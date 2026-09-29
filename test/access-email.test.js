const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startServer,withDb,id} = require('./helpers');
let server;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'showroom-mail-test-'));
const mailFile=path.join(dir,'mail.jsonl');
const data=(email)=>({name:'Test Mail',company:'Test Store',job_title:'Buyer',country:'France',city:'Paris',email,business_type:'Retailer',instagram:'@test_store',privacy_accepted:true});
async function post(route,body){return fetch(server.baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
before(async()=>{
  server=await startServer({dbNameSuffix:'access_email',port:3105,env:{RESEND_API_KEY:'re_test_only',AIRTABLE_API_KEY:'',NODE_OPTIONS:'--require '+path.join(__dirname,'fixtures/resend-stub.cjs'),TEST_MAIL_FILE:mailFile}});
});
after(()=>{server?.stop();fs.rmSync(dir,{recursive:true,force:true});});
test('email contains a usable token; DB stores only its hash; confirmation is still PENDING',async()=>{
  const email=id('mail')+'@example.com'; const response=await post('/api/access-request',data(email));assert.equal(response.status,200);assert.equal((await response.json()).verification_sent,true);
  const mail=fs.readFileSync(mailFile,'utf8').trim().split('\n').map(JSON.parse).find(m=>m.to.includes(email));assert.ok(mail);
  const token=mail.html.match(/#verify=([a-f0-9]{64})/)[1];
  const row=await withDb(server.dbUrl,async c=>(await c.query('SELECT * FROM access_requests WHERE email=$1',[email])).rows[0]);assert.notEqual(row.verification_token_hash,token);assert.equal(row.status,'pending');
  assert.equal((await post('/api/access-request/verify-email',{token})).status,200);
  const state=await withDb(server.dbUrl,async c=>(await c.query('SELECT status,email_verified_at FROM access_requests WHERE email=$1',[email])).rows[0]);assert.equal(state.status,'pending');assert.ok(state.email_verified_at);
  assert.equal((await fetch(server.baseUrl+'/api/portal/brands')).status,401);
});
test('provider error is reported truthfully and never grants access',async()=>{
  const email='fail-mail-'+id('mail')+'@example.com';const response=await post('/api/access-request',data(email));assert.equal(response.status,200);assert.equal((await response.json()).verification_sent,false);
  const row=await withDb(server.dbUrl,async c=>(await c.query('SELECT * FROM access_requests WHERE email=$1',[email])).rows[0]);assert.equal(row.status,'pending');assert.equal(row.email_verified_at,null);
});
