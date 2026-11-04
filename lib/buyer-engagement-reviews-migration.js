'use strict';
async function migrateReviews(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:engagement-reviews:v1'))");
    await db.query(`CREATE TABLE IF NOT EXISTS buyer_brand_reviews (
      id UUID PRIMARY KEY,candidate_id UUID NOT NULL UNIQUE REFERENCES buyer_brand_interest_candidates(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version>0),decision TEXT NOT NULL CHECK(decision IN ('review','qualified','dismissed')),
      note TEXT NOT NULL CHECK(length(note)<=2000),links JSONB NOT NULL,evidence JSONB NOT NULL,evidence_hash TEXT NOT NULL,
      updated_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS buyer_brand_review_events (
      review_id UUID NOT NULL REFERENCES buyer_brand_reviews(id) ON DELETE CASCADE,version INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('review','qualified','dismissed')),note TEXT NOT NULL,links JSONB NOT NULL,
      evidence JSONB NOT NULL,evidence_hash TEXT NOT NULL,reviewed_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(review_id,version)
    );
    CREATE TABLE IF NOT EXISTS buyer_brand_review_operations (
      request_key UUID PRIMARY KEY,candidate_id UUID NOT NULL REFERENCES buyer_brand_interest_candidates(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('saved','cancelled')),body_hash TEXT,review_version INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((status='saved' AND body_hash IS NOT NULL AND review_version IS NOT NULL) OR (status='cancelled' AND review_version IS NULL))
    );
    CREATE INDEX IF NOT EXISTS brand_review_operations_candidate ON buyer_brand_review_operations(candidate_id);`);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
module.exports={migrateReviews};
