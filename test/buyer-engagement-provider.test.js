'use strict';
const {test,before,beforeEach,after}=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg'),{randomUUID,randomBytes,createHmac}=require('node:crypto'),{startServer,id}=require('./helpers');
const seed=require('./email-links-fixture'),outbox=require('../lib/buyer-engagement-outbox'),provider=require('../lib/buyer-engagement-provider');
const secret='whsec_'+randomBytes(32).toString('base64'),previousSecret='whsec_'+randomBytes(32).toString('base64');
const route='/api/webhooks/buyer-engagement/resend',admin='/api/admin/buyer-engagement/provider-events';
let server,disabled,pool,f,providerId,ownerCookie;
async function cookie(session){const sid=randomUUID(),now=Date.now();await pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,...session})]);return 'sid='+encodeURIComponent('s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,''));}
const event=(type='email.delivered',changes={})=>({type,created_at:new Date().toISOString(),data:{email_id:providerId,to:[f.buyer+'@example.test'],subject:'PRIVATE synthetic body must not be stored',...changes}});
const globalEvent=(type='suppression.added',address=f.buyer+'@example.test')=>({type,created_at:new Date().toISOString(),data:{id:randomUUID(),email:address,origin:'manual'}});
function signed(raw,{deliveryId='msg_'+randomBytes(16).toString('hex'),key=secret,offset=0}={}){const timestamp=String(Math.floor(Date.now()/1000)+offset),signature='v1,'+createHmac('sha256',Buffer.from(key.slice(6),'base64')).update(deliveryId+'.'+timestamp+'.').update(raw).digest('base64');return {'svix-id':deliveryId,'svix-timestamp':timestamp,'svix-signature':signature};}
async function send(payload,{headers={},sign={},target=server,raw}={}){const body=raw||Buffer.from(JSON.stringify(payload)),r=await fetch(target.baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json',...signed(body,sign),...headers},body});return {status:r.status,body:await r.json(),headers:r.headers};}
const receipts=async()=> (await pool.query('SELECT * FROM buyer_engagement_provider_receipts')).rows;
const message=async()=> (await pool.query('SELECT * FROM buyer_engagement_provider_messages WHERE outbox_id=$1',[f.intent])).rows[0];
const blocks=async()=> (await pool.query('SELECT * FROM buyer_engagement_provider_blocks WHERE buyer_id=$1',[f.buyer])).rows;
async function nextPreparation(){await pool.query("UPDATE buyers SET approved_at=approved_at-INTERVAL '1 day' WHERE id=$1",[f.buyer]);await require('../lib/buyer-engagement-ledger').runSimulation(pool,{kind:'generate',request_key:randomUUID()});const prep=require('../lib/buyer-engagement-preparation');await prep.enqueuePreparations(pool,{request_key:randomUUID()});await prep.processPreparations(pool,{batch_size:10});return (await pool.query('SELECT id FROM buyer_engagement_preparation_jobs WHERE buyer_id=$1 ORDER BY created_at DESC LIMIT 1',[f.buyer])).rows[0].id;}
before(async()=>{server=await startServer({dbNameSuffix:'provider_'+Date.now(),port:3274,resendWebhookTestSecrets:[secret,previousSecret]});disabled=await startServer({dbNameSuffix:'provider_disabled_'+Date.now(),port:3275});pool=new Pool({connectionString:server.dbUrl});await pool.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');const owner=id('owner');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,$2,'not-a-password','Synthetic owner','owner',true)",[owner,owner+'@example.test']);ownerCookie=await cookie({staffUser:{id:owner,role:'owner',mfaEnrolled:true}});});
beforeEach(async()=>{await pool.query('TRUNCATE buyer_engagement_provider_receipts');f=await seed(pool,{origin:server.baseUrl});providerId=randomUUID();await outbox.recordOutcome(pool,f.envelope.attempt,{outcome:'accepted',provider_id:providerId});
  // Trusted test seed only: simulate the association a future real dispatcher
  // must establish. No public method can promote the isolated fixture binding.
  await pool.query("UPDATE buyer_engagement_provider_messages SET provider_kind='resend' WHERE outbox_id=$1",[f.intent]);});
after(async()=>{server?.stop();disabled?.stop();await pool?.end();});
test('receiver is disabled by default, even for a correctly signed body',async()=>{const r=await send(event(),{target:disabled});assert.equal(r.status,503);assert.equal(r.body.code,'provider_receiver_disabled');});
test('missing, forged, expired and future signatures cause no receipt, block or session',async()=>{
  for(const options of [{headers:{'svix-signature':''}},{sign:{key:'whsec_'+randomBytes(32).toString('base64')}},{sign:{offset:-600}},{sign:{offset:600}},{headers:{'svix-timestamp':'123garbage'}}]){const r=await send(event(),options);assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);}
  assert.equal((await receipts()).length,0);assert.equal((await blocks()).length,0);
});
test('signature authenticates original bytes; raw JSON whitespace is supported without reserialization',async()=>{
  const e=event(),raw=Buffer.from(JSON.stringify(e,null,2));assert.equal((await send(e,{raw})).status,200);const altered=Buffer.from(JSON.stringify(e));assert.equal((await send(e,{raw:altered,headers:signed(raw)})).status,401);assert.equal((await receipts()).length,1);
});
test('current and previous signing secrets both work during explicit rotation',async()=>{assert.equal((await send(event())).status,200);assert.equal((await send(event('email.sent'),{sign:{key:previousSecret}})).status,200);assert.ok((await message()).sent_at);});
test('bounded JSON only: oversized bodies, unsupported encoding and content type cannot reach effects',async()=>{
  assert.equal((await send(event(),{headers:{'Content-Type':'text/plain'}})).status,415);assert.equal((await send(event(),{headers:{'Content-Encoding':'gzip'}})).status,415);
  assert.equal((await send(event('email.sent',{subject:'x'.repeat(33000)}))).status,413);assert.equal((await receipts()).length,0);
});
test('invalid event shapes and future event dates are rejected after authentication',async()=>{
  const future=event();future.created_at=new Date(Date.now()+3600000).toISOString();
  for(const e of [event('email.delivered',{to:['a@example.test','b@example.test']}),event('email.delivered',{email_id:'bad'}),{...event(),created_at:'bad'},future])assert.equal((await send(e)).status,400);
  assert.equal((await receipts()).length,0);
});
test('open, click and unrelated event types create no behavioral tracking',async()=>{for(const type of ['email.opened','email.clicked','contact.created','constructor','__proto__'])assert.equal((await send({type,data:{url:'PRIVATE'}})).status,200);assert.equal((await receipts()).length,0);assert.equal((await message()).last_event_at,null);});
test('duplicate concurrent deliveries apply once; conflicting content under one signed ID is rejected',async()=>{
  const e=event(),deliveryId='msg_'+randomUUID(),results=await Promise.all(Array.from({length:8},()=>send(e,{sign:{deliveryId}})));assert.ok(results.every(r=>r.status===200));assert.equal((await receipts()).length,1);assert.ok((await message()).delivered_at);
  assert.equal((await send(event('email.bounced'),{sign:{deliveryId}})).status,409);assert.equal((await blocks()).length,0);
});
test('delivery records server acceptance only, without login, activity, preference or order changes',async()=>{
  const query='SELECT approved_at,first_login_at,last_login_at,last_meaningful_activity_at,last_seen_at,last_engagement_email_at,activation_pending FROM buyers WHERE id=$1',before=(await pool.query(query,[f.buyer])).rows[0];
  const r=await send(event());assert.deepEqual(r.body,{received:true});assert.equal(r.headers.get('set-cookie'),null);assert.deepEqual((await pool.query(query,[f.buyer])).rows[0],before);
  assert.equal((await pool.query('SELECT status FROM buyer_engagement_outbox WHERE id=$1',[f.intent])).rows[0].status,'accepted');assert.equal((await blocks()).length,0);
});
test('an unknown provider ID never matches a buyer by email and stores no raw body or recipient',async()=>{
  await send(event('email.complained',{email_id:randomUUID()}));const rows=await receipts();assert.equal(rows[0].status,'unmatched');assert.equal(rows[0].buyer_id,null);assert.equal((await blocks()).length,0);assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);assert.equal(JSON.stringify(rows).includes('@example.test'),false);
});
test('repeated unmatched events do not renew their retention window',async()=>{
  const e=event('email.sent',{email_id:randomUUID()}),deliveryId='msg_'+randomUUID();await send(e,{sign:{deliveryId}});const first=(await receipts())[0];await send(e,{sign:{deliveryId}});const repeated=(await receipts())[0];assert.equal(+repeated.received_at,+first.received_at);assert.equal(+repeated.expires_at,+first.expires_at);
});
test('real-provider receiver cannot mistake an isolated fixture ID for a real association',async()=>{
  await pool.query("UPDATE buyer_engagement_provider_messages SET provider_kind='local_fixture' WHERE outbox_id=$1",[f.intent]);await send(event('email.bounced'));assert.equal((await receipts())[0].status,'unmatched');assert.equal((await blocks()).length,0);
});
test('wrong recipient or a timestamp preceding the attempt is quarantined without blocking another identity',async()=>{
  await send(event('email.complained',{to:['other@example.test']}));const old=event('email.bounced');old.created_at=new Date(Date.now()-3600000).toISOString();await send(old);assert.ok((await receipts()).every(r=>r.status==='mismatch'));assert.equal((await blocks()).length,0);
});
test('a webhook before the HTTP acknowledgement requires an authenticated replay after authoritative binding',async()=>{
  f=await seed(pool,{origin:server.baseUrl});providerId=randomUUID();const e=event('email.bounced'),deliveryId='msg_'+randomUUID();await send(e,{sign:{deliveryId}});assert.equal((await receipts())[0].status,'unmatched');
  await outbox.recordOutcome(pool,f.envelope.attempt,{outcome:'accepted',provider_id:providerId});await pool.query("UPDATE buyer_engagement_provider_messages SET provider_kind='resend' WHERE outbox_id=$1",[f.intent]);
  await send(e,{sign:{deliveryId}});assert.equal((await receipts())[0].status,'applied');assert.equal((await blocks()).length,1);assert.equal((await receipts()).length,1);
  assert.equal((await pool.query("SELECT expires_at=received_at+INTERVAL '90 days' AS anchored FROM buyer_engagement_provider_receipts")).rows[0].anchored,true);
});
test('bounce and complaint remain sticky despite late delivery and do not rewrite marketing consent',async()=>{
  await send(event('email.bounced'));await send(event('email.complained'));await send(event('email.delivered'));await send(event('email.sent'));
  const m=await message();assert.ok(m.bounced_at&&m.complained_at&&m.delivered_at&&m.sent_at);assert.equal((await blocks())[0].reason,'complained');
  assert.equal((await pool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[f.buyer])).rows[0].status,'granted');assert.equal(await provider.hasProviderBlock(pool,(await pool.query('SELECT id,email FROM buyers WHERE id=$1',[f.buyer])).rows[0]),true);
  await assert.rejects(outbox.stageIntent(pool,{request_key:randomUUID(),preparation_job_id:await nextPreparation()}),e=>e.code==='provider_suppression');
});
test('a late HTTP acceptance cannot clear a provider delivery warning',async()=>{
  f=await seed(pool,{origin:server.baseUrl});const first=f.envelope;await outbox.recordOutcome(pool,first.attempt,{outcome:'uncertain'});await pool.query('UPDATE buyer_engagement_outbox SET next_attempt_at=NOW() WHERE id=$1',[f.intent]);const second=await outbox.authorizeRehearsal(pool,await outbox.claimNext(pool),f.key);providerId=randomUUID();await outbox.recordOutcome(pool,second.attempt,{outcome:'accepted',provider_id:providerId});
  const e=event('email.complained');await provider.processVerifiedEvent(pool,{event:e,raw:Buffer.from(JSON.stringify(e)),deliveryId:'msg_'+randomUUID(),providerKind:'local_fixture'});await outbox.recordOutcome(pool,first.attempt,{outcome:'accepted',provider_id:providerId});const r=(await pool.query('SELECT needs_attention,reason,status FROM buyer_engagement_outbox WHERE id=$1',[f.intent])).rows[0];assert.equal(r.needs_attention,true);assert.equal(r.reason,'provider_delivery_problem');assert.equal(r.status,'accepted');
});
test('a provider block cancels queued intentions and prevents consent regrant from bypassing it',async()=>{
  const job=await nextPreparation(),intent=(await outbox.stageIntent(pool,{request_key:randomUUID(),preparation_job_id:job})).operation.outbox_id;await send(event('email.suppressed'));
  assert.equal((await pool.query('SELECT status FROM buyer_engagement_outbox WHERE id=$1',[intent])).rows[0].status,'cancelled');await pool.query("UPDATE buyer_email_preferences SET status='granted' WHERE buyer_id=$1",[f.buyer]);await assert.rejects(outbox.stageIntent(pool,{request_key:randomUUID(),preparation_job_id:job}),e=>e.code==='provider_suppression');
});
test('global suppression is restricted to known provider recipients; a removal never automatically unblocks',async()=>{
  await send(globalEvent());assert.equal((await blocks()).length,1);await send(globalEvent('suppression.removed'));assert.ok((await blocks())[0].removal_notice_at);
  await send(globalEvent('suppression.added','unknown@example.test'));assert.equal((await receipts()).filter(r=>r.status==='unmatched').length,1);assert.equal((await blocks()).length,1);
});
test('generic sending failures and temporary delays are not labelled as a bad buyer address',async()=>{
  await send(event('email.delivery_delayed'));await send(event('email.failed'));assert.equal((await blocks()).length,0);assert.ok((await message()).delayed_at);assert.ok((await message()).failed_at);assert.equal((await pool.query('SELECT needs_attention FROM buyer_engagement_outbox WHERE id=$1',[f.intent])).rows[0].needs_attention,true);
});
test('explicit temporary bounces are reviewed without an address block, while permanent bounces block',async()=>{
  await send(event('email.bounced',{bounce:{type:'Temporary'}}));assert.equal((await blocks()).length,0);await send(event('email.bounced',{bounce:{type:'Permanent'}}));assert.equal((await blocks())[0].reason,'bounced');
});
test('a bounce without a classification is conservatively blocked for review rather than called permanent',async()=>{
  await send(event('email.bounced'));assert.equal((await blocks())[0].reason,'bounce_unclassified');
});
test('an old-address bounce is retained without blocking a changed address',async()=>{
  await pool.query("UPDATE buyers SET email='changed@example.test' WHERE id=$1",[f.buyer]);await send(event('email.bounced'));assert.equal((await blocks()).length,1);assert.equal(await provider.hasProviderBlock(pool,{id:f.buyer,email:'changed@example.test'}),false);assert.equal(await provider.hasProviderBlock(pool,{id:f.buyer,email:f.buyer+'@example.test'}),true);
});
test('delivery timestamps retain the earliest fact under out-of-order events',async()=>{
  const early=event(),late=structuredClone(early);late.created_at=new Date(+new Date(early.created_at)+1000).toISOString();await send(late);await send(early);assert.equal(+(await message()).delivered_at,+new Date(early.created_at));
});
test('database failures are not acknowledged and roll back the block and delivery fact together',async()=>{
  await pool.query("CREATE FUNCTION provider_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$");await pool.query('CREATE TRIGGER provider_receipt_fail BEFORE INSERT ON buyer_engagement_provider_receipts FOR EACH ROW EXECUTE FUNCTION provider_receipt_fail()');
  try{assert.equal((await send(event('email.bounced'))).status,503);assert.equal((await blocks()).length,0);assert.equal((await message()).bounced_at,null);}finally{await pool.query('DROP TRIGGER provider_receipt_fail ON buyer_engagement_provider_receipts');await pool.query('DROP FUNCTION provider_receipt_fail()');}
});
test('lost SQL acknowledgement replays the committed receipt without duplicating effects',async()=>{
  const e=event('email.bounced'),raw=Buffer.from(JSON.stringify(e)),deliveryId='msg_'+randomUUID();let lost=false;const proxy={connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{const r=await c.query(sql,args);if(sql==='COMMIT'&&!lost){lost=true;throw Error('synthetic lost commit');}return r;},release:()=>c.release()};}};
  await assert.rejects(provider.processVerifiedEvent(proxy,{event:e,raw,deliveryId}));const first=(await blocks())[0];assert.equal((await provider.processVerifiedEvent(pool,{event:e,raw,deliveryId})).replayed,true);assert.equal((await receipts()).length,1);assert.equal(+(await blocks())[0].created_at,+first.created_at);
});
test('owner-only monitoring exposes no secret, hash, body or operational mutation route',async()=>{
  assert.equal((await fetch(server.baseUrl+admin)).status,403);const buyerCookie=await cookie({buyerPortal:{id:f.buyer}});assert.equal((await fetch(server.baseUrl+admin,{headers:{Cookie:buyerCookie}})).status,403);
  const a=id('agent');await pool.query("INSERT INTO admin_users(id,email,password_hash,name,role,mfa_enabled) VALUES($1,$2,'not-a-password','Synthetic agent','agent',true)",[a,a+'@example.test']);assert.equal((await fetch(server.baseUrl+admin,{headers:{Cookie:await cookie({staffUser:{id:a,role:'agent',mfaEnrolled:true}})}})).status,403);
  const r=await fetch(server.baseUrl+admin,{headers:{Cookie:ownerCookie}}),data=await r.json();assert.equal(r.status,200);assert.equal(data.sending_enabled,false);assert.equal(data.receiver.enabled,true);for(const text of ['recipient_hash',secret,'PRIVATE','payload_hash'])assert.equal(JSON.stringify(data).includes(text),false);assert.equal((await fetch(server.baseUrl+admin+'/unblock',{method:'POST',headers:{Cookie:ownerCookie}})).status,404);
});
test('buyer export contains its own provider facts but excludes hashes and webhook secrets',async()=>{
  await send(event('email.bounced'));const c=await cookie({buyerPortal:{id:f.buyer}}),r=await fetch(server.baseUrl+'/api/portal/gdpr/export',{headers:{Cookie:c}}),data=(await r.json()).engagement.provider_events;assert.equal(data.messages.length,1);assert.equal(data.blocks.length,1);assert.equal(data.receipts.length,1);for(const text of ['hash',secret,'PRIVATE','delivery_id'])assert.equal(JSON.stringify(data).includes(text),false);
});
test('retention removes expired receipts and message history but preserves an active address block',async()=>{
  await send(event('email.bounced'));await send(event('email.sent',{email_id:randomUUID()}));await pool.query("UPDATE buyer_engagement_provider_receipts SET expires_at=NOW()-INTERVAL '1 second'");const retention=require('../lib/buyer-engagement-retention');assert.equal((await retention.runRetention(pool)).run.counts.provider_receipts,2);assert.equal((await blocks()).length,1);
  await pool.query("UPDATE buyer_engagement_outbox SET created_at=NOW()-INTERVAL '91 days'");await retention.runRetention(pool);assert.equal(await message(),undefined);assert.equal((await blocks()).length,1);await pool.query('DELETE FROM buyers WHERE id=$1',[f.buyer]);assert.equal((await blocks()).length,0);
});
test('inbox capacity stops new receipts without rejecting a previously committed duplicate',async()=>{
  const e=event(),deliveryId='msg_'+randomUUID();await send(e,{sign:{deliveryId}});
  await pool.query("INSERT INTO buyer_engagement_provider_receipts(provider_kind,delivery_id,payload_hash,event_type,event_at,status,expires_at) SELECT 'resend','capacity_'||n,'synthetic','email.sent',NOW(),'unmatched',NOW()+INTERVAL '7 days' FROM generate_series(1,9999) n");
  assert.equal((await send(event('email.sent'))).status,503);assert.equal((await send(e,{sign:{deliveryId}})).status,200);assert.equal((await receipts()).length,10000);
});
test('migration rerun preserves existing facts and never activates sending',async()=>{await send(event());await require('../lib/buyer-engagement-provider-migration').migrateProviderEvents(pool);assert.ok((await message()).delivered_at);assert.equal((await pool.query('SELECT delivery_enabled FROM buyer_engagement_outbox_control')).rows[0].delivery_enabled,false);});
test('invalid or weak signing configuration remains closed',()=>{for(const secrets of [[],['not-a-key'],['whsec_YQ=='],[secret,secret,secret]])assert.equal(provider.signingConfig({enabled:true,secrets}).configured,false);assert.equal(provider.signingConfig({enabled:false,secrets:[secret]}).enabled,false);});
