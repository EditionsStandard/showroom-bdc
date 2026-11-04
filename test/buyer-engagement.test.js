'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const bcrypt=require('bcryptjs');
const {authenticator}=require('otplib');
const {Pool}=require('pg');
const {startServer,withDb,id}=require('./helpers');
const {evaluateBuyer,captureRequestPreference}=require('../lib/buyer-engagement');
const {migrateBuyerEngagement}=require('../lib/buyer-engagement-migration');
let server,owner,buyerCookie,buyerId,dbPool;
const password='SyntheticPassword123!';
async function req(path,cookie,method='GET',body) {
  const response=await fetch(server.baseUrl+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const data=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();
  return {status:response.status,data,response};
}
async function login(email,pw=password) {
  return req('/editions-showroom-b2b-portail',null,'POST',{email,password:pw});
}
const cookie=r=>r.response.headers.get('set-cookie')?.split(';')[0];
async function seedBuyer(extra={}) {
  const buyer=id('engagement');
  await withDb(server.dbUrl,async db=>{
    await db.query('INSERT INTO buyers(id,email,password_hash,name,country) VALUES($1,$2,$3,$4,$5)',[buyer,buyer+'@test.invalid',await bcrypt.hash(password,10),'Synthetic buyer','FR']);
    if(extra.known)await db.query("UPDATE buyers SET login_history_known=true,approved_at=NOW()-INTERVAL '40 days' WHERE id=$1",[buyer]);
  });return buyer;
}
async function row(buyer=buyerId) { return withDb(server.dbUrl,async db=>(await db.query('SELECT * FROM buyers WHERE id=$1',[buyer])).rows[0]); }
before(async()=>{
  server=await startServer({dbNameSuffix:'engagement_'+crypto.randomBytes(4).toString('hex'),port:3217});
  dbPool=new Pool({connectionString:server.dbUrl});
  const secret=authenticator.generateSecret();
  await dbPool.query("INSERT INTO settings(key,value) VALUES('owner_mfa_enabled','on'),('owner_mfa_secret',$1),('owner_mfa_last_step','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[secret]);
  const initial=await req('/admin/login',null,'POST',{password:'TestAdmin123!'});
  const final=await req('/admin/login/mfa',cookie(initial),'POST',{code:authenticator.generate(secret)});
  assert.equal(final.response.headers.get('location'),'/admin');owner=cookie(final)||cookie(initial);
  buyerId=await seedBuyer({known:true});
  buyerCookie=cookie(await login(buyerId+'@test.invalid'));
});
after(async()=>{server?.stop();await dbPool?.end();});

test('simulation boundaries: unknown history and permission exclude; exact 30 days qualifies only observed inactivity',()=>{
  const now=new Date('2026-11-01T12:00:00Z'),past=new Date(now-30*86400000);
  const rule={id:'inactive',mode:'simulation',delay_hours:720};
  const b={email_status:'granted',login_history_known:true,last_login_at:past,last_meaningful_activity_at:past};
  assert.equal(evaluateBuyer(b,rule,now).eligible,true);
  assert.equal(evaluateBuyer({...b,last_meaningful_activity_at:new Date(+past+1)},rule,now).reason,'recent_activity');
  assert.equal(evaluateBuyer({...b,last_seen_at:now},rule,now).reason,'recent_presence');
  for(const status of ['unknown','denied'])assert.equal(evaluateBuyer({...b,email_status:status},rule,now).eligible,false);
  assert.equal(evaluateBuyer({...b,login_history_known:false},rule,now).reason,'history_unknown');
  assert.equal(evaluateBuyer({...b,last_login_at:null},rule,now).eligible,false);
  assert.equal(evaluateBuyer({...b,activation_pending:true},rule,now).eligible,false);
  assert.equal(evaluateBuyer(b,{...rule,mode:'disabled'},now).eligible,false);
  for(const id of ['cart','brand_interest'])assert.equal(evaluateBuyer(b,{...rule,id},now).eligible,false);
  const welcome={id:'welcome',mode:'simulation',delay_hours:24};
  assert.equal(evaluateBuyer({...b,last_login_at:null,approved_at:past},welcome,now).eligible,true);
  assert.equal(evaluateBuyer({...b,approved_at:past,first_login_at:past},welcome,now).eligible,false);
});

test('login records observation; failed login and heartbeat never manufacture meaningful activity',async()=>{
  const legacy=await seedBuyer();
  await login(legacy+'@test.invalid','wrong-password');assert.equal((await row(legacy)).first_login_at,null);
  const signed=await login(legacy+'@test.invalid');const observed=await row(legacy);
  assert.ok(observed.first_login_at);assert.equal(observed.login_history_known,false);
  await req('/api/portal/ping',cookie(signed),'POST',{});
  const after=await row(legacy);assert.equal(+after.last_meaningful_activity_at,+observed.last_meaningful_activity_at);assert.ok(after.last_seen_at);
  await login(legacy+'@test.invalid');assert.equal(+(await row(legacy)).first_login_at,+observed.first_login_at);
});

test('MFA records no completed login before the second factor',async()=>{
  const buyer=await seedBuyer({known:true}),secret=authenticator.generateSecret();
  await dbPool.query('UPDATE buyers SET mfa_enabled=true,mfa_secret=$2 WHERE id=$1',[buyer,secret]);
  const pending=await login(buyer+'@test.invalid');assert.match(pending.response.headers.get('location'),/step=mfa/);
  assert.equal((await row(buyer)).first_login_at,null);
  const success=await req('/editions-showroom-b2b-portail/mfa',cookie(pending),'POST',{code:authenticator.generate(secret)});
  assert.equal(success.response.headers.get('location'),'/portal');assert.ok((await row(buyer)).first_login_at);
});

test('only changed cart JSON updates activity; key order and identical sync do not',async()=>{
  await req('/api/portal/cart',buyerCookie,'POST',{cart:{a:1,b:2}});
  const first=await row();
  await req('/api/portal/cart',buyerCookie,'POST',{cart:{b:2,a:1}});
  assert.equal(+(await row()).last_meaningful_activity_at,+first.last_meaningful_activity_at);
  await req('/api/portal/cart',buyerCookie,'POST',{cart:{a:2,b:2}});
  assert.ok(+(await row()).last_meaningful_activity_at>+first.last_meaningful_activity_at);
});

test('approval stores provenance and initial choice; reapproval cannot override withdrawal',async()=>{
  const request=id('request'),email=request+'@test.invalid';
  await dbPool.query("INSERT INTO access_requests(id,name,email,marketing_consent,privacy_accepted_at) VALUES($1,'Synthetic',$2,true,NOW())",[request,email]);
  const approved=await req('/api/access-requests/'+request+'/approve',owner,'POST');assert.equal(approved.data.ok,true);
  const b=(await dbPool.query('SELECT * FROM buyers WHERE email=$1',[email])).rows[0];
  assert.equal(b.access_source,'access_request');assert.equal(b.login_history_known,true);assert.ok(b.approved_at);assert.equal(b.first_login_at,null);
  assert.equal((await dbPool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[b.id])).rows[0].status,'granted');
  await dbPool.query("UPDATE buyer_email_preferences SET status='denied' WHERE buyer_id=$1",[b.id]);
  const client=await dbPool.connect();try {await captureRequestPreference(client,b.id,{id:'later',marketing_consent:true,privacy_accepted_at:new Date()});}finally{client.release();}
  assert.equal((await dbPool.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[b.id])).rows[0].status,'denied');
  const token=new URL(approved.data.activation_url).searchParams.get('token');
  await req('/api/portal/reset-password',null,'POST',{token,password});
  assert.ok((await row(b.id)).activated_at);assert.equal((await row(b.id)).first_login_at,null);
});

