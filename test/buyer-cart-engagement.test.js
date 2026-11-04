'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),{randomUUID,createHmac}=require('node:crypto');
const {Pool}=require('pg');const {startServer,id}=require('./helpers');
const {createBuyerCartService}=require('../lib/buyer-cart');
const {runCartSimulation,getCartSimulation,pruneCartSimulation}=require('../lib/buyer-cart-engagement');
const endpoint='/api/admin/buyer-engagement/cart-simulation';
let server,pool,carts,buyer,brand,product,owner,buyerCookie,state;
async function cookie(session){const sid=randomUUID(),now=Date.now();await pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,...session})]);return 'sid='+encodeURIComponent('s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,''));}
async function request(path,{session=owner,method='GET',body}={}){const r=await fetch(server.baseUrl+path,{method,redirect:'manual',headers:{'Content-Type':'application/json',...(session?{Cookie:session}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
const run=(kind='generate',request_key=randomUUID())=>runCartSimulation(pool,{kind,request_key});
const preview=async()=> (await getCartSimulation(pool)).preview.rows.find(row=>row.buyer_id===buyer&&row.brand_id===brand);
async function age(){await pool.query("UPDATE buyer_cart_cycles SET changed_at=NOW()-INTERVAL '65 hours' WHERE buyer_id=$1",[buyer]);await pool.query("UPDATE buyers SET last_meaningful_activity_at=NOW()-INTERVAL '65 hours',last_seen_at=NULL WHERE id=$1",[buyer]);}
function line(b=brand,p=product,qty=2){return {brand_id:b,product_id:p,qty,size:'M',color:'Gold',note:''};}
const cart=(...lines)=>Object.fromEntries(lines.map((l,i)=>['line'+i,l]));
async function candidate(){return (await pool.query('SELECT * FROM buyer_cart_simulation_candidates WHERE buyer_id=$1 ORDER BY created_at,id',[buyer])).rows;}
async function totals(){return (await pool.query(`SELECT (SELECT COUNT(*)::int FROM buyer_cart_simulation_runs) AS runs,(SELECT COUNT(*)::int FROM buyer_cart_simulation_candidates) AS candidates,(SELECT COUNT(*)::int FROM buyer_cart_simulation_checks) AS checks`)).rows[0];}
function proxyBeforeRows(fn){return {connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{if(typeof sql==='string'&&sql.includes('SELECT c.*,s.cart_json'))await fn(c);return c.query(sql,args);},release:()=>c.release()};}};}
before(async()=>{
 server=await startServer({dbNameSuffix:'cart_sim_'+Date.now(),port:3232});pool=new Pool({connectionString:server.dbUrl});carts=createBuyerCartService(pool);
 await pool.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
 const ownerId=id('owner');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,'owner@example.test','not-a-password','Synthetic owner','owner',true)",[ownerId]);
 owner=await cookie({staffUser:{id:ownerId,email:'owner@example.test',role:'owner',mfaEnrolled:true}});
});
beforeEach(async()=>{
 await pool.query('TRUNCATE buyer_cart_simulation_runs CASCADE');await pool.query('DELETE FROM buyers');await pool.query('DELETE FROM orders');await pool.query('DELETE FROM brands');
 await pool.query("UPDATE buyer_engagement_rules SET mode='disabled',version=version+1");await pool.query("UPDATE buyer_engagement_rules SET mode='simulation',delay_hours=48 WHERE id='cart'");
 await pool.query('UPDATE buyer_engagement_simulation_control SET paused=false');
 buyer=id('buyer');brand=id('brand');product=id('product');
 await pool.query("INSERT INTO brands(id,name,subscription_status,min_per_reference) VALUES($1,'Synthetic brand','active',1)",[brand]);
 await pool.query("INSERT INTO products(id,brand_id,reference,price,sizes,color,stock_enabled,stock_qty) VALUES($1,$2,'SIM-ONLY',10,'M','Gold',true,100)",[product,brand]);
 await pool.query(`INSERT INTO buyers(id,email,password_hash,name,company,country,lang,approved_at,last_login_at,activation_pending,login_history_known)
  VALUES($1,$2,'not-a-password','Private synthetic name','Private synthetic company','FR','fr',NOW()-INTERVAL '70 days',NOW()-INTERVAL '3 days',false,false)`,[buyer,buyer+'@example.test']);
 await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,'granted','synthetic','v1')",[buyer]);
 buyerCookie=await cookie({buyerPortal:{id:buyer,email:buyer+'@example.test',name:'Private synthetic name',company:'Private synthetic company'}});
 state=await carts.snapshot(buyer);state=await carts.save(buyer,{...state,cart:cart(line())});await age();
});
after(async()=>{server?.stop();await pool?.end();});

test('preview is read only and a known aged cart can qualify without reconstructing historic logins',async()=>{
 const before=await totals();const row=await preview();assert.equal(row.eligible,true);assert.equal(row.reason,'known_open_cart_after_delay');assert.deepEqual(await totals(),before);
 const response=await request(endpoint);assert.equal(response.status,200);assert.equal(response.body.sending_enabled,false);assert.equal(response.body.preparation_enabled,false);
});
test('SQL threshold includes exactly 48 hours and excludes one microsecond before it',async()=>{
 const exact=proxyBeforeRows(c=>c.query("UPDATE buyer_cart_cycles SET changed_at=NOW()-INTERVAL '48 hours' WHERE buyer_id=$1",[buyer]));
 const first=await runCartSimulation(exact,{kind:'generate',request_key:randomUUID()});assert.equal(first.run.created_count,1);
 const early=proxyBeforeRows(c=>c.query("UPDATE buyer_cart_cycles SET changed_at=NOW()-INTERVAL '48 hours'+INTERVAL '1 microsecond' WHERE buyer_id=$1",[buyer]));
 const second=await runCartSimulation(early,{kind:'recheck',request_key:randomUUID()});assert.equal(second.run.eligible_count,0);assert.equal((await candidate())[0].reason,'delay_not_reached');
});
test('request replay and repeated scans do not duplicate cycle candidates or checks',async()=>{
 const key=randomUUID();const first=await run('generate',key),replay=await run('generate',key);assert.equal(replay.replayed,true);assert.equal(replay.run.id,first.run.id);
 assert.deepEqual(await totals(),{runs:1,candidates:1,checks:1});const next=await run();assert.equal(next.run.created_count,0);assert.equal(next.run.rechecked_count,1);
 assert.deepEqual(await totals(),{runs:2,candidates:1,checks:2});await assert.rejects(run('recheck',key),e=>e.status===409);
});
test('two brands at the same time create two scoped episodes for one buyer',async()=>{
 const b=id('brand'),p=id('product');await pool.query("INSERT INTO brands(id,name,subscription_status,min_per_reference) VALUES($1,'Second brand','active',1)",[b]);await pool.query("INSERT INTO products(id,brand_id,reference,price,sizes,color) VALUES($1,$2,'SECOND',10,'M','Gold')",[p,b]);
 state=await carts.save(buyer,{...await carts.snapshot(buyer),cart:cart(line(),line(b,p))});await age();assert.equal((await run()).run.created_count,2);assert.equal(new Set((await candidate()).map(c=>c.brand_id)).size,2);
});
test('withdrawal is reflected on read immediately, while the recorded decision remains historical until recheck',async()=>{
 await run();await pool.query("UPDATE buyer_email_preferences SET status='denied' WHERE buyer_id=$1",[buyer]);
 const view=await getCartSimulation(pool);assert.equal(view.candidates.rows[0].eligible,false);assert.equal(view.candidates.rows[0].recorded_status,'eligible');assert.equal(view.candidates.rows[0].reason,'marketing_permission_missing');
 await run('recheck');assert.equal((await candidate())[0].status,'excluded');
});
test('successful real checkout excludes the episode and cannot leave an actionable cart candidate',async()=>{
 await run();const current=await carts.snapshot(buyer);
 const created=await request('/api/portal/checkout-v2',{session:buyerCookie,method:'POST',body:{request_key:randomUUID(),cart_id:current.cart_id,revision:current.revision,lines:[{brand_id:brand,product_id:product,quantity:2,size:'M',variant_color:'Gold'}],client_name:'Synthetic',client_country:'FR',buyer_signature:'synthetic',cgv_accepted:true}});
 assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.ok,true);assert.equal((await preview()).reason,'cart_converted');await run('recheck');assert.equal((await candidate())[0].reason,'cart_converted');
});
test('changing content excludes the old revision and generates a new episode only after ageing again',async()=>{
 await run();const old=(await candidate())[0];await carts.save(buyer,{...await carts.snapshot(buyer),cart:cart(line(brand,product,3))});
 assert.equal((await getCartSimulation(pool)).candidates.rows[0].reason,'episode_changed');assert.equal((await run()).run.created_count,0);
 await age();assert.equal((await run()).run.created_count,1);const all=await candidate();assert.equal(all.length,2);assert.equal(all.find(c=>c.id===old.id).status,'excluded');
});
test('historical writes, empty cycles and disabled rules are excluded',async()=>{
 await carts.saveLegacy(buyer,cart(line()));assert.equal((await preview()).reason,'cart_history_unknown');
 await carts.save(buyer,{...await carts.snapshot(buyer),cart:{}});assert.equal((await preview()).reason,'cart_empty');
 await pool.query("UPDATE buyer_engagement_rules SET mode='disabled' WHERE id='cart'");assert.equal((await preview()).reason,'rule_disabled');
});
test('approval, completed login and explicit marketing permission are required',async()=>{
 for(const [sql,reason] of [
  ["UPDATE buyers SET approved_at=NULL WHERE id=$1",'approval_unknown'],
  ["UPDATE buyers SET approved_at=NOW()-INTERVAL '70 days',activation_pending=true WHERE id=$1",'no_completed_login'],
  ["UPDATE buyers SET activation_pending=false,last_login_at=NULL WHERE id=$1",'no_completed_login'],
  ["UPDATE buyers SET last_login_at=NOW()+INTERVAL '1 day' WHERE id=$1",'access_dates_invalid']]){
  await pool.query(sql,[buyer]);assert.equal((await preview()).reason,reason);
 }
 await pool.query("UPDATE buyers SET last_login_at=NOW()-INTERVAL '3 days' WHERE id=$1",[buyer]);await pool.query('DELETE FROM buyer_email_preferences WHERE buyer_id=$1',[buyer]);assert.equal((await preview()).reason,'marketing_permission_missing');
});
test('recent action, presence, contact and unknown activity prevent simulation eligibility',async()=>{
 for(const [field,reason] of [['last_meaningful_activity_at','recent_activity'],['last_seen_at','recent_presence'],['last_engagement_email_at','recent_contact']]){
  await age();await pool.query('UPDATE buyers SET last_engagement_email_at=NULL WHERE id=$1',[buyer]);await pool.query(`UPDATE buyers SET ${field}=NOW() WHERE id=$1`,[buyer]);assert.equal((await preview()).reason,reason);
 }
 await pool.query('UPDATE buyers SET last_meaningful_activity_at=NULL WHERE id=$1',[buyer]);assert.equal((await preview()).reason,'activity_unknown');
});
test('invalid catalogue, stock, brand and minimums are excluded without changing the cart',async()=>{
 const original=(await carts.snapshot(buyer)).cart;
 for(const sql of ["UPDATE products SET active=0 WHERE id=$1","UPDATE products SET stock_qty=0 WHERE id=$1","UPDATE products SET sizes='L' WHERE id=$1","UPDATE products SET color='Silver' WHERE id=$1","UPDATE products SET price=NULL WHERE id=$1"]){
  await pool.query("UPDATE products SET active=1,stock_qty=100,sizes='M',color='Gold',price=10 WHERE id=$1",[product]);await pool.query(sql,[product]);assert.equal((await preview()).reason,'cart_not_orderable');
 }
 await pool.query("UPDATE products SET price=10 WHERE id=$1",[product]);await pool.query("UPDATE brands SET min_per_reference=3 WHERE id=$1",[brand]);assert.equal((await preview()).reason,'cart_minimum_not_met');
 await pool.query("UPDATE brands SET subscription_status='inactive' WHERE id=$1",[brand]);assert.equal((await preview()).reason,'brand_unavailable');assert.deepEqual((await carts.snapshot(buyer)).cart,original);
});
test('pending checkout blocks a reminder until it is closed',async()=>{
 const body={request_key:randomUUID(),cart_id:state.cart_id,revision:state.revision,lines:[{brand_id:brand,product_id:product,quantity:2,size:'M',variant_color:'Gold'}]};await carts.reserveCheckout(buyer,body);
 assert.equal((await preview()).reason,'checkout_pending');await carts.cancel(buyer,body.request_key,[brand]);assert.equal((await preview()).eligible,true);
});
test('hash mismatches, missing templates and delay below 48 hours fail closed',async()=>{
 await pool.query('UPDATE buyer_cart_states SET cart_json=$2 WHERE buyer_id=$1',[buyer,JSON.stringify(cart(line(brand,product,3)))]);assert.equal((await preview()).reason,'cart_hash_mismatch');
 await pool.query('UPDATE buyer_cart_states SET cart_json=$2 WHERE buyer_id=$1',[buyer,JSON.stringify(cart(line()))]);
 await pool.query("DELETE FROM buyer_engagement_templates WHERE rule_id='cart' AND lang='fr'");assert.equal((await preview()).reason,'template_missing');
 await pool.query("UPDATE buyer_engagement_rules SET delay_hours=1 WHERE id='cart'");assert.equal((await preview()).reason,'cart_delay_below_minimum');
 // Restore the shared template for the following fixtures.
 await pool.query("INSERT INTO buyer_engagement_templates(rule_id,lang,version,subject,body) VALUES('cart','fr',1,'Synthetic','Synthetic')");
});
test('global pause prevents generation but still allows recorded exclusions on recheck',async()=>{
 await run();await pool.query('UPDATE buyer_engagement_simulation_control SET paused=true');await assert.rejects(run(),e=>e.code==='simulation_paused');
 assert.equal((await preview()).reason,'simulation_paused');await run('recheck');assert.equal((await candidate())[0].reason,'simulation_paused');
});
test('records contain no copied contact, cart content or message body; delivery states are forbidden',async()=>{
 const before=(await pool.query('SELECT COUNT(*)::int AS n FROM pending_reminders')).rows[0].n;await run();
 const records=JSON.stringify({runs:(await pool.query('SELECT * FROM buyer_cart_simulation_runs')).rows,candidates:await candidate(),checks:(await pool.query('SELECT * FROM buyer_cart_simulation_checks')).rows});
 for(const value of ['Private synthetic name','Private synthetic company',buyer+'@example.test','SIM-ONLY','synthetic-signature'])assert.equal(records.includes(value),false);
 await assert.rejects(pool.query("UPDATE buyer_cart_simulation_runs SET mode='send'"));await assert.rejects(pool.query("UPDATE buyer_cart_simulation_candidates SET status='sent'"));
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM pending_reminders')).rows[0].n,before);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_preparation_jobs')).rows[0].n,0);
});
test('cart simulation is owner only and export/cascade include the new history',async()=>{
 await run();assert.equal((await request(endpoint,{session:null})).status,403);assert.equal((await request(endpoint,{session:buyerCookie})).status,403);
 const staff=id('agent');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,$2,'not-a-password','Synthetic agent','agent',true)",[staff,staff+'@test.invalid']);const agent=await cookie({staffUser:{id:staff,role:'agent',mfaEnrolled:true}});assert.equal((await request(endpoint,{session:agent})).status,403);
 const exported=await request('/api/portal/gdpr/export',{session:buyerCookie});assert.equal(exported.status,200);assert.equal(exported.body.engagement.cart_simulation.candidates.length,1);
 await pool.query('DELETE FROM buyers WHERE id=$1',[buyer]);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_cart_simulation_candidates')).rows[0].n,0);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_cart_simulation_checks')).rows[0].n,0);
});
test('retention is based on creation age and repeated migration preserves current history',async()=>{
 await run();const original=(await candidate())[0];const {migrateCartEngagement}=require('../lib/buyer-cart-engagement-migration');await migrateCartEngagement(pool);assert.equal((await candidate())[0].id,original.id);
 await pool.query("UPDATE buyer_cart_simulation_candidates SET created_at=NOW()-INTERVAL '91 days',checked_at=NOW()");await pruneCartSimulation(pool);assert.equal((await candidate()).length,0);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_cart_simulation_checks')).rows[0].n,0);
 assert.equal((await run()).run.created_count,1);
});
test('failed journal write rolls back the entire calculation',async()=>{
 await pool.query("CREATE FUNCTION cart_sim_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$");await pool.query('CREATE TRIGGER cart_sim_fail BEFORE INSERT ON buyer_cart_simulation_checks FOR EACH ROW EXECUTE FUNCTION cart_sim_fail()');
 try{await assert.rejects(run());assert.deepEqual(await totals(),{runs:0,candidates:0,checks:0});assert.equal((await preview()).eligible,true);}
 finally{await pool.query('DROP TRIGGER cart_sim_fail ON buyer_cart_simulation_checks');await pool.query('DROP FUNCTION cart_sim_fail()');}
});
test('overlarge current cohort fails explicitly without partial records',async()=>{
 const rows=Array.from({length:1000},(_,i)=>({cycle_id:randomUUID(),brand_id:'overflow_'+i}));
 await pool.query(`INSERT INTO buyer_cart_cycles(cycle_id,buyer_id,brand_id,state,provenance,content_hash)
 SELECT cycle_id,$2,brand_id,'empty','versioned',$3 FROM jsonb_to_recordset($1::jsonb) AS x(cycle_id uuid,brand_id text)`,[JSON.stringify(rows),buyer,state.cycles[0].content_hash]);
 await assert.rejects(run(),e=>e.code==='cart_cohort_limit');assert.deepEqual(await totals(),{runs:0,candidates:0,checks:0});
});
