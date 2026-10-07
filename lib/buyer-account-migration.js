async function migrateBuyerAccounts(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:buyer-company:v1'))");
    await db.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_po_number TEXT DEFAULT '';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS commercial_snapshot JSONB;
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS activation_pending BOOLEAN DEFAULT false;
      ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS workflow_stage TEXT DEFAULT 'proposed';
      ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS linked_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL;
      ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS proposal_conditions TEXT DEFAULT '';
      ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS buyer_comment TEXT DEFAULT '';
      ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS buyer_approved_at TIMESTAMPTZ;
      ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS agency_validated_at TIMESTAMPTZ;
      UPDATE agent_selections SET workflow_stage='draft' WHERE status='draft' AND used=false AND workflow_stage='proposed';
      CREATE INDEX IF NOT EXISTS idx_agent_selections_order ON agent_selections(linked_order_id);
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', billing JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE buyers ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
      CREATE TABLE IF NOT EXISTS company_users (
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'buyer' CHECK(role IN ('owner','buyer')),
        PRIMARY KEY(company_id,buyer_id)
      );
      CREATE TABLE IF NOT EXISTS company_locations (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name TEXT NOT NULL, shipping JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS company_locations_company_idx ON company_locations(company_id);
      CREATE INDEX IF NOT EXISTS company_users_buyer_idx ON company_users(buyer_id);
      CREATE TABLE IF NOT EXISTS company_invites (
        token_hash TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'buyer' CHECK(role IN ('owner','buyer')),
        invited_by TEXT REFERENCES buyers(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS company_invites_company_idx ON company_invites(company_id);
      CREATE TABLE IF NOT EXISTS buying_shortlists (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
        company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
        name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', product_ids JSONB NOT NULL DEFAULT '[]',
        shared BOOLEAN NOT NULL DEFAULT false, ready_for_review BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS buying_shortlists_owner_idx ON buying_shortlists(owner_id);
      CREATE INDEX IF NOT EXISTS buying_shortlists_company_idx ON buying_shortlists(company_id) WHERE shared=true;
      -- Never merge retailers by their free-text name: each legacy buyer gets
      -- an isolated company until another user explicitly accepts an invite.
      INSERT INTO companies(id,name) SELECT 'legacy:'||id,company FROM buyers WHERE company_id IS NULL
        ON CONFLICT(id) DO NOTHING;
      UPDATE buyers SET company_id='legacy:'||id WHERE company_id IS NULL;
      INSERT INTO company_users(company_id,buyer_id,role) SELECT company_id,id,'owner' FROM buyers
        WHERE company_id IS NOT NULL ON CONFLICT(company_id,buyer_id) DO NOTHING;
    `);
    await db.query('COMMIT');
  } catch(e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}
module.exports={migrateBuyerAccounts};
