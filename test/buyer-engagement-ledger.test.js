'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const bcrypt=require('bcryptjs');
const {authenticator}=require('otplib');
const {Pool}=require('pg');
const {startServer,id}=require('./helpers');
const {runSimulation,pruneLedger}=require('../lib/buyer-engagement-ledger');
const {migrateBuyerEngagementLedger}=require('../lib/buyer-engagement-ledger-migration');
let server,pool,owner,passwordHash;
const password='LedgerSyntheticPassword123!';
const endpoint='/api/admin/buyer-engagement';
const key=()=>crypto.randomUUID();
async function request(path,{cookie=owner,method='GET',body}={}) {
  const response=await fetch(server.baseUrl+path,{method,redirect:'manual',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();
  return {status:response.status,data,response};
}
async function run(kind='generate',request_key=key()) {
  return request(endpoint+'/simulation-runs',{method:'POST',body:{kind,request_key}});
}
async function seedBuyer({kind='welcome',known=true,consent='granted',lang='fr'}={}) {
  const buyer=id('ledger_buyer');
  await pool.query(`INSERT INTO buyers(id,email,password_hash,name,company,lang,login_history_known,activation_pending,approved_at,last_login_at,last_meaningful_activity_at)
    VALUES($1,$2,$3,'Synthetic private name','Synthetic private company',$4,$5,$6,NOW()-INTERVAL '80 days',
      CASE WHEN $6 THEN NULL ELSE NOW()-INTERVAL '40 days' END,
      CASE WHEN $6 THEN NULL ELSE NOW()-INTERVAL '40 days' END)`,[buyer,buyer+'@test.invalid',passwordHash,lang,known,kind==='welcome']);
  if(consent!==null)await pool.query("INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,$2,'synthetic_test','synthetic_v1')",[buyer,consent]);
  return buyer;
}
async function enable(...rules) {
  await pool.query("UPDATE buyer_engagement_rules SET mode='simulation' WHERE id=ANY($1::text[])",[rules]);
}
async function candidates(buyer) {
  return (await pool.query('SELECT *,anchor_at::text AS exact_anchor FROM buyer_engagement_simulation_candidates WHERE buyer_id=$1 ORDER BY anchor_at,id',[buyer])).rows;
}
async function snapshotCounts() {
  return (await pool.query(`SELECT (SELECT COUNT(*)::int FROM buyer_engagement_simulation_runs) AS runs,
    (SELECT COUNT(*)::int FROM buyer_engagement_simulation_candidates) AS candidates,
    (SELECT COUNT(*)::int FROM buyer_engagement_simulation_checks) AS checks,
    (SELECT COUNT(*)::int FROM pending_reminders) AS legacy_reminders,
    (SELECT COUNT(*)::int FROM buyer_password_resets) AS activation_tokens,
    (SELECT COUNT(*)::int FROM buyer_email_preference_events) AS preference_events`)).rows[0];
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
  return {connect:async()=>{
    const db=await pool.connect();
    return {query:(sql,args)=>query(db,sql,args),release:()=>db.release()};
  }};
}
before(async()=>{
  server=await startServer({dbNameSuffix:'ledger_'+crypto.randomBytes(6).toString('hex'),port:3220});
  pool=new Pool({connectionString:server.dbUrl});passwordHash=await bcrypt.hash(password,10);
  const secret=authenticator.generateSecret();
  await pool.query("INSERT INTO settings(key,value) VALUES('owner_mfa_enabled','on'),('owner_mfa_secret',$1),('owner_mfa_last_step','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[secret]);
  const initial=await request('/admin/login',{cookie:null,method:'POST',body:{password:'TestAdmin123!'}});
  const initialCookie=initial.response.headers.get('set-cookie').split(';')[0];
  const completed=await request('/admin/login/mfa',{cookie:initialCookie,method:'POST',body:{code:authenticator.generate(secret)}});
  assert.equal(completed.response.headers.get('location'),'/admin');
  owner=completed.response.headers.get('set-cookie')?.split(';')[0]||initialCookie;
});
beforeEach(async()=>{
  // These are fresh databases owned by this test file; no shared/production data.
  await pool.query('TRUNCATE buyer_engagement_simulation_runs CASCADE');
  await pool.query('DELETE FROM buyers');
  await pool.query("UPDATE buyer_engagement_rules SET mode='disabled',delay_hours=CASE id WHEN 'welcome' THEN 24 WHEN 'inactive' THEN 720 WHEN 'cart' THEN 48 ELSE 168 END,version=version+1");
  await pool.query('UPDATE buyer_engagement_simulation_control SET paused=false,version=version+1 WHERE id=true');
});
after(async()=>{server?.stop();await pool?.end();});

test('generation persists only eligible supported episodes and checks, without contact copies or legacy tasks',async()=>{
  await enable('welcome','inactive','cart','brand_interest');
  const welcome=await seedBuyer(),inactive=await seedBuyer({kind:'inactive',lang:'en'}),unknown=await seedBuyer({known:false});
  const before=await snapshotCounts(),generated=await run();
  assert.equal(generated.status,200,JSON.stringify(generated.data));assert.equal(generated.data.replayed,false);
  const journal=generated.data.run;assert.equal(journal.mode,'simulation');assert.equal(journal.scanned_count,3);assert.equal(journal.evaluated_count,12);assert.equal(journal.created_count,2);assert.equal(journal.eligible_count,2);
  assert.equal((await candidates(welcome))[0].reason,'activation_pending');assert.equal((await candidates(inactive))[0].reason,'no_recorded_action_since_threshold');assert.equal((await candidates(unknown)).length,0);
  const counts=await snapshotCounts();assert.equal(counts.runs,1);assert.equal(counts.candidates,2);assert.equal(counts.checks,2);
  for(const name of ['legacy_reminders','activation_tokens','preference_events'])assert.equal(counts[name],before[name]);
  const raw=(await pool.query('SELECT * FROM buyer_engagement_simulation_candidates')).rows;
  assert.doesNotMatch(JSON.stringify(raw),/@test\.invalid|Synthetic private|https?:|portal_url/);
  const page=await request(endpoint+'/ledger');assert.equal(page.response.headers.get('cache-control'),'no-store');assert.equal(page.data.sending_enabled,false);assert.equal(page.data.candidates.total,2);assert.equal(page.data.runs.total,1);
  await assert.rejects(pool.query("UPDATE buyer_engagement_simulation_runs SET mode='live' WHERE id=$1",[journal.id]),{code:'23514'});
});

test('request keys replay one durable result and reject kind changes or free text keys',async()=>{
  await enable('welcome');await seedBuyer();const requestKey=key();
  const first=await run('generate',requestKey),replay=await run('generate',requestKey);
  assert.equal(first.status,200);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.deepEqual(replay.data.run,first.data.run);
  assert.equal((await snapshotCounts()).checks,1);
  const conflict=await run('recheck',requestKey);assert.equal(conflict.status,409);assert.equal(conflict.data.code,'request_key_reused');
  assert.equal((await run('generate','private@email.invalid')).status,400);
  assert.equal((await run('send',key())).status,400);
  assert.equal((await snapshotCounts()).runs,1);
});

test('concurrent generation cannot create duplicate runs or episode rows; busy requests are safely retryable',async()=>{
  await enable('welcome');const buyer=await seedBuyer(),requestKey=key();
  const calls=await Promise.all([run('generate',requestKey),run('generate',requestKey)]);
  assert.ok(calls.some(result=>result.status===200));
  for(const result of calls)assert.ok([200,409].includes(result.status),JSON.stringify(result.data));
  const retry=await run('generate',requestKey);assert.equal(retry.status,200);assert.equal(retry.data.replayed,true);
  assert.equal((await candidates(buyer)).length,1);const counts=await snapshotCounts();assert.equal(counts.runs,1);assert.equal(counts.checks,1);
});

test('new runs and rule/template revisions reuse the same episode and append versioned checks',async()=>{
  await enable('welcome');const buyer=await seedBuyer();const first=await run();assert.equal(first.status,200);
  const initial=(await candidates(buyer))[0];
  const rule=(await pool.query("SELECT * FROM buyer_engagement_rules WHERE id='welcome'")).rows[0];
  const editedRule=await request(endpoint+'/rules/welcome',{method:'PUT',body:{mode:'simulation',delay_hours:12,version:rule.version}});assert.equal(editedRule.status,200);
  const template=(await pool.query("SELECT * FROM buyer_engagement_templates WHERE rule_id='welcome' AND lang='fr' ORDER BY version DESC LIMIT 1")).rows[0];
  assert.equal((await request(endpoint+'/templates/welcome/fr',{method:'PUT',body:{version:template.version,subject:'Synthetic revised draft',body:'Hello {{buyer_name}}'}})).status,200);
  const second=await run();assert.equal(second.status,200);assert.equal(second.data.run.created_count,0);assert.equal(second.data.run.reused_count,1);
  const updated=(await candidates(buyer))[0];assert.equal(updated.id,initial.id);assert.equal(updated.first_run_id,initial.first_run_id);assert.equal(updated.rule_version,rule.version+1);assert.equal(updated.template_version,template.version+1);
  const checks=(await pool.query('SELECT * FROM buyer_engagement_simulation_checks WHERE candidate_id=$1 ORDER BY checked_at',[initial.id])).rows;
  assert.equal(checks.length,2);assert.equal(checks[0].template_version,initial.template_version);assert.equal(checks[1].template_version,template.version+1);
});

test('recheck excludes withdrawn consent and completed login, then records explicit regrant without a duplicate episode',async()=>{
  await enable('welcome');const consentBuyer=await seedBuyer(),loginBuyer=await seedBuyer();assert.equal((await run()).status,200);
  const auth=await buyerCookie(consentBuyer);
  assert.equal((await request('/api/portal/email-preferences',{cookie:auth,method:'PUT',body:{marketing_consent:false}})).status,200);
  await pool.query('UPDATE buyers SET first_login_at=NOW(),last_login_at=NOW(),last_meaningful_activity_at=NOW(),activation_pending=false WHERE id=$1',[loginBuyer]);
  assert.equal((await run('recheck')).status,200);
  assert.equal((await candidates(consentBuyer))[0].reason,'marketing_permission_missing');assert.equal((await candidates(loginBuyer))[0].reason,'already_logged_in');
  assert.equal((await request('/api/portal/email-preferences',{cookie:auth,method:'PUT',body:{marketing_consent:true}})).status,200);
  const regranted=await run('recheck');assert.equal(regranted.status,200);assert.equal((await candidates(consentBuyer))[0].status,'eligible');
  assert.equal((await candidates(consentBuyer)).length,1);assert.equal((await candidates(loginBuyer))[0].status,'excluded');
});

test('microsecond changes create a new inactivity episode and permanently exclude the earlier anchor',async()=>{
  await enable('inactive');const buyer=await seedBuyer({kind:'inactive'});
  await pool.query("UPDATE buyers SET last_meaningful_activity_at='2025-01-01 12:00:00.123456+00' WHERE id=$1",[buyer]);
  assert.equal((await run()).status,200);const first=(await candidates(buyer))[0];
  await pool.query("UPDATE buyers SET last_meaningful_activity_at='2025-01-01 12:00:00.123457+00' WHERE id=$1",[buyer]);
  const checked=await run('recheck');assert.equal(checked.status,200);assert.equal((await candidates(buyer))[0].reason,'episode_changed');assert.equal((await candidates(buyer)).length,1,'recheck never adds an episode');
  const generated=await run();assert.equal(generated.status,200);assert.equal(generated.data.run.created_count,1);
  const rows=await candidates(buyer);assert.equal(rows.length,2);assert.equal(rows[0].id,first.id);assert.equal(rows[0].status,'excluded');assert.equal(rows[0].reason,'episode_changed');assert.equal(rows[1].status,'eligible');assert.notEqual(rows[0].exact_anchor,rows[1].exact_anchor);
  assert.equal((await run()).data.run.created_count,0);
});

test('new activity, recent presence and a disabled rule invalidate prior candidates',async()=>{
  await enable('inactive','welcome');
  const active=await seedBuyer({kind:'inactive'}),present=await seedBuyer({kind:'inactive'}),welcome=await seedBuyer();
  assert.equal((await run()).status,200);
  await pool.query('UPDATE buyers SET last_meaningful_activity_at=NOW() WHERE id=$1',[active]);await pool.query('UPDATE buyers SET last_seen_at=NOW() WHERE id=$1',[present]);
  await pool.query("UPDATE buyer_engagement_rules SET mode='disabled',version=version+1 WHERE id='welcome'");
  assert.equal((await run('recheck')).status,200);
  assert.equal((await candidates(active))[0].reason,'recent_activity');assert.equal((await candidates(present))[0].reason,'recent_presence');assert.equal((await candidates(welcome))[0].reason,'rule_disabled');
});

test('pause is optimistic, blocks generation and permits a recheck that excludes all candidates',async()=>{
  await enable('welcome');const buyer=await seedBuyer();assert.equal((await run()).status,200);
  const initial=(await request(endpoint+'/ledger')).data.control;
  const paused=await request(endpoint+'/simulation-control',{method:'PUT',body:{paused:true,version:initial.version}});assert.equal(paused.status,200);
  const before=await snapshotCounts();const blocked=await run();assert.equal(blocked.status,409);assert.equal(blocked.data.code,'simulation_paused');assert.deepEqual(await snapshotCounts(),before);
  const visible=await request(endpoint+'/ledger');assert.equal(visible.data.candidates.rows[0].reason,'simulation_paused');
  const stale=await request(endpoint+'/simulation-control',{method:'PUT',body:{paused:false,version:initial.version}});assert.equal(stale.status,409);assert.equal(stale.data.code,'control_conflict');
  assert.equal((await run('recheck')).status,200);assert.equal((await candidates(buyer))[0].reason,'simulation_paused');
  assert.equal((await request(endpoint+'/simulation-control',{method:'PUT',body:{paused:false,version:paused.data.version}})).status,200);
  assert.equal((await run()).status,200);assert.equal((await candidates(buyer))[0].status,'eligible');
  assert.equal((await request(endpoint+'/simulation-control',{method:'PUT',body:{paused:'false',version:paused.data.version}})).status,400);
});

test('the engine lock fails quickly, preserves data and allows the same request key on retry',async()=>{
  await enable('welcome');await seedBuyer();const blocker=await pool.connect(),requestKey=key(),before=await snapshotCounts();
  try {
    await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1'))");
    const busy=await run('generate',requestKey);assert.equal(busy.status,409);assert.equal(busy.data.code,'simulation_busy');assert.deepEqual(await snapshotCounts(),before);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  assert.equal((await run('generate',requestKey)).status,200);
});

test('failure after candidate writes rolls back run, episode, checks and pruning atomically',async()=>{
  await enable('welcome');await seedBuyer();const before=await snapshotCounts(),requestKey=key();let injected=false;
  const proxy=poolProxy(async(db,sql,args)=>{
    if(sql.startsWith('INSERT INTO buyer_engagement_simulation_checks')){injected=true;throw new Error('synthetic check write failure');}
    return db.query(sql,args);
  });
  await assert.rejects(runSimulation(proxy,{request_key:requestKey,kind:'generate'}),/synthetic check write failure/);assert.equal(injected,true);assert.deepEqual(await snapshotCounts(),before);
  const retried=await run('generate',requestKey);assert.equal(retried.status,200);assert.equal(retried.data.replayed,false);assert.equal(retried.data.run.created_count,1);
});

test('cohorts above 10000 fail explicitly without partial runs, candidates or checks',async()=>{
  await enable('welcome');
  await pool.query("INSERT INTO buyers(id,email,password_hash) SELECT 'ledger_cap_'||i,'ledger_cap_'||i||'@test.invalid','not-a-password' FROM generate_series(1,10001) AS i");
  const before=await snapshotCounts(),result=await run();assert.equal(result.status,422);assert.equal(result.data.code,'simulation_cohort_limit');assert.deepEqual(await snapshotCounts(),before);
});

test('simulation records are exported per buyer and erased with the account while aggregate runs remain',async()=>{
  await enable('welcome');const buyer=await seedBuyer(),other=await seedBuyer();assert.equal((await run()).status,200);
  const auth=await buyerCookie(buyer),ownCandidate=(await candidates(buyer))[0],otherCandidate=(await candidates(other))[0];
  for(const route of ['/api/portal/gdpr/export','/api/portal/my-data-export']) {
    const result=await request(route,{cookie:auth});assert.equal(result.status,200);const exported=result.data.engagement.simulation_ledger;
    assert.deepEqual(exported.candidates.map(row=>row.id),[ownCandidate.id]);assert.equal(exported.checks.length,1);assert.equal(exported.checks[0].candidate_id,ownCandidate.id);assert.doesNotMatch(JSON.stringify(exported),new RegExp(otherCandidate.id));
  }
  const result=await request('/api/portal/delete-account',{cookie:auth,method:'POST',body:{password}});assert.equal(result.status,200);assert.equal(result.data.ok,true);
  assert.equal((await candidates(buyer)).length,0);assert.equal((await pool.query('SELECT * FROM buyer_engagement_simulation_checks WHERE candidate_id=$1',[ownCandidate.id])).rowCount,0);
  assert.equal((await candidates(other)).length,1);const runs=(await pool.query('SELECT * FROM buyer_engagement_simulation_runs')).rows;assert.equal(runs.length,1);assert.equal(runs[0].created_count,2);
});

test('retention uses fixed candidate age, cascades checks and ages aggregate runs separately',async()=>{
  await enable('welcome');const expired=await seedBuyer(),fresh=await seedBuyer();const generated=await run();assert.equal(generated.status,200);
  const oldCandidate=(await candidates(expired))[0],freshCandidate=(await candidates(fresh))[0];
  await pool.query("UPDATE buyer_engagement_simulation_candidates SET created_at=NOW()-INTERVAL '91 days',last_checked_at=NOW() WHERE id=$1",[oldCandidate.id]);
  await pruneLedger(pool);assert.equal((await candidates(expired)).length,0);assert.equal((await candidates(fresh)).length,1);assert.equal((await snapshotCounts()).checks,1);assert.equal((await snapshotCounts()).runs,1);
  await pool.query("UPDATE buyer_engagement_simulation_runs SET completed_at=NOW()-INTERVAL '366 days' WHERE id=$1",[generated.data.run.id]);
  await pruneLedger(pool);assert.equal((await snapshotCounts()).runs,0);assert.equal((await snapshotCounts()).checks,0);
  const surviving=(await candidates(fresh))[0];assert.equal(surviving.id,freshCandidate.id);assert.equal(surviving.first_run_id,null);assert.equal(surviving.last_run_id,null);
});

test('migration is repeatable and a failing migration rolls back newly created ledger tables',async()=>{
  await enable('welcome');const buyer=await seedBuyer();assert.equal((await run()).status,200);const before=await snapshotCounts();
  await migrateBuyerEngagementLedger(pool);await migrateBuyerEngagementLedger(pool);assert.deepEqual(await snapshotCounts(),before);assert.equal((await candidates(buyer)).length,1);
  const db=await pool.connect(),schema='ledger_rollback_'+crypto.randomBytes(5).toString('hex');
  try {
    await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`);
    await db.query('CREATE TABLE buyers(id TEXT PRIMARY KEY); CREATE TABLE buyer_engagement_rules(id TEXT PRIMARY KEY)');
    await db.query('CREATE TABLE buyer_engagement_templates(rule_id TEXT,lang TEXT,version INTEGER,PRIMARY KEY(rule_id,lang,version))');
    const proxy={connect:async()=>({query:async(sql,args)=>{
      const result=await db.query(sql,args);if(sql.includes('CREATE TABLE IF NOT EXISTS buyer_engagement_simulation_control'))throw new Error('synthetic migration failure');return result;
    },release(){}})};
    await assert.rejects(migrateBuyerEngagementLedger(proxy),/synthetic migration failure/);
    assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'buyer_engagement_simulation_%'",[schema])).rowCount,0);
  }finally{await db.query('SET search_path TO public');await db.query(`DROP SCHEMA ${schema} CASCADE`);db.release();}
});

test('non-owner sessions cannot access ledger, generate, recheck or pause simulations',async()=>{
  const identities=[null];const buyer=await seedBuyer();identities.push(await buyerCookie(buyer));
  for(const role of ['agent','designer']){
    const staff=id('ledger_'+role);await pool.query('INSERT INTO admin_users(id,email,password_hash,role,mfa_enabled) VALUES($1,$2,$3,$4,true)',[staff,staff+'@test.invalid','not-a-password',role]);
    identities.push(await sessionCookie({staffUser:{id:staff,email:staff+'@test.invalid',role,mfaEnrolled:true}}));
  }
  const control=(await request(endpoint+'/ledger')).data.control;
  for(const auth of identities){
    assert.equal((await request(endpoint+'/ledger',{cookie:auth})).status,403);
    for(const kind of ['generate','recheck'])assert.equal((await request(endpoint+'/simulation-runs',{cookie:auth,method:'POST',body:{kind,request_key:key()}})).status,403);
    assert.equal((await request(endpoint+'/simulation-control',{cookie:auth,method:'PUT',body:{paused:true,version:control.version}})).status,403);
  }
  assert.equal((await snapshotCounts()).runs,0);
});

test('a real preference withdrawal waits for the locked snapshot and the next recheck excludes it',async()=>{
  await enable('welcome');const buyer=await seedBuyer(),auth=await buyerCookie(buyer);
  let buyersLocked,releaseEngine;
  const locked=new Promise(resolve=>{buyersLocked=resolve;});
  const gate=new Promise(resolve=>{releaseEngine=resolve;});
  const proxy=poolProxy(async(db,sql,args)=>{
    const result=await db.query(sql,args);
    if(sql.includes('FROM buyers ORDER BY id LIMIT')){buyersLocked();await gate;}
    return result;
  });
  const calculation=runSimulation(proxy,{kind:'generate',request_key:key()});
  let withdrawal;
  try {
    await Promise.race([locked,calculation.then(()=>{throw new Error('The calculation skipped its buyer lock');})]);
    withdrawal=request('/api/portal/email-preferences',{cookie:auth,method:'PUT',body:{marketing_consent:false}});
    // Observe the real PostgreSQL wait rather than asserting a timing guess.
    const deadline=Date.now()+3000;let waiting=false;
    while(Date.now()<deadline){
      waiting=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE 'SELECT id FROM buyers WHERE id=%FOR UPDATE%') AS waiting`)).rows[0].waiting;
      if(waiting)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'preference API must lock the buyer before writing the preference');
    releaseEngine();
    const generated=await calculation;assert.equal(generated.run.created_count,1);
    assert.equal((await withdrawal).status,200);
    assert.equal((await candidates(buyer))[0].status,'eligible','completed run records its protected snapshot');
    assert.equal((await pool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[buyer])).rows[0].status,'denied');
    const checked=await run('recheck');assert.equal(checked.status,200);assert.equal((await candidates(buyer))[0].reason,'marketing_permission_missing');
  }finally{
    releaseEngine();await calculation.catch(()=>{});await withdrawal?.catch(()=>{});
  }
});
