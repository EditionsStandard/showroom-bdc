const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');
const XLSX = require('xlsx');
const { startServer, withDb, id } = require('./helpers');
let server, cookie, brandId;
before(async () => {
  server = await startServer({ dbNameSuffix: 'dependency_regression', port: 3210 });
  brandId = id('dependency_brand');
  const secret = authenticator.generateSecret();
  await withDb(server.dbUrl, async db => {
    await db.query("INSERT INTO settings(key,value) VALUES('owner_mfa_enabled','on'),('owner_mfa_secret',$1),('owner_mfa_last_step','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [secret]);
    await db.query("INSERT INTO brands(id,name,subscription_status) VALUES($1,'Dependency test','active')", [brandId]);
    await db.query("INSERT INTO orders(id,brand_id,order_number,client_name,client_email,status) VALUES($1,$2,'SEC-001','Élodie','dependency@test.invalid','draft')", [id('dependency_order'), brandId]);
  });
  const login = await fetch(server.baseUrl + '/admin/login', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'password=TestAdmin123!', redirect:'manual' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const mfa = await fetch(server.baseUrl + '/admin/login/mfa', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded', Cookie:cookie}, body:'code=' + authenticator.generate(secret), redirect:'manual' });
  assert.equal(mfa.headers.get('location'), '/admin');
  cookie = mfa.headers.get('set-cookie')?.split(';')[0] || cookie;
});
after(() => server?.stop());
function upload(csv, field = 'file') {
  const body = new FormData();
  body.append(field, new Blob([csv], {type:'text/csv'}), 'produits.csv');
  return fetch(server.baseUrl + `/api/brands/${brandId}/products/import-csv`, { method:'POST', headers:{Cookie:cookie}, body });
}
test('multipart CSV import preserves accents, prices and sizes with Multer 2', async () => {
  const response = await upload('reference,description,color,sizes,price,price_retail,collection\nSEC-001,Écharpe,Brun,S|M,12.50,25,FW27');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).imported, 1);
  await withDb(server.dbUrl, async db => {
    const row = (await db.query('SELECT description,price,sizes FROM products WHERE brand_id=$1 AND reference=$2', [brandId, 'SEC-001'])).rows[0];
    assert.equal(row.description, 'Écharpe');
    assert.equal(Number(row.price), 12.5);
    assert.equal(row.sizes, 'S|M');
  });
});
test('oversized and unexpected multipart files are rejected without crashing', async () => {
  assert.equal((await upload('x'.repeat(5 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload('reference\nSEC-002', 'unexpected')).status, 400);
  assert.equal((await fetch(server.baseUrl + '/admin/login')).status, 200);
});
test('SheetJS exports retain sheet names, accents and price values', async () => {
  for (const [kind, sheet] of [['products', 'Produits'], ['orders', 'Commandes']]) {
    const response = await fetch(server.baseUrl + `/api/admin/export/${kind}.xlsx?brand_id=${brandId}`, {headers:{Cookie:cookie}});
    assert.equal(response.status, 200);
    const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), {type:'buffer'});
    assert.deepEqual(workbook.SheetNames, [sheet]);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet]);
    assert.equal(rows.length, 1);
    if (kind === 'products') {
      assert.equal(rows[0]['Description'], 'Écharpe');
      assert.equal(rows[0]['Prix HT'], '12.5');
    } else assert.equal(rows[0]['Client'], 'Élodie');
  }
});
test('linesheet and sales PDFs still contain an embedded logo image', async () => {
  for (const endpoint of ['linesheet-pdf', 'sales-report/pdf']) {
    const response = await fetch(server.baseUrl + `/api/brands/${brandId}/${endpoint}`, {headers:{Cookie:cookie}});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    const pdf = Buffer.from(await response.arrayBuffer());
    assert.equal(pdf.subarray(0,5).toString(), '%PDF-');
    assert.match(pdf.toString('latin1'), /\/Subtype \/Image/);
  }
});

test('staff HTML and agent MFA sessions persist before the next request and grant no early access', async () => {
  const bcrypt = require('bcryptjs');
  for (const api of [false, true]) {
    const staffId = id('mfa_staff'), email = staffId + '@test.invalid';
    const secret = authenticator.generateSecret();
    await withDb(server.dbUrl, db => db.query('INSERT INTO admin_users(id,email,password_hash,role,brand_id,mfa_enabled,mfa_secret) VALUES($1,$2,$3,$4,$5,true,$6)', [staffId,email,bcrypt.hashSync('StaffSecure123!',10),'agent',brandId,secret]));
    const first = await fetch(server.baseUrl + (api ? '/api/agent/login' : '/admin/login'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'StaffSecure123!'}),redirect:'manual'});
    const pendingCookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(server.baseUrl + '/api/agent/me', {headers:{Cookie:pendingCookie}})).status, 401);
    const second = await fetch(server.baseUrl + (api ? '/api/agent/login/mfa' : '/admin/login/mfa'), {method:'POST',headers:{'Content-Type':'application/json',Cookie:pendingCookie},body:JSON.stringify({code:authenticator.generate(secret)}),redirect:'manual'});
    if (api) assert.equal(second.status, 200);
    else assert.equal(second.headers.get('location'), '/admin');
    const authenticatedCookie = second.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(server.baseUrl + '/api/agent/me', {headers:{Cookie:authenticatedCookie}})).status, 200);
  }
});

test('buyer password and access-link MFA sessions require a second factor before portal access', async () => {
  const bcrypt = require('bcryptjs');
  for (const magic of [false, true]) {
    const buyerId = id('mfa_buyer'), email = buyerId + '@test.invalid';
    const secret = authenticator.generateSecret(), token = id('access');
    await withDb(server.dbUrl, async db => {
      await db.query('INSERT INTO buyers(id,email,password_hash,mfa_enabled,mfa_secret) VALUES($1,$2,$3,true,$4)', [buyerId,email,bcrypt.hashSync('BuyerSecure123!',10),secret]);
      if (magic) await db.query("INSERT INTO buyer_access_tokens(token,buyer_id,expires_at) VALUES($1,$2,NOW()+interval '1 hour')", [token,buyerId]);
    });
    const first = magic
      ? await fetch(server.baseUrl + '/portal/access?token=' + token, {redirect:'manual'})
      : await fetch(server.baseUrl + '/editions-showroom-b2b-portail', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'BuyerSecure123!'}),redirect:'manual'});
    assert.equal(first.headers.get('location'), '/editions-showroom-b2b-portail?step=mfa');
    const pendingCookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(server.baseUrl + '/api/portal/my-orders', {headers:{Cookie:pendingCookie}})).status, 401);
    const second = await fetch(server.baseUrl + '/editions-showroom-b2b-portail/mfa', {method:'POST',headers:{'Content-Type':'application/json',Cookie:pendingCookie},body:JSON.stringify({code:authenticator.generate(secret)}),redirect:'manual'});
    assert.equal(second.headers.get('location'), '/portal');
    const authenticatedCookie = second.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(server.baseUrl + '/api/portal/my-orders', {headers:{Cookie:authenticatedCookie}})).status, 200);
  }
});
