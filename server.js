const express = require('express');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
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
  const allowed = ['showroom_name','showroom_email','smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','admin_password'];
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
  const { name, logo_url, logo, cover_image } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = uuidv4();
  await pool.query('INSERT INTO brands (id,name,logo_url,logo,cover_image) VALUES ($1,$2,$3,$4,$5)', [id, name, logo_url||'', logo||'', cover_image||'']);
  res.json({ id, name });
});

app.put('/api/brands/:id', requireAdmin, async (req, res) => {
  const { name, logo_url, logo, cover_image } = req.body;
  await pool.query('UPDATE brands SET name=$1, logo_url=$2, logo=$3, cover_image=$4 WHERE id=$5', [name, logo_url||'', logo||'', cover_image||'', req.params.id]);
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

app.get('/api/public/brands/:brandId', async (req, res) => {
  const b = await pool.query('SELECT id,name,logo_url,logo,cover_image FROM brands WHERE id=$1', [req.params.brandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const p = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active=1 ORDER BY reference', [req.params.brandId]);
  res.json({ brand: b.rows[0], products: p.rows });
});

app.post('/api/public/orders', async (req, res) => {
  const { brand_id, client_name, client_email, client_company, client_phone, notes, lines } = req.body;
  if (!brand_id || !client_name || !client_email || !lines?.length) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  const validLines = lines.filter(l => l.quantity > 0);
  if (!validLines.length) return res.status(400).json({ error: 'Aucune quantité saisie' });

  const orderId = uuidv4();
  await pool.query(
    `INSERT INTO orders (id,brand_id,client_name,client_email,client_company,client_phone,notes,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed')`,
    [orderId, brand_id, client_name, client_email, client_company||'', client_phone||'', notes||'']
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
  } catch(e) { console.error('PDF/email error:', e.message); }

  res.json({ ok: true, order_id: orderId });
});

// ==================== PDF ====================

async function generateOrderPDF(orderId) {
  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name FROM orders o JOIN brands b ON o.brand_id=b.id WHERE o.id=$1
  `, [orderId]);
  const order = oRes.rows[0];
  if (!order) throw new Error('Commande introuvable');

  const lRes = await pool.query(`
    SELECT ol.*, p.reference, p.description, p.color
    FROM order_lines ol JOIN products p ON ol.product_id=p.id
    WHERE ol.order_id=$1
  `, [orderId]);
  const lines = lRes.rows;

  const showroomName = await getSetting('showroom_name');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const total = lines.reduce((s, l) => s + l.quantity * parseFloat(l.unit_price), 0);
    const dateStr = new Date(order.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });

    doc.fontSize(22).fillColor('#1a1a2e').text(showroomName, { align: 'center' });
    doc.fontSize(13).fillColor('#666').text('Bon de Commande', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#999').text(`N° ${orderId.slice(0,8).toUpperCase()} — ${dateStr}`, { align: 'center' });
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(0.8);

    const startY = doc.y;
    doc.fontSize(9).fillColor('#999').text('MARQUE', 50, startY);
    doc.fontSize(13).fillColor('#1a1a2e').text(order.brand_name, 50, startY + 14);
    doc.fontSize(9).fillColor('#999').text('CLIENT', 310, startY);
    doc.fontSize(12).fillColor('#1a1a2e').text(order.client_name, 310, startY + 14);
    if (order.client_company) doc.fontSize(10).fillColor('#444').text(order.client_company, 310);
    doc.fontSize(10).fillColor('#444').text(order.client_email, 310);
    if (order.client_phone) doc.text(order.client_phone, 310);

    doc.moveDown(2.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(0.8);

    const col = { ref:50, desc:145, color:265, size:325, qty:370, pw:405, pr:450, total:500 };
    doc.fontSize(8).fillColor('#888');
    doc.text('RÉFÉRENCE', col.ref, doc.y);
    ['DÉSIGNATION','COULEUR','TAILLE','QTÉ','P.U. HT','RETAIL','TOTAL HT'].forEach((h, i) => {
      const keys = ['desc','color','size','qty','pw','pr','total'];
      doc.text(h, col[keys[i]], doc.y - doc.currentLineHeight());
    });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(0.3);

    let rowY = doc.y;
    lines.forEach((line, i) => {
      const bg = i % 2 === 0 ? '#f9f9f9' : '#ffffff';
      doc.rect(50, rowY-2, 495, 20).fillColor(bg).fill();
      doc.fontSize(9).fillColor('#1a1a2e');
      doc.text(line.reference||'', col.ref, rowY, {width:90});
      doc.text(line.description||'', col.desc, rowY, {width:115});
      doc.text(line.color||'', col.color, rowY, {width:55});
      doc.text(line.size||'', col.size, rowY, {width:40});
      doc.text(String(line.quantity), col.qty, rowY, {width:30});
      doc.text(`${parseFloat(line.unit_price).toFixed(2)} €`, col.pw, rowY, {width:40});
      doc.text(line.price_retail > 0 ? `${parseFloat(line.price_retail).toFixed(2)} €` : '—', col.pr, rowY, {width:45});
      doc.text(`${(line.quantity * parseFloat(line.unit_price)).toFixed(2)} €`, col.total, rowY, {width:45});
      rowY += 20;
    });

    doc.y = rowY + 5;
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#1a1a2e').text(`TOTAL HT : ${total.toFixed(2)} €`, { align: 'right' });

    if (order.notes) {
      doc.moveDown(1);
      doc.fontSize(9).fillColor('#888').text('NOTES :');
      doc.fontSize(10).fillColor('#444').text(order.notes);
    }

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#aaa').text(`Document généré automatiquement — ${showroomName}`, { align: 'center' });
    doc.end();
  });
}

// ==================== EMAIL ====================

async function sendOrderEmails(orderId, pdfBuffer) {
  const [host, port, user, pass, from, showroomEmail, showroomName] = await Promise.all([
    getSetting('smtp_host'), getSetting('smtp_port'), getSetting('smtp_user'),
    getSetting('smtp_pass'), getSetting('smtp_from'), getSetting('showroom_email'), getSetting('showroom_name')
  ]);

  if (!host || !user || !pass) { console.log('SMTP non configuré'); return; }

  const oRes = await pool.query('SELECT o.*, b.name as brand_name FROM orders o JOIN brands b ON o.brand_id=b.id WHERE o.id=$1', [orderId]);
  const order = oRes.rows[0];
  const filename = `Commande-${order.brand_name.replace(/\s/g,'-')}-${orderId.slice(0,8).toUpperCase()}.pdf`;

  const transporter = nodemailer.createTransport({
    host, port: parseInt(port)||587,
    secure: parseInt(port) === 465,
    auth: { user, pass }
  });

  const attachment = { filename, content: pdfBuffer, contentType: 'application/pdf' };

  await transporter.sendMail({
    from: `${showroomName} <${from||user}>`,
    to: order.client_email,
    subject: `Votre bon de commande — ${order.brand_name} — ${showroomName}`,
    html: `<p>Bonjour ${order.client_name},</p><p>Merci pour votre commande <strong>${order.brand_name}</strong>.</p><p>Votre bon de commande est en pièce jointe.</p><br><p>Cordialement,<br><strong>${showroomName}</strong></p>`,
    attachments: [attachment]
  });

  if (showroomEmail) {
    await transporter.sendMail({
      from: `${showroomName} <${from||user}>`,
      to: showroomEmail,
      subject: `[BDC] ${order.client_name} — ${order.brand_name}`,
      html: `<p>Nouvelle commande.<br><strong>Client :</strong> ${order.client_name} (${order.client_email})<br><strong>Marque :</strong> ${order.brand_name}</p>`,
      attachments: [attachment]
    });
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
