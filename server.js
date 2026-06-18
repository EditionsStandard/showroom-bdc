const express = require('express');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const { pool, init } = require('./database');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.set('trust proxy', 1); // Railway runs behind a proxy — required for secure cookies
const PORT = process.env.PORT || 3000;

// Stripe webhook needs the raw body for signature verification — must be registered before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe non configuré');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const brandId = session.metadata?.brand_id;
      if (brandId) {
        await pool.query(
          'UPDATE brands SET subscription_status=$1, stripe_customer_id=$2, stripe_subscription_id=$3 WHERE id=$4',
          ['active', session.customer, session.subscription, brandId]
        );
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : 'inactive';
      await pool.query('UPDATE brands SET subscription_status=$1 WHERE stripe_subscription_id=$2', [status, sub.id]);
    }
  } catch (err) {
    console.error('Stripe webhook handling error:', err);
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.get('/index.html', (req, res) => res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public')));
if (!process.env.SESSION_SECRET) console.warn('⚠️  SESSION_SECRET non défini — utilisez une valeur aléatoire en production');
app.use(session({
  store: process.env.DATABASE_URL ? new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }) : undefined,
  secret: process.env.SESSION_SECRET || 'showroom-dev-fallback-not-for-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Helpers
async function getSetting(key) {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows[0]?.value || '';
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function getRole(req) {
  if (req.session?.admin) return 'owner';
  if (req.session?.staffUser) return req.session.staffUser.role;
  return null;
}

function requireAdmin(req, res, next) {
  if (getRole(req)) return next();
  res.redirect('/admin/login');
}

function requireRole(...allowed) {
  return (req, res, next) => {
    const role = getRole(req);
    if (!role || !allowed.includes(role)) return res.status(403).json({ error: 'Accès refusé pour ce rôle' });
    req.userRole = role;
    req.userBrandId = req.session.staffUser?.brand_id || null;
    next();
  };
}

// Like requireRole, but for designers also checks req.params.brandId (or :id, as a fallback) matches their assigned brand
function requireBrandScope(...allowed) {
  const roleCheck = requireRole(...allowed);
  return (req, res, next) => {
    roleCheck(req, res, () => {
      if (req.userRole === 'designer') {
        const brandParam = req.params.brandId || req.params.id;
        if (brandParam !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
      }
      next();
    });
  };
}

// Rate limiting — anti brute force sur les logins
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// ==================== ADMIN ROUTES ====================

app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

app.post('/admin/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (email) {
    const bcrypt = require('bcryptjs');
    const r = await pool.query('SELECT * FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    const user = r.rows[0];
    if (user && await bcrypt.compare(password || '', user.password_hash)) {
      req.session.staffUser = { id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, name: user.name };
      return res.redirect('/admin');
    }
    return res.redirect('/admin/login?error=1');
  }

  const bcrypt = require('bcryptjs');
  const adminPassword = await getSetting('admin_password');
  let valid = false;
  if (adminPassword.startsWith('$2')) {
    valid = await bcrypt.compare(password || '', adminPassword);
  } else {
    // Plaintext in DB — compare then upgrade to hash on first successful login
    valid = (password === adminPassword);
    if (valid) {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', ['admin_password', hashed]);
    }
  }
  if (valid) {
    req.session.admin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => { req.session.destroy(() => res.redirect('/admin/login')); });
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/me', requireAdmin, (req, res) => {
  const role = getRole(req);
  if (role === 'owner') return res.json({ role: 'owner' });
  res.json({ role, brand_id: req.session.staffUser.brand_id, email: req.session.staffUser.email, name: req.session.staffUser.name });
});

// ==================== STAFF ACCOUNTS (owner only) ====================

app.get('/api/staff', requireRole('owner'), async (req, res) => {
  const r = await pool.query('SELECT a.id, a.email, a.role, a.brand_id, a.name, a.created_at, b.name as brand_name FROM admin_users a LEFT JOIN brands b ON a.brand_id=b.id ORDER BY a.created_at DESC');
  res.json(r.rows);
});

app.post('/api/staff', requireRole('owner'), async (req, res) => {
  const { email, password, role, brand_id, name } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'Email, mot de passe et rôle requis' });
  if (!['owner', 'agent', 'designer'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  if (role === 'designer' && !brand_id) return res.status(400).json({ error: 'Une marque doit être assignée à un designer' });

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO admin_users (id, email, password_hash, role, brand_id, name) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, email.toLowerCase().trim(), hash, role, role === 'designer' ? brand_id : null, name || '']
    );
    res.json({ id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', requireRole('owner'), async (req, res) => {
  const { name, email, role, brand_id, password } = req.body;
  if (password) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE admin_users SET name=$1,email=$2,role=$3,brand_id=$4,password_hash=$5 WHERE id=$6', [name, email, role, brand_id || null, hash, req.params.id]);
  } else {
    await pool.query('UPDATE admin_users SET name=$1,email=$2,role=$3,brand_id=$4 WHERE id=$5', [name, email, role, brand_id || null, req.params.id]);
  }
  res.json({ ok: true });
});

app.delete('/api/staff/:id', requireRole('owner'), async (req, res) => {
  await pool.query('DELETE FROM admin_users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ==================== API ADMIN ====================

app.get('/api/settings', requireRole('owner'), async (req, res) => {
  const r = await pool.query("SELECT key, value FROM settings WHERE key != 'admin_password'");
  const s = {};
  r.rows.forEach(row => s[row.key] = row.value);
  res.json(s);
});

app.post('/api/settings', requireRole('owner'), async (req, res) => {
  const allowed = ['showroom_name','showroom_email','smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','admin_password','agent_name','agent_title','agent_phone','cgv_text','currencies_json'];
  const bcrypt = require('bcryptjs');
  for (let [key, value] of Object.entries(req.body)) {
    if (!allowed.includes(key)) continue;
    if (key === 'admin_password' && value && !value.startsWith('$2')) {
      value = await bcrypt.hash(value, 10);
    }
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
  }
  res.json({ ok: true });
});

// Brands
app.get('/api/brands', requireRole('owner', 'agent', 'designer'), async (req, res) => {
  if (req.userRole === 'designer') {
    const r = await pool.query('SELECT * FROM brands WHERE id=$1 ORDER BY name', [req.userBrandId]);
    return res.json(r.rows);
  }
  const r = await pool.query('SELECT * FROM brands ORDER BY name');
  res.json(r.rows);
});

app.post('/api/brands', requireRole('owner', 'agent'), async (req, res) => {
  const { name, logo_url, logo, cover_image, cgv_text, moq_qty, moq_amount, about_text } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = uuidv4();
  await pool.query('INSERT INTO brands (id,name,logo_url,logo,cover_image,cgv_text,moq_qty,moq_amount,about_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, name, logo_url||'', logo||'', cover_image||'', cgv_text||'', moq_qty||0, moq_amount||0, about_text||'']);
  res.json({ id, name });
});

app.put('/api/brands/:id', requireRole('owner', 'agent', 'designer'), async (req, res) => {
  if (req.userRole === 'designer' && req.userBrandId !== req.params.id) return res.status(403).json({ error: 'Accès refusé' });
  const { name, logo_url, logo, cover_image, cgv_text, moq_qty, moq_amount, about_text } = req.body;
  await pool.query('UPDATE brands SET name=$1, logo_url=$2, logo=$3, cover_image=$4, cgv_text=$5, moq_qty=$6, moq_amount=$7, about_text=$8 WHERE id=$9',
    [name, logo_url||'', logo||'', cover_image||'', cgv_text||'', moq_qty||0, moq_amount||0, about_text||'', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/brands/:id', requireRole('owner'), async (req, res) => {
  await pool.query('DELETE FROM brands WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/brands/:id/qrcode', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('SELECT * FROM brands WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const url = `${getBaseUrl(req)}/commande/${req.params.id}`;
  const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  res.json({ qr, url });
});

app.post('/api/brands/:id/checkout-link', requireRole('owner'), async (req, res) => {
  const { id } = req.params;
  const { priceId } = req.body;
  const b = await pool.query('SELECT * FROM brands WHERE id=$1', [id]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const brand = b.rows[0];

  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY non configurée' });
  if (!priceId) return res.status(400).json({ error: 'priceId requis' });

  try {
    let customerId = brand.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ name: brand.name, metadata: { brand_id: id } });
      customerId = customer.id;
      await pool.query('UPDATE brands SET stripe_customer_id=$1 WHERE id=$2', [customerId, id]);
    }
    const base = getBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/admin?subscribed=1`,
      cancel_url: `${base}/admin`,
      metadata: { brand_id: id }
    });
    await pool.query('UPDATE brands SET subscription_price_id=$1 WHERE id=$2', [priceId, id]);
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brands/:id/cancel-subscription', requireRole('owner'), async (req, res) => {
  const b = await pool.query('SELECT * FROM brands WHERE id=$1', [req.params.id]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  try {
    if (b.rows[0].stripe_subscription_id) {
      await stripe.subscriptions.cancel(b.rows[0].stripe_subscription_id).catch(() => {});
    }
    await pool.query('UPDATE brands SET subscription_status=$1 WHERE id=$2', ['inactive', req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brands/:id/subscription-status', requireRole('owner'), async (req, res) => {
  // Manual override (e.g. extending a trial, or marking active without Stripe)
  const { status } = req.body;
  if (!['trial','active','inactive'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  await pool.query('UPDATE brands SET subscription_status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/brands/:brandId/products/:productId/qrcode', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { brandId, productId } = req.params;
  const r = await pool.query('SELECT * FROM products WHERE id=$1 AND brand_id=$2', [productId, brandId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  const url = `${getBaseUrl(req)}/commande/${brandId}?product=${productId}`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.json({ qr, url, reference: r.rows[0].reference, description: r.rows[0].description });
});

app.get('/api/brands/:brandId/qrcodes-all', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const b = await pool.query('SELECT * FROM brands WHERE id=$1', [req.params.brandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const prods = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active=1 ORDER BY reference', [req.params.brandId]);
  const base = getBaseUrl(req);
  const items = await Promise.all(prods.rows.map(async p => {
    const url = `${base}/commande/${req.params.brandId}?product=${p.id}`;
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 1 });
    return { qr, url, reference: p.reference, collection: p.collection_name, color: p.color, price: p.price, price_retail: p.price_retail };
  }));
  res.json({ brand: b.rows[0].name, items });
});

// Products
app.get('/api/brands/:brandId/products', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('SELECT * FROM products WHERE brand_id=$1 ORDER BY reference', [req.params.brandId]);
  res.json(r.rows);
});

app.post('/api/brands/:brandId/products', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { reference, description, color, sizes, price, price_retail, image_url, collection_name, category, composition, images, variants, season_id } = req.body;
  if (!reference) return res.status(400).json({ error: 'Référence requise' });
  const id = uuidv4();
  await pool.query(
    'INSERT INTO products (id,brand_id,reference,description,color,sizes,price,price_retail,image_url,collection_name,category,composition,images,variants,season_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [id, req.params.brandId, reference, description||'', color||'', sizes||'', price||0, price_retail||0, image_url||'', collection_name||'', category||'', composition||'', JSON.stringify(images||[]), JSON.stringify(variants||[]), season_id||null]
  );
  res.json({ id });
});

async function checkProductBrandScope(req, res) {
  if (req.userRole !== 'designer') return true;
  const p = await pool.query('SELECT brand_id FROM products WHERE id=$1', [req.params.id]);
  if (!p.rows[0] || p.rows[0].brand_id !== req.userBrandId) {
    res.status(403).json({ error: 'Accès refusé' });
    return false;
  }
  return true;
}

app.put('/api/products/:id', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkProductBrandScope(req, res)) return;
  const { reference, description, color, sizes, price, price_retail, image_url, active, collection_name, category, composition, images, variants, season_id } = req.body;
  await pool.query(
    'UPDATE products SET reference=$1,description=$2,color=$3,sizes=$4,price=$5,price_retail=$6,image_url=$7,active=$8,collection_name=$9,category=$10,composition=$11,images=$12,variants=$13,season_id=$14 WHERE id=$15',
    [reference, description||'', color||'', sizes||'', price||0, price_retail||0, image_url||'', active!==undefined?active:1, collection_name||'', category||'', composition||'', JSON.stringify(images||[]), JSON.stringify(variants||[]), season_id||null, req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkProductBrandScope(req, res)) return;
  await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/brands/:brandId/products', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('DELETE FROM products WHERE brand_id=$1', [req.params.brandId]);
  res.json({ ok: true, deleted: r.rowCount });
});

app.post('/api/products/:id/duplicate', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkProductBrandScope(req, res)) return;
  const r = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  const p = r.rows[0];
  const newId = uuidv4();
  await pool.query(
    'INSERT INTO products (id,brand_id,reference,description,color,sizes,price,price_retail,image_url,collection_name,category,composition,images,variants,season_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [newId, p.brand_id, p.reference + '-COPY', p.description, p.color, p.sizes, p.price, p.price_retail, p.image_url, p.collection_name, p.category, p.composition, p.images, p.variants, p.season_id]
  );
  res.json({ id: newId });
});

app.put('/api/products/:id/active', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkProductBrandScope(req, res)) return;
  const { active } = req.body;
  await pool.query('UPDATE products SET active=$1 WHERE id=$2', [active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/brands/:brandId/products/bulk', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'IDs requis' });
  await pool.query('DELETE FROM products WHERE id = ANY($1) AND brand_id=$2', [ids, req.params.brandId]);
  res.json({ ok: true, deleted: ids.length });
});

app.post('/api/upload-image', requireRole('owner','agent','designer'), upload.single('image'), async (req, res) => {
  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const slug = `img-${Date.now()}`;
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'showroom/uploads',
      public_id: slug,
      transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 80, fetch_format: 'auto' }]
    });
    res.json({ url: result.secure_url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/brands/:brandId/products-photos', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query("UPDATE products SET images='[]', image_url='' WHERE brand_id=$1", [req.params.brandId]);
  res.json({ ok: true, cleared: r.rowCount });
});

// ==================== SEASONS ====================

app.get('/api/brands/:brandId/seasons', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('SELECT * FROM seasons WHERE brand_id=$1 ORDER BY created_at DESC', [req.params.brandId]);
  res.json(r.rows);
});

app.post('/api/brands/:brandId/seasons', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = uuidv4();
  await pool.query('INSERT INTO seasons (id, brand_id, name) VALUES ($1,$2,$3)', [id, req.params.brandId, name]);
  res.json({ id, name });
});

app.put('/api/seasons/:id', requireRole('owner','agent','designer'), async (req, res) => {
  const s = await pool.query('SELECT brand_id FROM seasons WHERE id=$1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'Saison introuvable' });
  if (req.userRole === 'designer' && s.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
  const { name, active } = req.body;
  await pool.query('UPDATE seasons SET name=$1, active=$2 WHERE id=$3', [name, active!==undefined?active:1, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/seasons/:id', requireRole('owner','agent','designer'), async (req, res) => {
  const s = await pool.query('SELECT brand_id FROM seasons WHERE id=$1', [req.params.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'Saison introuvable' });
  if (req.userRole === 'designer' && s.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
  await pool.query('UPDATE products SET season_id=NULL WHERE season_id=$1', [req.params.id]);
  await pool.query('DELETE FROM seasons WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ==================== LINESHEET PDF ====================

app.get('/api/brands/:brandId/linesheet-pdf', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const pdf = await generateLinesheetPDF(req.params.brandId, req.query.season_id || null);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="linesheet.pdf"');
    res.send(pdf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== APPOINTMENTS ====================

app.get('/api/brands/:brandId/appointments', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('SELECT * FROM appointments WHERE brand_id=$1 ORDER BY slot_date, slot_time', [req.params.brandId]);
  res.json(r.rows);
});

app.get('/api/public/brands/:brandId/slots', async (req, res) => {
  const days = [];
  const now = new Date();
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekends
    days.push(d.toISOString().slice(0, 10));
  }
  const times = ['10:00','11:00','12:00','14:00','15:00','16:00','17:00'];
  const booked = await pool.query('SELECT slot_date, slot_time FROM appointments WHERE brand_id=$1', [req.params.brandId]);
  const bookedSet = new Set(booked.rows.map(b => `${b.slot_date.toISOString().slice(0,10)}_${b.slot_time}`));
  const slots = days.map(date => ({
    date,
    times: times.filter(t => !bookedSet.has(`${date}_${t}`))
  })).filter(d => d.times.length > 0);
  res.json({ slots });
});

app.post('/api/public/appointments', async (req, res) => {
  const { brand_id, client_name, client_email, client_phone, slot_date, slot_time, notes } = req.body;
  if (!brand_id || !client_name || !client_email || !slot_date || !slot_time) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  const existing = await pool.query('SELECT 1 FROM appointments WHERE brand_id=$1 AND slot_date=$2 AND slot_time=$3', [brand_id, slot_date, slot_time]);
  if (existing.rows[0]) return res.status(409).json({ error: 'Ce créneau est déjà réservé' });
  const id = uuidv4();
  await pool.query(
    'INSERT INTO appointments (id,brand_id,client_name,client_email,client_phone,slot_date,slot_time,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, brand_id, client_name, client_email, client_phone||'', slot_date, slot_time, notes||'']
  );
  res.json({ ok: true, id });
});

app.post('/api/brands/:brandId/bulk-photos', requireBrandScope('owner','agent','designer'), upload.array('photos', 200), async (req, res) => {
  const { brandId } = req.params;
  const prods = await pool.query('SELECT id, reference, color, images FROM products WHERE brand_id=$1', [brandId]);
  const results = [];

  // View ordering: front first, back second, others after
  const viewRank = hint => {
    if (hint.includes('front')) return 0;
    if (hint.includes('back')) return 1;
    return 2;
  };

  // Group incoming files by matched product, preserving existing images
  const pending = new Map(); // productId -> { images: [...], rank: [...] }
  for (const file of req.files) {
    const name = path.basename(file.originalname, path.extname(file.originalname));
    const parts = name.split('_');
    const ref = parts[0].trim().toUpperCase();
    const colorHint = parts.slice(1).join('_').trim().toLowerCase();

    const product = prods.rows.find(p => p.reference.toUpperCase() === ref);
    if (!product) {
      results.push({ file: file.originalname, status: 'not_found', ref });
      continue;
    }

    if (!pending.has(product.id)) {
      let existing = [];
      try { existing = JSON.parse(product.images || '[]'); } catch(e) {}
      pending.set(product.id, { images: existing.slice(), ranks: existing.map(() => -1) });
    }
    const entry = pending.get(product.id);
    const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    let imageData = base64;
    try {
      const slug = `${product.reference}-${colorHint || product.color}-${Date.now()}`.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
      const uploaded = await cloudinary.uploader.upload(base64, {
        folder: `showroom/${brandId}`,
        public_id: slug,
        overwrite: false,
        transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 80, fetch_format: 'auto' }]
      });
      imageData = uploaded.secure_url;
    } catch(e) { /* keep base64 on cloudinary error */ }
    entry.images.push(imageData);
    entry.ranks.push(viewRank(colorHint));
    results.push({ file: file.originalname, status: 'ok', ref, color: colorHint || product.color });
  }

  for (const [productId, entry] of pending) {
    // Stable sort new images (rank >= 0) to front/back order, keep pre-existing (rank -1) order intact at their relative position
    const indexed = entry.images.map((img, i) => ({ img, rank: entry.ranks[i], i }));
    indexed.sort((a, b) => {
      if (a.rank === -1 && b.rank === -1) return a.i - b.i;
      if (a.rank === -1) return -1;
      if (b.rank === -1) return 1;
      return a.rank - b.rank || a.i - b.i;
    });
    const sortedImages = indexed.map(x => x.img);
    await pool.query('UPDATE products SET images=$1 WHERE id=$2', [JSON.stringify(sortedImages), productId]);
  }

  res.json({ ok: true, results });
});

// Orders
async function checkOrderBrandScope(req, res) {
  if (req.userRole !== 'designer') return true;
  const o = await pool.query('SELECT brand_id FROM orders WHERE id=$1', [req.params.id]);
  if (!o.rows[0] || o.rows[0].brand_id !== req.userBrandId) {
    res.status(403).json({ error: 'Accès refusé' });
    return false;
  }
  return true;
}

app.get('/api/orders', requireRole('owner','agent','designer'), async (req, res) => {
  const brandFilter = req.userRole === 'designer' ? 'WHERE o.brand_id = $1' : '';
  const params = req.userRole === 'designer' ? [req.userBrandId] : [];
  const r = await pool.query(`
    SELECT o.*, b.name as brand_name,
      COUNT(ol.id) as line_count,
      SUM(ol.quantity * ol.unit_price) as total
    FROM orders o
    JOIN brands b ON o.brand_id = b.id
    LEFT JOIN order_lines ol ON ol.order_id = o.id
    ${brandFilter}
    GROUP BY o.id, b.name
    ORDER BY o.created_at DESC
  `, params);
  res.json(r.rows);
});

app.put('/api/orders/:id/status', requireRole('owner','agent'), async (req, res) => {
  const { status } = req.body;
  if (!['confirmed','validated','cancelled'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/orders/:id', requireRole('owner','agent'), async (req, res) => {
  await pool.query('DELETE FROM order_lines WHERE order_id=$1', [req.params.id]);
  await pool.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/orders/:id', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkOrderBrandScope(req, res)) return;
  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name FROM orders o JOIN brands b ON o.brand_id=b.id WHERE o.id=$1
  `, [req.params.id]);
  if (!oRes.rows[0]) return res.status(404).json({ error: 'Introuvable' });
  const lRes = await pool.query(`
    SELECT ol.*, p.reference, p.color as product_color FROM order_lines ol JOIN products p ON ol.product_id=p.id WHERE ol.order_id=$1
  `, [req.params.id]);
  res.json({ order: oRes.rows[0], lines: lRes.rows });
});

app.post('/api/orders/:id/resend', requireRole('owner','agent'), async (req, res) => {
  try {
    const pdf = await generateOrderPDF(req.params.id);
    await sendOrderEmails(req.params.id, pdf);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id/pdf', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkOrderBrandScope(req, res)) return;
  try {
    const pdf = await generateOrderPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="commande-${req.params.id.slice(0,8)}.pdf"`);
    res.send(pdf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== PUBLIC ====================

app.get('/', (req, res) => {
  if (req.session?.buyerPortal) return res.redirect('/portal');
  res.redirect('/editions-showroom-b2b-portail');
});

app.get('/api/public/brands', async (req, res) => {
  const r = await pool.query("SELECT id, name, logo, logo_url, cover_image FROM brands WHERE subscription_status != 'inactive' ORDER BY name");
  res.json(r.rows);
});

app.get('/commande/:brandId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'commande.html')));

// PDF public — accessible 24h après la commande (pour share sheet mobile)
app.get('/api/public/orders/:id/pdf', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id FROM orders WHERE id=$1 AND created_at > NOW() - INTERVAL '24 hours'",
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Non disponible' });
    const pdf = await generateOrderPDF(req.params.id);
    const filename = `PropositionCommande-${req.params.id.slice(0,8).toUpperCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/cgv', async (req, res) => {
  const cgv_text = await getSetting('cgv_text');
  res.json({ cgv_text });
});

app.get('/api/public/brands/:brandId', async (req, res) => {
  const b = await pool.query('SELECT id,name,logo_url,logo,cover_image,cgv_text,about_text,moq_qty,moq_amount,subscription_status FROM brands WHERE id=$1', [req.params.brandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  if (b.rows[0].subscription_status === 'inactive') {
    return res.status(403).json({ error: 'subscription_inactive', message: 'Ce showroom est temporairement indisponible.' });
  }
  const p = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active=1 ORDER BY reference', [req.params.brandId]);
  const seasons = await pool.query('SELECT id, name FROM seasons WHERE brand_id=$1 AND active=1 ORDER BY created_at DESC', [req.params.brandId]);
  const agentName  = await getSetting('agent_name');
  const agentTitle = await getSetting('agent_title');
  const agentPhone = await getSetting('agent_phone');
  const showroomName = await getSetting('showroom_name');
  let currencies = [];
  try { currencies = JSON.parse(await getSetting('currencies_json') || '[]'); } catch(e) {}
  res.json({ brand: b.rows[0], products: p.rows, seasons: seasons.rows, currencies, agent: { name: agentName, title: agentTitle, phone: agentPhone, showroom: showroomName } });
});

app.post('/api/public/selection-pdf', async (req, res) => {
  try {
    const { brand_id, client_name, client_email, client_company, client_country, lines } = req.body;
    const bRes = await pool.query('SELECT * FROM brands WHERE id=$1', [brand_id]);
    const brand = bRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Marque introuvable' });
    const productIds = [...new Set((lines||[]).map(l => l.product_id))];
    const pRes = await pool.query('SELECT * FROM products WHERE id = ANY($1)', [productIds]);
    const productMap = {};
    pRes.rows.forEach(p => { productMap[p.id] = p; });
    const resolvedLines = (lines||[]).filter(l => productMap[l.product_id]).map(l => ({ ...l, product: productMap[l.product_id] }));
    const showroomName = await getSetting('showroom_name');
    const agentName = await getSetting('agent_name');
    const pdf = await generateSelectionPDF({ brand, client_name, client_email, client_company, client_country, lines: resolvedLines, showroomName, agentName });
    const ref = (client_name||'Selection').replace(/\s/g,'-').slice(0,20);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Selection-${ref}-${brand.name.replace(/\s/g,'-')}.pdf"`);
    res.send(pdf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function createOrder({ brand_id, client_name, client_email, client_company, client_phone, client_country, notes, lines, buyer_signature, cgv_accepted, buyer_id }) {
  const validLines = (lines || []).filter(l => l.quantity > 0);
  if (!validLines.length) return { error: 'Aucune quantité saisie' };
  if (!buyer_signature) return { error: 'Signature requise' };
  if (!cgv_accepted) return { error: 'Acceptation des CGV requise' };

  const brandCheck = await pool.query('SELECT subscription_status, moq_qty, moq_amount FROM brands WHERE id=$1', [brand_id]);
  if (!brandCheck.rows[0]) return { error: 'Marque introuvable' };
  if (brandCheck.rows[0].subscription_status === 'inactive') {
    return { error: 'subscription_inactive', message: 'Ce showroom est temporairement indisponible.' };
  }

  // Resolve product prices server-side (never trust client-submitted prices)
  const resolvedLines = [];
  for (const line of validLines) {
    const p = await pool.query('SELECT * FROM products WHERE id=$1', [line.product_id]);
    if (!p.rows[0]) continue;
    resolvedLines.push({ ...line, product: p.rows[0] });
  }

  const totalQty = resolvedLines.reduce((s, l) => s + l.quantity, 0);
  const totalAmount = resolvedLines.reduce((s, l) => s + l.quantity * parseFloat(l.product.price || 0), 0);
  const moqQty = parseInt(brandCheck.rows[0].moq_qty) || 0;
  const moqAmount = parseFloat(brandCheck.rows[0].moq_amount) || 0;
  if (moqQty > 0 && totalQty < moqQty) return { error: `Minimum ${moqQty} pièces requis pour cette marque (sélection actuelle : ${totalQty}).` };
  if (moqAmount > 0 && totalAmount < moqAmount) return { error: `Montant minimum de ${moqAmount.toFixed(2)} € HT requis pour cette marque (sélection actuelle : ${totalAmount.toFixed(2)} €).` };

  const orderId = uuidv4();
  await pool.query(
    `INSERT INTO orders (id,brand_id,client_name,client_email,client_company,client_phone,client_country,notes,status,buyer_signature,cgv_accepted,buyer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11)`,
    [orderId, brand_id, client_name, client_email, client_company||'', client_phone||'', client_country||'', notes||'', buyer_signature||'', cgv_accepted?1:0, buyer_id||null]
  );

  for (const line of resolvedLines) {
    await pool.query(
      'INSERT INTO order_lines (id,order_id,product_id,size,quantity,unit_price,price_retail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uuidv4(), orderId, line.product_id, line.size||'', line.quantity, line.product.price, line.product.price_retail||0]
    );
  }

  try {
    const pdf = await generateOrderPDF(orderId);
    await sendOrderEmails(orderId, pdf);
  } catch(e) { console.error('PDF/email error:', e.message, '| code:', e.code, '| errno:', e.errno, '| host:', e.host || '', '| port:', e.port || ''); }

  const totRes = await pool.query('SELECT SUM(quantity * unit_price) as total FROM order_lines WHERE order_id=$1', [orderId]);
  const orderTotal = parseFloat(totRes.rows[0]?.total || 0);
  syncAirtable(client_email, client_company, client_name, orderTotal).catch(e => console.error('Airtable sync error:', e.message));

  return { order_id: orderId, total: orderTotal };
}

app.post('/api/public/orders', async (req, res) => {
  const { brand_id, client_name, client_email, client_company, client_phone, client_country, notes, lines, buyer_signature, cgv_accepted } = req.body;
  if (!brand_id || !client_name || !client_email || !lines?.length) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  const result = await createOrder({ brand_id, client_name, client_email, client_company, client_phone, client_country, notes, lines, buyer_signature, cgv_accepted });
  if (result.error) return res.status(result.error === 'subscription_inactive' ? 403 : 400).json(result);
  res.json({ ok: true, order_id: result.order_id });
});

// ==================== BUYER PORTAL (email + password, multi-brand) ====================

function requireBuyerAuth(req, res, next) {
  if (req.session?.buyerPortal) return next();
  res.status(401).json({ error: 'Non connecté' });
}

// Ancien lien conservé pour compatibilité
app.get('/portal-login', (req, res) => res.redirect('/editions-showroom-b2b-portail'));

app.get('/editions-showroom-b2b-portail', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal-login.html')));

app.post('/editions-showroom-b2b-portail', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const bcrypt = require('bcryptjs');
  const r = await pool.query('SELECT * FROM buyers WHERE email=$1', [(email||'').toLowerCase().trim()]);
  const buyer = r.rows[0];
  if (buyer && await bcrypt.compare(password || '', buyer.password_hash)) {
    req.session.buyerPortal = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country };
    return res.redirect('/portal');
  }
  res.redirect('/editions-showroom-b2b-portail?error=1');
});

app.get('/portal-logout', (req, res) => {
  req.session.destroy(() => res.redirect('/editions-showroom-b2b-portail'));
});
app.get('/portal', (req, res) => {
  if (!req.session?.buyerPortal) return res.redirect('/editions-showroom-b2b-portail');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

app.get('/api/portal/me', requireBuyerAuth, (req, res) => res.json(req.session.buyerPortal));

app.get('/api/portal/currencies', requireBuyerAuth, async (req, res) => {
  let currencies = [];
  try { currencies = JSON.parse(await getSetting('currencies_json') || '[]'); } catch(e) {}
  res.json(currencies);
});

app.post('/api/portal/change-password', requireBuyerAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères' });

  const bcrypt = require('bcryptjs');
  const r = await pool.query('SELECT * FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
  const buyer = r.rows[0];
  if (!buyer || !await bcrypt.compare(currentPassword, buyer.password_hash)) {
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE buyers SET password_hash=$1 WHERE id=$2', [hash, buyer.id]);
  res.json({ ok: true });
});

app.post('/api/portal/update-profile', requireBuyerAuth, async (req, res) => {
  const { name, company, phone, country } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est requis' });
  await pool.query('UPDATE buyers SET name=$1, company=$2, phone=$3, country=$4 WHERE id=$5',
    [name.trim(), company||'', phone||'', country||'', req.session.buyerPortal.id]);
  req.session.buyerPortal = { ...req.session.buyerPortal, name: name.trim(), company: company||'', phone: phone||'', country: country||'' };
  res.json({ ok: true });
});

app.get('/api/portal/brands', requireBuyerAuth, async (req, res) => {
  const r = await pool.query("SELECT id, name, logo, logo_url, cover_image, cgv_text, moq_qty, moq_amount FROM brands WHERE subscription_status != 'inactive' ORDER BY name");
  res.json(r.rows);
});

app.get('/api/portal/brands/:brandId/products', requireBuyerAuth, async (req, res) => {
  const b = await pool.query("SELECT id, name, logo, logo_url, cover_image, about_text, cgv_text, moq_qty, moq_amount, subscription_status FROM brands WHERE id=$1", [req.params.brandId]);
  if (!b.rows[0] || b.rows[0].subscription_status === 'inactive') return res.status(404).json({ error: 'Marque indisponible' });
  const p = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active=1 ORDER BY reference', [req.params.brandId]);
  res.json({ brand: b.rows[0], products: p.rows });
});

async function checkMoq(brand_id, lines) {
  const validLines = (lines || []).filter(l => l.quantity > 0);
  const b = await pool.query('SELECT moq_qty, moq_amount FROM brands WHERE id=$1', [brand_id]);
  if (!b.rows[0]) return 'Marque introuvable';
  const moqQty = parseInt(b.rows[0].moq_qty) || 0;
  const moqAmount = parseFloat(b.rows[0].moq_amount) || 0;
  if (!moqQty && !moqAmount) return null;

  let totalQty = 0, totalAmount = 0;
  for (const line of validLines) {
    const p = await pool.query('SELECT price FROM products WHERE id=$1', [line.product_id]);
    if (!p.rows[0]) continue;
    totalQty += line.quantity;
    totalAmount += line.quantity * parseFloat(p.rows[0].price || 0);
  }
  if (moqQty > 0 && totalQty < moqQty) return `Minimum ${moqQty} pièces requis (sélection actuelle : ${totalQty}).`;
  if (moqAmount > 0 && totalAmount < moqAmount) return `Montant minimum de ${moqAmount.toFixed(2)} € HT requis (sélection actuelle : ${totalAmount.toFixed(2)} €).`;
  return null;
}

app.post('/api/portal/checkout', requireBuyerAuth, async (req, res) => {
  const buyer = req.session.buyerPortal;
  const { lines, client_name, client_company, client_phone, client_country, buyer_signature, cgv_accepted, notes } = req.body;
  if (!lines?.length) return res.status(400).json({ error: 'Sélection vide' });
  if (!client_name) return res.status(400).json({ error: 'Nom requis' });
  if (!buyer_signature) return res.status(400).json({ error: 'Signature requise' });
  if (!cgv_accepted) return res.status(400).json({ error: 'Acceptation des CGV requise' });

  // Group lines by brand — one order per brand
  const byBrand = {};
  for (const line of lines) {
    if (!byBrand[line.brand_id]) byBrand[line.brand_id] = [];
    byBrand[line.brand_id].push(line);
  }

  // Validate MOQ for every brand BEFORE creating any order — all or nothing
  const brandsList = await pool.query('SELECT id, name FROM brands WHERE id = ANY($1)', [Object.keys(byBrand)]);
  const brandNameOf = id => brandsList.rows.find(b => b.id === id)?.name || id;
  for (const [brand_id, brandLines] of Object.entries(byBrand)) {
    const moqError = await checkMoq(brand_id, brandLines);
    if (moqError) return res.status(400).json({ error: `${brandNameOf(brand_id)} : ${moqError}` });
  }

  const results = [];
  for (const [brand_id, brandLines] of Object.entries(byBrand)) {
    const r = await createOrder({
      brand_id, client_name,
      client_email: buyer.email,
      client_company: client_company || buyer.company,
      client_phone: client_phone || buyer.phone,
      client_country: client_country || buyer.country,
      notes, lines: brandLines, buyer_signature, cgv_accepted, buyer_id: buyer.id
    });
    results.push({ brand_id, ...r });
  }

  res.json({ ok: true, orders: results });
});

app.get('/api/portal/orders', requireBuyerAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT o.*, b.name as brand_name, SUM(ol.quantity * ol.unit_price) as total
    FROM orders o
    JOIN brands b ON o.brand_id = b.id
    LEFT JOIN order_lines ol ON ol.order_id = o.id
    WHERE o.buyer_id = $1
    GROUP BY o.id, b.name
    ORDER BY o.created_at DESC
  `, [req.session.buyerPortal.id]);
  res.json(r.rows);
});

app.get('/api/portal/orders/:id/lines', requireBuyerAuth, async (req, res) => {
  const o = await pool.query('SELECT id FROM orders WHERE id=$1 AND buyer_id=$2', [req.params.id, req.session.buyerPortal.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'Non disponible' });
  const lines = await pool.query(
    'SELECT ol.quantity, ol.unit_price, ol.size, p.reference, p.color FROM order_lines ol JOIN products p ON ol.product_id=p.id WHERE ol.order_id=$1 ORDER BY p.reference',
    [req.params.id]
  );
  res.json(lines.rows);
});

app.get('/api/portal/orders/:id/pdf', requireBuyerAuth, async (req, res) => {
  const o = await pool.query('SELECT id FROM orders WHERE id=$1 AND buyer_id=$2', [req.params.id, req.session.buyerPortal.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'Non disponible' });
  try {
    const pdf = await generateOrderPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Commande-${req.params.id.slice(0,8).toUpperCase()}.pdf"`);
    res.send(pdf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Forgot / reset password (public endpoints — no auth required)
app.post('/api/portal/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  res.json({ ok: true }); // always succeed — don't reveal if email exists
  if (!email) return;
  try {
    const b = await pool.query('SELECT id, name FROM buyers WHERE email=$1', [email.toLowerCase().trim()]);
    if (!b.rows[0]) return;
    const buyer = b.rows[0];
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query('DELETE FROM buyer_password_resets WHERE buyer_id=$1', [buyer.id]);
    await pool.query(
      'INSERT INTO buyer_password_resets (token, buyer_id, expires_at) VALUES ($1,$2,$3)',
      [token, buyer.id, expires]
    );
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return;
    const { Resend } = require('resend');
    const resend = new Resend(resendKey);
    const showroomName = await getSetting('showroom_name');
    const fromAddress = await getSetting('smtp_from');
    const resetUrl = `${getBaseUrl(req)}/portal-login?token=${token}`;
    await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [email],
      subject: `Réinitialisation de mot de passe — ${showroomName}`,
      html: emailLayout({
        showroomName,
        content: `
          <p>Bonjour${buyer.name ? ' <strong>' + buyer.name + '</strong>' : ''},</p>
          <p>Vous avez demandé à réinitialiser votre mot de passe pour le showroom B2B <strong>${showroomName}</strong>.</p>
          ${emailBtn(resetUrl, 'Choisir un nouveau mot de passe →')}
          <p style="font-size:13px;color:#888;margin-top:24px">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
          <p>Cordialement,<br><strong>${showroomName}</strong></p>
        `
      })
    });
  } catch (e) { console.error('forgot-password error:', e.message); }
});

app.post('/api/portal/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6)
    return res.json({ error: 'Données invalides.' });
  try {
    const r = await pool.query(
      'SELECT buyer_id FROM buyer_password_resets WHERE token=$1 AND used=false AND expires_at > NOW()',
      [token]
    );
    if (!r.rows[0]) return res.json({ error: 'Lien invalide ou expiré.' });
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE buyers SET password_hash=$1 WHERE id=$2', [hash, r.rows[0].buyer_id]);
    await pool.query('UPDATE buyer_password_resets SET used=true WHERE token=$1', [token]);
    res.json({ ok: true });
  } catch (e) { res.json({ error: 'Erreur serveur.' }); }
});

// Admin: manage buyer accounts (owner + agent)
app.get('/api/buyers', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT id, email, name, company, phone, country, created_at FROM buyers ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/buyers', requireRole('owner','agent'), async (req, res) => {
  const { email, password, name, company, phone, country } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const cleanEmail = email.toLowerCase().trim();
  try {
    await pool.query(
      'INSERT INTO buyers (id, email, password_hash, name, company, phone, country) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, cleanEmail, hash, name||'', company||'', phone||'', country||'']
    );
    res.json({ id });
    sendBuyerWelcomeEmail({ email: cleanEmail, password, name, req }).catch(e => console.error('Buyer welcome email error:', e.message));
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

async function sendBuyerWelcomeEmail({ email, password, name, req }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('RESEND_API_KEY non configurée — email de bienvenue acheteur non envoyé'); return; }
  const { Resend } = require('resend');
  const resend = new Resend(resendKey);
  const showroomName = await getSetting('showroom_name');
  const fromAddress = await getSetting('smtp_from');
  const fromField = fromAddress || 'showroom@editionsstandard.com';
  const portalUrl = `${getBaseUrl(req)}/portal-login`;

  await resend.emails.send({
    from: `${showroomName} <${fromField}>`,
    to: [email],
    subject: `Votre accès au showroom — ${showroomName}`,
    html: emailLayout({
      showroomName,
      content: `
        <p>Bonjour${name ? ' <strong>' + name + '</strong>' : ''},</p>
        <p>Votre accès au showroom B2B <strong>${showroomName}</strong> a été créé. Vous pouvez dès à présent parcourir nos marques, consulter les collections et passer vos commandes en ligne.</p>
        ${emailInfoBox([
          ['Email', email],
          ['Mot de passe', password],
        ])}
        ${emailBtn(portalUrl, 'Accéder au showroom →')}
        <p style="font-size:13px;color:#888;margin-top:28px">En cas de question, n'hésitez pas à nous contacter.</p>
        <p>Cordialement,<br><strong>${showroomName}</strong></p>
      `
    })
  });
}

app.put('/api/buyers/:id', requireRole('owner','agent'), async (req, res) => {
  const { name, company, email, phone, country, password } = req.body;
  if (password) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE buyers SET name=$1,company=$2,email=$3,phone=$4,country=$5,password_hash=$6 WHERE id=$7', [name, company, email, phone, country, hash, req.params.id]);
  } else {
    await pool.query('UPDATE buyers SET name=$1,company=$2,email=$3,phone=$4,country=$5 WHERE id=$6', [name, company, email, phone, country, req.params.id]);
  }
  res.json({ ok: true });
});

app.delete('/api/buyers/:id', requireRole('owner','agent'), async (req, res) => {
  await pool.query('DELETE FROM buyers WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ==================== BRAND INVITE LINKS ====================

app.get('/api/brands/:brandId/invite-link', requireBrandScope('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT * FROM brand_invite_links WHERE brand_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.brandId]);
  if (!r.rows[0]) return res.json({ token: null, active: 0 });
  res.json(r.rows[0]);
});

app.post('/api/brands/:brandId/invite-link', requireBrandScope('owner','agent'), async (req, res) => {
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('DELETE FROM brand_invite_links WHERE brand_id=$1', [req.params.brandId]);
  await pool.query('INSERT INTO brand_invite_links (token, brand_id, active) VALUES ($1,$2,1)', [token, req.params.brandId]);
  res.json({ token });
});

app.put('/api/brands/:brandId/invite-link/toggle', requireBrandScope('owner','agent'), async (req, res) => {
  const { active } = req.body;
  await pool.query('UPDATE brand_invite_links SET active=$1 WHERE brand_id=$2', [active ? 1 : 0, req.params.brandId]);
  res.json({ ok: true });
});

app.get('/rejoindre/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'invite.html')));

app.get('/api/invite/:token', async (req, res) => {
  const r = await pool.query(`
    SELECT bil.*, b.name as brand_name, b.logo as brand_logo
    FROM brand_invite_links bil
    JOIN brands b ON b.id = bil.brand_id
    WHERE bil.token=$1 AND bil.active=1
  `, [req.params.token]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Lien invalide ou désactivé.' });
  res.json({ brand_name: r.rows[0].brand_name, brand_logo: r.rows[0].brand_logo });
});

app.post('/api/invite/:token', async (req, res) => {
  const r = await pool.query(`
    SELECT bil.brand_id, b.name as brand_name
    FROM brand_invite_links bil
    JOIN brands b ON b.id = bil.brand_id
    WHERE bil.token=$1 AND bil.active=1
  `, [req.params.token]);
  if (!r.rows[0]) return res.status(400).json({ error: 'Lien invalide ou désactivé.' });

  const { name, company, email, password } = req.body;
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Email et mot de passe requis (6 caractères min).' });
  if (!name) return res.status(400).json({ error: 'Nom requis.' });

  const cleanEmail = email.toLowerCase().trim();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO buyers (id, email, password_hash, name, company) VALUES ($1,$2,$3,$4,$5)',
      [id, cleanEmail, hash, name.trim(), (company||'').trim()]
    );
    req.session.buyerPortal = { id, email: cleanEmail, name: name.trim() };
    res.json({ ok: true });
    sendBuyerWelcomeEmail({ email: cleanEmail, password, name: name.trim(), req }).catch(() => {});
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé. Connectez-vous directement sur le portail.' });
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ==================== BUYER ACCESS (magic link) ====================

app.post('/api/buyer/request-link', async (req, res) => {
  const { brand_id, email } = req.body;
  if (!brand_id || !email) return res.status(400).json({ error: 'Email requis' });

  const b = await pool.query('SELECT id, name FROM brands WHERE id=$1', [brand_id]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });

  const hasOrders = await pool.query('SELECT 1 FROM orders WHERE brand_id=$1 AND client_email=$2 LIMIT 1', [brand_id, email]);
  // Always respond success regardless, to avoid leaking which emails have ordered
  if (hasOrders.rows[0]) {
    const token = uuidv4();
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await pool.query('INSERT INTO buyer_magic_links (token, brand_id, email, expires_at) VALUES ($1,$2,$3,$4)', [token, brand_id, email, expires]);

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      const { Resend } = require('resend');
      const resend = new Resend(resendKey);
      const fromAddress = await getSetting('smtp_from');
      const showroomName = await getSetting('showroom_name');
      const fromField = fromAddress || 'showroom@editionsstandard.com';
      const url = `${getBaseUrl(req)}/buyer/${brand_id}?token=${token}`;
      await resend.emails.send({
        from: `${showroomName} <${fromField}>`,
        to: [email],
        subject: `Votre espace commandes — ${b.rows[0].name}`,
        html: emailLayout({
          showroomName,
          brandName: b.rows[0].name,
          content: `
            <p>Bonjour,</p>
            <p>Cliquez sur le lien ci-dessous pour accéder à l'historique de vos commandes pour <strong>${b.rows[0].name}</strong>.</p>
            ${emailBtn(url, 'Accéder à mon espace →')}
            <p style="font-size:13px;color:#888;margin-top:24px">Ce lien est valable <strong>30 minutes</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
          `
        })
      }).catch(e => console.error('Buyer magic link email error:', e.message));
    }
  }

  res.json({ ok: true, message: 'Si un compte existe pour cet email, un lien a été envoyé.' });
});

app.get('/api/buyer/verify', async (req, res) => {
  const { brand_id, token } = req.query;
  const r = await pool.query('SELECT * FROM buyer_magic_links WHERE token=$1 AND brand_id=$2', [token, brand_id]);
  const link = r.rows[0];
  if (!link || link.used || new Date(link.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Lien invalide ou expiré' });
  }
  await pool.query('UPDATE buyer_magic_links SET used=1 WHERE token=$1', [token]);
  req.session.buyerEmail = link.email;
  req.session.buyerBrandId = brand_id;
  res.json({ ok: true, email: link.email });
});

app.get('/api/buyer/orders', async (req, res) => {
  if (!req.session.buyerEmail || !req.session.buyerBrandId) return res.status(401).json({ error: 'Non connecté' });
  const r = await pool.query(`
    SELECT o.*, SUM(ol.quantity * ol.unit_price) as total
    FROM orders o
    LEFT JOIN order_lines ol ON ol.order_id = o.id
    WHERE o.brand_id=$1 AND o.client_email=$2
    GROUP BY o.id ORDER BY o.created_at DESC
  `, [req.session.buyerBrandId, req.session.buyerEmail]);
  res.json({ email: req.session.buyerEmail, orders: r.rows });
});

app.get('/api/buyer/orders/:id/pdf', async (req, res) => {
  if (!req.session.buyerEmail || !req.session.buyerBrandId) return res.status(401).json({ error: 'Non connecté' });
  try {
    const r = await pool.query(
      'SELECT id FROM orders WHERE id=$1 AND brand_id=$2 AND client_email=$3',
      [req.params.id, req.session.buyerBrandId, req.session.buyerEmail]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Non disponible' });
    const pdf = await generateOrderPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Commande-${req.params.id.slice(0,8).toUpperCase()}.pdf"`);
    res.send(pdf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/buyer/:brandId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'buyer.html')));
app.get('/rdv/:brandId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'rdv.html')));

// ==================== PDF ====================

async function generateSelectionPDF({ brand, client_name, client_email, client_company, client_country, lines, showroomName, agentName }) {
  let logoBuf = null;
  try {
    const svg2img = require('svg2img');
    const svgSrc = fs.readFileSync(path.join(__dirname, 'public', 'logo.svg'), 'utf8');
    logoBuf = await new Promise((res, rej) =>
      svg2img(svgSrc, { width: 120, height: 120 }, (err, buf) => err ? rej(err) : res(buf))
    );
  } catch(e) {}

  const dateStr = new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });
  const total = lines.reduce((s, l) => s + l.quantity * parseFloat(l.product?.price || 0), 0);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    const hTop = 50;
    if (logoBuf) doc.image(logoBuf, 50, hTop, { width: 44, height: 44 });
    const tx = logoBuf ? 106 : 50;
    doc.fontSize(18).fillColor('#0a0a0a').font('Helvetica-Bold').text(showroomName, tx, hTop + 2, { lineBreak: false });
    doc.fontSize(9).fillColor('#888').font('Helvetica').text('Proposition de sélection — NON SIGNÉE', tx, hTop + 24, { lineBreak: false });
    doc.fontSize(8).fillColor('#aaa').text(dateStr, tx, hTop + 36, { lineBreak: false });
    doc.moveTo(50, hTop + 54).lineTo(545, hTop + 54).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

    // Client + brand info
    const infoY = hTop + 64;
    doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text('MARQUE', 50, infoY);
    doc.fontSize(12).fillColor('#0a0a0a').font('Helvetica-Bold').text(brand.name, 50, infoY + 12);
    doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text('CLIENT', 300, infoY);
    doc.fontSize(11).fillColor('#0a0a0a').font('Helvetica-Bold').text(client_name || '', 300, infoY + 12);
    doc.fontSize(9).fillColor('#555').font('Helvetica');
    if (client_company) doc.text(client_company, 300);
    doc.fillColor('#777').text(client_email || '', 300);
    if (client_country) doc.text(client_country, 300);

    const tableTop = infoY + 68;
    doc.moveTo(50, tableTop).lineTo(545, tableTop).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

    // Table header
    const col = { ref:50, name:145, color:280, size:330, qty:368, pw:405, pr:450, total:495 };
    const colW = { ref:90, name:130, color:45, size:33, qty:27, pw:40, pr:45, total:50 };
    const headers = ['RÉFÉRENCE','DÉSIGNATION','COULEUR','TAILLE','QTÉ','P.U. HT','RETAIL','TOTAL HT'];
    const colKeys = ['ref','name','color','size','qty','pw','pr','total'];
    const thY = tableTop + 8;
    doc.fontSize(7).fillColor('#aaa').font('Helvetica');
    headers.forEach((h, i) => {
      doc.text(h, col[colKeys[i]], thY, { width: colW[colKeys[i]], align: i >= 4 ? 'right' : 'left' });
    });
    doc.moveTo(50, thY + 14).lineTo(545, thY + 14).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

    let rowY = thY + 20;
    lines.forEach((l, i) => {
      const p = l.product || {};
      const rawName = p.description || '';
      const nameText = rawName.length > 60 ? rawName.slice(0, 57) + '…' : rawName;
      const nameH = doc.heightOfString(nameText, { width: colW.name });
      const rowH = Math.max(nameH, 14) + 8;
      if (i % 2 === 0) doc.rect(50, rowY - 2, 495, rowH).fillColor('#f7f7f7').fill();
      doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(p.reference || '', col.ref, rowY, { width: colW.ref });
      doc.fillColor('#333').font('Helvetica').text(nameText, col.name, rowY, { width: colW.name });
      doc.fillColor('#555')
        .text(l.color || p.color || '—', col.color, rowY, { width: colW.color })
        .text(l.size || '—', col.size, rowY, { width: colW.size });
      doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(String(l.quantity), col.qty, rowY, { width: colW.qty, align: 'right' });
      doc.fillColor('#333').font('Helvetica')
        .text(`${parseFloat(p.price||0).toFixed(2)} €`, col.pw, rowY, { width: colW.pw, align: 'right' })
        .text(p.price_retail > 0 ? `${parseFloat(p.price_retail).toFixed(2)} €` : '—', col.pr, rowY, { width: colW.pr, align: 'right' });
      doc.fillColor('#0a0a0a').font('Helvetica-Bold')
        .text(`${(l.quantity * parseFloat(p.price||0)).toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });
      rowY += rowH;
    });

    // Total
    doc.moveTo(50, rowY + 2).lineTo(545, rowY + 2).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    rowY += 12;
    doc.rect(380, rowY - 4, 165, 22).fillColor('#0a0a0a').fill();
    doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold')
      .text('TOTAL HT', 390, rowY, { width: 80 })
      .text(`${total.toFixed(2)} €`, 390, rowY, { width: 145, align: 'right' });
    rowY += 34;

    // Watermark notice
    doc.rect(50, rowY, 495, 38).fillColor('#fffde7').fill();
    doc.fontSize(8.5).fillColor('#b8860b').font('Helvetica-Bold')
      .text('⚠ DOCUMENT NON CONTRACTUEL — Proposition de sélection non signée', 60, rowY + 6, { width: 475, align: 'center' });
    doc.fontSize(7.5).fillColor('#b8860b').font('Helvetica')
      .text('Cette sélection ne constitue pas une commande ferme. Elle doit être signée par les deux parties pour être valide.', 60, rowY + 19, { width: 475, align: 'center' });
    rowY += 50;

    doc.fontSize(7.5).fillColor('#ccc').font('Helvetica')
      .text(`Document généré automatiquement — ${showroomName}`, 50, rowY, { align: 'center', width: 495 });

    doc.end();
  });
}

async function generateLinesheetPDF(brandId, seasonId) {
  const bRes = await pool.query('SELECT * FROM brands WHERE id=$1', [brandId]);
  const brand = bRes.rows[0];
  if (!brand) throw new Error('Marque introuvable');

  const showroomName = await getSetting('showroom_name');

  let query = 'SELECT * FROM products WHERE brand_id=$1 AND active=1';
  const params = [brandId];
  if (seasonId) { query += ' AND season_id=$2'; params.push(seasonId); }
  query += ' ORDER BY collection_name, reference';
  const prods = await pool.query(query, params);

  let logoBuf = null;
  try {
    const svg2img = require('svg2img');
    const svgSrc = fs.readFileSync(path.join(__dirname, 'public', 'logo.svg'), 'utf8');
    logoBuf = await new Promise((res, rej) =>
      svg2img(svgSrc, { width: 120, height: 120 }, (err, buf) => err ? rej(err) : res(buf))
    );
  } catch(e) {}

  const dateStr = new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;   // ~842
    const contentRight = pageW - 40;
    const contentW = contentRight - 40;

    const drawHeader = () => {
      const hTop = 40;
      if (logoBuf) doc.image(logoBuf, 40, hTop, { width: 36, height: 36 });
      const tx = logoBuf ? 84 : 40;
      doc.fontSize(15).fillColor('#0a0a0a').font('Helvetica-Bold').text(brand.name, tx, hTop, { lineBreak: false });
      doc.fontSize(8).fillColor('#888').font('Helvetica').text(`Linesheet — ${showroomName}`, tx, hTop + 17, { lineBreak: false });
      doc.fontSize(7).fillColor('#aaa').text(dateStr, tx, hTop + 27, { lineBreak: false });
      doc.moveTo(40, hTop + 44).lineTo(contentRight, hTop + 44).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
      return hTop + 54;
    };

    let y = drawHeader();
    let currentCollection = null;

    // Two-column layout in landscape: image left of each column, full description to its right
    const colGap = 24;
    const colW = (contentW - colGap) / 2;
    const imgW = 120, imgH = 120, textGap = 14;
    const textW = colW - imgW - textGap;
    const cols = [40, 40 + colW + colGap];
    let colY = [y, y];

    const getFirstImage = (p) => {
      try {
        const imgs = JSON.parse(p.images || '[]');
        if (imgs.length) return imgs[0];
      } catch(e) {}
      return p.image_url || null;
    };

    const measureCardHeight = (p) => {
      const nameText = p.description || '';
      doc.fontSize(7.5).font('Helvetica');
      const nameH = nameText ? doc.heightOfString(nameText, { width: textW }) : 0;
      let ty = 14 + nameH + 4;
      if (p.color) ty += 11;
      if (p.sizes) ty += 11;
      ty += 14; // price line
      return Math.max(ty, imgH) + 16;
    };

    const drawProductCard = (p, x, yy) => {
      const img = getFirstImage(p);
      const textX = x + imgW + textGap;
      if (img && img.startsWith('data:image')) {
        try {
          const base64 = img.replace(/^data:image\/\w+;base64,/, '');
          const buf = Buffer.from(base64, 'base64');
          doc.rect(x, yy, imgW, imgH).fillColor('#f2f2f2').fill();
          doc.image(buf, x, yy, { fit: [imgW, imgH], align: 'center', valign: 'center' });
        } catch(e) {
          doc.rect(x, yy, imgW, imgH).fillColor('#f2f2f2').fill();
        }
      } else {
        doc.rect(x, yy, imgW, imgH).fillColor('#f2f2f2').fill();
      }

      let ty = yy;
      doc.fontSize(9).fillColor('#0a0a0a').font('Helvetica-Bold').text(p.reference, textX, ty, { width: textW });
      ty += 14;
      const nameText = p.description || '';
      if (nameText) {
        doc.fontSize(7.5).fillColor('#555').font('Helvetica').text(nameText, textX, ty, { width: textW });
        ty += doc.heightOfString(nameText, { width: textW }) + 4;
      }
      if (p.color) { doc.fontSize(7).fillColor('#888').text(p.color, textX, ty, { width: textW }); ty += 11; }
      if (p.sizes) { doc.fontSize(7).fillColor('#888').text(p.sizes, textX, ty, { width: textW }); ty += 11; }
      doc.fontSize(8).fillColor('#0a0a0a').font('Helvetica-Bold').text(`${parseFloat(p.price||0).toFixed(2)} €`, textX, ty, { width: textW / 2, continued: p.price_retail > 0 });
      if (p.price_retail > 0) doc.fontSize(7.5).fillColor('#888').font('Helvetica').text(`   RRP ${parseFloat(p.price_retail).toFixed(2)} €`);
    };

    const newPage = () => {
      doc.addPage();
      const ny = drawHeader();
      colY = [ny, ny];
    };

    prods.rows.forEach((p) => {
      if (p.collection_name && p.collection_name !== currentCollection) {
        currentCollection = p.collection_name;
        // start new collection on a fresh left column row
        const rowY = Math.max(colY[0], colY[1]);
        colY = [rowY, rowY];
        if (rowY > doc.page.height - 120) { newPage(); }
        doc.fontSize(10).fillColor('#CCEB3C').font('Helvetica-Bold').text(currentCollection.toUpperCase(), 40, colY[0], { width: contentW });
        colY = [colY[0] + 18, colY[0] + 18];
      }

      const cardH = measureCardHeight(p);
      const pageLimit = doc.page.height - 50;

      // Place in whichever column has the most room; fall back to a new page if neither fits.
      let idx = colY[0] <= colY[1] ? 0 : 1;
      if (colY[idx] + cardH > pageLimit) {
        const otherIdx = idx === 0 ? 1 : 0;
        if (colY[otherIdx] + cardH <= pageLimit) {
          idx = otherIdx;
        } else {
          newPage();
          idx = 0;
        }
      }

      const x = cols[idx];
      drawProductCard(p, x, colY[idx]);
      doc.moveTo(x, colY[idx] + cardH - 8).lineTo(x + colW, colY[idx] + cardH - 8).strokeColor('#eee').lineWidth(0.5).stroke();
      colY[idx] += cardH;
    });

    doc.fontSize(7).fillColor('#ccc').font('Helvetica')
      .text(`Document généré automatiquement — ${showroomName}`, 40, doc.page.height - 30, { align: 'center', width: contentW });

    doc.end();
  });
}

async function generateOrderPDF(orderId) {
  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name, b.cgv_text as brand_cgv FROM orders o JOIN brands b ON o.brand_id=b.id WHERE o.id=$1
  `, [orderId]);
  const order = oRes.rows[0];
  if (!order) throw new Error('Commande introuvable');

  const lRes = await pool.query(`
    SELECT ol.*, p.reference, p.description as product_name, p.color
    FROM order_lines ol JOIN products p ON ol.product_id=p.id
    WHERE ol.order_id=$1
  `, [orderId]);
  const lines = lRes.rows;

  const showroomName = await getSetting('showroom_name');
  const agentName    = await getSetting('agent_name');
  const agentTitle   = await getSetting('agent_title');
  const globalCgv    = await getSetting('cgv_text');
  const cgvText      = order.brand_cgv || globalCgv;

  // Convert SVG logo to PNG buffer
  let logoBuf = null;
  try {
    const svg2img = require('svg2img');
    const svgSrc = fs.readFileSync(path.join(__dirname, 'public', 'logo.svg'), 'utf8');
    logoBuf = await new Promise((res, rej) =>
      svg2img(svgSrc, { width: 120, height: 120, preserveAspectRatio: true }, (err, buf) =>
        err ? rej(err) : res(buf)
      )
    );
  } catch(e) { /* logo optional */ }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const total   = lines.reduce((s, l) => s + l.quantity * parseFloat(l.unit_price), 0);
    const dateStr = new Date(order.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });

    // ── Header ──
    const headerTop = 50;
    if (logoBuf) {
      doc.image(logoBuf, 50, headerTop, { width: 48, height: 48 });
    }
    const textX = logoBuf ? 110 : 50;
    doc.fontSize(20).fillColor('#0a0a0a').font('Helvetica-Bold')
      .text(showroomName, textX, headerTop + 4, { lineBreak: false });
    doc.fontSize(10).fillColor('#888').font('Helvetica')
      .text('Bon de Commande', textX, headerTop + 30, { lineBreak: false });
    doc.fontSize(9).fillColor('#aaa')
      .text(`N° ${orderId.slice(0,8).toUpperCase()} — ${dateStr}`, textX, headerTop + 44, { lineBreak: false });

    doc.moveTo(50, headerTop + 62).lineTo(545, headerTop + 62).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    const infoY = headerTop + 72;

    // ── Marque / Client ──
    doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text('MARQUE', 50, infoY);
    doc.fontSize(12).fillColor('#0a0a0a').font('Helvetica-Bold').text(order.brand_name, 50, infoY + 12);

    doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text('CLIENT', 300, infoY);
    doc.fontSize(11).fillColor('#0a0a0a').font('Helvetica-Bold').text(order.client_name, 300, infoY + 12);
    doc.fontSize(9).fillColor('#555').font('Helvetica');
    if (order.client_company) doc.text(order.client_company, 300);
    doc.fillColor('#555').text(order.client_email, 300);
    if (order.client_phone) doc.fillColor('#777').text(order.client_phone, 300);

    const tableTop = infoY + 70;
    doc.moveTo(50, tableTop).lineTo(545, tableTop).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

    // ── Table header ──
    const col = { ref:50, name:145, color:280, size:330, qty:368, pw:400, pr:445, total:495 };
    const colW = { ref:90, name:130, color:45,  size:33,  qty:27,  pw:40,  pr:45,  total:50 };
    const headers = ['RÉFÉRENCE','DÉSIGNATION','COULEUR','TAILLE','QTÉ','P.U. HT','RETAIL','TOTAL HT'];
    const colKeys = ['ref','name','color','size','qty','pw','pr','total'];
    const thY = tableTop + 8;

    doc.fontSize(7).fillColor('#aaa').font('Helvetica');
    headers.forEach((h, i) => {
      const align = i >= 4 ? 'right' : 'left';
      doc.text(h, col[colKeys[i]], thY, { width: colW[colKeys[i]], align });
    });
    doc.moveTo(50, thY + 14).lineTo(545, thY + 14).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

    // ── Table rows ──
    let rowY = thY + 20;
    doc.font('Helvetica').fontSize(8.5);

    lines.forEach((line, i) => {
      // Measure name height
      const rawName = line.product_name || '';
      const nameText = rawName.length > 60 ? rawName.slice(0, 57) + '…' : rawName;
      const nameH = doc.heightOfString(nameText, { width: colW.name });
      const rowH  = Math.max(nameH, 14) + 8;

      if (i % 2 === 0) {
        doc.rect(50, rowY - 2, 495, rowH).fillColor('#f7f7f7').fill();
      }

      doc.fillColor('#0a0a0a').font('Helvetica-Bold')
        .text(line.reference || '', col.ref, rowY, { width: colW.ref });
      doc.fillColor('#333').font('Helvetica')
        .text(nameText, col.name, rowY, { width: colW.name });
      doc.fillColor('#555')
        .text(line.color || '—', col.color, rowY, { width: colW.color })
        .text(line.size  || '—', col.size,  rowY, { width: colW.size });
      doc.fillColor('#0a0a0a').font('Helvetica-Bold')
        .text(String(line.quantity), col.qty, rowY, { width: colW.qty, align: 'right' });
      doc.fillColor('#333').font('Helvetica')
        .text(`${parseFloat(line.unit_price).toFixed(2)} €`, col.pw,    rowY, { width: colW.pw,    align: 'right' })
        .text(line.price_retail > 0 ? `${parseFloat(line.price_retail).toFixed(2)} €` : '—', col.pr, rowY, { width: colW.pr, align: 'right' });
      doc.fillColor('#0a0a0a').font('Helvetica-Bold')
        .text(`${(line.quantity * parseFloat(line.unit_price)).toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });

      rowY += rowH;
    });

    // ── Total ──
    doc.moveTo(50, rowY + 2).lineTo(545, rowY + 2).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    rowY += 12;
    doc.rect(380, rowY - 4, 165, 22).fillColor('#0a0a0a').fill();
    doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold')
      .text('TOTAL HT', 390, rowY, { width: 80, align: 'left' })
      .text(`${total.toFixed(2)} €`, 390, rowY, { width: 145, align: 'right' });
    rowY += 26;

    // ── Notes ──
    if (order.notes) {
      rowY += 8;
      doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text('NOTES', 50, rowY);
      rowY += 12;
      doc.fontSize(9).fillColor('#444').font('Helvetica').text(order.notes, 50, rowY, { width: 495 });
      rowY += doc.heightOfString(order.notes, { width: 495 }) + 8;
    }

    // ── CGV ──
    if (cgvText) {
      rowY += 10;
      doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
      rowY += 10;
      doc.fontSize(7).fillColor('#aaa').font('Helvetica')
        .text('CONDITIONS GÉNÉRALES — PROPOSITION DE COMMANDE', 50, rowY, { align: 'center', width: 495 });
      rowY += 14;
      doc.fontSize(7.5).fillColor('#999').font('Helvetica')
        .text(cgvText, 50, rowY, { align: 'justify', lineGap: 1.5, width: 495 });
      rowY += doc.heightOfString(cgvText, { width: 495, lineGap: 1.5 }) + 10;
    }

    // ── Signatures ──
    // If near page bottom, add a new page
    if (rowY > 720) { doc.addPage(); rowY = 50; }
    else rowY += 16;

    doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    rowY += 14;

    const sigY = rowY;
    doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text("L'ACHETEUR", 50, sigY);
    doc.fontSize(9).fillColor('#0a0a0a').font('Helvetica-Bold').text(order.client_name || '', 50, sigY + 13);
    if (order.client_company) doc.fontSize(8).fillColor('#555').font('Helvetica').text(order.client_company, 50, sigY + 25);
    doc.fontSize(7.5).fillColor('#999').font('Helvetica')
      .text('Lu et approuvé — ' + new Date(order.created_at).toLocaleDateString('fr-FR'), 50, sigY + 35);

    if (order.buyer_signature && order.buyer_signature.startsWith('data:image')) {
      try {
        const sigData = order.buyer_signature.replace(/^data:image\/\w+;base64,/, '');
        doc.image(Buffer.from(sigData, 'base64'), 50, sigY + 48, { width: 160, height: 55 });
      } catch(e) {}
    }
    doc.moveTo(50, sigY + 110).lineTo(220, sigY + 110).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.fontSize(7).fillColor('#bbb').font('Helvetica').text('Signature', 50, sigY + 113);

    doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text("L'AGENT / SHOWROOM", 310, sigY);
    doc.fontSize(9).fillColor('#0a0a0a').font('Helvetica-Bold').text(agentName || showroomName, 310, sigY + 13);
    if (agentTitle) doc.fontSize(8).fillColor('#555').font('Helvetica').text(agentTitle, 310, sigY + 25);
    doc.fontSize(7.5).fillColor('#999').font('Helvetica').text('Date : ____________________', 310, sigY + 37);
    doc.moveTo(310, sigY + 110).lineTo(490, sigY + 110).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.fontSize(7).fillColor('#bbb').font('Helvetica').text('Signature', 310, sigY + 113);

    doc.fontSize(7.5).fillColor('#ccc').font('Helvetica')
      .text(`Document généré automatiquement — ${showroomName}`, 50, sigY + 130, { align: 'center', width: 495 });

    doc.end();
  });
}

// ==================== EMAIL ====================

const LOGO_URL = 'https://showroom.editionsstandard.com/logo.svg';

function emailLayout({ showroomName, brandName = '', brandLogo = '', accentColor = '#CCEB3C', content, footer = '' }) {
  const brandBlock = (brandName && brandLogo) ? `
    <div style="background:#fff;padding:20px 32px;text-align:center;border-bottom:1px solid #eee">
      <img src="${brandLogo}" alt="${brandName}" style="max-height:56px;max-width:180px;object-fit:contain">
    </div>` : brandName ? `
    <div style="background:#fff;padding:16px 32px;text-align:center;border-bottom:1px solid #eee">
      <span style="font-family:'Courier New',Courier,monospace;font-size:16px;font-weight:700;letter-spacing:2px;color:#0a0a0a">${brandName.toUpperCase()}</span>
    </div>` : '';

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f2f0">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f0;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

  <!-- HEADER -->
  <tr><td style="background:#0a0a0a;padding:22px 32px;text-align:center;border-radius:6px 6px 0 0">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:left;vertical-align:middle">
        <img src="${LOGO_URL}" alt="${showroomName}" width="36" height="36" style="border-radius:6px;vertical-align:middle">
      </td>
      <td style="text-align:right;vertical-align:middle">
        <span style="font-family:'Courier New',Courier,monospace;color:${accentColor};font-size:13px;font-weight:700;letter-spacing:3px">${showroomName.toUpperCase()}</span>
      </td>
    </tr></table>
  </td></tr>

  ${brandBlock ? `<tr><td>${brandBlock}</td></tr>` : ''}

  <!-- BODY -->
  <tr><td style="background:#fff;padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.7">
    ${content}
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f7f7f5;padding:16px 32px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#aaa;border-radius:0 0 6px 6px;border-top:1px solid #eee">
    ${footer || `${showroomName} — Document généré automatiquement`}
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function emailBtn(url, label) {
  return `<table cellpadding="0" cellspacing="0" style="margin:28px auto">
    <tr><td style="background:#0a0a0a;border-radius:4px;padding:14px 28px;text-align:center">
      <a href="${url}" style="color:#fff;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:1px">${label}</a>
    </td></tr>
  </table>`;
}

function emailInfoBox(rows) {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;background:#f7f7f5;border-radius:4px;padding:0;margin:20px 0">
    <tr><td style="padding:16px 20px">
      ${rows.map(([label, value]) => `
        <p style="margin:0 0 10px;font-size:13px"><span style="color:#888;display:inline-block;min-width:120px">${label}</span><strong style="color:#0a0a0a">${value}</strong></p>
      `).join('')}
    </td></tr>
  </table>`;
}

async function sendOrderEmails(orderId, pdfBuffer) {
  const resendKey = process.env.RESEND_API_KEY;
  const [showroomEmail, showroomName, agentName, fromAddress] = await Promise.all([
    getSetting('showroom_email'), getSetting('showroom_name'),
    getSetting('agent_name'), getSetting('smtp_from')
  ]);
  if (!resendKey) { console.log('RESEND_API_KEY non configurée'); return; }

  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name, b.cgv_text as brand_cgv, b.logo as brand_logo,
      SUM(ol.quantity * ol.unit_price) as order_total
    FROM orders o
    JOIN brands b ON o.brand_id=b.id
    LEFT JOIN order_lines ol ON ol.order_id=o.id
    WHERE o.id=$1
    GROUP BY o.id, b.name, b.cgv_text, b.logo
  `, [orderId]);
  const order = oRes.rows[0];
  const filename = `PropositionCommande-${order.brand_name.replace(/\s/g,'-')}-${orderId.slice(0,8).toUpperCase()}.pdf`;
  const totalStr = Number(order.order_total||0).toFixed(2).replace('.',',') + ' €';
  const dateStr = new Date(order.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });
  const globalCgv = await getSetting('cgv_text');
  const cgvText = order.brand_cgv || globalCgv;

  const { Resend } = require('resend');
  const resend = new Resend(resendKey);
  const fromField = fromAddress || 'showroom@editionsstandard.com';
  const fromFormatted = `${showroomName} <${fromField}>`;
  const attachment = { filename, content: pdfBuffer.toString('base64'), contentType: 'application/pdf' };

  // ── Email acheteur ──
  await resend.emails.send({
    from: fromFormatted,
    to: [order.client_email],
    subject: `Proposition de commande — ${order.brand_name} — ${showroomName}`,
    html: emailLayout({
      showroomName,
      brandName: order.brand_name,
      brandLogo: order.brand_logo || '',
      content: `
        <p>Bonjour <strong>${order.client_name}</strong>,</p>
        <p>Nous avons bien reçu votre proposition de commande pour la marque <strong>${order.brand_name}</strong> en date du ${dateStr}.</p>
        <p>Votre proposition de commande signée (total HT : <strong>${totalStr}</strong>) est jointe à cet email en PDF.</p>

        <table cellpadding="0" cellspacing="0" style="width:100%;background:#fffbea;border-left:3px solid #d4a017;border-radius:0 4px 4px 0;margin:24px 0">
          <tr><td style="padding:16px 20px">
            <p style="margin:0 0 8px;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;color:#8a6500;letter-spacing:1px;text-transform:uppercase">Important — Commande non définitive</p>
            <p style="margin:0;font-size:13px;color:#555;line-height:1.7">
              Cette proposition ne constitue <strong>pas un engagement ferme</strong>. Elle sera définitive après :<br>
              &bull; Acceptation formelle de <strong>${order.brand_name}</strong><br>
              &bull; Signature du bon de commande par les deux parties<br><br>
              Un délai de <strong>7 jours ouvrés</strong> est nécessaire pour la version définitive signée.
            </p>
          </td></tr>
        </table>

        <p style="color:#555;font-size:13px">Nous reviendrons vers vous dès confirmation. En cas de question, n'hésitez pas à nous contacter.</p>
        <p style="margin-top:28px">Cordialement,<br><strong>${agentName || showroomName}</strong></p>

        ${cgvText ? `
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee">
          <p style="margin:0 0 8px;font-family:'Courier New',Courier,monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#bbb">Conditions générales — ${order.brand_name}</p>
          <p style="margin:0;font-size:11px;color:#aaa;line-height:1.7;white-space:pre-wrap">${cgvText}</p>
        </div>` : ''}
      `
    }),
    attachments: [attachment]
  });

  // ── Copie showroom ──
  const copyTo = showroomEmail || fromField;
  await resend.emails.send({
    from: fromFormatted,
    to: [copyTo],
    subject: `[BDC] ${order.client_name} — ${order.brand_name} — ${totalStr}`,
    html: emailLayout({
      showroomName,
      brandName: order.brand_name,
      brandLogo: order.brand_logo || '',
      content: `
        <p style="font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;letter-spacing:1px;color:#0a0a0a;text-transform:uppercase;margin-bottom:20px">Nouvelle proposition de commande</p>
        ${emailInfoBox([
          ['Client', order.client_name],
          ...(order.client_company ? [['Société', order.client_company]] : []),
          ['Email', `<a href="mailto:${order.client_email}" style="color:#0a0a0a">${order.client_email}</a>`],
          ...(order.client_phone ? [['Téléphone', order.client_phone]] : []),
          ['Marque', order.brand_name],
          ['Date', dateStr],
          ['Total HT', `<span style="font-size:18px;color:#1a7a1a">${totalStr}</span>`],
        ])}
        <table cellpadding="0" cellspacing="0" style="width:100%;background:#fff3f3;border-left:3px solid #e74c3c;border-radius:0 4px 4px 0;margin:20px 0">
          <tr><td style="padding:14px 18px;font-size:13px;color:#555">
            En attente de votre <strong>contre-signature</strong> pour validation définitive. Le BDC signé par l'acheteur est en pièce jointe.
          </td></tr>
        </table>
      `
    }),
    attachments: [attachment]
  });
}

// ==================== AIRTABLE SYNC ====================


async function syncAirtable(clientEmail, clientCompany, clientName, orderTotal) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) return;

  const base = 'appquOEohNkpH6sbB';
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const today = new Date().toISOString().split('T')[0];

  // Search STORES by email
  let storeRecordId = null;
  try {
    const searchUrl = `https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm?filterByFormula=LOWER({fldbGIrhVTpvBBnZk})="${clientEmail.toLowerCase()}"&maxRecords=1`;
    const sr = await fetch(searchUrl, { headers });
    const sd = await sr.json();
    if (sd.records && sd.records.length > 0) storeRecordId = sd.records[0].id;
  } catch(e) { console.error('Airtable STORES search error:', e.message); }

  // Create ORDERS record
  let newOrderRecordId = null;
  try {
    const orderFields = {
      'fldyOjsWxkqgEOYAb': today,
      'fld5ZC4qLlyTTLAPJ': orderTotal,
      'fld9UkkpaB2KOE2sO': 'Confirmed',
      'fld936ErcEnR26Sl4': ['recOdXdfVsZ89W7pF']
    };
    if (storeRecordId) orderFields['flduQAMJ1BhBKvMOr'] = [storeRecordId];
    const cr = await fetch(`https://api.airtable.com/v0/${base}/tblkch3T3ckbhyRiN`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields: orderFields })
    });
    const cd = await cr.json();
    if (cd.id) newOrderRecordId = cd.id;
  } catch(e) { console.error('Airtable ORDERS create error:', e.message); }

  // Update STORES record: Statuts=Client + Last Contact=today
  if (storeRecordId) {
    try {
      const patchFields = {
        'fldNdh83yBoZONLhP': 'Client',
        'fldoXxM2cxB8pRWSj': today
      };
      await fetch(`https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm/${storeRecordId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: patchFields })
      });
    } catch(e) { console.error('Airtable STORES patch error:', e.message); }
  }
}

// Start
init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Showroom BDC démarré sur http://localhost:${PORT}`);
    console.log(`   Admin : http://localhost:${PORT}/admin\n`);
  });
}).catch(err => {
  console.error('Erreur démarrage DB:', err.message);
  process.exit(1);
});
