// Tests de non-régression pour les deux correctifs N+1 de cette session :
// - GET /api/portal/brands/:id/products doit incrémenter les vues de TOUS les
//   produits en une seule requête groupée (et non plus une par produit).
// - GET /api/portal/my-orders doit regrouper les lignes de commande en une
//   seule requête (WHERE order_id = ANY(...)), sans exposer order_id.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startServer, id, withDb } = require('./helpers');

let server;
let buyer, brandId;
const password = 'CorrectHorse42!';
const N_PRODUCTS = 12;

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
  server = await startServer({ dbNameSuffix: 'perf', port: 3103 });
  const hash = bcrypt.hashSync(password, 10);
  buyer = { id: id('buyer'), email: `perf-${id('t')}@test.com` };
  brandId = id('brand');

  await withDb(server.dbUrl, async client => {
    await client.query('INSERT INTO buyers (id, email, password_hash, name) VALUES ($1,$2,$3,$4)', [buyer.id, buyer.email, hash, 'Perf Buyer']);
    await client.query('INSERT INTO brands (id, name, subscription_status) VALUES ($1,$2,$3)', [brandId, 'Brand Perf', 'active']);
    for (let i = 0; i < N_PRODUCTS; i++) {
      await client.query(
        'INSERT INTO products (id, brand_id, reference, description, color, sizes, price, price_retail, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)',
        [`prod-${i}-${id('p')}`, brandId, `REF${i}`, `Produit ${i}`, 'Noir', 'S,M,L', 100, 200]
      );
    }
  });
});

after(() => server.stop());

test('le tracking des vues catalogue upserte tous les produits en une passe groupée', async () => {
  const cookie = await login(buyer.email);
  const r1 = await fetch(server.baseUrl + `/api/portal/brands/${brandId}/products`, { headers: { Cookie: cookie } });
  assert.equal(r1.status, 200);
  const body1 = await r1.json();
  assert.equal(body1.products.length, N_PRODUCTS);

  const stats1 = await withDb(server.dbUrl, c => c.query(
    'SELECT sum(views)::int AS total, count(*)::int AS n FROM product_stats WHERE product_id = ANY($1)',
    [body1.products.map(p => p.id)]
  ));
  assert.equal(stats1.rows[0].n, N_PRODUCTS, 'chaque produit doit avoir une ligne product_stats');
  assert.equal(stats1.rows[0].total, N_PRODUCTS, 'chaque produit doit être à 1 vue après le premier chargement');

  // Second chargement — l'upsert groupé doit incrémenter, pas dupliquer.
  await fetch(server.baseUrl + `/api/portal/brands/${brandId}/products`, { headers: { Cookie: cookie } });
  const stats2 = await withDb(server.dbUrl, c => c.query(
    'SELECT sum(views)::int AS total, count(*)::int AS n FROM product_stats WHERE product_id = ANY($1)',
    [body1.products.map(p => p.id)]
  ));
  assert.equal(stats2.rows[0].n, N_PRODUCTS, 'toujours une seule ligne par produit (pas de doublon)');
  assert.equal(stats2.rows[0].total, N_PRODUCTS * 2, 'les vues doivent être incrémentées, pas réinitialisées');
});

test("l'historique acheteur regroupe les lignes par commande sans exposer order_id", async () => {
  const orderId = id('order');
  const productsRes = await withDb(server.dbUrl, c => c.query('SELECT id FROM products WHERE brand_id=$1 LIMIT 3', [brandId]));
  const productIds = productsRes.rows.map(r => r.id);
  await withDb(server.dbUrl, async client => {
    await client.query(
      `INSERT INTO orders (id, brand_id, buyer_id, client_name, client_email, order_number, status, created_at)
       VALUES ($1,$2,$3,'Perf Buyer','${buyer.email}','ORD-PERF','confirmed',NOW())`,
      [orderId, brandId, buyer.id]
    );
    for (const pid of productIds) {
      await client.query(
        'INSERT INTO order_lines (id, order_id, product_id, size, quantity, unit_price, price_retail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id('line'), orderId, pid, 'M', 2, 100, 200]
      );
    }
  });

  const cookie = await login(buyer.email);
  const r = await fetch(server.baseUrl + '/api/portal/my-orders', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const orders = await r.json();
  const order = orders.find(o => o.id === orderId);
  assert.ok(order, 'la commande créée doit apparaître dans l\'historique');
  assert.equal(order.lines.length, productIds.length, 'toutes les lignes doivent être regroupées sous la commande');
  for (const line of order.lines) {
    assert.equal(line.order_id, undefined, "order_id ne doit pas fuiter dans la réponse (détail d'implémentation interne)");
    assert.ok(line.reference, 'chaque ligne doit conserver sa référence produit');
  }
});
