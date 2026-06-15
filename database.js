const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS collection_name TEXT DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS composition TEXT DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT DEFAULT '[]';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS variants TEXT DEFAULT '[]';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS price_retail NUMERIC DEFAULT 0;
    ALTER TABLE brands ADD COLUMN IF NOT EXISTS logo TEXT DEFAULT '';
    ALTER TABLE brands ADD COLUMN IF NOT EXISTS cover_image TEXT DEFAULT '';
    ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS price_retail NUMERIC DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_signature TEXT DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cgv_accepted INTEGER DEFAULT 0;
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logo_url TEXT DEFAULT '',
      logo TEXT DEFAULT '',
      cover_image TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS order_lines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      size TEXT DEFAULT '',
      quantity INTEGER NOT NULL,
      unit_price NUMERIC NOT NULL,
      price_retail NUMERIC DEFAULT 0
    );
  `);

  const defaults = {
    showroom_name: 'Editions Standard',
    showroom_email: '',
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_pass: '',
    smtp_from: '',
    admin_password: 'admin123',
    agent_name: '',
    agent_title: 'Agent Commercial',
    cgv_text: "La présente proposition de commande ne constitue pas un engagement ferme. Elle ne sera définitive qu'après acceptation écrite de la marque et signature du bon de commande par les deux parties (acheteur et agent/showroom). L'acheteur s'engage à maintenir sa sélection pendant 15 jours ouvrés à compter de la date de signature. Les prix sont indiqués en euros HT. Tout désistement après accord bilatéral pourra faire l'objet de pénalités. Les conditions de paiement et de livraison seront précisées dans le bon de commande définitif signé par les deux parties."
  };

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }
}

module.exports = { pool, init };
