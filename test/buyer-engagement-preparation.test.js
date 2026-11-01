'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const bcrypt=require('bcryptjs');
const {authenticator}=require('otplib');
const {Pool}=require('pg');
const {startServer,id}=require('./helpers');
const {runSimulation}=require('../lib/buyer-engagement-ledger');
const preparation=require('../lib/buyer-engagement-preparation');
let server,pool,owner,passwordHash;
const password='PreparationSyntheticPassword123!';
const endpoint='/api/admin/buyer-engagement/preparation-queue';
const key=()=>crypto.randomUUID();
async function request(path,{cookie=owner,method='GET',body}={}) {
  const response=await fetch(server.baseUrl+path,{method,redirect:'manual',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();
  return {status:response.status,data,response};
}
async function seedBuyer({kind='welcome',lang='fr',consent='granted'}={}) {
  const buyer=id('preparation_buyer');
  await pool.query(`INSERT INTO buyers(id,email,password_hash,name,company,lang,country,login_history_known,activation_pending,approved_at,last_login_at,last_meaningful_activity_at)
    VALUES($1,$2,$3,'Synthetic private name','Synthetic private company',$4,'FR',true,$5,NOW()-INTERVAL '80 days',
      CASE WHEN $5 THEN NULL ELSE NOW()-INTERVAL '40 days' END,
      CASE WHEN $5 THEN NULL ELSE NOW()-INTERVAL '40 days' END)`,[buyer,buyer+'@test.invalid',passwordHash,lang,kind==='welcome']);
  await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,$2,'synthetic_test','synthetic_v1')",[buyer,consent]);
  return buyer;
}
async function generate(...rules) {
  await pool.query("UPDATE buyer_engagement_rules SET mode='simulation' WHERE id=ANY($1::text[])",[rules]);
  return runSimulation(pool,{kind:'generate',request_key:key()});
}
async function enqueue(request_key=key()) {
  return request(endpoint+'/enqueue',{method:'POST',body:{request_key}});
}
async function resume() {
  const state=(await request(endpoint)).data.control;
  const result=await request(endpoint+'/control',{method:'PUT',body:{paused:false,version:state.version}});
  assert.equal(result.status,200,JSON.stringify(result.data));
  return result.data;
}
async function sessionCookie(session) {
  const sid=key(),now=Date.now();
  const payload={cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,...session};
  await pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify(payload)]);
  const signature=crypto.createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  return 'sid='+encodeURIComponent('s:'+sid+'.'+signature);
}
async function buyerCookie(buyer) {
  return sessionCookie({buyerPortal:{id:buyer,email:buyer+'@test.invalid',name:'Synthetic private name',company:'Synthetic private company',country:'FR'}});
}
function poolProxy(query) {
  return {connect:async()=>{const db=await pool.connect();return {query:(sql,args)=>query(db,sql,args),release:()=>db.release()};}};
}
before(async()=>{
  server=await startServer({dbNameSuffix:'preparation_'+crypto.randomBytes(6).toString('hex'),port:3222});
  pool=new Pool({connectionString:server.dbUrl});passwordHash=await bcrypt.hash(password,10);
  const secret=authenticator.generateSecret();
  await pool.query("INSERT INTO settings(key,value) VALUES('owner_mfa_enabled','on'),('owner_mfa_secret',$1),('owner_mfa_last_step','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[secret]);
  const initial=await request('/admin/login',{cookie:null,method:'POST',body:{password:'TestAdmin123!'}});
  const initialCookie=initial.response.headers.get('set-cookie').split(';')[0];
  const completed=await request('/admin/login/mfa',{cookie:initialCookie,method:'POST',body:{code:authenticator.generate(secret)}});
  assert.equal(completed.response.headers.get('location'),'/admin');
  owner=completed.response.headers.get('set-cookie')?.split(';')[0]||initialCookie;
});
after(async()=>{server?.stop();await pool?.end();});

const JOBS='buyer_engagement_preparation_jobs';
const EVENTS='buyer_engagement_preparation_events';
const CONTROL='buyer_engagement_preparation_control';
const OPERATIONS='buyer_engagement_preparation_enqueue_operations';
async function jobs(buyer) {
  const filter=buyer?' WHERE buyer_id=$1':'';
  return (await pool.query(`SELECT *,anchor_at::text AS exact_anchor FROM ${JOBS}${filter} ORDER BY created_at,id`,buyer?[buyer]:[])).rows;
}
async function counts() {
  return (await pool.query(`SELECT (SELECT COUNT(*)::int FROM ${JOBS}) AS jobs,
    (SELECT COUNT(*)::int FROM ${EVENTS}) AS events,(SELECT COUNT(*)::int FROM ${OPERATIONS}) AS operations,
    (SELECT COUNT(*)::int FROM pending_reminders) AS legacy_reminders,
    (SELECT COUNT(*)::int FROM buyer_password_resets) AS activation_tokens`)).rows[0];
}
async function prepareBuyer(options={}) {
  const buyer=await seedBuyer(options);
  await generate(options.kind==='inactive'?'inactive':'welcome');
  const result=await enqueue();assert.equal(result.status,200,JSON.stringify(result.data));
  return {buyer,job:(await jobs(buyer))[0]};
}
beforeEach(async()=>{
  await pool.query(`TRUNCATE ${OPERATIONS},${JOBS} CASCADE`);
  await pool.query('TRUNCATE buyer_engagement_simulation_runs CASCADE');
  await pool.query('DELETE FROM buyers');
  await pool.query("UPDATE buyer_engagement_rules SET mode='disabled',delay_hours=CASE id WHEN 'welcome' THEN 24 WHEN 'inactive' THEN 720 WHEN 'cart' THEN 48 ELSE 168 END,version=version+1");
  await pool.query("UPDATE buyer_engagement_templates SET subject='Synthetic preparation draft',body='Hello {{buyer_name}} — {{portal_url}}'");
  await pool.query('UPDATE buyer_engagement_simulation_control SET paused=false,version=version+1 WHERE id=true');
  await pool.query(`UPDATE ${CONTROL} SET paused=true,version=version+1 WHERE id=true`);
});

test('preparation is hard-locked to dry run, starts paused and never copies contact or creates legacy sends',async()=>{
  const welcome=await seedBuyer(),inactive=await seedBuyer({kind:'inactive',lang:'en'});
  await generate('welcome','inactive','cart','brand_interest');const before=await counts();
  const prepared=await enqueue();assert.equal(prepared.status,200,JSON.stringify(prepared.data));assert.equal(prepared.data.created_count,2);
  const queue=await request(endpoint);assert.equal(queue.status,200);assert.equal(queue.response.headers.get('cache-control'),'no-store');
  assert.equal(queue.data.mode,'dry_run');assert.equal(queue.data.delivery_enabled,false);assert.equal(queue.data.control.paused,true);assert.equal(queue.data.control.delivery_enabled,false);assert.equal(queue.data.jobs.total,2);
  assert.deepEqual(new Set((await jobs()).map(job=>job.buyer_id)),new Set([welcome,inactive]));
  assert.doesNotMatch(JSON.stringify(await jobs()),/@test\.invalid|Synthetic private|https?:|portal_url/);
  assert.ok(queue.data.jobs.rows.every(job=>!Object.hasOwn(job,'lease_token')));
  await assert.rejects(pool.query(`UPDATE ${CONTROL} SET delivery_enabled=true WHERE id=true`),{code:'23514'});
  await assert.rejects(pool.query(`UPDATE ${JOBS} SET mode='live'`),{code:'23514'});
  await assert.rejects(pool.query(`UPDATE ${JOBS} SET rule_id='cart'`),{code:'23514'});
  const after=await counts();assert.equal(after.legacy_reminders,before.legacy_reminders);assert.equal(after.activation_tokens,before.activation_tokens);
  const snapshot=await counts();await request(endpoint);await request(endpoint);assert.deepEqual(await counts(),snapshot,'GET must not mutate the queue');
});

test('enqueue replay recovers the same result and distinct request keys cannot duplicate an episode',async()=>{
  await seedBuyer();await generate('welcome');const requestKey=key();
  const first=await enqueue(requestKey),replay=await enqueue(requestKey);assert.equal(first.status,200);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
  for(const field of ['created_count','reused_count','rejected_count'])assert.equal(replay.data[field],first.data[field]);
  const distinct=await enqueue();assert.equal(distinct.status,200);assert.equal(distinct.data.created_count,0);assert.equal(distinct.data.reused_count,1);
  assert.equal((await jobs()).length,1);assert.equal((await counts()).operations,2);
  const invalid=await enqueue('private@email.invalid');assert.equal(invalid.status,400);assert.equal((await counts()).operations,2);
});

test('enqueue rejects candidates made stale by consent withdrawal or login before preparation',async()=>{
  const withdrawn=await seedBuyer(),logged=await seedBuyer(),current=await seedBuyer();await generate('welcome');
  const auth=await buyerCookie(withdrawn);
  assert.equal((await request('/api/portal/email-preferences',{cookie:auth,method:'PUT',body:{marketing_consent:false}})).status,200);
  await pool.query('UPDATE buyers SET first_login_at=NOW(),last_login_at=NOW(),last_meaningful_activity_at=NOW(),activation_pending=false WHERE id=$1',[logged]);
  const result=await enqueue();assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.created_count,1);assert.equal(result.data.rejected_count,2);
  assert.deepEqual((await jobs()).map(job=>job.buyer_id),[current]);
});

