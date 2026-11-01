'use strict';
// Real local application + synthetic PostgreSQL fixtures. All browser requests
// outside the local test server are aborted. No provider credentials inherited.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startServer,withDb,id}=require('../test/helpers');
const {authenticator}=require('otplib');
const bcrypt=require('bcryptjs');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  let server,browser;
  try {
    server=await startServer({dbNameSuffix:'engagement_browser_'+Date.now(),port:3218});
    const secret=authenticator.generateSecret(),buyer=id('browser'),password='SyntheticPassword123!';
    await withDb(server.dbUrl,async db=>{
      await db.query("INSERT INTO settings(key,value) VALUES('owner_mfa_enabled','on'),('owner_mfa_secret',$1),('owner_mfa_last_step','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[secret]);
      await db.query('INSERT INTO buyers(id,email,password_hash,name,country,login_history_known,approved_at) VALUES($1,$2,$3,$4,$5,true,NOW())',[buyer,buyer+'@test.invalid',await bcrypt.hash(password,10),'Synthetic buyer','FR']);
      for(let i=0;i<101;i++) {
        const synthetic=id('synthetic');
        await db.query("INSERT INTO buyers(id,email,password_hash,name,login_history_known,approved_at,activation_pending) VALUES($1,$2,'not-a-password',$3,$4,NOW()-INTERVAL '40 days',true)",[synthetic,`synthetic${i}@test.invalid`,`Synthetic ${i}`,i<51]);
        if(i<51)await db.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,'granted','synthetic','test-only')",[synthetic]);
      }
    });
    const post=(route,body,cookie)=>fetch(server.baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),redirect:'manual'});
    const initial=await post('/admin/login',{password:'TestAdmin123!'});
    const final=await post('/admin/login/mfa',{code:authenticator.generate(secret)},initial.headers.get('set-cookie').split(';')[0]);
    const ownerCookie=(final.headers.get('set-cookie')||initial.headers.get('set-cookie')).split(';')[0];
    const buyerResponse=await post('/editions-showroom-b2b-portail',{email:buyer+'@test.invalid',password});
    const buyerCookie=buyerResponse.headers.get('set-cookie').split(';')[0];
    browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
    for(const width of [360,1440])for(const lang of ['fr','en']) {
      const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
      const cookies=value=>[{name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:server.baseUrl}];
      await context.addCookies(cookies(ownerCookie));
      await context.route('**/*',route=>new URL(route.request().url()).origin===server.baseUrl?route.continue():route.abort());
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(server.baseUrl+'/admin');
      await page.waitForFunction(()=>typeof currentUserRole!=='undefined' && currentUserRole==='owner');
      await page.evaluate(lang=>{currentLang=lang;showSection('buyer-engagement');},lang);
      await page.waitForFunction(()=>document.querySelector('#engagement-rules form'));
      assert.equal(await page.locator('#engagement-rules form').count(),4);
      assert.equal(await page.locator('#engagement-buyers tr').count(),100);
      await page.locator('#engagement-next').click();await page.waitForFunction(()=>document.querySelectorAll('#engagement-buyers tr').length===2);
      await page.locator('#engagement-prev').click();await page.waitForFunction(()=>document.querySelectorAll('#engagement-buyers tr').length===100);
      const rule=page.locator('[data-rule=welcome]');
      await rule.locator('[name=mode]').selectOption('simulation');await rule.locator('[name=delay]').fill('36');await rule.locator('button').click();
      await page.waitForFunction(()=>document.querySelector('[data-rule=welcome] small')?.textContent!=='v1');
      await page.locator('#engagement-subject').fill('Synthetic <img src=x onerror=alert(1)>');
      await page.locator('#engagement-body').fill('Hello {{buyer_name}}\n{{portal_url}}');
      assert.equal(await page.locator('#engagement-preview img').count(),0);
      await page.locator('#engagement-template-save').click();await page.waitForFunction(()=>!document.getElementById('engagement-template-save').disabled);
      assert.equal(await page.locator('#engagement-subject').inputValue(),'Synthetic <img src=x onerror=alert(1)>');
      // Lose the first successful response, then retry the identical operation.
      // The server has committed; the UI must reuse its request key.
      let loseResponse=true;const requestKeys=[];
      await page.route('**/api/admin/buyer-engagement/simulation-runs',async route=>{
        requestKeys.push(route.request().postDataJSON().request_key);
        const response=await route.fetch();
        if(loseResponse){loseResponse=false;return route.abort();}
        return route.fulfill({response});
      });
      await page.locator('#engagement-generate').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-generate').disabled);
      await page.locator('#engagement-generate').click();
      await page.waitForFunction(()=>document.querySelectorAll('#engagement-candidates tr').length===50 && !document.getElementById('engagement-generate').disabled);
      assert.equal(requestKeys.length,2);assert.equal(requestKeys[0],requestKeys[1]);
      await page.locator('#engagement-candidate-next').click();
      await page.waitForFunction(()=>document.querySelectorAll('#engagement-candidates tr').length===1);
      await page.locator('#engagement-candidate-prev').click();
      await page.waitForFunction(()=>document.querySelectorAll('#engagement-candidates tr').length===50);
      await page.locator('#engagement-pause').click();
      await page.waitForFunction(()=>document.getElementById('engagement-generate').disabled && !document.getElementById('engagement-pause').disabled);
      assert.equal(await page.locator('#engagement-recheck').isEnabled(),true);
      await page.locator('#engagement-recheck').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-recheck').disabled);
      assert.match(await page.locator('#engagement-candidates tr').first().innerText(),lang==='fr'?/pause/:/paused/);
      await page.locator('#engagement-pause').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-generate').disabled);
      await page.locator('#engagement-recheck').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-recheck').disabled);
      const ledger=await page.evaluate(()=>fetch('/api/admin/buyer-engagement/ledger').then(r=>r.json()));
      assert.equal(ledger.candidates.total,51);assert.equal(ledger.sending_enabled,false);
      if(width===1440 && lang==='en'){
        assert.ok(ledger.runs.total>10);await page.locator('#engagement-run-next').click();
        await page.waitForFunction(()=>!document.getElementById('engagement-run-prev').disabled);
        await page.locator('#engagement-run-prev').click();
      }
      // Each viewport/language gets a clean preparation rehearsal over the
      // same synthetic candidates. Simulation run history is kept intact.
      await withDb(server.dbUrl,db=>db.query('DELETE FROM buyer_engagement_preparation_jobs'));
      await page.locator('#engagement-preparation-refresh').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-preparation-enqueue').disabled);
      assert.equal(await page.locator('#engagement-preparation-process').isDisabled(),true);
      let loseEnqueue=true;const preparationKeys=[];
      await page.route('**/preparation-queue/enqueue',async route=>{
        preparationKeys.push(route.request().postDataJSON().request_key);const response=await route.fetch();
        if(loseEnqueue){loseEnqueue=false;return route.abort();}return route.fulfill({response});
      });
      await page.locator('#engagement-preparation-enqueue').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-preparation-enqueue').disabled);
      await page.locator('#engagement-preparation-enqueue').click();
      await page.waitForFunction(()=>document.querySelectorAll('#engagement-preparation-rows tr').length===50 && !document.getElementById('engagement-preparation-enqueue').disabled);
      assert.equal(preparationKeys.length,2);assert.equal(preparationKeys[0],preparationKeys[1]);
      await page.locator('#engagement-preparation-next').click();
      await page.waitForFunction(()=>document.querySelectorAll('#engagement-preparation-rows tr').length===1);
      await page.locator('#engagement-preparation-prev').click();
      await page.waitForFunction(()=>document.querySelectorAll('#engagement-preparation-rows tr').length===50);
      await page.locator('#engagement-preparation-pause').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-preparation-process').disabled);
      await page.locator('#engagement-preparation-process').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-preparation-process').disabled);
      let queue=await page.evaluate(()=>fetch('/api/admin/buyer-engagement/preparation-queue').then(r=>r.json()));
      assert.equal(queue.counts.simulated,10);assert.equal(queue.delivery_enabled,false);
      let processRequests=0;
      await page.route('**/preparation-queue/process',async route=>{processRequests++;await route.fetch();return route.abort();});
      await page.locator('#engagement-preparation-process').click();
      await page.waitForFunction(()=>!document.getElementById('engagement-preparation-process').disabled);
      assert.match(await page.locator('#engagement-preparation-status').innerText(),lang==='fr'?/non confirmé/:/unconfirmed/);
      queue=await page.evaluate(()=>fetch('/api/admin/buyer-engagement/preparation-queue').then(r=>r.json()));
      assert.equal(processRequests,1,'ambiguous batch processing must never auto-retry');assert.equal(queue.counts.simulated,20);
      await page.locator('#engagement-preparation-pause').click();
      await page.waitForFunction(()=>document.getElementById('engagement-preparation-process').disabled && !document.getElementById('engagement-preparation-pause').disabled);
      if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`engagement-admin-${width}-${lang}.png`)});}
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'admin overflow');
      await context.clearCookies();await context.addCookies(cookies(buyerCookie));
      await page.addInitScript(lang=>localStorage.setItem('portal_lang',lang),lang);
      await page.goto(server.baseUrl+'/portal');
      await page.waitForFunction(()=>typeof me!=='undefined' && me?.id && window._pingInterval);
      await page.evaluate(()=>showView('account'));
      await page.locator('#buyer-email-preferences input').waitFor();
      await page.waitForFunction(()=>document.getElementById('company-tools')._company);
      if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`preference-before-${width}-${lang}.png`)});
      await page.locator('#buyer-email-preferences input').check();await page.locator('#buyer-email-preferences form button').click();
      await page.waitForFunction(()=>/enregistré|saved/.test(document.querySelector('#buyer-email-preferences [role=status]').textContent));
      await page.locator('#buyer-email-preferences input').uncheck();await page.locator('#buyer-email-preferences form button').click();
      await page.waitForFunction(()=>!document.querySelector('#buyer-email-preferences form button').disabled);
      const preference=await page.evaluate(()=>fetch('/api/portal/email-preferences').then(r=>r.json()));assert.equal(preference.status,'denied');
      if(process.env.SCREENSHOT_DIR)await page.locator('#buyer-email-preferences').screenshot({path:path.join(process.env.SCREENSHOT_DIR,`engagement-preferences-${width}-${lang}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'buyer overflow');
      assert.deepEqual(errors,[]);
      console.log(`PASS engagement ledger + locked queue, lost-response recovery, pagination, pause/process, templates, buyer preference: ${width}px ${lang}`);
      await context.close();
    }
  }finally {await browser?.close();server?.stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
