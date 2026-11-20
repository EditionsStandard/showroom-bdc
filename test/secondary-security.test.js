'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { startServer, withDb, id } = require('./helpers');

let server, brandId, productId, buyerId, email, expiredToken, usedToken, activeToken, newToken;
before(async () => {
  server = await startServer({ dbNameSuffix: 'secondary_security', port: 3232 });
  brandId=id('brand'); productId=id('product'); buyerId=id('buyer');
  email=id('buyer')+'@example.invalid';
  expiredToken=id('expired'); usedToken=id('used'); activeToken=id('active'); newToken=id('newbuyer');
  await withDb(server.dbUrl, async db => {
    await db.query("INSERT INTO brands(id,name,subscription_status) VALUES($1,'Security Brand','active')",[brandId]);
    await db.query("INSERT INTO products(id,brand_id,reference,price,active,sizes) VALUES($1,$2,'SKU-SEC',120,1,'S,M')",[productId,brandId]);
    await db.query("INSERT INTO buyers(id,email,password_hash,name,country,activation_pending) VALUES($1,$2,'test-hash','Security Buyer','FR',false)",[buyerId,email]);
    await db.query("CREATE TABLE IF NOT EXISTS user_sessions (sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)");
    const data=JSON.stringify([{product_id:productId,size:'S',variant_color:'blue',quantity:1}]);
    for(const [token,condition,used,recipient] of [
      [expiredToken,"NOW()-INTERVAL '1 day'",false,email],
      [usedToken,"NOW()+INTERVAL '1 day'",true,email],
      [activeToken,"NOW()+INTERVAL '1 day'",false,email],
      [newToken,"NOW()+INTERVAL '1 day'",false,id('new')+'@example.invalid']
    ]) await db.query(
      "INSERT INTO agent_selections(token,brand_id,client_email,client_name,items_json,expires_at,used) VALUES($1,$2,$3,'Security Customer',$4,"+condition+",$5)",
      [token,brandId,recipient,data,used]);
  });
});
after(() => server?.stop());

async function buyerCookie() {
  const sid=id('sid'), now=Date.now();
  const sess={cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},buyerPortal:{id:buyerId,email,name:'Security Buyer',company:'',country:'FR'},authAt:now,lastActive:now};
  await withDb(server.dbUrl,db=>db.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify(sess)]));
  const sig=createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  return 'sid='+encodeURIComponent('s:'+sid+'.'+sig);
}
async function post(url,payload,cookie) {
  const r=await fetch(server.baseUrl+url,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(payload)});
  return {status:r.status,body:await r.json()};
}

test('expired and confirmed selections cannot leak private PDFs by bearer link',async()=>{
  for(const token of [expiredToken,usedToken]) {
    const r=await fetch(server.baseUrl+'/api/selection/'+token+'/pdf');
    assert.equal(r.status,410,token);
    assert.match(r.headers.get('content-type')||'',/json/);
  }
});

test('early-access brand restrictions also apply to bearer PDF export',async()=>{
  await withDb(server.dbUrl,db=>db.query("UPDATE brands SET early_access_until=NOW()+INTERVAL '7 days' WHERE id=$1",[brandId]));
  try {
    const r=await fetch(server.baseUrl+'/api/selection/'+activeToken+'/pdf');
    assert.equal(r.status,403);
  } finally {
    await withDb(server.dbUrl,db=>db.query('UPDATE brands SET early_access_until=NULL WHERE id=$1',[brandId]));
  }
});

test('without outbound mail a selection link cannot create a verified buyer or sign an order',async()=>{
  const r=await post('/api/selection/'+newToken+'/confirm',{password:'AttackerPassword123!',signature:'signed',cgv_accepted:true,lines:[{product_id:productId,size:'S',quantity:1}]});
  assert.equal(r.status,503);
  assert.equal(r.body.code,'activation_unavailable');
  await withDb(server.dbUrl,async db=>{
    const buyer=await db.query('SELECT id FROM buyers WHERE email=(SELECT client_email FROM agent_selections WHERE token=$1)',[newToken]);
    assert.equal(buyer.rowCount,0);
    const order=await db.query('SELECT id FROM orders WHERE client_email=(SELECT client_email FROM agent_selections WHERE token=$1)',[newToken]);
    assert.equal(order.rowCount,0);
    const sel=await db.query('SELECT used FROM agent_selections WHERE token=$1',[newToken]);
    assert.equal(sel.rows[0].used,false);
  });
});

test('shared proposal uses canonical server prices and escapes user-written text',async()=>{
  const cookie=await buyerCookie();
  const malicious='<img src=x onerror=alert(42)>';
  const input={items:[{brand_id:brandId,product_id:productId,reference:'FORGED',brand_name:'FAKE',color:malicious,size:'S',qty:2,price:0}]};
  const result=await post('/api/portal/share',input,cookie);
  assert.equal(result.status,200,JSON.stringify(result.body));
  const r=await fetch(server.baseUrl+'/share/'+result.body.token);
  assert.equal(r.status,200);
  assert.match(r.headers.get('cache-control')||'',/no-store/);
  const html=await r.text();
  assert.match(html,/SKU-SEC/);
  assert.match(html,/240\\.00/);
  assert.ok(!html.includes('<img src=x onerror=alert(42)>'),'user HTML must be escaped');
  assert.ok(!html.includes('FORGED'),'product reference must be resolved by server');
  assert.ok(!html.includes('FAKE'),'brand name must be resolved by server');
});

test('shared proposal rejects fake products, cross-brand IDs, and excessive quantities',async()=>{
  const cookie=await buyerCookie();
  const item={brand_id:brandId,product_id:productId,color:'',size:'M',qty:1,price:0};
  assert.equal((await post('/api/portal/share',{items:[{...item,product_id:id('invented')}]},cookie)).status,400);
  assert.equal((await post('/api/portal/share',{items:[{...item,brand_id:id('wrong')}]},cookie)).status,400);
  assert.equal((await post('/api/portal/share',{items:[{...item,qty:100001}]},cookie)).status,400);
});

test('selection save and confirm reject oversized quantities without changing stored choices',async()=>{
  const payload={lines:[{product_id:productId,size:'S',quantity:100001}]};
  const r=await post('/api/selection/'+activeToken+'/save',payload);
  assert.equal(r.status,400);
  const confirmation=await post('/api/selection/'+activeToken+'/confirm',{...payload,password:'whatever',signature:'signed',cgv_accepted:true});
  assert.equal(confirmation.status,400);
  await withDb(server.dbUrl,async db=>{
    const row=(await db.query('SELECT used,items_json FROM agent_selections WHERE token=$1',[activeToken])).rows[0];
    assert.equal(row.used,false);
    assert.equal(JSON.parse(row.items_json)[0].quantity,1);
  });
});