test('pause blocks processing, optimistic control rejects stale edits and a reserved job can be safely released',async()=>{
  const {job}=await prepareBuyer();const before=await counts();
  const blocked=await request(endpoint+'/process',{method:'POST',body:{batch_size:1}});assert.equal(blocked.status,409);assert.deepEqual(await counts(),before);
  const control=(await request(endpoint)).data.control;await resume();
  const conflict=await request(endpoint+'/control',{method:'PUT',body:{paused:true,version:control.version}});assert.equal(conflict.status,409);
  const claim=(await preparation.claimPreparations(pool,{batch_size:1}))[0];assert.equal(claim.id,job.id);
  const live=(await request(endpoint)).data.control;
  assert.equal((await request(endpoint+'/control',{method:'PUT',body:{paused:true,version:live.version}})).status,200);
  let invoked=false;const outcome=await preparation.processClaim(pool,claim,{probe:async()=>{invoked=true;return {ok:true};}});
  assert.equal(outcome,'released');assert.equal(invoked,false);
  const released=(await jobs())[0];assert.equal(released.status,'pending');assert.equal(released.lease_token,null);
  await resume();const next=(await preparation.claimPreparations(pool,{batch_size:1}))[0];
  const simulation=(await request('/api/admin/buyer-engagement/ledger')).data.control;
  assert.equal((await request('/api/admin/buyer-engagement/simulation-control',{method:'PUT',body:{paused:true,version:simulation.version}})).status,200);
  assert.equal(await preparation.processClaim(pool,next),'released');
  const simulationReleased=(await jobs())[0];assert.equal(simulationReleased.status,'pending');assert.equal(simulationReleased.reason,'simulation_paused');assert.equal(simulationReleased.attempt_count,0);
});

