const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const { Resend } = require('resend');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const { pool, init } = require('./database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // CSP off car inline scripts dans admin/portal
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
    return res.status(400).send("Webhook signature error");
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const stripeSession = event.data.object;
      const brandId = stripeSession.metadata?.brand_id;
      if (brandId) {
        await pool.query(
          'UPDATE brands SET subscription_status=$1, stripe_customer_id=$2, stripe_subscription_id=$3 WHERE id=$4',
          ['active', stripeSession.customer, stripeSession.subscription, brandId]
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
// Favicon → réutilise le logo (évite le 404 /favicon.ico sur chaque page)
app.get('/favicon.ico', (req, res) => res.redirect(301, '/logo.svg'));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true
}));
if (!process.env.SESSION_SECRET) console.warn('⚠️  SESSION_SECRET non défini — utilisez une valeur aléatoire en production');
app.use(session({
  store: process.env.DATABASE_URL ? new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }) : undefined,
  secret: process.env.SESSION_SECRET || (() => { if (process.env.NODE_ENV === 'production') { console.error('⚠️  SESSION_SECRET non défini — utiliser une valeur aléatoire en production!'); } return 'showroom-dev-fallback-not-for-production'; })(),
  resave: false,
  saveUninitialized: false,
  name: 'sid',
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Helpers
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function cloudinaryOpt(url) {
  if (!url || !url.includes('res.cloudinary.com')) return url;
  return url.replace('/upload/', '/upload/q_auto,f_auto/');
}

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
      // Restrict designer AND agent (when brand_id set) to their own brand
      if (req.userRole === 'designer' || (req.userRole === 'agent' && req.userBrandId)) {
        const brandParam = req.params.brandId || req.params.id;
        if (brandParam && brandParam !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
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

const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 5,
  message: { error: 'Trop de demandes. Réessayez dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false
});

const publicLimiter = rateLimit({
  windowMs: 3600000, // 1 heure
  max: 30,
  message: { error: 'Trop de demandes. Réessayez dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false
});

const passwordLimiter = rateLimit({
  windowMs: 900000, // 15 minutes
  max: 5,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// ==================== ADMIN ROUTES ====================

app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

app.post('/admin/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (email) {
    const r = await pool.query('SELECT id, email, role, brand_id, name, password_hash FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    const user = r.rows[0];
    if (user && await bcrypt.compare(password || '', user.password_hash)) {
      return req.session.regenerate(err => {
        if (err) return res.redirect('/admin/login?error=1');
        req.session.staffUser = { id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, name: user.name };
        res.redirect('/admin');
      });
    }
    return res.redirect('/admin/login?error=1');
  }

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
    req.session.regenerate(err => {
      if (err) return res.redirect('/admin/login?error=1');
      req.session.admin = true;
      res.redirect('/admin');
    });
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
    console.error(err); res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put('/api/staff/:id', requireRole('owner'), async (req, res) => {
  try {
    const { name, email, role, brand_id, password } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE admin_users SET name=$1,email=$2,role=$3,brand_id=$4,password_hash=$5 WHERE id=$6', [name, email, role, brand_id || null, hash, req.params.id]);
    } else {
      await pool.query('UPDATE admin_users SET name=$1,email=$2,role=$3,brand_id=$4 WHERE id=$5', [name, email, role, brand_id || null, req.params.id]);
    }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.delete('/api/staff/:id', requireRole('owner'), async (req, res) => {
  try {
    // Prevent deleting the last owner
    const target = await pool.query('SELECT role FROM admin_users WHERE id=$1', [req.params.id]);
    if (target.rows[0]?.role === 'owner') {
      const ownerCount = await pool.query("SELECT COUNT(*) FROM admin_users WHERE role='owner'");
      if (parseInt(ownerCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Impossible de supprimer le dernier compte owner.' });
      }
    }
    await pool.query('DELETE FROM admin_users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
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
  const { name, logo_url, logo, cover_image, thumbnail, cgv_text, moq_qty, moq_amount, about_text, lookbook_url } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = uuidv4();
  await pool.query('INSERT INTO brands (id,name,logo_url,logo,cover_image,thumbnail,cgv_text,moq_qty,moq_amount,about_text,lookbook_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, name, logo_url||'', logo||'', cover_image||'', thumbnail||'', cgv_text||'', moq_qty||0, moq_amount||0, about_text||'', lookbook_url||'']);
  res.json({ id, name });
});

app.put('/api/brands/:id', requireRole('owner'), async (req, res) => {
  try {
    const { name, logo_url, logo, cover_image, thumbnail, cgv_text, moq_qty, moq_amount, about_text, lookbook_url } = req.body;
    await pool.query('UPDATE brands SET name=$1, logo_url=$2, logo=$3, cover_image=$4, thumbnail=$5, cgv_text=$6, moq_qty=$7, moq_amount=$8, about_text=$9, lookbook_url=$10 WHERE id=$11',
      [name, logo_url||'', logo||'', cover_image||'', thumbnail||'', cgv_text||'', moq_qty||0, moq_amount||0, about_text||'', lookbook_url||'', req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Mise à jour du lookbook seul (scopé marque — accessible owner/agent/designer)
app.put('/api/brands/:brandId/lookbook', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const { lookbook_url } = req.body;
    await pool.query('UPDATE brands SET lookbook_url=$1 WHERE id=$2', [lookbook_url || '', req.params.brandId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/brands/:id', requireRole('owner'), async (req, res) => {
  try {
    await pool.query('DELETE FROM brands WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/brands/:id/qrcode', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('SELECT * FROM brands WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const url = `${getBaseUrl(req)}/commande/${req.params.id}`;
  const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  res.json({ qr, url });
});

// QR d'accès de TOUTES les marques (pour impression sur une feuille A4)
app.get('/api/brands-qrcodes', requireRole('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query("SELECT id, name, logo, logo_url FROM brands WHERE subscription_status IS NULL OR subscription_status != 'inactive' ORDER BY name");
    const base = getBaseUrl(req);
    const items = await Promise.all(r.rows.map(async b => {
      const url = `${base}/commande/${b.id}`;
      const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
      return { id: b.id, name: b.name, logo: b.logo || b.logo_url || '', qr, url };
    }));
    res.json({ items });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
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
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/admin?subscribed=1`,
      cancel_url: `${base}/admin`,
      metadata: { brand_id: id }
    });
    await pool.query('UPDATE brands SET subscription_price_id=$1 WHERE id=$2', [priceId, id]);
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error(err); res.status(500).json({ error: "Erreur serveur" });
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
    console.error(err); res.status(500).json({ error: "Erreur serveur" });
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
  const prods = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active != 0 ORDER BY reference', [req.params.brandId]);
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
  // Upsert: update existing product with same reference in this brand
  const existing = await pool.query('SELECT id FROM products WHERE brand_id=$1 AND reference=$2', [req.params.brandId, reference]);
  if (existing.rows[0]) {
    const eid = existing.rows[0].id;
    const fields = [], vals = [];
    const set = (col, val) => { if (val !== undefined && val !== null && val !== '') { fields.push(`${col}=$${vals.push(val)}`); } };
    set('description', description); set('color', color); set('sizes', sizes);
    set('price', price > 0 ? price : undefined); set('price_retail', price_retail > 0 ? price_retail : undefined);
    set('image_url', image_url); set('collection_name', collection_name);
    set('category', category); set('composition', composition);
    if (fields.length) { vals.push(eid); await pool.query(`UPDATE products SET ${fields.join(',')} WHERE id=$${vals.length}`, vals); }
    return res.json({ id: eid, updated: true });
  }
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
  try {
    if (!await checkProductBrandScope(req, res)) return;
    const { reference, description, color, sizes, price, price_retail, image_url, active, collection_name, category, composition, images, variants, season_id } = req.body;
    await pool.query(
      'UPDATE products SET reference=$1,description=$2,color=$3,sizes=$4,price=$5,price_retail=$6,image_url=$7,active=$8,collection_name=$9,category=$10,composition=$11,images=$12,variants=$13,season_id=$14 WHERE id=$15',
      [reference, description||'', color||'', sizes||'', price||0, price_retail||0, image_url||'', active!==undefined?active:1, collection_name||'', category||'', composition||'', JSON.stringify(images||[]), JSON.stringify(variants||[]), season_id||null, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.patch('/api/products/:id/prices', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    if (!await checkProductBrandScope(req, res)) return;
    const fields = [];
    const vals = [];
    if (req.body.price !== undefined)        { fields.push(`price=$${vals.push(parseFloat(req.body.price)||0)}`); }
    if (req.body.price_retail !== undefined) { fields.push(`price_retail=$${vals.push(parseFloat(req.body.price_retail)||0)}`); }
    if (!fields.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    vals.push(req.params.id);
    await pool.query(`UPDATE products SET ${fields.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.delete('/api/products/:id', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    if (!await checkProductBrandScope(req, res)) return;
    // Un produit présent dans des commandes ne peut pas être supprimé (clé étrangère).
    // On renvoie un message clair et on propose la désactivation.
    const used = await pool.query('SELECT 1 FROM order_lines WHERE product_id=$1 LIMIT 1', [req.params.id]);
    if (used.rows.length) {
      return res.status(409).json({ error: 'Ce produit figure dans des commandes : il ne peut pas être supprimé. Désactivez-le pour le masquer du catalogue.', used: true });
    }
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// bulk MUST be declared before the catch-all /:brandId/products route
app.delete('/api/brands/:brandId/products/bulk', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'IDs requis' });
  await pool.query('DELETE FROM products WHERE id = ANY($1) AND brand_id=$2', [ids, req.params.brandId]);
  res.json({ ok: true, deleted: ids.length });
});

app.delete('/api/brands/:brandId/products', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('DELETE FROM products WHERE brand_id=$1', [req.params.brandId]);
  res.json({ ok: true, deleted: r.rowCount });
});

// Action groupée sur une collection entière : activer / désactiver / supprimer
app.post('/api/brands/:brandId/products/collection-bulk', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const { collection, action } = req.body;
    if (!collection) return res.status(400).json({ error: 'Collection requise' });
    const brandId = req.params.brandId;
    if (action === 'activate' || action === 'deactivate') {
      const active = action === 'activate' ? 1 : 0;
      const r = await pool.query('UPDATE products SET active=$1 WHERE brand_id=$2 AND collection_name=$3', [active, brandId, collection]);
      return res.json({ ok: true, count: r.rowCount });
    }
    if (action === 'delete') {
      // Supprime les produits sans commande, désactive ceux référencés par des commandes (FK)
      const prods = await pool.query('SELECT id FROM products WHERE brand_id=$1 AND collection_name=$2', [brandId, collection]);
      let deleted = 0, deactivated = 0;
      for (const p of prods.rows) {
        const used = await pool.query('SELECT 1 FROM order_lines WHERE product_id=$1 LIMIT 1', [p.id]);
        if (used.rows.length) { await pool.query('UPDATE products SET active=0 WHERE id=$1', [p.id]); deactivated++; }
        else { await pool.query('DELETE FROM products WHERE id=$1', [p.id]); deleted++; }
      }
      return res.json({ ok: true, deleted, deactivated });
    }
    return res.status(400).json({ error: 'Action invalide' });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
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
  try {
    if (!await checkProductBrandScope(req, res)) return;
    const { active } = req.body;
    await pool.query('UPDATE products SET active=$1 WHERE id=$2', [active ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/upload-image', requireRole('owner','agent','designer'), upload.single('image'), async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Fichier image requis (jpg, png, webp…)' });
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
    console.error(e); res.status(500).json({ error: "Erreur serveur" });
  }
});

const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/upload-pdf', requireRole('owner','agent','designer'), uploadPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Fichier PDF requis' });
    const base64 = `data:application/pdf;base64,${req.file.buffer.toString('base64')}`;
    const slug = `lookbook-${Date.now()}`;
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'showroom/lookbooks',
      public_id: slug,
      resource_type: 'raw'
    });
    res.json({ url: result.secure_url });
  } catch(e) {
    console.error(e); res.status(500).json({ error: "Erreur serveur" });
  }
});

app.delete('/api/brands/:brandId/products-photos', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query("UPDATE products SET images='[]', image_url='' WHERE brand_id=$1", [req.params.brandId]);
  res.json({ ok: true, cleared: r.rowCount });
});

// ==================== LINESHEET PDF ====================

app.get('/api/brands/:brandId/linesheet-pdf', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const pdf = await generateLinesheetPDF(req.params.brandId, req.query.season_id || null);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="linesheet.pdf"');
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
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
  const bookedSet = new Set(booked.rows.map(b => {
    const d = b.slot_date instanceof Date ? b.slot_date.toISOString().slice(0,10) : String(b.slot_date).slice(0,10);
    return `${d}_${b.slot_time}`;
  }));
  const slots = days.map(date => ({
    date,
    times: times.filter(t => !bookedSet.has(`${date}_${t}`))
  })).filter(d => d.times.length > 0);
  res.json({ slots });
});

app.post('/api/public/appointments', publicLimiter, async (req, res) => {
  const { brand_id, client_name, client_email, client_phone, slot_date, slot_time, notes } = req.body;
  if (!brand_id || !client_name || !client_email || !slot_date || !slot_time) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO appointments (id,brand_id,client_name,client_email,client_phone,slot_date,slot_time,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, brand_id, client_name, client_email, client_phone||'', slot_date, slot_time, notes||'']
    );
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ce créneau est déjà réservé' });
    throw e;
  }
  res.json({ ok: true, id });
});

app.post('/api/brands/:brandId/repair-fields', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { brandId } = req.params;
  const prods = await pool.query('SELECT id, description, color, category, composition FROM products WHERE brand_id=$1', [brandId]);
  // Patterns: "Category: Top." / "Color: Black." / "Material: Cotton 100%." / "Matière: ..."
  const extract = (text, ...keys) => {
    for (const k of keys) {
      const m = text.match(new RegExp(k + '\\s*:\\s*([^.]+)\\.?', 'i'));
      if (m) return m[1].trim();
    }
    return null;
  };
  let updated = 0;
  for (const p of prods.rows) {
    const desc = p.description || '';
    const newCategory   = (!p.category   || p.category   === '') ? extract(desc, 'Category', 'Catégorie', 'Type') : null;
    const newColor      = (!p.color      || p.color      === '') ? extract(desc, 'Color', 'Couleur', 'Coloris', 'Finish') : null;
    const newCompo      = (!p.composition|| p.composition=== '') ? extract(desc, 'Material', 'Matière', 'Composition', 'Fabric') : null;
    if (!newCategory && !newColor && !newCompo) continue;
    // Strip extracted info from description to avoid duplication
    let cleanDesc = desc;
    if (newCategory) cleanDesc = cleanDesc.replace(new RegExp('[. ]*Category\\s*:\\s*' + newCategory.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\.?', 'i'), '').trim();
    if (newColor)    cleanDesc = cleanDesc.replace(new RegExp('[. ]*Colo(?:r|ur|ris)\\s*:\\s*' + newColor.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\.?', 'i'), '').trim();
    if (newCompo)    cleanDesc = cleanDesc.replace(new RegExp('[. ]*(?:Material|Mati[eè]re|Composition|Fabric)\\s*:\\s*' + newCompo.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\.?', 'i'), '').trim();
    cleanDesc = cleanDesc.replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();
    await pool.query(
      'UPDATE products SET category=COALESCE(NULLIF($1,\'\'),category), color=COALESCE(NULLIF($2,\'\'),color), composition=COALESCE(NULLIF($3,\'\'),composition), description=$4 WHERE id=$5',
      [newCategory||'', newColor||'', newCompo||'', cleanDesc, p.id]
    );
    updated++;
  }
  res.json({ ok: true, total: prods.rows.length, updated });
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
  // Build a reference lookup (uppercase) → product list (may have multiple colors)
  const refIndex = new Map();
  for (const p of prods.rows) {
    const key = p.reference.toUpperCase();
    if (!refIndex.has(key)) refIndex.set(key, []);
    refIndex.get(key).push(p);
  }

  const pending = new Map(); // productId -> { images: [...], rank: [...] }
  for (const file of req.files) {
    const name = path.basename(file.originalname, path.extname(file.originalname));
    const parts = name.split('_');

    // Try longest prefix first → shortest to find the best matching reference
    let product = null;
    let colorHint = '';
    for (let len = parts.length; len >= 1; len--) {
      const candidate = parts.slice(0, len).join('_').toUpperCase();
      const matches = refIndex.get(candidate);
      if (!matches) continue;
      colorHint = parts.slice(len).join('_').trim().toLowerCase();
      // If multiple products share the same reference (different colors), pick by color hint
      if (matches.length === 1) { product = matches[0]; break; }
      const byColor = matches.find(p => p.color && colorHint.includes(p.color.toLowerCase()));
      product = byColor || matches[0];
      break;
    }

    if (!product) {
      results.push({ file: file.originalname, status: 'not_found', ref: parts[0].toUpperCase() });
      continue;
    }
    const ref = product.reference;

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
    } catch(e) { console.error('Cloudinary upload error:', e.message); /* keep original value on error */ }
    entry.images.push(imageData);
    entry.ranks.push(viewRank(colorHint));
    results.push({ file: file.originalname, status: 'ok', ref, color: colorHint || product.color });
  }

  for (const [productId, entry] of pending) {
    // Stable sort new images (rank >= 0) to front/back order, keep pre-existing (rank -1) order intact at their relative position
    const indexed = entry.images.map((img, i) => ({ img, rank: entry.ranks[i], i }));
    indexed.sort((a, b) => {
      if (a.rank === -1 && b.rank === -1) return a.i - b.i;
      if (a.rank === -1) return 1;   // old images after new
      if (b.rank === -1) return -1;  // new images first
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
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const offset = parseInt(req.query.offset) || 0;
  const brandFilter = req.userRole === 'designer' ? 'WHERE o.brand_id = $1' : '';
  const params = req.userRole === 'designer' ? [req.userBrandId] : [];
  const r = await pool.query(`
    SELECT o.id, o.order_number, o.brand_id, o.client_name, o.client_email, o.client_company,
           o.client_phone, o.client_country, o.status, o.notes, o.admin_notes,
           o.cgv_accepted, o.buyer_id, o.created_at,
           b.name as brand_name,
           COUNT(ol.id) as line_count,
           SUM(ol.quantity * ol.unit_price) as total
    FROM orders o
    JOIN brands b ON o.brand_id = b.id
    LEFT JOIN order_lines ol ON ol.order_id = o.id
    ${brandFilter}
    GROUP BY o.id, o.order_number, b.name
    ORDER BY o.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `, params);
  res.json(r.rows);
});

app.get('/api/agent-selections', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    const brandFilter = req.userRole === 'designer' ? 'AND a.brand_id = $1' : '';
    const params = req.userRole === 'designer' ? [req.userBrandId] : [];
    const r = await pool.query(`
      SELECT a.token, a.selection_number, a.brand_id, a.client_name, a.client_email, a.client_company,
             a.notes, a.created_by, a.used, a.created_at, a.expires_at,
             b.name as brand_name,
             a.items_json
      FROM agent_selections a
      JOIN brands b ON a.brand_id = b.id
      WHERE 1=1 ${brandFilter}
      ORDER BY a.created_at DESC
    `, params);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/orders/:id/status', requireRole('owner','agent'), async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['confirmed','validated','in_production','shipped','cancelled','archived'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [status, req.params.id]);
    // Notify buyer on meaningful transitions
    if (['validated','in_production','shipped'].includes(status)) {
      sendOrderStatusEmail(req.params.id, status).catch(e => console.error('status email error:', e.message));
    }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

async function sendOrderStatusEmail(orderId, status) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const [showroomName, agentName, fromAddress] = await Promise.all([
    getSetting('showroom_name'), getSetting('agent_name'), getSetting('smtp_from')
  ]);
  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name, b.logo as brand_logo, SUM(ol.quantity * ol.unit_price) as order_total,
           by2.lang as buyer_lang
    FROM orders o JOIN brands b ON o.brand_id=b.id
    LEFT JOIN order_lines ol ON ol.order_id=o.id
    LEFT JOIN buyers by2 ON by2.id=o.buyer_id
    WHERE o.id=$1 GROUP BY o.id, b.name, b.logo, by2.lang
  `, [orderId]);
  const order = oRes.rows[0];
  if (!order) return;
  const resend = new Resend(resendKey);
  const fromField = fromAddress || 'showroom@editionsstandard.com';
  const isEn = order.buyer_lang === 'en';
  const statusMessages = {
    validated:     { fr: 'Votre commande a été <strong>validée</strong> par la marque.', en: 'Your order has been <strong>validated</strong> by the brand.' },
    in_production: { fr: 'Votre commande est <strong>en production</strong>.', en: 'Your order is <strong>in production</strong>.' },
    shipped:       { fr: 'Votre commande a été <strong>expédiée</strong>.', en: 'Your order has been <strong>shipped</strong>.' }
  };
  const msg = statusMessages[status]?.[isEn ? 'en' : 'fr'] || '';
  const statusLabels = {
    validated: isEn ? 'Validated ✓' : 'Validée ✓',
    in_production: isEn ? 'In production' : 'En production',
    shipped: isEn ? 'Shipped 🚚' : 'Expédiée 🚚'
  };
  await resend.emails.send({
    from: `${showroomName} <${fromField}>`,
    to: [order.client_email],
    subject: isEn
      ? `Order update — ${order.brand_name} — ${statusLabels[status]}`
      : `Mise à jour commande — ${order.brand_name} — ${statusLabels[status]}`,
    html: emailLayout({ showroomName, brandName: order.brand_name, brandLogo: order.brand_logo || '', content: `
      <p>${isEn ? 'Hello' : 'Bonjour'} <strong>${escHtml(order.client_name)}</strong>,</p>
      <p>${msg}</p>
      <p style="margin-top:12px;font-size:13px;color:#555">${isEn ? 'Brand' : 'Marque'} : <strong>${escHtml(order.brand_name)}</strong> · ${isEn ? 'Reference' : 'Référence'} : <code>${order.order_number || orderId.slice(0,8).toUpperCase()}</code></p>
      <p style="margin-top:28px">${isEn ? 'Best regards' : 'Cordialement'},<br><strong>${escHtml(agentName || showroomName)}</strong></p>
    ` })
  });
}

app.get('/api/orders/export/csv', requireRole('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.id, o.created_at, o.client_name, o.client_email, o.client_company, o.client_phone, o.client_country,
             o.status, b.name as brand_name,
             ol.size, ol.quantity, ol.unit_price, ol.price_retail,
             p.reference, p.description, p.color
      FROM orders o
      JOIN brands b ON o.brand_id=b.id
      JOIN order_lines ol ON ol.order_id=o.id
      JOIN products p ON ol.product_id=p.id
      ORDER BY o.created_at DESC, o.id, p.reference
    `);
    const headers = ['Date','Référence commande','Client','Email','Société','Téléphone','Pays','Statut','Marque','Référence produit','Description','Couleur','Taille','Quantité','Prix HT','Prix PVC'];
    const rows = r.rows.map(row => [
      new Date(row.created_at).toLocaleDateString('fr-FR'),
      row.order_number || row.id.slice(0,8).toUpperCase(),
      row.client_name, row.client_email, row.client_company, row.client_phone, row.client_country,
      row.status, row.brand_name, row.reference, row.description, row.color,
      row.size, row.quantity, row.unit_price, row.price_retail
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="commandes-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('﻿' + csv); // BOM for Excel
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/orders/export-csv', requireRole('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.order_number, o.id, o.created_at, b.name as brand_name,
             o.client_name, o.client_email, o.client_company, o.client_country, o.status,
             COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total_ht
      FROM orders o
      JOIN brands b ON o.brand_id = b.id
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      GROUP BY o.id, b.name
      ORDER BY o.created_at DESC
    `);
    const headers = ['Référence','Date','Marque','Client','Email','Société','Pays','Statut','Total HT'];
    const rows = r.rows.map(row => [
      row.order_number || row.id.slice(0,8).toUpperCase(),
      new Date(row.created_at).toLocaleDateString('fr-FR'),
      row.brand_name,
      row.client_name, row.client_email, row.client_company || '', row.client_country || '',
      row.status,
      parseFloat(row.total_ht).toFixed(2)
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="commandes.csv"');
    res.send('﻿' + csv);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/buyers/export-csv', requireRole('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT name, email, company, phone, country, instagram, created_at
      FROM buyers ORDER BY created_at DESC
    `);
    const headers = ['Nom','Email','Société','Téléphone','Pays','Instagram','Inscrit le'];
    const rows = r.rows.map(row => [
      row.name, row.email, row.company || '', row.phone || '', row.country || '',
      row.instagram || '',
      new Date(row.created_at).toLocaleDateString('fr-FR')
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="acheteurs.csv"');
    res.send('﻿' + csv);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/buyers/stats', requireRole('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT b.id, b.email, b.name, b.company, b.last_seen_at,
             COUNT(DISTINCT o.id) as order_count,
             COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total_amount,
             COUNT(DISTINCT o.brand_id) as brands_count
      FROM buyers b
      LEFT JOIN orders o ON o.buyer_id = b.id
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      GROUP BY b.id
      ORDER BY total_amount DESC
    `);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.delete('/api/orders/:id', requireRole('owner','agent'), async (req, res) => {
  try {
    await pool.query('DELETE FROM order_lines WHERE order_id=$1', [req.params.id]);
    await pool.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
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

// ── Agenda global ────────────────────────────────────────────────────
app.get('/api/admin/appointments', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query(`
    SELECT a.*, b.name AS brand_name
    FROM appointments a
    JOIN brands b ON b.id = a.brand_id
    ORDER BY a.slot_date DESC, a.slot_time DESC
  `);
  res.json(r.rows);
});

app.delete('/api/admin/appointments/:id', requireRole('owner','agent'), async (req, res) => {
  await pool.query('DELETE FROM appointments WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Magic link accès direct portail ──────────────────────────────────
app.post('/api/admin/buyers/:id/send-access', requireRole('owner','agent'), async (req, res) => {
  try {
    const b = await pool.query('SELECT * FROM buyers WHERE id=$1', [req.params.id]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Acheteur introuvable' });
    const buyer = b.rows[0];
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(503).json({ error: 'Email non configuré' });
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(`CREATE TABLE IF NOT EXISTS buyer_access_tokens (
      token TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL, used BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query('INSERT INTO buyer_access_tokens (token, buyer_id, expires_at) VALUES ($1,$2,$3)', [token, buyer.id, expires]);
    const [showroomName, fromAddress] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from')]);
    const link = `${getBaseUrl(req)}/portal/access?token=${token}`;
    const resend = new Resend(resendKey);
    const isEn = buyer.lang === 'en';
    await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [buyer.email],
      subject: isEn ? `Your showroom access — ${showroomName}` : `Votre accès showroom — ${showroomName}`,
      html: emailLayout({ showroomName, content: `
        <p>${isEn ? `Hello <strong>${escHtml(buyer.name)}</strong>,` : `Bonjour <strong>${escHtml(buyer.name)}</strong>,`}</p>
        <p>${isEn ? 'Click below to access the showroom — no password needed.' : 'Cliquez ci-dessous pour accéder au showroom, sans mot de passe.'}</p>
        ${emailBtn(link, isEn ? 'ACCESS SHOWROOM →' : 'ACCÉDER AU SHOWROOM →')}
        <p style="font-size:12px;color:#888;margin-top:20px">${isEn ? 'This link expires in 24 hours.' : 'Ce lien est valable 24 heures.'}</p>
      ` })
    });
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/portal/access', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/portal');
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS buyer_access_tokens (
      token TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL, used BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    const r = await pool.query('SELECT * FROM buyer_access_tokens WHERE token=$1 AND used=false AND expires_at > NOW()', [token]);
    if (!r.rows[0]) return res.redirect('/portal?error=link_expired');
    const buyer = await pool.query('SELECT * FROM buyers WHERE id=$1', [r.rows[0].buyer_id]);
    if (!buyer.rows[0]) return res.redirect('/portal');
    await pool.query('UPDATE buyer_access_tokens SET used=true WHERE token=$1', [token]);
    req.session.buyerPortal = { id: buyer.rows[0].id, email: buyer.rows[0].email, name: buyer.rows[0].name };
    res.redirect('/portal');
  } catch(e) { res.redirect('/portal'); }
});

app.post('/api/orders/:id/resend', requireRole('owner','agent'), async (req, res) => {
  try {
    const pdf = await generateOrderPDF(req.params.id);
    await sendOrderEmails(req.params.id, pdf);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/orders/:id/pdf', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkOrderBrandScope(req, res)) return;
  try {
    const pdf = await generateOrderPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    const orderNumForFile = (await pool.query('SELECT order_number FROM orders WHERE id=$1', [req.params.id]).then(r => r.rows[0]?.order_number)) || req.params.id.slice(0,8).toUpperCase();
    res.setHeader('Content-Disposition', `attachment; filename="commande-${orderNumForFile}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ==================== PUBLIC ====================

app.get('/', (req, res) => {
  if (req.session?.buyerPortal) return res.redirect('/portal');
  res.redirect('/editions-showroom-b2b-portail');
});

app.get('/api/public/brands', async (req, res) => {
  const r = await pool.query("SELECT id, name, logo, logo_url, cover_image, thumbnail, lookbook_url FROM brands WHERE subscription_status != 'inactive' ORDER BY name");
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
    const orderNum2 = r.rows[0]?.order_number || req.params.id.slice(0,8).toUpperCase();
    const filename = `PropositionCommande-${orderNum2}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/public/cgv', async (req, res) => {
  const cgv_text = await getSetting('cgv_text');
  res.json({ cgv_text });
});

app.get('/api/public/brands/:brandId', async (req, res) => {
  const b = await pool.query('SELECT id,name,logo_url,logo,cover_image,thumbnail,cgv_text,about_text,moq_qty,moq_amount,subscription_status FROM brands WHERE id=$1', [req.params.brandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  if (b.rows[0].subscription_status === 'inactive') {
    return res.status(403).json({ error: 'subscription_inactive', message: 'Ce showroom est temporairement indisponible.' });
  }
  const p = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active != 0 ORDER BY reference', [req.params.brandId]);
  const [agentName, agentTitle, agentPhone, showroomName, currenciesRaw] = await Promise.all([
    getSetting('agent_name'), getSetting('agent_title'), getSetting('agent_phone'),
    getSetting('showroom_name'), getSetting('currencies_json'),
  ]);
  let currencies = [];
  try { currencies = JSON.parse(currenciesRaw || '[]'); } catch(e) {}
  const brand = b.rows[0];
  brand.logo = cloudinaryOpt(brand.logo);
  brand.logo_url = cloudinaryOpt(brand.logo_url);
  brand.cover_image = cloudinaryOpt(brand.cover_image);
  brand.thumbnail = cloudinaryOpt(brand.thumbnail);
  const products = p.rows.map(prod => ({ ...prod, image_url: cloudinaryOpt(prod.image_url) }));
  res.json({ brand, products, currencies, agent: { name: agentName, title: agentTitle, phone: agentPhone, showroom: showroomName } });
});

app.post('/api/public/selection-pdf', async (req, res) => {
  try {
    const { brand_id, client_name, client_email, client_company, client_country, notes, lines } = req.body;
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
    const pdf = await generateSelectionPDF({ brand, client_name, client_email, client_company, client_country, notes, lines: resolvedLines, showroomName, agentName });
    const ref = (client_name||'Selection').replace(/\s/g,'-').slice(0,20);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Selection-${ref}-${brand.name.replace(/\s/g,'-')}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
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
  const productIds = validLines.map(l => l.product_id);
  const productRows = await pool.query('SELECT * FROM products WHERE id = ANY($1)', [productIds]);
  const productMap = Object.fromEntries(productRows.rows.map(r => [r.id, r]));
  const resolvedLines = validLines.map(line => ({ ...line, product: productMap[line.product_id] })).filter(l => l.product);

  const totalQty = resolvedLines.reduce((s, l) => s + l.quantity, 0);
  const totalAmount = resolvedLines.reduce((s, l) => s + l.quantity * parseFloat(l.product.price || 0), 0);
  const moqQty = parseInt(brandCheck.rows[0].moq_qty) || 0;
  const moqAmount = parseFloat(brandCheck.rows[0].moq_amount) || 0;
  if (moqQty > 0 && totalQty < moqQty) return { error: `Minimum ${moqQty} pièces requis pour cette marque (sélection actuelle : ${totalQty}).` };
  if (moqAmount > 0 && totalAmount < moqAmount) return { error: `Montant minimum de ${moqAmount.toFixed(2)} € HT requis pour cette marque (sélection actuelle : ${totalAmount.toFixed(2)} €).` };

  const orderId = uuidv4();
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const seqRes = await dbClient.query("SELECT LPAD(nextval('order_number_seq')::TEXT, 4, '0') AS num");
    const orderNumber = 'ES-' + seqRes.rows[0].num;
    await dbClient.query(
      `INSERT INTO orders (id,brand_id,client_name,client_email,client_company,client_phone,client_country,notes,status,buyer_signature,cgv_accepted,buyer_id,order_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11,$12)`,
      [orderId, brand_id, client_name, client_email, client_company||'', client_phone||'', client_country||'', notes||'', buyer_signature||'', cgv_accepted?1:0, buyer_id||null, orderNumber]
    );
    for (const line of resolvedLines) {
      await dbClient.query(
        'INSERT INTO order_lines (id,order_id,product_id,size,quantity,unit_price,price_retail,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [uuidv4(), orderId, line.product_id, line.size||'', line.quantity, line.product.price, line.product.price_retail||0, line.note||'']
      );
    }
    await dbClient.query('COMMIT');
  } catch(e) {
    await dbClient.query('ROLLBACK');
    return { error: 'Erreur lors de la création de la commande' };
  } finally {
    dbClient.release();
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

app.post('/api/public/orders', publicLimiter, async (req, res) => {
  const { brand_id, client_name, client_email, client_company, client_phone, client_country, notes, lines, buyer_signature, cgv_accepted } = req.body;
  if (!brand_id || !client_name || !client_email || !lines?.length) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  if (typeof client_name !== 'string' || client_name.length > 200) return res.status(400).json({ error: 'Nom invalide' });
  if (typeof client_email !== 'string' || client_email.length > 200 || !client_email.includes('@')) return res.status(400).json({ error: 'Email invalide' });
  if (!Array.isArray(lines) || lines.length > 500) return res.status(400).json({ error: 'Commande invalide' });
  try {
    const result = await createOrder({ brand_id, client_name, client_email, client_company, client_phone, client_country, notes, lines, buyer_signature, cgv_accepted });
    if (result.error) return res.status(result.error === 'subscription_inactive' ? 403 : 400).json(result);
    res.json({ ok: true, order_id: result.order_id });
  } catch(e) {
    console.error('createOrder error:', e.message);
    res.status(500).json({ error: 'Erreur serveur lors de la création de la commande.' });
  }
});

// ==================== SÉLECTION AGENT (préparée en RDV, confirmée par l'acheteur) ====================

// 1) L'agent prépare une sélection pour un acheteur et lui envoie un lien
app.post('/api/brands/:brandId/agent-selection', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const { client_name, client_email, client_company, notes, items } = req.body;
    if (!client_email || !client_email.includes('@')) return res.status(400).json({ error: 'Email acheteur valide requis' });
    if (!Array.isArray(items) || !items.filter(i => i.quantity > 0).length) return res.status(400).json({ error: 'Sélectionnez au moins un article' });
    const brandId = req.params.brandId;
    const b = await pool.query('SELECT name FROM brands WHERE id=$1', [brandId]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
    const cleanItems = items.filter(i => i.quantity > 0).map(i => ({ product_id: i.product_id, size: i.size || '', quantity: parseInt(i.quantity) || 0 }));
    const token = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 jours
    const seqSel = await pool.query("SELECT LPAD(nextval('selection_number_seq')::TEXT, 4, '0') AS num");
    const selectionNumber = 'SEL-' + seqSel.rows[0].num;
    await pool.query(
      `INSERT INTO agent_selections (token, brand_id, client_name, client_email, client_company, items_json, notes, created_by, expires_at, selection_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [token, brandId, client_name||'', client_email.toLowerCase().trim(), client_company||'', JSON.stringify(cleanItems), notes||'', req.session?.staffUser?.email || 'owner', expires, selectionNumber]
    );
    const url = `${getBaseUrl(req)}/selection/${token}`;
    sendAgentSelectionEmail({ email: client_email.toLowerCase().trim(), name: client_name, brandName: b.rows[0].name, selectionNumber, url, req }).catch(e => console.error('agent-selection email:', e.message));
    res.json({ ok: true, token, url, selection_number: selectionNumber });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

async function sendAgentSelectionEmail({ email, name, brandName, selectionNumber, url, req }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('RESEND_API_KEY non configurée — email sélection agent non envoyé'); return; }
  const resend = new Resend(resendKey);
  const showroomName = await getSetting('showroom_name');
  const fromField = (await getSetting('smtp_from')) || 'showroom@editionsstandard.com';
  const numLabel = selectionNumber ? ` — Réf. ${selectionNumber}` : '';
  await resend.emails.send({
    from: `${showroomName} <${fromField}>`,
    to: [email],
    subject: `Votre sélection ${brandName}${numLabel} — à valider`,
    html: emailLayout({ showroomName, content: `
      <p>Bonjour${name ? ' <strong>' + escHtml(name) + '</strong>' : ''},</p>
      <p>Une sélection <strong>${escHtml(brandName)}</strong> a été préparée pour vous lors de notre rendez-vous.</p>
      ${selectionNumber ? `<p style="font-size:13px;color:#888">Référence : <strong>${escHtml(selectionNumber)}</strong></p>` : ''}
      <p>Cliquez ci-dessous pour la consulter, créer votre accès et la valider :</p>
      ${emailBtn(url, 'Voir et valider ma sélection →')}
      <p style="font-size:13px;color:#888;margin-top:28px">Ce lien est valable 30 jours.</p>
      <p>Cordialement,<br><strong>${showroomName}</strong></p>
    ` })
  });
}

// 2) L'acheteur ouvre le lien : page de confirmation
app.get('/selection/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'selection.html')));

// 3) Données de la sélection (publique, via token)
app.get('/api/selection/:token', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM agent_selections WHERE token=$1', [req.params.token]);
    const sel = r.rows[0];
    if (!sel) return res.status(404).json({ error: 'Sélection introuvable' });
    if (sel.used) return res.status(410).json({ error: 'Cette sélection a déjà été validée.' });
    if (new Date(sel.expires_at) < new Date()) return res.status(410).json({ error: 'Cette sélection a expiré.' });
    const b = await pool.query('SELECT id, name, logo, logo_url, cgv_text, moq_qty, moq_amount FROM brands WHERE id=$1', [sel.brand_id]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
    const items = JSON.parse(sel.items_json || '[]');
    const ids = items.map(i => i.product_id);
    const prods = await pool.query('SELECT id, reference, description, color, price, price_retail, image_url, images FROM products WHERE id = ANY($1)', [ids]);
    const pmap = Object.fromEntries(prods.rows.map(p => [p.id, p]));
    const lines = items.map(i => ({ ...i, product: pmap[i.product_id] })).filter(l => l.product);
    const existingBuyer = await pool.query('SELECT 1 FROM buyers WHERE email=$1', [sel.client_email]);
    res.json({
      brand: b.rows[0],
      client: { name: sel.client_name, email: sel.client_email, company: sel.client_company },
      notes: sel.notes,
      lines,
      account_exists: existingBuyer.rows.length > 0
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// 4) L'acheteur crée son compte (ou se connecte) et valide la commande
app.post('/api/selection/:token/confirm', emailLimiter, async (req, res) => {
  try {
    const { password, signature, cgv_accepted, lines } = req.body;
    const r = await pool.query('SELECT * FROM agent_selections WHERE token=$1', [req.params.token]);
    const sel = r.rows[0];
    if (!sel) return res.status(404).json({ error: 'Sélection introuvable' });
    if (sel.used) return res.status(410).json({ error: 'Cette sélection a déjà été validée.' });
    if (new Date(sel.expires_at) < new Date()) return res.status(410).json({ error: 'Cette sélection a expiré.' });
    if (!signature) return res.status(400).json({ error: 'Signature requise' });
    if (!cgv_accepted) return res.status(400).json({ error: 'Acceptation des CGV requise' });

    // Compte acheteur : créer (nouveau) ou authentifier (existant)
    const email = sel.client_email;
    const existing = (await pool.query('SELECT id, email, name, company, phone, country, password_hash FROM buyers WHERE email=$1', [email])).rows[0];
    let buyer;
    if (existing) {
      // Compte déjà existant : on exige le mot de passe pour confirmer l'identité
      if (!password || !await bcrypt.compare(password, existing.password_hash)) {
        return res.status(401).json({ error: 'Mot de passe incorrect. Saisissez le mot de passe de votre compte acheteur.', account_exists: true });
      }
      buyer = { id: existing.id, email: existing.email, name: existing.name, company: existing.company, phone: existing.phone, country: existing.country };
    } else {
      if (!password || password.length < 8) return res.status(400).json({ error: 'Choisissez un mot de passe (8 caractères minimum)' });
      const hash = await bcrypt.hash(password, 10);
      const id = uuidv4();
      await pool.query('INSERT INTO buyers (id, email, password_hash, name, company) VALUES ($1,$2,$3,$4,$5)',
        [id, email, hash, sel.client_name || '', sel.client_company || '']);
      buyer = { id, email, name: sel.client_name || '', company: sel.client_company || '', phone: '', country: '' };
    }

    // Lignes : on part de la sélection stockée, en appliquant d'éventuels ajustements de quantité
    const stored = JSON.parse(sel.items_json || '[]');
    const adjust = Array.isArray(lines) ? Object.fromEntries(lines.map(l => [l.product_id + '|' + (l.size||''), parseInt(l.quantity) || 0])) : null;
    const finalLines = stored.map(i => ({
      product_id: i.product_id, size: i.size || '',
      quantity: adjust ? (adjust[i.product_id + '|' + (i.size||'')] ?? i.quantity) : i.quantity
    })).filter(l => l.quantity > 0);

    const result = await createOrder({
      brand_id: sel.brand_id, client_name: buyer.name || sel.client_name, client_email: email,
      client_company: buyer.company || sel.client_company, client_phone: buyer.phone, client_country: buyer.country,
      notes: sel.notes, lines: finalLines, buyer_signature: signature, cgv_accepted: cgv_accepted ? 1 : 0, buyer_id: buyer.id
    });
    if (result.error) return res.status(result.error === 'subscription_inactive' ? 403 : 400).json(result);

    await pool.query('UPDATE agent_selections SET used=true WHERE token=$1', [req.params.token]);
    // Connecte l'acheteur
    req.session.regenerate(err => {
      if (err) return res.json({ ok: true, order_id: result.order_id });
      req.session.buyerPortal = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country };
      res.json({ ok: true, order_id: result.order_id });
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
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
  const r = await pool.query('SELECT id, email, name, company, phone, country, password_hash FROM buyers WHERE email=$1', [(email||'').toLowerCase().trim()]);
  const buyer = r.rows[0];
  if (buyer && await bcrypt.compare(password || '', buyer.password_hash)) {
    // Régénération de session — anti session fixation
    req.session.regenerate(err => {
      if (err) return res.redirect('/editions-showroom-b2b-portail?error=1');
      req.session.buyerPortal = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country };
      const next = (req.body.next || '').replace(/[^a-zA-Z0-9?=&%_\-/]/g, '');
      res.redirect(next && next.startsWith('/portal') ? next : '/portal');
    });
    return;
  }
  const failNext = req.body.next && req.body.next.startsWith('/portal')
    ? '&next=' + encodeURIComponent(req.body.next) : '';
  res.redirect('/editions-showroom-b2b-portail?error=1' + failNext);
});

app.get('/portal-logout', (req, res) => {
  req.session.destroy(() => res.redirect('/editions-showroom-b2b-portail'));
});
app.get('/portal', (req, res) => {
  if (!req.session?.buyerPortal) {
    const next = req.query.brand || req.query.add
      ? '?next=' + encodeURIComponent(req.originalUrl)
      : '';
    return res.redirect('/editions-showroom-b2b-portail' + next);
  }
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

app.post('/api/portal/change-password', requireBuyerAuth, passwordLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' });

  const r = await pool.query('SELECT id, password_hash FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
  const buyer = r.rows[0];
  if (!buyer || !await bcrypt.compare(currentPassword, buyer.password_hash)) {
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE buyers SET password_hash=$1 WHERE id=$2', [hash, buyer.id]);
  res.json({ ok: true });
});

// RGPD — Export des données personnelles (droit d'accès)
app.get('/api/portal/gdpr/export', requireBuyerAuth, async (req, res) => {
  try {
    const buyerId = req.session.buyerPortal.id;
    const [profile, orders, carts] = await Promise.all([
      pool.query('SELECT id, email, name, company, phone, country, created_at, last_seen_at, lang FROM buyers WHERE id=$1', [buyerId]),
      pool.query(`SELECT o.id, o.brand_id, o.client_name, o.client_email, o.client_company,
                         o.client_phone, o.client_country, o.status, o.notes, o.cgv_accepted, o.created_at,
                         b.name as brand_name
                  FROM orders o JOIN brands b ON o.brand_id=b.id
                  WHERE o.buyer_id=$1 ORDER BY o.created_at DESC`, [buyerId]),
      pool.query('SELECT cart_json, updated_at FROM buyer_carts WHERE buyer_id=$1', [buyerId])
    ]);
    const export_data = {
      generated_at: new Date().toISOString(),
      profile: profile.rows[0] || null,
      orders: orders.rows,
      cart: carts.rows[0] || null
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="mes-donnees-showroom.json"');
    res.json(export_data);
  } catch(e) { res.status(500).json({ error: 'Erreur lors de l\'export' }); }
});

// RGPD — Suppression du compte (droit à l'oubli)
app.delete('/api/portal/account', requireBuyerAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Mot de passe requis pour confirmer la suppression' });
    const buyerId = req.session.buyerPortal.id;
    const r = await pool.query('SELECT id, password_hash FROM buyers WHERE id=$1', [buyerId]);
    const buyer = r.rows[0];
    if (!buyer || !await bcrypt.compare(password, buyer.password_hash)) {
      return res.status(400).json({ error: 'Mot de passe incorrect' });
    }
    // Anonymise les commandes existantes (conservation légale) puis supprime le compte
    await pool.query(`UPDATE orders SET client_name='[Supprimé]', client_email='deleted@deleted', client_phone='', buyer_id=NULL WHERE buyer_id=$1`, [buyerId]);
    await pool.query('DELETE FROM buyers WHERE id=$1', [buyerId]);
    req.session.destroy(() => {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur lors de la suppression' }); }
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
  try {
    // != 'inactive' exclut les NULL en PG — on inclut explicitement les NULL
    const r = await pool.query("SELECT id, name, logo, logo_url, cover_image, thumbnail, cgv_text, moq_qty, moq_amount, lookbook_url, created_at FROM brands WHERE (subscription_status IS NULL OR subscription_status != 'inactive') ORDER BY name");
    const brands = r.rows.map(b => ({
      ...b,
      logo: cloudinaryOpt(b.logo),
      logo_url: cloudinaryOpt(b.logo_url),
      cover_image: cloudinaryOpt(b.cover_image),
      thumbnail: cloudinaryOpt(b.thumbnail)
    }));
    res.json(brands);
  } catch(e) { console.error('portal brands:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/portal/brands/:brandId/products', requireBuyerAuth, async (req, res) => {
  try {
    const b = await pool.query("SELECT id, name, logo, logo_url, cover_image, thumbnail, about_text, cgv_text, moq_qty, moq_amount, subscription_status, lookbook_url FROM brands WHERE id=$1", [req.params.brandId]);
    if (!b.rows[0] || b.rows[0].subscription_status === 'inactive') return res.status(404).json({ error: 'Marque indisponible' });
    const p = await pool.query('SELECT id, reference, description, color, sizes, price, price_retail, image_url, images, variants, collection_name, composition, category, season_id, active, created_at FROM products WHERE brand_id=$1 AND active != 0 ORDER BY collection_name, reference', [req.params.brandId]);
    const brand = b.rows[0];
    brand.logo = cloudinaryOpt(brand.logo);
    brand.logo_url = cloudinaryOpt(brand.logo_url);
    brand.cover_image = cloudinaryOpt(brand.cover_image);
    brand.thumbnail = cloudinaryOpt(brand.thumbnail);
    const products = p.rows.map(prod => ({ ...prod, image_url: cloudinaryOpt(prod.image_url) }));
    res.json({ brand, products });
  } catch(e) { console.error('portal products:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

async function checkMoq(brand_id, lines) {
  const validLines = (lines || []).filter(l => l.quantity > 0);
  const b = await pool.query('SELECT moq_qty, moq_amount FROM brands WHERE id=$1', [brand_id]);
  if (!b.rows[0]) return 'Marque introuvable';
  const moqQty = parseInt(b.rows[0].moq_qty) || 0;
  const moqAmount = parseFloat(b.rows[0].moq_amount) || 0;
  if (!moqQty && !moqAmount) return null;

  const ids = validLines.map(l => l.product_id);
  const priceRows = await pool.query('SELECT id, price FROM products WHERE id = ANY($1)', [ids]);
  const priceMap = Object.fromEntries(priceRows.rows.map(r => [r.id, r.price]));
  let totalQty = 0, totalAmount = 0;
  for (const line of validLines) {
    if (!(line.product_id in priceMap)) continue;
    totalQty += line.quantity;
    totalAmount += line.quantity * parseFloat(priceMap[line.product_id] || 0);
  }
  if (moqQty > 0 && totalQty < moqQty) return `Minimum ${moqQty} pièces requis (sélection actuelle : ${totalQty}).`;
  if (moqAmount > 0 && totalAmount < moqAmount) return `Montant minimum de ${moqAmount.toFixed(2)} € HT requis (sélection actuelle : ${totalAmount.toFixed(2)} €).`;
  return null;
}

app.post('/api/portal/checkout', requireBuyerAuth, async (req, res) => {
  const buyer = req.session.buyerPortal;
  const { lines, client_name, client_company, client_phone, client_country, buyer_signature, cgv_accepted, notes } = req.body;
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'Sélection vide' });
  if (lines.length > 500) return res.status(400).json({ error: 'Commande trop volumineuse' });
  if (!client_name || typeof client_name !== 'string' || client_name.length > 200) return res.status(400).json({ error: 'Nom requis' });
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
    SELECT o.id, o.order_number, o.brand_id, o.client_name, o.client_email, o.client_company,
           o.client_phone, o.client_country, o.status, o.notes, o.cgv_accepted, o.created_at,
           b.name as brand_name, SUM(ol.quantity * ol.unit_price) as total
    FROM orders o
    JOIN brands b ON o.brand_id = b.id
    LEFT JOIN order_lines ol ON ol.order_id = o.id
    WHERE o.buyer_id = $1
    GROUP BY o.id, o.order_number, b.name
    ORDER BY o.created_at DESC
  `, [req.session.buyerPortal.id]);
  res.json(r.rows);
});

// Sélections préparées par un agent pour cet acheteur, en attente de validation
app.get('/api/portal/pending-selections', requireBuyerAuth, async (req, res) => {
  try {
    const email = req.session.buyerPortal.email;
    const r = await pool.query(`
      SELECT a.token, a.items_json, a.created_at, a.expires_at, b.name as brand_name
      FROM agent_selections a JOIN brands b ON a.brand_id = b.id
      WHERE a.client_email = $1 AND a.used = false
      ORDER BY a.created_at DESC
    `, [email]);
    const now = new Date();
    const items = r.rows
      .filter(row => new Date(row.expires_at) > now)
      .map(row => {
        let count = 0;
        try { count = JSON.parse(row.items_json || '[]').reduce((s, i) => s + (parseInt(i.quantity) || 0), 0); } catch(e) {}
        return { token: row.token, brand_name: row.brand_name, created_at: row.created_at, piece_count: count };
      });
    res.json(items);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/portal/orders/:id/lines', requireBuyerAuth, async (req, res) => {
  const o = await pool.query('SELECT id FROM orders WHERE id=$1 AND buyer_id=$2', [req.params.id, req.session.buyerPortal.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'Non disponible' });
  const lines = await pool.query(
    'SELECT ol.product_id, ol.quantity, ol.unit_price, ol.size, p.reference, p.color as product_color FROM order_lines ol JOIN products p ON ol.product_id=p.id WHERE ol.order_id=$1 ORDER BY p.reference',
    [req.params.id]
  );
  res.json(lines.rows);
});

app.get('/api/portal/orders/:id/pdf', requireBuyerAuth, async (req, res) => {
  const o = await pool.query('SELECT id, order_number FROM orders WHERE id=$1 AND buyer_id=$2', [req.params.id, req.session.buyerPortal.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'Non disponible' });
  try {
    const pdf = await generateOrderPDF(req.params.id);
    const oNum = o.rows[0].order_number || req.params.id.slice(0,8).toUpperCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Commande-${oNum}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Email sélection ──────────────────────────────────────────────────
app.post('/api/portal/selection-email', requireBuyerAuth, async (req, res) => {
  try {
    const { to, message, items } = req.body;
    if (!to || !items?.length) return res.status(400).json({ error: 'Données manquantes' });
    const buyer = req.session.buyerPortal;
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(500).json({ error: 'Email non configuré' });

    // Reuse selection-pdf generation logic inline
    const showroomName = await getSetting('showroom_name') || 'Showroom';
    const fromAddress = await getSetting('smtp_from') || 'showroom@editionsstandard.com';
    const dateStr = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    const byBrand = {};
    items.forEach(l => { (byBrand[l.brand_id] = byBrand[l.brand_id] || { name: l.brand_name, lines: [] }).lines.push(l); });
    const grandTotal = items.reduce((s, l) => s + l.qty * parseFloat(l.price || 0), 0);

    const pdf = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const hTop = 50;
      doc.fontSize(18).fillColor('#0a0a0a').font('Helvetica-Bold').text(showroomName, 50, hTop + 2, { lineBreak: false });
      doc.fontSize(9).fillColor('#888').font('Helvetica').text('Sélection acheteur — NON CONTRACTUEL', 50, hTop + 24, { lineBreak: false });
      doc.fontSize(8).fillColor('#aaa').text(dateStr, 50, hTop + 36, { lineBreak: false });
      doc.moveTo(50, hTop + 54).lineTo(545, hTop + 54).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
      const infoY = hTop + 64;
      doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text('ACHETEUR', 50, infoY);
      doc.fontSize(11).fillColor('#0a0a0a').font('Helvetica-Bold').text(buyer.name || '', 50, infoY + 12);
      doc.fontSize(9).fillColor('#555').font('Helvetica').text(buyer.email || '', 50, infoY + 26);
      let rowY = infoY + 60;
      const col = { ref: 50, desc: 145, color: 295, size: 345, qty: 390, total: 455 };
      const colW = { ref: 90, desc: 145, color: 45, size: 40, qty: 30, total: 90 };
      Object.values(byBrand).forEach(({ name: brandName, lines }) => {
        if (rowY > 720) { doc.addPage(); rowY = 50; }
        doc.rect(50, rowY, 495, 20).fillColor('#0a0a0a').fill();
        doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold').text(brandName.toUpperCase(), 58, rowY + 5, { width: 477 });
        rowY += 26;
        doc.fontSize(7).fillColor('#aaa').font('Helvetica');
        ['RÉFÉRENCE','DÉSIGNATION','COULEUR','TAILLE','QTÉ','TOTAL HT'].forEach((h, i) => {
          const cs = [col.ref, col.desc, col.color, col.size, col.qty, col.total];
          const cw = [colW.ref, colW.desc, colW.color, colW.size, colW.qty, colW.total];
          doc.text(h, cs[i], rowY, { width: cw[i], align: i >= 4 ? 'right' : 'left' });
        });
        doc.moveTo(50, rowY + 12).lineTo(545, rowY + 12).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        rowY += 18;
        lines.forEach((l, i) => {
          if (rowY > 750) { doc.addPage(); rowY = 50; }
          const lineTotal = (l.qty * parseFloat(l.price || 0)).toFixed(2);
          if (i % 2 === 0) doc.rect(50, rowY - 2, 495, 16).fillColor('#f7f7f7').fill();
          doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(l.reference || '', col.ref, rowY, { width: colW.ref });
          doc.fillColor('#333').font('Helvetica').text((l.description||'').slice(0,55), col.desc, rowY, { width: colW.desc });
          doc.fillColor('#555').text(l.color||'—', col.color, rowY, { width: colW.color }).text(l.size||'—', col.size, rowY, { width: colW.size });
          doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(String(l.qty), col.qty, rowY, { width: colW.qty, align: 'right' });
          doc.fillColor('#333').font('Helvetica').text(`${lineTotal} €`, col.total, rowY, { width: colW.total, align: 'right' });
          if (l.note) { rowY += 16; doc.fontSize(7).fillColor('#888').text(`↳ ${l.note}`, col.desc, rowY, { width: 350 }); doc.fontSize(7); }
          rowY += 16;
        });
        const brandTotal = lines.reduce((s, l) => s + l.qty * parseFloat(l.price || 0), 0);
        rowY += 4;
        doc.fontSize(8).fillColor('#555').font('Helvetica').text(`Sous-total ${brandName}`, col.ref, rowY, { width: 320 });
        doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(`${brandTotal.toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });
        rowY += 26;
      });
      if (rowY > 700) { doc.addPage(); rowY = 50; }
      doc.rect(380, rowY, 165, 24).fillColor('#0a0a0a').fill();
      doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold').text('TOTAL HT', 390, rowY + 6, { width: 80 }).text(`${grandTotal.toFixed(2)} €`, 390, rowY + 6, { width: 145, align: 'right' });
      rowY += 36;
      doc.rect(50, rowY, 495, 36).fillColor('#fffde7').fill();
      doc.fontSize(8).fillColor('#b8860b').font('Helvetica-Bold').text('⚠ DOCUMENT NON CONTRACTUEL', 60, rowY + 6, { width: 475, align: 'center' });
      doc.fontSize(7.5).fillColor('#b8860b').font('Helvetica').text('Cette sélection ne constitue pas une commande ferme.', 60, rowY + 18, { width: 475, align: 'center' });
      doc.end();
    });

    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: `${showroomName} <${fromAddress}>`,
      to: [to],
      subject: `Sélection B2B — ${showroomName} — ${dateStr}`,
      html: `<p>Bonjour,</p>${message ? `<p>${escHtml(message).replace(/\n/g,'<br>')}</p>` : ''}<p>Veuillez trouver ci-joint la sélection de <strong>${escHtml(buyer.name)}</strong> (${escHtml(buyer.email)}).</p><p>Total HT : <strong>${grandTotal.toFixed(2)} €</strong></p><p style="color:#888;font-size:12px">Ce document est non contractuel.</p>`,
      attachments: [{ filename: `Selection-${dateStr}.pdf`, content: pdf.toString('base64'), contentType: 'application/pdf' }]
    });
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Partage sélection ────────────────────────────────────────────────
app.post('/api/portal/share', requireBuyerAuth, async (req, res) => {
  try {
    const items = req.body.items || [];
    if (!items.length) return res.status(400).json({ error: 'Sélection vide' });
    const token = crypto.randomBytes(12).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days
    await pool.query(
      'INSERT INTO selection_shares (token, buyer_id, items_json, expires_at) VALUES ($1,$2,$3,$4)',
      [token, req.session.buyerPortal.id, JSON.stringify(items), expires]
    );
    res.json({ token });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/share/:token', async (req, res) => {
  const r = await pool.query('SELECT * FROM selection_shares WHERE token=$1 AND expires_at > NOW()', [req.params.token]);
  if (!r.rows[0]) return res.status(404).send('<h2>Lien expiré ou invalide.</h2>');
  const items = JSON.parse(r.rows[0].items_json || '[]');
  const showroomName = await getSetting('showroom_name') || 'Showroom';
  const byBrand = {};
  items.forEach(l => { (byBrand[l.brand_name||'?'] = byBrand[l.brand_name||'?'] || []).push(l); });
  const grandTotal = items.reduce((s, l) => s + l.qty * parseFloat(l.price||0), 0);
  const rows = Object.entries(byBrand).map(([brand, lines]) =>
    `<h3 style="margin:24px 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #eee;padding-bottom:6px">${escHtml(brand)}</h3>` +
    lines.map(l => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:13px"><span><strong>${escHtml(l.reference)}</strong>${l.color?' · '+escHtml(l.color):''}${l.size?' · '+escHtml(l.size):''}</span><span>× ${escHtml(String(l.qty))} — ${(l.qty*parseFloat(l.price||0)).toFixed(2)} €</span></div>`).join('')
  ).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sélection — ${showroomName}</title><style>body{font-family:'Helvetica Neue',sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#111}.header{border-bottom:2px solid #111;padding-bottom:16px;margin-bottom:24px}.tag{display:inline-block;background:#fffde7;border:1px solid #d4a017;color:#8a6500;font-size:11px;padding:3px 10px;border-radius:12px;margin-bottom:16px}.total{background:#111;color:#fff;padding:14px 18px;margin-top:24px;font-weight:700;display:flex;justify-content:space-between;font-size:15px}</style></head><body><div class="header"><h1 style="font-size:22px;margin:0 0 4px">${showroomName}</h1><p style="color:#888;font-size:12px;margin:0">Sélection partagée — lecture seule</p></div><span class="tag">NON CONTRACTUEL</span>${rows}<div class="total"><span>TOTAL HT</span><span>${grandTotal.toFixed(2)} €</span></div><p style="color:#aaa;font-size:11px;margin-top:24px;text-align:center">Ce document est non contractuel. La commande doit être validée sur le portail.</p></body></html>`);
});

app.get('/api/portal/cart', requireBuyerAuth, async (req, res) => {
  const r = await pool.query('SELECT cart_json FROM buyer_carts WHERE buyer_id=$1', [req.session.buyerPortal.id]);
  res.json(r.rows[0] ? JSON.parse(r.rows[0].cart_json || '{}') : {});
});

app.post('/api/portal/cart', requireBuyerAuth, async (req, res) => {
  const cartJson = JSON.stringify(req.body.cart || {});
  if (cartJson.length > 100_000) return res.status(400).json({ error: 'Panier trop volumineux' });
  await pool.query(
    `INSERT INTO buyer_carts (buyer_id, cart_json, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (buyer_id) DO UPDATE SET cart_json=$2, updated_at=NOW()`,
    [req.session.buyerPortal.id, cartJson]
  );
  res.json({ ok: true });
});

app.post('/api/portal/stats/view/:productId', requireBuyerAuth, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO product_stats (product_id, views, cart_adds)
      VALUES ($1, 1, 0)
      ON CONFLICT (product_id) DO UPDATE SET views = product_stats.views + 1, updated_at = NOW()
    `, [req.params.productId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/portal/stats/cart/:productId', requireBuyerAuth, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO product_stats (product_id, views, cart_adds)
      VALUES ($1, 0, 1)
      ON CONFLICT (product_id) DO UPDATE SET cart_adds = product_stats.cart_adds + 1, updated_at = NOW()
    `, [req.params.productId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/admin/product-stats', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.reference, p.description, p.color, p.price, b.name as brand_name,
             COALESCE(ps.views, 0) as views,
             COALESCE(ps.cart_adds, 0) as cart_adds
      FROM products p
      JOIN brands b ON p.brand_id = b.id
      LEFT JOIN product_stats ps ON ps.product_id = p.id
      WHERE p.active != 0
      ORDER BY COALESCE(ps.views, 0) DESC
      LIMIT 100
    `);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/portal/search', requireBuyerAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const like = `%${q}%`;
    const r = await pool.query(`
      SELECT p.id, p.reference, p.description, p.color, p.price, p.price_retail, p.images, p.image_url, p.brand_id,
             b.name as brand_name
      FROM products p
      JOIN brands b ON p.brand_id = b.id
      WHERE p.active != 0
        AND b.subscription_status != 'inactive'
        AND (p.reference ILIKE $1 OR p.description ILIKE $1 OR p.color ILIKE $1)
      ORDER BY p.reference
      LIMIT 40
    `, [like]);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/portal/favorites/products', requireBuyerAuth, async (req, res) => {
  const ids = (req.body.ids || []).slice(0, 100);
  if (!ids.length) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT p.id, p.reference, p.description, p.color, p.price, p.price_retail, p.images, p.image_url, p.brand_id
       FROM products p WHERE p.id = ANY($1) AND p.active != 0`,
      [ids]
    );
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/portal/selection-pdf', requireBuyerAuth, async (req, res) => {
  try {
    const items = req.body.items || [];
    if (!items.length) return res.status(400).json({ error: 'Sélection vide' });
    const buyer = req.session.buyerPortal;
    const showroomName = await getSetting('showroom_name') || 'Showroom';
    const dateStr = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

    // Group by brand
    const byBrand = {};
    items.forEach(l => { (byBrand[l.brand_id] = byBrand[l.brand_id] || { name: l.brand_name, lines: [] }).lines.push(l); });
    const grandTotal = items.reduce((s, l) => s + l.qty * parseFloat(l.price || 0), 0);

    const pdf = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hTop = 50;
      doc.fontSize(18).fillColor('#0a0a0a').font('Helvetica-Bold').text(showroomName, 50, hTop + 2, { lineBreak: false });
      doc.fontSize(9).fillColor('#888').font('Helvetica').text('Sélection acheteur — NON CONTRACTUEL', 50, hTop + 24, { lineBreak: false });
      doc.fontSize(8).fillColor('#aaa').text(dateStr, 50, hTop + 36, { lineBreak: false });
      doc.moveTo(50, hTop + 54).lineTo(545, hTop + 54).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

      const infoY = hTop + 64;
      doc.fontSize(7.5).fillColor('#aaa').font('Helvetica').text('ACHETEUR', 50, infoY);
      doc.fontSize(11).fillColor('#0a0a0a').font('Helvetica-Bold').text(buyer.name || '', 50, infoY + 12);
      doc.fontSize(9).fillColor('#555').font('Helvetica').text(buyer.email || '', 50, infoY + 26);
      if (buyer.company) doc.text(buyer.company, 50, infoY + 38);

      let rowY = infoY + 70;
      const col = { ref: 50, desc: 145, color: 295, size: 345, qty: 390, total: 455 };
      const colW = { ref: 90, desc: 145, color: 45, size: 40, qty: 30, total: 90 };

      Object.values(byBrand).forEach(({ name: brandName, lines }) => {
        if (rowY > 720) { doc.addPage(); rowY = 50; }
        doc.rect(50, rowY, 495, 20).fillColor('#0a0a0a').fill();
        doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold').text(brandName.toUpperCase(), 58, rowY + 5, { width: 477 });
        rowY += 26;

        doc.fontSize(7).fillColor('#aaa').font('Helvetica');
        doc.text('RÉFÉRENCE', col.ref, rowY, { width: colW.ref });
        doc.text('DÉSIGNATION', col.desc, rowY, { width: colW.desc });
        doc.text('COULEUR', col.color, rowY, { width: colW.color });
        doc.text('TAILLE', col.size, rowY, { width: colW.size });
        doc.text('QTÉ', col.qty, rowY, { width: colW.qty, align: 'right' });
        doc.text('TOTAL HT', col.total, rowY, { width: colW.total, align: 'right' });
        doc.moveTo(50, rowY + 12).lineTo(545, rowY + 12).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        rowY += 18;

        lines.forEach((l, i) => {
          if (rowY > 750) { doc.addPage(); rowY = 50; }
          const lineTotal = (l.qty * parseFloat(l.price || 0)).toFixed(2);
          const descText = (l.description || '').slice(0, 55);
          if (i % 2 === 0) doc.rect(50, rowY - 2, 495, 16).fillColor('#f7f7f7').fill();
          doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(l.reference || '', col.ref, rowY, { width: colW.ref });
          doc.fillColor('#333').font('Helvetica').text(descText, col.desc, rowY, { width: colW.desc });
          doc.fillColor('#555')
            .text(l.color || '—', col.color, rowY, { width: colW.color })
            .text(l.size || '—', col.size, rowY, { width: colW.size });
          doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(String(l.qty), col.qty, rowY, { width: colW.qty, align: 'right' });
          doc.fillColor('#333').font('Helvetica').text(`${lineTotal} €`, col.total, rowY, { width: colW.total, align: 'right' });
          rowY += 16;
        });

        const brandTotal = lines.reduce((s, l) => s + l.qty * parseFloat(l.price || 0), 0);
        doc.moveTo(380, rowY + 2).lineTo(545, rowY + 2).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        rowY += 6;
        doc.fontSize(8).fillColor('#555').font('Helvetica').text(`Sous-total ${brandName}`, col.ref, rowY, { width: 320 });
        doc.fillColor('#0a0a0a').font('Helvetica-Bold').text(`${brandTotal.toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });
        rowY += 26;
      });

      if (rowY > 700) { doc.addPage(); rowY = 50; }
      doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#333').lineWidth(1).stroke();
      rowY += 10;
      doc.rect(380, rowY, 165, 24).fillColor('#0a0a0a').fill();
      doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold')
        .text('TOTAL HT', 390, rowY + 6, { width: 80 })
        .text(`${grandTotal.toFixed(2)} €`, 390, rowY + 6, { width: 145, align: 'right' });
      rowY += 36;

      doc.rect(50, rowY, 495, 36).fillColor('#fffde7').fill();
      doc.fontSize(8).fillColor('#b8860b').font('Helvetica-Bold')
        .text('⚠ DOCUMENT NON CONTRACTUEL', 60, rowY + 6, { width: 475, align: 'center' });
      doc.fontSize(7.5).fillColor('#b8860b').font('Helvetica')
        .text('Cette sélection ne constitue pas une commande ferme. Elle doit être validée et signée sur le portail.', 60, rowY + 18, { width: 475, align: 'center' });

      doc.end();
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Selection-${Date.now()}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Forgot / reset password (public endpoints — no auth required)
app.post('/api/portal/forgot-password', emailLimiter, async (req, res) => {
  const { email } = req.body || {};
  res.json({ ok: true }); // always succeed — don't reveal if email exists
  if (!email) return;
  try {
    const b = await pool.query('SELECT id, name FROM buyers WHERE email=$1', [email.toLowerCase().trim()]);
    if (!b.rows[0]) return;
    const buyer = b.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query('DELETE FROM buyer_password_resets WHERE buyer_id=$1', [buyer.id]);
    await pool.query(
      'INSERT INTO buyer_password_resets (token, buyer_id, expires_at) VALUES ($1,$2,$3)',
      [token, buyer.id, expires]
    );
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return;
    const resend = new Resend(resendKey);
    const showroomName = await getSetting('showroom_name');
    const fromAddress = await getSetting('smtp_from');
    const resetUrl = `${getBaseUrl(req)}/editions-showroom-b2b-portail?token=${token}`;
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

app.post('/api/portal/reset-password', emailLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6)
    return res.json({ error: 'Données invalides.' });
  try {
    const r = await pool.query(
      'SELECT buyer_id FROM buyer_password_resets WHERE token=$1 AND used=false AND expires_at > NOW()',
      [token]
    );
    if (!r.rows[0]) return res.json({ error: 'Lien invalide ou expiré.' });
    const hash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE buyers SET password_hash=$1 WHERE id=$2', [hash, r.rows[0].buyer_id]);
      await client.query('UPDATE buyer_password_resets SET used=true WHERE token=$1', [token]);
      await client.query('COMMIT');
    } catch(txErr) { await client.query('ROLLBACK'); throw txErr; }
    finally { client.release(); }
    res.json({ ok: true });
  } catch (e) { res.json({ error: 'Erreur serveur.' }); }
});

// Admin: manage buyer accounts (owner + agent)
app.get('/api/buyers', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT id, email, name, company, phone, country, created_at, last_seen_at FROM buyers ORDER BY created_at DESC');
  res.json(r.rows);
});

app.get('/api/buyers/presence', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query(`SELECT id, last_seen_at FROM buyers WHERE last_seen_at > NOW() - INTERVAL '90 seconds'`);
  res.json(r.rows.map(b => b.id));
});

app.post('/api/portal/ping', requireBuyerAuth, async (req, res) => {
  const { lang } = req.body;
  await pool.query('UPDATE buyers SET last_seen_at = NOW()' + (lang ? ', lang=$2' : '') + ' WHERE id = $1',
    lang ? [req.session.buyerPortal.id, lang] : [req.session.buyerPortal.id]);
  res.json({ ok: true });
});

app.put('/api/orders/:id/admin-notes', requireRole('owner','agent'), async (req, res) => {
  try {
    const { admin_notes } = req.body;
    await pool.query('UPDATE orders SET admin_notes=$1 WHERE id=$2', [admin_notes || '', req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/admin/buyers/:id/relance', requireRole('owner','agent'), async (req, res) => {
  try {
    const b = await pool.query('SELECT * FROM buyers WHERE id=$1', [req.params.id]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Acheteur introuvable' });
    const buyer = b.rows[0];
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(503).json({ error: 'Email non configuré' });
    const [showroomName, agentName, fromAddress] = await Promise.all([
      getSetting('showroom_name'), getSetting('agent_name'), getSetting('smtp_from')
    ]);
    const resend = new Resend(resendKey);
    const { message } = req.body;
    const isEn = buyer.lang === 'en';
    await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [buyer.email],
      subject: isEn ? `Your showroom access — ${showroomName}` : `Votre accès showroom — ${showroomName}`,
      html: emailLayout({ showroomName, content: `
        <p>${isEn ? `Hello <strong>${escHtml(buyer.name)}</strong>,` : `Bonjour <strong>${escHtml(buyer.name)}</strong>,`}</p>
        ${message ? `<p>${escHtml(message).replace(/\n/g,'<br>')}</p>` : `<p>${isEn
          ? 'Your showroom selections are waiting for you. Don\'t hesitate to browse the collections and place your order.'
          : 'Vos sélections showroom vous attendent. N\'hésitez pas à parcourir les collections et passer commande.'}</p>`}
        <p style="margin-top:24px">
          <a href="${getBaseUrl(req)}/portal" style="display:inline-block;background:#CCEB3C;color:#111;font-weight:700;padding:12px 28px;border-radius:4px;text-decoration:none;font-family:'Courier New',monospace;font-size:13px;letter-spacing:1px">
            ${isEn ? 'ACCESS SHOWROOM →' : 'ACCÉDER AU SHOWROOM →'}
          </a>
        </p>
        <p style="margin-top:28px">Cordialement,<br><strong>${escHtml(agentName || showroomName)}</strong></p>
      ` })
    });
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/admin/search', requireRole('owner','agent'), async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ orders: [], buyers: [] });
  const like = `%${q}%`;
  const [orders, buyers] = await Promise.all([
    pool.query(`SELECT o.id, o.client_name, o.client_email, o.client_company, o.status, b.name as brand_name,
      SUM(ol.quantity*ol.unit_price) as total, o.created_at
      FROM orders o JOIN brands b ON o.brand_id=b.id LEFT JOIN order_lines ol ON ol.order_id=o.id
      WHERE o.client_name ILIKE $1 OR o.client_email ILIKE $1 OR o.client_company ILIKE $1
      GROUP BY o.id, b.name ORDER BY o.created_at DESC LIMIT 10`, [like]),
    pool.query(`SELECT id, name, email, company FROM buyers
      WHERE name ILIKE $1 OR email ILIKE $1 OR company ILIKE $1 LIMIT 8`, [like])
  ]);
  res.json({ orders: orders.rows, buyers: buyers.rows });
});

app.get('/api/portal/brands/:brandId/slots', requireBuyerAuth, async (req, res) => {
  const days = [];
  const now = new Date();
  for (let i = 1; i <= 21; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  const times = ['10:00','11:00','12:00','14:00','15:00','16:00','17:00'];
  const booked = await pool.query('SELECT slot_date, slot_time FROM appointments WHERE brand_id=$1', [req.params.brandId]);
  const bookedSet = new Set(booked.rows.map(b => {
    const d = b.slot_date instanceof Date ? b.slot_date.toISOString().slice(0,10) : String(b.slot_date).slice(0,10);
    return `${d}_${b.slot_time}`;
  }));
  const slots = days.map(date => ({
    date,
    times: times.filter(t => !bookedSet.has(`${date}_${t}`))
  })).filter(d => d.times.length > 0);
  res.json({ slots });
});

app.post('/api/portal/appointments', requireBuyerAuth, async (req, res) => {
  const buyer = req.session.buyerPortal;
  const { brand_id, slot_date, slot_time, notes } = req.body;
  if (!brand_id || !slot_date || !slot_time) return res.status(400).json({ error: 'Données incomplètes' });
  const id = crypto.randomUUID();
  try {
    await pool.query(
      'INSERT INTO appointments (id,brand_id,client_name,client_email,client_phone,slot_date,slot_time,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, brand_id, buyer.name, buyer.email, buyer.phone||'', slot_date, slot_time, notes||'']
    );
    res.json({ ok: true, id });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ce créneau est déjà réservé' });
    console.error(e); res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post('/api/buyers', requireRole('owner','agent'), async (req, res) => {
  const { email, password, name, company, phone, country } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });
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
    console.error(err); res.status(500).json({ error: "Erreur serveur" });
  }
});

async function sendBuyerWelcomeEmail({ email, password, name, req }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('RESEND_API_KEY non configurée — email de bienvenue acheteur non envoyé'); return; }
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
  try {
    const { name, company, email, phone, country, password } = req.body;
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE buyers SET name=$1,company=$2,email=$3,phone=$4,country=$5,password_hash=$6 WHERE id=$7', [name, company, email, phone, country, hash, req.params.id]);
    } else {
      await pool.query('UPDATE buyers SET name=$1,company=$2,email=$3,phone=$4,country=$5 WHERE id=$6', [name, company, email, phone, country, req.params.id]);
    }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.delete('/api/buyers/:id', requireRole('owner','agent'), async (req, res) => {
  try {
    await pool.query('DELETE FROM buyers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ==================== BRAND INVITE LINKS ====================

app.get('/api/brands/:brandId/invite-link', requireBrandScope('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT * FROM brand_invite_links WHERE brand_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.brandId]);
  if (!r.rows[0]) return res.json({ token: null, active: 0 });
  res.json(r.rows[0]);
});

app.post('/api/brands/:brandId/invite-link', requireBrandScope('owner','agent'), async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('DELETE FROM brand_invite_links WHERE brand_id=$1', [req.params.brandId]);
  await pool.query('INSERT INTO brand_invite_links (token, brand_id, active) VALUES ($1,$2,1)', [token, req.params.brandId]);
  res.json({ token });
});

app.put('/api/brands/:brandId/invite-link/toggle', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const { active } = req.body;
    await pool.query('UPDATE brand_invite_links SET active=$1 WHERE brand_id=$2', [active ? 1 : 0, req.params.brandId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/rejoindre/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'invite.html')));
app.get('/demande-acces', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demande-acces.html')));

// ── Demandes d'accès acheteur ──────────────────────────────────────────────

app.post('/api/access-request', publicLimiter, async (req, res) => {
  const { name, company, phone, email, country, instagram, website, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Nom et email requis' });
  // Vérifier doublon (même email en pending)
  const dup = await pool.query("SELECT id FROM access_requests WHERE email=$1 AND status='pending'", [email.toLowerCase().trim()]);
  if (dup.rows.length) return res.status(409).json({ error: 'Une demande est déjà en cours pour cet email.' });
  const id = uuidv4();
  await pool.query(
    'INSERT INTO access_requests (id,name,company,phone,email,country,instagram,website,message,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW() + INTERVAL \'30 days\')',
    [id, name.trim(), (company||'').trim(), (phone||'').trim(), email.toLowerCase().trim(), (country||'').trim(), (instagram||'').trim(), (website||'').trim(), (message||'').trim()]
  );
  // Notifier l'admin
  const [showroomName, adminEmail, fromAddress] = await Promise.all([
    getSetting('showroom_name'), getSetting('showroom_email'), getSetting('smtp_from')
  ]);
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && adminEmail) {
    const resend = new Resend(resendKey);
    const from = fromAddress || 'showroom@editionsstandard.com';
    const adminUrl = `${req.protocol}://${req.get('host')}/admin`;
    await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [adminEmail],
      subject: `Nouvelle demande d'accès — ${name} (${company || email})`,
      html: emailLayout({ showroomName, content: `
        <p>Une nouvelle demande d'accès au showroom vient d'être soumise.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;width:120px">Nom</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${escHtml(name)}</strong></td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Société</td><td style="padding:8px;border-bottom:1px solid #eee">${escHtml(company||'—')}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Téléphone</td><td style="padding:8px;border-bottom:1px solid #eee">${escHtml(phone||'—')}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Email</td><td style="padding:8px;border-bottom:1px solid #eee">${escHtml(email)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Pays</td><td style="padding:8px;border-bottom:1px solid #eee">${escHtml(country||'—')}</td></tr>
          ${instagram ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Instagram</td><td style="padding:8px;border-bottom:1px solid #eee">${escHtml(instagram)}</td></tr>` : ''}
          ${website ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Website</td><td style="padding:8px;border-bottom:1px solid #eee"><a href="${escHtml(website)}" style="color:#CCEB3C">${escHtml(website)}</a></td></tr>` : ''}
          ${message ? `<tr><td style="padding:8px;color:#888;vertical-align:top">Message</td><td style="padding:8px">${escHtml(message)}</td></tr>` : ''}
        </table>
        ${emailBtn(adminUrl, 'GÉRER LES DEMANDES →')}
      ` })
    }).catch(e => console.error('access-request notify:', e.message));
  }
  res.json({ ok: true });
});

app.get('/api/access-requests', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT * FROM access_requests ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/access-requests/:id/approve', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Demande introuvable' });
  const req2 = r.rows[0];
  if (req2.status !== 'pending') return res.status(400).json({ error: 'Demande déjà traitée' });

  // Créer le compte acheteur avec mot de passe temporaire
  const tempPassword = crypto.randomBytes(4).toString('hex'); // ex: a3f9c12d
  const hash = await bcrypt.hash(tempPassword, 10);
  const buyerId = uuidv4();
  try {
    await pool.query(
      'INSERT INTO buyers (id,email,password_hash,name,company,phone,country) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [buyerId, req2.email, hash, req2.name, req2.company, req2.phone, req2.country]
    );
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Un compte existe déjà pour cet email.' });
    throw e;
  }
  await pool.query("UPDATE access_requests SET status='approved' WHERE id=$1", [req.params.id]);

  // Email de bienvenue avec les identifiants
  const [showroomName, fromAddress] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from')]);
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const resend = new Resend(resendKey);
    const from = fromAddress || 'showroom@editionsstandard.com';
    const loginUrl = `${req.protocol}://${req.get('host')}/editions-showroom-b2b-portail`;
    await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [req2.email],
      subject: `Votre accès au showroom ${showroomName} est confirmé`,
      html: emailLayout({ showroomName, content: `
        <p>Bonjour <strong>${escHtml(req2.name)}</strong>,</p>
        <p>Votre demande d'accès au showroom <strong>${escHtml(showroomName)}</strong> a été acceptée.</p>
        <p>Voici vos identifiants de connexion :</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;width:120px">Email</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${escHtml(req2.email)}</strong></td></tr>
          <tr><td style="padding:8px;color:#888">Mot de passe</td><td style="padding:8px"><strong style="font-family:monospace;font-size:16px;letter-spacing:2px">${escHtml(tempPassword)}</strong></td></tr>
        </table>
        <p style="font-size:12px;color:#888">Vous pourrez modifier votre mot de passe après votre première connexion.</p>
        ${emailBtn(loginUrl, 'ACCÉDER AU SHOWROOM →')}
      ` })
    }).catch(e => console.error('access-request approve email:', e.message));
  }
  res.json({ ok: true });
});

app.post('/api/access-requests/:id/reject', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Demande introuvable' });
  const req2 = r.rows[0];
  if (req2.status !== 'pending') return res.status(400).json({ error: 'Demande déjà traitée' });
  await pool.query("UPDATE access_requests SET status='rejected' WHERE id=$1", [req.params.id]);

  const [showroomName, fromAddress] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from')]);
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const resend = new Resend(resendKey);
    const from = fromAddress || 'showroom@editionsstandard.com';
    await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [req2.email],
      subject: `Votre demande d'accès — ${showroomName}`,
      html: emailLayout({ showroomName, content: `
        <p>Bonjour <strong>${escHtml(req2.name)}</strong>,</p>
        <p>Nous avons bien reçu votre demande d'accès au showroom <strong>${escHtml(showroomName)}</strong>.</p>
        <p>Après examen, nous ne sommes pas en mesure de donner suite à votre demande pour le moment.</p>
        <p>N'hésitez pas à nous contacter directement pour plus d'informations.</p>
      ` })
    }).catch(e => console.error('access-request reject email:', e.message));
  }
  res.json({ ok: true });
});

app.get('/api/invite/:token', async (req, res) => {
  const r = await pool.query(`
    SELECT bil.*, b.name as brand_name, b.logo as brand_logo
    FROM brand_invite_links bil
    JOIN brands b ON b.id = bil.brand_id
    WHERE bil.token=$1 AND bil.active != 0
  `, [req.params.token]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Lien invalide ou désactivé.' });
  res.json({ brand_name: r.rows[0].brand_name, brand_logo: r.rows[0].brand_logo });
});

app.post('/api/invite/:token', async (req, res) => {
  const r = await pool.query(`
    SELECT bil.brand_id, b.name as brand_name
    FROM brand_invite_links bil
    JOIN brands b ON b.id = bil.brand_id
    WHERE bil.token=$1 AND bil.active != 0
  `, [req.params.token]);
  if (!r.rows[0]) return res.status(400).json({ error: 'Lien invalide ou désactivé.' });

  const { name, company, email, password } = req.body;
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Email et mot de passe requis (6 caractères min).' });
  if (!name) return res.status(400).json({ error: 'Nom requis.' });

  const cleanEmail = email.toLowerCase().trim();
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO buyers (id, email, password_hash, name, company) VALUES ($1,$2,$3,$4,$5)',
      [id, cleanEmail, hash, name.trim(), (company||'').trim()]
    );
    req.session.buyerPortal = { id, email: cleanEmail, name: name.trim(), company: (company||'').trim(), phone: '', country: '' };
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
    const oNumPublic = (await pool.query('SELECT order_number FROM orders WHERE id=$1', [req.params.id])).rows[0]?.order_number || req.params.id.slice(0,8).toUpperCase();
    res.setHeader('Content-Disposition', `attachment; filename="Commande-${oNumPublic}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/buyer/:brandId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'buyer.html')));
app.get('/rdv/:brandId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'rdv.html')));

// ==================== PDF ====================

async function generateSelectionPDF({ brand, client_name, client_email, client_company, client_country, notes, lines, showroomName, agentName }) {
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

    // Commentaires agent
    if (notes && notes.trim()) {
      doc.rect(50, rowY, 495, 14).fillColor('#f0f0f0').fill();
      doc.fontSize(7).fillColor('#888').font('Helvetica-Bold').text('COMMENTAIRES', 58, rowY + 4);
      rowY += 18;
      doc.fontSize(9).fillColor('#333').font('Helvetica').text(notes.trim(), 58, rowY, { width: 479 });
      rowY += doc.heightOfString(notes.trim(), { width: 479 }) + 14;
    }

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

  let query = 'SELECT * FROM products WHERE brand_id=$1 AND active != 0';
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
    SELECT ol.*, p.reference, p.description as product_name, p.color, ol.note
    FROM order_lines ol JOIN products p ON ol.product_id=p.id
    WHERE ol.order_id=$1
  `, [orderId]);
  const lines = lRes.rows;

  const [showroomName, agentName, agentTitle, globalCgv] = await Promise.all([
    getSetting('showroom_name'), getSetting('agent_name'),
    getSetting('agent_title'), getSetting('cgv_text')
  ]);
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
      .text(`N° ${order.order_number || orderId.slice(0,8).toUpperCase()} — ${dateStr}`, textX, headerTop + 44, { lineBreak: false });

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
      if (line.note) {
        doc.fontSize(7.5).fillColor('#888').font('Helvetica-Oblique')
          .text(`Note : ${line.note}`, col.ref + 4, rowY, { width: 490 });
        rowY += doc.heightOfString(`Note : ${line.note}`, { width: 490 }) + 4;
      }
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
      <span style="font-family:'Courier New',Courier,monospace;font-size:16px;font-weight:700;letter-spacing:2px;color:#0a0a0a">${escHtml(brandName.toUpperCase())}</span>
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
        <span style="font-family:'Courier New',Courier,monospace;color:${accentColor};font-size:13px;font-weight:700;letter-spacing:3px">${escHtml(showroomName.toUpperCase())}</span>
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
      ${rows.map(([label, value, raw]) => `
        <p style="margin:0 0 10px;font-size:13px"><span style="color:#888;display:inline-block;min-width:120px">${escHtml(label)}</span><strong style="color:#0a0a0a">${raw ? String(value||'') : escHtml(String(value||''))}</strong></p>
      `).join('')}
    </td></tr>
  </table>`;
}

async function sendOrderEmails(orderId, pdfBuffer) {
  const resendKey = process.env.RESEND_API_KEY;
  const [showroomEmail, showroomName, agentName, fromAddress, globalCgv] = await Promise.all([
    getSetting('showroom_email'), getSetting('showroom_name'),
    getSetting('agent_name'), getSetting('smtp_from'), getSetting('cgv_text'),
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
  const filename = `PropositionCommande-${order.brand_name.replace(/\s/g,'-')}-${order.order_number || orderId.slice(0,8).toUpperCase()}.pdf`;
  const totalStr = Number(order.order_total||0).toFixed(2).replace('.',',') + ' €';
  const dateStr = new Date(order.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });
  const cgvText = order.brand_cgv || globalCgv;

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
        <p>Bonjour <strong>${escHtml(order.client_name)}</strong>,</p>
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
          ['Email', `<a href="mailto:${escHtml(order.client_email)}" style="color:#0a0a0a">${escHtml(order.client_email)}</a>`, true],
          ...(order.client_phone ? [['Téléphone', order.client_phone]] : []),
          ['Marque', order.brand_name],
          ['Date', dateStr],
          ['Total HT', `<span style="font-size:18px;color:#1a7a1a">${escHtml(totalStr)}</span>`, true],
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

app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

// Catch-all 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Gestionnaire d'erreur global Express — capture les exceptions des routes
// (placé après toutes les routes) pour renvoyer une 500 propre au lieu de planter.
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

// Filet de sécurité au niveau du process : une erreur asynchrone non capturée
// ne doit PAS faire planter tout le serveur (sinon site down jusqu'au redémarrage).
process.on('unhandledRejection', (reason) => {
  console.error('Promesse rejetée non gérée:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Exception non capturée:', err);
});

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
