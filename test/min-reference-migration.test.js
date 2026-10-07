const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { migrateMinReference } = require('../lib/min-reference-migration');

for (const legacy of [false, true]) test(`reference constraint: ${legacy ? 'existing hotfix' : 'fresh schema'}`, async () => {
  const schema = 'min_ref_' + require('node:crypto').randomBytes(6).toString('hex');
  const admin = new Pool({ connectionString: process.env.TEST_PG_ADMIN_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_PG_ADMIN_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres', options: `-c search_path=${schema},public` });
  try {
    await pool.query(`
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE brands(id TEXT PRIMARY KEY);
      CREATE TABLE buyer_brand_terms(buyer_id TEXT,brand_id TEXT,PRIMARY KEY(buyer_id,brand_id));
      CREATE TABLE orders(id TEXT PRIMARY KEY,brand_id TEXT,buyer_id TEXT);
      CREATE TABLE products(id TEXT PRIMARY KEY,reference TEXT);
      CREATE TABLE order_lines(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,product_id TEXT,quantity INTEGER,size TEXT,color TEXT);
      INSERT INTO brands VALUES ('1937b8b8-00d4-4c72-8d03-a83f492db00f');
      INSERT INTO products VALUES ('p','REF'),('p2','REF');
    `);
    if (legacy) await pool.query(`
      ALTER TABLE brands ADD COLUMN min_per_reference INTEGER DEFAULT 1;
      ALTER TABLE buyer_brand_terms ADD COLUMN min_per_reference_override INTEGER;
      CREATE FUNCTION enforce_min_per_reference() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.quantity < 3 THEN RAISE EXCEPTION 'old per-line constraint'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER trg_min_per_reference BEFORE INSERT OR UPDATE OF quantity ON order_lines
        FOR EACH ROW EXECUTE FUNCTION enforce_min_per_reference();
    `);
    await migrateMinReference(pool);
    await migrateMinReference(pool);
    assert.equal((await pool.query('SELECT min_per_reference FROM brands')).rows[0].min_per_reference, 3);
    if (legacy) assert.match((await pool.query("SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid='order_lines'::regclass AND tgname='trg_min_per_reference'")).rows[0].def, /BEFORE INSERT/);
    let counter = 0;
    async function order(quantities, minOverride = null) {
      const id = 'order' + ++counter;
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        if (minOverride !== null) await db.query('INSERT INTO buyer_brand_terms VALUES ($1,$2,$3) ON CONFLICT(buyer_id,brand_id) DO UPDATE SET min_per_reference_override=$3', ['buyer'+minOverride, '1937b8b8-00d4-4c72-8d03-a83f492db00f', minOverride]);
        await db.query('INSERT INTO orders VALUES ($1,$2,$3)', [id, '1937b8b8-00d4-4c72-8d03-a83f492db00f', minOverride === null ? 'buyer' : 'buyer'+minOverride]);
        for (const [i,q] of quantities.entries()) await db.query('INSERT INTO order_lines VALUES ($1,$2,$3,$4,$5,$6)', [id+'line'+i,id,i ? 'p2':'p',q,i ? '16-18"':'7"',i ? 'Silver':'Gold']);
        await db.query('COMMIT');
      } catch(e) { await db.query('ROLLBACK'); throw e; }
      finally { db.release(); }
      return id;
    }
    for (const q of [1,2]) await assert.rejects(order([q]), e => e.code === '23514' && e.constraint === 'min_per_reference');
    await order([3]);
    await order([1],1);
    await assert.rejects(order([1],2), e => e.code === '23514');
    await order([2],2);
    const split = await order([2,1]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1',[split])).rows[0].n,2);
    await assert.rejects(pool.query('UPDATE order_lines SET quantity=1 WHERE id=$1',[split+'line0']),e => e.code === '23514');
    await pool.query('DELETE FROM orders WHERE id=$1',[split]);
    await pool.query('UPDATE brands SET min_per_reference=2');
    await migrateMinReference(pool);
    assert.equal((await pool.query('SELECT min_per_reference FROM brands')).rows[0].min_per_reference,2);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