test('concurrent reservations claim disjoint jobs and reject unbounded batch requests',async()=>{
  for(let i=0;i<5;i++)await seedBuyer();await generate('welcome');await enqueue();await resume();
  const claims=await Promise.all([1,2,3].map(()=>preparation.claimPreparations(pool,{batch_size:2})));
  const all=claims.flat();assert.equal(all.length,5);assert.equal(new Set(all.map(claim=>claim.id)).size,5);
  assert.ok(all.every(claim=>claim.lease_token && claim.attempt_count===1));
  const before=await counts();for(const batch_size of [0,11,-1,1.5,'2']) {
    const invalid=await request(endpoint+'/process',{method:'POST',body:{batch_size}});assert.equal(invalid.status,400,JSON.stringify(invalid.data));
  }
  assert.deepEqual(await counts(),before);
});

test('expired leases can be reclaimed, while the old fencing token cannot complete the job',async()=>{
  const {job}=await prepareBuyer();await resume();
  const first=(await preparation.claimPreparations(pool,{batch_size:1}))[0];
  await pool.query(`UPDATE ${JOBS} SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,[job.id]);
  const second=(await preparation.claimPreparations(pool,{batch_size:1}))[0];assert.equal(second.id,first.id);assert.notEqual(second.lease_token,first.lease_token);assert.equal(second.attempt_count,2);
  const before=await counts();let invoked=false;
  assert.equal(await preparation.processClaim(pool,first,{probe:async()=>{invoked=true;return {ok:true};}}),'stale');assert.equal(invoked,false);assert.deepEqual(await counts(),before);
  assert.equal(await preparation.processClaim(pool,second),'simulated');assert.equal((await jobs())[0].status,'simulated');
  assert.equal((await preparation.claimPreparations(pool,{batch_size:1})).length,0);
});

test('three abandoned leases exhaust the retry budget instead of reserving forever',async()=>{
  const {job}=await prepareBuyer();await resume();
  for(let attempt=1;attempt<=3;attempt++) {
    const claim=(await preparation.claimPreparations(pool,{batch_size:1}))[0];assert.equal(claim.id,job.id);assert.equal(claim.attempt_count,attempt);
    await pool.query(`UPDATE ${JOBS} SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,[job.id]);
  }
  const terminal=await request(endpoint+'/process',{method:'POST',body:{batch_size:1}});
  assert.equal(terminal.status,200);assert.equal(terminal.data.claimed,0);assert.equal(terminal.data.failed,1,'summary must report expired exhausted leases terminalized by this batch');
  const exhausted=(await jobs())[0];assert.equal(exhausted.status,'failed');assert.equal(exhausted.attempt_count,3);
  const repeated=await request(endpoint+'/process',{method:'POST',body:{batch_size:1}});assert.equal(repeated.data.failed,0);
});

