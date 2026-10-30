'use strict';

// Additive, transactional and rerunnable. Never infer grants or commercial terms.
async function migrateAdminCommercial(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('admin-commercial-v1'))");
    await db.query(`
      ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS client_country TEXT DEFAULT '';
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS client_country TEXT DEFAULT '';
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS parent_agent_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT;
      CREATE TABLE IF NOT EXISTS agent_scope_grants (
        staff_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
        country_code TEXT NOT NULL CHECK (country_code = '*' OR country_code ~ '^[A-Z]{2}$'),
        PRIMARY KEY (staff_id, brand_id, country_code)
      );
      CREATE TABLE IF NOT EXISTS wholesale_commissions (
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
        order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT,
        beneficiary_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('agency_receivable','agent_payable','subagent_payable')),
        country_code TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
        currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        basis_kind TEXT NOT NULL CHECK (basis_kind IN ('ordered_net','invoiced_net','collected_net','manual_net')),
        basis_amount NUMERIC(16,2) NOT NULL CHECK (basis_amount >= 0),
        rate_percent NUMERIC(7,4) NOT NULL CHECK (rate_percent BETWEEN 0 AND 100),
        amount NUMERIC(16,2) GENERATED ALWAYS AS (round(basis_amount * rate_percent / 100, 2)) STORED,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','invoiced','paid','cancelled')),
        source_reference TEXT NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        version INTEGER NOT NULL DEFAULT 1,
        CHECK ((kind = 'agency_receivable' AND beneficiary_id IS NULL) OR (kind <> 'agency_receivable' AND beneficiary_id IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS wholesale_commission_events (
        id BIGSERIAL PRIMARY KEY,
        commission_id TEXT NOT NULL REFERENCES wholesale_commissions(id) ON DELETE RESTRICT,
        actor TEXT NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        reference TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wholesale_beneficiary ON wholesale_commissions(beneficiary_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wholesale_brand ON wholesale_commissions(brand_id, created_at DESC);
    `);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e; // Permission/schema errors must stop startup, never silently skip.
  } finally { db.release(); }
}
module.exports = { migrateAdminCommercial };