test('admin-created accounts need a hashed single-use activation, never an emailed password',async()=>{
  const created=await req('/api/buyers',owner,'POST',{email:id('created')+'@test.invalid',name:'Synthetic',password:'IgnoredOldAdminPassword12!'});
  assert.equal(created.status,200);assert.equal(created.data.emailed,false);assert.equal(created.data.password,undefined);
  const b=await row(created.data.id);assert.equal(b.activation_pending,true);assert.equal(b.access_source,'admin_created');assert.ok(b.approved_at);
  assert.equal(await bcrypt.compare('IgnoredOldAdminPassword12!',b.password_hash),false);
  const token=new URL(created.data.activation_url).searchParams.get('token');
  assert.equal((await dbPool.query('SELECT token FROM buyer_password_resets WHERE buyer_id=$1',[b.id])).rows[0].token,crypto.createHash('sha256').update(token).digest('hex'));
  const result=await req('/api/portal/reset-password',null,'POST',{token,password});assert.equal(result.data.ok,true);
  assert.ok((await row(b.id)).activated_at);
  assert.equal((await req('/api/portal/reset-password',null,'POST',{token,password})).data.ok,undefined);
});

test('public invitation cannot create an account or session',async()=>{
  const email=id('invite')+'@test.invalid';
  const result=await req('/api/invite/any-token',null,'POST',{name:'Synthetic',email,password});
  assert.equal(result.status,409);assert.equal(result.data.redirect,'/demande-acces');
  assert.equal((await dbPool.query('SELECT id FROM buyers WHERE email=$1',[email])).rowCount,0);
  assert.equal((await req('/rejoindre/any-token')).response.headers.get('location'),'/demande-acces');
});

