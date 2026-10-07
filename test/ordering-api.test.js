const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startServer, withDb } = require('./helpers');
let server, cookie;
const buyer = 'minimum_buyer';
const brand = '1937b8b8-00d4-4c72-8d03-a83f492db00f';
before(async () => {
  server = await startServer({ dbNameSuffix: 'ordering', port: 3196 });
  await withDb(server.dbUrl, async db => {
    await db.query('INSERT INTO buyers(id,email,password_hash,name) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[buyer,'minimum@example.test',bcrypt.hashSync('StrongPassword123!',10),'Buyer']);
    await db.query("INSERT INTO brands(id,name,moq_amount,moq_strict,min_per_reference) VALUES ($1,'WODD',3500,false,3),('other-brand','Other',0,false,1) ON CONFLICT(id) DO UPDATE SET min_per_reference=EXCLUDED.min_per_reference",[brand]);
    await db.query("INSERT INTO products(id,brand_id,reference,price,sizes,color,variants) VALUES ('minimum-p',$1,'REF',248,'7\",16-18\"','Gold','[{\"color\":\"Silver\"}]'),('other-p','other-brand','OTHER',10,'','','[]') ON CONFLICT(id) DO NOTHING",[brand]);
    await db.query('DELETE FROM buyer_brand_terms WHERE buyer_id=$1',[buyer]);
  });
  const login = await fetch(server.baseUrl+'/editions-showroom-b2b-portail',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'email=minimum%40example.test&password=StrongPassword123!',redirect:'manual'});
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => server?.stop());
const line = quantity => ({ brand_id:brand,product_id:'minimum-p',quantity,size:'7"',variant_color:'Gold' });
async function checkout(lines) {
  const response=await fetch(server.baseUrl+'/api/portal/checkout',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({lines,client_name:'Buyer',buyer_signature:'signed',cgv_accepted:true})});
  return response.json();
}
test('direct API rejects 1/2 and accepts 3 below non-strict €3500 recommendation', async () => {
  for(const q of [1,2]) {
    const result = await checkout([line(q)]);
    assert.equal(result.ok,false);
    assert.match(JSON.stringify(result),/minimum 3/);
  }
  const result=await checkout([line(3)]);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.orders.length,1);
});
test('API resolves negotiated minima and splits multi-brand orders',async () => {
  for(const min of [1,2]) {
    await withDb(server.dbUrl,db=>db.query('INSERT INTO buyer_brand_terms(buyer_id,brand_id,min_per_reference_override) VALUES ($1,$2,$3) ON CONFLICT(buyer_id,brand_id) DO UPDATE SET min_per_reference_override=$3',[buyer,brand,min]));
    if(min===2) assert.equal((await checkout([line(1)])).ok,false);
    const result=await checkout([line(min),{brand_id:'other-brand',product_id:'other-p',quantity:1}]);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.orders.length,2);
  }
});
test('split colors and sizes aggregate by reference and persist separately',async () => {
  await withDb(server.dbUrl,db=>db.query('DELETE FROM buyer_brand_terms WHERE buyer_id=$1',[buyer]));
  const result=await checkout([line(2),{...line(1),variant_color:'Silver',size:'7"'}]);
  assert.equal(result.ok,true,JSON.stringify(result));
  const response=await fetch(server.baseUrl+'/api/portal/orders/'+result.orders[0].order_id+'/lines',{headers:{Cookie:cookie}});
  const lines=await response.json();
  assert.equal(lines.length,2);
  assert.deepEqual(new Set(lines.map(l=>l.variant_color)),new Set(['Gold','Silver']));
});
test('PO and confirmation persist; reorder exposes current prices and availability before adding',async()=>{
  const response=await fetch(server.baseUrl+'/api/portal/checkout',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({lines:[line(3)],client_name:'Buyer',buyer_signature:'signed',cgv_accepted:true,buyer_po_number:'PO-CURRENT-2026'})});
  const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));
  const order=result.orders[0];
  assert.match(order.order_number,/^ES-/);
  assert.equal(order.buyer_po_number,'PO-CURRENT-2026');
  assert.equal(order.reference_count,1);assert.equal(order.pieces,3);
  await withDb(server.dbUrl,db=>db.query("UPDATE products SET price=300 WHERE id='minimum-p'"));
  const reconcile=()=>fetch(server.baseUrl+'/api/portal/orders/'+order.order_id+'/reorder',{headers:{Cookie:cookie}}).then(r=>r.json());
  const current=await reconcile();assert.equal(Number(current.lines[0].price),300);assert.equal(current.summary.prices_updated,1);
  await withDb(server.dbUrl,db=>db.query("UPDATE products SET active=0 WHERE id='minimum-p'"));
  const unavailable=await reconcile();assert.equal(unavailable.lines.length,0);assert.equal(unavailable.summary.unavailable,1);
  await withDb(server.dbUrl,db=>db.query("UPDATE products SET price=248,active=1 WHERE id='minimum-p'"));
});
test('Quick Order shares current reference minimum, variant, price and availability checks',async()=>{
  const quick=rows=>fetch(server.baseUrl+'/api/portal/quick-order/reconcile',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({brand_id:brand,rows})}).then(r=>r.json());
  assert.equal((await quick([{reference:'REF',quantity:1,color:'Gold',size:'7"'}])).ok,false);
  const valid=await quick([{reference:'REF',quantity:2,color:'Gold',size:'7"'},{reference:'REF',quantity:1,color:'Silver',size:'7"'}]);
  assert.equal(valid.ok,true,JSON.stringify(valid));assert.equal(valid.lines.length,2);assert.equal(Number(valid.lines[0].price),248);
  assert.equal((await quick([{reference:'REF',quantity:3,color:'Bad color',size:'7"'}])).ok,false);
});
test('agent selection approval retains link, reference aggregate and proposed order workflow',async()=>{
  const token=require('node:crypto').randomBytes(24).toString('hex');
  await withDb(server.dbUrl,db=>db.query("INSERT INTO agent_selections(token,brand_id,client_name,client_email,items_json,expires_at) VALUES($1,$2,'Buyer','minimum@example.test',$3,NOW()+INTERVAL '1 hour')",[token,brand,JSON.stringify([{product_id:'minimum-p',quantity:0,size:'7"'}])]));
  const data=await fetch(server.baseUrl+'/api/selection/'+token).then(r=>r.json());assert.equal(data.brand.min_per_reference,3);
  const confirm=lines=>fetch(server.baseUrl+'/api/selection/'+token+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'StrongPassword123!',signature:'signed',cgv_accepted:true,lines,buyer_comment:'Deliver together',buyer_po_number:'SEL-PO'})}).then(r=>r.json());
  assert.match((await confirm([line(1)])).error,/minimum 3/);
  const result=await confirm([line(2),{...line(1),variant_color:'Silver'}]);assert.equal(result.ok,true,JSON.stringify(result));
  await withDb(server.dbUrl,async db=>{
    const row=(await db.query('SELECT workflow_stage,linked_order_id,buyer_comment FROM agent_selections WHERE token=$1',[token])).rows[0];
    assert.equal(row.workflow_stage,'buyer_approved');assert.equal(row.linked_order_id,result.order_id);assert.equal(row.buyer_comment,'Deliver together');
  });
});
