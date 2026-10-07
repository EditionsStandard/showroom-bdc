// Transactional migration: preserve the manually installed production trigger.
// Its BEFORE timing cannot validate a reference split across several lines.
// Reuse its function, with validation deferred until all lines are present.
async function migrateMinReference(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('migration:min-reference:v1'))");
    await db.query(`
      ALTER TABLE brands ADD COLUMN IF NOT EXISTS min_per_reference INTEGER DEFAULT 1;
      ALTER TABLE buyer_brand_terms ADD COLUMN IF NOT EXISTS min_per_reference_override INTEGER;
      UPDATE brands SET min_per_reference=3
      WHERE id='1937b8b8-00d4-4c72-8d03-a83f492db00f'
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key='migration:min-reference:v1');
    `);
    await db.query(`
      CREATE OR REPLACE FUNCTION enforce_min_per_reference() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      DECLARE
        target_order TEXT;
        invalid RECORD;
      BEGIN
        -- Existing production BEFORE trigger remains installed. A dedicated
        -- deferred constraint trigger performs the aggregate validation.
        IF TG_WHEN = 'BEFORE' THEN
          RETURN NEW;
        END IF;
        FOR target_order IN
          SELECT DISTINCT id FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.order_id END,
            CASE WHEN TG_OP <> 'INSERT' THEN OLD.order_id END
          ]) AS affected(id) WHERE id IS NOT NULL
        LOOP
          -- Cascading order deletion leaves nothing to validate.
          PERFORM 1 FROM orders WHERE id=target_order FOR NO KEY UPDATE;
          SELECT p.reference, SUM(l.quantity) AS quantity,
            GREATEST(1, COALESCE(bt.min_per_reference_override, b.min_per_reference, 1)) AS minimum
          INTO invalid
          FROM order_lines l
          JOIN orders o ON o.id=l.order_id
          JOIN brands b ON b.id=o.brand_id
          JOIN products p ON p.id=l.product_id
          LEFT JOIN buyer_brand_terms bt ON bt.brand_id=o.brand_id AND bt.buyer_id=o.buyer_id
          WHERE l.order_id=target_order
          GROUP BY p.reference, bt.min_per_reference_override, b.min_per_reference
          HAVING SUM(l.quantity) < GREATEST(1, COALESCE(bt.min_per_reference_override, b.min_per_reference, 1))
          LIMIT 1;
          IF FOUND THEN
            RAISE EXCEPTION 'Reference % requires at least % pieces (current: %)',
              invalid.reference, invalid.minimum, invalid.quantity
              USING ERRCODE='23514', CONSTRAINT='min_per_reference';
          END IF;
        END LOOP;
        RETURN NULL;
      END;
      $function$;
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='order_lines'::regclass
                       AND tgname='trg_min_per_reference' AND NOT tgisinternal) THEN
          CREATE CONSTRAINT TRIGGER trg_min_per_reference
            AFTER INSERT OR UPDATE OR DELETE ON order_lines
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
            EXECUTE FUNCTION enforce_min_per_reference();
        ELSIF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='order_lines'::regclass
                         AND tgname='trg_min_per_reference' AND tgdeferrable AND tginitdeferred)
          AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='order_lines'::regclass
                          AND tgname='trg_min_per_reference_aggregate') THEN
          CREATE CONSTRAINT TRIGGER trg_min_per_reference_aggregate
            AFTER INSERT OR UPDATE OR DELETE ON order_lines
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
            EXECUTE FUNCTION enforce_min_per_reference();
        END IF;
      END;
      $migration$;
      INSERT INTO settings(key,value) VALUES ('migration:min-reference:v1','complete')
        ON CONFLICT (key) DO NOTHING;
    `);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

module.exports = { migrateMinReference };
