const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {startServer,withDb,id}=require('./helpers');
let server,cookie;
before(async()=>{
  server=await startServer({dbNameSuffix:'activation',port:3197});
  const {authenticator}=require('otplib');
  const secret=authenticator.generateSecret();
  await withDb(server.dbUrl,async db=>{
    await db.query("INSERT INTO settings(key,value) VALUES('owner_mfa_enabled','on'),('owner_mfa_secret',$1),('owner_mfa_last_step','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[secret]);
  });
  const login=await fetch(server.baseUrl+'/admin/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password=TestAdmin123!',redirect:'manual'});
  cookie=login.headers.get('set-cookie').split(';')[0];
  const mfa=await fetch(server.baseUrl+'/admin/login/mfa',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie},body:'code='+authenticator.generate(secret),redirect:'manual'});
  assert.equal(mfa.headers.get('location'),'/admin','owner MFA must complete');
  cookie=mfa.headers.get('set-cookie')?.split(';')[0] || cookie;
});
after(()=>server?.stop());
test('approval uses a hashed single-use activation token and no emailed password',async()=>{
  const request=id('access'),email=request+'@test.invalid';
  await withDb(server.dbUrl,db=>db.query('INSERT INTO access_requests(id,name,email) VALUES($1,$2,$3)',[request,'Buyer',email]));
  const response=await fetch(server.baseUrl+'/api/access-requests/'+request+'/approve',{method:'POST',headers:{Cookie:cookie}});
  const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.temp_password,undefined);
  const token=new URL(result.activation_url).searchParams.get('token');
  assert.equal(token.length,64);
  await withDb(server.dbUrl,async db=>{
    const row=(await db.query('SELECT b.activation_pending,r.token,r.expires_at FROM buyers b JOIN buyer_password_resets r ON r.buyer_id=b.id WHERE b.email=$1',[email])).rows[0];
    assert.equal(row.activation_pending,true);
    assert.equal(row.token,crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(row.expires_at.getTime()-Date.now()<=3600000);
  });
  const reset=()=>fetch(server.baseUrl+'/api/portal/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:'ChosenSecurePassword12!'})}).then(r=>r.json());
  const concurrent=await Promise.all([reset(),reset()]);
  assert.equal(concurrent.filter(r=>r.ok).length,1,'token must be single use under concurrent requests');
  assert.ok((await reset()).error);
  await withDb(server.dbUrl,async db=>assert.equal((await db.query('SELECT activation_pending FROM buyers WHERE email=$1',[email])).rows[0].activation_pending,false));
});
