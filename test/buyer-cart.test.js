'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const {createHmac,randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {startServer,withDb}=require('./helpers');

const suffix=randomUUID().replaceAll('-','').slice(0,10);
const brandA='cart_a_'+suffix,brandB='cart_b_'+suffix;
const productA='cart_product_a_'+suffix,productB='cart_product_b_'+suffix;
let server,buyer,cookie;
const db=fn=>withDb(server.dbUrl,fn);
async function cookieFor(buyerId,extraBuyerPortal={}){
  const sid=randomUUID(),now=Date.now();
  const payload={cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},
    authAt:now,lastActive:now,buyerPortal:{id:buyerId,email:buyerId+'@test.invalid',name:'Synthetic cart buyer',company:'Synthetic shop',...extraBuyerPortal}};
  await db(c=>c.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify(payload)]));
  const signature=createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  return 'sid='+encodeURIComponent('s:'+sid+'.'+signature);
}
async function request(path,method='GET',body,session=cookie){
  const response=await fetch(server.baseUrl+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual'});
  const text=await response.text();
  let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,body:data};
}
async function snapshot(){
  const result=await request('/api/portal/cart-state');assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
}
function cartLine(brand=brandA,quantity=2){
  const product=brand===brandA?productA:productB;
  return {brand_id:brand,brand_name:brand===brandA?'Synthetic A':'Synthetic B',product_id:product,
    reference:brand===brandA?'CART-A':'CART-B',description:'Synthetic product',color:'Gold',size:'M',qty:quantity,price:12.5,note:''};
}
function cartOf(...lines){return Object.fromEntries(lines.map(line=>[JSON.stringify([line.brand_id,line.product_id,line.color,line.size]),line]));}
async function put(state,cart){return request('/api/portal/cart-state','PUT',{cart_id:state.cart_id,revision:state.revision,cart});}
async function save(cart,state){const result=await put(state||await snapshot(),cart);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}
function cycle(state,brand=brandA){
  return state.cycles.filter(item=>item.brand_id===brand).sort((a,b)=>Number(b.revision)-Number(a.revision))[0];
}
function checkoutBody(state,extra={}){
  return {request_key:randomUUID(),cart_id:state.cart_id,revision:state.revision,
    lines:Object.values(state.cart).map(line=>({brand_id:line.brand_id,product_id:line.product_id,quantity:line.qty,size:line.size,variant_color:line.color,note:line.note||''})),
    client_name:'Synthetic cart buyer',client_company:'Synthetic shop',client_country:'FR',buyer_signature:'synthetic-signature',cgv_accepted:true,...extra};
}
const checkout=body=>request('/api/portal/checkout-v2','POST',body);
const receipt=key=>request('/api/portal/checkout-v2/'+encodeURIComponent(key));
async function counts(){return db(async c=>({
  orders:Number((await c.query('SELECT COUNT(*) AS n FROM orders WHERE buyer_id=$1',[buyer])).rows[0].n),
  stock:Number((await c.query('SELECT stock_qty FROM products WHERE id=$1',[productA])).rows[0].stock_qty),
  stockB:Number((await c.query('SELECT stock_qty FROM products WHERE id=$1',[productB])).rows[0].stock_qty)
}));}
async function activity(){return db(async c=>(await c.query('SELECT last_meaningful_activity_at FROM buyers WHERE id=$1',[buyer])).rows[0].last_meaningful_activity_at);}
function assertComplete(result){assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.state,'complete',JSON.stringify(result.body));}

before(async()=>{
  server=await startServer({dbNameSuffix:'cart_'+suffix,port:3228});
  await db(async c=>{
    await c.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
    for(const [brand,name] of [[brandA,'Synthetic A'],[brandB,'Synthetic B']])await c.query("INSERT INTO brands(id,name,subscription_status,min_per_reference,moq_strict) VALUES($1,$2,'active',1,false)",[brand,name]);
    for(const [product,brand,ref] of [[productA,brandA,'CART-A'],[productB,brandB,'CART-B']])await c.query("INSERT INTO products(id,brand_id,reference,description,price,sizes,color,stock_enabled,stock_qty) VALUES($1,$2,$3,'Synthetic product',12.5,'M,L','Gold',true,100)",[product,brand,ref]);
  });
});
beforeEach(async()=>{
  buyer='cart_buyer_'+randomUUID().replaceAll('-','');
  await db(async c=>{
    await c.query("UPDATE brands SET subscription_status='active',early_access_until=NULL WHERE id=ANY($1)",[[brandA,brandB]]);
    await c.query("UPDATE products SET active=1,price=12.5,stock_qty=100,stock_enabled=true WHERE id=ANY($1)",[[productA,productB]]);
    await c.query("INSERT INTO buyers(id,email,password_hash,name,company,country,last_meaningful_activity_at) VALUES($1,$2,'not-a-password','Synthetic cart buyer','Synthetic shop','FR','2020-01-01')",[buyer,buyer+'@test.invalid']);
  });
  cookie=await cookieFor(buyer);
});
after(()=>server?.stop());

