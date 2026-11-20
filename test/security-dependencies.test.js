'use strict';
const {before, after, test} = require('node:test');
const assert = require('node:assert/strict');
const {createHmac} = require('node:crypto');
const XLSX = require('xlsx');
const {startServer, withDb, id} = require('./helpers');

let server, staffId, brandId, productId;
before(async () => {
  server = await startServer({dbNameSuffix:'secure_dep_upgrades',port:3262});
  staffId=id('staff'); brandId=id('brand'); productId=id('product');
  await withDb(server.dbUrl,async db=>{
    await db.query("INSERT INTO brands(id,name,subscription_status) VALUES($1,'Studio Name','active')",[brandId]);
    await db.query("INSERT INTO products(id,brand_id,reference,description,color,sizes,price,active) VALUES($1,$2,$3,'Verified product','Black','S,M',125,1)",[productId,brandId,'=INJECTED_FORMULA']);
    await db.query("INSERT INTO orders(id,brand_id,client_name,client_email,status) VALUES($1,$2,'Buyer','buyer@example.invalid','confirmed')",[id('order'),brandId]);
    await db.query("INSERT INTO admin_users(id,email,password_hash,role,mfa_enabled) VALUES($1,$2,'test-only','owner',true)",[staffId,staffId+'@example.invalid']);
    await db.query('CREATE TABLE IF NOT EXISTS user_sessions (sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
  });
});
after(()=>server?.stop());

async function staffCookie(){
  const sid=id('sid'); const now=Date.now();
  const sess={
    cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},
    staffUser:{id:staffId,role:'owner',email:staffId+'@example.invalid',brand_id:null,mfaEnrolled:true},
    authAt:now,lastActive:now
  };
  await withDb(server.dbUrl, db=>db.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify(sess)]));
  const sig=createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
  return 'sid='+encodeURIComponent('s:'+sid+'.'+sig);
}

test('pinned dependencies do not retain vulnerable Multer 1.x or SheetJS 0.18',()=>{
  const pkg=require('../package.json');
  assert.equal(pkg.dependencies.multer,'2.5.0');
  assert.equal(require('multer/package.json').version,'2.5.0');
  assert.equal(pkg.dependencies.xlsx,'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
  assert.equal(XLSX.version,'0.20.3');
});

test('XLSX export of B2B products retains reference and wholesale amounts without spreadsheet formulas',async()=>{
  const cookie=await staffCookie();
  const r=await fetch(server.baseUrl+'/api/admin/export/products.xlsx',{headers:{Cookie:cookie}});
  assert.equal(r.status,200,await r.clone().text().then(x=>x.slice(0,300)));
  assert.match(r.headers.get('content-type')||'',/spreadsheetml/);
  const buffer=Buffer.from(await r.arrayBuffer());
  assert.equal(buffer.subarray(0,2).toString(),'PK');
  const book=XLSX.read(buffer,{type:'buffer'});
  assert.ok(book.SheetNames.includes('Produits'));
  const sheet=book.Sheets['Produits'];
  const rows=XLSX.utils.sheet_to_json(sheet);
  const product=rows.find(x=>x['Référence']==='=INJECTED_FORMULA');
  assert.ok(product,JSON.stringify(rows).slice(0,1000));
  assert.equal(Number(product['Prix HT']),125);
  const cell=Object.values(sheet).find(x=>x?.v==='=INJECTED_FORMULA');
  assert.equal(cell?.t,'s');
  assert.equal(cell?.f,undefined,'reference must never become an executable formula');
});

test('XLSX export of orders still produces a readable workbook',async()=>{
  const cookie=await staffCookie();
  const r=await fetch(server.baseUrl+'/api/admin/export/orders.xlsx',{headers:{Cookie:cookie}});
  assert.equal(r.status,200,await r.clone().text().then(x=>x.slice(0,300)));
  const book=XLSX.read(Buffer.from(await r.arrayBuffer()),{type:'buffer'});
  assert.ok(book.SheetNames.includes('Commandes'));
  assert.ok(XLSX.utils.sheet_to_json(book.Sheets.Commandes).some(row=>row.Client==='Buyer'));
});

test('multipart fake image bytes cannot bypass content validation after Multer upgrade',async()=>{
  const cookie=await staffCookie();
  const form=new FormData();
  form.append('image',new Blob([Buffer.from('<script>not an image</script>')],{type:'image/png'}),'fake.png');
  const r=await fetch(server.baseUrl+'/api/upload-image',{method:'POST',headers:{Cookie:cookie},body:form});
  assert.equal(r.status,400,await r.text());
});
