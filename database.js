const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Sans ce handler, une erreur sur un client idle du pool (reset réseau, etc.)
// remonte comme exception non interceptée et plante tout le process — piège
// classique de node-postgres, documenté dans son propre README. Logger et
// continuer : le pool recrée les connexions mortes tout seul.
pool.on('error', (err) => {
  console.error('[pg-pool] Erreur client idle :', err.message);
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
    "ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN DEFAULT false",
    "ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ",
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
    "ALTER TABLE agent_selections ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS delivery_terms TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS payment_terms TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS order_deadline DATE DEFAULT NULL",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS return_terms TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS is_sample BOOLEAN DEFAULT false",
    // Demandes de lien de partage émises par les marques (designer) → traitées par l'agence
    `CREATE TABLE IF NOT EXISTS share_requests (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      requested_by TEXT DEFAULT '',
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Messagerie asynchrone acheteur ↔ agence (un fil par acheteur)
    `CREATE TABLE IF NOT EXISTS buyer_messages (
      id TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_by_buyer BOOLEAN DEFAULT false,
      read_by_staff BOOLEAN DEFAULT false
    )`,
    "CREATE INDEX IF NOT EXISTS idx_buyer_messages_buyer ON buyer_messages(buyer_id, created_at)",
    // P0-04 — liens de commande privés & expirants (/c/:token → marque). Les liens
    // /commande/:brandId directs restent valides (rétrocompat) ; ceci ajoute une
    // méthode de partage à durée limitée.
    `CREATE TABLE IF NOT EXISTS commande_links (
      token TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      active INTEGER DEFAULT 1,
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Sécurité : le PDF de commande publique (flux agent-showroom sans compte
    // acheteur) ne doit plus être accessible par le seul UUID de la commande.
    // pdf_token = clé aléatoire dédiée (jamais l'id) ; pdf_revoked = coupure
    // manuelle depuis l'admin, indépendante de l'expiration 24h.
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS pdf_token TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS pdf_revoked BOOLEAN DEFAULT false",
    // Fiche marque portail : site web, réseaux sociaux, vidéo de marque (optionnels)
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS website TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS instagram TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS facebook TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS tiktok TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS linkedin TEXT DEFAULT ''",
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS video_url TEXT DEFAULT ''",
    // Marques suivies par un acheteur — alerte quand une marque suivie publie
    // une nouvelle collection (voir buyer_notifications ci-dessous).
    `CREATE TABLE IF NOT EXISTS brand_follows (
      buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (buyer_id, brand_id)
    )`,
    `CREATE TABLE IF NOT EXISTS buyer_notifications (
      id TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'new_collection',
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    "CREATE INDEX IF NOT EXISTS idx_buyer_notifications_buyer ON buyer_notifications(buyer_id, created_at DESC)",
    // Accès anticipé : la marque peut réserver sa collection à ses clients
    // privilégiés jusqu'à une date d'ouverture générale. is_privileged vit sur
    // buyer_brand_terms (déjà la table des surcharges par couple acheteur×marque)
    // plutôt que dans une nouvelle table.
    "ALTER TABLE brands ADD COLUMN IF NOT EXISTS early_access_until TIMESTAMPTZ DEFAULT NULL",
    "ALTER TABLE buyer_brand_terms ADD COLUMN IF NOT EXISTS is_privileged BOOLEAN DEFAULT false",
    // Pas de backfill : les commandes déjà existantes sont de toute façon hors de
    // la fenêtre de 24h de l'endpoint public. Les nouvelles commandes reçoivent
    // un pdf_token généré en JS (crypto.randomBytes) à la création.

    // MFA (TOTP) — comptes staff (admin_users). mfa_secret = clé TOTP active,
    // mfa_pending_secret = clé générée pendant l'enrôlement, pas encore confirmée
    // (jamais activée avant vérification d'un code valide, évite un enrôlement
    // "silencieux" par un attaquant ayant momentanément la session). Codes de
    // secours stockés hashés (SHA-256, comme un token de reset), jamais en clair.
    "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mfa_secret TEXT",
    "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT",
    "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT",

    // MFA acheteur — optionnelle (contrairement au staff), activable depuis
    // « Mon profil ». Même schéma, table différente.
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS mfa_secret TEXT",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT false",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT",

    // Signature agent/marque côté commande — jusqu'ici la case « agent »
    // du PDF n'était qu'une ligne à signer à la main, jamais capturée. Une
    // fois signée, la commande devient le bon de commande définitif (double
    // signature) envoyé à l'acheteur.
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_signature TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_signed_at TIMESTAMP",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_signed_by TEXT",
    // Présence en ligne des comptes staff (agent/designer/owner) dans l'admin —
    // même mécanique que buyers.last_seen_at, alimentée par un ping périodique
    // depuis /admin et le PWA /agent.
    "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP",
    // File d'attente de validation manuelle pour les relances automatiques
    // (acheteurs inactifs, sélections non confirmées) — ces relances sont
    // sensibles commercialement et ne doivent plus partir sans regard humain,
    // même si leur détection reste automatique/planifiée.
    `CREATE TABLE IF NOT EXISTS pending_reminders (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      label TEXT DEFAULT '',
      preview TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT DEFAULT ''
    )`,
    "CREATE INDEX IF NOT EXISTS idx_pending_reminders_status ON pending_reminders(status, created_at)",
    // Shortlist — 3e niveau d'intention distinct de favoris et panier
    // (favoris = "j'aime", shortlist = "à montrer/étudier en équipe", panier = "je commande").
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS shortlist_json TEXT DEFAULT '[]'",
    "ALTER TABLE product_stats ADD COLUMN IF NOT EXISTS favorite_adds INTEGER DEFAULT 0",
    "ALTER TABLE product_stats ADD COLUMN IF NOT EXISTS shortlist_adds INTEGER DEFAULT 0",
    // Conditions négociées par acheteur × marque — surcharge optionnelle des
    // conditions par défaut de la marque (payment_terms/delivery_terms/
    // return_terms), un champ vide = pas de surcharge, repli sur la marque.
    `CREATE TABLE IF NOT EXISTS buyer_brand_terms (
      buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      payment_terms TEXT DEFAULT '',
      delivery_terms TEXT DEFAULT '',
      return_terms TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by TEXT DEFAULT '',
      PRIMARY KEY (buyer_id, brand_id)
    )`,
    // Anti-rejeu TOTP : mémorise le pas de temps (30s) du dernier code MFA
    // accepté, pour refuser la réutilisation d'un même code intercepté.
    "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT DEFAULT 0",
    "ALTER TABLE buyers ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT DEFAULT 0",
    // Scoping des notifications push par marque : sans identité du souscripteur,
    // sendPushToAdmins() ne pouvait pas distinguer owner/agent ni la marque de
    // l'agent, et envoyait le contenu de TOUTES les commandes à tout abonné.
    "ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS staff_id TEXT",
    // Pièces jointes messagerie acheteur ↔ agence (photo, PDF) — un message peut
    // désormais porter un fichier, avec ou sans texte d'accompagnement.
    "ALTER TABLE buyer_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT DEFAULT ''",
    "ALTER TABLE buyer_messages ADD COLUMN IF NOT EXISTS attachment_name TEXT DEFAULT ''",
    "ALTER TABLE buyer_messages ADD COLUMN IF NOT EXISTS attachment_type TEXT DEFAULT ''",
    // Détail structuré (JSON) des événements de commande — utilisé pour l'instant
    // par 'lines_edited' : liste des lignes modifiées avec quantité avant/après,
    // pour afficher un vrai historique des quantités plutôt qu'une note générique.
    "ALTER TABLE order_events ADD COLUMN IF NOT EXISTS detail TEXT DEFAULT ''",
    // Surcharges de texte des emails sortants (invitation, relance, accès direct) —
    // une ligne par (template, langue) ; absence de ligne = texte par défaut du code.
    `CREATE TABLE IF NOT EXISTS email_templates (
      template_key TEXT NOT NULL,
      lang TEXT NOT NULL,
      subject TEXT DEFAULT '',
      body TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (template_key, lang)
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

  // Pas de mot de passe par défaut codé en dur (ex. l'ancien 'admin123') : une
  // valeur visible dans le code source est devinable par quiconque a accès au
  // dépôt et suffirait, combinée au fait que l'enrôlement MFA de ce compte n'est
  // pas lui-même vérifié par une preuve d'identité, à prendre durablement le
  // contrôle total du compte owner sur un déploiement fraîchement installé sans
  // ADMIN_PASSWORD défini. Un mot de passe aléatoire est généré et affiché une
  // seule fois dans les logs — uniquement au tout premier démarrage (la ligne
  // 'admin_password' n'existe pas encore en base), pour ne pas ré-imprimer à
  // chaque redémarrage un mot de passe qui ne serait de toute façon plus celui
  // réellement actif (INSERT ... ON CONFLICT DO NOTHING plus bas).
  async function resolveAdminPasswordDefault() {
    if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
    const existing = await pool.query("SELECT 1 FROM settings WHERE key='admin_password'").catch(() => ({ rows: [] }));
    if (existing.rows.length) return ''; // déjà seedé — ignoré par ON CONFLICT DO NOTHING
    const generated = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    console.warn(`⚠️  ADMIN_PASSWORD non défini — mot de passe owner généré aléatoirement au premier démarrage : ${generated}`);
    console.warn('⚠️  Notez-le maintenant : changez-le depuis Paramètres > Sécurité, il ne sera plus jamais affiché.');
    return generated;
  }
  const adminPasswordDefault = await resolveAdminPasswordDefault();
  const defaults = {
    showroom_name: 'Editions Standard',
    current_season: 'SS27',
    showroom_email: '',
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_pass: '',
    smtp_from: '',
    admin_password: adminPasswordDefault,
    maintenance_mode: 'off',
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
    DELETE FROM commande_links WHERE expires_at < NOW() - INTERVAL '30 days';
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
