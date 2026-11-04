'use strict';
const {test,before,beforeEach,after}=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg'),{randomUUID,createHash}=require('node:crypto'),{startServer,id}=require('./helpers');
const fixture=require('./email-links-fixture'),links=require('../lib/buyer-engagement-email-links'),outbox=require('../lib/buyer-engagement-outbox');
let server,pool,f;
const hash=v=>createHash('sha256').update(v).digest('hex');
const row=async()=> (await pool.query('SELECT * FROM buyer_engagement_outbox WHERE id=$1',[f.intent])).rows[0];
const preference=async()=> (await pool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[f.buyer])).rows[0].status;
async function post(path,body,headers={}){const response=await fetch(server.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});return {status:response.status,body:await response.json(),headers:response.headers};}
const unsubscribe=()=>post('/api/public/buyer-engagement/unsubscribe',{token:f.unsubscribeToken});
const activate=token=>post('/api/portal/reset-password',{token,password:'Synthetic password 123!'});
before(async()=>{server=await startServer({dbNameSuffix:'email_links_'+Date.now(),port:3270});pool=new Pool({connectionString:server.dbUrl});});
beforeEach(async()=>{f=await fixture(pool,{origin:server.baseUrl});});
after(async()=>{server?.stop();await pool?.end();});
test('first sealed envelope contains usable links and list headers, with only hashes in link tables',async()=>{
  assert.equal(f.unsubscribe.origin,server.baseUrl);assert.match(f.unsubscribeToken,/^[a-f0-9]{64}$/);assert.equal(f.envelope.payload.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
  const u=(await pool.query('SELECT * FROM buyer_engagement_unsubscribe_links')).rows[0],a=(await pool.query('SELECT * FROM buyer_engagement_activation_links')).rows[0];
  assert.equal(u.token_hash,hash(f.unsubscribeToken));assert.equal(a.token_hash,hash(f.activationToken));
  assert.equal(+a.expires_at-+a.created_at,3600000);
  const stored=JSON.stringify((await pool.query('SELECT * FROM buyer_engagement_outbox')).rows)+JSON.stringify([u,a]);
  assert.equal(stored.includes(f.unsubscribeToken),false);assert.equal(stored.includes(f.activationToken),false);
  const exported=await links.exportEmailLinks(pool,f.buyer);assert.equal(exported.unsubscribe_links.length,1);assert.equal(exported.activation_links.length,1);assert.equal(JSON.stringify(exported).includes('hash'),false);
  assert.equal((await outbox.listOutbox(pool)).sending_enabled,false);
});
test('GET and HEAD never withdraw consent or activate, return private pages without a session cookie',async()=>{
  for(const path of [f.unsubscribe.pathname,'/buyer-engagement/unsubscribe','/buyer-engagement/activate'])for(const method of ['GET','HEAD']){
    const r=await fetch(server.baseUrl+path,{method});assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);assert.equal(r.headers.get('set-cookie'),null);
  }
  assert.equal(await preference(),'granted');assert.equal((await pool.query('SELECT activation_pending FROM buyers WHERE id=$1',[f.buyer])).rows[0].activation_pending,true);
});
test('anonymous JSON withdrawal is idempotent and changes marketing preference only',async()=>{
  const before=(await pool.query('SELECT approved_at,first_login_at,last_login_at,last_meaningful_activity_at,last_seen_at,activation_pending FROM buyers WHERE id=$1',[f.buyer])).rows[0];
  assert.equal((await unsubscribe()).body.ok,true);assert.equal((await unsubscribe()).body.ok,true);assert.equal(await preference(),'denied');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM buyer_email_preference_events WHERE buyer_id=$1 AND source='email_link'",[f.buyer])).rows[0].n,1);
  assert.deepEqual((await pool.query('SELECT approved_at,first_login_at,last_login_at,last_meaningful_activity_at,last_seen_at,activation_pending FROM buyers WHERE id=$1',[f.buyer])).rows[0],before);
  assert.equal((await row()).status,'uncertain');assert.equal((await row()).needs_attention,true);
  assert.equal((await activate(f.activationToken)).body.ok,true,'functional activation remains available after marketing opt-out');
});
test('one-click supports URL-encoded and multipart POST without cookies',async()=>{
  const path=f.unsubscribe.pathname;
  assert.equal((await post(path,'List-Unsubscribe=One-Click',{'Content-Type':'application/x-www-form-urlencoded'})).body.ok,true);
  const form=new FormData();form.append('List-Unsubscribe','One-Click');
  const r=await fetch(server.baseUrl+path,{method:'POST',body:form});assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
  assert.equal(await preference(),'denied');
});
test('invalid bearer, wrong one-click payload and oversized bodies fail without changing consent',async()=>{
  for(const body of [{token:'x'},{token:'f'.repeat(64)},{token:f.unsubscribeToken,buyer_id:f.buyer}])assert.equal((await post('/api/public/buyer-engagement/unsubscribe',body)).status,400);
  assert.equal((await post(f.unsubscribe.pathname,{})).status,400);
  assert.equal((await post(f.unsubscribe.pathname,'List-Unsubscribe=One-Click&extra=x',{'Content-Type':'application/x-www-form-urlencoded'})).status,400);
  assert.equal((await post('/api/public/buyer-engagement/unsubscribe',{token:f.unsubscribeToken,extra:'x'.repeat(3000)})).status,413);
  assert.equal(await preference(),'granted');
});
test('expired links, changed email addresses and deleted buyers cannot withdraw another identity',async()=>{
  await pool.query("UPDATE buyer_engagement_unsubscribe_links SET expires_at=NOW()-INTERVAL '1 second'");assert.equal((await unsubscribe()).status,400);
  await pool.query("UPDATE buyer_engagement_unsubscribe_links SET expires_at=NOW()+INTERVAL '1 day'");
  await pool.query("UPDATE buyers SET email='changed@example.test' WHERE id=$1",[f.buyer]);assert.equal((await unsubscribe()).status,400);assert.equal(await preference(),'granted');
  await pool.query('DELETE FROM buyers WHERE id=$1',[f.buyer]);assert.equal((await unsubscribe()).status,400);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_activation_links')).rows[0].n,0);
});
test('a still-valid old link can withdraw a later regrant, and never grants consent itself',async()=>{
  await unsubscribe();await pool.query("UPDATE buyer_email_preferences SET status='granted' WHERE buyer_id=$1",[f.buyer]);await unsubscribe();assert.equal(await preference(),'denied');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_email_preference_events WHERE buyer_id=$1',[f.buyer])).rows[0].n,2);
});
test('withdrawal preserves uncertainty and a late accepted provider fact',async()=>{
  await unsubscribe();assert.equal((await row()).status,'uncertain');
  await outbox.recordOutcome(pool,f.envelope.attempt,{outcome:'accepted',provider_id:randomUUID()});assert.equal((await row()).status,'accepted');assert.equal(await preference(),'denied');
});
test('withdrawal cancels an unattempted intent for a new eligible episode',async()=>{
  await pool.query("UPDATE buyers SET approved_at=NOW()-INTERVAL '81 days' WHERE id=$1",[f.buyer]);
  await require('../lib/buyer-engagement-ledger').runSimulation(pool,{kind:'generate',request_key:randomUUID()});const prep=require('../lib/buyer-engagement-preparation');await prep.enqueuePreparations(pool,{request_key:randomUUID()});await prep.processPreparations(pool,{batch_size:10});
  const job=(await pool.query('SELECT id FROM buyer_engagement_preparation_jobs WHERE buyer_id=$1 ORDER BY created_at DESC LIMIT 1',[f.buyer])).rows[0].id;
  const staged=await outbox.stageIntent(pool,{request_key:randomUUID(),preparation_job_id:job});assert.notEqual(staged.operation.outbox_id,f.intent);await unsubscribe();assert.equal((await pool.query('SELECT status FROM buyer_engagement_outbox WHERE id=$1',[staged.operation.outbox_id])).rows[0].status,'cancelled');
});
test('managed activation is single-use, sets no login, and does not grant a session',async()=>{
  const results=await Promise.all([activate(f.activationToken),activate(f.activationToken)]);assert.equal(results.filter(r=>r.body.ok).length,1);
  const b=(await pool.query('SELECT activation_pending,activated_at,first_login_at,last_login_at FROM buyers WHERE id=$1',[f.buyer])).rows[0];assert.equal(b.activation_pending,false);assert.ok(b.activated_at);assert.equal(b.first_login_at,null);assert.equal(b.last_login_at,null);
  const portal=await fetch(server.baseUrl+'/api/portal/me');assert.equal(portal.status,401);
});
test('managed activation requires current approval, same identity and pending activation',async()=>{
  for(const change of ["approved_at=NULL","approved_at=NOW()+INTERVAL '1 day'","email='other@example.test'","activation_pending=false","first_login_at=NOW()"]){
    await pool.query('UPDATE buyers SET '+change+' WHERE id=$1',[f.buyer]);assert.ok((await activate(f.activationToken)).body.error);
    await pool.query("UPDATE buyers SET approved_at=NOW()-INTERVAL '80 days',email=$2,activation_pending=true,first_login_at=NULL WHERE id=$1",[f.buyer,f.buyer+'@example.test']);
  }
  assert.equal((await pool.query('SELECT used FROM buyer_password_resets WHERE token=$1',[hash(f.activationToken)])).rows[0].used,false);
});
test('expiration rejects activation and blocks a retry without generating new links',async()=>{
  await pool.query("UPDATE buyer_password_resets SET expires_at=NOW()-INTERVAL '1 second' WHERE token=$1",[hash(f.activationToken)]);assert.ok((await activate(f.activationToken)).body.error);
  await outbox.recordOutcome(pool,f.envelope.attempt,{outcome:'uncertain'});await pool.query('UPDATE buyer_engagement_outbox SET next_attempt_at=NOW()');
  let calls=0;const r=await outbox.rehearseOne(pool,{key:f.key,transport:{kind:'local_fixture',submit:async()=>{calls++;}}});assert.equal(r.reason,'activation_link_unavailable');assert.equal(calls,0);assert.equal((await row()).status,'uncertain');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_activation_links')).rows[0].n,1);
});
test('valid retries preserve byte-identical links and the provider key',async()=>{
  await outbox.recordOutcome(pool,f.envelope.attempt,{outcome:'uncertain'});await pool.query('UPDATE buyer_engagement_outbox SET next_attempt_at=NOW()');
  const retry=await outbox.authorizeRehearsal(pool,await outbox.claimNext(pool),f.key,{origin:'https://changed.test'});assert.deepEqual(retry.payload,f.envelope.payload);assert.equal(retry.provider_key,f.envelope.provider_key);
});
test('absolute managed expiry still blocks activation if the legacy timestamp is later',async()=>{
  await pool.query("UPDATE buyer_engagement_activation_links SET expires_at=NOW()-INTERVAL '1 second'");await pool.query("UPDATE buyer_password_resets SET expires_at=NOW()+INTERVAL '1 day' WHERE token=$1",[hash(f.activationToken)]);
  assert.ok((await activate(f.activationToken)).body.error);assert.equal((await pool.query('SELECT used FROM buyer_password_resets WHERE token=$1',[hash(f.activationToken)])).rows[0].used,false);
  assert.equal((await links.frozenLinksValid(pool,await row(),(await pool.query('SELECT * FROM buyers WHERE id=$1',[f.buyer])).rows[0])).reason,'activation_link_unavailable');
});
test('issuing a managed activation preserves an existing legacy reset, and legacy reset still works',async()=>{
  const legacy='a'.repeat(64);f=await fixture(pool,{origin:server.baseUrl,legacyToken:legacy});assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_password_resets WHERE buyer_id=$1',[f.buyer])).rows[0].n,2);
  assert.equal((await activate(legacy)).body.ok,true);assert.ok((await activate(f.activationToken)).body.error);
});
test('removal of reset tokens invalidates managed metadata and retry, without a legacy bypass',async()=>{
  await pool.query('DELETE FROM buyer_password_resets WHERE buyer_id=$1',[f.buyer]);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_activation_links')).rows[0].n,0);assert.ok((await activate(f.activationToken)).body.error);
});
test('link issuance rolls back together with a failed attempt insert',async()=>{
  await pool.query('DELETE FROM buyer_engagement_unsubscribe_links');await pool.query('DELETE FROM buyer_password_resets');await pool.query('DELETE FROM buyer_engagement_outbox');
  const job=(await pool.query('SELECT id FROM buyer_engagement_preparation_jobs WHERE buyer_id=$1',[f.buyer])).rows[0].id;f.intent=(await outbox.stageIntent(pool,{request_key:randomUUID(),preparation_job_id:job})).operation.outbox_id;
  await pool.query("CREATE FUNCTION email_attempt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$");await pool.query('CREATE TRIGGER email_attempt_fail BEFORE INSERT ON buyer_engagement_outbox_attempts FOR EACH ROW EXECUTE FUNCTION email_attempt_fail()');
  try{await assert.rejects(outbox.authorizeRehearsal(pool,await outbox.claimNext(pool),f.key));assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_unsubscribe_links')).rows[0].n,0);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_password_resets')).rows[0].n,0);}finally{await pool.query('DROP TRIGGER email_attempt_fail ON buyer_engagement_outbox_attempts');await pool.query('DROP FUNCTION email_attempt_fail()');}
});
test('unsubscribe survives outbox retention, then expires; cleanup excludes legacy resets',async()=>{
  await pool.query("UPDATE buyer_engagement_outbox SET created_at=NOW()-INTERVAL '91 days'");const retention=require('../lib/buyer-engagement-retention');await retention.runRetention(pool);assert.equal(await row(),undefined);assert.equal((await unsubscribe()).body.ok,true);
  await pool.query("INSERT INTO buyer_password_resets(token,buyer_id,expires_at) VALUES($1,$2,NOW()-INTERVAL '9 days')",['legacy-expired',f.buyer]);await pool.query("UPDATE buyer_password_resets SET expires_at=NOW()-INTERVAL '8 days' WHERE token=$1",[hash(f.activationToken)]);
  await pool.query("UPDATE buyer_engagement_activation_links SET expires_at=NOW()-INTERVAL '8 days'");
  await pool.query("UPDATE buyer_engagement_unsubscribe_links SET expires_at=NOW()-INTERVAL '1 second'");const r=await retention.runRetention(pool);assert.equal(r.run.counts.unsubscribe_links,1);assert.equal(r.run.counts.activation_links,1);assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM buyer_password_resets WHERE token='legacy-expired'")).rows[0].n,1);assert.equal((await unsubscribe()).status,400);
});
test('migration is idempotent and does not mint or approve accounts',async()=>{
  await require('../lib/buyer-engagement-email-links-migration').migrateEmailLinks(pool);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyers')).rows[0].n,1);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_unsubscribe_links')).rows[0].n,1);
});
test('origin policy rejects credentials, paths, fragments and non-approved hosts',()=>{
  for(const origin of ['https://attacker.example','https://showroom.editionsstandard.com@attacker.example','https://showroom.editionsstandard.com/path','https://showroom.editionsstandard.com/#token=x','http://showroom.editionsstandard.com'])assert.throws(()=>links.checkedOrigin(origin));
  assert.equal(links.checkedOrigin('https://showroom.editionsstandard.com'),'https://showroom.editionsstandard.com');assert.equal(links.checkedOrigin('http://127.0.0.1:3270',{fixture:true}),'http://127.0.0.1:3270');
});