test('access tokens cannot bypass activation and concurrent use yields only one login',async()=>{
  const b=await seedBuyer({known:true}),token=id('token');
  await dbPool.query('CREATE TABLE IF NOT EXISTS buyer_access_tokens(token TEXT PRIMARY KEY,buyer_id TEXT REFERENCES buyers(id),expires_at TIMESTAMP,used BOOLEAN DEFAULT false)');
  await dbPool.query("INSERT INTO buyer_access_tokens(token,buyer_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')",[token,b]);
  await dbPool.query('UPDATE buyers SET activation_pending=true WHERE id=$1',[b]);
  await req('/portal/access?token='+token);assert.equal((await row(b)).first_login_at,null);
  assert.equal((await dbPool.query('SELECT used FROM buyer_access_tokens WHERE token=$1',[token])).rows[0].used,false);
  await dbPool.query('UPDATE buyers SET activation_pending=false WHERE id=$1',[b]);
  const results=await Promise.all([req('/portal/access?token='+token),req('/portal/access?token='+token)]);
  assert.equal(results.filter(r=>r.response.headers.get('location')==='/portal').length,1);assert.ok((await row(b)).first_login_at);
});

test('preference API requires explicit boolean; withdrawal excludes simulation and blocks legacy marketing',async()=>{
  assert.equal((await req('/api/portal/email-preferences',buyerCookie,'PUT',{marketing_consent:'true'})).status,400);
  assert.equal((await req('/api/portal/email-preferences',buyerCookie,'PUT',{marketing_consent:true})).status,200);
  await req('/api/portal/email-preferences',buyerCookie,'PUT',{marketing_consent:false});
  await req('/api/portal/email-preferences',buyerCookie,'PUT',{marketing_consent:false});
  assert.equal((await dbPool.query('SELECT COUNT(*)::int AS n FROM buyer_email_preference_events WHERE buyer_id=$1',[buyerId])).rows[0].n,2);
  assert.equal((await req('/api/admin/buyers/'+buyerId+'/relance',owner,'POST',{})).status,409);
  for(const path of ['/api/portal/gdpr/export','/api/portal/my-data-export']) {
    const exported=await req(path,buyerCookie);assert.equal(exported.data.engagement.email_preference.status,'denied');assert.equal(exported.data.engagement.preference_history.length,2);
  }
});

