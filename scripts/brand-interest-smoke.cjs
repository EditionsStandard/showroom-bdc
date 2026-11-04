'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {startServer,id}=require('../test/helpers'),{Pool}=require('pg');
const {randomUUID,createHmac}=require('node:crypto');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 let server,pool,browser;
 try {
  server=await startServer({dbNameSuffix:'brand_interest_browser_'+Date.now(),port:3238});pool=new Pool({connectionString:server.dbUrl});
  const buyer=id('buyer'),brand=id('brand'),product=id('product'),owner=id('owner');
  await pool.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
  await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,'synthetic-owner@example.test','not-a-password','Synthetic owner','owner',true)",[owner]);
  await pool.query("INSERT INTO brands(id,name,subscription_status,min_per_reference) VALUES($1,'Synthetic brand','active',1)",[brand]);await pool.query("INSERT INTO products(id,brand_id,reference,price,sizes,color) VALUES($1,$2,'INTEREST-ONLY',10,'M','Gold')",[product,brand]);
  const others=Array.from({length:51},(_,i)=>({id:id('buyer'),name:i===0?'Synthetic <img src=x onerror=alert(1)>':'Synthetic buyer '+i}));
  await pool.query(`INSERT INTO buyers(id,email,password_hash,name,approved_at,last_login_at,activation_pending)
    SELECT id,id||'@example.test','not-a-password',name,NOW()-INTERVAL '70 days',NOW()-INTERVAL '1 hour',false FROM jsonb_to_recordset($1::jsonb) AS x(id text,name text)`,[JSON.stringify([...others,{id:buyer,name:'Synthetic interactive buyer'}])]);
  await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) SELECT id,'granted','synthetic','v1' FROM buyers");
  async function session(value){const sid=randomUUID(),now=Date.now();await pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,...value})]);return encodeURIComponent('s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,''));}
  const ownerCookie=await session({staffUser:{id:owner,email:'synthetic-owner@example.test',role:'owner',mfaEnrolled:true}}),buyerCookie=await session({buyerPortal:{id:buyer,email:buyer+'@example.test',name:'Synthetic interactive buyer'}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  for(const width of [360,1440])for(const lang of ['fr','en']){
   await pool.query('TRUNCATE buyer_brand_interest_runs CASCADE');await pool.query('DELETE FROM buyer_brand_interest_days');await pool.query('DELETE FROM buyer_interest_preference_events');await pool.query('DELETE FROM buyer_interest_preferences');
   await pool.query("UPDATE buyer_email_preferences SET status='granted'");await pool.query("UPDATE buyer_engagement_rules SET mode='simulation',delay_hours=168,min_distinct_days=3 WHERE id='brand_interest'");await pool.query('UPDATE buyer_engagement_simulation_control SET paused=false');
   await pool.query("INSERT INTO buyer_interest_preferences(buyer_id,status,version,notice_version) SELECT id,'granted',1,'brand-interest-v1' FROM buyers WHERE id!=$1",[buyer]);
   await pool.query(`INSERT INTO buyer_brand_interest_days(buyer_id,brand_id,visit_day,observed_at,consent_version)
    SELECT b.id,$1,((NOW()-make_interval(days=>n)) AT TIME ZONE 'UTC')::date,NOW()-make_interval(days=>n),1 FROM buyers b CROSS JOIN generate_series(1,3) AS n WHERE b.id!=$2`,[brand,buyer]);
   const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
   await context.route('**/*',route=>new URL(route.request().url()).origin===server.baseUrl?route.continue():route.abort());
   await context.addInitScript(lang=>localStorage.setItem('portal_lang',lang),lang);
   const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));let observations=0;
   await page.route('**/api/portal/brand-interest',route=>{observations++;return route.continue();});
   async function useCookie(value){await context.clearCookies();await context.addCookies([{name:'sid',value,url:server.baseUrl}]);}
   async function portal(){await useCookie(buyerCookie);await page.goto(server.baseUrl+'/portal');await page.waitForFunction(()=>typeof PortalCart!=='undefined'&&typeof me!=='undefined'&&me?.id);}
   async function account(){await page.evaluate(()=>showView('account'));await page.locator('#buyer-interest-preferences input').waitFor();}
   async function admin(){await useCookie(ownerCookie);await page.goto(server.baseUrl+'/admin');await page.waitForFunction(()=>typeof currentUserRole!=='undefined'&&currentUserRole==='owner');await page.evaluate(lang=>{currentLang=lang;showSection('buyer-engagement');},lang);await require('./engagement-navigation.cjs').revealEngagementPanel(page,'brand');await page.waitForFunction(()=>document.querySelectorAll('#engagement-brand-rows tr').length===50&&!document.getElementById('engagement-brand-refresh').disabled);}
   const ready=()=>page.waitForFunction(()=>!document.getElementById('engagement-brand-refresh').disabled);
   const state=()=>page.evaluate(()=>fetch('/api/admin/buyer-engagement/brand-interest').then(r=>r.json()));
   await portal();await page.evaluate(async brand=>{await openBrand(brand);await BuyerBrandInterest.record(brand,BuyerBrandInterest.begin());},brand);assert.equal(observations,0,'no POST without separate permission');
   await account();assert.equal(await page.locator('#buyer-interest-preferences input').isChecked(),false);
   await page.locator('#buyer-interest-preferences input').check();await page.locator('#buyer-interest-preferences form button').click();await page.waitForFunction(()=>!document.querySelector('#buyer-interest-preferences form button').disabled&&/Votre choix a été enregistré|Your choice has been saved/.test(document.querySelector('#buyer-interest-preferences [role=status]').textContent));
   await page.evaluate(brand=>openBrand(brand),brand);
   for(let retry=0;retry<100;retry++){if((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_brand_interest_days WHERE buyer_id=$1',[buyer])).rows[0].n===1)break;await new Promise(resolve=>setTimeout(resolve,50));}
   assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_brand_interest_days WHERE buyer_id=$1',[buyer])).rows[0].n,1,'real openBrand hook records the first permitted day');
   await page.evaluate(async brand=>{for(let i=0;i<3;i++)await openBrand(brand);await BuyerBrandInterest.record(brand,BuyerBrandInterest.begin());},brand);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_brand_interest_days WHERE buyer_id=$1',[buyer])).rows[0].n,1);
   const before=observations;await page.evaluate(async brand=>{const stale=BuyerBrandInterest.begin();BuyerBrandInterest.begin();await BuyerBrandInterest.record(brand,stale);},brand);assert.equal(observations,before,'stale navigation is not an observation');
   const unavailable=route=>route.fulfill({status:503,contentType:'application/json',body:'{}'});await page.route('**/api/portal/interest-preferences',unavailable);await page.evaluate(async brand=>{await openBrand(brand);await BuyerBrandInterest.record(brand,BuyerBrandInterest.begin());},brand);assert.equal(observations,before);assert.ok(await page.locator('#products-list').innerText());await page.unroute('**/api/portal/interest-preferences',unavailable);
   await pool.query(`INSERT INTO buyer_brand_interest_days(buyer_id,brand_id,visit_day,observed_at,consent_version) SELECT $1,$2,((NOW()-make_interval(days=>n)) AT TIME ZONE 'UTC')::date,NOW()-make_interval(days=>n),1 FROM generate_series(1,2) AS n`,[buyer,brand]);
   await admin();let value=await state();assert.equal(value.total,52);assert.equal(value.counts.eligible,52);assert.equal(value.counts.candidates,0);assert.equal(await page.locator('#engagement-brand-panel img').count(),0);
   await page.locator('#engagement-brand-next').click();await ready();assert.equal(await page.locator('#engagement-brand-rows tr').count(),2);await page.locator('#engagement-brand-prev').click();await ready();
   let lose=true;const keys=[];await page.route('**/brand-interest/runs',async route=>{keys.push(route.request().postDataJSON().request_key);const response=await route.fetch();assert.equal(response.status(),200);if(lose){lose=false;return route.abort();}return route.fulfill({response});});
   await page.locator('#engagement-brand-generate').click();await ready();await admin();await page.locator('#engagement-brand-generate').click();await ready();assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);value=await state();assert.equal(value.runs.length,1);assert.equal(value.counts.candidates,52);
   const target=value.rows.find(r=>r.buyer_id!==buyer).buyer_id;await pool.query("UPDATE buyer_email_preferences SET status='denied' WHERE buyer_id=$1",[target]);await page.locator('#engagement-brand-refresh').click();await ready();value=await state();assert.equal(value.rows.find(r=>r.buyer_id===target).recorded.status,'eligible');assert.equal(value.rows.find(r=>r.buyer_id===target).reason,'marketing_permission_missing');
   await page.locator('#engagement-brand-recheck').click();await ready();assert.equal((await state()).rows.find(r=>r.buyer_id===target).recorded.status,'excluded');
   await page.locator('#engagement-tab-automations').click();
   const rule=page.locator('[data-rule=brand_interest]');await rule.locator('[name=min_days]').fill('4');await rule.locator('button').click();await page.waitForFunction(()=>document.querySelector('[data-rule=brand_interest] [name=min_days]')?.value==='4'&&!document.getElementById('engagement-refresh').disabled);
   await require('./engagement-navigation.cjs').revealEngagementPanel(page,'brand');await page.locator('#engagement-brand-refresh').click();await ready();assert.equal((await state()).counts.eligible,0);
   await require('./engagement-navigation.cjs').revealEngagementPanel(page,'diagnostics');
   await page.locator('#engagement-pause').click();await page.waitForFunction(()=>document.getElementById('engagement-brand-generate').disabled&&!document.getElementById('engagement-pause').disabled);assert.equal(await page.locator('#engagement-brand-recheck').isEnabled(),true);await page.locator('#engagement-brand-recheck').click();await ready();assert.equal((await state()).rows[0].recorded.reason,'simulation_paused');
   await page.locator('#engagement-pause').click();await page.waitForFunction(()=>!document.getElementById('engagement-brand-generate').disabled);
   const invalid=route=>route.fulfill({contentType:'application/json',body:'{}'});await page.route('**/brand-interest?offset=*',invalid);await page.locator('#engagement-brand-refresh').click();await ready();assert.equal(await page.locator('#engagement-brand-rows tr').count(),0);assert.equal(await page.locator('#engagement-brand-generate').isDisabled(),true);await page.unroute('**/brand-interest?offset=*',invalid);await page.locator('#engagement-brand-refresh').click();await ready();
   if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.evaluate(()=>document.getElementById('engagement-brand-panel').scrollIntoView({block:'start'}));await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`brand-interest-admin-${width}-${lang}.png`)});}
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);if(width===360)assert.equal(await page.locator('#engagement-brand-panel .table-wrap').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
   await portal();await account();await page.locator('#buyer-interest-preferences input').uncheck();await page.locator('#buyer-interest-preferences form button').click();await page.waitForFunction(()=>!document.querySelector('#buyer-interest-preferences form button').disabled&&/Votre choix a été enregistré|Your choice has been saved/.test(document.querySelector('#buyer-interest-preferences [role=status]').textContent));
   assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_brand_interest_days WHERE buyer_id=$1',[buyer])).rows[0].n,0);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_brand_interest_candidates WHERE buyer_id=$1',[buyer])).rows[0].n,0);assert.equal((await pool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[buyer])).rows[0].status,'granted');
   if(process.env.SCREENSHOT_DIR)await page.locator('#buyer-interest-preferences').screenshot({path:path.join(process.env.SCREENSHOT_DIR,`brand-interest-preference-${width}-${lang}.png`)});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);console.log(`PASS brand interest ${width}px ${lang}: separate permission, daily dedupe, stale navigation, fail-closed collection, pagination, persistent retry, rule edit, pause, live exclusion and withdrawal purge`);await context.close();
  }
 }finally{await browser?.close();server?.stop();await pool?.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
