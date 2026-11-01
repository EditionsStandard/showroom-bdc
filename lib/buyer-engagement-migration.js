'use strict';

async function migrateBuyerEngagement(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:buyer-engagement:v1'))");
    await db.query(`
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS access_source TEXT NOT NULL DEFAULT 'legacy_unknown';
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMPTZ;
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS last_meaningful_activity_at TIMESTAMPTZ;
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS login_history_known BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS last_engagement_email_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS buyer_email_preferences (
        buyer_id TEXT PRIMARY KEY REFERENCES buyers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('granted','denied','unknown')),
        source TEXT NOT NULL, notice_version TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS buyer_email_preference_events (
        id BIGSERIAL PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('granted','denied','unknown')),
        source TEXT NOT NULL, notice_version TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS buyer_email_preference_events_buyer ON buyer_email_preference_events(buyer_id);
      CREATE TABLE IF NOT EXISTS buyer_engagement_rules (
        id TEXT PRIMARY KEY CHECK(id IN ('welcome','inactive','cart','brand_interest')),
        mode TEXT NOT NULL DEFAULT 'disabled' CHECK(mode IN ('disabled','simulation')),
        delay_hours INTEGER NOT NULL CHECK(delay_hours BETWEEN 1 AND 8760),
        version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS buyer_engagement_templates (
        rule_id TEXT NOT NULL REFERENCES buyer_engagement_rules(id),
        lang TEXT NOT NULL CHECK(lang IN ('fr','en')), version INTEGER NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(rule_id,lang,version)
      );
      INSERT INTO buyer_engagement_rules(id,delay_hours) VALUES
        ('welcome',24),('inactive',720),('cart',48),('brand_interest',168) ON CONFLICT DO NOTHING;
    `);
    // No reconstruction of historic logins or consent from last_seen_at.
    // Seeds are drafts, never delivery templates. Existing edits survive restart.
    for (const rule of ['welcome', 'inactive', 'cart', 'brand_interest']) {
      for (const lang of ['fr', 'en']) {
        await db.query(`INSERT INTO buyer_engagement_templates(rule_id,lang,version,subject,body)
          VALUES($1,$2,1,$3,$4) ON CONFLICT DO NOTHING`, [rule, lang,
          lang === 'fr' ? 'Votre showroom Éditions Standard' : 'Your Éditions Standard showroom',
          lang === 'fr' ? 'Bonjour {{buyer_name}},\nVotre équipe Éditions Standard reste à votre disposition.\n{{portal_url}}'
            : 'Hello {{buyer_name}},\nYour Éditions Standard team is here to help.\n{{portal_url}}']);
      }
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
module.exports = { migrateBuyerEngagement };
