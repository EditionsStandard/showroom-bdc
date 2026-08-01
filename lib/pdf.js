// Génération de PDF (sélections, linesheets, bons de commande). Extrait de
// server.js — dépend de `pool` (connexion DB directe) et de `getSetting`
// (injecté via createPdfGenerators, car défini côté server.js et utilisé
// ailleurs dans l'app).
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { pool } = require('../database');

// Typographie des PDF : IBM Plex Mono (la police du site) embarquée en WOFF
// complet (glyphes accentués + €). Fallback Helvetica si le fichier manque.
const PDF_FONT_REG = path.join(__dirname, '..', 'public', 'fonts', 'IBMPlexMono-Regular-full.woff');
const PDF_FONT_SB  = path.join(__dirname, '..', 'public', 'fonts', 'IBMPlexMono-SemiBold-full.woff');
function registerPdfFonts(doc) {
  try {
    doc.registerFont('Mono', PDF_FONT_REG);
    doc.registerFont('MonoSB', PDF_FONT_SB);
    return { reg: 'Mono', bold: 'MonoSB' };
  } catch (e) {
    console.error('[pdf-fonts]', e.message);
    return { reg: 'Helvetica', bold: 'Helvetica-Bold' };
  }
}
// Logo des PDF : PNG pré-rendu (fiable, aucune conversion SVG au runtime qui
// pourrait échouer silencieusement en production et laisser le doc sans logo).
let _pdfLogoCache;
function loadPdfLogo() {
  if (_pdfLogoCache !== undefined) return _pdfLogoCache;
  try { _pdfLogoCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo-pdf.png')); }
  catch (e) { _pdfLogoCache = null; }
  return _pdfLogoCache;
}
// Logo de la MARQUE pour l'en-tête des PDF (bon de commande / sélection).
// Renvoie un buffer PNG/JPG exploitable par PDFKit, ou null (→ on retombe sur
// le monogramme showroom). Gère data:URI et URL http(s) ; les logos Cloudinary
// sont convertis en PNG borné (compatible PDFKit, gère la transparence).
// SSRF : logo_url/image_url sont saisis librement par du staff (owner/agent/designer,
// pas seulement owner) et ces buffers sont récupérés CÔTÉ SERVEUR à chaque génération
// de PDF. Sans restriction d'hôte, un agent peut faire pointer le serveur vers une
// cible interne (ex. endpoint de métadonnées cloud) simplement en déclenchant le PDF
// de sa propre commande. Les images légitimes passent toujours par l'upload
// Cloudinary — on n'autorise QUE cet hôte (vérifié via URL.hostname, jamais une
// simple sous-chaîne, qui serait contournable par ex. via res.cloudinary.com.evil.com).
async function fetchCloudinaryImage(url, transform, timeoutMs) {
  let parsed;
  try { parsed = new URL(url); } catch(e) { return null; }
  if (parsed.hostname !== 'res.cloudinary.com') return null;
  const finalUrl = transform ? url.replace('/upload/', `/upload/${transform}/`) : url;
  const resp = await fetch(finalUrl, { signal: AbortSignal.timeout(timeoutMs || 10000) });
  return resp.ok ? Buffer.from(await resp.arrayBuffer()) : null;
}

async function loadBrandLogoBuffer(ref) {
  if (!ref || typeof ref !== 'string') return null;
  try {
    if (ref.startsWith('data:image')) {
      if (/^data:image\/svg/i.test(ref)) return null; // PDFKit ne gère pas le SVG
      return Buffer.from(ref.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }
    if (/^https?:\/\//i.test(ref)) {
      return await fetchCloudinaryImage(ref, 'w_240,h_240,c_limit,f_png', 8000);
    }
  } catch (e) { console.error('[pdf-brand-logo]', e.message); }
  return null;
}
// Rend des CGV clause par clause : chaque clause devient un paragraphe distinct,
// aéré, avec son numéro (« Article 3. », « 3. », « 3.2 »…) en gras pour la
// lisibilité. Gère les sauts de page. `ctx.get/set` pilotent le curseur rowY.
function renderClauses(doc, text, ctx) {
  const { F, LEFT, WIDTH, BOTTOM, TOP, INK, SOFT } = ctx;
  let paras;
  if (/\n/.test(text)) {
    // CGV saisies avec des retours à la ligne → un paragraphe par ligne.
    paras = text.split(/\n+/);
  } else {
    // Bloc unique → on scinde avant chaque marqueur de clause pour aérer.
    paras = text.split(/(?=(?:Article|Art\.?)\s*\d+|(?:^|\s)\d{1,2}[.)]\s)/i);
  }
  paras = paras.map(s => s.trim()).filter(Boolean);
  const FS = 8, GAP = 1.5, PARA_SPACING = 8;
  paras.forEach(para => {
    const m = para.match(/^((?:Article\s+|Art\.?\s*)?\d+(?:\.\d+)*[.)\-–]?)(\s+)([\s\S]*)$/i);
    let rowY = ctx.get();
    if (rowY + FS * 2 + 4 > BOTTOM) { doc.addPage(); rowY = TOP; ctx.set(rowY); }
    if (m && m[1].length <= 16 && m[3]) {
      doc.font(F.bold).fontSize(FS).fillColor(INK)
        .text(m[1] + ' ', LEFT, rowY, { continued: true, width: WIDTH, lineGap: GAP });
      doc.font(F.reg).fontSize(FS).fillColor(SOFT)
        .text(m[3], { width: WIDTH, align: 'justify', lineGap: GAP });
    } else {
      doc.font(F.reg).fontSize(FS).fillColor(SOFT)
        .text(para, LEFT, rowY, { width: WIDTH, align: 'justify', lineGap: GAP });
    }
    ctx.set(doc.y + PARA_SPACING);
  });
}

