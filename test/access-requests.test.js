const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {startServer,withDb,id} = require('./helpers');
let server, cookie;
const valid = () => ({name:'Test Buyer',company:'Test Store',job_title:'Buyer',country:'Singapore',city:'Singapore',email:`${id('access')}@example.com`,business_type:'Retailer',website:'https://example.com',privacy_accepted:true});
async function post(path,body,auth=false) {return fetch(server.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{})},body:JSON.stringify(body||{})});}
async function row(email) {return withDb(server.dbUrl,async c=>(await c.query('SELECT * FROM access_requests WHERE email=$1',[email])).rows[0]);}
async function buyers(email) {return withDb(server.dbUrl,async c=>(await c.query('SELECT * FROM buyers WHERE email=$1',[email])).rows);}
async function verify(request, expired=false) {
  const token=crypto.randomBytes(32).toString('hex');
  await withDb(server.dbUrl,c=>c.query('UPDATE access_requests SET verification_token_hash=$2, verification_expires_at=$3 WHERE id=$1',[request.id,crypto.createHash('sha256').update(token).digest('hex'),new Date(Date.now()+(expired?-10000:3600000))]));
  return {token,response:await post('/api/access-request/verify-email',{token})};
}
before(async()=>{
  // No external mail or CRM secrets are used in this test process.
  delete process.env.RESEND_API_KEY; delete process.env.AIRTABLE_API_KEY;
  server=await startServer({dbNameSuffix:'access',port:3104});
  await withDb(server.dbUrl,c=>c.query("INSERT INTO settings (key,value) VALUES ('owner_mfa_enabled','off') ON CONFLICT (key) DO UPDATE SET value='off'"));
  const r=await fetch(server.baseUrl+'/admin/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password=TestAdmin123!',redirect:'manual'});
  cookie=r.headers.get('set-cookie'); assert.ok(cookie); assert.equal(r.headers.get('location'),'/admin');
  const setup = await post('/api/staff/mfa/setup',{},true); const {secret} = await setup.json(); assert.ok(secret);
  const confirm = await post('/api/staff/mfa/confirm',{code:require('otplib').authenticator.generate(secret)},true); assert.equal(confirm.status,200);
});
after(()=>server?.stop());
test('incomplete or forged requests fail without creating a request or buyer',async()=>{
  for(const patch of [{company:''},{country:''},{city:''},{job_title:''},{business_type:''},{website:''},{email:{}},{instagram:'https://evil.com/store'}]) {
    const data={...valid(),...patch}; const r=await post('/api/access-request',data); assert.equal(r.status,400); if(typeof data.email==='string') assert.equal(await row(data.email),undefined);
  }
});
test('complete submission stays pending even when email fails; public actions cannot approve',async()=>{
  const data=valid();const r=await post('/api/access-request',{...data,status:'approved',email_verified_at:new Date().toISOString()});
  assert.equal(r.status,200);const result=await r.json(); assert.equal(result.status,'pending'); assert.equal(result.verification_sent,false);
  const saved=await row(data.email);assert.equal(saved.status,'pending');assert.equal(saved.email_verified_at,null);assert.equal(saved.job_title,'Buyer');assert.equal(saved.city,'Singapore');assert.equal(saved.business_type,'Retailer');assert.equal((await buyers(data.email)).length,0);
  for(const action of ['approve','reject','resend-verification']) assert.ok([401,403].includes((await post(`/api/access-requests/${saved.id}/${action}`)).status));
  assert.equal((await post(`/api/access-requests/${saved.id}/approve`,{},true)).status,409);
  assert.equal((await fetch(server.baseUrl+'/api/portal/brands')).status,401);
});
test('verification is single-use, stays pending, then only admin approval creates working access',async()=>{
  const data=valid();await post('/api/access-request',data);const saved=await row(data.email);
  const {token,response}=await verify(saved);assert.equal(response.status,200);assert.equal((await row(data.email)).status,'pending');assert.equal((await buyers(data.email)).length,0);
  assert.equal((await post('/api/access-request/verify-email',{token})).status,400);
  const r=await post(`/api/access-requests/${saved.id}/approve`,{},true);assert.equal(r.status,200);const result=await r.json();assert.ok(result.temp_password);
  assert.equal((await row(data.email)).status,'approved');assert.equal((await buyers(data.email)).length,1);
  const login=await fetch(server.baseUrl+'/editions-showroom-b2b-portail',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:data.email,password:result.temp_password}),redirect:'manual'});
  assert.equal(login.headers.get('location'),'/portal');
  const session=login.headers.get('set-cookie');assert.equal((await fetch(server.baseUrl+'/api/portal/brands',{headers:{Cookie:session}})).status,200);
  assert.equal((await post(`/api/access-requests/${saved.id}/approve`,{},true)).status,409);
});
test('expired token fails; declined request never creates an account',async()=>{
  const data=valid();await post('/api/access-request',data);const saved=await row(data.email);
  const {token,response}=await verify(saved,true);assert.equal(response.status,400);
  assert.equal((await post(`/api/access-requests/${saved.id}/reject`,{},true)).status,200);
  assert.equal((await row(data.email)).status,'declined');assert.equal((await buyers(data.email)).length,0);
  assert.equal((await post('/api/access-request/verify-email',{token})).status,400);
  assert.equal((await post(`/api/access-requests/${saved.id}/approve`,{},true)).status,409);
});
test('concurrent duplicate submissions and decisions have one winner',async()=>{
  const data=valid();const submitted=await Promise.all([post('/api/access-request',data),post('/api/access-request',data)]);assert.deepEqual(submitted.map(r=>r.status).sort(),[200,409]);
  const saved=await row(data.email);await verify(saved);
  const actions=await Promise.all([post(`/api/access-requests/${saved.id}/approve`,{},true),post(`/api/access-requests/${saved.id}/reject`,{},true)]);
  assert.deepEqual(actions.map(r=>r.status).sort(),[200,409]);
  const final=await row(data.email);assert.equal((await buyers(data.email)).length,final.status==='approved'?1:0);
});
test('admin list includes details and verification state but not token hash',async()=>{
  const r=await fetch(server.baseUrl+'/api/access-requests',{headers:{Cookie:cookie}});assert.equal(r.status,200);
  const rows=await r.json();assert.ok(rows.length);assert.ok('job_title' in rows[0]);assert.ok('email_verified_at' in rows[0]);assert.ok(!('verification_token_hash' in rows[0]));
});
test('old public invitation route cannot create automatic access',async()=>{
  const data=valid();const r=await post('/api/invite/any-token',{...data,password:'CorrectHorse42!'});assert.equal(r.status,409);assert.equal((await buyers(data.email)).length,0);
  const page=await fetch(server.baseUrl+'/rejoindre/any-token',{redirect:'manual'});assert.equal(page.headers.get('location'),'/demande-acces');
});
