const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const bcrypt=require('bcryptjs');
const {startServer,withDb,id}=require('./helpers');
let server,users=[];
before(async()=>{
  server=await startServer({dbNameSuffix:'companies',port:3198});
  for(let i=0;i<3;i++){
    const buyer=id('company_buyer'),email=buyer+'@example.test';
    await withDb(server.dbUrl,db=>db.query('INSERT INTO buyers(id,email,password_hash,name,company) VALUES($1,$2,$3,$4,$5)',[buyer,email,bcrypt.hashSync('CompanySecurePassword123!',10),'Buyer','Same retailer name']));
    const login=await fetch(server.baseUrl+'/editions-showroom-b2b-portail',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'email='+encodeURIComponent(email)+'&password=CompanySecurePassword123!',redirect:'manual'});
    users.push({id:buyer,email,cookie:login.headers.get('set-cookie').split(';')[0]});
  }
});
after(()=>server?.stop());
async function request(user,path,method='GET',body){const r=await fetch(server.baseUrl+path,{method,headers:{Cookie:user.cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};}
test('companies do not merge by name; invitations are email-scoped and single use',async()=>{
  const a=await request(users[0],'/api/portal/company'),b=await request(users[1],'/api/portal/company');
  assert.notEqual(a.data.company.id,b.data.company.id);
  const invite=await request(users[0],'/api/portal/company/invites','POST',{email:users[1].email});
  const token=new URL(invite.data.url,'http://test').searchParams.get('company_invite');
  assert.equal((await request(users[2],'/api/portal/company/invites/accept','POST',{token})).status,400);
  assert.equal((await request(users[1],'/api/portal/company/invites/accept','POST',{token})).status,200);
  assert.equal((await request(users[1],'/api/portal/company/invites/accept','POST',{token})).status,400);
  const joined=await request(users[1],'/api/portal/company');assert.equal(joined.data.company.id,a.data.company.id);assert.equal(joined.data.role,'buyer');
  assert.equal((await request(users[1],'/api/portal/company/locations','POST',{name:'Unauthorized',shipping:{address:'Test'}})).status,403);
});
test('buying lists are personal until explicitly shared, remain isolated from other companies',async()=>{
  const created=await request(users[0],'/api/portal/buying-shortlists','POST',{name:'Opening buy',notes:'Review budget',product_ids:[]});
  assert.equal(created.status,200);
  const listId=created.data.id;
  assert.equal((await request(users[1],'/api/portal/buying-shortlists')).data.length,0);
  await request(users[0],'/api/portal/buying-shortlists/'+listId,'PATCH',{shared:true,ready_for_review:true});
  assert.equal((await request(users[1],'/api/portal/buying-shortlists')).data[0].id,listId);
  assert.equal((await request(users[2],'/api/portal/buying-shortlists')).data.length,0);
  assert.equal((await request(users[1],'/api/portal/buying-shortlists/'+listId,'PATCH',{notes:'Unauthorized'})).status,403);
});

test('structured addresses validate country and city, preserve legacy records and owner-only writes',async()=>{
  const company=(await request(users[0],'/api/portal/company')).data.company;
  const legacy={address:'Legacy address, unchanged',reference:'Existing billing reference'};
  await withDb(server.dbUrl,db=>db.query('UPDATE companies SET billing=$1 WHERE id=$2',[legacy,company.id]));
  assert.deepEqual((await request(users[0],'/api/portal/company')).data.company.billing,legacy);
  const invalid=[{},[],{address:'A',city:'Paris',country:'France'},{address:'A',city:'Paris',country:'XX'},{address:'A',country:'FR'},{address:['A'],city:'Paris',country:'FR'}];
  for(const address of invalid) {
    assert.equal((await request(users[0],'/api/portal/company','PUT',{name:company.name,billing:address})).status,400);
    assert.equal((await request(users[0],'/api/portal/company/locations','POST',{name:'Test location',shipping:address})).status,400);
  }
  assert.deepEqual((await request(users[0],'/api/portal/company')).data.company.billing,legacy);
  const billing={...legacy,address:'12 Test Street',address_line2:'Unit 2',city:'Paris',postal_code:'75001',country:'FR'};
  assert.equal((await request(users[1],'/api/portal/company','PUT',{name:company.name,billing})).status,403);
  assert.equal((await request(users[0],'/api/portal/company','PUT',{name:company.name,billing})).status,200);
  assert.deepEqual((await request(users[0],'/api/portal/company')).data.company.billing,billing);
  // Postal codes are optional: do not require a postcode for every country.
  assert.equal((await request(users[0],'/api/portal/company/locations','POST',{name:'Test store',shipping:{address:'Test address',city:'Hong Kong',country:'HK'}})).status,200);
  assert.equal((await request(users[2],'/api/portal/company')).data.locations.length,0);
});

test('profile country changes require ISO codes without rewriting unqualified historical countries',async()=>{
  await withDb(server.dbUrl,db=>db.query("UPDATE buyers SET country='Other' WHERE id=$1",[users[0].id]));
  const profile=country=>request(users[0],'/api/portal/update-profile','POST',{name:'Buyer',company:'Retailer',phone:'',country});
  assert.equal((await profile('Other')).status,200);
  for(const value of ['France','XX','',{},null])assert.equal((await profile(value)).status,400);
  assert.equal((await profile('dk')).status,200);
  const result=await withDb(server.dbUrl,db=>db.query('SELECT country FROM buyers WHERE id=$1',[users[0].id]));
  assert.equal(result.rows[0].country,'DK');
  assert.equal((await profile('Other')).status,400,'a stale form cannot restore a legacy value');
});
