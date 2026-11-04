'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),{randomUUID,createHmac}=require('node:crypto'),{Pool}=require('pg');
const {startServer,id}=require('./helpers'),{createBuyerCartService}=require('../lib/buyer-cart');
const {savePreference,runBrandInterest}=require('../lib/buyer-brand-interest');
const {runCartSimulation}=require('../lib/buyer-cart-engagement');
const {runRetention,retentionHealth,startRetentionScheduler}=require('../lib/buyer-engagement-retention');
let server,pool,carts,owner,buyerCookie,oldBuyer,currentBuyer,brand,product,startup;
const endpoint='/api/admin/buyer-engagement/retention';
const run=(request_key=randomUUID())=>runRetention(pool,{trigger:'manual',request_key});
async function cookie(session){const sid=randomUUID(),now=Date.now();await pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,...session})]);return 'sid='+encodeURIComponent('s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,''));}
async function request(path,{session=owner,method='GET',body}={}){const r=await fetch(server.baseUrl+path,{method,redirect:'manual',headers:{'Content-Type':'application/json',...(session?{Cookie:session}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
async function count(table,where='',args=[]){return (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`,args)).rows[0].n;}
async function expired(){
 await pool.query("UPDATE buyer_brand_interest_candidates SET created_at=NOW()-INTERVAL '91 days' WHERE buyer_id=$1",[oldBuyer]);
 await pool.query("UPDATE buyer_cart_simulation_candidates SET created_at=NOW()-INTERVAL '91 days' WHERE buyer_id=$1",[oldBuyer]);
 await pool.query("UPDATE buyer_brand_interest_days SET observed_at=NOW()-INTERVAL '31 days' WHERE buyer_id=$1",[oldBuyer]);
 for(const table of ['buyer_brand_interest_runs','buyer_cart_simulation_runs'])await pool.query(`INSERT INTO ${table}(id,request_key,kind,scanned_count,created_count,rechecked_count,eligible_count,excluded_count,rule_snapshot,created_at)
   VALUES($1,$2,'generate',0,0,0,0,0,'{}',NOW()-INTERVAL '366 days')`,[randomUUID(),randomUUID()]);
}
function proxyBeforeCleanup(fn){return {connect:async()=>{const c=await pool.connect();let done=false;return {query:async(sql,args)=>{if(!done&&typeof sql==='string'&&sql.startsWith('WITH doomed AS')){done=true;await fn(c);}return c.query(sql,args);},release:e=>c.release(e)};}};}
before(async()=>{
 server=await startServer({dbNameSuffix:'retention_'+Date.now(),port:3240});pool=new Pool({connectionString:server.dbUrl});carts=createBuyerCartService(pool);
 startup=(await pool.query('SELECT * FROM buyer_engagement_retention_runs')).rows;
 await pool.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
 const ownerId=id('owner');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,'retention-owner@example.test','not-a-password','Synthetic owner','owner',true)",[ownerId]);owner=await cookie({staffUser:{id:ownerId,email:'retention-owner@example.test',role:'owner',mfaEnrolled:true}});
});
beforeEach(async()=>{
 await pool.query('TRUNCATE buyer_engagement_retention_runs,buyer_brand_interest_runs,buyer_cart_simulation_runs CASCADE');await pool.query('DELETE FROM buyers');await pool.query('DELETE FROM orders');await pool.query('DELETE FROM brands');
 await pool.query("UPDATE buyer_engagement_rules SET mode='disabled'");await pool.query("UPDATE buyer_engagement_rules SET mode='simulation',delay_hours=168,min_distinct_days=3 WHERE id='brand_interest'");await pool.query("UPDATE buyer_engagement_rules SET mode='simulation',delay_hours=48 WHERE id='cart'");await pool.query('UPDATE buyer_engagement_simulation_control SET paused=false');
 oldBuyer=id('old');currentBuyer=id('current');brand=id('brand');product=id('product');
 await pool.query("INSERT INTO brands(id,name,subscription_status,min_per_reference) VALUES($1,'Synthetic retention brand','active',1)",[brand]);await pool.query("INSERT INTO products(id,brand_id,reference,price,sizes,color) VALUES($1,$2,'RETENTION-ONLY',10,'M','Gold')",[product,brand]);
 for(const buyer of [oldBuyer,currentBuyer]){
  await pool.query("INSERT INTO buyers(id,email,password_hash,name,approved_at,last_login_at,activation_pending) VALUES($1,$2,'not-a-password','Private synthetic buyer',NOW()-INTERVAL '70 days',NOW()-INTERVAL '3 days',false)",[buyer,buyer+'@example.test']);
  await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,'granted','synthetic','v1')",[buyer]);await savePreference(pool,buyer,{interest_consent:true,version:0,notice_version:'brand-interest-v1'});
  await pool.query(`INSERT INTO buyer_brand_interest_days(buyer_id,brand_id,visit_day,observed_at,consent_version) SELECT $1,$2,((NOW()-make_interval(days=>n)) AT TIME ZONE 'UTC')::date,NOW()-make_interval(days=>n),1 FROM generate_series(1,3) AS n`,[buyer,brand]);
  const state=await carts.snapshot(buyer);await carts.save(buyer,{...state,cart:{line:{brand_id:brand,product_id:product,qty:2,size:'M',color:'Gold',note:''}}});
 }
 await pool.query("UPDATE buyer_cart_cycles SET changed_at=NOW()-INTERVAL '65 hours'");await pool.query("UPDATE buyers SET last_meaningful_activity_at=NOW()-INTERVAL '65 hours',last_seen_at=NULL");
 await runBrandInterest(pool,{kind:'generate',request_key:randomUUID()});await runCartSimulation(pool,{kind:'generate',request_key:randomUUID()});
 buyerCookie=await cookie({buyerPortal:{id:currentBuyer,email:currentBuyer+'@example.test',name:'Synthetic buyer'}});
});
after(async()=>{server?.stop();await pool?.end();});
test('startup records its actual result while the test server keeps all background scheduling disabled',async()=>{
 assert.equal(startup.length,1);assert.equal(startup[0].trigger,'startup');assert.equal(startup[0].status,'succeeded');
 const response=await request(endpoint);assert.equal(response.status,200);assert.equal(response.body.runtime.enabled,false);assert.equal(response.body.attention,true);assert.equal(response.body.sending_enabled,false);assert.equal(response.body.crm_writes_enabled,false);
 assert.equal((await request('/api/portal/interest-preferences',{session:buyerCookie})).body.retention_schedule_enabled,false);
});
test('an isolated server can schedule retention while legacy background jobs remain disabled',async()=>{
 const isolated=await startServer({dbNameSuffix:'retention_only_'+Date.now(),port:3244,retentionOnly:true}),db=new Pool({connectionString:isolated.dbUrl});
 try {
  await db.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
  const ownerId=id('owner'),sid=randomUUID(),now=Date.now();await db.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,'isolated-owner@example.test','not-a-password','Synthetic owner','owner',true)",[ownerId]);
  await db.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,staffUser:{id:ownerId,role:'owner',mfaEnrolled:true}})]);
  const signed='s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  const response=await fetch(isolated.baseUrl+endpoint,{headers:{Cookie:'sid='+encodeURIComponent(signed)}});assert.equal(response.status,200);const health=await response.json();assert.equal(health.runtime.enabled,true);assert.equal(health.attention,false);assert.equal(health.runs[0].trigger,'startup');assert.equal(health.runs[0].status,'succeeded');
 } finally {isolated.stop();await db.end();}
});
test('expired simulations are deleted with their checks; current data, accounts, preferences, cart cycles and orders survive',async()=>{
 await expired();await pool.query("INSERT INTO orders(id,brand_id,buyer_id,client_name,client_email,status) VALUES($1,$2,$3,'Synthetic','synthetic@example.test','confirmed')",[id('order'),brand,currentBuyer]);
 const result=await run();assert.equal(result.run.status,'succeeded');assert.deepEqual(result.run.counts,{brand_candidates:1,brand_observations:3,brand_runs:1,cart_candidates:1,cart_runs:1,outbox:0,outbox_operations:0,outbox_payloads:0});
 for(const table of ['buyer_brand_interest_candidates','buyer_cart_simulation_candidates']){assert.equal(await count(table,'WHERE buyer_id=$1',[oldBuyer]),0);assert.equal(await count(table,'WHERE buyer_id=$1',[currentBuyer]),1);}
 assert.equal(await count('buyer_brand_interest_checks'),1);assert.equal(await count('buyer_cart_simulation_checks'),1);assert.equal(await count('buyers'),2);assert.equal(await count('buyer_interest_preferences'),2);assert.equal(await count('buyer_interest_preference_events'),2);assert.equal(await count('buyer_cart_cycles'),2);assert.equal(await count('orders'),1);
});
test('exact retention boundaries are preserved rather than deleted early',async()=>{
 await expired();
 const proxy=proxyBeforeCleanup(async c=>{
  await c.query("UPDATE buyer_brand_interest_candidates SET created_at=NOW()-INTERVAL '90 days' WHERE buyer_id=$1",[oldBuyer]);await c.query("UPDATE buyer_cart_simulation_candidates SET created_at=NOW()-INTERVAL '90 days' WHERE buyer_id=$1",[oldBuyer]);await c.query("UPDATE buyer_brand_interest_days SET observed_at=NOW()-INTERVAL '30 days' WHERE buyer_id=$1",[oldBuyer]);
  for(const table of ['buyer_brand_interest_runs','buyer_cart_simulation_runs'])await c.query(`UPDATE ${table} SET created_at=NOW()-INTERVAL '365 days' WHERE created_at<NOW()-INTERVAL '365 days'`);
 });
 const result=await runRetention(proxy,{trigger:'manual',request_key:randomUUID()});assert.equal(result.run.status,'succeeded');assert.equal(Object.values(result.run.counts).reduce((a,b)=>a+b,0),0);
});
test('bounded batches expose a backlog and a later run completes it',async()=>{
 const rows=Array.from({length:1001},(_,i)=>({id:'expired_'+i}));await pool.query("INSERT INTO buyers(id,email,password_hash) SELECT id,id||'@example.test','not-a-password' FROM jsonb_to_recordset($1::jsonb) AS x(id text)",[JSON.stringify(rows)]);
 await pool.query("INSERT INTO buyer_brand_interest_days(buyer_id,brand_id,consent_version,observed_at) SELECT id,$2,1,NOW()-INTERVAL '31 days' FROM jsonb_to_recordset($1::jsonb) AS x(id text)",[JSON.stringify(rows),brand]);
 const first=await run();assert.equal(first.run.status,'partial');assert.equal(first.run.counts.brand_observations,1000);assert.equal(first.run.remaining.brand_observations,true);assert.equal((await retentionHealth(pool)).last_success_at,null);
 const second=await run();assert.equal(second.run.status,'succeeded');assert.equal(second.run.counts.brand_observations,1);assert.equal(await count('buyer_brand_interest_days'),6);
});
test('locked expired rows remain visible as backlog and are retried after release',async()=>{
 await expired();const db=await pool.connect();try{await db.query('BEGIN');await db.query('SELECT id FROM buyer_brand_interest_candidates WHERE buyer_id=$1 FOR UPDATE',[oldBuyer]);const result=await run();assert.equal(result.run.status,'partial');assert.equal(result.run.remaining.brand_candidates,true);assert.equal(result.run.counts.brand_candidates,0);}finally{await db.query('ROLLBACK');db.release();}
 assert.equal((await run()).run.status,'succeeded');assert.equal(await count('buyer_brand_interest_candidates','WHERE buyer_id=$1',[oldBuyer]),0);
});
test('cleanup failure rolls back every deletion and records only a sanitized failure code',async()=>{
 await expired();await pool.query("CREATE FUNCTION retention_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Private synthetic detail'; END; $$");await pool.query('CREATE TRIGGER retention_fail BEFORE DELETE ON buyer_brand_interest_days FOR EACH ROW EXECUTE FUNCTION retention_fail()');
 let result;try{result=await run();assert.equal(result.run.status,'failed');assert.equal(result.run.error_code,'retention_failed');assert.deepEqual(result.run.counts,{});assert.equal(await count('buyer_brand_interest_candidates'),2);assert.equal(await count('buyer_brand_interest_days'),6);assert.equal(JSON.stringify(result).includes('Private synthetic detail'),false);}finally{await pool.query('DROP TRIGGER retention_fail ON buyer_brand_interest_days');await pool.query('DROP FUNCTION retention_fail()');}
 assert.equal((await run(result.run.request_key)).run.status,'failed');assert.equal((await run()).run.status,'succeeded');
});
test('lost commit acknowledgement cannot overwrite a committed success or repeat its deletions',async()=>{
 await expired();const proxy={connect:async()=>{const c=await pool.connect();let lost=false;return {query:async(sql,args)=>{const result=await c.query(sql,args);if(sql==='COMMIT'&&!lost){lost=true;throw Object.assign(new Error('Synthetic lost acknowledgement'),{code:'ECONNRESET'});}return result;},release:e=>c.release(e)};}};
 const key=randomUUID(),first=await runRetention(proxy,{trigger:'manual',request_key:key});assert.equal(first.run.status,'succeeded');const replay=await run(key);assert.equal(replay.replayed,true);assert.equal(replay.run.id,first.run.id);assert.deepEqual(replay.run.counts,first.run.counts);assert.equal(await count('buyer_engagement_retention_runs'),1);
});
test('shared simulation engine contention records a deferral without changing expired data',async()=>{
 await expired();const db=await pool.connect();let deferred;try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1'))");deferred=await run();assert.equal(deferred.run.status,'skipped_busy');assert.equal(await count('buyer_brand_interest_candidates'),2);}finally{await db.query('ROLLBACK');db.release();}
 assert.equal((await run(deferred.run.request_key)).run.status,'skipped_busy');assert.equal((await run()).run.status,'succeeded');
});
test('a crashed running attempt is marked interrupted before a new operation is allowed',async()=>{
 await expired();const key=randomUUID();await pool.query("INSERT INTO buyer_engagement_retention_runs(id,request_key,trigger,status,started_at) VALUES($1,$2,'manual','running',NOW()-INTERVAL '20 minutes')",[randomUUID(),key]);
 assert.equal((await retentionHealth(pool)).stalled,true);const result=await run(key);assert.equal(result.run.status,'interrupted');assert.equal(await count('buyer_brand_interest_candidates'),2);assert.equal((await run()).run.status,'succeeded');
});
test('scheduled work respects the six-hour cadence and retries an incomplete batch',async()=>{
 await run();const before=await count('buyer_engagement_retention_runs');assert.deepEqual(await runRetention(pool,{trigger:'scheduled',onlyIfDue:true}),{not_due:true});assert.equal(await count('buyer_engagement_retention_runs'),before);
 await expired();await pool.query("UPDATE buyer_engagement_retention_runs SET started_at=NOW()-INTERVAL '7 hours',finished_at=NOW()-INTERVAL '7 hours'");assert.equal((await runRetention(pool,{trigger:'scheduled',onlyIfDue:true})).run.status,'succeeded');
});
test('scheduler can execute the real cleanup under a virtual timer while disabled mode schedules nothing',async()=>{
 let callback,delay,cancelled=false;const disabled=startRetentionScheduler(pool,{enabled:false,schedule:()=>{throw new Error('Disabled scheduler must not schedule');}});disabled.stop();assert.equal((await retentionHealth(pool)).runtime.enabled,false);
 await expired();const controller=startRetentionScheduler(pool,{enabled:true,schedule:(fn,ms)=>{callback=fn;delay=ms;return {unref(){}};},cancel:()=>{cancelled=true;}});
 try{assert.equal(delay,300000);await callback();assert.equal(await count('buyer_brand_interest_candidates','WHERE buyer_id=$1',[oldBuyer]),0);const health=await retentionHealth(pool);assert.equal(health.runs[0].trigger,'scheduled');assert.equal(health.runtime.enabled,true);assert.ok(health.runtime.last_tick_at);}finally{controller.stop();}assert.equal(cancelled,true);
});
test('monitoring is read only and flags stale success without inventing current health',async()=>{
 await run();await pool.query("UPDATE buyer_engagement_retention_runs SET finished_at=NOW()-INTERVAL '9 hours'");const before=await count('buyer_engagement_retention_runs'),health=await retentionHealth(pool);assert.equal(health.late,true);assert.equal(health.attention,true);assert.equal(await count('buyer_engagement_retention_runs'),before);
});
test('owner access is required and manual runs accept only an operation reference',async()=>{
 assert.equal((await request(endpoint,{session:null})).status,403);assert.equal((await request(endpoint,{session:buyerCookie})).status,403);
 const agent=id('agent');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,$2,'not-a-password','Synthetic','agent',true)",[agent,agent+'@example.test']);assert.equal((await request(endpoint,{session:await cookie({staffUser:{id:agent,role:'agent',mfaEnrolled:true}})})).status,403);
 assert.equal((await request(endpoint+'/runs',{method:'POST',body:{request_key:'invalid'}})).status,400);const key=randomUUID();const result=await request(endpoint+'/runs',{method:'POST',body:{request_key:key,table:'buyers',days:0,trigger:'scheduled'}});assert.equal(result.status,200);assert.equal(result.body.run.trigger,'manual');assert.equal(await count('buyers'),2);
 assert.equal((await request(endpoint+'/runs',{method:'POST',body:{request_key:key}})).body.replayed,true);
});
test('retention migration preserves job history and completed operations release the session lock',async()=>{
 const result=await run();await require('../lib/buyer-engagement-retention-migration').migrateRetention(pool);assert.equal(await count('buyer_engagement_retention_runs','WHERE id=$1',[result.run.id]),1);
 const other=new Pool({connectionString:server.dbUrl,max:1}),db=await other.connect();try{await db.query('BEGIN');assert.equal((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1')) AS acquired")).rows[0].acquired,true);}finally{await db.query('ROLLBACK');db.release();await other.end();}
});
test('an unconfirmed advisory-lock acquisition destroys the session instead of leaking the lease into the pool',async()=>{
 const proxy={connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{const result=await c.query(sql,args);if(typeof sql==='string'&&sql.includes('pg_try_advisory_lock('))throw Object.assign(new Error('Synthetic lost lock reply'),{code:'ECONNRESET'});return result;},release:e=>c.release(e)};}};
 await assert.rejects(runRetention(proxy,{trigger:'manual',request_key:randomUUID()}));
 const other=new Pool({connectionString:server.dbUrl,max:1}),db=await other.connect();try{await db.query('BEGIN');assert.equal((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1')) AS acquired")).rows[0].acquired,true);}finally{await db.query('ROLLBACK');db.release();await other.end();}
});