test('empty bootstrap and identical empty PUT do not manufacture a known cart or activity',async()=>{
  const before=await activity(),initial=await snapshot();
  assert.equal(typeof initial.cart_id,'string');assert.ok(Number.isSafeInteger(Number(initial.revision)));
  assert.deepEqual(initial.cart,{});assert.deepEqual(initial.cycles,[]);
  const same=await save({},initial);
  assert.equal(same.cart_id,initial.cart_id);assert.equal(same.revision,initial.revision);assert.deepEqual(same.cycles,[]);
  assert.equal(+(await activity()),+before);
});

test('historical cart remains unknown on read and identical PUT; a changed brand becomes observed',async()=>{
  const historic=cartOf(cartLine());
  await db(c=>c.query("INSERT INTO buyer_carts(buyer_id,cart_json,updated_at) VALUES($1,$2,'2020-01-01')",[buyer,JSON.stringify(historic)]));
  const before=await activity(),initial=await snapshot(),old=cycle(initial);
  assert.deepEqual(initial.cart,historic);assert.equal(old.state,'unknown');assert.equal(old.provenance,'legacy_unknown');
  const same=await save(historic,initial);
  assert.equal(same.revision,initial.revision);assert.equal(cycle(same).cycle_id,old.cycle_id);assert.equal(cycle(same).state,'unknown');
  assert.equal(+new Date(cycle(same).changed_at),+new Date(old.changed_at));assert.equal(+(await activity()),+before);
  const changed=await save(cartOf(cartLine(brandA,3)),same);
  assert.equal(cycle(changed).state,'open');assert.equal(cycle(changed).provenance,'versioned');
  assert.ok(+(await activity())>+before);
});

test('real versioned mutation opens a cycle; no-op sync preserves revision, clock and activity',async()=>{
  const saved=await save(cartOf(cartLine(),cartLine(brandB,3))),observed=await activity();
  assert.equal(cycle(saved).state,'open');assert.equal(cycle(saved).provenance,'versioned');assert.ok(cycle(saved).content_hash);
  const reordered=Object.fromEntries(Object.entries(saved.cart).reverse());
  const same=await save(reordered,saved);
  assert.equal(same.revision,saved.revision);assert.equal(cycle(same).cycle_id,cycle(saved).cycle_id);
  for(const brand of [brandA,brandB]){
    assert.equal(cycle(same,brand).revision,cycle(saved,brand).revision);
    assert.equal(+new Date(cycle(same,brand).changed_at),+new Date(cycle(saved,brand).changed_at));
  }
  assert.equal(+(await activity()),+observed);
});

test('stale device cannot overwrite another device and explicit rebasing keeps both brands',async()=>{
  const deviceA=await snapshot(),deviceB=JSON.parse(JSON.stringify(deviceA));
  const savedA=await save(cartOf(cartLine()),deviceA);
  const stale=await put(deviceB,cartOf(cartLine(brandB,3)));
  assert.equal(stale.status,409,JSON.stringify(stale.body));
  assert.deepEqual((await snapshot()).cart,savedA.cart);
  const rebased=await save(cartOf(cartLine(),cartLine(brandB,3)),await snapshot());
  assert.equal(Object.values(rebased.cart).length,2);assert.equal(cycle(rebased,brandA).state,'open');assert.equal(cycle(rebased,brandB).state,'open');
});

