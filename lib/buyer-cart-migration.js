'use strict';

async function migrateBuyerCart(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:buyer-cart:v1'))");
    await db.query(`
      CREATE TABLE IF NOT EXISTS buyer_cart_states (
        buyer_id TEXT PRIMARY KEY REFERENCES buyers(id) ON DELETE CASCADE,
        cart_id UUID NOT NULL UNIQUE,
        revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0),
        cart_json JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS buyer_cart_cycles (
        cycle_id UUID PRIMARY KEY,
        buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        brand_id TEXT NOT NULL,
        is_current BOOLEAN NOT NULL DEFAULT true,
        revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1),
        state TEXT NOT NULL CHECK(state IN ('open','empty','converted','unknown')),
        provenance TEXT NOT NULL CHECK(provenance IN ('versioned','legacy_unknown','expired')),
        content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        converted_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
        UNIQUE(buyer_id,cycle_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS buyer_cart_current_brand ON buyer_cart_cycles(buyer_id,brand_id) WHERE is_current;
      CREATE INDEX IF NOT EXISTS buyer_cart_cycles_buyer ON buyer_cart_cycles(buyer_id);
      CREATE TABLE IF NOT EXISTS buyer_cart_checkouts (
        buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        request_key UUID NOT NULL,
        request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
        context_hash TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' CHECK(context_hash ~ '^[a-f0-9]{64}$'),
        cart_id UUID NOT NULL,
        expected_cycles JSONB NOT NULL CHECK(jsonb_typeof(expected_cycles)='object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(buyer_id,request_key)
      );
      ALTER TABLE buyer_cart_checkouts ADD COLUMN IF NOT EXISTS context_hash TEXT NOT NULL
        DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' CHECK(context_hash ~ '^[a-f0-9]{64}$');
      CREATE TABLE IF NOT EXISTS buyer_cart_checkout_results (
        buyer_id TEXT NOT NULL,
        request_key UUID NOT NULL,
        brand_id TEXT NOT NULL,
        cycle_id UUID NOT NULL,
        order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
        success BOOLEAN NOT NULL,
        result_json JSONB NOT NULL CHECK(jsonb_typeof(result_json)='object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(buyer_id,request_key,brand_id),
        FOREIGN KEY(buyer_id,request_key) REFERENCES buyer_cart_checkouts(buyer_id,request_key) ON DELETE CASCADE,
        FOREIGN KEY(buyer_id,cycle_id) REFERENCES buyer_cart_cycles(buyer_id,cycle_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS buyer_cart_cycle_one_conversion ON buyer_cart_checkout_results(cycle_id) WHERE success;
      CREATE INDEX IF NOT EXISTS buyer_cart_checkout_results_order ON buyer_cart_checkout_results(order_id) WHERE order_id IS NOT NULL;
    `);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;}
  finally {db.release();}
}

module.exports={migrateBuyerCart};
