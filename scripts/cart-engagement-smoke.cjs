'use strict';
// Real local server + synthetic carts; all non-local browser requests blocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {startServer,id}=require('../test/helpers');
const {Pool}=require('pg'),{createBuyerCartService}=require('../lib/buyer-cart');
const {randomUUID,createHmac}=require('node:crypto');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 let server,browser,pool;
 try{
  server=await startServer({dbNameSuffix:'cart_engagement_ui_'+Date.now(),port:3234});
  pool=new Pool({connectionString:server.dbUrl});const carts=createBuyerCartService(pool),brand=id('brand'),product=id('product'),owner=id('owner'),sid=randomUUID(),now=Date.now();
  await pool.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
  await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,'synthetic-owner@example.test','not-a-password','Synthetic owner','owner',true)",[owner]);
  await pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,staffUser:{id:owner,email:'synthetic-owner@example.test',role:'owner',mfaEnrolled:true}})]);
  await pool.query("INSERT INTO brands(id,name,subscription_status,min_per_reference) VALUES($1,'Synthetic brand','active',1)",[brand]);
  await pool.query("INSERT INTO products(id,brand_id,reference,price,sizes,color) VALUES($1,$2,'SIM-ONLY',10,'M','Gold')",[product,brand]);
  for(let i=0;i<52;i++){
   const buyer=id('buyer');
   await pool.query("INSERT INTO buyers(id,email,password_hash,name,lang,approved_at,last_login_at,activation_pending) VALUES($1,$2,'not-a-password',$3,'fr',NOW()-INTERVAL '70 days',NOW()-INTERVAL '3 days',false)",[buyer,buyer+'@example.test',i===0?'Synthetic <img src=x onerror=alert(1)>':'Synthetic buyer '+i]);
   await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,'granted','synthetic','v1')",[buyer]);
   const state=await carts.snapshot(buyer),cart={line:{brand_id:brand,product_id:product,qty:2,size:'M',color:'Gold',note:''}};
   if(i===51)await carts.saveLegacy(buyer,cart);else await carts.save(buyer,{...state,cart});
  }
  await pool.query("UPDATE buyer_cart_cycles SET changed_at=NOW()-INTERVAL '65 hours'");
  await pool.query("UPDATE buyers SET last_meaningful_activity_at=NOW()-INTERVAL '65 hours',last_seen_at=NULL");
  await pool.query("UPDATE buyer_engagement_rules SET mode='simulation',delay_hours=48 WHERE id='cart'");
  const signed='s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  const endpoint='/api/admin/buyer-engagement/cart-simulation',storageKey='buyer_cart_simulation_pending_v1';
  for(const width of [360,1440])for(const lang of ['fr','en']){
   await pool.query('TRUNCATE buyer_cart_simulation_runs CASCADE');await pool.query("UPDATE buyer_email_preferences SET status='granted'");await pool.query('UPDATE buyer_engagement_simulation_control SET paused=false');
   const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
   await context.addCookies([{name:'sid',value:encodeURIComponent(signed),url:server.baseUrl}]);
   await context.route('**/*',route=>new URL(route.request().url()).origin===server.baseUrl?route.continue():route.abort());
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   const open=async()=>{
    await page.goto(server.baseUrl+'/admin');await page.waitForFunction(()=>typeof currentUserRole!=='undefined'&&currentUserRole==='owner');
    await page.evaluate(lang=>{currentLang=lang;showSection('buyer-engagement');},lang);await require('./engagement-navigation.cjs').revealEngagementPanel(page,'cart');
    await page.waitForFunction(()=>document.querySelectorAll('#engagement-cart-rows tr').length===50&&!document.getElementById('engagement-cart-refresh').disabled);
   };
   const view=()=>page.evaluate(endpoint=>fetch(endpoint).then(r=>r.json()),endpoint);
   const ready=()=>page.waitForFunction(()=>!document.getElementById('engagement-cart-refresh').disabled);
   await open();assert.equal((await view()).candidates.total,0);assert.equal(await page.locator('#engagement-cart-panel img').count(),0);
   assert.equal(await page.locator('[data-rule=cart] [name=delay]').getAttribute('min'),'48');
   await page.locator('#engagement-cart-next').click();await ready();assert.equal(await page.locator('#engagement-cart-rows tr').count(),2);
   await page.locator('#engagement-cart-prev').click();await ready();assert.equal(await page.locator('#engagement-cart-rows tr').count(),50);
   let lose=true;const keys=[];
   await page.route('**/cart-simulation/runs',async route=>{
    keys.push(route.request().postDataJSON().request_key);const response=await route.fetch();assert.equal(response.status(),200);
    if(lose){lose=false;return route.abort();}return route.fulfill({response});
   });
   await page.locator('#engagement-cart-generate').click();await ready();
   assert.match(await page.locator('#engagement-cart-status').innerText(),lang==='fr'?/non confirmé/:/unconfirmed/);
   assert.ok(await page.evaluate(key=>localStorage.getItem(key),storageKey));
   // Reopen the actual admin, preserving only the operation reference.
   await open();await page.locator('#engagement-cart-generate').click();await ready();
   assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(await page.evaluate(key=>localStorage.getItem(key),storageKey),null);
   let value=await view();assert.equal(value.candidates.total,51);assert.equal(value.runs.length,1);assert.equal(value.sending_enabled,false);assert.equal(value.preparation_enabled,false);
   await page.locator('#engagement-cart-next').click();await ready();assert.equal(await page.locator('#engagement-cart-candidates tr').count(),1);
   await page.locator('#engagement-cart-prev').click();await ready();
   const first=value.candidates.rows[0].buyer_id;
   await pool.query("UPDATE buyer_email_preferences SET status='denied' WHERE buyer_id=$1",[first]);
   await page.locator('#engagement-cart-refresh').click();await ready();value=await view();
   assert.equal(value.candidates.rows[0].recorded_status,'eligible');assert.equal(value.candidates.rows[0].reason,'marketing_permission_missing');
   assert.match(await page.locator('#engagement-cart-candidates tr').first().innerText(),lang==='fr'?/retiré/:/withdrawn/);
   await page.locator('#engagement-cart-recheck').click();await ready();value=await view();assert.equal(value.candidates.rows[0].recorded_status,'excluded');
   await page.locator('#engagement-pause').click();await page.waitForFunction(()=>document.getElementById('engagement-cart-generate').disabled&&!document.getElementById('engagement-pause').disabled);
   assert.equal(await page.locator('#engagement-cart-recheck').isEnabled(),true);
   await page.locator('#engagement-cart-recheck').click();await ready();assert.equal((await view()).candidates.rows[0].recorded_reason,'simulation_paused');
   await page.locator('#engagement-pause').click();await page.waitForFunction(()=>!document.getElementById('engagement-cart-generate').disabled);
   // Malformed successful response must clear stale results and block a new calculation.
   const invalid=route=>route.fulfill({contentType:'application/json',body:'{}'});
   await page.route('**/cart-simulation?offset=*',invalid);await page.locator('#engagement-cart-refresh').click();await ready();
   assert.equal(await page.locator('#engagement-cart-rows tr').count(),0);assert.equal(await page.locator('#engagement-cart-candidates tr').count(),0);assert.equal(await page.locator('#engagement-cart-generate').isDisabled(),true);
   assert.match(await page.locator('#engagement-cart-status').innerText(),lang==='fr'?/indisponibles/:/unavailable/);
   await page.unroute('**/cart-simulation?offset=*',invalid);await page.locator('#engagement-cart-refresh').click();await ready();
   if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.evaluate(()=>document.getElementById('engagement-cart-panel').scrollIntoView({block:'start'}));await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`cart-engagement-${width}-${lang}.png`)});}
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'admin overflow');
   if(width===360)assert.equal(await page.locator('#engagement-cart-panel .table-wrap').evaluateAll(wraps=>wraps.every(el=>el.scrollWidth<=el.clientWidth)),true,'cart status readable without horizontal scrolling');
   if(width===1440&&lang==='en'){
    const before=keys.length;
    await page.evaluate(key=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new Error('synthetic storage failure');return set.call(this,k,v);};},storageKey);
    await page.locator('#engagement-cart-generate').click();await ready();assert.equal(keys.length,before);assert.equal(await page.locator('#engagement-cart-generate').isDisabled(),true);assert.match(await page.locator('#engagement-cart-status').innerText(),/storage/);
    // A separate reload restores Storage.prototype; inject invalid data before module initialization.
    await page.addInitScript(key=>localStorage.setItem(key,'false'),storageKey);await open();
    assert.equal(await page.locator('#engagement-cart-generate').isDisabled(),true);assert.match(await page.locator('#engagement-cart-status').innerText(),/Storage unavailable/);
   }
   assert.deepEqual(errors,[]);
   console.log(`PASS cart simulation: ${width}px ${lang}; pagination, persisted lost-response recovery, consent, pause, malformed response${width===1440&&lang==='en'?', unavailable and invalid storage':''}`);
   await context.close();
  }
 }finally{await browser?.close();server?.stop();await pool?.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
