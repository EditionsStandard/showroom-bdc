'use strict';
async function migrateProviderEvents(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:engagement-provider:v1'))");
    await db.query(`
      CREATE TABLE IF NOT EXISTS buyer_engagement_provider_messages (
        provider_kind TEXT NOT NULL CHECK(provider_kind IN ('local_fixture','resend')),
        provider_id UUID NOT NULL, outbox_id UUID NOT NULL UNIQUE REFERENCES buyer_engagement_outbox(id) ON DELETE CASCADE,
        buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE, recipient_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_event_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, delayed_at TIMESTAMPTZ,
        bounced_at TIMESTAMPTZ, complained_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, suppressed_at TIMESTAMPTZ,
        PRIMARY KEY(provider_kind,provider_id));
      CREATE INDEX IF NOT EXISTS engagement_provider_message_buyer ON buyer_engagement_provider_messages(buyer_id);
      CREATE INDEX IF NOT EXISTS engagement_provider_message_recipient ON buyer_engagement_provider_messages(provider_kind,recipient_hash);
      CREATE TABLE IF NOT EXISTS buyer_engagement_provider_receipts (
        provider_kind TEXT NOT NULL CHECK(provider_kind IN ('local_fixture','resend')), delivery_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, event_type TEXT NOT NULL, event_at TIMESTAMPTZ NOT NULL, provider_id UUID,
        outbox_id UUID REFERENCES buyer_engagement_outbox(id) ON DELETE CASCADE,
        buyer_id TEXT REFERENCES buyers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('unmatched','applied','mismatch')),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(provider_kind,delivery_id));
      CREATE INDEX IF NOT EXISTS engagement_provider_receipt_expiry ON buyer_engagement_provider_receipts(expires_at);
      CREATE INDEX IF NOT EXISTS engagement_provider_receipt_buyer ON buyer_engagement_provider_receipts(buyer_id);
      CREATE TABLE IF NOT EXISTS buyer_engagement_provider_blocks (
        provider_kind TEXT NOT NULL CHECK(provider_kind IN ('local_fixture','resend')),
        buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE, recipient_hash TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('bounced','bounce_unclassified','complained','suppressed','suppression_added')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_event_at TIMESTAMPTZ NOT NULL,
        removal_notice_at TIMESTAMPTZ,
        PRIMARY KEY(provider_kind,buyer_id,recipient_hash));
    `);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
module.exports={migrateProviderEvents};
