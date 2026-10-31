'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {createHmac,randomUUID}=require('node:crypto');
const {startServer,withDb}=require('./helpers');
const {migrateAdminCommercial}=require('../lib/admin-commercial-migration');
const {normalizeGrants,contains}=require('../lib/agent-scopes');
const {validateCommission}=require('../lib/wholesale-commissions');
let server,owner,agent,sub,other,noGrants;
const key=randomUUID().slice(0,8);
const ids=Object.fromEntries(['owner','agent','sub','other','empty','brandA','brandB','brandC','buyer','fr','be','jp','denied','unknown','sel','appointment'].map(n=>[n,n+'-'+key]));

async function cookieFor(role,id){
  const sid=randomUUID();const now=Date.now();
  const session={cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},staffUser:{id,role,email:id+'@test.invalid',brand_id:null,mfaEnrolled:true},authAt:now,lastActive:now};
  await withDb(server.dbUrl,db=>db.query('INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL \'1 day\')',[sid,JSON.stringify(session)]));
  const signature=createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  return 'sid='+encodeURIComponent('s:'+sid+'.'+signature);
}
async function request(path,cookie,method='GET',body){
  const r=await fetch(server.baseUrl+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  return {status:r.status,body:(r.headers.get('content-type')||'').includes('json')?await r.json():await r.text()};
}
before(async()=>{
  server=await startServer({dbNameSuffix:'commercial_'+key,port:3210});
  await withDb(server.dbUrl,async db=>{
    await db.query('CREATE TABLE IF NOT EXISTS user_sessions (sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
    for(const who of ['owner','agent','sub','other','empty']) await db.query('INSERT INTO admin_users(id,email,password_hash,role,name,mfa_enabled) VALUES($1,$2,$3,$4,$5,true)',[ids[who],ids[who]+'@test.invalid','not-a-password',who==='owner'?'owner':'agent',who]);
    for(const name of ['brandA','brandB','brandC']) await db.query('INSERT INTO brands(id,name) VALUES($1,$2)',[ids[name],name]);
    await db.query('INSERT INTO buyers(id,email,password_hash,name,country) VALUES($1,$2,$3,$4,$5)',[ids.buyer,'buyer@test.invalid','none','Buyer','FR']);
    await db.query("INSERT INTO products(id,brand_id,reference,price) VALUES($1,$2,'TEST-ONLY',100)",['product-'+key,ids.brandA]);
    for(const [name,brand,country] of [['fr','brandA','FR'],['be','brandA','BE'],['jp','brandB','JP'],['denied','brandB','FR'],['unknown','brandA','France']]){
      await db.query("INSERT INTO orders(id,brand_id,buyer_id,order_number,client_name,client_email,client_country,status) VALUES($1,$2,$3,$4,'Buyer','buyer@test.invalid',$5,'confirmed')",[ids[name],ids[brand],ids.buyer,name,country]);
      await db.query('INSERT INTO order_lines(id,order_id,product_id,quantity,unit_price) VALUES($1,$2,$3,2,100)',[randomUUID(),ids[name],'product-'+key]);
    }
    for(const [brand,country] of [['brandA','FR'],['brandA','BE'],['brandB','JP']]) await db.query('INSERT INTO agent_scope_grants VALUES($1,$2,$3)',[ids.agent,ids[brand],country]);
    await db.query('INSERT INTO agent_scope_grants VALUES($1,$2,$3)',[ids.sub,ids.brandA,'FR']);
    await db.query('UPDATE admin_users SET parent_agent_id=$1 WHERE id=$2',[ids.agent,ids.sub]);
    await db.query("INSERT INTO agent_selections(token,brand_id,client_email,items_json,expires_at,client_country) VALUES($1,$2,'buyer@test.invalid','[]',NOW()+INTERVAL '1 day','JP')",[ids.sel,ids.brandB]);
    await db.query("INSERT INTO appointments(id,brand_id,client_name,client_email,slot_date,slot_time,client_country) VALUES($1,$2,'JP Buyer','buyer@test.invalid',CURRENT_DATE,'08:00','JP')",[ids.appointment,ids.brandB]);
  });
  [owner,agent,sub,other,noGrants]=await Promise.all([cookieFor('owner',ids.owner),cookieFor('agent',ids.agent),cookieFor('agent',ids.sub),cookieFor('agent',ids.other),cookieFor('agent',ids.empty)]);
});
after(()=>server?.stop());

test('explicit grants reject invalid countries and cross-product permissions',()=>{
  assert.throws(()=>normalizeGrants([{brand_id:'A',country_code:'XX'}]));
  assert.throws(()=>normalizeGrants([{brand_id:'A',country_code:'France'}]));
  assert.equal(contains([{brand_id:'A',country_code:'FR'},{brand_id:'B',country_code:'JP'}],{brand_id:'B',country_code:'FR'}),false);
  assert.equal(contains([{brand_id:'A',country_code:'*'}],{brand_id:'A',country_code:'JP'}),true);
});
test('agent lists exactly authorized brand/country pairs, pagination counts and filters',async()=>{
  const r=await request('/api/orders?limit=1',agent);assert.equal(r.status,200);assert.equal(r.body.total,3);assert.equal(r.body.rows.length,1);
  const all=await request('/api/orders',agent);assert.deepEqual(new Set(all.body.rows.map(o=>o.id)),new Set([ids.fr,ids.be,ids.jp]));
  assert.equal((await request('/api/orders?country=JP&amountMin=150',agent)).body.total,1);
  assert.equal((await request('/api/orders?country=US',agent)).body.total,0);
});
test('subagent scope, no-grant default deny and global owner visibility',async()=>{
  assert.deepEqual((await request('/api/orders',sub)).body.rows.map(o=>o.id),[ids.fr]);
  assert.equal((await request('/api/orders',noGrants)).body.total,0);
  assert.equal((await request('/api/orders',owner)).body.total,5);
  assert.equal((await request('/api/brands',agent)).body.length,2);
  assert.equal((await request('/api/agent/me',sub)).body.brands.length,1);
});
test('direct IDs, PDFs, mutation, public shortcuts and exports cannot bypass grants',async()=>{
  for(const suffix of ['','/pdf','/history','/events']) assert.equal((await request('/api/orders/'+ids.denied+suffix,agent)).status,404,suffix);
  assert.equal((await request('/api/orders/'+ids.denied+'/status',agent,'PUT',{status:'cancelled'})).status,404);
  assert.equal((await request('/api/orders/'+ids.fr,other)).status,404);
  assert.equal((await request('/api/public/orders',agent,'POST',{brand_id:ids.brandC})).status,403);
  for(const path of ['/api/orders/export-csv','/api/admin/export/orders.xlsx','/api/buyers/export-csv','/api/access-requests','/api/settings','/api/admin/buyers/'+ids.buyer+'/profile']) assert.equal((await request(path,agent)).status,403,path);
  assert.equal((await request('/api/public/brands/'+ids.brandC,agent)).status,403);
});
test('selection creation cannot relabel a client country to bypass territory restrictions',async()=>{
  const spoof=await request('/api/brands/'+ids.brandB+'/agent-selection',agent,'POST',{client_email:'buyer@test.invalid',client_country:'JP',items:[]});
  assert.equal(spoof.status,403);
  const unqualified=await request('/api/brands/'+ids.brandA+'/agent-selection',agent,'POST',{client_email:'unknown@test.invalid',client_country:'FR',items:[]});
  assert.equal(unqualified.status,403);
});
test('scoped totals, selections and appointments do not include another territory',async()=>{
  const r=await request('/api/stats',agent);assert.equal(r.status,200);assert.equal(r.body.orders_count,3);assert.equal(Number(r.body.revenue_total),600);
  assert.equal((await request('/api/agent-selections',sub)).body.length,0);
  assert.equal((await request('/api/agent-selections',agent)).body.length,1);
  assert.equal((await request('/api/admin/appointments',sub)).body.length,0);
  assert.equal((await request('/api/admin/appointments',agent)).body.length,1);
  assert.equal((await request('/api/admin/dashboard/priorities',agent)).body.accessRequests.length,0);
});
test('only owner manages hierarchy; cycles, depth and parent reductions rejected atomically',async()=>{
  const path='/api/staff/'+ids.agent+'/scopes';
  assert.equal((await request(path,agent,'PUT',{grants:[]})).status,403);
  assert.equal((await request(path,owner,'PUT',{grants:[{brand_id:ids.brandB,country_code:'JP'}]})).status,409);
  assert.equal((await request('/api/staff/'+ids.sub+'/scopes',owner,'PUT',{parent_agent_id:ids.agent,grants:[{brand_id:ids.brandB,country_code:'FR'}]})).status,409);
  assert.equal((await request(path,owner,'PUT',{parent_agent_id:ids.sub,grants:[]})).status,409);
  assert.equal((await request('/api/staff/'+ids.other+'/scopes',owner,'PUT',{parent_agent_id:ids.sub,grants:[]})).status,409);
  assert.equal((await request(path,owner)).body.grants.length,3);
});
test('revocation is effective in existing sessions; exact grants do not expand from empty country',async()=>{
  const path='/api/staff/'+ids.other+'/scopes';
  assert.equal((await request(path,owner,'PUT',{grants:[{brand_id:ids.brandA,country_code:'*'}]})).status,200);
  assert.equal((await request('/api/orders',other)).body.total,3);
  assert.equal((await request(path,owner,'PUT',{grants:[]})).status,200);
  assert.equal((await request('/api/orders',other)).body.total,0);
});
test('wholesale requires documented basis and rate, stores exact rounded amount and separate flows',async()=>{
  const base={brand_id:ids.brandA,kind:'agency_receivable',country_code:'FR',currency:'EUR',basis_kind:'invoiced_net',basis_amount:'123.45',rate_percent:'12.5000',source_reference:'Test-only contract'};
  for(const field of ['basis_amount','rate_percent','source_reference'])assert.throws(()=>validateCommission({...base,[field]:undefined}));
  assert.throws(()=>validateCommission({...base,rate_percent:'12junk'}));
  const created=await request('/api/wholesale-commissions',owner,'POST',base);assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.amount,'15.43');assert.equal(created.body.status,'draft');
  assert.equal((await request('/api/wholesale-commissions',agent,'POST',base)).status,403);
  assert.deepEqual((await request('/api/wholesale-commissions',agent)).body,[]);
  const payable=await request('/api/wholesale-commissions',owner,'POST',{...base,kind:'subagent_payable',beneficiary_id:ids.sub,order_id:ids.fr});assert.equal(payable.status,201,JSON.stringify(payable.body));
  const id=payable.body.id;
  assert.equal((await request('/api/wholesale-commissions/'+id+'/status',owner,'PATCH',{status:'paid',reference:'test',version:1})).status,409);
  const approved=await request('/api/wholesale-commissions/'+id+'/status',owner,'PATCH',{status:'approved',reference:'contract checked',version:1});assert.equal(approved.status,200);
  assert.equal((await request('/api/wholesale-commissions/'+id+'/status',owner,'PATCH',{status:'invoiced',reference:'stale',version:1})).status,409);
  assert.equal((await request('/api/wholesale-commissions',sub)).body.length,1);
  assert.equal((await request('/api/wholesale-commissions',agent)).body.length,0);
  assert.equal((await request('/api/wholesale-commissions/'+id+'/history',owner)).body.length,2);
  const mismatch=await request('/api/wholesale-commissions',owner,'POST',{...base,order_id:ids.jp});assert.equal(mismatch.status,400);
});
test('a cached owner session cannot retain owner access after demotion',async()=>{
  const stale=await cookieFor('owner',ids.empty);
  assert.equal((await request('/api/staff',stale)).status,403);
  assert.equal((await request('/api/orders',stale)).body.total,0);
});
test('designer orders retain the assigned-brand SQL parameter after PR 281',async()=>{
  const designerId='designer-'+key;
  await withDb(server.dbUrl,db=>db.query("INSERT INTO admin_users(id,email,password_hash,role,brand_id,mfa_enabled) VALUES($1,$2,'none','designer',$3,true)",[designerId,designerId+'@test.invalid',ids.brandA]));
  const cookie=await cookieFor('designer',designerId);
  const result=await request('/api/orders',cookie);assert.equal(result.status,200);assert.equal(result.body.total,3);
  assert.ok(result.body.rows.every(order=>order.brand_id===ids.brandA));
});
test('migration is rerunnable and retains original orders and commercial records',async()=>{
  const {Pool}=require('pg');const pool=new Pool({connectionString:server.dbUrl});
  try{
    await migrateAdminCommercial(pool);await migrateAdminCommercial(pool);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM orders')).rows[0].count,5);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM wholesale_commissions')).rows[0].count,2);
  }finally{await pool.end();}
});