test('retryable preparation failures use bounded exponential backoff and stop after attempt three',async()=>{
  const {job}=await prepareBuyer();await resume();
  const probe=async()=>{throw Object.assign(new Error('Synthetic transient failure; must not be stored verbatim'),{retryable:true});};
  for(let attempt=1;attempt<=3;attempt++) {
    const claim=(await preparation.claimPreparations(pool,{batch_size:1}))[0];assert.equal(claim.attempt_count,attempt);
    assert.equal(await preparation.processClaim(pool,claim,{probe}),attempt<3?'retry_scheduled':'failed');
    const row=(await jobs())[0];assert.equal(row.status,attempt<3?'pending':'failed');assert.equal(row.lease_token,null);
    if(attempt<3) {
      const remaining=(await pool.query(`SELECT EXTRACT(EPOCH FROM(next_attempt_at-clock_timestamp()))::float AS seconds FROM ${JOBS} WHERE id=$1`,[job.id])).rows[0].seconds;
      const delay=attempt===1?60:120;assert.ok(remaining>=delay-10 && remaining<=delay+1,JSON.stringify({attempt,remaining}));
      assert.equal((await preparation.claimPreparations(pool,{batch_size:1})).length,0);
      await pool.query(`UPDATE ${JOBS} SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1`,[job.id]);
    }
  }
  assert.equal((await preparation.claimPreparations(pool,{batch_size:1})).length,0);
  assert.doesNotMatch(JSON.stringify((await pool.query(`SELECT * FROM ${EVENTS}`)).rows),/must not be stored verbatim/);
});

test('a permanent preparation failure cancels without retry or copied exception text',async()=>{
  await prepareBuyer();await resume();const claim=(await preparation.claimPreparations(pool,{batch_size:1}))[0];
  assert.equal(await preparation.processClaim(pool,claim,{probe:async()=>{throw new Error('Synthetic private exception detail');}}),'cancelled');
  assert.equal((await jobs())[0].status,'cancelled');assert.equal((await preparation.claimPreparations(pool,{batch_size:1})).length,0);
  assert.doesNotMatch(JSON.stringify((await pool.query(`SELECT * FROM ${EVENTS}`)).rows),/Synthetic private exception detail/);
});

