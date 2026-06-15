const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { pool, init } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'showroom-durand-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
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

function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  res.redirect('/admin/login');
}

// ==================== ADMIN ROUTES ====================

app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

app.post('/admin/login', async (req, res) => {
  const adminPassword = await getSetting('admin_password');
  if (req.body.password === adminPassword) {
    req.session.admin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ==================== API ADMIN ====================

app.get('/api/settings', requireAdmin, async (req, res) => {
  const r = await pool.query("SELECT key, value FROM settings WHERE key != 'admin_password'");
  const s = {};
  r.rows.forEach(row => s[row.key] = row.value);
  res.json(s);
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  const allowed = ['showroom_name','showroom_email','smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','admin_password','agent_name','agent_title','agent_phone','cgv_text'];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
    }
  }
  res.json({ ok: true });
});

// Brands
app.get('/api/brands', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM brands ORDER BY name');
  res.json(r.rows);
});

app.post('/api/brands', requireAdmin, async (req, res) => {
  const { name, logo_url, logo, cover_image, cgv_text, moq_qty, moq_amount } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = uuidv4();
  await pool.query('INSERT INTO brands (id,name,logo_url,logo,cover_image,cgv_text,moq_qty,moq_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, name, logo_url||'', logo||'', cover_image||'', cgv_text||'', moq_qty||0, moq_amount||0]);
  res.json({ id, name });
});

app.put('/api/brands/:id', requireAdmin, async (req, res) => {
  const { name, logo_url, logo, cover_image, cgv_text, moq_qty, moq_amount } = req.body;
  await pool.query('UPDATE brands SET name=$1, logo_url=$2, logo=$3, cover_image=$4, cgv_text=$5, moq_qty=$6, moq_amount=$7 WHERE id=$8',
    [name, logo_url||'', logo||'', cover_image||'', cgv_text||'', moq_qty||0, moq_amount||0, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/brands/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM brands WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/brands/:id/qrcode', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM brands WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const url = `${getBaseUrl(req)}/commande/${req.params.id}`;
  const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  res.json({ qr, url });
});

// Products
app.get('/api/brands/:brandId/products', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM products WHERE brand_id=$1 ORDER BY reference', [req.params.brandId]);
  res.json(r.rows);
});

app.post('/api/brands/:brandId/products', requireAdmin, async (req, res) => {
  const { reference, description, color, sizes, price, price_retail, image_url, collection_name, composition, images, variants } = req.body;
  if (!reference) return res.status(400).json({ error: 'Référence requise' });
  const id = uuidv4();
  await pool.query(
    'INSERT INTO products (id,brand_id,reference,description,color,sizes,price,price_retail,image_url,collection_name,composition,images,variants) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [id, req.params.brandId, reference, description||'', color||'', sizes||'', price||0, price_retail||0, image_url||'', collection_name||'', composition||'', JSON.stringify(images||[]), JSON.stringify(variants||[])]
  );
  res.json({ id });
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  const { reference, description, color, sizes, price, price_retail, image_url, active, collection_name, composition, images, variants } = req.body;
  await pool.query(
    'UPDATE products SET reference=$1,description=$2,color=$3,sizes=$4,price=$5,price_retail=$6,image_url=$7,active=$8,collection_name=$9,composition=$10,images=$11,variants=$12 WHERE id=$13',
    [reference, description||'', color||'', sizes||'', price||0, price_retail||0, image_url||'', active!==undefined?active:1, collection_name||'', composition||'', JSON.stringify(images||[]), JSON.stringify(variants||[]), req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Orders
app.get('/api/orders', requireAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT o.*, b.name as brand_name,
      COUNT(ol.id) as line_count,
      SUM(ol.quantity * ol.unit_price) as total
    FROM orders o
    JOIN brands b ON o.brand_id = b.id
    LEFT JOIN order_lines ol ON ol.order_id = o.id
    GROUP BY o.id, b.name
    ORDER BY o.created_at DESC
  `);
  res.json(r.rows);
});

app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['confirmed','validated','cancelled'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM order_lines WHERE order_id=$1', [req.params.id]);
  await pool.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/orders/:id', requireAdmin, async (req, res) => {
  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name FROM orders o JOIN brands b ON o.brand_id=b.id WHERE o.id=$1
  `, [req.params.id]);
  if (!oRes.rows[0]) return res.status(404).json({ error: 'Introuvable' });
  const lRes = await pool.query(`
    SELECT ol.*, p.reference, p.color as product_color FROM order_lines ol JOIN products p ON ol.product_id=p.id WHERE ol.order_id=$1
  `, [req.params.id]);
  res.json({ order: oRes.rows[0], lines: lRes.rows });
});

app.post('/api/orders/:id/resend', requireAdmin, async (req, res) => {
  try {
    const pdf = await generateOrderPDF(req.params.id);
    await sendOrderEmails(req.params.id, pdf);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id/pdf', requireAdmin, async (req, res) => {
  try {
    const pdf = await generateOrderPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="commande-${req.params.id.slice(0,8)}.pdf"`);
    res.send(pdf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== PUBLIC ====================

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
  const b = await pool.query('SELECT id,name,logo_url,logo,cover_image,cgv_text,moq_qty,moq_amount FROM brands WHERE id=$1', [req.params.brandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const p = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active=1 ORDER BY reference', [req.params.brandId]);
  const agentName  = await getSetting('agent_name');
  const agentTitle = await getSetting('agent_title');
  const agentPhone = await getSetting('agent_phone');
  const showroomName = await getSetting('showroom_name');
  res.json({ brand: b.rows[0], products: p.rows, agent: { name: agentName, title: agentTitle, phone: agentPhone, showroom: showroomName } });
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

app.post('/api/public/orders', async (req, res) => {
  const { brand_id, client_name, client_email, client_company, client_phone, client_country, notes, lines, buyer_signature, cgv_accepted } = req.body;
  if (!brand_id || !client_name || !client_email || !lines?.length) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  const validLines = lines.filter(l => l.quantity > 0);
  if (!validLines.length) return res.status(400).json({ error: 'Aucune quantité saisie' });

  const orderId = uuidv4();
  await pool.query(
    `INSERT INTO orders (id,brand_id,client_name,client_email,client_company,client_phone,client_country,notes,status,buyer_signature,cgv_accepted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10)`,
    [orderId, brand_id, client_name, client_email, client_company||'', client_phone||'', client_country||'', notes||'', buyer_signature||'', cgv_accepted?1:0]
  );

  for (const line of validLines) {
    const p = await pool.query('SELECT * FROM products WHERE id=$1', [line.product_id]);
    if (!p.rows[0]) continue;
    await pool.query(
      'INSERT INTO order_lines (id,order_id,product_id,size,quantity,unit_price,price_retail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uuidv4(), orderId, line.product_id, line.size||'', line.quantity, p.rows[0].price, p.rows[0].price_retail||0]
    );
  }

  try {
    const pdf = await generateOrderPDF(orderId);
    await sendOrderEmails(orderId, pdf);
  } catch(e) { console.error('PDF/email error:', e.message, '| code:', e.code, '| errno:', e.errno, '| host:', e.host || '', '| port:', e.port || ''); }

  const totRes = await pool.query('SELECT SUM(quantity * unit_price) as total FROM order_lines WHERE order_id=$1', [orderId]);
  const orderTotal = parseFloat(totRes.rows[0]?.total || 0);
  syncAirtable(client_email, client_company, client_name, orderTotal).catch(e => console.error('Airtable sync error:', e.message));

  res.json({ ok: true, order_id: orderId });
});

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

async function sendOrderEmails(orderId, pdfBuffer) {
  const resendKey = process.env.RESEND_API_KEY;
  const [showroomEmail, showroomName, agentName, fromAddress] = await Promise.all([
    getSetting('showroom_email'), getSetting('showroom_name'),
    getSetting('agent_name'), getSetting('smtp_from')
  ]);

  if (!resendKey) { console.log('RESEND_API_KEY non configurée'); return; }

  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name, b.cgv_text as brand_cgv,
      SUM(ol.quantity * ol.unit_price) as order_total
    FROM orders o
    JOIN brands b ON o.brand_id=b.id
    LEFT JOIN order_lines ol ON ol.order_id=o.id
    WHERE o.id=$1
    GROUP BY o.id, b.name, b.cgv_text
  `, [orderId]);
  const order = oRes.rows[0];
  const filename = `PropositionCommande-${order.brand_name.replace(/\s/g,'-')}-${orderId.slice(0,8).toUpperCase()}.pdf`;
  const totalStr = Number(order.order_total||0).toFixed(2).replace('.',',') + ' €';
  const dateStr = new Date(order.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });

  const globalCgv = await getSetting('cgv_text');
  const cgvText = order.brand_cgv || globalCgv;

  const { Resend } = require('resend');
  const resend = new Resend(resendKey);
  const fromField = fromAddress || `noreply@editionsstandard.fr`;
  const fromFormatted = `${showroomName} <${fromField}>`;

  const attachment = { filename, content: pdfBuffer.toString('base64'), contentType: 'application/pdf' };

  // ── Email acheteur ──
  await resend.emails.send({
    from: fromFormatted,
    to: [order.client_email],
    subject: `Proposition de commande — ${order.brand_name} — ${showroomName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
        <div style="background:#0a0a0a;padding:24px 32px;text-align:center">
          <span style="color:#CCEB3C;font-size:22px;font-weight:700;letter-spacing:2px">${showroomName.toUpperCase()}</span>
        </div>
        <div style="padding:32px">
          <p>Bonjour <strong>${order.client_name}</strong>,</p>
          <p>Nous avons bien reçu votre proposition de commande pour la marque <strong>${order.brand_name}</strong> en date du ${dateStr}.</p>
          <p>Votre proposition de commande signée (total HT : <strong>${totalStr}</strong>) est jointe à cet email.</p>

          <div style="background:#fff8e1;border-left:4px solid #f0a500;padding:16px 20px;margin:24px 0;border-radius:2px">
            <p style="margin:0 0 8px;font-weight:700;color:#b37a00">⚠️ IMPORTANT — Commande non définitive</p>
            <p style="margin:0;font-size:14px;color:#555;line-height:1.6">
              Cette proposition ne constitue <strong>pas un engagement ferme</strong>. Elle ne sera définitive qu'après :<br>
              &bull; Acceptation formelle de la marque <strong>${order.brand_name}</strong><br>
              &bull; Signature du bon de commande par les deux parties (acheteur et agent)
            </p>
          </div>

          <p style="font-size:14px;color:#555">Nous reviendrons vers vous dès confirmation de la marque. En cas de question, n'hésitez pas à nous contacter.</p>
          <p>Cordialement,<br><strong>${agentName || showroomName}</strong><br><span style="color:#999;font-size:13px">${showroomName}</span></p>
        </div>
        ${cgvText ? `
        <div style="background:#f9f9f9;border-top:1px solid #eee;padding:24px 32px">
          <p style="margin:0 0 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#aaa">Conditions générales — ${order.brand_name}</p>
          <p style="margin:0;font-size:11px;color:#999;line-height:1.7;white-space:pre-wrap">${cgvText}</p>
        </div>` : ''}
        <div style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#aaa">
          ${showroomName} — Document généré automatiquement
        </div>
      </div>
    `,
    attachments: [attachment]
  });

  // ── Copie showroom ──
  const copyTo = showroomEmail || fromField;
  await resend.emails.send({
    from: fromFormatted,
    to: [copyTo],
    subject: `[BDC À VALIDER] ${order.client_name} — ${order.brand_name} — ${totalStr}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
        <div style="background:#0a0a0a;padding:24px 32px;text-align:center">
          <span style="color:#CCEB3C;font-size:18px;font-weight:700;letter-spacing:2px">NOUVELLE PROPOSITION DE COMMANDE</span>
        </div>
        <div style="padding:32px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 0;color:#888;width:140px">Client</td><td style="padding:8px 0;font-weight:600">${order.client_name}</td></tr>
            ${order.client_company ? `<tr><td style="padding:8px 0;color:#888">Société</td><td style="padding:8px 0">${order.client_company}</td></tr>` : ''}
            <tr><td style="padding:8px 0;color:#888">Email</td><td style="padding:8px 0"><a href="mailto:${order.client_email}">${order.client_email}</a></td></tr>
            ${order.client_phone ? `<tr><td style="padding:8px 0;color:#888">Téléphone</td><td style="padding:8px 0">${order.client_phone}</td></tr>` : ''}
            <tr><td style="padding:8px 0;color:#888">Marque</td><td style="padding:8px 0;font-weight:600">${order.brand_name}</td></tr>
            <tr><td style="padding:8px 0;color:#888">Total HT</td><td style="padding:8px 0;font-weight:700;font-size:18px;color:#1a7a1a">${totalStr}</td></tr>
            <tr><td style="padding:8px 0;color:#888">Date</td><td style="padding:8px 0">${dateStr}</td></tr>
          </table>
          <div style="background:#fff3f3;border-left:4px solid #e74c3c;padding:14px 18px;margin:20px 0;border-radius:2px;font-size:14px">
            ⏳ <strong>En attente de votre contre-signature</strong> pour validation définitive.
          </div>
          <p style="font-size:13px;color:#888">Le bon de commande signé par l'acheteur est en pièce jointe.</p>
        </div>
      </div>
    `,
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