test('checkout receipt survives a discarded POST response and replays before catalogue or stock validation',async()=>{
  const saved=await save(cartOf(cartLine())),body=checkoutBody(saved);
  // The caller deliberately discards the creation response, then resolves the
  // uncertain result using only its durable request key.
  await checkout(body);
  const found=await receipt(body.request_key);assertComplete(found);assert.equal(found.body.ok,true);
  assert.equal(found.body.orders.length,1);const orderId=found.body.orders[0].order_id;assert.ok(orderId);
  assert.equal(Number(found.body.orders[0].total),25);assert.deepEqual(found.body.cart.cart,{});
  const converted=cycle(found.body.cart);assert.equal(converted.state,'converted');assert.equal(converted.converted_order_id,orderId);
  assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
  await db(c=>c.query('UPDATE products SET active=0,price=999,stock_qty=0 WHERE id=$1',[productA]));
  const replay=await checkout(body);assertComplete(replay);assert.equal(replay.body.orders[0].order_id,orderId);
  assert.equal(Number(replay.body.orders[0].total),25);assert.deepEqual(await counts(),{orders:1,stock:0,stockB:100});
});

test('immutable request key rejects changed content without creating another order',async()=>{
  const body=checkoutBody(await save(cartOf(cartLine()))),created=await checkout(body);assertComplete(created);
  const changed=await checkout({...body,client_name:'A different client'});
  assert.equal(changed.status,409,JSON.stringify(changed.body));assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
});

test('pending checkout binds session fallbacks but completed receipts replay after the session context changes',async()=>{
  const saved=await save(cartOf(cartLine())),body=checkoutBody(saved),pool=new Pool({connectionString:server.dbUrl});
  assert.equal(Object.hasOwn(body,'client_phone'),false);
  try{
    await require('../lib/buyer-cart').createBuyerCartService(pool).reserveCheckout(buyer,body,{
      client_email:buyer+'@test.invalid',client_company:'Synthetic shop',client_phone:''
    });
  }finally{await pool.end();}
  const pending=await receipt(body.request_key);assert.equal(pending.status,200);assert.equal(pending.body.state,'pending');
  const changedCookie=await cookieFor(buyer,{phone:'+33123456789'});
  const changed=await request('/api/portal/checkout-v2','POST',body,changedCookie);
  assert.equal(changed.status,409,JSON.stringify(changed.body));assert.equal(changed.body.code,'checkout_context_changed');
  assert.deepEqual(await counts(),{orders:0,stock:100,stockB:100});
  const created=await checkout(body);assertComplete(created);assert.equal(created.body.ok,true);
  const replay=await request('/api/portal/checkout-v2','POST',body,changedCookie);assertComplete(replay);
  assert.equal(replay.body.orders[0].order_id,created.body.orders[0].order_id);assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
});

test('partial checkout converts A, preserves B, and replays the original refusal even after B is reactivated',async()=>{
  const saved=await save(cartOf(cartLine(),cartLine(brandB,3))),body=checkoutBody(saved);
  await db(c=>c.query("UPDATE brands SET subscription_status='inactive' WHERE id=$1",[brandB]));
  const result=await checkout(body);assertComplete(result);assert.equal(result.body.ok,false);assert.equal(result.body.orders.length,2);
  const a=result.body.orders.find(order=>order.brand_id===brandA),b=result.body.orders.find(order=>order.brand_id===brandB);
  assert.ok(a.order_id);assert.ok(b.error);assert.equal(cycle(result.body.cart,brandA).state,'converted');
  assert.equal(cycle(result.body.cart,brandB).state,'open');assert.deepEqual(Object.values(result.body.cart.cart).map(line=>line.brand_id),[brandB]);
  await db(c=>c.query("UPDATE brands SET subscription_status='active' WHERE id=$1",[brandB]));
  const replay=await checkout(body);assertComplete(replay);assert.equal(replay.body.orders.find(order=>order.brand_id===brandA).order_id,a.order_id);
  assert.ok(replay.body.orders.find(order=>order.brand_id===brandB).error);assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
  const retry=await checkout(checkoutBody(await snapshot()));assertComplete(retry);assert.equal(retry.body.ok,true);
  assert.equal(retry.body.orders.length,1);assert.equal(retry.body.orders[0].brand_id,brandB);
  assert.deepEqual(await counts(),{orders:2,stock:98,stockB:97});
});

