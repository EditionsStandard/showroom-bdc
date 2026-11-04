'use strict';
async function migrateCRMChecks(pool){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:engagement-crm-checks:v1'))");await db.query(`CREATE TABLE IF NOT EXISTS buyer_brand_crm_checks (
 request_key UUID PRIMARY KEY,candidate_id UUID NOT NULL REFERENCES buyer_brand_interest_candidates(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),review_version INTEGER,source_token TEXT,identity_hash TEXT,links JSONB,
 result JSONB,error_code TEXT,requested_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ,
 CHECK((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL))
 );CREATE INDEX IF NOT EXISTS brand_crm_checks_candidate ON buyer_brand_crm_checks(candidate_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS brand_crm_checks_running ON buyer_brand_crm_checks(created_at) WHERE status='running';`);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
module.exports={migrateCRMChecks};
