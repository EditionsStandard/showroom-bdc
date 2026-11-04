'use strict';
async function migrateTemplateSignoffs(pool){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:engagement-template-signoffs:v1'))");await db.query(`
 CREATE TABLE IF NOT EXISTS buyer_engagement_template_signoffs(
 rule_id TEXT NOT NULL,lang TEXT NOT NULL,template_version INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),decision TEXT NOT NULL CHECK(decision IN ('approved','revoked')),
 scope TEXT NOT NULL DEFAULT 'editorial_only' CHECK(scope='editorial_only'),content_hash TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),decided_by TEXT NOT NULL,decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(rule_id,lang,template_version),FOREIGN KEY(rule_id,lang,template_version) REFERENCES buyer_engagement_templates(rule_id,lang,version) ON DELETE CASCADE
 );
 CREATE TABLE IF NOT EXISTS buyer_engagement_template_signoff_operations(
 request_key UUID PRIMARY KEY,rule_id TEXT NOT NULL,lang TEXT NOT NULL,template_version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('saved','cancelled')),body_hash TEXT,revision INTEGER,
 decision TEXT CHECK(decision IN ('approved','revoked')),reason TEXT,content_hash TEXT,actor TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(rule_id,lang,template_version) REFERENCES buyer_engagement_templates(rule_id,lang,version) ON DELETE CASCADE,
 CHECK((status='saved' AND body_hash IS NOT NULL AND revision IS NOT NULL AND decision IS NOT NULL AND reason IS NOT NULL AND content_hash IS NOT NULL) OR (status='cancelled' AND revision IS NULL))
 );CREATE INDEX IF NOT EXISTS template_signoff_operations_scope ON buyer_engagement_template_signoff_operations(rule_id,lang,template_version,created_at DESC);`);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
module.exports={migrateTemplateSignoffs};
