'use strict';
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const {createHmac,randomUUID}=require('node:crypto');
const {startServer,withDb}=require('./helpers');
let server,owner,agent,designer,buyerSession;
const suffix=randomUUID().replaceAll('-','').slice(0,10);
const ids=Object.fromEntries(['owner','agent','designer','brandA','brandB','brandUnused','buyerA','buyerB','buyerUnused','productA','productB'].map(name=>[name,`kpi_${name}_${suffix}`]));
const amount=value=>Number(value);
async function db(fn){return withDb(server.dbUrl,fn);}
async function request(path,cookie=owner){
  const response=await fetch(server.baseUrl+path,{headers:cookie?{Cookie:cookie}:{},redirect:'manual'});
  return {status:response.status,body:(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text()};
}
async function cookieFor(session){
  const sid=randomUUID(),now=Date.now();
  const payload={cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,...session};
  await db(c=>c.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify(payload)]));
  const signature=createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  return 'sid='+encodeURIComponent('s:'+sid+'.'+signature);
}
async function order({status='confirmed',brand='brandA',country='FR',buyer='buyerA',lines=[{quantity:1,price:10}],age='1 day'}={}){
  const orderId=randomUUID();
  await db(async c=>{
    await c.query(`INSERT INTO orders(id,brand_id,buyer_id,client_name,client_email,client_country,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,NOW()-$8::interval)`,[orderId,ids[brand],ids[buyer],buyer,ids[buyer]+'@test.invalid',country,status,age]);
    for(const line of lines)await c.query('INSERT INTO order_lines(id,order_id,product_id,quantity,unit_price) VALUES($1,$2,$3,$4,$5)',[randomUUID(),orderId,brand==='brandB'?ids.productB:ids.productA,line.quantity,line.price]);
  });
  return orderId;
}
async function selection({status='sent',used=false,template=false,brand='brandA',country='FR'}={}){
  const token=randomUUID();
  await db(c=>c.query(`INSERT INTO agent_selections(token,brand_id,client_email,items_json,expires_at,status,used,is_template,client_country)
    VALUES($1,$2,'synthetic@test.invalid','[]',NOW()+INTERVAL '30 days',$3,$4,$5,$6)`,[token,ids[brand],status,used,template,country]));
  return token;
}
before(async()=>{
  server=await startServer({dbNameSuffix:'kpi_'+suffix,port:3224});
  await db(async c=>{
    await c.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
    for(const brand of ['brandA','brandB','brandUnused'])await c.query('INSERT INTO brands(id,name) VALUES($1,$2)',[ids[brand],brand+' '+suffix]);
    for(const buyer of ['buyerA','buyerB','buyerUnused'])await c.query('INSERT INTO buyers(id,email,password_hash,name,company,country) VALUES($1,$2,$3,$4,$5,$6)',[ids[buyer],ids[buyer]+'@test.invalid','not-a-password',buyer+' '+suffix,'Synthetic shop','FR']);
    for(const [product,brand] of [['productA','brandA'],['productB','brandB']])await c.query('INSERT INTO products(id,brand_id,reference,price) VALUES($1,$2,$3,10)',[ids[product],ids[brand],'KPI-SYNTHETIC-'+product]);
    for(const role of ['owner','agent','designer'])await c.query('INSERT INTO admin_users(id,email,password_hash,name,role,brand_id,mfa_enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[ids[role],ids[role]+'@test.invalid','not-a-password',role,role,role==='designer'?ids.brandA:null]);
  });
  [owner,agent,designer]=await Promise.all(['owner','agent','designer'].map(role=>cookieFor({staffUser:{id:ids[role],email:ids[role]+'@test.invalid',role,brand_id:role==='designer'?ids.brandA:null,mfaEnrolled:true}})));
  buyerSession=await cookieFor({buyerPortal:{id:ids.buyerA,email:ids.buyerA+'@test.invalid',name:'Synthetic buyer'}});
});
beforeEach(async()=>{
  await db(async c=>{
    await c.query('DELETE FROM agent_selections');
    await c.query('DELETE FROM orders');
    await c.query('DELETE FROM agent_scope_grants');
    for(const [brand,country] of [['brandA','FR'],['brandB','JP']])await c.query('INSERT INTO agent_scope_grants(staff_id,brand_id,country_code) VALUES($1,$2,$3)',[ids.agent,ids[brand],country]);
  });
});
after(()=>server?.stop());

test('multi-line orders count once and only active statuses enter owner totals and rankings',async()=>{
  await order({lines:[{quantity:2,price:10},{quantity:1,price:5},{quantity:3,price:7}]}); // 46, one order
  await order({status:'validated',lines:[{quantity:2,price:20}]}); // 40
  await order({status:'in_production',brand:'brandB',buyer:'buyerB',lines:[{quantity:1,price:30}]});
  await order({status:'shipped',brand:'brandB',buyer:'buyerB',lines:[{quantity:1,price:4}]});
  for(const status of ['draft','cancelled','archived',null,'unknown_status'])await order({status,buyer:'buyerUnused',lines:[{quantity:100,price:999}]});
  const stats=await request('/api/stats');assert.equal(stats.status,200);
  assert.equal(stats.body.orders_count,4);assert.equal(amount(stats.body.revenue_total),120);
  assert.equal(amount(stats.body.pending_validation_total),46);assert.equal(amount(stats.body.validated_orders_total),74);
  const result=await request('/api/admin/buyer-stats');assert.equal(result.status,200);
  const buyers=Object.fromEntries(result.body.topBuyers.map(row=>[row.name,row]));
  assert.equal(Number(buyers['buyerA '+suffix].order_count),2);assert.equal(amount(buyers['buyerA '+suffix].total_amount),86);
  assert.equal(Number(buyers['buyerB '+suffix].order_count),2);assert.equal(amount(buyers['buyerB '+suffix].total_amount),34);
  assert.equal(buyers['buyerUnused '+suffix],undefined);
  const brands=Object.fromEntries(result.body.topBrands.map(row=>[row.name,row]));
  assert.equal(Number(brands['brandA '+suffix].order_count),2);assert.equal(amount(brands['brandA '+suffix].total_amount),86);
  assert.equal(Number(brands['brandB '+suffix].order_count),2);assert.equal(brands['brandUnused '+suffix],undefined);
  assert.equal(result.body.recentActivity.reduce((n,row)=>n+Number(row.count),0),4);
  assert.equal(result.body.recentActivity.reduce((n,row)=>n+amount(row.amount),0),120);
});

test('an active order without lines counts as one order and contributes zero amount',async()=>{
  await order({status:'validated',lines:[]});
  const stats=(await request('/api/stats')).body;assert.equal(stats.orders_count,1);assert.equal(amount(stats.revenue_total),0);
  const rankings=(await request('/api/admin/buyer-stats')).body;
  assert.equal(rankings.topBuyers.length,1);assert.equal(Number(rankings.topBuyers[0].order_count),1);assert.equal(amount(rankings.topBuyers[0].total_amount),0);
  assert.equal(rankings.topBrands.length,1);assert.equal(Number(rankings.topBrands[0].order_count),1);
});

test('the rolling 30-day window excludes older, future and inactive-status orders consistently',async()=>{
  await order({age:'29 days 23 hours 58 minutes',lines:[{quantity:1,price:11}]});
  await order({age:'30 days 2 minutes',lines:[{quantity:1,price:22}]});
  await order({age:'-1 day',lines:[{quantity:1,price:33}]});
  await order({age:'2 days',status:'archived',lines:[{quantity:1,price:44}]});
  await order({age:'2 days',status:'cancelled',lines:[{quantity:1,price:55}]});
  assert.equal((await request('/api/stats')).body.orders_last30,1);
  assert.equal((await request('/api/stats',agent)).body.orders_last30,1);
  const activity=(await request('/api/admin/buyer-stats')).body.recentActivity;
  assert.equal(activity.reduce((n,row)=>n+Number(row.count),0),1);
  assert.equal(activity.reduce((n,row)=>n+amount(row.amount),0),11);
});

test('selection acceptance uses recorded sent proposals, excludes drafts/templates/unknown statuses and preserves aliases',async()=>{
  await selection({used:true});await selection({used:false});await selection({used:false});
  await selection({status:'draft',used:true});await selection({status:null,used:true});await selection({status:'unknown_status',used:true});
  await selection({template:true,used:true});await selection({template:true,used:false});
  for(const cookie of [owner,agent]){
    const result=await request('/api/stats',cookie);assert.equal(result.status,200);
    const stats=result.body;assert.equal(stats.selections_proposed,3);assert.equal(stats.selections_accepted,1);assert.equal(stats.selection_acceptance_rate,33);
    assert.equal(stats.selections_total,stats.selections_proposed);assert.equal(stats.selections_confirmed,stats.selections_accepted);assert.equal(stats.conversion_rate,stats.selection_acceptance_rate);
    assert.equal(stats.selection_metric,'recorded_proposal_acceptance');
  }
});

test('empty proposal cohorts return a zero ratio without inventing email-delivery counts',async()=>{
  await selection({status:'draft',used:true});await selection({template:true,used:true});
  for(const cookie of [owner,agent]){
    const stats=(await request('/api/stats',cookie)).body;
    assert.equal(stats.selections_proposed,0);assert.equal(stats.selections_accepted,0);assert.equal(stats.selection_acceptance_rate,0);
    assert.equal(stats.selections_total,0);assert.equal(stats.conversion_rate,0);
    assert.equal(stats.selection_metric,'recorded_proposal_acceptance');
    assert.equal(stats.emails_delivered,undefined);assert.equal(stats.payments_received,undefined);
  }
});

test('agent figures retain exact brand-country pairs and never combine grants as a cross-product',async()=>{
  await order({brand:'brandA',country:'FR',lines:[{quantity:1,price:10},{quantity:1,price:2}]});
  await order({brand:'brandB',country:'JP',lines:[{quantity:1,price:20}]});
  await order({brand:'brandA',country:'JP',lines:[{quantity:1,price:100}]});
  await order({brand:'brandB',country:'FR',lines:[{quantity:1,price:200}]});
  await order({brand:'brandA',country:'France',lines:[{quantity:1,price:300}]});
  await order({brand:'brandA',country:'FR',status:'draft',lines:[{quantity:1,price:400}]});
  await selection({brand:'brandA',country:'FR',used:true});await selection({brand:'brandB',country:'JP',used:false});
  await selection({brand:'brandA',country:'JP',used:true});await selection({brand:'brandB',country:'FR',used:true});
  const stats=(await request('/api/stats',agent)).body;
  assert.equal(stats.orders_count,2);assert.equal(amount(stats.revenue_total),32);assert.equal(stats.orders_last30,2);
  assert.equal(stats.selections_proposed,2);assert.equal(stats.selections_accepted,1);assert.equal(stats.selection_acceptance_rate,50);
  const global=(await request('/api/stats',owner)).body;
  assert.equal(global.orders_count,5);assert.equal(amount(global.revenue_total),632);assert.equal(global.selections_proposed,4);
});

test('revoking grants changes existing agent-session figures immediately',async()=>{
  await order();await selection({used:true});
  assert.equal((await request('/api/stats',agent)).body.orders_count,1);
  await db(c=>c.query('DELETE FROM agent_scope_grants WHERE staff_id=$1',[ids.agent]));
  const stats=(await request('/api/stats',agent)).body;
  assert.equal(stats.orders_count,0);assert.equal(amount(stats.revenue_total),0);assert.equal(stats.orders_last30,0);
  assert.equal(stats.selections_proposed,0);assert.equal(stats.selections_accepted,0);assert.equal(stats.selection_acceptance_rate,0);
  const chart=(await request('/api/dashboard/revenue-chart',agent)).body;assert.equal(chart.length,6);assert.ok(chart.every(row=>row.total===0));
  assert.deepEqual((await request('/api/dashboard/top-products',agent)).body,[]);
});

test('detailed buyer rankings remain owner-only and unauthenticated, buyer and designer requests are refused',async()=>{
  for(const cookie of [undefined,buyerSession,designer,agent]){
    const result=await request('/api/admin/buyer-stats',cookie===undefined?null:cookie);assert.equal(result.status,403);
  }
  for(const cookie of [null,buyerSession,designer])assert.equal((await request('/api/stats',cookie)).status,403);
});

async function expectedCalendarKeys(){
  return db(async c=>(await c.query(`SELECT to_char(month,'YYYY-MM') AS key FROM generate_series(
    date_trunc('month',NOW())-INTERVAL '5 months',date_trunc('month',NOW()),INTERVAL '1 month') AS month ORDER BY month`)).rows.map(row=>row.key));
}
async function expectedCalendarMonths(lang){
  return (await expectedCalendarKeys()).map(key=>new Date(key+'-15T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'fr-FR',{month:'short',timeZone:'UTC'}));
}
async function moveOrderTime(orderId,expression){
  // Expressions below are fixed test fixtures, never HTTP/user input.
  await db(c=>c.query(`UPDATE orders SET created_at=${expression} WHERE id=$1`,[orderId]));
}

test('calendar-month charts and top products use the active cohort and exact owner/agent scope',async()=>{
  const first=await order({brand:'brandA',country:'FR',lines:[{quantity:2,price:10}]});
  await moveOrderTime(first,"date_trunc('month',NOW())-INTERVAL '5 months'"); // inclusive lower bound
  await order({brand:'brandA',country:'FR',lines:[{quantity:3,price:12}],age:'1 minute'});
  await order({brand:'brandB',country:'JP',status:'validated',lines:[{quantity:2,price:7}],age:'1 minute'});
  await order({brand:'brandA',country:'JP',lines:[{quantity:1,price:40}],age:'1 minute'}); // owner only
  await order({brand:'brandB',country:'FR',lines:[{quantity:1,price:50}],age:'1 minute'}); // owner only
  const old=await order({lines:[{quantity:100,price:100}]});
  await moveOrderTime(old,"date_trunc('month',NOW())-INTERVAL '5 months'-INTERVAL '1 microsecond'");
  await order({age:'-1 day',lines:[{quantity:100,price:200}]});
  for(const status of ['draft','cancelled','archived',null,'unknown_status'])await order({status,lines:[{quantity:100,price:300}],age:'1 minute'});
  for(const [cookie,total,quantities,revenues] of [[owner,160,[6,3],[96,64]],[agent,70,[5,2],[56,14]]]){
    for(const lang of ['fr','en']){
      const chart=await request('/api/dashboard/revenue-chart?months=6&lang='+lang,cookie);assert.equal(chart.status,200);
      assert.equal(chart.body.length,6);assert.deepEqual(chart.body.map(row=>row.month),await expectedCalendarMonths(lang));
      assert.deepEqual(chart.body.map(row=>row.month_key),await expectedCalendarKeys());
      assert.ok(chart.body.every(row=>typeof row.total==='number'&&Number.isFinite(row.total)));
      assert.equal(chart.body.reduce((sum,row)=>sum+row.total,0),total);
      assert.equal(chart.body[0].total,20,'the first calendar-month boundary must be included');
    }
    const products=await request('/api/dashboard/top-products',cookie);assert.equal(products.status,200);assert.equal(products.body.length,2);
    const byId=Object.fromEntries(products.body.map(row=>[row.id,row]));
    for(const [i,product] of [ids.productA,ids.productB].entries()){
      assert.equal(typeof byId[product].qty,'number');assert.equal(typeof byId[product].revenue,'number');
      assert.equal(byId[product].qty,quantities[i]);assert.equal(byId[product].revenue,revenues[i]);
    }
  }
});

test('an empty chart has exactly six localized zero months and top products stays empty',async()=>{
  await order({status:'validated',lines:[],age:'1 minute'});
  await order({status:'archived',lines:[{quantity:50,price:100}],age:'1 minute'});
  await order({status:'cancelled',lines:[{quantity:50,price:100}],age:'1 minute'});
  for(const cookie of [owner,agent])for(const lang of ['fr','en']){
    const chart=await request('/api/dashboard/revenue-chart?lang='+lang,cookie);assert.equal(chart.status,200);
    assert.equal(chart.body.length,6);assert.deepEqual(chart.body.map(row=>row.month),await expectedCalendarMonths(lang));
      assert.deepEqual(chart.body.map(row=>row.month_key),await expectedCalendarKeys());
    assert.deepEqual(chart.body.map(row=>row.total),[0,0,0,0,0,0]);
    assert.deepEqual((await request('/api/dashboard/top-products',cookie)).body,[]);
  }
});
