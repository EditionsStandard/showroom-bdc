const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function init() {
  // Tables créées dans l'ordre des dépendances (clés étrangères) :
  // d'abord les tables de base, puis celles qui les référencent, puis les colonnes ALTER.

  // 1) Tables de base
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logo_url TEXT DEFAULT '',
      logo TEXT DEFAULT '',
      cover_image TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT DEFAULT '',
      company TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      country TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      reference TEXT NOT NULL,
      description TEXT DEFAULT '',
      color TEXT DEFAULT '',
      sizes TEXT DEFAULT '',
      price NUMERIC DEFAULT 0,
      image_url TEXT DEFAULT '',
      collection_name TEXT DEFAULT '',
      composition TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id),
      client_name TEXT NOT NULL,
      client_email TEXT NOT NULL,
      client_company TEXT DEFAULT '',
      client_phone TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_lines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      size TEXT DEFAULT '',
      quantity INTEGER NOT NULL,
      unit_price NUMERIC NOT NULL,
      price_retail NUMERIC DEFAULT 0
    );
  `).catch(() => {});

  // Cache des traductions de contenu (bios, désignations…) — 1 appel API par texte/langue
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_translations (
      source_hash TEXT NOT NULL,
      lang TEXT NOT NULL,
      translated TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (source_hash, lang)
    );
  `).catch(() => {});

  // 2) Tables dépendantes (référencent brands/products/orders/buyers)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_stats (
      product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      views INTEGER DEFAULT 0,
      cart_adds INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyer_carts (
      buyer_id TEXT PRIMARY KEY REFERENCES buyers(id) ON DELETE CASCADE,
      cart_json TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS selection_shares (
      token TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      items_json TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    );
  `).catch(() => {});

  // Sélections préparées par un agent pour un acheteur (mode "Sélection agent")
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_selections (
      token TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      client_name TEXT DEFAULT '',
      client_email TEXT NOT NULL,
      client_company TEXT DEFAULT '',
      items_json TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_invite_links (
      token TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seasons (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      client_name TEXT NOT NULL,
      client_email TEXT NOT NULL,
      client_phone TEXT DEFAULT '',
      slot_date DATE NOT NULL,
      slot_time TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (brand_id, slot_date, slot_time)
    );
  `).catch(() => {});

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'appointments_brand_slot_unique'
      ) THEN
        ALTER TABLE appointments ADD CONSTRAINT appointments_brand_slot_unique UNIQUE (brand_id, slot_date, slot_time);
      END IF;
    END $$;
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
      name TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyer_magic_links (
      token TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyer_password_resets (
      token TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyer_access_tokens (
      token TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(() => {});

  // Colonnes additionnelles — exécutées APRÈS les CREATE TABLE pour qu'elles
  // s'appliquent dès le 1er démarrage sur une base fraîche.
  // Chaque ALTER est exécuté SÉPARÉMENT : en PG, un bloc multi-statements est
  // une seule transaction, donc un seul échec annulerait toutes les autres colonnes.
  const alters = [
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS thumbnail TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS collection_name TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS composition TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT DEFAULT '[]'",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS variants TEXT DEFAULT '[]'",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS price_retail NUMERIC DEFAULT 0",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS video_url TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS logo TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS cover_image TEXT DEFAULT ''",
    "ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS price_retail NUMERIC DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_signature TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS cgv_accepted INTEGER DEFAULT 0",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS cgv_text TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS moq_qty INTEGER DEFAULT 0",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS moq_amount NUMERIC DEFAULT 0",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS moq_strict BOOLEAN DEFAULT false",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_country TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'confirmed'",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial'",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS subscription_price_id TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS about_text TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS lookbook_url TEXT DEFAULT ''",
    "ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_id TEXT REFERENCES buyers(id) ON DELETE SET NULL",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS season_id TEXT REFERENCES seasons(id) ON DELETE SET NULL",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS lang TEXT DEFAULT 'fr'",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT DEFAULT ''",
    "CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1",
    "ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS selection_number TEXT DEFAULT ''",
    "CREATE SEQUENCE IF NOT EXISTS selection_number_seq START 1",
    `CREATE TABLE IF NOT EXISTS access_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT NOT NULL,
      country TEXT DEFAULT '',
      instagram TEXT DEFAULT '',
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    "ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS instagram TEXT DEFAULT ''",
    "ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS website TEXT DEFAULT ''",
    "ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT ''",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS internal_notes TEXT DEFAULT ''",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS favorites_json TEXT DEFAULT '[]'",
    "ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent'",
    "ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS draft_name TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS default_currency TEXT DEFAULT ''",
    "ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false",
    "ALTER TABLE appointments ADD COLUMN IF NOT EXISTS video_link TEXT DEFAULT ''",
    `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, subscription_json TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
    "ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS is_template BOOLEAN DEFAULT false",
    "ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS template_name TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS internal_notes TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_qty INTEGER DEFAULT NULL",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_window TEXT DEFAULT ''",
    // Demandes de lien de partage émises par les marques (designer) → traitées par l'agence
    `CREATE TABLE IF NOT EXISTS share_requests (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      requested_by TEXT DEFAULT '',
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
  for (const sql of alters) {
    await pool.query(sql).catch(e => console.error('Migration colonne ignorée:', e.message.split('\n')[0]));
  }

  // Table timeline événements commande
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});

  // Table audit log admin
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      user_email TEXT,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});

  // Table historique des statuts de commande
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_status_history (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      old_status TEXT DEFAULT '',
      new_status TEXT NOT NULL,
      changed_by TEXT DEFAULT '',
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});

  // Backfill: brands existantes sans statut → 'trial' (évite qu'elles soient masquées du portail)
  await pool.query("UPDATE brands SET subscription_status = 'trial' WHERE subscription_status IS NULL").catch(() => {});

  const defaults = {
    showroom_name: 'Editions Standard',
    current_season: 'SS27',
    showroom_email: '',
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_pass: '',
    smtp_from: '',
    admin_password: process.env.ADMIN_PASSWORD || 'admin123',
    agent_name: '',
    agent_title: 'Agent Commercial',
    agent_phone: '',
    cgv_text: "La présente proposition de commande ne constitue pas un engagement ferme. Elle ne sera définitive qu'après acceptation écrite de la marque et signature du bon de commande par les deux parties (acheteur et agent/showroom). L'acheteur s'engage à maintenir sa sélection pendant 15 jours ouvrés à compter de la date de signature. Les prix sont indiqués en euros HT. Tout désistement après accord bilatéral pourra faire l'objet de pénalités. Les conditions de paiement et de livraison seront précisées dans le bon de commande définitif signé par les deux parties.",
    currencies_json: JSON.stringify([
      { code: 'EUR', symbol: '€', rate: 1 },
      { code: 'USD', symbol: '$', rate: 1.08 },
      { code: 'GBP', symbol: '£', rate: 0.86 },
      { code: 'JPY', symbol: '¥', rate: 160 },
      { code: 'CHF', symbol: 'Fr', rate: 0.93 },
      { code: 'CAD', symbol: 'CA$', rate: 1.47 },
      { code: 'AUD', symbol: 'A$', rate: 1.63 },
      { code: 'DKK', symbol: 'kr', rate: 7.46 },
      { code: 'SEK', symbol: 'kr', rate: 11.4 },
      { code: 'NOK', symbol: 'kr', rate: 11.5 },
      { code: 'KRW', symbol: '₩', rate: 1450 },
      { code: 'CNY', symbol: '¥', rate: 7.8 },
    ])
  };

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }

  // Migration: add new currencies to existing installs without overwriting user-defined rates
  {
    const existing = await pool.query("SELECT value FROM settings WHERE key='currencies_json'").catch(() => ({ rows: [] }));
    if (existing.rows[0]) {
      try {
        const curr = JSON.parse(existing.rows[0].value);
        const codes = curr.map(c => c.code);
        const toAdd = [
          { code: 'JPY', symbol: '¥', rate: 160 },
          { code: 'CHF', symbol: 'Fr', rate: 0.93 },
          { code: 'CAD', symbol: 'CA$', rate: 1.47 },
          { code: 'AUD', symbol: 'A$', rate: 1.63 },
          { code: 'DKK', symbol: 'kr', rate: 7.46 },
          { code: 'SEK', symbol: 'kr', rate: 11.4 },
          { code: 'NOK', symbol: 'kr', rate: 11.5 },
          { code: 'KRW', symbol: '₩', rate: 1450 },
          { code: 'CNY', symbol: '¥', rate: 7.8 },
        ].filter(c => !codes.includes(c.code));
        if (toAdd.length) {
          await pool.query("UPDATE settings SET value=$1 WHERE key='currencies_json'", [JSON.stringify([...curr, ...toAdd])]);
        }
      } catch(e) { console.error('currencies migration error:', e.message); }
    }
  }

  // Nettoyage des tokens expirés
  await pool.query(`
    DELETE FROM buyer_magic_links WHERE expires_at < NOW() - INTERVAL '7 days';
    DELETE FROM buyer_password_resets WHERE expires_at < NOW() - INTERVAL '7 days';
  `).catch(() => {});

  await pool.query(`
    DELETE FROM buyer_access_tokens WHERE expires_at < NOW() - INTERVAL '7 days';
    DELETE FROM selection_shares WHERE expires_at < NOW() - INTERVAL '7 days';
    DELETE FROM agent_selections WHERE expires_at < NOW() - INTERVAL '30 days';
    DELETE FROM buyer_carts WHERE updated_at < NOW() - INTERVAL '90 days';
    DELETE FROM access_requests WHERE status='pending' AND created_at < NOW() - INTERVAL '30 days';
  `).catch(() => {});

  // Index pour les performances — exécutés SÉPARÉMENT (comme les ALTER) pour
  // qu'un index en échec ne bloque pas la création des autres.
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id)',
    'CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)',
    'CREATE INDEX IF NOT EXISTS idx_orders_buyer_id ON orders(buyer_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_brand_id ON orders(brand_id)',
    'CREATE INDEX IF NOT EXISTS idx_order_lines_order_id ON order_lines(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointments_brand_id ON appointments(brand_id)',
    // product_id : très sollicité (EXISTS "produit utilisé ?", jointures lignes/produits)
    'CREATE INDEX IF NOT EXISTS idx_order_lines_product_id ON order_lines(product_id)',
    // filtres récurrents sur les commandes (stats, dashboard, listes triées)
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
    'CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)',
    // sélections agent : cloisonnement marque + filtres brouillons/templates
    'CREATE INDEX IF NOT EXISTS idx_agent_selections_brand_id ON agent_selections(brand_id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_selections_status ON agent_selections(status)',
    // timelines de commande
    'CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id)',
    // archivage/restauration par saison
    'CREATE INDEX IF NOT EXISTS idx_products_season_id ON products(season_id)',
    // déduplication des demandes d'accès en attente
    'CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status)',
    // upsert import CSV (recherche par marque + référence)
    'CREATE INDEX IF NOT EXISTS idx_products_brand_reference ON products(brand_id, reference)',
    // demandes de lien de partage en attente (vue agence)
    'CREATE INDEX IF NOT EXISTS idx_share_requests_status ON share_requests(status)',
  ];
  for (const sql of indexes) {
    await pool.query(sql).catch(e => console.error('Index création ignorée:', e.message.split('\n')[0]));
  }
}

module.exports = { pool, init };
