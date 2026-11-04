'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),{Pool}=require('pg');
const {startServer}=require('../test/helpers'),fixture=require('../test/email-links-fixture'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
(async()=>{let server,pool,browser;try{
  server=await startServer({dbNameSuffix:'email_actions_ui_'+Date.now(),port:3272});pool=new Pool({connectionString:server.dbUrl});
  browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE,headless:true});
  if(process.env.SCREENSHOT_DIR)await fs.mkdir(process.env.SCREENSHOT_DIR,{recursive:true});
  for(const width of [360,1440])for(const lang of ['fr','en']){
    const f=await fixture(pool,{lang,origin:server.baseUrl}),context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),external=[],errors=[];
    await context.route('**/*',route=>{if(new URL(route.request().url()).origin===server.baseUrl)return route.continue();external.push(new URL(route.request().url()).origin);return route.abort();});
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.activation.href);await page.waitForFunction(()=>!document.getElementById('action').hidden);
    assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('html').getAttribute('lang'),lang);
    assert.equal((await pool.query('SELECT activation_pending FROM buyers WHERE id=$1',[f.buyer])).rows[0].activation_pending,true);
    if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`activation-${width}-${lang}.png`)});
    await page.locator('#password').fill('Synthetic password 123!');await page.locator('#confirmation').fill('Different password 123!');await page.locator('#submit').click();await page.waitForFunction(()=>document.getElementById('status').textContent.length>0);
    assert.equal((await pool.query('SELECT activation_pending FROM buyers WHERE id=$1',[f.buyer])).rows[0].activation_pending,true);
    await page.locator('#confirmation').fill('Synthetic password 123!');await page.locator('#submit').click();await page.waitForFunction(()=>document.getElementById('action').hidden);
    assert.match(await page.locator('#status').innerText(),/enregistré|saved/);assert.equal(await page.locator('#password').inputValue(),'');
    const b=(await pool.query('SELECT activation_pending,first_login_at,last_login_at FROM buyers WHERE id=$1',[f.buyer])).rows[0];assert.equal(b.activation_pending,false);assert.equal(b.first_login_at,null);assert.equal(b.last_login_at,null);
    assert.equal((await page.request.get(server.baseUrl+'/api/portal/me')).status(),401);
    const unsubscribe=server.baseUrl+'/buyer-engagement/unsubscribe#'+new URLSearchParams({token:f.unsubscribeToken,lang});await page.goto(unsubscribe);await page.waitForFunction(()=>!document.getElementById('action').hidden);
    assert.equal(new URL(page.url()).hash,'');assert.equal((await pool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[f.buyer])).rows[0].status,'granted');
    await page.locator('#language').click();assert.equal(await page.locator('html').getAttribute('lang'),lang==='fr'?'en':'fr');await page.locator('#language').click();
    if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`unsubscribe-${width}-${lang}.png`)});
    // Simulate a lost HTTP confirmation after the preference was committed.
    const lost=async route=>{await route.fetch();await route.abort();};await page.route('**/api/public/buyer-engagement/unsubscribe',lost);await page.locator('#submit').click();await page.waitForFunction(()=>!document.getElementById('submit').disabled&&document.getElementById('status').textContent.length>0);await page.unroute('**/api/public/buyer-engagement/unsubscribe',lost);
    assert.equal((await pool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[f.buyer])).rows[0].status,'denied');await page.locator('#submit').click();await page.waitForFunction(()=>document.getElementById('action').hidden);
    assert.match(await page.locator('#status').innerText(),/enregistré|saved/);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_email_preference_events WHERE buyer_id=$1',[f.buyer])).rows[0].n,1);
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.goto(f.unsubscribe.href);await page.waitForFunction(()=>!document.getElementById('action').hidden);assert.equal(new URL(page.url()).pathname,'/buyer-engagement/unsubscribe');assert.equal(new URL(page.url()).hash,'');
    assert.equal((await pool.query('SELECT delivery_enabled FROM buyer_engagement_outbox_control')).rows[0].delivery_enabled,false);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log(`PASS email actions ${width}px ${lang}: safe GET, token removal, activation, no login, unsubscribe, lost confirmation, zero external requests`);await context.close();
  }
}finally{await browser?.close();server?.stop();await pool?.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