test('processing rechecks consent, completed login and activation instead of trusting queued eligibility',async()=>{
  const withdrawn=await seedBuyer(),logged=await seedBuyer(),activated=await seedBuyer();await generate('welcome');await enqueue();await resume();
  const claims=await preparation.claimPreparations(pool,{batch_size:3});assert.equal(claims.length,3);
  const auth=await buyerCookie(withdrawn);assert.equal((await request('/api/portal/email-preferences',{cookie:auth,method:'PUT',body:{marketing_consent:false}})).status,200);
  await pool.query('UPDATE buyers SET first_login_at=NOW(),last_login_at=NOW(),last_meaningful_activity_at=NOW(),activation_pending=false WHERE id=$1',[logged]);
  await pool.query('UPDATE buyers SET activation_pending=false,activated_at=NOW() WHERE id=$1',[activated]);
  let invoked=0;for(const claim of claims)assert.equal(await preparation.processClaim(pool,claim,{probe:async()=>{invoked++;return {ok:true};}}),'cancelled');
  assert.equal(invoked,0);assert.ok((await jobs()).every(job=>job.status==='cancelled'));
});

test('an inactivity episode changed by one microsecond is cancelled even when it remains older than thirty days',async()=>{
  const buyer=await seedBuyer({kind:'inactive'});
  await pool.query("UPDATE buyers SET last_meaningful_activity_at='2025-01-01 12:00:00.123456+00' WHERE id=$1",[buyer]);
  await generate('inactive');await enqueue();await resume();const claim=(await preparation.claimPreparations(pool,{batch_size:1}))[0];
  await pool.query("UPDATE buyers SET last_meaningful_activity_at='2025-01-01 12:00:00.123457+00' WHERE id=$1",[buyer]);
  let invoked=false;assert.equal(await preparation.processClaim(pool,claim,{probe:async()=>{invoked=true;return {ok:true};}}),'cancelled');assert.equal(invoked,false);
  assert.equal((await jobs(buyer))[0].status,'cancelled');
});

test('rule or template revisions after enqueue invalidate the exact approved preparation snapshot',async()=>{
  const welcome=await seedBuyer(),inactive=await seedBuyer({kind:'inactive'});await generate('welcome','inactive');await enqueue();await resume();
  const claims=await preparation.claimPreparations(pool,{batch_size:2});assert.equal(claims.length,2);
  const rule=(await pool.query("SELECT * FROM buyer_engagement_rules WHERE id='welcome'")).rows[0];
  assert.equal((await request('/api/admin/buyer-engagement/rules/welcome',{method:'PUT',body:{mode:'simulation',delay_hours:rule.delay_hours,version:rule.version}})).status,200);
  const template=(await pool.query("SELECT * FROM buyer_engagement_templates WHERE rule_id='inactive' AND lang='fr' ORDER BY version DESC LIMIT 1")).rows[0];
  assert.equal((await request('/api/admin/buyer-engagement/templates/inactive/fr',{method:'PUT',body:{version:template.version,subject:'Revised synthetic draft',body:'Hello {{buyer_name}}'}})).status,200);
  let invoked=0;for(const claim of claims)assert.equal(await preparation.processClaim(pool,claim,{probe:async()=>{invoked++;return {ok:true};}}),'cancelled');
  assert.equal(invoked,0);assert.equal((await jobs(welcome))[0].status,'cancelled');assert.equal((await jobs(inactive))[0].status,'cancelled');
});

test('the default batch processor produces simulated outcomes and no repeated completion',async()=>{
  for(let i=0;i<3;i++)await seedBuyer();await generate('welcome');await enqueue();await resume();
  const first=await request(endpoint+'/process',{method:'POST',body:{batch_size:2}});assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.claimed,2);assert.equal(first.data.simulated,2);
  const second=await request(endpoint+'/process',{method:'POST',body:{batch_size:2}});assert.equal(second.status,200);assert.equal(second.data.claimed,1);assert.equal(second.data.simulated,1);
  const completed=await counts(),empty=await request(endpoint+'/process',{method:'POST',body:{batch_size:2}});assert.equal(empty.status,200);assert.equal(empty.data.claimed,0);assert.deepEqual(await counts(),completed);
  assert.ok((await jobs()).every(job=>job.status==='simulated'));
});

