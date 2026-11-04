'use strict';
async function migrateEmailLinks(pool){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:engagement-email-links:v1'))");await db.query(`
 CREATE TABLE IF NOT EXISTS buyer_engagement_unsubscribe_links(
 token_hash TEXT PRIMARY KEY,outbox_id UUID UNIQUE REFERENCES buyer_engagement_outbox(id) ON DELETE SET NULL,
 buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,email_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '365 days',last_used_at TIMESTAMPTZ);
 CREATE INDEX IF NOT EXISTS engagement_unsubscribe_buyer ON buyer_engagement_unsubscribe_links(buyer_id);
 CREATE INDEX IF NOT EXISTS engagement_unsubscribe_expiry ON buyer_engagement_unsubscribe_links(expires_at);
 CREATE TABLE IF NOT EXISTS buyer_engagement_activation_links(
 token_hash TEXT PRIMARY KEY REFERENCES buyer_password_resets(token) ON DELETE CASCADE,
 outbox_id UUID UNIQUE REFERENCES buyer_engagement_outbox(id) ON DELETE SET NULL,
 buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,email_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '60 minutes');
 ALTER TABLE buyer_engagement_activation_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
 UPDATE buyer_engagement_activation_links SET expires_at=created_at+INTERVAL '60 minutes' WHERE expires_at IS NULL;
 ALTER TABLE buyer_engagement_activation_links ALTER COLUMN expires_at SET DEFAULT NOW()+INTERVAL '60 minutes';
 ALTER TABLE buyer_engagement_activation_links ALTER COLUMN expires_at SET NOT NULL;
 CREATE INDEX IF NOT EXISTS engagement_activation_buyer ON buyer_engagement_activation_links(buyer_id);
 CREATE INDEX IF NOT EXISTS engagement_activation_expiry ON buyer_engagement_activation_links(expires_at);
 `);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
module.exports={migrateEmailLinks};
