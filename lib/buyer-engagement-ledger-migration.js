'use strict';

async function migrateBuyerEngagementLedger(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:buyer-engagement-ledger:v1'))");
    await db.query(`
      CREATE TABLE IF NOT EXISTS buyer_engagement_simulation_control (
        id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), paused BOOLEAN NOT NULL DEFAULT false,
        version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO buyer_engagement_simulation_control(id) VALUES(true) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS buyer_engagement_simulation_runs (
        id UUID PRIMARY KEY, request_key UUID NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('generate','recheck')),
        mode TEXT NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scanned_count INTEGER NOT NULL DEFAULT 0, evaluated_count INTEGER NOT NULL DEFAULT 0,
        created_count INTEGER NOT NULL DEFAULT 0, reused_count INTEGER NOT NULL DEFAULT 0,
        excluded_count INTEGER NOT NULL DEFAULT 0, eligible_count INTEGER NOT NULL DEFAULT 0,
        rule_snapshot JSONB NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS buyer_engagement_simulation_candidates (
        id UUID PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL REFERENCES buyer_engagement_rules(id), anchor_at TIMESTAMPTZ NOT NULL,
        mode TEXT NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),
        status TEXT NOT NULL CHECK(status IN ('eligible','excluded')), reason TEXT NOT NULL,
        rule_version INTEGER NOT NULL, delay_hours INTEGER NOT NULL,
        template_lang TEXT NOT NULL, template_version INTEGER NOT NULL,
        first_run_id UUID REFERENCES buyer_engagement_simulation_runs(id) ON DELETE SET NULL,
        last_run_id UUID REFERENCES buyer_engagement_simulation_runs(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(rule_id,buyer_id,anchor_at),
        FOREIGN KEY(rule_id,template_lang,template_version) REFERENCES buyer_engagement_templates(rule_id,lang,version)
      );
      CREATE INDEX IF NOT EXISTS engagement_candidates_buyer ON buyer_engagement_simulation_candidates(buyer_id);
      CREATE TABLE IF NOT EXISTS buyer_engagement_simulation_checks (
        run_id UUID NOT NULL REFERENCES buyer_engagement_simulation_runs(id) ON DELETE CASCADE,
        candidate_id UUID NOT NULL REFERENCES buyer_engagement_simulation_candidates(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('eligible','excluded')), reason TEXT NOT NULL,
        rule_version INTEGER NOT NULL, delay_hours INTEGER NOT NULL,
        template_lang TEXT NOT NULL, template_version INTEGER NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(run_id,candidate_id)
      );
      CREATE INDEX IF NOT EXISTS engagement_checks_candidate ON buyer_engagement_simulation_checks(candidate_id);
    `);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;}
  finally {db.release();}
}
module.exports={migrateBuyerEngagementLedger};
