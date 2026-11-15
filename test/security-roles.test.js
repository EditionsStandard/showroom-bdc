'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { startServer, withDb } = require('./helpers');

const suffix = randomUUID().slice(0, 8);
const id = prefix => prefix + '-' + suffix;
const ids = {
  brandA: id('scope-brand-a'), brandB: id('scope-brand-b'),
  productA: id('scope-product-a'), productB: id('scope-product-b'),
  buyerA: id('scope-buyer-a'), buyerB: id('scope-buyer-b'),
  orderA: id('scope-order-a'), orderB: id('scope-order-b'),
  owner: id('scope-owner'), agent: id('scope-agent'), designer: id('scope-designer')
};
const password = 'StrongBuyerPassword123!';
let server, cookieA, cookieB, ownerCookie, agentCookie, designerCookie;

function staffCookie(userId, role, brandId) {
  const sid = randomUUID();
  const now = Date.now();
  const session = {
    cookie: { originalMaxAge: 86400000, expires: new Date(now + 86400000).toISOString(), httpOnly: true, path: '/' },
    staffUser: { id: userId, role, brand_id: brandId, email: userId + '@example.invalid', mfaEnrolled: true },
    authAt: now, lastActive: now
  };
  const signature = createHmac('sha256', 'test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/, '');
  return { sid, session, cookie: 'sid=' + encodeURIComponent('s:' + sid + '.' + signature) };
}

async function buyerLogin(email) {
  const response = await fetch(server.baseUrl + '/editions-showroom-b2b-portail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=' + encodeURIComponent(email) + '&password=' + encodeURIComponent(password),
    redirect: 'manual'
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /portal/);
  return response.headers.get('set-cookie').split(';')[0];
}

async function request(endpoint, cookie, method = 'GET', body) {
  return fetch(server.baseUrl + endpoint, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}

before(async () => {
  server = await startServer({ dbNameSuffix: 'secroles_' + suffix, port: 3221 });
  const passwordHash = bcrypt.hashSync(password, 10);
  await withDb(server.dbUrl, async db => {
    for (const brand of ['brandA', 'brandB']) {
      await db.query("INSERT INTO brands(id,name,subscription_status) VALUES($1,$2,'active')", [ids[brand], brand]);
    }
    await db.query("INSERT INTO products(id,brand_id,reference,price) VALUES($1,$2,'A001',100),($3,$4,'B001',200)", [ids.productA, ids.brandA, ids.productB, ids.brandB]);
    for (const who of ['buyerA', 'buyerB']) {
      await db.query("INSERT INTO buyers(id,email,password_hash,name) VALUES($1,$2,$3,$4)",
        [ids[who], ids[who] + '@example.invalid', passwordHash, who]);
    }
    for (const who of ['owner', 'agent', 'designer']) {
      const role = who;
      const brandId = who === 'owner' ? null : ids.brandA;
      await db.query("INSERT INTO admin_users(id,email,password_hash,role,brand_id,mfa_enabled) VALUES($1,$2,'unused',$3,$4,true)",
        [ids[who], ids[who] + '@example.invalid', role, brandId]);
    }
    await db.query("INSERT INTO orders(id,brand_id,buyer_id,client_name,client_email,status) VALUES($1,$2,$3,'Buyer A',$4,'confirmed'),($5,$6,$7,'Buyer B',$8,'confirmed')",
      [ids.orderA, ids.brandA, ids.buyerA, ids.buyerA + '@example.invalid', ids.orderB, ids.brandB, ids.buyerB, ids.buyerB + '@example.invalid']);
    for (const who of ['owner', 'agent', 'designer']) {
      const info = staffCookie(ids[who], who, who === 'owner' ? null : ids.brandA);
      await db.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')", [info.sid, JSON.stringify(info.session)]);
      if (who === 'owner') ownerCookie = info.cookie;
      if (who === 'agent') agentCookie = info.cookie;
      if (who === 'designer') designerCookie = info.cookie;
    }
  });
  cookieA = await buyerLogin(ids.buyerA + '@example.invalid');
  cookieB = await buyerLogin(ids.buyerB + '@example.invalid');
});

after(() => server?.stop());

test('admin security endpoints reject anonymous, buyer, agent and designer sessions', async () => {
  for (const cookie of [null, cookieA, agentCookie, designerCookie]) {
    const result = await request('/api/admin/security/status', cookie);
    assert.equal(result.status, 403);
  }
  assert.equal((await request('/api/admin/security/status', ownerCookie)).status, 200);
});

test('staff access checks are enforced on API requests, not by hiding the admin UI', async () => {
  for (const cookie of [cookieA, cookieB]) {
    assert.equal((await request('/api/staff', cookie)).status, 403);
    assert.equal((await request('/api/brands/' + ids.brandA + '/products', cookie)).status, 403);
  }
  for (const cookie of [agentCookie, designerCookie]) {
    assert.equal((await request('/api/brands/' + ids.brandB + '/products', cookie)).status, 403);
    assert.equal((await request('/api/products/' + ids.productB + '/prices', cookie, 'PATCH', {price: 1})).status, 403);
    assert.equal((await request('/api/brands/' + ids.brandB + '/products', cookie, 'POST', {reference:'BAD-SCOPE'})).status, 403);
  }
  assert.equal((await request('/api/brands/' + ids.brandB + '/products', ownerCookie)).status, 200);
});

test('buyers cannot retrieve another buyers order, PDF, or reorder snapshot by ID', async () => {
  for (const [cookie, otherOrder] of [[cookieA, ids.orderB], [cookieB, ids.orderA]]) {
    for (const endpoint of ['/lines', '/pdf', '/reorder']) {
      assert.equal((await request('/api/portal/orders/' + otherOrder + endpoint, cookie)).status, 404, endpoint);
    }
  }
});