test('two request keys racing for one cart cycle cannot create two orders',async()=>{
  const state=await save(cartOf(cartLine()));
  const results=await Promise.all([checkout(checkoutBody(state)),checkout(checkoutBody(state))]);
  assert.ok(results.some(result=>result.status===200&&result.body.orders?.some(order=>order.order_id)),JSON.stringify(results));
  assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
  const orderIds=results.flatMap(result=>Array.isArray(result.body.orders)?result.body.orders.filter(order=>order.order_id).map(order=>order.order_id):[]);
  assert.equal(new Set(orderIds).size,1);
});

test('new cycle with identical lines creates a deliberate new order within the old twenty-second dedup window',async()=>{
  const firstState=await save(cartOf(cartLine())),first=await checkout(checkoutBody(firstState));assertComplete(first);
  const secondState=await save(cartOf(cartLine()),await snapshot());
  assert.notEqual(cycle(secondState).cycle_id,cycle(firstState).cycle_id);assert.equal(cycle(secondState).state,'open');
  const second=await checkout(checkoutBody(secondState));assertComplete(second);assert.equal(second.body.ok,true);
  assert.notEqual(second.body.orders[0].order_id,first.body.orders[0].order_id);assert.deepEqual(await counts(),{orders:2,stock:96,stockB:100});
});

test('legacy cart POST still works but invalidates known provenance even for an identical snapshot',async()=>{
  const saved=await save(cartOf(cartLine())),before=await activity();
  const legacy=await request('/api/portal/cart','POST',{cart:saved.cart});assert.equal(legacy.status,200);assert.equal(legacy.body.ok,true);
  const readLegacy=await request('/api/portal/cart');assert.equal(readLegacy.status,200);assert.deepEqual(readLegacy.body,saved.cart);
  const current=await snapshot();assert.equal(cycle(current).state,'unknown');assert.equal(cycle(current).provenance,'legacy_unknown');
  assert.equal(+(await activity()),+before);
  const stale=await put(saved,cartOf(cartLine(brandA,4)));assert.equal(stale.status,409);
});

test('legacy checkout keeps its response contract but makes cart conversion provenance unknown',async()=>{
  const saved=await save(cartOf(cartLine())),body=checkoutBody(saved);
  const result=await request('/api/portal/checkout','POST',body);
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.ok,true);assert.equal(result.body.orders.length,1);
  const current=await snapshot();assert.equal(cycle(current).state,'unknown');assert.equal(cycle(current).provenance,'legacy_unknown');
  assert.deepEqual(current.cart,saved.cart);assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
});

test('cart and receipts are buyer scoped and reject unauthenticated access',async()=>{
  const saved=await save(cartOf(cartLine())),body=checkoutBody(saved);assertComplete(await checkout(body));
  const other='cart_other_'+randomUUID().replaceAll('-','');
  await db(c=>c.query("INSERT INTO buyers(id,email,password_hash,name) VALUES($1,$2,'not-a-password','Other synthetic buyer')",[other,other+'@test.invalid']));
  const otherCookie=await cookieFor(other);
  const hidden=await request('/api/portal/checkout-v2/'+body.request_key,'GET',undefined,otherCookie);assert.equal(hidden.status,404);
  const foreign=await request('/api/portal/cart-state','PUT',{cart_id:saved.cart_id,revision:saved.revision,cart:cartOf(cartLine())},otherCookie);
  assert.ok([400,403,404,409].includes(foreign.status),JSON.stringify(foreign));
  for(const path of ['/api/portal/cart-state','/api/portal/checkout-v2/'+body.request_key]){
    const result=await request(path,'GET',undefined,null);assert.equal(result.status,401);
  }
  assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
});

test('invalid buyer context produces stable per-brand refusals without converting the cart',async()=>{
  const saved=await save(cartOf(cartLine()));
  for(const invalid of [{client_country:'Other'},{client_name:''},{buyer_signature:''},{cgv_accepted:false}]){
    const body=checkoutBody(saved,invalid),result=await checkout(body);assertComplete(result);assert.equal(result.body.ok,false);
    assert.equal(result.body.orders.length,1);assert.ok(result.body.orders[0].error);
    assert.equal(cycle((await snapshot())).state,'open');assert.deepEqual(await counts(),{orders:0,stock:100,stockB:100});
    const repeated=await checkout(body);assertComplete(repeated);assert.deepEqual(repeated.body.orders,result.body.orders);
  }
  const valid=await checkout(checkoutBody(saved));assertComplete(valid);assert.equal(valid.body.ok,true);
});

