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