// Ordre d'affichage d'une taille dans une grille (tailles numériques triées
// numériquement, tailles lettres XS→XXXL dans leur ordre naturel, toute autre
// valeur en dernier) — sans quoi la requête order_lines (sans ORDER BY) rend
// les tailles dans un ordre arbitraire, illisible une fois regroupées sur une
// seule ligne (ex. "42:1 40:3 38:5 36:2" au lieu de 36→42).
const SIZE_SORT_LETTERS = ['XXS','XS','S','M','L','XL','XXL','XXXL','3XL','4XL','5XL'];
function sizeSortKey(size) {
  const s = String(size || '').trim().toUpperCase();
  if (/^[\d]+([.,]\d+)?$/.test(s)) return parseFloat(s.replace(',', '.'));
  const idx = SIZE_SORT_LETTERS.indexOf(s);
  return idx >= 0 ? 1000 + idx : 2000;
}

// generateSelectionPDF / generateLinesheetPDF / generateOrderPDF dépendent de
// getSetting (settings clé/valeur définis côté server.js) — injecté ici plutôt
// que dupliqué, pour garder une seule implémentation de la table `settings`.
function createPdfGenerators({ getSetting }) {
  async function generateSelectionPDF({ brand, client_name, client_email, client_company, client_country, notes, lines, showroomName, agentName }) {
    const logoBuf = (await loadBrandLogoBuffer(brand && (brand.logo || brand.logo_url))) || loadPdfLogo();
    const dateStr = new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });
    const total = lines.reduce((s, l) => s + l.quantity * parseFloat(l.product?.price || 0), 0);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Typo du site (IBM Plex Mono) + palette éditoriale monochrome.
      const F = registerPdfFonts(doc);
      const INK = '#0a0a0a', SOFT = '#555555', MUTE = '#9a9a9a', LINE = '#dcdcdc', ZEBRA = '#f6f6f4';
      const LEFT = 50, RIGHT = 545, BOTTOM = 792, TOP = 50, WIDTH = RIGHT - LEFT;
      let rowY = TOP;
      const hr = (y, color = LINE) => doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(color).lineWidth(0.5).stroke();
      const label = (txt, x, y, w) => doc.font(F.reg).fontSize(6.5).fillColor(MUTE).text(txt, x, y, { width: w, characterSpacing: 1.4 });
      const ensure = (h) => { if (rowY + h > BOTTOM) { doc.addPage(); rowY = TOP; return true; } return false; };

      // ── Header ──
      if (logoBuf) { try { doc.image(logoBuf, LEFT, rowY, { fit: [48, 44], align: 'left', valign: 'top' }); } catch(e) { const mono = loadPdfLogo(); if (mono) try { doc.image(mono, LEFT, rowY, { fit: [44, 44] }); } catch(_){} } }
      const tx = logoBuf ? 104 : LEFT;
      doc.font(F.bold).fontSize(16).fillColor(INK).text((showroomName || '').toUpperCase(), tx, rowY + 2, { lineBreak: false, characterSpacing: 1 });
      doc.font(F.reg).fontSize(8).fillColor(MUTE).text('PROPOSITION DE SÉLECTION — NON SIGNÉE', tx, rowY + 24, { lineBreak: false, characterSpacing: 1.4 });
      doc.font(F.reg).fontSize(8).fillColor(MUTE).text(dateStr, tx, rowY + 36, { lineBreak: false });
      rowY += 58;
      hr(rowY); rowY += 14;

      // ── Marque / Client ──
      const infoTop = rowY;
      label('MARQUE', LEFT, infoTop);
      doc.font(F.bold).fontSize(12).fillColor(INK).text(brand.name || '', LEFT, infoTop + 12);
      label('CLIENT', 300, infoTop);
      doc.font(F.bold).fontSize(11).fillColor(INK).text(client_name || '', 300, infoTop + 12);
      let cY = infoTop + 28;
      doc.font(F.reg).fontSize(8.5);
      if (client_company) { doc.fillColor(SOFT).text(client_company, 300, cY); cY += 12; }
      doc.fillColor(MUTE).text(client_email || '', 300, cY); cY += 12;
      if (client_country) { doc.fillColor(SOFT).text(client_country, 300, cY); cY += 12; }
      rowY = Math.max(infoTop + 44, cY) + 10;

      // ── Table ──
      const col  = { ref:50, name:145, color:280, size:330, qty:368, pw:400, pr:445, total:495 };
      const colW = { ref:90, name:130, color:45,  size:33,  qty:27,  pw:40,  pr:45,  total:50 };
      const headers = ['RÉFÉRENCE','DÉSIGNATION','COULEUR','TAILLE','QTÉ','P.U. HT','RETAIL','TOTAL HT'];
      const colKeys = ['ref','name','color','size','qty','pw','pr','total'];
      const drawTableHead = () => {
        hr(rowY); rowY += 6;
        doc.font(F.reg).fontSize(6.5).fillColor(MUTE);
        headers.forEach((h, i) => doc.text(h, col[colKeys[i]], rowY, { width: colW[colKeys[i]], align: i >= 4 ? 'right' : 'left', characterSpacing: 0.6 }));
        rowY += 12; hr(rowY); rowY += 6;
      };
      drawTableHead();

      lines.forEach((l, i) => {
        const p = l.product || {};
        const nameText = p.description || '';
        const colorText = l.color || p.color || '—';
        const compoText = (p.composition || '').trim();
        // La référence peut être longue et déborder sur 2-3 lignes dans sa colonne
        // étroite tout comme désignation/couleur ci-dessous — omise ici auparavant,
        // elle laissait rowH trop court et le texte de la ligne suivante chevauchait
        // visuellement la référence encore en cours d'affichage (même bug déjà vu
        // et corrigé sur generateOrderPDF — voir refH là-bas).
        const refH = doc.font(F.bold).fontSize(8.5).heightOfString(p.reference || '', { width: colW.ref });
        const nameH = doc.font(F.reg).fontSize(8.5).heightOfString(nameText, { width: colW.name });
        // Composition affichée en petit sous la désignation — même raison que sur
        // generateOrderPDF : plusieurs références peuvent partager désignation et
        // couleur identiques, seule la matière les distingue.
        const compoH = compoText ? doc.font(F.reg).fontSize(7).heightOfString(compoText, { width: colW.name }) + 2 : 0;
        // La couleur peut être plus longue que sa colonne étroite (45pt) et donc
        // se retrouver sur plusieurs lignes — la hauteur de ligne doit en tenir
        // compte, sinon la ligne suivante (et in fine le total/CGV/signature)
        // chevauche visuellement le texte de couleur encore en cours de rendu.
        const colorH = doc.font(F.reg).fontSize(8.5).heightOfString(colorText, { width: colW.color });
        let rowH = Math.max(refH, nameH + compoH, colorH, 12) + 7;
        // Note propre à cette référence (ex : demande de modification du client) —
        // laissée par l'agent en préparant/éditant la sélection, visible par
        // l'acheteur sur /selection/ ET reprise ici pour garder le PDF fidèle.
        const noteTxt = l.note ? `Note : ${l.note}` : '';
        const noteH = noteTxt ? doc.font(F.reg).fontSize(7.5).heightOfString(noteTxt, { width: WIDTH - 4 }) + 3 : 0;
        if (rowY + rowH + noteH > BOTTOM) { doc.addPage(); rowY = TOP; drawTableHead(); }
        if (i % 2 === 0) doc.rect(LEFT, rowY - 2, WIDTH, rowH + noteH).fillColor(ZEBRA).fill();
        doc.font(F.bold).fontSize(8.5).fillColor(INK).text(p.reference || '', col.ref, rowY, { width: colW.ref });
        doc.font(F.reg).fillColor('#333').text(nameText, col.name, rowY, { width: colW.name });
        // Couleur SOFT (plus foncée que MUTE) : à 6.5pt/MUTE, une composition longue
        // qui s'étale sur plusieurs lignes devenait quasi illisible (trop clair, trop
        // petit) — repéré en pratique après déploiement du premier correctif.
        if (compoText) doc.font(F.reg).fontSize(7).fillColor(SOFT).text(compoText, col.name, rowY + nameH + 2, { width: colW.name, characterSpacing: 0.2 });
        doc.fillColor(SOFT).fontSize(8.5)
          .text(colorText, col.color, rowY, { width: colW.color })
          .text(l.size || '—', col.size, rowY, { width: colW.size });
        // Quantité 0 = pas encore fixée par l'acheteur (référence proposée, pas
        // encore commandée) — plus clair qu'un "0" qui pourrait passer pour une
        // erreur de saisie.
        doc.font(F.bold).fillColor(INK).text(l.quantity > 0 ? String(l.quantity) : 'à déf.', col.qty, rowY, { width: colW.qty, align: 'right' });
        doc.font(F.reg).fillColor('#333')
          .text(`${parseFloat(p.price||0).toFixed(2)} €`, col.pw, rowY, { width: colW.pw, align: 'right' })
          .text(p.price_retail > 0 ? `${parseFloat(p.price_retail).toFixed(2)} €` : '—', col.pr, rowY, { width: colW.pr, align: 'right' });
        doc.font(F.bold).fillColor(INK).text(`${(l.quantity * parseFloat(p.price||0)).toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });
        rowY += rowH;
        if (noteTxt) { doc.font(F.reg).fontSize(7.5).fillColor(MUTE).text(noteTxt, col.ref + 4, rowY, { width: WIDTH - 4 }); rowY += noteH; }
      });

      // ── Total ──
      ensure(30);
      hr(rowY + 2); rowY += 10;
      doc.rect(380, rowY - 4, 165, 22).fillColor(INK).fill();
      doc.font(F.bold).fontSize(10).fillColor('#ffffff')
        .text('TOTAL HT', 390, rowY + 1, { width: 80, characterSpacing: 1 })
        .text(`${total.toFixed(2)} €`, 390, rowY + 1, { width: 145, align: 'right' });
      rowY += 32;

      // ── Commentaires agent ──
      if (notes && notes.trim()) {
        const nH = doc.font(F.reg).fontSize(9).heightOfString(notes.trim(), { width: WIDTH - 16 });
        ensure(28 + nH);
        label('COMMENTAIRES', LEFT, rowY); rowY += 12;
        doc.font(F.reg).fontSize(9).fillColor('#333').text(notes.trim(), LEFT, rowY, { width: WIDTH });
        rowY = doc.y + 12;
      }

      // ── Mention non contractuelle ──
      ensure(46);
      doc.rect(LEFT, rowY, WIDTH, 40).fillColor('#faf7e8').fill();
      doc.font(F.bold).fontSize(8.5).fillColor('#8a6d00')
        .text('DOCUMENT NON CONTRACTUEL — PROPOSITION DE SÉLECTION', LEFT + 10, rowY + 7, { width: WIDTH - 20, align: 'center', characterSpacing: 0.6 });
      doc.font(F.reg).fontSize(7.5).fillColor('#8a6d00')
        .text('Cette sélection ne constitue pas une commande ferme. Elle doit être signée par les deux parties pour être valide.', LEFT + 10, rowY + 21, { width: WIDTH - 20, align: 'center' });
      rowY += 52;

      doc.font(F.reg).fontSize(7).fillColor('#bbbbbb')
        .text(`Document généré automatiquement — ${showroomName}`, LEFT, rowY, { align: 'center', width: WIDTH });

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

    // Première image d'un produit (data: ou URL distante)
    const getFirstImage = (p) => {
      try { const imgs = JSON.parse(p.images || '[]'); if (imgs.length) return imgs[0]; } catch(e) {}
      return p.image_url || null;
    };
    // Pré-charge les images en Buffer AVANT la génération (synchrone) du PDF.
    // Gère le base64 ET les URL distantes (Cloudinary) — sinon images manquantes.
    // Cloudinary : on force un JPEG borné (PDFKit n'accepte que JPEG/PNG, pas webp).
    const imageBuffers = {};
    await Promise.all(prods.rows.map(async (p) => {
      let img = getFirstImage(p);
      // tolère un objet {url|src|secure_url} au lieu d'une chaîne
      if (img && typeof img === 'object') img = img.url || img.src || img.secure_url || null;
      if (!img || typeof img !== 'string') return;
      try {
        if (img.startsWith('data:image')) {
          imageBuffers[p.id] = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        } else if (/^https?:\/\//i.test(img)) {
          // PNG forcé : PDFKit n'accepte ni le webp ni le JPEG progressif (que Cloudinary
          // peut servir). w_500 borne la taille. f_png garantit la compatibilité.
          const buf = await fetchCloudinaryImage(img, 'w_500,c_limit,f_png', 10000);
          if (buf) imageBuffers[p.id] = buf;
        }
      } catch(e) { console.error('[linesheet-img] échec', p.reference || p.id, e.message); }
    }));

    let logoBuf = null;
    try {
      const svg2img = require('svg2img');
      const svgSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo.svg'), 'utf8');
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
      const F = registerPdfFonts(doc);

      const pageW = doc.page.width;   // ~842
      const contentRight = pageW - 40;
      const contentW = contentRight - 40;

      const drawHeader = () => {
        const hTop = 40;
        if (logoBuf) doc.image(logoBuf, 40, hTop, { width: 36, height: 36 });
        const tx = logoBuf ? 84 : 40;
        doc.fontSize(15).fillColor('#0a0a0a').font(F.bold).text(brand.name, tx, hTop, { lineBreak: false });
        doc.fontSize(8).fillColor('#888').font(F.reg).text(`Linesheet — ${showroomName}`, tx, hTop + 17, { lineBreak: false });
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

      const measureCardHeight = (p) => {
        const nameText = p.description || '';
        doc.fontSize(7.5).font(F.reg);
        const nameH = nameText ? doc.heightOfString(nameText, { width: textW }) : 0;
        let ty = 14 + nameH + 4;
        if (p.color) ty += 11;
        if (p.sizes) ty += 11;
        ty += 14; // price line
        return Math.max(ty, imgH) + 16;
      };

      const drawProductCard = (p, x, yy) => {
        const buf = imageBuffers[p.id];
        const textX = x + imgW + textGap;
        doc.rect(x, yy, imgW, imgH).fillColor('#f2f2f2').fill();
        if (buf) {
          try {
            doc.image(buf, x, yy, { fit: [imgW, imgH], align: 'center', valign: 'center' });
          } catch(e) { /* format non supporté → fond gris déjà dessiné */ }
        }

        let ty = yy;
        doc.fontSize(9).fillColor('#0a0a0a').font(F.bold).text(p.reference, textX, ty, { width: textW });
        ty += 14;
        const nameText = p.description || '';
        if (nameText) {
          doc.fontSize(7.5).fillColor('#555').font(F.reg).text(nameText, textX, ty, { width: textW });
          ty += doc.heightOfString(nameText, { width: textW }) + 4;
        }
        if (p.color) { doc.fontSize(7).fillColor('#888').text(p.color, textX, ty, { width: textW }); ty += 11; }
        if (p.sizes) { doc.fontSize(7).fillColor('#888').text(p.sizes, textX, ty, { width: textW }); ty += 11; }
        doc.fontSize(8).fillColor('#0a0a0a').font(F.bold).text(`${parseFloat(p.price||0).toFixed(2)} €`, textX, ty, { width: textW / 2, continued: p.price_retail > 0 });
        if (p.price_retail > 0) doc.fontSize(7.5).fillColor('#888').font(F.reg).text(`   RRP ${parseFloat(p.price_retail).toFixed(2)} €`);
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
          doc.fontSize(10).fillColor('#CCEB3C').font(F.bold).text(currentCollection.toUpperCase(), 40, colY[0], { width: contentW });
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

      doc.fontSize(7).fillColor('#ccc').font(F.reg)
        .text(`Document généré automatiquement — ${showroomName}`, 40, doc.page.height - 30, { align: 'center', width: contentW });

      doc.end();
    });
  }

  async function generateOrderPDF(orderId) {
    const oRes = await pool.query(`
      SELECT o.*, b.name as brand_name, b.cgv_text as brand_cgv, b.logo as brand_logo, b.logo_url as brand_logo_url FROM orders o JOIN brands b ON o.brand_id=b.id WHERE o.id=$1
    `, [orderId]);
    const order = oRes.rows[0];
    if (!order) throw new Error('Commande introuvable');

    const lRes = await pool.query(`
      SELECT ol.*, p.reference, p.description as product_name, p.color, p.composition, p.image_url, p.images, p.variants, ol.note
      FROM order_lines ol JOIN products p ON ol.product_id=p.id
      WHERE ol.order_id=$1
    `, [orderId]);
    const lines = lRes.rows;

    // Pré-chargement des vignettes pour le récapitulatif visuel, une par groupe
    // produit+coloris (voir "grouped" plus bas) — sinon une commande avec le même
    // produit dans 2 coloris différents affichait deux fois la même photo (celle
    // du coloris de base), quel que soit le coloris réellement commandé pour
    // chaque taille. Dédoublonné par clé produit+coloris. Échec d'une image =
    // simplement omise.
    const lineImages = {};
    const imgGroupKeys = [...new Set(lines.map(l => l.product_id + '|' + (l.variant_color || l.color || '')))];
    await Promise.all(imgGroupKeys.map(async (key) => {
      const [pid, variantColor] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      const l = lines.find(x => x.product_id === pid);
      let img = null;
      // Priorité à la photo du coloris réellement commandé (products.variants),
      // repli sur la photo par défaut de la fiche produit si ce coloris n'a pas
      // de photo propre ou si le produit n'a pas de variantes.
      if (variantColor) {
        try {
          const variants = JSON.parse(l.variants || '[]');
          const v = Array.isArray(variants) ? variants.find(x => (x.color || '').toLowerCase() === variantColor.toLowerCase()) : null;
          if (v && Array.isArray(v.images) && v.images[0]) img = v.images[0];
        } catch(e) {}
      }
      if (!img) img = l.image_url;
      if (!img && l.images) { try { const arr = JSON.parse(l.images); img = Array.isArray(arr) ? arr[0] : null; } catch(e) {} }
      if (img && typeof img === 'object') img = img.url || img.src || img.secure_url || null;
      if (!img || typeof img !== 'string') return;
      try {
        if (img.startsWith('data:image')) {
          lineImages[key] = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        } else if (/^https?:\/\//i.test(img)) {
          const buf = await fetchCloudinaryImage(img, 'w_300,h_300,c_limit,f_png', 10000);
          if (buf) lineImages[key] = buf;
        }
      } catch(e) { console.error('[order-pdf-img]', l.reference || pid, e.message); }
    }));

    const [showroomName, agentName, agentTitle, globalCgv] = await Promise.all([
      getSetting('showroom_name'), getSetting('agent_name'),
      getSetting('agent_title'), getSetting('cgv_text')
    ]);
    const cgvText      = order.brand_cgv || globalCgv;

    // Conditions de paiement/livraison négociées spécifiquement pour cet
    // acheteur × cette marque (voir /api/admin/buyers/:id/terms/:brandId) —
    // rendues seulement si elles existent, pour que la marque les voie
    // explicitement sur le document envoyé, plutôt que seulement sur l'écran
    // de commande de l'acheteur.
    let negotiatedPayment = null;
    let negotiatedDelivery = null;
    if (order.buyer_id) {
      const termsRes = await pool.query('SELECT payment_terms, delivery_terms FROM buyer_brand_terms WHERE buyer_id=$1 AND brand_id=$2', [order.buyer_id, order.brand_id]);
      negotiatedPayment = termsRes.rows[0]?.payment_terms || null;
      negotiatedDelivery = termsRes.rows[0]?.delivery_terms || null;
    }

    // Logo de la marque (si dispo) sinon monogramme showroom
    const logoBuf = (await loadBrandLogoBuffer(order.brand_logo || order.brand_logo_url)) || loadPdfLogo();

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Typo du site (IBM Plex Mono) + palette éditoriale monochrome.
      const F = registerPdfFonts(doc);
      const INK = '#0a0a0a', SOFT = '#555555', MUTE = '#9a9a9a', LINE = '#dcdcdc', ZEBRA = '#f6f6f4';
      const LEFT = 50, RIGHT = 545, BOTTOM = 792, TOP = 50, WIDTH = RIGHT - LEFT;
      let rowY = TOP;
      const hr = (y, color = LINE) => doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(color).lineWidth(0.5).stroke();
      const label = (txt, x, y, w) => doc.font(F.reg).fontSize(6.5).fillColor(MUTE).text(txt, x, y, { width: w, characterSpacing: 1.4 });
      const ensure = (h) => { if (rowY + h > BOTTOM) { doc.addPage(); rowY = TOP; return true; } return false; };

      const total   = lines.reduce((s, l) => s + l.quantity * parseFloat(l.unit_price), 0);
      const dateStr = new Date(order.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' });
      const orderNo = order.order_number || orderId.slice(0,8).toUpperCase();

      // ── Header ──
      if (logoBuf) { try { doc.image(logoBuf, LEFT, rowY, { fit: [48, 44], align: 'left', valign: 'top' }); } catch(e) { const mono = loadPdfLogo(); if (mono) try { doc.image(mono, LEFT, rowY, { fit: [44, 44] }); } catch(_){} } }
      const textX = logoBuf ? 104 : LEFT;
      doc.font(F.bold).fontSize(16).fillColor(INK)
        .text((showroomName || '').toUpperCase(), textX, rowY + 2, { lineBreak: false, characterSpacing: 1 });
      // Tant que l'agent/la marque n'a pas signé, ce document reste une
      // proposition (cf. CGU) — le distinguer clairement du bon de commande
      // définitif une fois les deux signatures réunies.
      doc.font(F.reg).fontSize(8).fillColor(MUTE)
        .text(order.agent_signature ? 'BON DE COMMANDE DÉFINITIF — SIGNÉ' : 'PROPOSITION DE COMMANDE', textX, rowY + 24, { lineBreak: false, characterSpacing: 2 });
      doc.font(F.reg).fontSize(8).fillColor(MUTE)
        .text(`N° ${orderNo}   —   ${dateStr}`, textX, rowY + 36, { lineBreak: false });
      rowY += 58;
      hr(rowY); rowY += 14;

      // ── Marque / Client ──
      const infoTop = rowY;
      label('MARQUE', LEFT, infoTop);
      doc.font(F.bold).fontSize(12).fillColor(INK).text(order.brand_name || '', LEFT, infoTop + 12);
      label('CLIENT', 300, infoTop);
      doc.font(F.bold).fontSize(11).fillColor(INK).text(order.client_name || '', 300, infoTop + 12);
      let cY = infoTop + 28;
      doc.font(F.reg).fontSize(8.5);
      if (order.client_company) { doc.fillColor(SOFT).text(order.client_company, 300, cY); cY += 12; }
      doc.fillColor(SOFT).text(order.client_email || '', 300, cY); cY += 12;
      if (order.client_phone) { doc.fillColor(MUTE).text(order.client_phone, 300, cY); cY += 12; }
      if (order.delivery_window) { doc.font(F.bold).fillColor(INK).text('Livraison : ' + order.delivery_window, 300, cY); cY += 12; }
      rowY = Math.max(infoTop + 44, cY) + 10;

      // ── Table ──
      // Colonnes TAILLE et QTÉ fusionnées en une seule colonne "grille" (voir
      // regroupement par référence ci-dessous) — élargie d'autant pour accueillir
      // plusieurs paires taille:qté sur la même ligne.
      const col  = { ref:50, name:138, color:229, grid:270, pw:399, pr:446, total:497 };
      const colW = { ref:85, name:88,  color:38,  grid:126, pw:44,  pr:48,  total:48 };
      const headers = ['RÉFÉRENCE','DÉSIGNATION','COULEUR','TAILLES / QTÉ','P.U. HT','RETAIL','TOTAL HT'];
      const colKeys = ['ref','name','color','grid','pw','pr','total'];
      const drawTableHead = () => {
        hr(rowY); rowY += 6;
        doc.font(F.reg).fontSize(6.5).fillColor(MUTE);
        headers.forEach((h, i) => doc.text(h, col[colKeys[i]], rowY, { width: colW[colKeys[i]], align: i >= 4 ? 'right' : 'left', characterSpacing: 0.6 }));
        rowY += 12; hr(rowY); rowY += 6;
      };
      drawTableHead();

      // Regroupe les lignes par produit + coloris réellement choisi (référence
      // partage le même product_id, une taille = une ligne order_lines) pour
      // afficher toutes les tailles commandées et leur quantité sur une seule
      // ligne PDF, au lieu d'une ligne par taille comme auparavant. Le regroupement
      // inclut le coloris (variant_color si l'acheteur en a choisi un dans le
      // tiroir produit, sinon la couleur de base de la fiche) pour ne jamais
      // fusionner deux coloris différents d'une même référence sur une seule ligne.
      const grouped = [];
      const byProduct = new Map();
      lines.forEach(l => {
        const lineColor = l.variant_color || l.color;
        const groupKey = l.product_id + '|' + (lineColor || '');
        let g = byProduct.get(groupKey);
        if (!g) {
          g = { reference: l.reference, product_name: l.product_name, color: lineColor, composition: l.composition, unit_price: l.unit_price, price_retail: l.price_retail, sizes: [], lineTotal: 0, notes: [] };
          byProduct.set(groupKey, g);
          grouped.push(g);
        }
        g.sizes.push({ size: l.size || '—', quantity: l.quantity });
        g.lineTotal += l.quantity * parseFloat(l.unit_price);
        if (l.note) g.notes.push(`${l.size || '—'} : ${l.note}`);
      });
      grouped.forEach(g => g.sizes.sort((a, b) => sizeSortKey(a.size) - sizeSortKey(b.size)));

      grouped.forEach((g, i) => {
        const nameText = g.product_name || '';
        const colorText = g.color || '—';
        const compoText = (g.composition || '').trim();
        const gridText = g.sizes.map(s => `${s.size} : ${s.quantity}`).join('   ');
        // La référence (code SKU) peut être longue et déborder sur 2-3 lignes dans
        // sa colonne étroite tout comme désignation/couleur/grille ci-dessous —
        // omise ici auparavant, elle laissait rowH trop court et le texte de la
        // ligne suivante chevauchait visuellement la référence encore en cours
        // d'affichage (voire cassait la pagination automatique de PDFKit).
        const refH = doc.font(F.bold).fontSize(8.5).heightOfString(g.reference || '', { width: colW.ref });
        const nameH = doc.font(F.reg).fontSize(8.5).heightOfString(nameText, { width: colW.name });
        // Composition affichée en petit sous la désignation — plusieurs références
        // partagent parfois exactement le même nom + couleur (ex. plusieurs coloris
        // "White Dot" d'un même style ne différant que par la matière) : sans elle,
        // impossible de distinguer ces lignes sur le document envoyé à la marque.
        const compoH = compoText ? doc.font(F.reg).fontSize(7).heightOfString(compoText, { width: colW.name }) + 2 : 0;
        // Voir generateSelectionPDF : la couleur peut déborder de sa colonne
        // étroite sur plusieurs lignes, il faut en tenir compte dans rowH pour
        // éviter que la ligne suivante (et le total/CGV/signature en bas de
        // document) ne chevauche visuellement le texte de couleur. La grille de
        // tailles peut elle aussi déborder sur plusieurs lignes (référence à
        // beaucoup de tailles commandées) — même précaution.
        const colorH = doc.font(F.reg).fontSize(8.5).heightOfString(colorText, { width: colW.color });
        const gridH = doc.font(F.reg).fontSize(8).heightOfString(gridText, { width: colW.grid });
        const rowH  = Math.max(refH, nameH + compoH, colorH, gridH, 12) + 7;
        const noteTxt = g.notes.length ? `Note : ${g.notes.join(' — ')}` : '';
        const noteH = noteTxt ? doc.font(F.reg).fontSize(7.5).heightOfString(noteTxt, { width: 480 }) + 3 : 0;

        // Saut de page si la ligne (+ sa note) ne tient pas → on rejoue l'en-tête.
        if (rowY + rowH + noteH > BOTTOM) { doc.addPage(); rowY = TOP; drawTableHead(); }

        if (i % 2 === 0) doc.rect(LEFT, rowY - 2, WIDTH, rowH).fillColor(ZEBRA).fill();
        doc.font(F.bold).fontSize(8.5).fillColor(INK).text(g.reference || '', col.ref, rowY, { width: colW.ref });
        doc.font(F.reg).fillColor('#333').text(nameText, col.name, rowY, { width: colW.name });
        // Couleur SOFT (plus foncée que MUTE) : à 6.5pt/MUTE, une composition longue
        // qui s'étale sur plusieurs lignes devenait quasi illisible (trop clair, trop
        // petit) — repéré en pratique après déploiement du premier correctif.
        if (compoText) doc.font(F.reg).fontSize(7).fillColor(SOFT).text(compoText, col.name, rowY + nameH + 2, { width: colW.name, characterSpacing: 0.2 });
        doc.fillColor(SOFT).fontSize(8.5).text(colorText, col.color, rowY, { width: colW.color });
        doc.font(F.bold).fontSize(8).fillColor(INK).text(gridText, col.grid, rowY, { width: colW.grid });
        doc.font(F.reg).fontSize(8.5).fillColor('#333')
          .text(`${parseFloat(g.unit_price).toFixed(2)} €`, col.pw, rowY, { width: colW.pw, align: 'right' })
          .text(g.price_retail > 0 ? `${parseFloat(g.price_retail).toFixed(2)} €` : '—', col.pr, rowY, { width: colW.pr, align: 'right' });
        doc.font(F.bold).fillColor(INK).text(`${g.lineTotal.toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });

        rowY += rowH;
        if (noteTxt) { doc.font(F.reg).fontSize(7.5).fillColor(MUTE).text(noteTxt, col.ref + 4, rowY, { width: 480 }); rowY += noteH; }
      });

      // ── Total ──
      ensure(30);
      hr(rowY + 2); rowY += 10;
      doc.rect(380, rowY - 4, 165, 22).fillColor(INK).fill();
      doc.font(F.bold).fontSize(10).fillColor('#ffffff')
        .text('TOTAL HT', 390, rowY + 1, { width: 80, align: 'left', characterSpacing: 1 })
        .text(`${total.toFixed(2)} €`, 390, rowY + 1, { width: 145, align: 'right' });
      rowY += 30;

      // ── Notes ──
      if (order.notes) {
        const nH = doc.font(F.reg).fontSize(9).heightOfString(order.notes, { width: WIDTH });
        ensure(24 + nH);
        label('NOTES', LEFT, rowY); rowY += 12;
        doc.font(F.reg).fontSize(9).fillColor('#444').text(order.notes, LEFT, rowY, { width: WIDTH });
        rowY = doc.y + 10;
      }

      // ── Conditions de paiement/livraison négociées (mises en avant, avant les CGV standard) ──
      if (negotiatedPayment) {
        const npH = doc.font(F.bold).fontSize(9).heightOfString(negotiatedPayment, { width: WIDTH - 32 });
        ensure(34 + npH);
        doc.rect(LEFT, rowY, WIDTH, npH + 26).fillColor(ZEBRA).fill();
        doc.rect(LEFT, rowY, 3, npH + 26).fillColor(INK).fill();
        doc.font(F.reg).fontSize(7).fillColor(MUTE).text('CONDITIONS DE PAIEMENT NÉGOCIÉES', LEFT + 16, rowY + 9, { characterSpacing: 1.4 });
        doc.font(F.bold).fontSize(9).fillColor(INK).text(negotiatedPayment, LEFT + 16, rowY + 21, { width: WIDTH - 32 });
        rowY += npH + 26 + 12;
      }
      if (negotiatedDelivery) {
        const ndH = doc.font(F.bold).fontSize(9).heightOfString(negotiatedDelivery, { width: WIDTH - 32 });
        ensure(34 + ndH);
        doc.rect(LEFT, rowY, WIDTH, ndH + 26).fillColor(ZEBRA).fill();
        doc.rect(LEFT, rowY, 3, ndH + 26).fillColor(INK).fill();
        doc.font(F.reg).fontSize(7).fillColor(MUTE).text('CONDITIONS DE LIVRAISON NÉGOCIÉES', LEFT + 16, rowY + 9, { characterSpacing: 1.4 });
        doc.font(F.bold).fontSize(9).fillColor(INK).text(negotiatedDelivery, LEFT + 16, rowY + 21, { width: WIDTH - 32 });
        rowY += ndH + 26 + 12;
      }

      // ── CGV (toujours incluses au bon de commande final, avec pagination auto) ──
      if (cgvText) {
        ensure(60);
        hr(rowY); rowY += 12;
        doc.font(F.bold).fontSize(8).fillColor(INK)
          .text('CONDITIONS GÉNÉRALES DE VENTE', LEFT, rowY, { align: 'center', width: WIDTH, characterSpacing: 1.5 });
        rowY += 20;
        renderClauses(doc, cgvText, { F, LEFT, WIDTH, BOTTOM, TOP, INK, SOFT, get: () => rowY, set: (v) => { rowY = v; } });
        rowY += 6;
      }

      // ── Signatures (bloc insécable : ~140 pt) ──
      ensure(150);
      hr(rowY); rowY += 14;
      const sigY = rowY;
      label("L'ACHETEUR", LEFT, sigY);
      doc.font(F.bold).fontSize(9).fillColor(INK).text(order.client_name || '', LEFT, sigY + 13);
      if (order.client_company) doc.font(F.reg).fontSize(8).fillColor(SOFT).text(order.client_company, LEFT, sigY + 25);
      doc.font(F.reg).fontSize(7.5).fillColor(MUTE)
        .text('Lu et approuvé — ' + new Date(order.created_at).toLocaleDateString('fr-FR'), LEFT, sigY + 37);
      if (order.buyer_signature && order.buyer_signature.startsWith('data:image')) {
        try {
          const sigData = order.buyer_signature.replace(/^data:image\/\w+;base64,/, '');
          doc.image(Buffer.from(sigData, 'base64'), LEFT, sigY + 48, { width: 160, height: 55 });
        } catch(e) {}
      }
      doc.moveTo(LEFT, sigY + 110).lineTo(220, sigY + 110).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc.font(F.reg).fontSize(6.5).fillColor(MUTE).text('SIGNATURE', LEFT, sigY + 114, { characterSpacing: 1 });

      label("L'AGENT / SHOWROOM", 310, sigY);
      doc.font(F.bold).fontSize(9).fillColor(INK).text(order.agent_signed_by || agentName || showroomName || '', 310, sigY + 13);
      if (agentTitle) doc.font(F.reg).fontSize(8).fillColor(SOFT).text(agentTitle, 310, sigY + 25);
      doc.font(F.reg).fontSize(7.5).fillColor(MUTE)
        .text(order.agent_signed_at ? 'Signé le ' + new Date(order.agent_signed_at).toLocaleDateString('fr-FR') : 'Date : ____________________', 310, sigY + 39);
      if (order.agent_signature && order.agent_signature.startsWith('data:image')) {
        try {
          const agentSigData = order.agent_signature.replace(/^data:image\/\w+;base64,/, '');
          doc.image(Buffer.from(agentSigData, 'base64'), 310, sigY + 48, { width: 160, height: 55 });
        } catch(e) {}
      }
      doc.moveTo(310, sigY + 110).lineTo(490, sigY + 110).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc.font(F.reg).fontSize(6.5).fillColor(MUTE).text('SIGNATURE', 310, sigY + 114, { characterSpacing: 1 });

      rowY = sigY + 130;
      doc.font(F.reg).fontSize(7).fillColor('#bbbbbb')
        .text(`Document généré automatiquement — ${showroomName}`, LEFT, rowY, { align: 'center', width: WIDTH });

      // ── Récapitulatif visuel (photos des articles commandés) ──
      // Une carte par PRODUIT (grille tailles/quantités), pas par taille — sinon
      // une commande multi-tailles répète la même photo une fois par ligne et le
      // PDF explose en pages pour une commande qui tient sur quelques références.
      // Clé composite produit+coloris (comme lineImages ci-dessus) : une carte par
      // coloris réellement commandé, pas seulement par produit — sinon deux
      // coloris d'une même référence partageaient à tort la même carte/photo.
      const visualProductIds = [];
      const visualProducts = {};
      lines.forEach(l => {
        const key = l.product_id + '|' + (l.variant_color || l.color || '');
        if (!lineImages[key]) return;
        if (!visualProducts[key]) {
          visualProducts[key] = { reference: l.reference, color: l.variant_color || l.color, composition: l.composition, sizes: [], totalQty: 0 };
          visualProductIds.push(key);
        }
        visualProducts[key].sizes.push({ size: l.size || '—', qty: l.quantity });
        visualProducts[key].totalQty += l.quantity;
      });

      if (visualProductIds.length) {
        doc.addPage();
        doc.font(F.bold).fontSize(14).fillColor(INK).text('Récapitulatif visuel', LEFT, 50);
        doc.font(F.reg).fontSize(8.5).fillColor(MUTE)
          .text(`${order.brand_name} — Commande N° ${orderNo}`, LEFT, 70);
        hr(86);
        const cardW = 156, gap = 11, imgH = 150, startX = LEFT, VBOTTOM = 800;

        // Hauteur de légende variable selon le nombre de tailles à lister —
        // calculée avant le tracé pour que chaque ligne de cartes ait la hauteur
        // de sa carte la plus haute (sinon une carte 6 tailles chevauche la suivante).
        const cards = visualProductIds.map(pid => {
          const p = visualProducts[pid];
          const sizesText = p.sizes.map(s => `${s.size} : ${s.qty}`).join('   ·   ');
          const compoText = (p.composition || '').trim();
          // La référence et la couleur sont ici aussi susceptibles de déborder sur
          // plusieurs lignes dans une carte de 156pt de large (mêmes SKU longs que
          // dans le tableau ci-dessus) — une hauteur fixe assumée à une seule ligne
          // laissait la ligne suivante de la légende chevaucher visuellement la
          // référence encore en cours d'affichage.
          doc.font(F.bold).fontSize(8.5);
          const refH = doc.heightOfString(p.reference || '', { width: cardW });
          doc.font(F.reg).fontSize(7.5);
          const colorH = p.color ? doc.heightOfString(p.color, { width: cardW }) : 0;
          // Composition en petit sous couleur/référence — même raison que sur le
          // tableau principal : désignation+couleur identiques entre produits
          // pourtant distincts, seule la matière les différencie. Couleur SOFT
          // (pas MUTE) : à 6.5pt/MUTE, une composition longue sur plusieurs lignes
          // devenait quasi illisible — repéré en pratique après le premier déploiement.
          doc.fontSize(7);
          const compoH = compoText ? doc.heightOfString(compoText, { width: cardW }) : 0;
          doc.fontSize(7.5);
          const sizesH = doc.heightOfString(sizesText, { width: cardW });
          const captionH = refH + 4 + (p.color ? colorH + 4 : 0) + (compoText ? compoH + 4 : 0) + sizesH + 3 + 12;
          return { pid, ...p, sizesText, compoText, refH, colorH, compoH, cardH: imgH + captionH };
        });

        let cx = startX, cy = 100, colIdx = 0, rowMax = 0;
        cards.forEach((card, idx) => {
          if (colIdx === 0) {
            rowMax = Math.max(card.cardH, cards[idx + 1]?.cardH || 0, cards[idx + 2]?.cardH || 0);
            if (cy + rowMax + 10 > VBOTTOM) { doc.addPage(); cy = 50; }
          }
          doc.rect(cx, cy, cardW, imgH).fillColor('#f2f2f2').fill();
          try { doc.image(lineImages[card.pid], cx, cy, { fit: [cardW, imgH], align: 'center', valign: 'center' }); } catch(e) { /* format non supporté → fond gris */ }
          let ty = cy + imgH + 5;
          doc.font(F.bold).fontSize(8.5).fillColor(INK).text(card.reference || '', cx, ty, { width: cardW });
          ty += card.refH + 4;
          if (card.color) { doc.font(F.reg).fontSize(7.5).fillColor(MUTE).text(card.color, cx, ty, { width: cardW }); ty += card.colorH + 4; }
          if (card.compoText) { doc.font(F.reg).fontSize(7).fillColor(SOFT).text(card.compoText, cx, ty, { width: cardW, characterSpacing: 0.2 }); ty += card.compoH + 4; }
          doc.font(F.reg).fontSize(7.5).fillColor('#444').text(card.sizesText, cx, ty, { width: cardW });
          ty = doc.y + 3;
          doc.font(F.bold).fontSize(8).fillColor(INK).text('Qté totale : ' + card.totalQty, cx, ty, { width: cardW });

          colIdx++;
          if (colIdx >= 3) { colIdx = 0; cx = startX; cy += rowMax + 16; }
          else { cx += cardW + gap; }
        });
      }

      doc.end();
    });
  }

  return { generateSelectionPDF, generateLinesheetPDF, generateOrderPDF };
}

module.exports = {
  registerPdfFonts,
  loadPdfLogo,
  loadBrandLogoBuffer,
  fetchCloudinaryImage,
  renderClauses,
  sizeSortKey,
  createPdfGenerators,
};
