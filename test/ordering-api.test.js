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