test('only owner can access simulation; rule versions reject lost updates and sending mode',async()=>{
  assert.equal((await req('/api/admin/buyer-engagement')).status,403);
  assert.equal((await req('/api/admin/buyer-engagement',buyerCookie)).status,403);
  const rules=(await req('/api/admin/buyer-engagement',owner)).data.rules;
  const welcome=rules.find(r=>r.id==='welcome');
  assert.equal((await req('/api/admin/buyer-engagement/rules/welcome',owner,'PUT',{mode:'live',delay_hours:24,version:welcome.version})).status,400);
  const save=()=>req('/api/admin/buyer-engagement/rules/welcome',owner,'PUT',{mode:'simulation',delay_hours:24,version:welcome.version});
  const concurrent=await Promise.all([save(),save()]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  const snapshot=await req('/api/admin/buyer-engagement',owner);assert.equal(snapshot.data.sending_enabled,false);assert.equal(snapshot.response.headers.get('cache-control'),'no-store');
});

test('repeat simulation creates no jobs, tokens, reminders or consent events; template writes retain versions',async()=>{
  const counts=async()=>(await dbPool.query(`SELECT (SELECT COUNT(*) FROM pending_reminders) AS reminders,(SELECT COUNT(*) FROM buyer_password_resets) AS tokens,(SELECT COUNT(*) FROM buyer_email_preference_events) AS preferences`)).rows[0];
  const before=await counts(),one=await req('/api/admin/buyer-engagement',owner),two=await req('/api/admin/buyer-engagement',owner);
  assert.deepEqual(one.data.buyers,two.data.buyers);assert.deepEqual(await counts(),before);
  const tpl=one.data.templates.find(t=>t.rule_id==='welcome' && t.lang==='fr');
  const save=()=>req('/api/admin/buyer-engagement/templates/welcome/fr',owner,'PUT',{version:tpl.version,subject:'Brouillon <script>',body:'{{buyer_name}} — texte'});
  assert.deepEqual((await Promise.all([save(),save()])).map(r=>r.status).sort(),[200,409]);
  assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM buyer_engagement_templates WHERE rule_id='welcome' AND lang='fr'")).rows[0].n,2);
});

test('migration reruns preserve unknown history and edited rules; preferences cascade on account deletion',async()=>{
  const legacy=await seedBuyer();await dbPool.query("UPDATE buyers SET last_seen_at=NOW()-INTERVAL '2 years' WHERE id=$1",[legacy]);
  const before=(await dbPool.query('SELECT * FROM buyer_engagement_rules ORDER BY id')).rows;
  await migrateBuyerEngagement(dbPool);await migrateBuyerEngagement(dbPool);
  assert.deepEqual((await dbPool.query('SELECT * FROM buyer_engagement_rules ORDER BY id')).rows,before);
  assert.equal((await row(legacy)).login_history_known,false);assert.equal((await row(legacy)).first_login_at,null);
  assert.equal((await req('/api/portal/delete-account',buyerCookie,'POST',{password})).status,200);
  assert.equal((await dbPool.query('SELECT * FROM buyer_email_preferences WHERE buyer_id=$1',[buyerId])).rowCount,0);
  assert.equal((await dbPool.query('SELECT * FROM buyer_email_preference_events WHERE buyer_id=$1',[buyerId])).rowCount,0);
});

test('migration rolls back additive DDL on failure',async()=>{
  const schema='rollback_'+crypto.randomBytes(4).toString('hex');
  const db=await dbPool.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`);
    await db.query('CREATE TABLE buyers(id TEXT PRIMARY KEY)');
    let failed=false;
    const proxy={connect:async()=>({query:async(sql,args)=>{
      if(sql.startsWith('INSERT INTO buyer_engagement_templates'))throw new Error('synthetic migration failure');
      return db.query(sql,args);
    },release(){}})};
    try {await migrateBuyerEngagement(proxy);}catch {failed=true;}
    assert.equal(failed,true);
    const columns=await db.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=\'buyers\'',[schema]);
    assert.deepEqual(columns.rows.map(r=>r.column_name),['id']);
    assert.equal((await db.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rowCount,1);
  }finally {await db.query('SET search_path TO public');await db.query(`DROP SCHEMA ${schema} CASCADE`);db.release();}
});

test('agent and designer sessions cannot read or edit owner engagement data',async()=>{
  for(const role of ['agent','designer']) {
    const staff=id(role),sid=id('session');
    await dbPool.query('INSERT INTO admin_users(id,email,password_hash,role,mfa_enabled) VALUES($1,$2,$3,$4,true)',[staff,staff+'@test.invalid','not-a-password',role]);
    const now=Date.now(),session={cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},staffUser:{id:staff,role,email:staff+'@test.invalid',mfaEnrolled:true},authAt:now,lastActive:now};
    await dbPool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify(session)]);
    const sig=crypto.createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
    const auth='sid='+encodeURIComponent('s:'+sid+'.'+sig);
    assert.equal((await req('/api/admin/buyer-engagement',auth)).status,403);
    assert.equal((await req('/api/admin/buyer-engagement/rules/welcome',auth,'PUT',{mode:'simulation',delay_hours:24,version:1})).status,403);
  }
});
