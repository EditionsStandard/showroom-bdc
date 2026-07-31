const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startServer, id, withDb } = require('./helpers');

let server;
let buyerEmail;
const password = 'CorrectHorse42!';

before(async () => {
  server = await startServer({ dbNameSuffix: 'auth', port: 3101 });
  buyerEmail = `buyer-${id('t')}@test.com`;
  const hash = bcrypt.hashSync(password, 10);
  await withDb(server.dbUrl, client =>
    client.query('INSERT INTO buyers (id, email, password_hash, name) VALUES ($1,$2,$3,$4)',
      [id('buyer'), buyerEmail, hash, 'Test Buyer'])
  );
});

after(() => server.stop());

test('mauvais mot de passe rejeté, aucune session ouverte', async () => {
  const r = await fetch(server.baseUrl + '/editions-showroom-b2b-portail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(buyerEmail)}&password=WrongPassword`,
    redirect: 'manual',
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') || '', /error=1/);
  const cookie = r.headers.get('set-cookie');
  const me = await fetch(server.baseUrl + '/api/portal/my-orders', { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(me.status, 401, 'aucune session acheteur ne doit être ouverte après un échec');
});

test('bon mot de passe accepté, session acheteur fonctionnelle', async () => {
  const r = await fetch(server.baseUrl + '/editions-showroom-b2b-portail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(buyerEmail)}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') || '', /\/portal/);
  const cookie = r.headers.get('set-cookie');
  assert.ok(cookie, 'un cookie de session doit être posé à la connexion');
  const me = await fetch(server.baseUrl + '/api/portal/my-orders', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
});

test('verrouillage du compte après 8 échecs, même avec le bon mot de passe ensuite', async () => {
  const lockEmail = `buyer-lock-${id('t')}@test.com`;
  const hash = bcrypt.hashSync(password, 10);
  await withDb(server.dbUrl, client =>
    client.query('INSERT INTO buyers (id, email, password_hash, name) VALUES ($1,$2,$3,$4)',
      [id('buyer'), lockEmail, hash, 'Lock Test'])
  );
  for (let i = 0; i < 8; i++) {
    await fetch(server.baseUrl + '/editions-showroom-b2b-portail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `email=${encodeURIComponent(lockEmail)}&password=WrongPassword`,
      redirect: 'manual',
    });
  }
  const r = await fetch(server.baseUrl + '/editions-showroom-b2b-portail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(lockEmail)}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') || '', /error=locked/, 'le compte doit rester verrouillé même avec le bon mot de passe');
});
