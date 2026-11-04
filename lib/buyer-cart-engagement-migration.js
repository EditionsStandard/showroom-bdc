'use strict';
async function migrateCartEngagement(pool){
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:cart-engagement:v1'))");
  await db.query(`CREATE TABLE IF NOT EXISTS buyer_cart_simulation_runs(
   id UUID PRIMARY KEY,request_key UUID NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('generate','recheck')),
   mode TEXT NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   scanned_count INTEGER NOT NULL,created_count INTEGER NOT NULL,rechecked_count INTEGER NOT NULL,
   eligible_count INTEGER NOT NULL,excluded_count INTEGER NOT NULL,rule_snapshot JSONB NOT NULL);
  CREATE TABLE IF NOT EXISTS buyer_cart_simulation_candidates(
   id UUID PRIMARY KEY,buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
   brand_id TEXT NOT NULL,cycle_id UUID NOT NULL REFERENCES buyer_cart_cycles(cycle_id) ON DELETE CASCADE,
   cycle_revision BIGINT NOT NULL,content_hash TEXT NOT NULL,
   mode TEXT NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),
   status TEXT NOT NULL CHECK(status IN ('eligible','excluded')),reason TEXT NOT NULL,
   rule_version INTEGER NOT NULL,delay_hours INTEGER NOT NULL,template_lang TEXT NOT NULL,template_version INTEGER,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   last_run_id UUID REFERENCES buyer_cart_simulation_runs(id) ON DELETE SET NULL,
   UNIQUE(cycle_id,cycle_revision,content_hash));
  CREATE INDEX IF NOT EXISTS cart_simulation_buyer ON buyer_cart_simulation_candidates(buyer_id);
  CREATE TABLE IF NOT EXISTS buyer_cart_simulation_checks(
   run_id UUID NOT NULL REFERENCES buyer_cart_simulation_runs(id) ON DELETE CASCADE,
   candidate_id UUID NOT NULL REFERENCES buyer_cart_simulation_candidates(id) ON DELETE CASCADE,
   status TEXT NOT NULL CHECK(status IN ('eligible','excluded')),reason TEXT NOT NULL,
   rule_version INTEGER NOT NULL,delay_hours INTEGER NOT NULL,template_lang TEXT NOT NULL,template_version INTEGER,
   checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(run_id,candidate_id));`);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
module.exports={migrateCartEngagement};
