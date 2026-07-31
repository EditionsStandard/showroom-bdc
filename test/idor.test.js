const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startServer, id, withDb } = require('./helpers');

let server;
let buyerA, buyerB, orderAId, orderBId;
const password = 'CorrectHorse42!';

async function login(email) {
  const r = await fetch(server.baseUrl + '/editions-showroom-b2b-portail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  return r.headers.get('set-cookie');
}

before(async () => {
  server = await startServer({ dbNameSuffix: 'idor', port: 3102 });
  const hash = bcrypt.hashSync(password, 10);
  buyerA = { id: id('buyer'), email: `a-${id('t')}@test.com` };
  buyerB = { id: id('buyer'), email: `b-${id('t')}@test.com` };
  orderAId = id('order');
  orderBId = id('order');
  const brandId = id('brand');

  await withDb(server.dbUrl, async client => {
    await client.query('INSERT INTO buyers (id, email, password_hash, name) VALUES ($1,$2,$3,$4),($5,$6,$3,$7)',
      [buyerA.id, buyerA.email, hash, 'Buyer A', buyerB.id, buyerB.email, 'Buyer B']);
    await client.query('INSERT INTO brands (id, name, subscription_status) VALUES ($1,$2,$3)', [brandId, 'Brand IDOR', 'active']);
    await client.query(
      `INSERT INTO orders (id, brand_id, buyer_id, client_name, client_email, order_number, status, created_at)
       VALUES ($1,$2,$3,'Buyer A','${buyerA.email}','ORD-A','confirmed',NOW())`,
      [orderAId, brandId, buyerA.id]
    );
    await client.query(
      `INSERT INTO orders (id, brand_id, buyer_id, client_name, client_email, order_number, status, created_at)
       VALUES ($1,$2,$3,'Buyer B','${buyerB.email}','ORD-B','confirmed',NOW())`,
      [orderBId, brandId, buyerB.id]
    );
  });
});

after(() => server.stop());

test("l'historique d'un acheteur ne contient jamais les commandes d'un autre", async () => {
  const cookieA = await login(buyerA.email);
  const r = await fetch(server.baseUrl + '/api/portal/my-orders', { headers: { Cookie: cookieA } });
  assert.equal(r.status, 200);
  const orders = await r.json();
  assert.ok(orders.some(o => o.id === orderAId), "la commande de A doit apparaître dans son propre historique");
  assert.ok(!orders.some(o => o.id === orderBId), "la commande de B ne doit JAMAIS apparaître dans l'historique de A");
});

test("un acheteur ne peut pas récupérer les lignes de la commande d'un autre par ID", async () => {
  const cookieA = await login(buyerA.email);
  const r = await fetch(server.baseUrl + `/api/portal/orders/${orderBId}/lines`, { headers: { Cookie: cookieA } });
  assert.equal(r.status, 404, "l'accès à la commande d'un autre acheteur doit être refusé (404, pas de fuite d'existence)");
});

test("un acheteur ne peut pas télécharger le PDF de la commande d'un autre", async () => {
  const cookieA = await login(buyerA.email);
  const r = await fetch(server.baseUrl + `/api/portal/orders/${orderBId}/pdf`, { headers: { Cookie: cookieA } });
  assert.equal(r.status, 404);
});

test("un acheteur PEUT télécharger le PDF de sa propre commande", async () => {
  const cookieA = await login(buyerA.email);
  const r = await fetch(server.baseUrl + `/api/portal/orders/${orderAId}/pdf`, { headers: { Cookie: cookieA } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
});