test('GDPR export includes cart protocol history and database buyer deletion cascades every protocol table',async()=>{
  const saved=await save(cartOf(cartLine())),body=checkoutBody(saved),created=await checkout(body);assertComplete(created);
  const exported=await request('/api/portal/gdpr/export');assert.equal(exported.status,200,JSON.stringify(exported.body));
  assert.ok(exported.body.cart_protocol&&typeof exported.body.cart_protocol==='object');
  const protocol=JSON.stringify(exported.body.cart_protocol);
  for(const value of [saved.cart_id,cycle(saved).cycle_id,body.request_key,created.body.orders[0].order_id])assert.ok(protocol.includes(value),value+' missing from protocol export');
  const tables=['buyer_cart_states','buyer_cart_cycles','buyer_cart_checkouts','buyer_cart_checkout_results'];
  await db(async c=>{
    for(const table of tables)assert.ok(Number((await c.query(`SELECT COUNT(*) AS n FROM ${table} WHERE buyer_id=$1`,[buyer])).rows[0].n)>0,table+' not exercised');
    await c.query('DELETE FROM buyers WHERE id=$1',[buyer]);
    for(const table of tables)assert.equal(Number((await c.query(`SELECT COUNT(*) AS n FROM ${table} WHERE buyer_id=$1`,[buyer])).rows[0].n),0,table+' not cascaded');
  });
});

test('checkout cannot substitute quantities or notes that differ from the saved cart revision',async()=>{
  const saved=await save(cartOf(cartLine()));
  for(const change of [{quantity:3},{note:'Not the saved note'}]){
    const body=checkoutBody(saved);body.lines[0]={...body.lines[0],...change};
    const result=await checkout(body);assert.ok([400,409].includes(result.status),JSON.stringify(result));
    assert.deepEqual(await counts(),{orders:0,stock:100,stockB:100});
    const current=await snapshot();assert.equal(current.revision,saved.revision);assert.deepEqual(current.cart,saved.cart);
  }
});

test('malformed versioned snapshots are rejected without altering the existing cart',async()=>{
  const saved=await save(cartOf(cartLine()));
  const malformed=[null,[],42,...[0,-1,1.5,'2'].map(qty=>cartOf({...cartLine(),qty})),
    Object.fromEntries(Array.from({length:501},(_,i)=>['line_'+i,cartLine()]))];
  for(const cart of malformed){
    const result=await put(saved,cart);assert.equal(result.status,400,JSON.stringify(result));
    const current=await snapshot();assert.equal(current.revision,saved.revision);assert.deepEqual(current.cart,saved.cart);
  }
});

test('expiration clears payloads older than ninety days while retaining conversion tombstones and receipts',async()=>{
  const saved=await save(cartOf(cartLine(),cartLine(brandB,3))),body=checkoutBody(saved);
  await db(c=>c.query("UPDATE brands SET subscription_status='inactive' WHERE id=$1",[brandB]));
  const created=await checkout(body);assertComplete(created);const committed=created.body.orders.find(order=>order.brand_id===brandA);
  assert.ok(committed.order_id);const before=await snapshot();
  await db(async c=>{
    await c.query("UPDATE buyer_cart_states SET updated_at=NOW()-INTERVAL '91 days' WHERE buyer_id=$1",[buyer]);
    await c.query("UPDATE buyer_carts SET updated_at=NOW()-INTERVAL '91 days' WHERE buyer_id=$1",[buyer]);
  });
  const pool=new Pool({connectionString:server.dbUrl});
  try{await require('../lib/buyer-cart').createBuyerCartService(pool).expireCarts();}finally{await pool.end();}
  const expired=await snapshot();assert.equal(expired.cart_id,before.cart_id);assert.ok(Number(expired.revision)>Number(before.revision));assert.deepEqual(expired.cart,{});
  assert.equal(cycle(expired,brandA).state,'converted');assert.equal(cycle(expired,brandA).converted_order_id,committed.order_id);
  assert.equal(cycle(expired,brandB).provenance,'expired');assert.ok(['empty','unknown'].includes(cycle(expired,brandB).state));
  assert.deepEqual((await request('/api/portal/cart')).body,{});
  const found=await receipt(body.request_key);assertComplete(found);assert.equal(found.body.orders.find(order=>order.brand_id===brandA).order_id,committed.order_id);
  assert.deepEqual(await counts(),{orders:1,stock:98,stockB:100});
});