test('migration failure rolls back partial schema changes and preserves original records',async()=>{
  const {Pool}=require('pg');
  const schema='rollback_'+key;
  await withDb(server.dbUrl,async db=>{
    await db.query(`CREATE SCHEMA ${schema}`);
    for(const table of ['brands','admin_users','orders','agent_selections','appointments']) await db.query(`CREATE TABLE ${schema}.${table}(id TEXT PRIMARY KEY)`);
    await db.query(`INSERT INTO ${schema}.orders VALUES('original-record')`);
    // A conflicting relation makes the migration fail after its additive ALTERs.
    await db.query(`CREATE VIEW ${schema}.wholesale_commissions AS SELECT 'conflict'::text AS id`);
  });
  const pool=new Pool({connectionString:server.dbUrl,options:'-c search_path='+schema+',public'});
  try{
    await assert.rejects(migrateAdminCommercial(pool));
    const columns=await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND column_name IN ('parent_agent_id','client_country')",[schema]);
    assert.equal(columns.rows.length,0,'all preceding ALTERs must roll back');
    assert.equal((await pool.query('SELECT id FROM orders')).rows[0].id,'original-record');
  }finally{
    await pool.end();
    await withDb(server.dbUrl,db=>db.query(`DROP SCHEMA ${schema} CASCADE`));
  }
});
