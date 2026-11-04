'use strict';
async function migrateRetention(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:engagement-retention:v1'))");
    await db.query(`CREATE TABLE IF NOT EXISTS buyer_engagement_retention_runs (
      id UUID PRIMARY KEY,request_key UUID NOT NULL UNIQUE,
      trigger TEXT NOT NULL CHECK(trigger IN ('startup','scheduled','manual')),
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial','skipped_busy','failed','interrupted')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ,
      counts JSONB NOT NULL DEFAULT '{}',remaining JSONB NOT NULL DEFAULT '{}',error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS engagement_retention_finished ON buyer_engagement_retention_runs(finished_at);
    CREATE INDEX IF NOT EXISTS interest_candidate_age ON buyer_brand_interest_candidates(created_at);
    CREATE INDEX IF NOT EXISTS interest_run_age ON buyer_brand_interest_runs(created_at);
    CREATE INDEX IF NOT EXISTS cart_candidate_age ON buyer_cart_simulation_candidates(created_at);
    CREATE INDEX IF NOT EXISTS cart_run_age ON buyer_cart_simulation_runs(created_at);`);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
module.exports={migrateRetention};
