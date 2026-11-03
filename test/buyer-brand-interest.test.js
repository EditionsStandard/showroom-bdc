'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),{randomUUID,createHmac}=require('node:crypto'),{Pool}=require('pg');
const {startServer,id}=require('./helpers');
const {NOTICE_VERSION,savePreference,recordBrandDay,runBrandInterest,getBrandInterest,pruneBrandInterest}=require('../lib/buyer-brand-interest');
let server,pool,buyer,brand,owner,buyerCookie;
const endpoint='/api/admin/buyer-engagement/brand-interest';
async function cookie(session){const sid=randomUUID(),now=Date.now();await pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,...session})]);return 'sid='+encodeURIComponent('s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,''));}
async function request(path,{session=owner,method='GET',body}={}){const r=await fetch(server.baseUrl+path,{method,redirect:'manual',headers:{'Content-Type':'application/json',...(session?{Cookie:session}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
const setPreference=(interest_consent,version=0)=>savePreference(pool,buyer,{interest_consent,version,notice_version:NOTICE_VERSION});
const run=(kind='generate',request_key=randomUUID())=>runBrandInterest(pool,{kind,request_key});
const view=()=>getBrandInterest(pool);
const totals=async()=> (await pool.query(`SELECT (SELECT COUNT(*)::int FROM buyer_brand_interest_runs) AS runs,(SELECT COUNT(*)::int FROM buyer_brand_interest_candidates) AS candidates,(SELECT COUNT(*)::int FROM buyer_brand_interest_checks) AS checks,(SELECT COUNT(*)::int FROM buyer_brand_interest_days) AS observations`)).rows[0];
async function days(values=[1,2,3],b=brand){for(const n of values)await pool.query(`INSERT INTO buyer_brand_interest_days(buyer_id,brand_id,visit_day,observed_at,consent_version)
 VALUES($1,$2,((NOW()-make_interval(days=>$3)) AT TIME ZONE 'UTC')::date,NOW()-make_interval(days=>$3),1)`,[buyer,b,n]);}
before(async()=>{
 server=await startServer({dbNameSuffix:'brand_interest_'+Date.now(),port:3236});pool=new Pool({connectionString:server.dbUrl});
 await pool.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
 const ownerId=id('owner');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,'interest-owner@example.test','not-a-password','Synthetic owner','owner',true)",[ownerId]);owner=await cookie({staffUser:{id:ownerId,email:'interest-owner@example.test',role:'owner',mfaEnrolled:true}});
});
beforeEach(async()=>{
 await pool.query('TRUNCATE buyer_brand_interest_runs CASCADE');await pool.query('DELETE FROM buyers');await pool.query('DELETE FROM orders');await pool.query('DELETE FROM brands');
 await pool.query("UPDATE buyer_engagement_rules SET mode='disabled',version=version+1");await pool.query("UPDATE buyer_engagement_rules SET mode='simulation',delay_hours=168,min_distinct_days=3 WHERE id='brand_interest'");await pool.query('UPDATE buyer_engagement_simulation_control SET paused=false');
 buyer=id('buyer');brand=id('brand');
 await pool.query("INSERT INTO brands(id,name,subscription_status) VALUES($1,'Synthetic brand','active')",[brand]);
 await pool.query("INSERT INTO buyers(id,email,password_hash,name,approved_at,last_login_at,activation_pending) VALUES($1,$2,'not-a-password','Private synthetic buyer',NOW()-INTERVAL '70 days',NOW()-INTERVAL '1 hour',false)",[buyer,buyer+'@example.test']);
 await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,'granted','synthetic','v1')",[buyer]);
 buyerCookie=await cookie({buyerPortal:{id:buyer,email:buyer+'@example.test',name:'Synthetic buyer'}});
});
after(async()=>{server?.stop();await pool?.end();});
test('marketing permission alone never authorises observations; preferences start unknown',async()=>{
 const pref=await request('/api/portal/interest-preferences',{session:buyerCookie});assert.equal(pref.body.status,'unknown');assert.equal(pref.body.collecting_enabled,false);
 assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);assert.equal((await totals()).observations,0);
});
test('explicit grant records at most one observation per brand and server UTC day despite parallel retries',async()=>{
 const pref=await setPreference(true);assert.equal(pref.version,1);
 const outcomes=await Promise.all(Array.from({length:5},()=>recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1,observed_at:'2000-01-01',buyer_id:'someone-else'})));
 assert.equal(outcomes.filter(o=>o.recorded).length,1);assert.equal((await totals()).observations,1);
 const row=(await pool.query('SELECT *,visit_day=(NOW() AT TIME ZONE \'UTC\')::date AS today FROM buyer_brand_interest_days')).rows[0];assert.equal(row.today,true);assert.equal(row.buyer_id,buyer);
 assert.equal((await pool.query('SELECT last_meaningful_activity_at FROM buyers WHERE id=$1',[buyer])).rows[0].last_meaningful_activity_at,null,'optional measurement does not overwrite the shared activity timestamp');
});
test('disabled rule and global pause prevent collection without affecting access',async()=>{
 await setPreference(true);await pool.query("UPDATE buyer_engagement_rules SET mode='disabled' WHERE id='brand_interest'");assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);
 await pool.query("UPDATE buyer_engagement_rules SET mode='simulation' WHERE id='brand_interest'");await pool.query('UPDATE buyer_engagement_simulation_control SET paused=true');assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);
 assert.equal((await request('/api/portal/brands',{session:buyerCookie})).status,200);
});
test('pause acknowledgement waits for an in-flight observation, then prevents further collection',async()=>{
 await setPreference(true);let entered,release;
 const atInsert=new Promise(resolve=>entered=resolve),continueInsert=new Promise(resolve=>release=resolve);
 const proxy={connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{if(typeof sql==='string'&&sql.includes('INSERT INTO buyer_brand_interest_days')){entered();await continueInsert;}return c.query(sql,args);},release:()=>c.release()};}};
 const recording=recordBrandDay(proxy,buyer,{brand_id:brand,consent_version:1});await atInsert;
 const pauser=await pool.connect(),pid=(await pauser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;let completed=false;
 const pausing=pauser.query('UPDATE buyer_engagement_simulation_control SET paused=true').then(()=>{completed=true;});
 try {
  let waiting=false;
  for(let retry=0;retry<100;retry++){waiting=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',[pid])).rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(waiting,true);assert.equal(completed,false);release();assert.equal((await recording).recorded,true);await pausing;
  assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);
 } finally {release();await Promise.allSettled([recording,pausing]);pauser.release();}
});
test('unapproved, incomplete and future access dates prevent collection',async()=>{
 await setPreference(true);
 for(const sql of ["UPDATE buyers SET approved_at=NULL WHERE id=$1","UPDATE buyers SET approved_at=NOW(),activation_pending=true WHERE id=$1","UPDATE buyers SET activation_pending=false,last_login_at=NULL WHERE id=$1","UPDATE buyers SET last_login_at=NOW()+INTERVAL '1 day' WHERE id=$1"]){await pool.query(sql,[buyer]);assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);}
});
test('hidden and inactive brands cannot produce observations; privilege is evaluated per brand',async()=>{
 await setPreference(true);assert.equal((await recordBrandDay(pool,buyer,{brand_id:'missing',consent_version:1})).recorded,false);
 await pool.query("UPDATE brands SET subscription_status='inactive' WHERE id=$1",[brand]);assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);
 await pool.query("UPDATE brands SET subscription_status='active',early_access_until=NOW()+INTERVAL '1 day' WHERE id=$1",[brand]);assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);
 await pool.query('INSERT INTO buyer_brand_terms(buyer_id,brand_id,is_privileged) VALUES($1,$2,true)',[buyer,brand]);assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,true);
});
test('withdrawing tracking deletes observations and signal history but preserves preference evidence',async()=>{
 await setPreference(true);await days();await run();assert.equal((await totals()).candidates,1);
 await setPreference(false,0);assert.deepEqual(await totals(),{runs:1,candidates:0,checks:0,observations:0});
 const history=(await pool.query('SELECT status FROM buyer_interest_preference_events WHERE buyer_id=$1 ORDER BY version',[buyer])).rows;assert.deepEqual(history.map(r=>r.status),['granted','denied']);
});
test('old observation requests cannot cross withdrawal and regrant; new permission starts fresh',async()=>{
 await setPreference(true);await days();await setPreference(false,1);const pref=await setPreference(true,2);assert.equal(pref.version,3);
 assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);
 assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:3})).recorded,true);assert.equal((await view()).rows[0].distinct_days,1);
});
test('stale grants fail closed and stale withdrawals win; notice version must match',async()=>{
 await setPreference(true);await setPreference(false,1);await assert.rejects(setPreference(true,1),e=>e.status===409);
 await assert.rejects(savePreference(pool,buyer,{interest_consent:true,version:2,notice_version:'old-notice'}),e=>e.status===400);
 const denied=await setPreference(false,0);assert.equal(denied.version,2);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_interest_preference_events')).rows[0].n,2);
});
test('an obsolete notice never authorises collection and renewed permission starts without historic observations',async()=>{
 await setPreference(true);await days();await run();await pool.query("UPDATE buyer_interest_preferences SET notice_version='obsolete' WHERE buyer_id=$1",[buyer]);
 const pref=await request('/api/portal/interest-preferences',{session:buyerCookie});assert.equal(pref.body.status,'unknown');assert.equal(pref.body.collecting_enabled,false);assert.equal(pref.body.version,1);
 assert.equal((await view()).rows[0].reason,'interest_permission_missing');assert.equal((await recordBrandDay(pool,buyer,{brand_id:brand,consent_version:1})).recorded,false);
 assert.equal((await setPreference(true,1)).version,2);assert.deepEqual(await totals(),{runs:1,candidates:0,checks:0,observations:0});
});
test('preview is read only, requires distinct days and ignores historic product counters',async()=>{
 await setPreference(true);await days([1,2]);const before=await totals();let value=await view();assert.equal(value.rows[0].eligible,false);assert.equal(value.rows[0].reason,'interest_days_insufficient');assert.deepEqual(await totals(),before);
 await days([3]);value=await view();assert.equal(value.rows[0].eligible,true);assert.equal(value.mode,'simulation');assert.equal(value.crm_writes_enabled,false);assert.equal(value.sending_enabled,false);
});
test('rolling window includes its exact boundary and excludes one microsecond earlier',async()=>{
 await setPreference(true);await days();
 const proxy=delta=>({connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{if(typeof sql==='string'&&sql.includes('WITH visits AS'))await c.query(`UPDATE buyer_brand_interest_days SET observed_at=NOW()-INTERVAL '168 hours'+$2::interval,visit_day=((NOW()-INTERVAL '168 hours'+$2::interval) AT TIME ZONE 'UTC')::date WHERE buyer_id=$1 AND visit_day=((NOW()-INTERVAL '3 days') AT TIME ZONE 'UTC')::date`,[buyer,delta]);return c.query(sql,args);},release:()=>c.release()};}});
 assert.equal((await runBrandInterest(proxy('0 seconds'),{kind:'generate',request_key:randomUUID()})).run.created_count,1);
 await pool.query("UPDATE buyer_brand_interest_days SET observed_at=NOW()-INTERVAL '3 days',visit_day=((NOW()-INTERVAL '3 days') AT TIME ZONE 'UTC')::date WHERE buyer_id=$1 AND visit_day<((NOW()-INTERVAL '3 days') AT TIME ZONE 'UTC')::date",[buyer]);
 assert.equal((await runBrandInterest(proxy('-1 microsecond'),{kind:'recheck',request_key:randomUUID()})).run.eligible_count,0);
});
test('repeated runs and request replay keep a single signal per buyer and brand',async()=>{
 await setPreference(true);await days();const key=randomUUID(),first=await run('generate',key),replay=await run('generate',key);assert.equal(replay.run.id,first.run.id);assert.equal(replay.replayed,true);
 assert.equal((await run()).run.created_count,0);assert.deepEqual(await totals(),{runs:2,candidates:1,checks:2,observations:3});await assert.rejects(run('recheck',key),e=>e.status===409);
 const second=id('brand');await pool.query("INSERT INTO brands(id,name) VALUES($1,'Second synthetic brand')",[second]);await days([1,2,3],second);assert.equal((await run()).run.created_count,1);
});
test('marketing withdrawal excludes immediately while recorded checks remain historical',async()=>{
 await setPreference(true);await days();await run();await pool.query("UPDATE buyer_email_preferences SET status='denied' WHERE buyer_id=$1",[buyer]);let value=await view();assert.equal(value.rows[0].recorded.status,'eligible');assert.equal(value.rows[0].reason,'marketing_permission_missing');
 await run('recheck');value=await view();assert.equal(value.rows[0].recorded.status,'excluded');assert.equal((await totals()).observations,3);
});
test('orders and recent engagement contacts suppress sales signals',async()=>{
 await setPreference(true);await days();await pool.query("UPDATE buyers SET last_engagement_email_at=NOW() WHERE id=$1",[buyer]);assert.equal((await view()).rows[0].reason,'recent_contact');
 await pool.query('UPDATE buyers SET last_engagement_email_at=NULL WHERE id=$1',[buyer]);
 await pool.query("INSERT INTO orders(id,brand_id,buyer_id,client_name,client_email,status) VALUES($1,$2,$3,'Synthetic','synthetic@example.test','draft')",[id('order'),brand,buyer]);assert.equal((await view()).rows[0].eligible,true);
 await pool.query("UPDATE orders SET status='confirmed' WHERE buyer_id=$1",[buyer]);assert.equal((await view()).rows[0].reason,'order_since_observations');await pool.query("UPDATE orders SET status='cancelled' WHERE buyer_id=$1",[buyer]);assert.equal((await view()).rows[0].eligible,true);
});
test('pause blocks generation and permits recording exclusions on recheck',async()=>{
 await setPreference(true);await days();await run();await pool.query('UPDATE buyer_engagement_simulation_control SET paused=true');await assert.rejects(run(),e=>e.code==='simulation_paused');assert.equal((await run('recheck')).run.excluded_count,1);
});
test('owner rule update validates window and day threshold and preserves optimistic concurrency',async()=>{
 const rule=(await pool.query("SELECT * FROM buyer_engagement_rules WHERE id='brand_interest'")).rows[0];
 const payload={mode:'simulation',delay_hours:336,min_distinct_days:3,version:rule.version};assert.equal((await request('/api/admin/buyer-engagement/rules/brand_interest',{method:'PUT',body:payload})).status,200);
 assert.equal((await request('/api/admin/buyer-engagement/rules/brand_interest',{method:'PUT',body:payload})).status,409);
 for(const change of [{delay_hours:25},{delay_hours:744},{min_distinct_days:1},{min_distinct_days:31},{delay_hours:72,min_distinct_days:4}])assert.equal((await request('/api/admin/buyer-engagement/rules/brand_interest',{method:'PUT',body:{...payload,...change,version:rule.version+1}})).status,400);
});
test('admin routes are owner only; observations use the authenticated buyer identity',async()=>{
 assert.equal((await request(endpoint,{session:null})).status,403);assert.equal((await request(endpoint,{session:buyerCookie})).status,403);
 const agent=id('agent');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,$2,'not-a-password','Synthetic','agent',true)",[agent,agent+'@example.test']);assert.equal((await request(endpoint,{session:await cookie({staffUser:{id:agent,role:'agent',mfaEnrolled:true}})})).status,403);
 await setPreference(true);const response=await request('/api/portal/brand-interest',{session:buyerCookie,method:'POST',body:{brand_id:brand,consent_version:1,buyer_id:'other'}});assert.equal(response.status,200);assert.equal(response.body.recorded,true);
 assert.equal((await request('/api/portal/brand-interest',{session:null,method:'POST',body:{brand_id:brand,consent_version:1}})).status,401);
});
test('buyer export and deletion cover observation, preference and signal data',async()=>{
 await setPreference(true);await days();await run();const exported=await request('/api/portal/gdpr/export',{session:buyerCookie});assert.equal(exported.status,200);const data=exported.body.engagement.brand_interest;assert.equal(data.observations.length,3);assert.equal(data.candidates.length,1);assert.equal(data.checks.length,1);assert.equal(data.preference_history.length,1);
 await pool.query('DELETE FROM buyers WHERE id=$1',[buyer]);assert.deepEqual(await totals(),{runs:1,candidates:0,checks:0,observations:0});assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_interest_preferences')).rows[0].n,0);
});
test('simulation tables copy no buyer contact or messages and forbid delivery states',async()=>{
 await setPreference(true);await days();await run();const recorded=JSON.stringify((await pool.query('SELECT * FROM buyer_brand_interest_candidates')).rows);assert.equal(recorded.includes('Private synthetic buyer'),false);assert.equal(recorded.includes('@example.test'),false);
 await assert.rejects(pool.query("UPDATE buyer_brand_interest_runs SET mode='send'"));await assert.rejects(pool.query("UPDATE buyer_brand_interest_candidates SET status='sent'"));assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_preparation_jobs')).rows[0].n,0);
});
test('retention removes observations at 30 days and candidates by creation age, not recheck age',async()=>{
 await setPreference(true);await days();await run();await pool.query("UPDATE buyer_brand_interest_days SET observed_at=NOW()-INTERVAL '31 days'");await pruneBrandInterest(pool);assert.equal((await totals()).observations,0);assert.equal((await view()).rows[0].reason,'interest_days_insufficient');
 await pool.query("UPDATE buyer_brand_interest_candidates SET created_at=NOW()-INTERVAL '91 days',checked_at=NOW()");await pruneBrandInterest(pool);assert.equal((await totals()).candidates,0);assert.equal((await totals()).checks,0);
 await require('../lib/buyer-brand-interest-migration').migrateBrandInterest(pool);assert.equal((await totals()).runs,1);
});
test('failed history insertion rolls back the complete run and signals',async()=>{
 await setPreference(true);await days();await pool.query("CREATE FUNCTION interest_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$");await pool.query('CREATE TRIGGER interest_fail BEFORE INSERT ON buyer_brand_interest_checks FOR EACH ROW EXECUTE FUNCTION interest_fail()');
 try{await assert.rejects(run());assert.deepEqual(await totals(),{runs:0,candidates:0,checks:0,observations:3});}finally{await pool.query('DROP TRIGGER interest_fail ON buyer_brand_interest_checks');await pool.query('DROP FUNCTION interest_fail()');}
});
test('shared engine lock prevents concurrent runs',async()=>{
 const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1'))");await assert.rejects(run(),e=>e.code==='simulation_busy');}finally{await db.query('ROLLBACK');db.release();}
});
test('concurrent tracking withdrawal cannot leave a stale candidate after a committed calculation',async()=>{
 await setPreference(true);await days();let entered,release;
 const atInsert=new Promise(resolve=>entered=resolve),continueInsert=new Promise(resolve=>release=resolve);
 const proxy={connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{if(typeof sql==='string'&&sql.includes('INSERT INTO buyer_brand_interest_checks')){entered();await continueInsert;}return c.query(sql,args);},release:()=>c.release()};}};
 const calculating=runBrandInterest(proxy,{kind:'generate',request_key:randomUUID()});await atInsert;
 const withdrawal=setPreference(false,1);release();await Promise.all([calculating,withdrawal]);
 assert.deepEqual(await totals(),{runs:1,candidates:0,checks:0,observations:0});
});
test('overlarge buyer-brand cohort fails without partial simulation records',async()=>{
 await setPreference(true);const rows=Array.from({length:5001},(_,i)=>({id:'overflow_'+i}));
 await pool.query("INSERT INTO brands(id,name) SELECT id,'Synthetic overflow' FROM jsonb_to_recordset($1::jsonb) AS x(id text)",[JSON.stringify(rows)]);
 await pool.query(`INSERT INTO buyer_brand_interest_days(buyer_id,brand_id,consent_version) SELECT $2,id,1 FROM jsonb_to_recordset($1::jsonb) AS x(id text)`,[JSON.stringify(rows),buyer]);
 await assert.rejects(run(),e=>e.code==='interest_cohort_limit');assert.deepEqual(await totals(),{runs:0,candidates:0,checks:0,observations:5001});
});