test('preparation traces export only the connected buyer and cascade on deletion',async()=>{
  const buyer=await seedBuyer(),other=await seedBuyer();await generate('welcome');await enqueue();
  const own=(await jobs(buyer))[0],foreign=(await jobs(other))[0],auth=await buyerCookie(buyer);
  for(const route of ['/api/portal/gdpr/export','/api/portal/my-data-export']) {
    const exported=await request(route,{cookie:auth});assert.equal(exported.status,200);
    const queue=exported.data.engagement.preparation_queue;assert.ok(queue);assert.deepEqual(queue.jobs.map(job=>job.id),[own.id]);assert.ok(queue.events.length>=1);
    assert.ok(queue.events.every(event=>event.job_id===own.id));assert.doesNotMatch(JSON.stringify(queue),new RegExp(foreign.id));
  }
  const deleted=await request('/api/portal/delete-account',{cookie:auth,method:'POST',body:{password}});assert.equal(deleted.status,200);assert.equal(deleted.data.ok,true);
  assert.equal((await jobs(buyer)).length,0);assert.equal((await pool.query(`SELECT * FROM ${EVENTS} WHERE job_id=$1`,[own.id])).rowCount,0);assert.equal((await jobs(other)).length,1);
  assert.equal((await counts()).operations,1,'aggregate enqueue operation does not retain a buyer contact');
});

test('fixed-age job retention cascades events while aggregate enqueue results expire separately',async()=>{
  const expired=await seedBuyer(),fresh=await seedBuyer();await generate('welcome');await enqueue();
  const old=(await jobs(expired))[0],current=(await jobs(fresh))[0];
  await pool.query(`UPDATE ${JOBS} SET created_at=NOW()-INTERVAL '91 days',updated_at=NOW() WHERE id=$1`,[old.id]);
  await preparation.prunePreparationQueue(pool);assert.equal((await jobs(expired)).length,0);assert.equal((await jobs(fresh))[0].id,current.id);
  assert.equal((await pool.query(`SELECT * FROM ${EVENTS} WHERE job_id=$1`,[old.id])).rowCount,0);assert.equal((await counts()).operations,1);
  await pool.query(`UPDATE ${OPERATIONS} SET created_at=NOW()-INTERVAL '366 days'`);await preparation.prunePreparationQueue(pool);assert.equal((await counts()).operations,0);assert.equal((await jobs(fresh)).length,1);
});

test('a failure after queue insertion rolls back jobs, events and the idempotency result together',async()=>{
  await seedBuyer();await generate('welcome');const before=await counts(),requestKey=key();let injected=false;
  const proxy=poolProxy(async(db,sql,args)=>{
    const result=await db.query(sql,args);
    if(sql.includes('INSERT INTO buyer_engagement_preparation_jobs')){injected=true;throw new Error('Synthetic enqueue rollback');}
    return result;
  });
  await assert.rejects(preparation.enqueuePreparations(proxy,{request_key:requestKey}),/Synthetic enqueue rollback/);assert.equal(injected,true);assert.deepEqual(await counts(),before);
  const retry=await enqueue(requestKey);assert.equal(retry.status,200);assert.equal(retry.data.replayed,false);assert.equal(retry.data.created_count,1);
});

test('buyers, agents and designers cannot read or mutate the transversal preparation queue',async()=>{
  const identities=[null],buyer=await seedBuyer();identities.push(await buyerCookie(buyer));
  for(const role of ['agent','designer']) {
    const staff=id('prep_'+role);await pool.query('INSERT INTO admin_users(id,email,password_hash,role,mfa_enabled) VALUES($1,$2,$3,$4,true)',[staff,staff+'@test.invalid','not-a-password',role]);
    identities.push(await sessionCookie({staffUser:{id:staff,email:staff+'@test.invalid',role,mfaEnrolled:true}}));
  }
  const control=(await request(endpoint)).data.control;
  for(const auth of identities) {
    assert.equal((await request(endpoint,{cookie:auth})).status,403);
    assert.equal((await request(endpoint+'/enqueue',{cookie:auth,method:'POST',body:{request_key:key()}})).status,403);
    assert.equal((await request(endpoint+'/process',{cookie:auth,method:'POST',body:{batch_size:1}})).status,403);
    assert.equal((await request(endpoint+'/control',{cookie:auth,method:'PUT',body:{paused:false,version:control.version}})).status,403);
  }
  assert.equal((await counts()).jobs,0);assert.equal((await counts()).operations,0);
});

