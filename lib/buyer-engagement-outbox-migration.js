'use strict';
async function migrateOutbox(pool){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:engagement-outbox:v1'))");await db.query(`
 CREATE TABLE IF NOT EXISTS buyer_engagement_outbox_control(id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),paused BOOLEAN NOT NULL DEFAULT true,
 delivery_enabled BOOLEAN NOT NULL DEFAULT false CHECK(delivery_enabled=false),version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 INSERT INTO buyer_engagement_outbox_control(id) VALUES(true) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS buyer_engagement_outbox(
 id UUID PRIMARY KEY,buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,preparation_job_id UUID REFERENCES buyer_engagement_preparation_jobs(id) ON DELETE SET NULL,
 rule_id TEXT NOT NULL CHECK(rule_id IN ('welcome','inactive')),scope_key TEXT NOT NULL DEFAULT 'buyer' CHECK(scope_key='buyer'),anchor_at TIMESTAMPTZ NOT NULL,
 mode TEXT NOT NULL DEFAULT 'isolated_transport' CHECK(mode='isolated_transport'),status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','reserved','submitting','uncertain','accepted','rejected','cancelled')),
 reason TEXT NOT NULL DEFAULT 'staged',rule_version INTEGER NOT NULL,delay_hours INTEGER NOT NULL,template_lang TEXT NOT NULL,template_version INTEGER NOT NULL,
 template_hash TEXT NOT NULL,signoff_revision INTEGER NOT NULL,activation_pending_snapshot BOOLEAN NOT NULL,identity_hash TEXT NOT NULL,
 provider_key TEXT NOT NULL UNIQUE,message_hash TEXT,sealed_payload JSONB,first_attempt_at TIMESTAMPTZ,attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
 provider_id UUID,needs_attention BOOLEAN NOT NULL DEFAULT false,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),lease_token UUID,lease_expires_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(buyer_id,rule_id,scope_key,anchor_at),FOREIGN KEY(rule_id,template_lang,template_version) REFERENCES buyer_engagement_templates(rule_id,lang,version),
 CHECK((status IN ('reserved','submitting') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status NOT IN ('reserved','submitting') AND lease_token IS NULL AND lease_expires_at IS NULL)),
 CHECK((attempt_count=0 AND first_attempt_at IS NULL) OR (attempt_count>0 AND first_attempt_at IS NOT NULL AND message_hash IS NOT NULL)),
 CHECK(status<>'accepted' OR provider_id IS NOT NULL));
 CREATE INDEX IF NOT EXISTS engagement_outbox_due ON buyer_engagement_outbox(status,next_attempt_at,created_at);
 CREATE INDEX IF NOT EXISTS engagement_outbox_buyer ON buyer_engagement_outbox(buyer_id,first_attempt_at);
 CREATE TABLE IF NOT EXISTS buyer_engagement_outbox_attempts(
 id UUID PRIMARY KEY,outbox_id UUID NOT NULL REFERENCES buyer_engagement_outbox(id) ON DELETE CASCADE,attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
 lease_token UUID NOT NULL,message_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'submitting' CHECK(status IN ('submitting','accepted','rejected','uncertain')),
 provider_id UUID,reason TEXT NOT NULL DEFAULT 'authorized',authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ,
 UNIQUE(outbox_id,attempt_no),CHECK(status<>'accepted' OR provider_id IS NOT NULL));
 CREATE TABLE IF NOT EXISTS buyer_engagement_outbox_events(id BIGSERIAL PRIMARY KEY,outbox_id UUID NOT NULL REFERENCES buyer_engagement_outbox(id) ON DELETE CASCADE,
 event TEXT NOT NULL,reason TEXT NOT NULL,attempt_no INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS outbox_events_parent ON buyer_engagement_outbox_events(outbox_id,id);
 CREATE TABLE IF NOT EXISTS buyer_engagement_outbox_operations(request_key UUID PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('stage','recover')),source_id UUID,
 outbox_id UUID REFERENCES buyer_engagement_outbox(id) ON DELETE CASCADE,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
module.exports={migrateOutbox};
