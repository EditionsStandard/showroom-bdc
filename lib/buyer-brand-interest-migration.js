'use strict';
async function migrateBrandInterest(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:brand-interest:v1'))");
    await db.query(`
      ALTER TABLE buyer_engagement_rules ADD COLUMN IF NOT EXISTS min_distinct_days INTEGER NOT NULL DEFAULT 3 CHECK(min_distinct_days BETWEEN 2 AND 30);
      CREATE TABLE IF NOT EXISTS buyer_interest_preferences (
        buyer_id TEXT PRIMARY KEY REFERENCES buyers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('granted','denied')), version INTEGER NOT NULL CHECK(version>0),
        notice_version TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS buyer_interest_preference_events (
        buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE, version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('granted','denied')), notice_version TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(buyer_id,version)
      );
      CREATE TABLE IF NOT EXISTS buyer_brand_interest_days (
        buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        visit_day DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), consent_version INTEGER NOT NULL,
        PRIMARY KEY(buyer_id,brand_id,visit_day)
      );
      CREATE INDEX IF NOT EXISTS brand_interest_observed ON buyer_brand_interest_days(observed_at);
      CREATE TABLE IF NOT EXISTS buyer_brand_interest_runs (
        id UUID PRIMARY KEY, request_key UUID NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('generate','recheck')),
        mode TEXT NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scanned_count INTEGER NOT NULL, created_count INTEGER NOT NULL, rechecked_count INTEGER NOT NULL,
        eligible_count INTEGER NOT NULL, excluded_count INTEGER NOT NULL, rule_snapshot JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS buyer_brand_interest_candidates (
        id UUID PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),
        status TEXT NOT NULL CHECK(status IN ('eligible','excluded')), reason TEXT NOT NULL,
        distinct_days INTEGER NOT NULL, first_observed_at TIMESTAMPTZ, last_observed_at TIMESTAMPTZ,
        rule_version INTEGER NOT NULL, window_hours INTEGER NOT NULL, min_distinct_days INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_run_id UUID REFERENCES buyer_brand_interest_runs(id) ON DELETE SET NULL,
        UNIQUE(buyer_id,brand_id)
      );
      CREATE TABLE IF NOT EXISTS buyer_brand_interest_checks (
        candidate_id UUID NOT NULL REFERENCES buyer_brand_interest_candidates(id) ON DELETE CASCADE,
        run_id UUID NOT NULL REFERENCES buyer_brand_interest_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('eligible','excluded')), reason TEXT NOT NULL,
        distinct_days INTEGER NOT NULL, first_observed_at TIMESTAMPTZ, last_observed_at TIMESTAMPTZ,
        rule_version INTEGER NOT NULL, window_hours INTEGER NOT NULL, min_distinct_days INTEGER NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(candidate_id,run_id)
      );
    `);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
module.exports={migrateBrandInterest};