test('the built-in draft check refuses unsupported variables without rendering an email or issuing a token',async()=>{
  await pool.query("UPDATE buyer_engagement_templates SET body='Hello {{unknown_private_variable}}' WHERE rule_id='welcome'");
  await prepareBuyer();await resume();const before=await counts();
  const result=await preparation.processPreparations(pool,{batch_size:1});assert.equal(result.claimed,1);assert.equal(result.cancelled,1);assert.equal(result.simulated,0);
  assert.equal((await jobs())[0].reason,'template_invalid');assert.equal((await counts()).activation_tokens,before.activation_tokens);
});

test('enqueue refuses more than one thousand candidates without a partial preparation',async()=>{
  await pool.query("INSERT INTO buyers(id,email,password_hash,login_history_known,activation_pending,approved_at) SELECT 'prep_cap_'||i,'prep_cap_'||i||'@test.invalid','not-a-password',true,true,NOW()-INTERVAL '80 days' FROM generate_series(1,1001) AS i");
  await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) SELECT id,'granted','synthetic_test','synthetic_v1' FROM buyers");
  await generate('welcome');const before=await counts(),result=await enqueue();assert.equal(result.status,422);assert.deepEqual(await counts(),before);
});

test('preparation migration reruns preserve jobs and a failed DDL transaction leaves no partial tables',async()=>{
  const {migrateBuyerEngagementPreparation}=require('../lib/buyer-engagement-preparation-migration');
  await prepareBuyer();const before=await counts();await migrateBuyerEngagementPreparation(pool);await migrateBuyerEngagementPreparation(pool);assert.deepEqual(await counts(),before);
  const db=await pool.connect(),schema='prep_rollback_'+crypto.randomBytes(5).toString('hex');
  try {
    await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`);
    await db.query('CREATE TABLE buyers(id TEXT PRIMARY KEY);CREATE TABLE buyer_engagement_rules(id TEXT PRIMARY KEY);CREATE TABLE buyer_engagement_templates(rule_id TEXT,lang TEXT,version INTEGER,PRIMARY KEY(rule_id,lang,version));CREATE TABLE buyer_engagement_simulation_candidates(id UUID PRIMARY KEY)');
    const proxy={connect:async()=>({query:async(sql,args)=>{const result=await db.query(sql,args);if(sql.includes('CREATE TABLE IF NOT EXISTS buyer_engagement_preparation_control'))throw new Error('Synthetic preparation migration failure');return result;},release(){}})};
    await assert.rejects(migrateBuyerEngagementPreparation(proxy),/Synthetic preparation migration failure/);
    assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'buyer_engagement_preparation_%'",[schema])).rowCount,0);
  }finally{await db.query('SET search_path TO public');await db.query(`DROP SCHEMA ${schema} CASCADE`);db.release();}
});

test('processing derives identity from the stored job instead of trusting mutable claim fields',async()=>{
  const actual=await seedBuyer(),other=await seedBuyer();await generate('welcome');await enqueue();await resume();
  const claims=await preparation.claimPreparations(pool,{batch_size:2}),claim=claims.find(row=>row.buyer_id===actual);
  assert.ok(claim);await pool.query("UPDATE buyer_email_preferences SET status='denied' WHERE buyer_id=$1",[actual]);
  let invoked=false;
  const outcome=await preparation.processClaim(pool,{...claim,buyer_id:other,rule_id:'inactive',anchor_key:'2020-01-01T00:00:00Z'},{probe:async()=>{invoked=true;return {ok:true};}});
  assert.equal(outcome,'cancelled');assert.equal(invoked,false);assert.equal((await jobs(actual))[0].reason,'marketing_permission_missing');assert.equal((await jobs(other))[0].status,'reserved');
});

test('queue reads run inside a repeatable read, read-only database transaction',async()=>{
  await prepareBuyer();let checked=0;
  const proxy=poolProxy(async(db,sql,args)=>{
    if(sql.trimStart().startsWith('SELECT')) {
      assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
      assert.equal((await db.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');checked++;
    }
    return db.query(sql,args);
  });
  const result=await preparation.getPreparationQueue(proxy,{});assert.equal(result.jobs.total,1);assert.ok(checked>=3);
});
