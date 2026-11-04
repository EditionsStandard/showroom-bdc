'use strict';
async function migrateBuyerEngagementPreparation(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:buyer-engagement-preparation:v1'))");
    await db.query(`
      CREATE TABLE IF NOT EXISTS buyer_engagement_preparation_control (
        id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), paused BOOLEAN NOT NULL DEFAULT true,
        delivery_enabled BOOLEAN NOT NULL DEFAULT false CHECK(delivery_enabled=false),
        version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO buyer_engagement_preparation_control(id) VALUES(true) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS buyer_engagement_preparation_enqueue_operations (
        request_key UUID PRIMARY KEY, created_count INTEGER NOT NULL, reused_count INTEGER NOT NULL,
        rejected_count INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS buyer_engagement_preparation_jobs (
        id UUID PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        candidate_id UUID REFERENCES buyer_engagement_simulation_candidates(id) ON DELETE SET NULL,
        rule_id TEXT NOT NULL REFERENCES buyer_engagement_rules(id) CHECK(rule_id IN ('welcome','inactive')),
        scope_key TEXT NOT NULL DEFAULT 'buyer' CHECK(scope_key='buyer'), anchor_at TIMESTAMPTZ NOT NULL,
        mode TEXT NOT NULL DEFAULT 'dry_run' CHECK(mode='dry_run'),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reserved','simulated','cancelled','failed')),
        reason VARCHAR(80) NOT NULL DEFAULT 'prepared',
        rule_version INTEGER NOT NULL, delay_hours INTEGER NOT NULL,
        template_lang TEXT NOT NULL, template_version INTEGER NOT NULL, activation_pending_snapshot BOOLEAN NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_token UUID, lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checked_at TIMESTAMPTZ,
        UNIQUE(buyer_id,rule_id,anchor_at,scope_key),
        CHECK((status='reserved' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR (status<>'reserved' AND lease_token IS NULL AND lease_expires_at IS NULL)),
        FOREIGN KEY(rule_id,template_lang,template_version) REFERENCES buyer_engagement_templates(rule_id,lang,version)
      );
      CREATE INDEX IF NOT EXISTS preparation_jobs_buyer ON buyer_engagement_preparation_jobs(buyer_id);
      CREATE INDEX IF NOT EXISTS preparation_jobs_due ON buyer_engagement_preparation_jobs(status,next_attempt_at,created_at);
      CREATE TABLE IF NOT EXISTS buyer_engagement_preparation_events (
        id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL REFERENCES buyer_engagement_preparation_jobs(id) ON DELETE CASCADE,
        event TEXT NOT NULL CHECK(event IN ('enqueued','reserved','lease_recovered','released','simulated','cancelled','retry_scheduled','failed')),
        reason VARCHAR(80) NOT NULL, attempt_count INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS preparation_events_job ON buyer_engagement_preparation_events(job_id,id);
    `);
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
module.exports={migrateBuyerEngagementPreparation};
