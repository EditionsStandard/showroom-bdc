'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { startServer, withDb, id } = require('./helpers');

let server, brandId, staffId;
before(async () => {
  server = await startServer({ dbNameSuffix: 'security_foundations', port: 3231 });
  brandId = id('brand');
  staffId = id('staff');
  await withDb(server.dbUrl, async db => {
    await db.query(
      "INSERT INTO brands(id,name,subscription_status,lookbook_url,cover_image) VALUES ($1,'Test Brand','active','https://example.test/private-wholesale-linesheet.pdf','https://example.test/cover.jpg')",
      [brandId]
    );
    await db.query("INSERT INTO admin_users(id,email,password_hash,role,mfa_enabled) VALUES ($1,$2,'test-only','owner',true)",
      [staffId, staffId + '@example.test']);
    await db.query('CREATE TABLE IF NOT EXISTS user_sessions (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp NOT NULL)');
  });
});
after(() => server?.stop());

async function staffCookie(ageMs) {
  const sid = id('sid');
  const now = Date.now();
  const sess = {
    cookie: { originalMaxAge: 86400000, expires: new Date(now + 86400000).toISOString(), httpOnly: true, path: '/' },
    staffUser: { id: staffId, role: 'owner', email: staffId + '@example.test', brand_id: null, mfaEnrolled: true },
    authAt: now - ageMs,
    lastActive: now - ageMs,
  };
  await withDb(server.dbUrl, db =>
    db.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')", [sid, JSON.stringify(sess)]));
  const signature = createHmac('sha256', 'test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/, '');
  return 'sid=' + encodeURIComponent('s:' + sid + '.' + signature);
}

test('robots permits noindex crawling rather than blocking directives', async () => {
  const r = await fetch(server.baseUrl + '/robots.txt');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Allow:\s*\//);
  assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
});

test('anonymous clients cannot reach a brand catalogue by UUID alone', async () => {
  for (const path of ['/commande/' + brandId, '/api/public/brands/' + brandId]) {
    const r = await fetch(server.baseUrl + path, { redirect: 'manual' });
    assert.equal(r.status, 403, path);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/, path);
  }
});

test('the legacy public brand list does not reveal private lookbook URLs', async () => {
  const r = await fetch(server.baseUrl + '/api/public/brands');
  assert.equal(r.status, 200);
  const brands = await r.json();
  const b = brands.find(x => x.id === brandId);
  assert.ok(b, 'public listing should still work');
  assert.equal(b.lookbook_url, undefined);
  assert.equal(b.thumbnail, undefined);
  assert.equal(b.cover_image, 'https://example.test/cover.jpg');
  assert.match(r.headers.get('cache-control') || '', /no-store/);
});

test('expired staff sessions cannot bypass the 30-minute inactivity limit via public commerce routes', async () => {
  const expired = await staffCookie(31 * 60 * 1000);
  for (const path of ['/commande/' + brandId, '/api/public/brands/' + brandId]) {
    const r = await fetch(server.baseUrl + path, { headers: { Cookie: expired }, redirect: 'manual' });
    assert.equal(r.status, 403, path);
  }
});

test('new share links have 128-bit random suffix and still resolve for invited buyers', async () => {
  const cookie = await staffCookie(0);
  const create = await fetch(server.baseUrl + '/api/brands/' + brandId + '/commande-link', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 1 })
  });
  const raw = await create.text();
  assert.equal(create.status, 200, raw);
  const link = JSON.parse(raw);
  assert.match(link.slug, /-[a-f0-9]{32}$/i, 'bearer slug needs 128 random bits');
  const open = await fetch(server.baseUrl + '/c/' + encodeURIComponent(link.slug), { redirect: 'manual' });
  assert.equal(open.status, 302, 'fresh invitation link should still open');
  assert.equal(open.headers.get('location'), '/commande/' + brandId);
});