test('repeated additive migration preserves cart identity, revisions, cycles and durable receipts',async()=>{
  const saved=await save(cartOf(cartLine())),body=checkoutBody(saved);assertComplete(await checkout(body));
  const before=await snapshot(),receiptBefore=await receipt(body.request_key),pool=new Pool({connectionString:server.dbUrl});
  try{
    const {migrateBuyerCart}=require('../lib/buyer-cart-migration');
    await migrateBuyerCart(pool);await migrateBuyerCart(pool);
  }finally{await pool.end();}
  assert.deepEqual(await snapshot(),before);assert.deepEqual((await receipt(body.request_key)).body.orders,receiptBefore.body.orders);
});

test('receipt write failure rolls back order, stock, cart conversion and meaningful activity together',async()=>{
  const saved=await save(cartOf(cartLine())),before=await activity();
  await db(async c=>{
    await c.query("CREATE FUNCTION cart_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END; $$");
    await c.query('CREATE TRIGGER cart_test_fail_receipt BEFORE INSERT ON buyer_cart_checkout_results FOR EACH ROW EXECUTE FUNCTION cart_test_fail_receipt()');
  });
  try{
    const failed=await checkout(checkoutBody(saved));
    assert.ok(failed.status>=400||failed.body.ok!==true,JSON.stringify(failed));
    assert.deepEqual(await counts(),{orders:0,stock:100,stockB:100});
    const after=await snapshot();assert.equal(after.revision,saved.revision);assert.deepEqual(after.cart,saved.cart);
    assert.equal(cycle(after).state,'open');assert.equal(cycle(after).converted_order_id,null);
    assert.equal(+new Date(cycle(after).changed_at),+new Date(cycle(saved).changed_at));
    assert.equal(+(await activity()),+before);
  }finally{
    await db(async c=>{
      await c.query('DROP TRIGGER IF EXISTS cart_test_fail_receipt ON buyer_cart_checkout_results');
      await c.query('DROP FUNCTION IF EXISTS cart_test_fail_receipt()');
    });
  }
});

test('closing an unreserved uncertain key fences a delayed creation request',async()=>{
  const saved=await save(cartOf(cartLine())),body=checkoutBody(saved);
  const closed=await request('/api/portal/checkout-v2/'+body.request_key+'/cancel','POST',{brands:[brandA]});
  assertComplete(closed);assert.equal(closed.body.orders[0].code,'checkout_cancelled');
  const delayed=await checkout(body);assert.equal(delayed.status,409);
  assert.deepEqual(await counts(),{orders:0,stock:100,stockB:100});assert.deepEqual((await snapshot()).cart,saved.cart);
});
test('closing a reserved attempt preserves existing results and prevents missing brands from creating orders',async()=>{
  const saved=await save(cartOf(cartLine(),cartLine(brandB,3))),body=checkoutBody(saved),pool=new Pool({connectionString:server.dbUrl});
  try{await require('../lib/buyer-cart').createBuyerCartService(pool).reserveCheckout(buyer,body,{client_email:buyer+'@test.invalid',client_company:'Synthetic shop',client_phone:''});}finally{await pool.end();}
  const closed=await request('/api/portal/checkout-v2/'+body.request_key+'/cancel','POST',{brands:[brandA,brandB]});assertComplete(closed);
  const replay=await checkout(body);assertComplete(replay);assert.equal(replay.body.ok,false);assert.equal(replay.body.orders.length,2);
  assert.deepEqual(await counts(),{orders:0,stock:100,stockB:100});
  const retry=await checkout(checkoutBody(await snapshot()));assertComplete(retry);assert.equal(retry.body.ok,true);
  const closeAgain=await request('/api/portal/checkout-v2/'+retry.body.request_key+'/cancel','POST',{brands:[brandA,brandB]});
  assertComplete(closeAgain);assert.equal(closeAgain.body.ok,true);assert.deepEqual(closeAgain.body.orders,retry.body.orders);
});
