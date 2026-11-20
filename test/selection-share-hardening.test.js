'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { startServer, withDb, id } = require('./helpers');

let server, brandId, otherBrand, productId, buyerId, buyerEmail, token;
before(async () => {
  server = await startServer({ dbNameSuffix: 'share_selection_security', port: 3254 });
  brandId = id('brand'); otherBrand = id('otherbrand'); productId = id('prod');
  buyerId = id('buyer'); buyerEmail = id('email') + '@example.test'; token = id('selection');
  await withDb(server.dbUrl, async db => {
    await db.query("INSERT INTO brands(id,name,subscription_status) VALUES($1,'Genuine Brand','active'),($2,'Other Brand','active')", [brandId,otherBrand]);
    await db.query("INSERT INTO products(id,brand_id,reference,description,color,price,active) VALUES ($1,$2,'REAL-001','Real product','Black',125,1)", [productId,brandId]);
    await db.query("INSERT INTO buyers(id,email,password_hash,name,company) VALUES($1,$2,'no-login','Test Buyer','Test Store')", [buyerId,buyerEmail]);
    await db.query("INSERT INTO agent_selections(token,brand_id,client_name,client_email,client_company,items_json,expires_at,status) VALUES($1,$2,'Test Buyer',$3,'Test Store',$4,NOW()+INTERVAL '1 day','sent')", [token,brandId,buyerEmail,JSON.stringify([{product_id:productId,quantity:1,size:'M'}])]);
    await db.query('CREATE TABLE IF NOT EXISTS user_sessions (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp NOT NULL)');
    const sid=id('session');
    const now=Date.now();
    const sess={cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},buyerPortal:{id:buyerId,email:buyerEmail,name:'Test Buyer',company:'Test Store',country:'FR'},authAt:now,lastActive:now};
    await db.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify(sess)]);
    const signature=createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
    globalThis.buyerCookie='sid='+encodeURIComponent('s:'+sid+'.'+signature);
  });
});
after(() => server?.stop());
async function json(path, method='GET', body, cookie) {
  const r=await fetch(server.baseUrl+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,body:await r.json().catch(()=>({})),headers:r.headers};
}
test('selection PDF refuses expired, approved and draft bearer links',async()=>{
  for (const [sql,status] of [
    ["UPDATE agent_selections SET expires_at=NOW()-INTERVAL '1 minute',used=false,status='sent' WHERE token=$1",410],
    ["UPDATE agent_selections SET expires_at=NOW()+INTERVAL '1 day',used=true,status='sent' WHERE token=$1",410],
    ["UPDATE agent_selections SET expires_at=NOW()+INTERVAL '1 day',used=false,status='draft' WHERE token=$1",404]
  ]) {
    await withDb(server.dbUrl,db=>db.query(sql,[token]));
    const r=await fetch(server.baseUrl+'/api/selection/'+token+'/pdf');
    assert.equal(r.status,status,sql);
    assert.match(r.headers.get('cache-control')||'',/no-store/);
  }
  await withDb(server.dbUrl,db=>db.query("UPDATE agent_selections SET status='sent',used=false WHERE token=$1",[token]));
});
test('selection PDF and page suppress bearer token referrers and caching',async()=>{
  const r=await fetch(server.baseUrl+'/selection/'+token);
  assert.equal(r.status,200);
  assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  assert.match(r.headers.get('cache-control')||'',/no-store/);
  const data=await fetch(server.baseUrl+'/api/selection/'+token);
  assert.match(data.headers.get('cache-control')||'',/no-store/);
});
test('selection save rejects absurd quantities and broad arrays',async()=>{
  const path='/api/selection/'+token+'/save';
  assert.equal((await json(path,'POST',{lines:[{product_id:productId,size:'M',quantity:10000000000}]})).status,400);
  assert.equal((await json(path,'POST',{lines:Array.from({length:501},()=>({product_id:productId,quantity:1}))})).status,400);
});
test('buyer share uses authoritative wholesale price, brand and reference',async()=>{
  const valid={brand_id:brandId,product_id:productId,brand_name:'FAKE BRAND',reference:'FAKE REF',description:'FAKE',color:'Black',size:'M',qty:2,price:0.01};
  const r=await json('/api/portal/share','POST',{items:[valid]},globalThis.buyerCookie);
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.match(r.body.token,/^[a-f0-9]{48}$/);
  const db=await withDb(server.dbUrl,db=>db.query('SELECT items_json FROM selection_shares WHERE token=$1',[r.body.token]));
  const stored=JSON.parse(db.rows[0].items_json)[0];
  assert.equal(stored.price,125);
  assert.equal(stored.brand_name,'Genuine Brand');
  assert.equal(stored.reference,'REAL-001');
  const page=await fetch(server.baseUrl+'/share/'+r.body.token);
  assert.equal(page.status,200);
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.match(page.headers.get('cache-control')||'',/no-store/);
  const html=await page.text();
  assert.match(html,/250\.00/);
  assert.doesNotMatch(html,/FAKE BRAND|FAKE REF|0\.01/);
});
test('buyer cannot forge cross-brand product or arbitrary line totals',async()=>{
  const base={brand_id:brandId,product_id:productId,color:'Black',size:'M',qty:1};
  assert.equal((await json('/api/portal/share','POST',{items:[{...base,brand_id:otherBrand}]},globalThis.buyerCookie)).status,403);
  assert.equal((await json('/api/portal/share','POST',{items:[{...base,qty:99999999999}]},globalThis.buyerCookie)).status,400);
  assert.equal((await json('/api/portal/share','POST',{items:Array(201).fill(base)},globalThis.buyerCookie)).status,400);
});
