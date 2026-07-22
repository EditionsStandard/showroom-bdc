const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const PDFDocument = require('pdfkit');
// Typographie des PDF : IBM Plex Mono (la police du site) embarquée en WOFF
// complet (glyphes accentués + €). Fallback Helvetica si le fichier manque.
const PDF_FONT_REG = path.join(__dirname, 'public', 'fonts', 'IBMPlexMono-Regular-full.woff');
const PDF_FONT_SB  = path.join(__dirname, 'public', 'fonts', 'IBMPlexMono-SemiBold-full.woff');
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
  try { _pdfLogoCache = fs.readFileSync(path.join(__dirname, 'public', 'logo-pdf.png')); }
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
const multer = require('multer');
const { Resend } = require('resend');
const sanitizeHtml = require('sanitize-html');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// ── Web Push notifications ────────────────────────────────────────────
const webpush = (() => { try { return require('web-push'); } catch(e) { return null; } })();
const XLSX = (() => { try { return require('xlsx'); } catch(e) { return null; } })();
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const { pool, init } = require('./database');

// Une variable Railway copiée-collée embarque facilement un caractère parasite
// (saut de ligne, espace, guillemets/backticks restés collés au copier-coller
// depuis un bloc de code) : silencieusement, ça casse l'encodage base64url
// strict attendu par le navigateur ("applicationServerKey is not encoded as
// base64url without padding"), un rejet qui a lieu côté client donc invisible
// dans nos logs. On nettoie ET on valide ici une fois pour toutes, pour que
// toute clé mal collée soit détectée au démarrage plutôt que de planter le
// navigateur d'un utilisateur avec une erreur cryptique.
function sanitizeVapidKey(raw) {
  if (!raw) return null;
  return raw.trim().replace(/^['"` ]+|['"` ]+$/g, '') || null;
}
function isValidVapidPublicKey(key) {
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  try { return Buffer.from(key, 'base64url').length === 65; } catch(e) { return false; }
}
const VAPID_PUBLIC_KEY_RAW = sanitizeVapidKey(process.env.VAPID_PUBLIC_KEY);
const VAPID_PRIVATE_KEY_RAW = sanitizeVapidKey(process.env.VAPID_PRIVATE_KEY);
if (VAPID_PUBLIC_KEY_RAW && !isValidVapidPublicKey(VAPID_PUBLIC_KEY_RAW)) {
  console.error(`[vapid] VAPID_PUBLIC_KEY invalide après nettoyage (attendu : base64url sans padding, 65 octets décodés — reçu ${VAPID_PUBLIC_KEY_RAW.length} caractères). Notifications push désactivées jusqu'à correction de la variable Railway.`);
}
if (VAPID_PRIVATE_KEY_RAW && !/^[A-Za-z0-9_-]+$/.test(VAPID_PRIVATE_KEY_RAW)) {
  console.error(`[vapid] VAPID_PRIVATE_KEY invalide après nettoyage (caractères hors base64url détectés). Notifications push désactivées jusqu'à correction de la variable Railway.`);
}
const VAPID_PUBLIC_KEY = isValidVapidPublicKey(VAPID_PUBLIC_KEY_RAW) ? VAPID_PUBLIC_KEY_RAW : null;
const VAPID_PRIVATE_KEY = (VAPID_PRIVATE_KEY_RAW && /^[A-Za-z0-9_-]+$/.test(VAPID_PRIVATE_KEY_RAW)) ? VAPID_PRIVATE_KEY_RAW : null;
if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.ADMIN_EMAIL || 'admin@localhost'),
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// brandId : si fourni, notifie owner + agents/designers de CETTE marque
// uniquement (ex. nouvelle commande) ; si omis, notifie uniquement les owners
// (ex. demande de lien de partage — affaire interne à l'agence, pas aux
// autres marques). Sans ce filtre, un agent abonné recevait le contenu
// (nom client + marque) de TOUTES les commandes, toutes marques confondues.
async function sendPushToAdmins(title, body, brandId) {
  if (!webpush || !VAPID_PUBLIC_KEY) return;
  try {
    const subs = await pool.query(`
      SELECT ps.id, ps.subscription_json FROM push_subscriptions ps
      LEFT JOIN admin_users au ON au.id = ps.staff_id
      WHERE ps.staff_id IS NULL OR au.role = 'owner' ${brandId ? "OR (au.role IN ('agent','designer') AND au.brand_id = $1)" : ''}
    `, brandId ? [brandId] : []);
    for (const row of subs.rows) {
      const sub = JSON.parse(row.subscription_json);
      webpush.sendNotification(sub, JSON.stringify({ title, body })).catch(e => {
        console.error('[push-error]', e.statusCode || '', e.message);
        // 404/410 : le service de push confirme que cet abonnement n'existe plus
        // (désinstallation, permission révoquée, appareil réinitialisé…) — sans
        // ce nettoyage, la ligne restait en base indéfiniment et chaque envoi
        // futur échouait silencieusement sur le même endpoint mort.
        if (e.statusCode === 404 || e.statusCode === 410) {
          pool.query('DELETE FROM push_subscriptions WHERE id=$1', [row.id]).catch(() => {});
        }
      });
    }
  } catch(e) {}
}
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
// Hash factice (jamais un vrai mot de passe) comparé même quand le compte
// n'existe pas, sur les routes de login — bcrypt.compare() domine le temps
// de réponse (~80ms) ; le sauter pour un email inconnu créait un écart de
// timing mesurable et fiable pour énumérer les comptes enregistrés.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('dummy-password-never-used-' + crypto.randomBytes(8).toString('hex'), 10);

// Verrouillage de compte après échecs répétés — complète loginLimiter (par IP)
// avec un verrou par compte, seul rempart contre un mot de passe deviné/fuité
// essayé depuis des IP variées (hors de portée d'un rate-limit par IP seul).
const LOGIN_LOCKOUT_THRESHOLD = 8;
const LOGIN_LOCKOUT_MINUTES = 15;

// table ne provient jamais d'une entrée utilisateur (toujours 'admin_users' ou
// 'buyers', codé en dur aux points d'appel) — l'interpolation ici est sûre.
async function recordLoginFailure(table, id) {
  const r = await pool.query(`UPDATE ${table} SET failed_login_count = COALESCE(failed_login_count,0) + 1 WHERE id=$1 RETURNING failed_login_count`, [id]);
  if ((r.rows[0]?.failed_login_count || 0) >= LOGIN_LOCKOUT_THRESHOLD) {
    await pool.query(`UPDATE ${table} SET locked_until = NOW() + INTERVAL '${LOGIN_LOCKOUT_MINUTES} minutes' WHERE id=$1`, [id]);
  }
}
async function clearLoginFailures(table, id) {
  await pool.query(`UPDATE ${table} SET failed_login_count = 0, locked_until = NULL WHERE id=$1`, [id]);
}
function isLocked(row) {
  return !!(row?.locked_until && new Date(row.locked_until) > new Date());
}
// Même principe pour le compte owner historique, sans ligne admin_users —
// son état (comme owner_mfa_*) vit dans la table settings en clé/valeur.
async function recordOwnerLoginFailure() {
  const count = parseInt((await getSetting('owner_failed_login_count')) || '0', 10) + 1;
  await pool.query("INSERT INTO settings (key,value) VALUES ('owner_failed_login_count',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [String(count)]);
  if (count >= LOGIN_LOCKOUT_THRESHOLD) {
    const until = new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60000).toISOString();
    await pool.query("INSERT INTO settings (key,value) VALUES ('owner_locked_until',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [until]);
  }
}
async function clearOwnerLoginFailures() {
  await pool.query("DELETE FROM settings WHERE key IN ('owner_failed_login_count','owner_locked_until')");
}
async function isOwnerLocked() {
  const until = await getSetting('owner_locked_until');
  return !!(until && new Date(until) > new Date());
}

// ── Structured logger ───────────────────────────────────────────────
const log = {
  info: (msg, data={}) => console.log(JSON.stringify({ level:'info', msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data={}) => console.warn(JSON.stringify({ level:'warn', msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data={}) => console.error(JSON.stringify({ level:'error', msg, ...data, ts: new Date().toISOString() })),
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const APP_VERSION = process.env.APP_VERSION || Date.now().toString();

const app = express();
// CSP : l'app utilise des scripts/handlers/styles inline → script-src/style-src
// gardent 'unsafe-inline' (et script-src-attr pour les onclick). Mais on verrouille
// le reste : connect-src 'self' (anti-exfiltration), object-src 'none',
// base-uri 'self', frame-ancestors 'none' (anti-clickjacking), form-action 'self'.
// Origines externes réelles : cdn.jsdelivr.net (lib QR), Google Fonts, images https
// (Cloudinary). Testé sans violation sur admin/portal/commande.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "https://res.cloudinary.com", "blob:"], // lecture vidéo Cloudinary
      connectSrc: ["'self'", "https://api.cloudinary.com"], // upload vidéo direct signé
    }
  }
}));
app.set('trust proxy', 1); // Railway runs behind a proxy — required for secure cookies
const PORT = process.env.PORT || 3000;

// ── Filet anti-requêtes-pendantes ────────────────────────────────────
// Express 4 ne transmet PAS les rejets de promesse au middleware d'erreur :
// un handler async qui throw/reject laisse la requête pendante jusqu'au
// timeout du socket. On enrobe donc automatiquement chaque handler de route
// pour rediriger toute erreur (sync ou async) vers le middleware d'erreur
// global (défini en fin de fichier). Couvre toutes les routes, présentes et
// futures, sans avoir à les enrober une par une.
['get', 'post', 'put', 'delete', 'patch', 'all'].forEach(method => {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => {
    const wrapped = handlers.map(h =>
      (typeof h === 'function' && h.length < 4)
        ? function (req, res, next) {
            try {
              const ret = h(req, res, next);
              if (ret && typeof ret.then === 'function') ret.catch(next);
              return ret;
            } catch (err) { next(err); }
          }
        : h
    );
    return original(path, ...wrapped);
  };
});

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

// P0-01/02/03 — Portail B2B PRIVÉ : aucune page (commande, admin, agent, portail,
// sélection, PDF) ne doit être indexée. On pose un noindex GLOBAL au niveau HTTP
// (couvre HTML *et* PDF, contrairement à une simple meta) + un robots.txt qui
// interdit tout le crawl. Protège prix wholesale, sélections et signatures.
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  // CSP frame-ancestors 'none' (ci-dessus) est déjà la protection anti-framing
  // primaire ; X-Frame-Options: DENY reste un filet pour les navigateurs plus
  // anciens qui ignorent frame-ancestors. Permissions-Policy : le site n'a
  // besoin d'aucune de ces API, on les coupe explicitement.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Données privées (commandes, acheteurs, staff, sécurité...) : jamais de cache
  // navigateur/proxy intermédiaire. Les routes qui servent déjà un fichier
  // (PDF) posent en plus leur propre Content-Disposition, ce header ne les gêne pas.
  if (req.path.startsWith('/api/portal') || req.path.startsWith('/api/admin') || req.path.startsWith('/api/staff') || req.path.startsWith('/api/buyers') || req.path.startsWith('/api/orders') || req.path.startsWith('/api/buyer/')) {
    res.setHeader('Cache-Control', 'no-store, private');
  }
  next();
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// CSRF — couche additionnelle en plus des cookies SameSite=Lax (déjà une
// protection réelle sur les requêtes cross-site) : sur toute requête qui
// modifie l'état (POST/PUT/PATCH/DELETE), si Origin ou Referer est présent,
// son host doit correspondre à celui du site. Un navigateur envoie toujours
// l'un des deux sur une requête cross-site ; un attaquant ne peut pas le
// falsifier depuis une page tierce. Requêtes sans Origin ni Referer (clients
// non-navigateur, webhooks déjà routés avant ce middleware) : non bloquées ici,
// SameSite=Lax reste la protection de base pour ce cas.
// Comparaison normalisée (casse, port, préfixe www.) — un déploiement
// derrière un proxy/CDN peut légitimement présenter des variantes du même
// hôte (ex. www.showroom... vs showroom..., ou un port explicite) que le
// navigateur reflète fidèlement dans Origin/Referer sans qu'il s'agisse
// d'une requête cross-site. Incident du 2026-07 : cette vérification a
// bloqué 100% des connexions (buyer et admin) en production suite à une
// telle variante — d'où la normalisation, et un fail-open journalisé en
// dernier recours plutôt qu'un blocage total si un cas non prévu survient
// (SameSite=Lax reste la protection réelle dans tous les cas).
function normalizeHost(h) {
  return String(h || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
}
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const selfHost = req.headers['x-forwarded-host'] || req.headers.host;
  const originHeader = req.headers.origin || req.headers.referer;
  // Safari envoie parfois littéralement l'en-tête Origin: null (redirection,
  // navigation privée, certains contextes WebKit) — ce n'est PAS un indicateur
  // de requête cross-site, juste une particularité du navigateur. La chaîne
  // "null" est vraie en JS (!"null" === false), donc sans ce cas explicite
  // elle finissait dans new URL("null") qui échoue et bloquait la connexion.
  // Cause racine de l'incident du 2026-07 (buyer + admin bloqués).
  if (!originHeader || originHeader === 'null') return next();
  let originHost;
  try { originHost = new URL(originHeader).host; } catch(e) {
    console.error('[CSRF] Origin/Referer non parsable:', originHeader, '| path:', req.path);
    return next(); // fail-open journalisé, cf. commentaire ci-dessus sur SameSite=Lax
  }
  if (normalizeHost(originHost) !== normalizeHost(selfHost)) {
    console.error('[CSRF] host mismatch — selfHost:', selfHost, '| originHost:', originHost, '| path:', req.path, '| ua:', req.headers['user-agent']);
    // Blocage réel uniquement ici, sur un mismatch non ambigu (un Origin/Referer
    // valide et parsable, pointant vers un autre host) — les cas ambigus qui ont
    // causé l'incident du 2026-07 (Origin absent, "null", ou non parsable)
    // restent fail-open ci-dessus, inchangés.
    return res.status(403).json({ error: 'cross_origin_forbidden', message: 'Requête refusée (origine différente).' });
  }
  next();
});

app.get('/index.html', (req, res) => res.redirect('/'));
// Favicon → réutilise le logo (évite le 404 /favicon.ico sur chaque page)
app.get('/favicon.ico', (req, res) => res.redirect(301, '/logo.svg'));
app.get('/sw.js', (req, res) => {
  const swPath = path.join(__dirname, 'public', 'sw.js');
  let swContent = fs.readFileSync(swPath, 'utf8');
  swContent = swContent.replace("'es-showroom-v1'", `'es-showroom-${APP_VERSION}'`);
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(swContent);
});

// Sert une page HTML applicative avec revalidation systématique (no-cache).
// Empêche qu'un ancien shell HTML mis en cache (navigateur ou PWA installée sur
// l'écran d'accueil) ne masque une nouvelle version déployée du site.
function sendPage(res, filename, cacheControl) {
  res.setHeader('Cache-Control', cacheControl || 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', filename));
}
app.use(express.static(path.join(__dirname, 'public'), {
  // index:false — sinon express.static sert automatiquement public/index.html
  // pour GET / et court-circuite silencieusement le handler explicite plus
  // bas (redirection vers le portail acheteur) : public/index.html est une
  // ancienne page vitrine avec des liens /commande/:brandId non tokenisés.
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  setHeaders: (res, filePath) => {
    // Les pages HTML doivent toujours être revalidées : un ancien shell mis en
    // cache (navigateur ou PWA installée) ne doit jamais masquer une nouvelle
    // version déployée. Les autres assets (css/js/img) gardent le cache long.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    // Helmet pose Cross-Origin-Resource-Policy: same-origin par défaut sur TOUTE
    // réponse (y compris ces fichiers statiques) — un navigateur/WebView qui
    // charge une de ces images depuis un autre contexte d'origine (le logo dans
    // un email ouvert par le client mail, un partage de lien…) la bloque alors
    // silencieusement (constaté : logo d'en-tête invisible dans les emails,
    // cadre vide à la place). Ces images sont déjà publiques (aucune auth sur
    // express.static) et prévues pour être intégrées ailleurs que le site —
    // on assouplit donc explicitement la policy pour elles uniquement, le
    // reste du site (pages HTML, API) garde la protection stricte par défaut.
    if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(filePath)) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));
// Secret de session : jamais de valeur connue en production. Si SESSION_SECRET
// n'est pas défini en prod, on génère un secret aléatoire au démarrage (au lieu
// d'un secret codé en dur, qui permettrait de forger des cookies de session et
// de contourner l'authentification). Conséquence : définir SESSION_SECRET, sinon
// les sessions sont invalidées à chaque redémarrage.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.error('⚠️  SESSION_SECRET non défini en production — secret aléatoire généré (sessions invalidées à chaque redémarrage). DÉFINISSEZ SESSION_SECRET.');
    return crypto.randomBytes(48).toString('hex');
  }
  console.warn('⚠️  SESSION_SECRET non défini — fallback de développement utilisé (ne pas utiliser en production).');
  return 'showroom-dev-fallback-not-for-production';
}
app.use(session({
  store: process.env.DATABASE_URL ? new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }) : undefined,
  secret: resolveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  name: 'sid',
  cookie: {
    // Borne haute côté cookie/store — l'expiration réelle, plus courte et
    // différenciée admin/acheteur, est appliquée au niveau applicatif via
    // isSessionFresh() (voir plus bas) : le cookie doit juste survivre au
    // moins aussi longtemps que la politique la plus permissive (acheteur).
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// ── Politique d'expiration de session (OWASP Session Management / NIST 800-63B AAL2) ──
// Deux bornes combinées, appliquées par isSessionFresh() : un délai d'inactivité
// (la session expire si rien ne se passe pendant ce temps) et une durée absolue
// (la session expire même avec activité continue, forçant une reconnexion
// périodique). L'admin manipule des données plus sensibles (coordonnées
// acheteurs, prix négociés) et a déjà la MFA — on peut donc se permettre une
// fenêtre courte sans trop pénaliser l'usage. Le portail acheteur reste plus
// permissif pour éviter de reconnecter un client à chaque visite.
const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;              // 30 min
const ADMIN_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;     // 12 h
const BUYER_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;          // 2 h
const BUYER_ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

// Initialise (à la première requête authentifiée suivant regenerate()) puis
// vérifie les deux bornes ; renouvelle lastActive à chaque appel réussi.
// Ne pas confondre avec le cookie lui-même : session.destroy() (appelé par
// les middlewares requireAdmin/requireRole/requireBuyerAuth quand ceci
// renvoie false) est ce qui invalide réellement l'accès, pas cette fonction.
function isSessionFresh(req, idleMs, absoluteMs) {
  const now = Date.now();
  if (!req.session.authAt) req.session.authAt = now;
  if (!req.session.lastActive) req.session.lastActive = now;
  if (now - req.session.authAt > absoluteMs) return false;
  if (now - req.session.lastActive > idleMs) return false;
  req.session.lastActive = now;
  return true;
}

// MFA obligatoire côté admin (comptes admin_users individuels ET compte owner
// legacy à mot de passe partagé) : une session admin/staff sans MFA enrôlée
// ne peut appeler que les endpoints nécessaires pour terminer l'enrôlement
// (ou se déconnecter) — tout le reste du panneau est bloqué côté serveur,
// pas seulement masqué côté client. Le flag d'enrôlement est mis en cache
// dans la session à la connexion (et rafraîchi par /api/staff/mfa/confirm et
// /disable) pour éviter une requête DB à chaque appel. Une session déjà
// ouverte AVANT le déploiement de cette fonctionnalité n'a pas ce flag
// (undefined, ni true ni false) — on le déduit alors une seule fois depuis
// la base plutôt que de traiter "flag absent" comme "non enrôlé" : sinon
// tout admin déjà connecté (MFA active ou non) se retrouve bloqué au
// redémarrage du serveur, sans lien avec son état réel.
async function requireMfaEnrolled(req, res, next) {
  const role = getRole(req);
  if (!role) return next(); // pas de session admin — laissé aux middlewares d'auth des routes
  try {
    let enrolled;
    if (req.session.staffUser) {
      enrolled = req.session.staffUser.mfaEnrolled;
      if (enrolled === undefined) {
        const r = await pool.query('SELECT mfa_enabled FROM admin_users WHERE id=$1', [req.session.staffUser.id]);
        enrolled = !!r.rows[0]?.mfa_enabled;
        req.session.staffUser.mfaEnrolled = enrolled;
      }
    } else {
      enrolled = req.session.ownerMfaEnrolled;
      if (enrolled === undefined) {
        enrolled = (await getSetting('owner_mfa_enabled')) === 'on';
        req.session.ownerMfaEnrolled = enrolled;
      }
    }
    if (enrolled) return next();
    const p = req.path;
    if (p.startsWith('/api/staff/mfa/') || p === '/api/me' || p === '/admin/logout') return next();
    if (p.startsWith('/api/')) return res.status(403).json({ error: 'mfa_required', message: 'Double authentification obligatoire — configurez-la avant de continuer.' });
    next(); // route HTML (ex. /admin) : le JS client affiche l'overlay de configuration bloquant
  } catch(e) {
    console.error('requireMfaEnrolled:', e);
    // Échec de la vérification MFA (ex. incident DB) : fail-closed sur /api/*
    // (actions et données sensibles — c'est là qu'est le vrai risque) mais
    // fail-open sur les pages HTML (simple coquille sans données, les appels
    // /api/* qu'elle déclenchera restent eux bloqués ci-dessus) — pour ne pas
    // reproduire le blocage total de l'incident CSRF 2026-07 tout en évitant
    // qu'une erreur DB transitoire ne devienne une fenêtre de contournement
    // du MFA obligatoire.
    logAuditRaw(req.session?.staffUser?.email || (req.session?.admin ? 'admin' : 'unknown'), 'mfa_check_failed', 'staff', req.session?.staffUser?.id || '', String(e.message || e));
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'mfa_check_failed', message: 'Vérification de sécurité temporairement indisponible — réessayez.' });
    next();
  }
}
app.use(requireMfaEnrolled);

// ── Mode maintenance ────────────────────────────────────────────────
// Coupe l'accès buyer/public en cas d'incident, en gardant l'admin joignable
// pour piloter la remise en ligne. Setting en base (persistant, visible par
// tous les workers), cache mémoire 5s pour éviter une requête DB par hit.
let _maintenanceCache = { value: null, at: 0 };
async function isMaintenanceOn() {
  const now = Date.now();
  if (_maintenanceCache.value !== null && now - _maintenanceCache.at < 5000) return _maintenanceCache.value;
  const v = await getSetting('maintenance_mode').catch(() => 'off');
  _maintenanceCache = { value: v === 'on', at: now };
  return _maintenanceCache.value;
}
function invalidateMaintenanceCache() { _maintenanceCache = { value: null, at: 0 }; }
const MAINTENANCE_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Maintenance</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f5f4f0;font-family:'Courier New',monospace;padding:32px;text-align:center;line-height:1.7}</style></head><body><div><p style="font-size:15px">Le showroom est temporairement en maintenance.</p><p style="font-size:13px;color:#999">Merci de réessayer dans quelques instants.</p></div></body></html>`;
app.use(async (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/staff') || req.path.startsWith('/api/me') || req.path.startsWith('/api/admin')) return next();
  if (getRole(req)) return next(); // staff/owner déjà authentifiés : accès total pendant la maintenance
  try {
    if (await isMaintenanceOn()) return res.status(503).type('html').send(MAINTENANCE_HTML);
  } catch(e) {}
  next();
});

// ── Audit log helper ──────────────────────────────────────
function logAudit(req, action, targetType, targetId, details) {
  const email = req.session?.staffUser?.email || (req.session?.admin ? 'admin' : 'unknown');
  pool.query('INSERT INTO admin_audit_log (id,user_email,action,target_type,target_id,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
    [uuidv4(), email, action, targetType, targetId||'', details||'']).catch(()=>{});
}
// Variante sans req.session (connexion/déconnexion : l'identité n'est pas
// encore — ou plus — dans la session à l'instant du log). `details` ne doit
// jamais contenir de mot de passe/token — ici uniquement l'IP appelante.
function logAuditRaw(email, action, targetType, targetId, details) {
  pool.query('INSERT INTO admin_audit_log (id,user_email,action,target_type,target_id,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
    [uuidv4(), email || 'unknown', action, targetType, targetId||'', details||'']).catch(()=>{});
}

// ── MFA (TOTP) ──────────────────────────────────────────────────────
// 10 codes de secours à usage unique, format lisible XXXX-XXXX. Comme un mot
// de passe, seul le hash SHA-256 est conservé en base — jamais le code en clair.
function generateBackupCodes() {
  const plain = [];
  for (let i = 0; i < 10; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    plain.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  const hashed = plain.map(c => crypto.createHash('sha256').update(c).digest('hex'));
  return { plain, hashed };
}
// Vérifie et consomme (usage unique) un code de secours parmi la liste hashée
// stockée en base. Renvoie la liste hashée mise à jour (code retiré) si trouvé,
// sinon null.
function consumeBackupCode(hashedListJson, submittedCode) {
  let hashedList;
  try { hashedList = JSON.parse(hashedListJson || '[]'); } catch(e) { return null; }
  const hash = crypto.createHash('sha256').update((submittedCode || '').trim().toUpperCase()).digest('hex');
  const idx = hashedList.indexOf(hash);
  if (idx === -1) return null;
  hashedList.splice(idx, 1);
  return hashedList;
}
// otplib accepte un code sur une fenêtre de tolérance (±1 pas de 30s) mais ne
// bloque pas nativement la réutilisation du même code dans cette fenêtre — un
// code intercepté (regard par-dessus l'épaule, capture réseau) resterait donc
// valable pour une seconde connexion. On retient le pas de temps du dernier
// code accepté par compte et on rejette la réutilisation du même pas.
function currentTotpStep() {
  return Math.floor(Date.now() / 1000 / (authenticator.options.step || 30));
}

// ── Order events (timeline) ───────────────────────────────────────────
// detail : payload JSON optionnel (ex. liste des lignes modifiées avec
// quantité avant/après pour 'lines_edited') — affiché en plus de `note`
// dans le fil d'historique de la commande.
async function addOrderEvent(orderId, eventType, note, createdBy, detail) {
  await pool.query(
    'INSERT INTO order_events (order_id, event_type, note, created_by, detail) VALUES ($1,$2,$3,$4,$5)',
    [orderId, eventType, note || '', createdBy || 'system', detail ? JSON.stringify(detail) : '']
  ).catch(() => {});
}

// Décrémente le stock suivi des lignes d'une commande qui sort de l'état
// "draft" — nécessaire car /reorder est le seul chemin qui insère une
// commande directement en 'draft' sans passer par createOrder() (qui
// décrémente déjà le stock à la création) ; sans ce décrément, confirmer un
// brouillon issu d'un "renouveler" ne reflétait jamais la quantité engagée
// dans stock_qty, risquant un sur-engagement. Transactionnel et tout-ou-rien :
// si une ligne n'a plus assez de stock, annule tous les décréments déjà
// faits pour cette commande plutôt que de la laisser à moitié décrémentée.
async function decrementOrderStockOnActivation(orderId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const lines = await dbClient.query(
      `SELECT ol.product_id, ol.quantity, p.stock_enabled, p.stock_qty, p.reference
       FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id=$1`,
      [orderId]
    );
    for (const line of lines.rows) {
      if (line.stock_enabled && line.stock_qty !== null) {
        const upd = await dbClient.query(
          'UPDATE products SET stock_qty = stock_qty - $1 WHERE id=$2 AND stock_enabled=true AND stock_qty IS NOT NULL AND stock_qty >= $1',
          [line.quantity, line.product_id]
        );
        if (upd.rowCount === 0) {
          await dbClient.query('ROLLBACK');
          return { error: `Stock insuffisant pour ${line.reference || line.product_id}` };
        }
      }
    }
    await dbClient.query('COMMIT');
    return { ok: true };
  } catch(e) {
    await dbClient.query('ROLLBACK');
    return { error: e.message };
  } finally {
    dbClient.release();
  }
}

// Recrédite le stock suivi (stock_enabled) des lignes d'une commande annulée
// ou supprimée — createOrder() et l'édition de lignes décrémentent stock_qty,
// mais annuler/supprimer une commande ne le recréditait jamais, perdant ce
// stock définitivement pour les marques qui suivent leurs quantités.
async function restoreOrderStock(orderId) {
  try {
    const lines = await pool.query(
      `SELECT ol.product_id, ol.quantity, p.stock_enabled, p.stock_qty
       FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id=$1`,
      [orderId]
    );
    for (const line of lines.rows) {
      if (line.stock_enabled && line.stock_qty !== null) {
        await pool.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id=$2', [line.quantity, line.product_id]);
      }
    }
  } catch(e) { console.error('restoreOrderStock:', e.message); }
}

// Helpers
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Nettoyage strict du message enrichi saisi par le staff (composer riche de
// l'invitation prospect, contenteditable côté client) avant de l'insérer
// dans l'email envoyé. Ne JAMAIS faire confiance au nettoyage fait dans le
// navigateur (contournable en modifiant la requête) — seule cette étape
// côté serveur fait foi. Autorise uniquement la mise en forme minimale
// (gras/italique/paragraphes/liens) ; tout le reste (script, style, iframe,
// attributs on*…) est supprimé. Les liens sont systématiquement forcés en
// target=_blank/rel=noopener/noreferrer et restreints aux schémas
// http(s)/mailto — jamais javascript: ou data:.
function sanitizeRichMessage(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'a'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      div: 'p',
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: { href: attribs.href || '#', target: '_blank', rel: 'noopener noreferrer' }
      })
    }
  }).trim();
}

// Neutralise l'injection de formule CSV/XLSX (Excel/Sheets exécutent les cellules
// commençant par =, +, -, @ comme des formules à l'ouverture) en préfixant d'une
// apostrophe — inoffensif pour les valeurs normales, désamorce =CMD(), +HYPERLINK() etc.
// Neutralise l'injection de formule CSV (un champ ouvert par un tableur qui
// commence par un caractère déclencheur peut exécuter du code — cf. OWASP CSV
// Injection). On se limite à '=' et '@' (déclencheurs de formule sans
// ambiguïté) et aux caractères de contrôle tabulation/retour chariot : '+' et
// '-' ont été retirés du jeu de caractères piégés — un numéro de téléphone
// international ("+33 6 12 34 56 78", donnée courante pour cette app B2B
// France) partageait leur préfixe et se retrouvait corrompu par l'apostrophe
// ajoutée (invisible dans Excel mais visible et cassante pour tout autre
// consommateur du CSV — réimport, autre tableur, script).
function csvSafe(v) {
  const s = String(v == null ? '' : v);
  return /^[=@\t\r]/.test(s) ? "'" + s : s;
}

function cloudinaryOpt(url) {
  if (!url || !url.includes('res.cloudinary.com')) return url;
  return url.replace('/upload/', '/upload/q_auto,f_auto/');
}

// Nombre fini, négatif ramené à 0 (prix, MOQ, stock — jamais de valeur négative).
function nonNeg(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// URL destinée à un href : n'autorise que http(s). Neutralise javascript:, data:,
// etc. (sinon une URL javascript: stockée s'exécuterait au clic — XSS). Vide sinon.
function safeHttpUrl(url) {
  const s = String(url || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function slugify(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Slug lisible pour un lien partagé (ex. /rejoindre/zara-4f9a2c1b, /c/zara-9e3d0a7c),
// dérivé du nom de marque + un suffixe aléatoire TOUJOURS présent (pas
// seulement en cas de collision). Le nom d'une marque n'est pas un secret —
// n'importe qui le connaissant pourrait sinon deviner /c/zara ou
// /rejoindre/zara sans jamais avoir reçu le lien, contournant entièrement le
// token aléatoire censé être le seul rempart d'accès (le lien /c/:token donne
// accès aux prix wholesale/conditions commerciales confidentielles sans
// compte). Repli sur un court identifiant aléatoire si le nom ne produit
// aucun caractère latin/chiffre (ex. nom uniquement en emoji/idéogrammes).
// table ne provient jamais d'une entrée utilisateur (toujours un littéral codé
// en dur aux points d'appel) — l'interpolation ici est sûre.
async function uniqueSlugFor(table, brandName) {
  const base = slugify(brandName) || crypto.randomBytes(3).toString('hex');
  while (true) {
    const candidate = `${base}-${crypto.randomBytes(4).toString('hex')}`;
    const exists = await pool.query(`SELECT 1 FROM ${table} WHERE slug=$1`, [candidate]);
    if (!exists.rows.length) return candidate;
  }
}

async function getSetting(key) {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows[0]?.value || '';
}

// Host/X-Forwarded-Host viennent du client et sont trivialement falsifiables
// (n'importe qui peut envoyer un en-tête Host arbitraire) — les faire confiance
// aveuglément permettait d'empoisonner tous les liens générés par le serveur
// (réinitialisation de mot de passe, invitations, QR codes, liens de sélection…)
// vers un domaine contrôlé par l'attaquant, avec le token en clair dans l'URL :
// une victime cliquant le lien envoie son token de réinitialisation à l'attaquant,
// qui le rejoue ensuite sur le vrai domaine → prise de contrôle du compte.
// BASE_URL doit être défini en production ; le repli sur les en-têtes de requête
// n'est acceptable qu'en développement local (jamais exposé à Internet).
function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  // req est absent des tâches de fond (crons, emails déclenchés hors requête HTTP) —
  // ces contextes retombent aussi sur le domaine de prod plutôt que de planter.
  if (process.env.NODE_ENV === 'production' || !req) return 'https://showroom.editionsstandard.com';
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
  if (!getRole(req)) return res.redirect('/admin/login');
  if (isSessionFresh(req, ADMIN_IDLE_TIMEOUT_MS, ADMIN_ABSOLUTE_TIMEOUT_MS)) return next();
  return req.session.destroy(() => res.redirect('/admin/login?error=session_expired'));
}

function requireRole(...allowed) {
  return (req, res, next) => {
    const role = getRole(req);
    if (!role || !allowed.includes(role)) return res.status(403).json({ error: 'Accès refusé pour ce rôle' });
    if (!isSessionFresh(req, ADMIN_IDLE_TIMEOUT_MS, ADMIN_ABSOLUTE_TIMEOUT_MS)) {
      return req.session.destroy(() => res.status(401).json({ error: 'Session expirée, reconnectez-vous.' }));
    }
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
// Handler commun : journalise le dépassement (IP + route) avant de renvoyer le 429
// standard — permet de repérer un brute-force en cours dans /api/admin/audit-log
// sans avoir à grep les logs Railway.
function rateLimitExceededHandler(message) {
  return (req, res /*, next, options */) => {
    logAuditRaw('rate-limit', 'rate_limit_exceeded', 'route', req.originalUrl, req.ip);
    res.status(429).json(message);
  };
}

// Clé de rate-limit résistante au spoofing de X-Forwarded-For. `trust proxy`
// est nécessaire en production (cookies sécurisés derrière le proxy Railway),
// mais un client qui atteint le serveur directement (ce sandbox de test, ou
// tout accès qui contournerait le proxy) peut alors faire varier req.ip à
// volonté simplement en changeant l'en-tête — ce qui viderait de son sens un
// rate-limit basé sur l'IP, y compris combinée à un email (IP+email varie
// tout autant si l'IP varie : composer les deux ne protège rien tant que
// l'un des deux termes reste falsifiable). On clé donc PUREMENT sur un
// identifiant que le client ne peut pas changer à chaque requête :
// - étape code MFA (staff ou acheteur) : la session déjà validée par mot de
//   passe (mfaPending/mfaPendingBuyer.id, ou l'ID de session pour le owner
//   qui n'a pas d'ID de compte dédié) — cette session ne peut exister sans
//   avoir déjà fourni le bon mot de passe, donc pas falsifiable par un
//   simple changement d'en-tête ;
// - étape mot de passe : l'email soumis seul — un attaquant qui fait varier
//   l'IP reste plafonné sur CE compte précis, seul repli qui compte contre
//   un brute-force ciblé (et évite au passage le blocage collatéral d'une
//   IP de showroom partagée par plusieurs comptes légitimes).
function authRateLimitKey(req) {
  const pending = req.session?.mfaPending || req.session?.mfaPendingBuyer;
  if (pending) return 'mfa:' + (pending.id || ('owner:' + req.sessionID));
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  return email ? 'email:' + email : rateLimit.ipKeyGenerator(req.ip);
}
// Pour les routes déjà authentifiées (changement/désactivation de mot de
// passe ou de MFA) : clé sur l'identité de session, pas l'IP.
function authedUserRateLimitKey(req) {
  const id = req.session?.staffUser?.id || (req.session?.admin ? 'owner' : '') || req.session?.buyerPortal?.id;
  return id ? 'auth:' + id : rateLimit.ipKeyGenerator(req.ip);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  keyGenerator: authRateLimitKey,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  handler: rateLimitExceededHandler({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' }),
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
  // Relevé : en showroom (Fashion Week) plusieurs acheteurs passent commande
  // derrière la MÊME IP publique (WiFi partagé) — 30/h bloquait tout le monde.
  max: 200,
  message: { error: 'Trop de demandes. Réessayez dans quelques minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// Validation d'une sélection par l'acheteur : limité PAR SÉLECTION (token), pas
// par IP — sinon plusieurs acheteurs sur le WiFi du showroom se bloquent entre eux.
// Les validations réussies ne comptent pas (skipSuccessfulRequests) : seuls les
// essais en échec (signature/CGV/mot de passe) sont décomptés, largement.
const confirmLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 20,
  // La route porte toujours :token → on keye par sélection (jamais par IP),
  // ce qui évite aussi la normalisation IPv6 d'express-rate-limit.
  keyGenerator: (req) => 'sel:' + req.params.token,
  skipSuccessfulRequests: true,
  message: { error: 'Trop de tentatives sur cette sélection. Réessayez dans quelques minutes.' },
  standardHeaders: true, legacyHeaders: false
});

const passwordLimiter = rateLimit({
  windowMs: 900000, // 15 minutes
  max: 5,
  keyGenerator: authedUserRateLimitKey,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  handler: rateLimitExceededHandler({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' }),
  standardHeaders: true, legacyHeaders: false
});

// /api/portal/translate appelle un LLM payant (Claude) par lot non mis en cache —
// un compte acheteur (auto-inscrit via lien d'invitation, sans vetting) pouvait
// jusqu'ici envoyer un flot illimité de textes inédits et générer un coût API sans
// borne. Limite par COMPTE (comme uploadLimiter), pas par IP.
const translateLimiter = rateLimit({
  windowMs: 3600000, // 1 heure
  max: 100,
  keyGenerator: authedUserRateLimitKey,
  message: { error: 'Trop de requêtes de traduction. Réessayez dans quelques minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// Mot de passe oublié / lien magique acheteur : plusieurs acheteurs partagent
// souvent la même IP (WiFi showroom) — 5/h (emailLimiter) les bloquerait
// mutuellement, comme le bug de validation déjà corrigé (confirmLimiter). Les
// tokens sont générés en crypto.randomBytes(32) (256 bits) : la sécurité ne
// repose pas sur ce rate-limit, qui n'est là que pour éviter le spam d'envois.
const buyerAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 30,
  keyGenerator: (req) => {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    return email ? 'email:' + email : rateLimit.ipKeyGenerator(req.ip);
  },
  message: { error: 'Trop de demandes. Réessayez dans quelques minutes.' },
  handler: rateLimitExceededHandler({ error: 'Trop de demandes. Réessayez dans quelques minutes.' }),
  standardHeaders: true, legacyHeaders: false
});


const cartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Emails sortants déclenchés par du staff (invitation prospect, renvoi d'accès/
// commande, relances) : un compte agent (rôle bas niveau de confiance, scopé à
// une marque) pouvait déclencher un nombre illimité d'envois Resend en boucle.
// Plafond généreux (compatible avec un vrai envoi en masse après un salon) mais
// borné, et par COMPTE (authedUserRateLimitKey) — pas par IP — pour ne pas
// bloquer toute l'agence derrière la même IP de bureau. Réutilisé tel quel sur
// tous les endpoints d'email sortant déclenchables par un agent (pas un
// limiteur dédié par endpoint : même risque, même seuil raisonnable).
const prospectInviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 200,
  keyGenerator: authedUserRateLimitKey,
  message: { error: 'Trop d\'invitations envoyées. Réessayez dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false,
});

// Uploads (photos produit, import en lot, pièces jointes messagerie) : aucun
// des 4 endpoints d'upload ne limitait le débit — un compte compromis pouvait
// marteler Cloudinary sans borne. Limite par COMPTE (staff ou acheteur, via
// authedUserRateLimitKey) et non par requête individuelle : un import en lot
// de 200 photos reste UN seul appel HTTP, donc n'est jamais bloqué par cette
// limite pensée pour la fréquence des appels, pas leur contenu.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 60,
  keyGenerator: authedUserRateLimitKey,
  message: { error: 'Trop d\'imports. Réessayez dans 1 heure.' },
  standardHeaders: true, legacyHeaders: false,
});
// ==================== ADMIN ROUTES ====================

// Un admin déjà connecté qui revient sur /admin/login (ex. bouton Précédent
// après une connexion réussie, la navigation par section ne poussant pas
// d'historique) tombait sur un formulaire figé — parfois même l'étape MFA,
// laissant croire à une déconnexion. On redirige directement vers /admin.
app.get('/admin/login', (req, res) => {
  if (getRole(req)) return res.redirect('/admin');
  sendPage(res, 'admin-login.html');
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (email) {
    const r = await pool.query('SELECT id, email, role, brand_id, name, password_hash, mfa_enabled, locked_until FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    const user = r.rows[0];
    const passwordOk = await bcrypt.compare(password || '', user?.password_hash || DUMMY_BCRYPT_HASH);
    const locked = isLocked(user);
    if (user && passwordOk && !locked) {
      await clearLoginFailures('admin_users', user.id);
      if (user.mfa_enabled) {
        // Mot de passe correct mais MFA active : pas de session privilégiée tant
        // que le code TOTP n'est pas vérifié — mfaPending ne porte aucun droit.
        req.session.mfaPending = { kind: 'staff', id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, name: user.name };
        logAuditRaw(user.email, 'login_password_ok_mfa_pending', 'staff', user.id, req.ip);
        return res.redirect('/admin/login?step=mfa');
      }
      return req.session.regenerate(err => {
        if (err) return res.redirect('/admin/login?error=1');
        req.session.staffUser = { id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, name: user.name, mfaEnrolled: false };
        logAuditRaw(user.email, 'login_success', 'staff', user.id, req.ip);
        // Sauvegarde explicite avant redirection — voir commentaire équivalent
        // sur /admin/login/mfa (évite un rebond vers /admin/login si le
        // navigateur suit le 302 avant la persistance garantie de la session).
        req.session.save(err2 => err2 ? res.redirect('/admin/login?error=1') : res.redirect('/admin'));
      });
    }
    if (user && locked) {
      logAuditRaw(user.email, 'login_blocked_locked', 'staff', user.id, req.ip);
      return res.redirect('/admin/login?error=locked');
    }
    if (user) await recordLoginFailure('admin_users', user.id);
    logAuditRaw(email.toLowerCase().trim(), 'login_failed', 'staff', '', req.ip);
    return res.redirect('/admin/login?error=1');
  }

  const ownerLocked = await isOwnerLocked();
  if (ownerLocked) {
    logAuditRaw('admin', 'login_blocked_locked', 'staff', '', req.ip);
    return res.redirect('/admin/login?error=locked');
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
    await clearOwnerLoginFailures();
    const ownerMfaEnabled = (await getSetting('owner_mfa_enabled')) === 'on';
    if (ownerMfaEnabled) {
      req.session.mfaPending = { kind: 'owner' };
      logAuditRaw('admin', 'login_password_ok_mfa_pending', 'staff', '', req.ip);
      return res.redirect('/admin/login?step=mfa');
    }
    req.session.regenerate(err => {
      if (err) return res.redirect('/admin/login?error=1');
      req.session.admin = true;
      req.session.ownerMfaEnrolled = false;
      logAuditRaw('admin', 'login_success', 'staff', '', req.ip);
      req.session.save(err2 => err2 ? res.redirect('/admin/login?error=1') : res.redirect('/admin'));
    });
  } else {
    await recordOwnerLoginFailure();
    logAuditRaw('admin', 'login_failed', 'staff', '', req.ip);
    res.redirect('/admin/login?error=1');
  }
});

// Étape 2 : vérification du code TOTP (ou d'un code de secours) après un mot
// de passe déjà validé (req.session.mfaPending, sans aucun droit tant que
// cette étape n'est pas franchie). Limité par loginLimiter comme le mot de
// passe — un code à 6 chiffres est bien plus rapide à bruteforcer qu'un mot
// de passe, la fenêtre de 30s + le rate-limit le rendent impraticable.
app.post('/admin/login/mfa', loginLimiter, async (req, res) => {
  const pending = req.session.mfaPending;
  if (!pending) return res.redirect('/admin/login');
  const code = (req.body.code || '').toString().trim();
  const backupCode = (req.body.backup_code || '').toString().trim();
  let ok = false, usedBackup = false;

  const step = currentTotpStep();
  if (pending.kind === 'staff') {
    const r = await pool.query('SELECT mfa_secret, mfa_backup_codes FROM admin_users WHERE id=$1', [pending.id]);
    const row = r.rows[0];
    if (row?.mfa_secret) {
      if (code && authenticator.check(code, row.mfa_secret)) {
        // Anti-rejeu atomique : un simple SELECT puis UPDATE séparés laisse une
        // fenêtre où deux requêtes concurrentes avec le MÊME code (intercepté,
        // rejoué) passeraient toutes les deux authenticator.check() avant qu'aucune
        // n'ait encore écrit mfa_last_step. L'UPDATE conditionnel ci-dessous est
        // atomique côté Postgres (verrou de ligne) : une seule requête peut
        // effectivement réclamer ce pas de temps, l'autre obtient rowCount=0.
        const claim = await pool.query('UPDATE admin_users SET mfa_last_step=$1 WHERE id=$2 AND mfa_last_step IS DISTINCT FROM $1 RETURNING id', [step, pending.id]);
        ok = claim.rowCount > 0;
      } else if (backupCode) {
        const updated = consumeBackupCode(row.mfa_backup_codes, backupCode);
        // Même principe : l'UPDATE ne s'applique que si mfa_backup_codes n'a pas
        // changé depuis la lecture — sinon deux requêtes concurrentes pourraient
        // consommer deux fois le même code de secours.
        if (updated) {
          const claim = await pool.query('UPDATE admin_users SET mfa_backup_codes=$1 WHERE id=$2 AND mfa_backup_codes=$3 RETURNING id', [JSON.stringify(updated), pending.id, row.mfa_backup_codes]);
          ok = usedBackup = claim.rowCount > 0;
        }
      }
    }
  } else if (pending.kind === 'owner') {
    const secret = await getSetting('owner_mfa_secret');
    if (secret) {
      if (code && authenticator.check(code, secret)) {
        const claim = await pool.query(
          `INSERT INTO settings (key,value) VALUES ('owner_mfa_last_step',$1)
           ON CONFLICT (key) DO UPDATE SET value=$1 WHERE settings.value IS DISTINCT FROM $1
           RETURNING key`,
          [String(step)]
        );
        ok = claim.rowCount > 0;
      } else if (backupCode) {
        const backupJson = await getSetting('owner_mfa_backup_codes');
        const updated = consumeBackupCode(backupJson, backupCode);
        if (updated) {
          const claim = await pool.query("UPDATE settings SET value=$1 WHERE key='owner_mfa_backup_codes' AND value=$2 RETURNING key", [JSON.stringify(updated), backupJson]);
          ok = usedBackup = claim.rowCount > 0;
        }
      }
    }
  }

  if (!ok) {
    logAuditRaw(pending.email || 'admin', 'login_mfa_failed', 'staff', pending.id || '', req.ip);
    return res.redirect('/admin/login?step=mfa&error=1');
  }

  req.session.regenerate(err => {
    if (err) return res.redirect('/admin/login?error=1');
    if (pending.kind === 'staff') {
      req.session.staffUser = { id: pending.id, email: pending.email, role: pending.role, brand_id: pending.brand_id, name: pending.name, mfaEnrolled: true };
    } else {
      req.session.admin = true;
      req.session.ownerMfaEnrolled = true;
    }
    logAuditRaw(pending.email || 'admin', usedBackup ? 'login_success_mfa_backup' : 'login_success_mfa', 'staff', pending.id || '', req.ip);
    // Sauvegarde explicite avant la redirection : sans ça, un navigateur qui suit
    // le 302 immédiatement peut arriver sur /admin avant que la nouvelle session
    // (régénérée juste au-dessus) ne soit garantie persistée en base — requireAdmin
    // ne la trouve pas encore et rebondit vers /admin/login (observé en test réel).
    req.session.save(err2 => {
      if (err2) return res.redirect('/admin/login?error=1');
      res.redirect('/admin');
    });
  });
});

app.get('/admin/logout', (req, res) => {
  const email = req.session?.staffUser?.email || (req.session?.admin ? 'admin' : 'unknown');
  logAuditRaw(email, 'logout', 'staff', '', req.ip);
  req.session.destroy(() => res.redirect('/admin/login'));
});
app.get('/admin', requireAdmin, (req, res) => sendPage(res, 'admin.html'));

app.get('/admin/reset-password', (req, res) => sendPage(res, 'admin-reset-password.html'));

// Mot de passe oublié / réinitialisation pour le staff (owner avec compte
// email, agent, designer — admin_users). Même principe que le flux acheteur
// (buyerAuthLimiter/buyer_password_resets) : token 256 bits, seul le hash est
// stocké, réponse toujours identique côté /forgot-password pour ne jamais
// révéler si un email correspond à un compte. Le compte owner "historique"
// (mot de passe unique en settings.admin_password, sans ligne admin_users)
// n'est pas couvert ici — il reste géré via Paramètres > Sécurité une fois
// connecté.
app.post('/api/staff/forgot-password', buyerAuthLimiter, async (req, res) => {
  const { email } = req.body || {};
  res.json({ ok: true }); // toujours succès — ne révèle jamais si l'email existe
  if (!email) return;
  try {
    const a = await pool.query('SELECT id, name FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!a.rows[0]) return;
    const admin = a.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 heure
    await pool.query('DELETE FROM admin_password_resets WHERE admin_id=$1', [admin.id]);
    await pool.query(
      'INSERT INTO admin_password_resets (token, admin_id, expires_at) VALUES ($1,$2,$3)',
      [tokenHash, admin.id, expires]
    );
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return;
    const resend = newResendClient(resendKey);
    const showroomName = await getSetting('showroom_name');
    const fromAddress = await getSetting('smtp_from');
    const resetUrl = `${getBaseUrl(req)}/admin/reset-password?token=${token}`;
    const { error } = await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [email],
      subject: `Réinitialisation de mot de passe — ${showroomName}`,
      html: emailLayout({
        showroomName,
        content: `
          <p>Bonjour${admin.name ? ' <strong>' + escHtml(admin.name) + '</strong>' : ''},</p>
          <p>Vous avez demandé à réinitialiser votre mot de passe pour l'espace admin <strong>${showroomName}</strong>.</p>
          ${emailBtn(resetUrl, 'Choisir un nouveau mot de passe →')}
          <p style="font-size:13px;color:#888;margin-top:24px">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
          <p>Cordialement,<br><strong>${showroomName}</strong></p>
        `
      })
    });
    if (error) console.error('[resend] staff forgot-password:', error.message || error);
  } catch (e) { console.error('staff forgot-password error:', e.message); }
});

app.post('/api/staff/reset-password', buyerAuthLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 12)
    return res.json({ error: 'Données invalides (12 caractères minimum).' });
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await pool.query(
      'SELECT admin_id FROM admin_password_resets WHERE token=$1 AND used=false AND expires_at > NOW()',
      [tokenHash]
    );
    if (!r.rows[0]) return res.json({ error: 'Lien invalide ou expiré.' });
    const adminId = r.rows[0].admin_id;
    const hash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE admin_users SET password_hash=$1, failed_login_count=0, locked_until=NULL WHERE id=$2', [hash, adminId]);
      await client.query('UPDATE admin_password_resets SET used=true WHERE token=$1', [tokenHash]);
      await client.query('COMMIT');
    } catch(txErr) { await client.query('ROLLBACK'); throw txErr; }
    finally { client.release(); }
    // Un reset via lien mail invalide toutes les sessions existantes de ce
    // compte (pas de session "courante" légitime à préserver, contrairement
    // au changement de mot de passe depuis l'admin une fois déjà connecté).
    await invalidateStaffSessions(adminId, null);
    logAuditRaw('staff:' + adminId, 'password_reset', 'staff', adminId, req.ip);
    res.json({ ok: true });
  } catch (e) { res.json({ error: 'Erreur serveur.' }); }
});

// ── MFA : enrôlement et gestion (self-service, tous rôles connectés) ────
// Le secret n'est écrit dans mfa_secret (actif) qu'après vérification d'un
// code — tant qu'il est seulement dans mfa_pending_secret, la MFA reste
// désactivée : un enrôlement lancé puis abandonné n'a aucun effet.
app.get('/api/staff/mfa/status', requireAdmin, async (req, res) => {
  if (req.session.staffUser) {
    const r = await pool.query('SELECT mfa_enabled FROM admin_users WHERE id=$1', [req.session.staffUser.id]);
    return res.json({ enabled: !!r.rows[0]?.mfa_enabled });
  }
  res.json({ enabled: (await getSetting('owner_mfa_enabled')) === 'on' });
});

app.post('/api/staff/mfa/setup', requireAdmin, passwordLimiter, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const label = req.session.staffUser?.email || 'owner';
    const uri = authenticator.keyuri(label, 'Showroom Editions Standard', secret);
    const qr = await QRCode.toDataURL(uri);
    if (req.session.staffUser) {
      await pool.query('UPDATE admin_users SET mfa_pending_secret=$1 WHERE id=$2', [secret, req.session.staffUser.id]);
    } else {
      await pool.query("INSERT INTO settings (key,value) VALUES ('owner_mfa_pending_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [secret]);
    }
    res.json({ secret, qr, uri });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/staff/mfa/confirm', requireAdmin, passwordLimiter, async (req, res) => {
  try {
    const code = (req.body.code || '').toString().trim();
    let secret;
    if (req.session.staffUser) {
      const r = await pool.query('SELECT mfa_pending_secret FROM admin_users WHERE id=$1', [req.session.staffUser.id]);
      secret = r.rows[0]?.mfa_pending_secret;
    } else {
      secret = await getSetting('owner_mfa_pending_secret');
    }
    if (!secret || !code || !authenticator.check(code, secret)) return res.status(400).json({ error: 'Code invalide. Vérifiez l\'heure de votre appareil et réessayez.' });
    const { plain, hashed } = generateBackupCodes();
    if (req.session.staffUser) {
      await pool.query('UPDATE admin_users SET mfa_secret=$1, mfa_pending_secret=NULL, mfa_enabled=true, mfa_backup_codes=$2 WHERE id=$3', [secret, JSON.stringify(hashed), req.session.staffUser.id]);
      req.session.staffUser.mfaEnrolled = true; // débloque immédiatement le reste de l'admin (MFA obligatoire)
      logAudit(req, 'mfa_enabled', 'staff', req.session.staffUser.id, '');
    } else {
      await pool.query("INSERT INTO settings (key,value) VALUES ('owner_mfa_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [secret]);
      await pool.query("INSERT INTO settings (key,value) VALUES ('owner_mfa_enabled','on') ON CONFLICT (key) DO UPDATE SET value='on'");
      await pool.query("INSERT INTO settings (key,value) VALUES ('owner_mfa_backup_codes',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(hashed)]);
      await pool.query("DELETE FROM settings WHERE key='owner_mfa_pending_secret'");
      req.session.ownerMfaEnrolled = true;
      logAudit(req, 'mfa_enabled', 'system', '', 'owner');
    }
    res.json({ ok: true, backup_codes: plain });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Désactivation : ré-authentification par mot de passe exigée (action sensible).
app.post('/api/staff/mfa/disable', requireAdmin, passwordLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (req.session.staffUser) {
      const r = await pool.query('SELECT password_hash FROM admin_users WHERE id=$1', [req.session.staffUser.id]);
      if (!r.rows[0] || !await bcrypt.compare(password || '', r.rows[0].password_hash)) return res.status(403).json({ error: 'Mot de passe incorrect' });
      await pool.query('UPDATE admin_users SET mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled=false, mfa_backup_codes=NULL WHERE id=$1', [req.session.staffUser.id]);
      // MFA obligatoire : désactiver reverrouille immédiatement le compte
      // derrière le flux d'enrôlement (cohérent avec le middleware requireMfaEnrolled).
      req.session.staffUser.mfaEnrolled = false;
      logAudit(req, 'mfa_disabled', 'staff', req.session.staffUser.id, '');
    } else {
      const adminPassword = await getSetting('admin_password');
      const valid = adminPassword.startsWith('$2') ? await bcrypt.compare(password || '', adminPassword) : password === adminPassword;
      if (!valid) return res.status(403).json({ error: 'Mot de passe incorrect' });
      await pool.query("DELETE FROM settings WHERE key IN ('owner_mfa_secret','owner_mfa_pending_secret','owner_mfa_enabled','owner_mfa_backup_codes')");
      req.session.ownerMfaEnrolled = false;
      logAudit(req, 'mfa_disabled', 'system', '', 'owner');
    }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Réinitialisation d'urgence de la MFA d'un membre du staff par l'owner
// (compte perdu, téléphone changé sans les codes de secours...).
app.post('/api/staff/:id/mfa/reset', requireRole('owner'), async (req, res) => {
  try {
    await pool.query('UPDATE admin_users SET mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled=false, mfa_backup_codes=NULL WHERE id=$1', [req.params.id]);
    logAudit(req, 'mfa_reset', 'staff', req.params.id, '');
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/me', requireAdmin, (req, res) => {
  const role = getRole(req);
  const mfa_enrolled = req.session.staffUser ? !!req.session.staffUser.mfaEnrolled : !!req.session.ownerMfaEnrolled;
  if (role === 'owner' && !req.session.staffUser) return res.json({ role: 'owner', mfa_enrolled });
  res.json({ role, brand_id: req.session.staffUser.brand_id, email: req.session.staffUser.email, name: req.session.staffUser.name, mfa_enrolled });
});

// ==================== STAFF ACCOUNTS (owner only) ====================

app.get('/api/staff', requireRole('owner'), async (req, res) => {
  const r = await pool.query('SELECT a.id, a.email, a.role, a.brand_id, a.name, a.avatar_url, a.created_at, a.last_seen_at, b.name as brand_name FROM admin_users a LEFT JOIN brands b ON a.brand_id=b.id ORDER BY a.created_at DESC');
  res.json(r.rows);
});

// Présence en ligne des comptes staff (agent/designer/owner) — même mécanique
// que /api/buyers/presence (fenêtre glissante de 90s), alimentée par le ping
// périodique envoyé depuis /admin et le PWA /agent tant qu'une session est ouverte.
app.get('/api/staff/presence', requireRole('owner'), async (req, res) => {
  const r = await pool.query("SELECT id FROM admin_users WHERE last_seen_at > NOW() - INTERVAL '90 seconds'");
  res.json(r.rows.map(s => s.id));
});

app.post('/api/staff/ping', requireAdmin, async (req, res) => {
  if (req.session.staffUser) {
    await pool.query('UPDATE admin_users SET last_seen_at = NOW() WHERE id = $1', [req.session.staffUser.id]);
  }
  res.json({ ok: true });
});

// Marque assignable à un agent (cantonnement à cette marque — cf. isBrandScoped)
// ou laissée vide pour un agent multi-marques ; obligatoire pour un designer.
function staffBrandIdFor(role, brand_id) {
  return (role === 'designer' || role === 'agent') ? (brand_id || null) : null;
}

// Photo de profil : uniquement une URL Cloudinary issue de /api/upload-image
// (jamais une URL arbitraire fournie telle quelle — même garde-fou que les
// pièces jointes de messagerie acheteur).
function sanitizeAvatarUrl(url) {
  return (typeof url === 'string' && url.startsWith('https://res.cloudinary.com/')) ? url : '';
}

app.post('/api/staff', requireRole('owner'), async (req, res) => {
  const { email, password, role, brand_id, name, avatar_url } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'Email, mot de passe et rôle requis' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) return res.status(400).json({ error: 'Email invalide' });
  if (password.length < 12) return res.status(400).json({ error: 'Mot de passe trop court (12 caractères minimum)' });
  if (!['owner', 'agent', 'designer'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  if (brand_id != null && typeof brand_id !== 'string') return res.status(400).json({ error: 'Marque invalide' });
  if (role === 'designer' && !brand_id) return res.status(400).json({ error: 'Une marque doit être assignée à un designer' });

  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const cleanEmail = email.toLowerCase().trim();
  try {
    await pool.query(
      'INSERT INTO admin_users (id, email, password_hash, role, brand_id, name, avatar_url) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, cleanEmail, hash, role, staffBrandIdFor(role, brand_id), name || '', sanitizeAvatarUrl(avatar_url)]
    );
    logAudit(req, 'create_staff', 'staff', id, `${cleanEmail} (${role})`);
    res.json({ id });
    sendStaffWelcomeEmail(req, { email: cleanEmail, name: name || '', role, password }).catch(e => console.error('Staff welcome email error:', e.message));
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    console.error(err); res.status(500).json({ error: "Erreur serveur" });
  }
});

// Invalide les sessions actives d'un membre du staff (changement de rôle, blocage,
// suppression) — sans ça, un rôle modifié ne prend effet qu'à la prochaine connexion,
// le `req.session.staffUser` déjà en mémoire côté navigateur restant valide.
async function invalidateStaffSessions(userId, exceptSid) {
  try {
    await pool.query(
      "DELETE FROM user_sessions WHERE sess->'staffUser'->>'id' = $1 AND sid != COALESCE($2, '')",
      [userId, exceptSid || null]
    );
  } catch(e) { console.error('invalidateStaffSessions:', e.message); }
}

app.put('/api/staff/:id', requireRole('owner'), async (req, res) => {
  try {
    const { name, email, role, brand_id, password, avatar_url } = req.body;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) return res.status(400).json({ error: 'Email invalide' });
    if (password && password.length < 12) return res.status(400).json({ error: 'Mot de passe trop court (12 caractères minimum)' });
    if (!['owner', 'agent', 'designer'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
    if (brand_id != null && typeof brand_id !== 'string') return res.status(400).json({ error: 'Marque invalide' });
    if (role === 'designer' && !brand_id) return res.status(400).json({ error: 'Une marque doit être assignée à un designer' });
    // Même garde-fou que DELETE : jamais retirer le dernier owner (auto-verrouillage
    // total de l'admin sinon — plus personne pour gérer le staff/les marques).
    const target = await pool.query('SELECT role FROM admin_users WHERE id=$1', [req.params.id]);
    const oldRole = target.rows[0]?.role;
    if (role !== 'owner' && oldRole === 'owner') {
      const ownerCount = await pool.query("SELECT COUNT(*) FROM admin_users WHERE role='owner'");
      if (parseInt(ownerCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Impossible de rétrograder le dernier compte owner.' });
      }
    }
    const normalizedEmail = email.toLowerCase().trim();
    const cleanAvatarUrl = sanitizeAvatarUrl(avatar_url);
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE admin_users SET name=$1,email=$2,role=$3,brand_id=$4,password_hash=$5,avatar_url=$6 WHERE id=$7', [name, normalizedEmail, role, staffBrandIdFor(role, brand_id), hash, cleanAvatarUrl, req.params.id]);
    } else {
      await pool.query('UPDATE admin_users SET name=$1,email=$2,role=$3,brand_id=$4,avatar_url=$5 WHERE id=$6', [name, normalizedEmail, role, staffBrandIdFor(role, brand_id), cleanAvatarUrl, req.params.id]);
    }
    logAudit(req, 'update_staff', 'staff', req.params.id, `role=${role}`);
    // Editer sa propre fiche (nom/email/mdp) sans changer son propre rôle ne doit
    // pas déconnecter la session en cours — sinon l'owner qui modifie son propre
    // profil se retrouve immédiatement délogué au milieu de l'opération.
    const isSelfEditNoRoleChange = req.session?.staffUser?.id === req.params.id && role === oldRole;
    await invalidateStaffSessions(req.params.id, isSelfEditNoRoleChange ? req.sessionID : null);
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
    logAudit(req, 'delete_staff', 'staff', req.params.id, target.rows[0]?.role || '');
    await invalidateStaffSessions(req.params.id);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Email d'identifiants staff, partagé entre la création de compte (accès tout
// juste créé par l'owner) et le renvoi/régénération manuelle — même gabarit,
// copie légèrement adaptée. Repli silencieux si RESEND_API_KEY absente : les
// deux appelants gèrent eux-mêmes le cas "non envoyé" (réponse HTTP déjà partie
// pour la création ; mot de passe renvoyé en clair pour le renvoi manuel).
async function sendStaffWelcomeEmail(req, { email, name, role, password, isNew = true }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('RESEND_API_KEY non configurée — email identifiants staff non envoyé'); return { emailed: false }; }
  const [showroomName, fromAddress] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from')]);
  const resend = newResendClient(resendKey);
  const loginUrl = `${getBaseUrl(req)}/admin/login`;
  const roleLabel = { owner: 'Propriétaire', agent: 'Agent', designer: 'Marque / Designer' }[role] || role;
  const { error } = await resend.emails.send({
    from: `${showroomName || 'Showroom'} <${fromAddress || 'showroom@editionsstandard.com'}>`,
    to: [email],
    subject: isNew ? `${showroomName || 'Showroom'} — bienvenue, votre accès a été créé` : `${showroomName || 'Showroom'} — vos identifiants d'accès`,
    html: emailLayout({ showroomName, content:
      `<h2 style="font-size:18px;margin:0 0 16px">${isNew ? 'Bienvenue sur votre espace' : "Vos identifiants d'accès"}</h2>
       <p>Bonjour ${escHtml(name || '')},</p>
       <p>${isNew ? 'Un accès vient de vous être créé sur' : 'Voici vos identifiants pour accéder à'} votre espace :</p>
       ${emailInfoBox([['Email', email], ['Mot de passe', password], ['Rôle', roleLabel]])}
       ${emailBtn(loginUrl, 'SE CONNECTER')}
       <p style="color:#888;font-size:12px">Conservez cet email en lieu sûr et ne le transférez pas.${isNew ? '' : ' Ce mot de passe remplace le précédent.'}</p>` })
  });
  // Le SDK Resend résout avec {data:null,error} au lieu de rejeter sur un échec
  // API — sans cette vérification, l'appelant croirait l'email envoyé alors que
  // le destinataire n'a rien reçu (compte créé/mot de passe changé "à l'aveugle").
  if (error) { console.error('[resend] staff-credentials:', error.message || error); return { emailed: false }; }
  return { emailed: true };
}

// Renvoi des identifiants d'un compte staff (marque/agent). Les mots de passe
// étant hashés (non récupérables), on en génère un NOUVEAU, on le définit, puis
// on l'envoie par email avec le lien de connexion. Repli : renvoie le mot de
// passe dans la réponse si l'email n'est pas configuré (le owner le relaie).
app.post('/api/staff/:id/resend-credentials', requireRole('owner'), prospectInviteLimiter, async (req, res) => {
  try {
    const u = (await pool.query('SELECT id, email, name, role FROM admin_users WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'Compte introuvable' });
    const newPw = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const hash = await bcrypt.hash(newPw, 10);
    await pool.query('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [hash, u.id]);
    logAudit(req, 'resend_staff_credentials', 'staff', u.id, u.email);
    const { emailed } = await sendStaffWelcomeEmail(req, { email: u.email, name: u.name, role: u.role, password: newPw, isNew: false });
    res.json({ ok: true, emailed, email: u.email, password: emailed ? undefined : newPw });
  } catch(e) { console.error('resend staff creds:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Invitation d'un prospect : envoie depuis l'app un email d'invitation (harmonisé)
// avec un message personnalisable et le lien de demande d'accès. Contrairement au
// mailto (prospect → agence), c'est l'agence qui écrit au prospect.
app.post('/api/prospect-invite', requireRole('owner', 'agent'), prospectInviteLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email prospect invalide' });
    // Le message vient du composer riche côté admin (contenteditable) : du
    // HTML, pas du texte brut. Plus de marge (4000) qu'un texte simple car
    // la mise en forme (balises) consomme des caractères ; sanitizeRichMessage()
    // ci-dessous fait le nettoyage de sécurité qui compte réellement.
    const customMsg = sanitizeRichMessage((req.body.message || '').toString().slice(0, 4000));
    const brandId = (req.body.brand_id || '').toString().trim();
    // Cible : marque précise (lien /rejoindre) ou toutes les marques (/demande-acces)
    let brandName = '';
    let link = `${getBaseUrl(req)}/demande-acces`;
    if (brandId && brandId !== 'all') {
      const br = (await pool.query('SELECT id, name FROM brands WHERE id=$1', [brandId])).rows[0];
      if (!br) return res.status(404).json({ error: 'Marque introuvable' });
      if (isBrandScoped(req) && req.userBrandId !== br.id) return res.status(403).json({ error: 'Accès refusé' });
      brandName = br.name;
      // Récupère (ou crée) le lien d'invitation actif de la marque
      let t = (await pool.query('SELECT token, slug FROM brand_invite_links WHERE brand_id=$1 AND active=1 ORDER BY created_at DESC LIMIT 1', [brandId])).rows[0];
      if (!t) {
        const token = crypto.randomBytes(24).toString('hex');
        // DELETE avant de calculer le slug : sinon l'ancienne ligne de CETTE marque
        // (même nom) se compte comme une collision et le slug dérive à chaque
        // régénération (zara → zara-2 → zara-3…) au lieu de rester stable.
        await pool.query('DELETE FROM brand_invite_links WHERE brand_id=$1', [brandId]);
        const slug = await uniqueSlugFor('brand_invite_links', br.name);
        await pool.query('INSERT INTO brand_invite_links (token, brand_id, active, slug) VALUES ($1,$2,1,$3)', [token, brandId, slug]);
        t = { token, slug };
      }
      link = `${getBaseUrl(req)}/rejoindre/${t.slug || t.token}`;
    }
    logAudit(req, 'invite_prospect', 'prospect', email, brandName || 'toutes marques');
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.json({ ok: true, emailed: false, brand: brandName || null });
    const [showroomName, fromAddress, ownerEmail] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from'), getSetting('showroom_email')]);
    const resend = newResendClient(resendKey);
    // Langue explicitement choisie par l'agent dans le sélecteur du formulaire
    // d'invitation — pas de langue enregistrée à défaut ici (contrairement au
    // lien direct/relance), le prospect n'a pas encore de compte.
    const isEn = req.body.lang === 'en';
    const lang = isEn ? 'en' : 'fr';
    // Le prospect n'a pas de langue enregistrée (pas encore de compte) et la
    // page d'atterrissage se base par défaut sur localStorage (donc FR au tout
    // premier clic) — sans ce paramètre, un email envoyé en anglais atterrit
    // sur une page en français. ?lang= est lu en priorité par invite.html et
    // demande-acces.html.
    link += (link.includes('?') ? '&' : '?') + 'lang=' + lang;
    const marqueHtml = brandName
      ? (isEn ? `the <strong>${escHtml(brandName)}</strong> collection` : `la collection <strong>${escHtml(brandName)}</strong>`)
      : (isEn ? 'our curated brands' : 'notre sélection de marques');
    const marqueTxt = brandName || (isEn ? 'our brands' : 'nos marques');
    const buttonHtml = emailBtn(link, isEn ? 'DISCOVER →' : 'DÉCOUVRIR →');
    const tpl = await getEmailTemplate('prospect_invite', lang);
    const subject = applyTemplateVars(tpl.subject, { marque_txt: escHtml(marqueTxt), showroom: escHtml(showroomName || '') });
    // Un message personnalisé (saisi pour cet envoi précis) remplace le corps
    // du modèle éditable — le bouton reste toujours présent pour garantir un
    // lien cliquable, même si l'agent oublie de le mentionner dans son texte.
    // customMsg est déjà du HTML nettoyé (sanitizeRichMessage) avec sa propre
    // structure de paragraphes — ne pas ré-échapper ni ré-envelopper ici.
    const bodyHtml = customMsg
      ? `${customMsg}${buttonHtml}`
      : applyTemplateVars(tpl.body, { marque: marqueHtml, showroom: escHtml(showroomName || ''), bouton: buttonHtml });
    const { error } = await resend.emails.send({
      from: `${showroomName || 'Showroom'} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [email],
      replyTo: ownerEmail || undefined,
      ...(ownerEmail && ownerEmail.toLowerCase() !== email.toLowerCase() ? { bcc: [ownerEmail] } : {}),
      subject,
      html: emailLayout({ showroomName, content:
        `<h2 style="font-size:18px;margin:0 0 16px">${isEn ? 'Discover' : 'Découvrez'} ${brandName ? escHtml(brandName) : (isEn ? 'our showroom' : 'notre showroom')}</h2>
         ${bodyHtml}` })
    });
    // Le SDK Resend résout avec {data:null,error} sur un échec API au lieu de
    // rejeter — sans cette vérification, la réponse affirmait emailed:true
    // même si le prospect n'avait rien reçu.
    if (error) { console.error('[resend] prospect-invite:', error.message || error); return res.json({ ok: true, emailed: false, email, brand: brandName || null }); }
    res.json({ ok: true, emailed: true, email, brand: brandName || null });
  } catch(e) { console.error('prospect invite:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ==================== API ADMIN ====================

// ── Modèles d'email (owner) — texte des emails sortants, éditable sans toucher au code.
app.get('/api/admin/email-templates', requireRole('owner'), async (req, res) => {
  try {
    const rows = (await pool.query('SELECT template_key, lang, subject, body FROM email_templates')).rows;
    const overrides = {};
    rows.forEach(r => {
      overrides[r.template_key] = overrides[r.template_key] || {};
      overrides[r.template_key][r.lang] = { subject: r.subject, body: r.body };
    });
    res.json({ defaults: EMAIL_TEMPLATE_DEFAULTS, overrides, vars: EMAIL_TEMPLATE_VARS });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/admin/email-templates/:key/:lang', requireRole('owner'), async (req, res) => {
  try {
    const { key, lang } = req.params;
    if (!EMAIL_TEMPLATE_DEFAULTS[key] || !EMAIL_TEMPLATE_DEFAULTS[key][lang]) return res.status(404).json({ error: 'Modèle inconnu' });
    const subject = (req.body.subject || '').toString().slice(0, 300);
    const body = (req.body.body || '').toString().slice(0, 10000);
    await pool.query(`
      INSERT INTO email_templates (template_key, lang, subject, body, updated_at) VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (template_key, lang) DO UPDATE SET subject=$3, body=$4, updated_at=NOW()
    `, [key, lang, subject, body]);
    logAudit(req, 'email_template_update', 'email_template', key + '_' + lang, '');
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/admin/email-templates/:key/:lang', requireRole('owner'), async (req, res) => {
  try {
    const { key, lang } = req.params;
    if (!EMAIL_TEMPLATE_DEFAULTS[key] || !EMAIL_TEMPLATE_DEFAULTS[key][lang]) return res.status(404).json({ error: 'Modèle inconnu' });
    await pool.query('DELETE FROM email_templates WHERE template_key=$1 AND lang=$2', [key, lang]);
    logAudit(req, 'email_template_reset', 'email_template', key + '_' + lang, '');
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/settings', requireRole('owner'), async (req, res) => {
  // Les secrets ne doivent jamais faire l'aller-retour vers le navigateur, même
  // vers un owner légitime — admin_password était déjà exclu, smtp_pass ne
  // l'était pas (aucun champ ne l'affiche côté UI, mais l'API le renvoyait
  // quand même s'il avait été défini, ex. via un appel API manuel).
  const r = await pool.query("SELECT key, value FROM settings WHERE key NOT IN ('admin_password', 'smtp_pass')");
  const s = {};
  r.rows.forEach(row => s[row.key] = row.value);
  res.json(s);
});

app.post('/api/settings', requireRole('owner'), async (req, res) => {
  const allowed = ['showroom_name','showroom_email','smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','admin_password','agent_name','agent_title','agent_phone','cgv_text','currencies_json','current_season','login_bg_url','login_bg_url_mobile','showroom_website','showroom_instagram','showroom_facebook','showroom_tiktok','showroom_linkedin','showroom_contact_email'];
  // Liens affichés publiquement dans le footer de tous les emails (jamais
  // javascript:/data: — mêmes contrôles que les liens de marque).
  const urlKeys = ['showroom_website','showroom_instagram','showroom_facebook','showroom_tiktok','showroom_linkedin'];
  let touchedShowroomLinks = false;
  for (let [key, value] of Object.entries(req.body)) {
    if (!allowed.includes(key)) continue;
    if (key === 'admin_password' && value && !value.startsWith('$2')) {
      // Même longueur minimale que partout ailleurs (acheteurs, staff) — ce
      // mot de passe protège le compte le plus privilégié du système, il ne
      // doit pas être le seul à échapper à la règle.
      if (value.length < 12) return res.status(400).json({ error: 'Mot de passe trop court (12 caractères minimum)' });
      value = await bcrypt.hash(value, 10);
    }
    if (urlKeys.includes(key)) value = safeHttpUrl(value);
    if (key === 'showroom_contact_email' && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return res.status(400).json({ error: 'Email de contact invalide' });
    if (urlKeys.includes(key) || key === 'showroom_contact_email') touchedShowroomLinks = true;
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
  }
  if (touchedShowroomLinks) refreshShowroomLinksCache().catch(() => {});
  res.json({ ok: true });
});

// Brands
app.get('/api/brands', requireRole('owner', 'agent', 'designer'), async (req, res) => {
  if (isBrandScoped(req)) {
    const r = await pool.query('SELECT * FROM brands WHERE id=$1 ORDER BY name', [req.userBrandId]);
    return res.json(r.rows);
  }
  const r = await pool.query('SELECT * FROM brands ORDER BY name');
  res.json(r.rows);
});

// Créer une marque = créer un nouveau tenant : action owner uniquement (comme
// PUT/DELETE /api/brands/:id). Un agent est rattaché à UNE marque existante,
// il n'a jamais besoin d'en créer une autre.
app.post('/api/brands', requireRole('owner'), async (req, res) => {
  const { name, logo_url, logo, cover_image, thumbnail, cgv_text, moq_qty, moq_amount, moq_strict, about_text, lookbook_url, website, instagram, facebook, tiktok, linkedin, video_url, invite_bg_url, retail_margin } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nom requis' });
  if (retail_margin !== undefined && retail_margin !== null && retail_margin !== '' && !(Number.isFinite(parseFloat(retail_margin)) && parseFloat(retail_margin) > 0)) return res.status(400).json({ error: 'Marge retail invalide' });
  const id = uuidv4();
  const orderDeadline = /^\d{4}-\d{2}-\d{2}$/.test(req.body.order_deadline || '') ? req.body.order_deadline : null;
  const earlyAccessUntil = /^\d{4}-\d{2}-\d{2}$/.test(req.body.early_access_until || '') ? req.body.early_access_until : null;
  await pool.query('INSERT INTO brands (id,name,logo_url,logo,cover_image,thumbnail,cgv_text,moq_qty,moq_amount,moq_strict,about_text,lookbook_url,delivery_terms,payment_terms,order_deadline,return_terms,website,instagram,facebook,tiktok,linkedin,video_url,early_access_until,invite_bg_url,retail_margin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)',
    [id, name, safeHttpUrl(logo_url), logo||'', cover_image||'', thumbnail||'', cgv_text||'', Math.floor(nonNeg(moq_qty)), nonNeg(moq_amount), moq_strict||false, about_text||'', safeHttpUrl(lookbook_url), (req.body.delivery_terms||'').slice(0,600), (req.body.payment_terms||'').slice(0,600), orderDeadline, (req.body.return_terms||'').slice(0,600), safeHttpUrl(website), safeHttpUrl(instagram), safeHttpUrl(facebook), safeHttpUrl(tiktok), safeHttpUrl(linkedin), video_url||'', earlyAccessUntil, invite_bg_url||'', (retail_margin !== undefined && retail_margin !== null && retail_margin !== '') ? parseFloat(retail_margin) : null]);
  res.json({ id, name });
});

app.put('/api/brands/:id', requireRole('owner'), async (req, res) => {
  try {
    const { name, logo_url, logo, cover_image, thumbnail, cgv_text, moq_qty, moq_amount, moq_strict, about_text, lookbook_url, default_currency, delivery_terms, payment_terms, order_deadline, return_terms, website, instagram, facebook, tiktok, linkedin, video_url, early_access_until, invite_bg_url, retail_margin } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Nom requis' });
    if (retail_margin !== undefined && retail_margin !== null && retail_margin !== '' && !(Number.isFinite(parseFloat(retail_margin)) && parseFloat(retail_margin) > 0)) return res.status(400).json({ error: 'Marge retail invalide' });
    const orderDeadline = /^\d{4}-\d{2}-\d{2}$/.test(order_deadline || '') ? order_deadline : null;
    const earlyAccessUntil = /^\d{4}-\d{2}-\d{2}$/.test(early_access_until || '') ? early_access_until : null;
    await pool.query('UPDATE brands SET name=$1, logo_url=$2, logo=$3, cover_image=$4, thumbnail=$5, cgv_text=$6, moq_qty=$7, moq_amount=$8, about_text=$9, lookbook_url=$10, default_currency=$11, moq_strict=$12, delivery_terms=$13, payment_terms=$14, order_deadline=$15, return_terms=$16, website=$17, instagram=$18, facebook=$19, tiktok=$20, linkedin=$21, video_url=$22, early_access_until=$23, invite_bg_url=$24, retail_margin=$25 WHERE id=$26',
      [name, safeHttpUrl(logo_url), logo||'', cover_image||'', thumbnail||'', cgv_text||'', Math.floor(nonNeg(moq_qty)), nonNeg(moq_amount), about_text||'', safeHttpUrl(lookbook_url), default_currency||null, moq_strict||false, (delivery_terms||'').slice(0,600), (payment_terms||'').slice(0,600), orderDeadline, (return_terms||'').slice(0,600), safeHttpUrl(website), safeHttpUrl(instagram), safeHttpUrl(facebook), safeHttpUrl(tiktok), safeHttpUrl(linkedin), video_url||'', earlyAccessUntil, invite_bg_url||'', (retail_margin !== undefined && retail_margin !== null && retail_margin !== '') ? parseFloat(retail_margin) : null, req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Mise à jour du lookbook seul (scopé marque — accessible owner/agent/designer)
app.put('/api/brands/:brandId/lookbook', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const { lookbook_url } = req.body;
    await pool.query('UPDATE brands SET lookbook_url=$1 WHERE id=$2', [safeHttpUrl(lookbook_url), req.params.brandId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/brands/:id', requireRole('owner'), async (req, res) => {
  try {
    // orders.brand_id n'a pas de ON DELETE CASCADE (les commandes sont des pièces
    // comptables à conserver) : une marque ayant reçu ne serait-ce qu'une commande
    // fait échouer le DELETE en bloc (rollback atomique, rien n'est supprimé) avec
    // une 500 opaque. Message clair + suggestion de désactivation à la place.
    const used = await pool.query('SELECT 1 FROM orders WHERE brand_id=$1 LIMIT 1', [req.params.id]);
    if (used.rows.length) {
      return res.status(409).json({ error: 'Cette marque a des commandes enregistrées : elle ne peut pas être supprimée. Désactivez-la (statut abonnement) pour la masquer.', used: true });
    }
    await pool.query('DELETE FROM brands WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Réutilise un lien de commande actif et non expiré pour la marque, ou en crée
// un nouveau (90j) — utilisé pour que les QR codes imprimés restent valides
// après le verrouillage de /commande/:brandId (accès désormais requis via
// session staff ou token, plus d'accès direct par simple UUID de marque).
async function getOrCreateCommandeLink(brandId, createdBy) {
  const existing = await pool.query(
    "SELECT token, slug FROM commande_links WHERE brand_id=$1 AND active=1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
    [brandId]
  );
  if (existing.rows[0]) return existing.rows[0].slug || existing.rows[0].token;
  const token = crypto.randomBytes(18).toString('base64url');
  const brandName = (await pool.query('SELECT name FROM brands WHERE id=$1', [brandId])).rows[0]?.name || '';
  const slug = await uniqueSlugFor('commande_links', brandName);
  await pool.query(
    "INSERT INTO commande_links (token, brand_id, expires_at, created_by, slug) VALUES ($1,$2,NOW() + INTERVAL '90 days',$3,$4)",
    [token, brandId, createdBy || 'qrcode', slug]
  );
  return slug;
}

// QR codes réservés à l'agence (owner/agent) : la distribution/diffusion ne
// passe pas par les marques, qui ne doivent pas pouvoir court-circuiter l'agence.
app.get('/api/brands/:id/qrcode', requireBrandScope('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT * FROM brands WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const token = await getOrCreateCommandeLink(req.params.id, req.session?.staffUser?.email);
  const url = `${getBaseUrl(req)}/c/${token}`;
  const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  res.json({ qr, url });
});

// QR d'accès de TOUTES les marques (pour impression sur une feuille A4)
app.get('/api/brands-qrcodes', requireRole('owner','agent'), async (req, res) => {
  try {
    const r = isBrandScoped(req)
      ? await pool.query("SELECT id, name, logo, logo_url FROM brands WHERE id=$1 AND (subscription_status IS NULL OR subscription_status != 'inactive') ORDER BY name", [req.userBrandId])
      : await pool.query("SELECT id, name, logo, logo_url FROM brands WHERE subscription_status IS NULL OR subscription_status != 'inactive' ORDER BY name");
    const base = getBaseUrl(req);
    const createdBy = req.session?.staffUser?.email;
    const items = await Promise.all(r.rows.map(async b => {
      const token = await getOrCreateCommandeLink(b.id, createdBy);
      const url = `${base}/c/${token}`;
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

app.get('/api/brands/:brandId/products/:productId/qrcode', requireBrandScope('owner','agent'), async (req, res) => {
  const { brandId, productId } = req.params;
  const r = await pool.query('SELECT * FROM products WHERE id=$1 AND brand_id=$2', [productId, brandId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  const token = await getOrCreateCommandeLink(brandId, req.session?.staffUser?.email);
  const url = `${getBaseUrl(req)}/c/${token}?product=${productId}`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.json({ qr, url, reference: r.rows[0].reference, description: r.rows[0].description });
});

app.get('/api/brands/:brandId/qrcodes-all', requireBrandScope('owner','agent'), async (req, res) => {
  const b = await pool.query('SELECT * FROM brands WHERE id=$1', [req.params.brandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const prods = await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active != 0 ORDER BY reference', [req.params.brandId]);
  const base = getBaseUrl(req);
  const token = await getOrCreateCommandeLink(req.params.brandId, req.session?.staffUser?.email);
  const items = await Promise.all(prods.rows.map(async p => {
    const url = `${base}/c/${token}?product=${p.id}`;
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

// ── Marques suivies & notifications "nouvelle collection" ──────────────────
// isNewCollection() est vérifié AVANT l'insertion pour savoir si cette
// collection existait déjà chez la marque ; notifyBrandFollowers() prévient
// ensuite chaque acheteur qui suit la marque (cloche du portail + email),
// une seule fois par collection réellement nouvelle (pas par produit).
async function isNewCollection(brandId, collectionName) {
  if (!collectionName) return false;
  const r = await pool.query('SELECT 1 FROM products WHERE brand_id=$1 AND collection_name=$2 LIMIT 1', [brandId, collectionName]);
  return r.rows.length === 0;
}
async function notifyBrandFollowers(req, brandId, collectionName) {
  try {
    const followers = await pool.query(
      `SELECT bf.buyer_id, b.email, b.name FROM brand_follows bf
       JOIN buyers b ON b.id = bf.buyer_id WHERE bf.brand_id = $1`,
      [brandId]
    );
    if (!followers.rows.length) return;
    const brandRes = await pool.query('SELECT name FROM brands WHERE id=$1', [brandId]);
    const brandName = brandRes.rows[0]?.name || '';
    const title = `${brandName} a publié une nouvelle collection`;
    const body = collectionName ? `Découvrez « ${collectionName} », disponible dès maintenant.` : 'De nouvelles pièces sont disponibles dès maintenant.';
    for (const f of followers.rows) {
      pool.query(
        'INSERT INTO buyer_notifications (id, buyer_id, brand_id, type, title, body) VALUES ($1,$2,$3,$4,$5,$6)',
        [uuidv4(), f.buyer_id, brandId, 'new_collection', title, body]
      ).catch(e => console.error('[notif-insert]', e.message));
    }
    sendNewCollectionEmails(req, followers.rows, brandName, collectionName).catch(e => console.error('[notify-followers-email]', e.message));
  } catch(e) { console.error('[notify-followers]', e.message); }
}
async function sendNewCollectionEmails(req, followerRows, brandName, collectionName) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const [showroomName, fromAddress] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from')]);
  const from = fromAddress || 'showroom@editionsstandard.com';
  const resend = newResendClient(resendKey);
  const link = `${getBaseUrl(req)}/portal`;
  const subject = `${brandName} — nouvelle collection disponible`;
  for (const f of followerRows) {
    if (!f.email) continue;
    const content = `
      <p>Bonjour <strong>${escHtml(f.name || '')}</strong>,</p>
      <p><strong>${escHtml(brandName)}</strong>, une marque que vous suivez, vient de publier de nouvelles pièces${collectionName ? ` — <strong>${escHtml(collectionName)}</strong>` : ''}.</p>
      <p style="margin-top:22px"><a href="${escHtml(link)}" style="display:inline-block;background:#CCEB3C;color:#111;padding:10px 20px;text-decoration:none;font-weight:700;font-size:12px;letter-spacing:.04em">Voir la collection</a></p>
    `;
    const { error } = await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [f.email],
      subject,
      html: emailLayout({ showroomName, brandName, content })
    }).catch(e => ({ error: e }));
    if (error) console.error('[resend] new-collection:', error.message || error);
  }
}
// Un import CSV peut introduire un grand nombre de collection_name distinctes
// en un seul appel (fichier mal formé, ou volontairement pour spammer les
// abonnés d'une marque) ; chacune déclenche un envoi d'email à tous les
// followers. On plafonne le nombre de collections notifiées par import — un
// import légitime n'en introduit jamais plus qu'une poignée à la fois.
const MAX_NEW_COLLECTION_NOTIFICATIONS_PER_IMPORT = 5;
// Chaque ligne d'un import CSV/JSON déclenche 1-2 aller-retours DB séquentiels
// (SELECT + INSERT/UPDATE), sans traitement par lots ni timeout dédié — un
// fichier de plusieurs dizaines de milliers de lignes peut monopoliser le pool
// de connexions plusieurs minutes malgré une taille de fichier modeste.
const MAX_CSV_IMPORT_ROWS = 5000;
function notifyNewCollections(req, brandId, newlySeenCollections) {
  const collections = [...newlySeenCollections];
  if (collections.length > MAX_NEW_COLLECTION_NOTIFICATIONS_PER_IMPORT) {
    console.error(`[notify] ${collections.length} nouvelles collections en un import pour la marque ${brandId} — notification limitée aux ${MAX_NEW_COLLECTION_NOTIFICATIONS_PER_IMPORT} premières`);
  }
  for (const coll of collections.slice(0, MAX_NEW_COLLECTION_NOTIFICATIONS_PER_IMPORT)) {
    notifyBrandFollowers(req, brandId, coll).catch(e => console.error('[notify]', e.message));
  }
}

app.post('/api/brands/:brandId/products', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { reference, description, color, sizes, price, price_retail, image_url, collection_name, category, composition, images, variants, season_id, video_url, featured } = req.body;
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
    if (video_url !== undefined) { fields.push(`video_url=$${vals.push(video_url)}`); } // permet aussi de vider
    if (featured !== undefined) { fields.push(`featured=$${vals.push(!!featured)}`); }
    if (fields.length) { vals.push(eid); await pool.query(`UPDATE products SET ${fields.join(',')} WHERE id=$${vals.length}`, vals); }
    return res.json({ id: eid, updated: true });
  }
  const isNewColl = await isNewCollection(req.params.brandId, collection_name);
  const id = uuidv4();
  await pool.query(
    'INSERT INTO products (id,brand_id,reference,description,color,sizes,price,price_retail,image_url,collection_name,category,composition,images,variants,season_id,video_url,featured) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
    [id, req.params.brandId, reference, description||'', color||'', sizes||'', nonNeg(price), nonNeg(price_retail), image_url||'', collection_name||'', category||'', composition||'', JSON.stringify(images||[]), JSON.stringify(variants||[]), season_id||null, video_url||'', !!featured]
  );
  if (isNewColl) notifyBrandFollowers(req, req.params.brandId, collection_name).catch(e => console.error('[notify]', e.message));
  res.json({ id });
});

// Référence « échantillon » express : crée un produit léger (réf + photo + prix)
// à rattacher à une sélection quand une pièce n'est pas au catalogue (sample photographié
// par l'acheteur). Masqué du catalogue public (active=0) et marqué is_sample : il reste
// résolu par product_id sur la line sheet / le PDF / la commande, sans polluer le portail.
// L'image accepte une URL http(s) ou une photo en data: (upload direct depuis le mobile).
app.post('/api/brands/:brandId/sample-product', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const { reference, description, color, price, image } = req.body;
    if (!reference || !String(reference).trim()) return res.status(400).json({ error: 'Référence requise' });
    const ref = String(reference).trim().slice(0, 120);
    // data:image/svg+xml exclu comme partout ailleurs (ALLOWED_IMAGE_MIMES) — un
    // SVG peut embarquer du <script>/<foreignObject> exécuté si le champ est un
    // jour affiché autrement qu'en <img src>.
    const img = (typeof image === 'string' && /^(https?:|data:image\/)/i.test(image.trim()) && !/^data:image\/svg/i.test(image.trim())) ? image.trim() : '';
    // Réutilise une référence existante de la marque (évite les doublons)
    const existing = await pool.query('SELECT id FROM products WHERE brand_id=$1 AND reference=$2', [req.params.brandId, ref]);
    if (existing.rows[0]) return res.json({ id: existing.rows[0].id, reference: ref, existing: true });
    const id = uuidv4();
    await pool.query(
      'INSERT INTO products (id,brand_id,reference,description,color,sizes,price,image_url,images,collection_name,active,is_sample) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [id, req.params.brandId, ref, (description||'').slice(0,300), (color||'').slice(0,80), '', nonNeg(price), img, JSON.stringify(img ? [img] : []), 'Échantillons', 0, true]
    );
    logAudit(req, 'create_sample', 'product', id, ref);
    res.json({ id, reference: ref, price: nonNeg(price), image_url: img });
  } catch(e) { console.error('sample-product:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// True when the current role is restricted to a single brand (designer, or agent with brand_id).
function isBrandScoped(req) {
  return req.userRole === 'designer' || (req.userRole === 'agent' && !!req.userBrandId);
}

async function checkProductBrandScope(req, res) {
  if (!isBrandScoped(req)) return true;
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
    const { reference, description, color, sizes, price, price_retail, image_url, active, collection_name, category, composition, images, variants, season_id, video_url, featured } = req.body;
    if (!reference || typeof reference !== 'string' || !reference.trim()) return res.status(400).json({ error: 'Référence requise' });
    if (price !== undefined && !Number.isFinite(parseFloat(price))) return res.status(400).json({ error: 'Prix invalide' });
    if (price_retail !== undefined && !Number.isFinite(parseFloat(price_retail))) return res.status(400).json({ error: 'Prix retail invalide' });
    if (images !== undefined && !Array.isArray(images)) return res.status(400).json({ error: 'images doit être un tableau' });
    if (variants !== undefined && !Array.isArray(variants)) return res.status(400).json({ error: 'variants doit être un tableau' });
    // Même contrainte implicite que l'upsert POST (brand_id+reference) : deux
    // produits de la même marque partageant une référence rendent les futurs
    // upserts CSV / le matching bulk-photos ambigus (mise à jour du mauvais produit).
    const brandRow = await pool.query('SELECT brand_id FROM products WHERE id=$1', [req.params.id]);
    const dup = await pool.query('SELECT id FROM products WHERE brand_id=$1 AND reference=$2 AND id<>$3', [brandRow.rows[0].brand_id, reference.trim(), req.params.id]);
    if (dup.rows[0]) return res.status(409).json({ error: 'Cette référence est déjà utilisée par un autre produit de cette marque' });
    await pool.query(
      'UPDATE products SET reference=$1,description=$2,color=$3,sizes=$4,price=$5,price_retail=$6,image_url=$7,active=$8,collection_name=$9,category=$10,composition=$11,images=$12,variants=$13,season_id=$14,video_url=$15,featured=$16 WHERE id=$17',
      [reference, description||'', color||'', sizes||'', nonNeg(price), nonNeg(price_retail), image_url||'', active!==undefined?active:1, collection_name||'', category||'', composition||'', JSON.stringify(images||[]), JSON.stringify(variants||[]), season_id||null, video_url||'', !!featured, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.patch('/api/products/:id/prices', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    if (!await checkProductBrandScope(req, res)) return;
    const fields = [];
    const vals = [];
    if (req.body.price !== undefined)        { fields.push(`price=$${vals.push(nonNeg(req.body.price))}`); }
    if (req.body.price_retail !== undefined) { fields.push(`price_retail=$${vals.push(nonNeg(req.body.price_retail))}`); }
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

// Drag & drop product reorder
app.post('/api/brands/:brandId/products/reorder', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const { productId, beforeProductId } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId requis' });
    // Try to update sort_order if the column exists; silently ignore if not
    if (beforeProductId) {
      const target = await pool.query('SELECT sort_order, created_at FROM products WHERE id=$1 AND brand_id=$2', [beforeProductId, req.params.brandId]).catch(() => ({ rows: [] }));
      if (target.rows[0]) {
        const refOrder = target.rows[0].sort_order;
        if (refOrder !== null && refOrder !== undefined) {
          // brand_id=$3 obligatoire — sans ce filtre, un agent/designer borné à sa
          // marque pourrait modifier le sort_order d'un produit d'une autre marque
          // en fournissant son id directement (hors UI, la cible n'était jamais
          // revérifiée, contrairement à beforeProductId juste au-dessus).
          await pool.query('UPDATE products SET sort_order=$1 WHERE id=$2 AND brand_id=$3', [refOrder - 1, productId, req.params.brandId]).catch(e => console.error('[sort-order-error]', e.message));
        }
      }
    }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Même contrainte FK que DELETE /api/products/:id (order_lines.product_id) :
// un seul produit référencé par une commande fait échouer TOUT le DELETE en
// masse (rollback atomique) avec une 500 opaque, sans rien supprimer, même
// les produits légitimement supprimables. Même remède que collection-bulk
// ci-dessous : désactiver les produits référencés, supprimer le reste.
async function deleteOrDeactivateProducts(whereClause, params) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const deact = await dbClient.query(
      `UPDATE products SET active=0 WHERE ${whereClause} AND EXISTS (SELECT 1 FROM order_lines ol WHERE ol.product_id = products.id)`,
      params
    );
    const del = await dbClient.query(
      `DELETE FROM products WHERE ${whereClause} AND NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.product_id = products.id)`,
      params
    );
    await dbClient.query('COMMIT');
    return { deleted: del.rowCount, deactivated: deact.rowCount };
  } catch(e) {
    await dbClient.query('ROLLBACK');
    throw e;
  } finally {
    dbClient.release();
  }
}

// bulk MUST be declared before the catch-all /:brandId/products route
app.delete('/api/brands/:brandId/products/bulk', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'IDs requis' });
    const r = await deleteOrDeactivateProducts('id = ANY($1) AND brand_id=$2', [ids, req.params.brandId]);
    res.json({ ok: true, ...r });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/brands/:brandId/products', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const r = await deleteOrDeactivateProducts('brand_id=$1', [req.params.brandId]);
    res.json({ ok: true, ...r });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
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
      // Supprime les produits sans commande, désactive ceux référencés par des commandes (FK).
      // Deux requêtes ensemblistes atomiques (au lieu de 2N+1 requêtes en boucle).
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        const deact = await dbClient.query(
          `UPDATE products SET active=0
           WHERE brand_id=$1 AND collection_name=$2
             AND EXISTS (SELECT 1 FROM order_lines ol WHERE ol.product_id = products.id)`,
          [brandId, collection]
        );
        const del = await dbClient.query(
          `DELETE FROM products
           WHERE brand_id=$1 AND collection_name=$2
             AND NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.product_id = products.id)`,
          [brandId, collection]
        );
        await dbClient.query('COMMIT');
        return res.json({ ok: true, deleted: del.rowCount, deactivated: deact.rowCount });
      } catch(e) {
        await dbClient.query('ROLLBACK');
        throw e;
      } finally {
        dbClient.release();
      }
    }
    return res.status(400).json({ error: 'Action invalide' });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── Import CSV produits ──────────────────────────────────────────────
const uploadCsv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function parseCSVRow(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  fields.push(cur);
  return fields;
}

// Accepte le séparateur décimal virgule (format tableur français : "12,50",
// "1.234,56") en plus du point — parseFloat('0,50') renverrait sinon 0 et
// ferait passer un article importé en gratuit sans aucune erreur remontée.
// Échappe les métacaractères LIKE/ILIKE (% et _, backslash = caractère d'échappement
// par défaut de Postgres) avant interpolation dans un motif `%...%` construit
// côté serveur — sans ça, une recherche littérale contenant un % (ex. "50%")
// ou un _ (ex. une référence "SKU_1") se comporte comme un joker et remonte
// des résultats sans rapport avec la requête de l'utilisateur.
function escapeLike(s) {
  return String(s == null ? '' : s).replace(/[\\%_]/g, m => '\\' + m);
}
function parsePrice(v) {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  // Retire tout ce qui n'est pas chiffre/virgule/point/signe moins (symbole
  // monétaire "€ "/"$"/espace insécable...) avant de parser — un prix formaté
  // "€ 32,00" (courant dans les exports linesheet de marque) fait échouer
  // parseFloat silencieusement (il s'arrête au premier caractère non
  // numérique), donnant 0 sans aucune erreur visible.
  s = s.replace(/[^0-9,.\-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

app.post('/api/brands/:brandId/products/import-csv', requireBrandScope('owner','agent'), uploadLimiter, uploadCsv.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier CSV requis' });
    const brandId = req.params.brandId;
    const text = req.file.buffer.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'Fichier vide ou sans données' });
    // Plafond de lignes : chaque ligne déclenche 1-2 aller-retours DB séquentiels
    // (SELECT + INSERT/UPDATE) dans la même requête HTTP, sans traitement par
    // lots ni timeout dédié — un fichier de plusieurs dizaines de milliers de
    // lignes (pourtant sous la limite de taille de 5 Mo si les lignes sont
    // courtes) peut monopoliser le pool de connexions plusieurs minutes.
    if (lines.length - 1 > MAX_CSV_IMPORT_ROWS) return res.status(400).json({ error: `Fichier trop volumineux (${lines.length - 1} lignes, maximum ${MAX_CSV_IMPORT_ROWS}). Scindez-le en plusieurs imports.` });
    // Expected header: reference,description,color,sizes,price,price_retail,collection,composition,category
    const header = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());
    const idx = (col) => header.indexOf(col);
    let imported = 0, skipped = 0;
    const existingCollections = new Set((await pool.query(
      "SELECT DISTINCT collection_name FROM products WHERE brand_id=$1 AND collection_name IS NOT NULL AND collection_name != ''",
      [brandId]
    )).rows.map(r => r.collection_name));
    const newlySeenCollections = new Set();
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVRow(lines[i]);
      const get = (col) => (row[idx(col)] || '').trim();
      const reference = get('reference');
      if (!reference) { skipped++; continue; }
      const description = get('description');
      const color = get('color');
      const sizes = get('sizes');
      const price = parsePrice(get('price'));
      const price_retail = parsePrice(get('price_retail'));
      const collection_name = get('collection');
      const composition = get('composition');
      const category = get('category');
      const existing = await pool.query('SELECT id FROM products WHERE brand_id=$1 AND reference=$2', [brandId, reference]);
      if (existing.rows[0]) {
        await pool.query(
          'UPDATE products SET description=$1,color=$2,sizes=$3,price=$4,price_retail=$5,collection_name=$6,composition=$7,category=$8 WHERE id=$9',
          [description, color, sizes, price, price_retail, collection_name, composition, category, existing.rows[0].id]
        );
      } else {
        await pool.query(
          'INSERT INTO products (id,brand_id,reference,description,color,sizes,price,price_retail,collection_name,composition,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [uuidv4(), brandId, reference, description, color, sizes, price, price_retail, collection_name, composition, category]
        );
        if (collection_name && !existingCollections.has(collection_name)) newlySeenCollections.add(collection_name);
      }
      imported++;
    }
    notifyNewCollections(req, brandId, newlySeenCollections);
    res.json({ imported, skipped });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── Import CSV produits (JSON rows) ─────────────────────────────────
app.post('/api/brands/:brandId/import-csv', requireBrandScope('owner', 'agent', 'designer'), uploadLimiter, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Aucune ligne' });
    if (rows.length > MAX_CSV_IMPORT_ROWS) return res.status(400).json({ error: `Trop de lignes (${rows.length}, maximum ${MAX_CSV_IMPORT_ROWS}). Scindez l'import.` });
    let created = 0, updated = 0;
    const errors = [];
    const existingCollections = new Set((await pool.query(
      "SELECT DISTINCT collection_name FROM products WHERE brand_id=$1 AND collection_name IS NOT NULL AND collection_name != ''",
      [req.params.brandId]
    )).rows.map(r => r.collection_name));
    const newlySeenCollections = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object') { errors.push('Ligne invalide ignorée'); continue; }
      const ref = (row.reference || row.Reference || row.ref || '').trim();
      if (!ref) { errors.push('Ligne sans référence ignorée'); continue; }
      try {
        const existing = await pool.query('SELECT id FROM products WHERE brand_id=$1 AND reference=$2', [req.params.brandId, ref]);
        const fields = {
          description: row.description || row.Description || '',
          color: row.color || row.Color || row.couleur || '',
          sizes: row.sizes || row.tailles || row.Sizes || '',
          price: parsePrice(row.price || row.prix || row.Price || 0),
          price_retail: parsePrice(row.price_retail || row.prix_retail || 0),
          collection_name: row.collection_name || row.collection || row.Collection || '',
          composition: row.composition || row.Composition || '',
          category: row.category || row.categorie || row.Category || '',
        };
        if (existing.rows[0]) {
          // Une ligne partielle (ex. fichier "reference,price" seul, ou cellules
          // vides pour certaines colonnes) ne doit JAMAIS effacer un champ déjà
          // renseigné — seuls les champs réellement présents dans la ligne sont
          // écrasés, comme le fait déjà l'upsert produit unique ci-dessus.
          const sets = [], vals = [];
          const set = (col, val) => { if (val !== '' && val !== undefined && val !== null) { sets.push(`${col}=$${vals.push(val)}`); } };
          set('description', fields.description); set('color', fields.color); set('sizes', fields.sizes);
          if (fields.price > 0) set('price', fields.price);
          if (fields.price_retail > 0) set('price_retail', fields.price_retail);
          set('collection_name', fields.collection_name); set('composition', fields.composition); set('category', fields.category);
          if (sets.length) { vals.push(existing.rows[0].id); await pool.query(`UPDATE products SET ${sets.join(',')} WHERE id=$${vals.length}`, vals); }
          updated++;
        } else {
          const id = uuidv4();
          await pool.query(`INSERT INTO products (id,brand_id,reference,description,color,sizes,price,price_retail,collection_name,composition,category,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
            [id, req.params.brandId, ref, fields.description, fields.color, fields.sizes, fields.price, fields.price_retail, fields.collection_name, fields.composition, fields.category]);
          if (fields.collection_name && !existingCollections.has(fields.collection_name)) newlySeenCollections.add(fields.collection_name);
          created++;
        }
      } catch(e) { errors.push(`${ref}: ${e.message}`); }
    }
    notifyNewCollections(req, req.params.brandId, newlySeenCollections);
    res.json({ created, updated, errors });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── Fusion intelligente (par désignation+couleur) ──────────────────────
// Pour les fichiers marque dont la colonne "reference" est inutilisable
// (ex. identique sur toutes les lignes) : au lieu d'upserter par référence
// (risque d'écraser tout le catalogue sur une seule ligne), on retrouve le
// produit existant par désignation+couleur normalisées et on ne touche QUE
// les champs susceptibles d'avoir changé (prix, tailles, composition,
// catégorie) — la référence existante n'est jamais modifiée. Rien n'est
// jamais créé automatiquement : une ligne sans correspondance est juste
// listée pour décision manuelle.
const normMergeKey = s => (s || '').toString().trim().toUpperCase().replace(/\s+/g, ' ');
app.post('/api/brands/:brandId/smart-merge/preview', requireBrandScope('owner', 'agent', 'designer'), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Aucune ligne' });
    if (rows.length > MAX_CSV_IMPORT_ROWS) return res.status(400).json({ error: `Trop de lignes (${rows.length}, maximum ${MAX_CSV_IMPORT_ROWS}). Scindez l'import.` });
    const prods = await pool.query(
      'SELECT id, reference, description, color, price, price_retail, sizes, composition, category FROM products WHERE brand_id=$1',
      [req.params.brandId]
    );
    const index = new Map();
    for (const p of prods.rows) {
      const key = normMergeKey(p.description) + '|' + normMergeKey(p.color);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(p);
    }
    const matched = [], unmatched = [], ambiguous = [];
    const seenInFile = new Map();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const description = (row.description || row.Description || '').trim();
      const color = (row.color || row.Color || row.couleur || '').trim();
      const key = normMergeKey(description) + '|' + normMergeKey(color);
      if (seenInFile.has(key)) {
        const entry = seenInFile.get(key);
        entry.duplicateInFile = (entry.duplicateInFile || 1) + 1;
        continue;
      }
      const candidates = index.get(key);
      if (!candidates) { unmatched.push({ description, color }); continue; }
      if (candidates.length > 1) { ambiguous.push({ description, color, count: candidates.length }); continue; }
      const p = candidates[0];
      const newFields = {
        price: parsePrice(row.price || row.prix || 0),
        price_retail: parsePrice(row.price_retail || row.prix_retail || 0),
        sizes: (row.sizes || row.tailles || '').trim(),
        composition: (row.composition || '').trim(),
        category: (row.category || row.categorie || '').trim(),
      };
      const changes = {};
      for (const f of Object.keys(newFields)) {
        const newVal = newFields[f];
        if (newVal === '' || newVal === 0) continue; // ligne source vide : on ne remplace jamais par du vide
        const oldVal = p[f];
        const isNumeric = f === 'price' || f === 'price_retail';
        const same = isNumeric ? Math.abs(parseFloat(oldVal) - newVal) < 0.005 : (oldVal || '').toString().trim() === newVal;
        if (!same) changes[f] = { old: oldVal, new: newVal };
      }
      const entry = { productId: p.id, reference: p.reference, description: p.description, color: p.color, changes };
      seenInFile.set(key, entry);
      matched.push(entry);
    }
    res.json({ matched, unmatched, ambiguous, totalRows: rows.length });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/brands/:brandId/smart-merge/apply', requireBrandScope('owner', 'agent', 'designer'), async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'Aucune mise à jour' });
    let applied = 0;
    for (const u of updates) {
      if (!u || !u.productId || !u.changes || typeof u.changes !== 'object') continue;
      // Ne met à jour QUE les champs listés dans changes, jamais reference/description/color/brand_id.
      const allowed = ['price', 'price_retail', 'sizes', 'composition', 'category'];
      const sets = [], vals = [];
      for (const f of allowed) {
        if (u.changes[f] !== undefined) { sets.push(`${f}=$${sets.length + 1}`); vals.push(u.changes[f].new !== undefined ? u.changes[f].new : u.changes[f]); }
      }
      if (!sets.length) continue;
      vals.push(u.productId, req.params.brandId);
      const r = await pool.query(
        `UPDATE products SET ${sets.join(',')} WHERE id=$${vals.length - 1} AND brand_id=$${vals.length}`,
        vals
      );
      if (r.rowCount) applied++;
    }
    logAudit(req, 'smart_merge_apply', 'brand', req.params.brandId, `${applied} produits mis à jour`);
    res.json({ ok: true, applied });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── Export CSV produits ──────────────────────────────────────────────
app.get('/api/brands/:brandId/products/export-csv', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    logAudit(req, 'export_products_csv', 'brand', req.params.brandId, '');
    const r = await pool.query(
      'SELECT reference, description, color, sizes, price, price_retail, collection_name, composition, category FROM products WHERE brand_id=$1 ORDER BY reference',
      [req.params.brandId]
    );
    const headers = ['reference','description','color','sizes','price','price_retail','collection','composition','category'];
    const rows = r.rows.map(p => [
      p.reference, p.description, p.color, p.sizes,
      p.price, p.price_retail, p.collection_name, p.composition, p.category
    ]);
    const csv = [headers, ...rows].map(row => row.map(v => `"${csvSafe(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="produits-${req.params.brandId.slice(0,8)}.csv"`);
    res.send('﻿' + csv);
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

// Bascule rapide "mise en avant" depuis la liste produits (icône ★), sans
// passer par le formulaire complet — même logique que le PATCH stock ci-dessous.
app.patch('/api/products/:id/featured', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    if (!await checkProductBrandScope(req, res)) return;
    await pool.query('UPDATE products SET featured=$1 WHERE id=$2', [!!req.body.featured, req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.patch('/api/products/:id/stock', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkProductBrandScope(req, res)) return;
    const { stock_qty, stock_enabled } = req.body;
    // Stock : entier >= 0, ou null si non renseigné (jamais de stock négatif)
    const sq = (stock_qty === null || stock_qty === undefined || stock_qty === '')
      ? null : Math.max(0, Math.floor(Number(stock_qty) || 0));
    await pool.query(
      'UPDATE products SET stock_qty=$1, stock_enabled=$2 WHERE id=$3',
      [sq, stock_enabled ?? false, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Formats raster uniquement — exclut délibérément image/svg+xml : un SVG peut
// embarquer du <script>/<foreignObject> exécuté si le fichier est ouvert
// directement dans un onglet (le champ mimetype matcherait `startsWith('image/')`).
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// req.file.mimetype vient du Content-Type déclaré par le CLIENT sur la partie
// multipart — falsifiable (ex. `curl -F "image=@payload.html;type=image/jpeg"`),
// contrairement à /api/upload-pdf qui vérifie déjà la signature binaire réelle
// (%PDF). Même contrôle ici sur les octets magiques des 4 formats autorisés,
// pour ne jamais faire confiance qu'à une étiquette déclarative.
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true; // JPEG
  if (buf.slice(0,4).toString('latin1') === 'GIF8') return true; // GIF
  if (buf.slice(0,4).toString('latin1') === 'RIFF' && buf.slice(8,12).toString('latin1') === 'WEBP') return true; // WebP
  return false;
}
app.post('/api/upload-image', requireRole('owner','agent','designer'), uploadLimiter, upload.single('image'), async (req, res) => {
  if (!req.file || !ALLOWED_IMAGE_MIMES.includes(req.file.mimetype) || !looksLikeImage(req.file.buffer)) return res.status(400).json({ error: 'Fichier image requis (jpg, png, webp, gif)' });
  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    // Aléatoire (pas Date.now()) : les URLs Cloudinary sont servies publiquement
    // sans authentification — un identifiant basé sur l'horodatage ne se devine
    // qu'à quelques centaines de valeurs près si le moment d'upload est connu/
    // estimable (ex. date de création d'une marque, visible publiquement).
    const slug = `img-${crypto.randomBytes(16).toString('hex')}`;
    // ?size=large : fonds plein écran (image de connexion) — limite élargie à 1920px
    const max = req.query.size === 'large' ? 1920 : 1200;
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'showroom/uploads',
      public_id: slug,
      // strip_profile : retire les métadonnées EXIF/IPTC (géoloc, appareil…) de l'image livrée.
      transformation: [{ width: max, height: max, crop: 'limit', quality: 80, fetch_format: 'auto', flags: 'strip_profile' }]
    });
    res.json({ url: result.secure_url });
  } catch(e) {
    // Les utilisateurs de cette route sont internes (owner/agent/designer) : on remonte
    // le motif réel (ex. « Invalid api_key », « disabled account ») pour diagnostic.
    console.error('[upload-image] Cloudinary:', e.message);
    res.status(502).json({ error: "Échec de l'envoi de l'image", detail: e.message || String(e) });
  }
});

// Diagnostic Cloudinary (owner) : indique si les variables d'env sont présentes et
// tente un mini upload de test (PNG 1×1) pour révéler l'erreur exacte côté navigateur,
// sans jamais exposer les secrets eux-mêmes.
app.get('/api/admin/cloudinary-check', requireRole('owner'), async (req, res) => {
  const cfg = {
    cloud_name: !!process.env.CLOUDINARY_CLOUD_NAME,
    api_key: !!process.env.CLOUDINARY_API_KEY,
    api_secret: !!process.env.CLOUDINARY_API_SECRET,
    cloud_name_value: process.env.CLOUDINARY_CLOUD_NAME || null // le cloud_name n'est pas secret (visible dans chaque URL)
  };
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  try {
    const r = await cloudinary.uploader.upload(tinyPng, { folder: 'showroom/_diag', public_id: 'cloudinary-check', overwrite: true });
    res.json({ configured: cfg, test: { ok: true, secure_url: r.secure_url } });
  } catch(e) {
    res.json({ configured: cfg, test: { ok: false, error: e.message || String(e), http_code: e.http_code || null } });
  }
});

// Diagnostic synchro Airtable (owner) : vérifie la clé + l'accès à la table STORES
// + l'existence des champs mappés (lecture 1 enregistrement, non destructif).
app.get('/api/admin/airtable-check', requireRole('owner'), async (req, res) => {
  const configured = !!process.env.AIRTABLE_API_KEY;
  if (!configured) return res.json({ configured: false });
  const base = 'appquOEohNkpH6sbB';
  const fields = ['fldbGIrhVTpvBBnZk','fldiiGOlzIQNvdGTh','fldbnSDcnI2mb9qjj','fldNdh83yBoZONLhP','fldoXxM2cxB8pRWSj'];
  const url = `https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm?maxRecords=1&` + fields.map(f => 'fields%5B%5D=' + f).join('&');
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_API_KEY }, signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return res.json({ configured: true, ok: true, sample: (d.records || []).length });
    return res.json({ configured: true, ok: false, status: r.status, error: (d.error && (d.error.message || d.error.type)) || ('HTTP ' + r.status) });
  } catch(e) { res.json({ configured: true, ok: false, error: e.message || String(e) }); }
});

// Diagnostic traduction (owner) : teste EN DIRECT chaque langue avec une phrase
// témoin et remonte l'erreur exacte par langue (clé manquante, HTTP, JSON…).
// Contourne le cache pour révéler la vraie cause quand « ça ne traduit pas ».
app.get('/api/admin/translate-check', requireRole('owner'), async (req, res) => {
  const configured = !!process.env.ANTHROPIC_API_KEY;
  let cacheRows = null;
  try { const c = await pool.query('SELECT COUNT(*)::int n FROM content_translations'); cacheRows = c.rows[0].n; } catch(_) {}
  if (!configured) return res.json({ configured: false, cache_rows: cacheRows });
  const sample = 'Nouvelle collection printemps, coupe ajustée en laine.';
  const langs = Object.keys(TRANSLATE_LANGS);
  const results = {};
  await Promise.all(langs.map(async (lang) => {
    try {
      const tr = await claudeTranslate([sample], TRANSLATE_LANGS[lang]);
      const val = tr && tr[0];
      results[lang] = { ok: !!(val && String(val).trim() && val !== sample), sample: val || null };
    } catch(e) { results[lang] = { ok: false, error: e.message || String(e) }; }
  }));
  res.json({ configured: true, cache_rows: cacheRows, results });
});

// Purge du cache de traduction (owner) : retire les entrées figées (dont les
// anciens replis français) pour forcer une retraduction propre. ?lang=xx cible
// une langue ; sans paramètre, vide toute la table.
app.post('/api/admin/translate-cache/clear', requireRole('owner'), async (req, res) => {
  const lang = (req.query.lang || req.body && req.body.lang || '').trim();
  try {
    const r = lang
      ? await pool.query('DELETE FROM content_translations WHERE lang=$1', [lang])
      : await pool.query('DELETE FROM content_translations');
    res.json({ ok: true, deleted: r.rowCount, lang: lang || 'all' });
  } catch(e) { console.error('translate-cache clear:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Réplique fidèle de sentenceCase() du portail (public/portal.html) : indispensable
// pour que les textes pré-traduits produisent le MÊME hash que ceux demandés à la
// volée par le navigateur (sinon le cache ne serait jamais retrouvé).
function srvSentenceCase(s) {
  s = String(s || '');
  if (!s) return s;
  const letters = s.replace(/[^a-zA-Z]/g, '');
  const upperRatio = letters.length ? (letters.replace(/[^A-Z]/g, '').length / letters.length) : 0;
  if (upperRatio < 0.7) return s;
  return s.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, c => c.toUpperCase());
}

// Pré-traduction complète du catalogue (owner) : remplit le cache pour les 8
// langues d'un coup (bios de marques + désignations produits). Idempotent — ne
// paie que ce qui manque encore ; si l'appel est coupé, recliquer reprend depuis
// le cache. Peut prendre 1 à 2 min sur un gros catalogue.
app.post('/api/admin/translate-warm', requireRole('owner'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY absente dans Railway' });
  try {
    const [brands, prods] = await Promise.all([
      pool.query("SELECT DISTINCT about_text FROM brands WHERE about_text IS NOT NULL AND about_text <> ''"),
      pool.query("SELECT DISTINCT description FROM products WHERE COALESCE(active,1)=1 AND description IS NOT NULL AND description <> ''")
    ]);
    const set = new Set();
    brands.rows.forEach(r => { const t = String(r.about_text || '').trim(); if (t) set.add(t.slice(0, 4000)); });
    prods.rows.forEach(r => { const t = srvSentenceCase(r.description || '').trim(); if (t) set.add(t.slice(0, 4000)); });
    const texts = [...set];
    const langs = Object.keys(TRANSLATE_LANGS);
    if (!texts.length) return res.json({ ok: true, texts: 0, langs: langs.length, added: 0, perLang: {}, note: 'Aucun texte à traduire (bios/désignations vides).' });
    const before = (await pool.query('SELECT COUNT(*)::int n FROM content_translations')).rows[0].n;
    const perLang = {};
    for (const lang of langs) {
      try { await translateBatch(texts, lang); perLang[lang] = 'ok'; }
      catch(e) { perLang[lang] = e.message || 'échec'; console.error(`[warm] ${lang}: ${e.message}`); }
    }
    // Les INSERT du cache sont asynchrones (fire-and-forget) : petite pause pour
    // que le comptage final reflète l'essentiel des écritures.
    await new Promise(r => setTimeout(r, 1500));
    const after = (await pool.query('SELECT COUNT(*)::int n FROM content_translations')).rows[0].n;
    res.json({ ok: true, texts: texts.length, langs: langs.length, cached_before: before, cached_after: after, added: Math.max(0, after - before), perLang });
  } catch(e) { console.error('translate-warm:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Signature pour upload direct navigateur → Cloudinary (vidéos surtout) : évite de
// faire transiter de gros fichiers par le serveur. On ne signe que folder + timestamp.
app.get('/api/cloudinary-signature', requireRole('owner','agent','designer'), (req, res) => {
  if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(503).json({ error: 'Cloudinary non configuré' });
  }
  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'showroom/videos';
  const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, process.env.CLOUDINARY_API_SECRET);
  res.json({ signature, timestamp, folder, apiKey: process.env.CLOUDINARY_API_KEY, cloudName: process.env.CLOUDINARY_CLOUD_NAME });
});

const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/upload-pdf', requireRole('owner','agent','designer'), uploadLimiter, uploadPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Fichier PDF requis' });
    // resource_type:'raw' ne transcode pas le contenu côté Cloudinary (contrairement aux
    // images) : le Content-Type déclaré ne suffit pas, on vérifie la signature réelle du fichier.
    if (req.file.buffer.slice(0, 4).toString('latin1') !== '%PDF') return res.status(400).json({ error: 'Fichier PDF invalide' });
    const base64 = `data:application/pdf;base64,${req.file.buffer.toString('base64')}`;
    const slug = `lookbook-${crypto.randomBytes(16).toString('hex')}`;
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
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', 'attachment; filename="linesheet.pdf"');
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ==================== APPOINTMENTS ====================

app.get('/api/brands/:brandId/appointments', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const r = await pool.query('SELECT * FROM appointments WHERE brand_id=$1 ORDER BY slot_date, slot_time', [req.params.brandId]);
  res.json(r.rows);
});

app.get('/api/public/brands/:brandId/slots', publicLimiter, async (req, res) => {
  const days = [];
  const now = new Date();
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekends
    days.push(d.toISOString().slice(0, 10));
  }
  const times = APPOINTMENT_TIMES;
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

// Créneaux proposés (doit rester cohérent avec /api/public/brands/:brandId/slots)
const APPOINTMENT_TIMES = ['10:00','11:00','12:00','14:00','15:00','16:00','17:00'];
function isValidAppointmentSlot(slot_date, slot_time) {
  if (!APPOINTMENT_TIMES.includes(slot_time)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slot_date)) return false;
  const d = new Date(slot_date + 'T00:00:00');
  if (isNaN(d)) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const max = new Date(today); max.setDate(max.getDate() + 22);
  if (d < today || d > max) return false;          // dans la fenêtre proposée
  if (d.getDay() === 0 || d.getDay() === 6) return false; // pas le week-end
  // Le jour même, refuser un créneau déjà passé dans la journée (sinon un
  // acheteur peut réserver "aujourd'hui 10h" à 16h, créant un RDV fantôme).
  if (d.getTime() === today.getTime()) {
    const [h, m] = slot_time.split(':').map(Number);
    const slotMinutes = h * 60 + m;
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    if (slotMinutes <= nowMinutes) return false;
  }
  return true;
}

app.post('/api/public/appointments', publicLimiter, async (req, res) => {
  try {
    const { brand_id, client_name, client_email, client_phone, slot_date, slot_time, notes } = req.body;
    if (!brand_id || !client_name || !client_email || !slot_date || !slot_time) {
      return res.status(400).json({ error: 'Données incomplètes' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(client_email).trim())) {
      return res.status(400).json({ error: 'Email invalide' });
    }
    if (!isValidAppointmentSlot(String(slot_date), String(slot_time))) {
      return res.status(400).json({ error: 'Créneau invalide' });
    }
    const brand = await pool.query('SELECT name FROM brands WHERE id=$1', [brand_id]);
    if (!brand.rows.length) return res.status(404).json({ error: 'Marque introuvable' });

    const name = String(client_name).trim().slice(0, 200);
    const email = String(client_email).trim().toLowerCase().slice(0, 200);
    const phone = String(client_phone || '').trim().slice(0, 50);
    const note = String(notes || '').trim().slice(0, 1000);
    const id = uuidv4();
    try {
      await pool.query(
        'INSERT INTO appointments (id,brand_id,client_name,client_email,client_phone,slot_date,slot_time,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, brand_id, name, email, phone, slot_date, slot_time, note]
      );
    } catch(e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ce créneau est déjà réservé' });
      throw e;
    }
    airtableTouchStore(email).catch(() => {}); // reflète le RDV dans le CRM Airtable
    // Send confirmation emails (non-blocking)
    sendAppointmentConfirmationEmail({ id, brand_id, client_name: name, client_email: email, client_phone: phone, slot_date, slot_time, notes: note }).catch(e => console.error('RDV email error:', e.message));
    sendPushToAdmins('Nouveau rendez-vous', `${name} — ${brand.rows[0].name} — ${slot_date} ${slot_time}`, brand_id).catch(() => {});
    res.json({ ok: true, id });
  } catch(e) { console.error('public appointment error:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

async function sendAppointmentConfirmationEmail(appt) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const [showroomName, fromAddress, agentName, agentPhone, adminEmail] = await Promise.all([
    getSetting('showroom_name'), getSetting('smtp_from'), getSetting('agent_name'),
    getSetting('agent_phone'), getSetting('showroom_email')
  ]);
  const from = fromAddress || 'showroom@editionsstandard.com';
  const resend = newResendClient(resendKey);

  // Get brand name
  const brandRes = await pool.query('SELECT name FROM brands WHERE id=$1', [appt.brand_id]);
  const brandName = brandRes.rows[0]?.name || showroomName;

  const dateStr = appt.slot_date instanceof Date
    ? appt.slot_date.toLocaleDateString('fr-FR')
    : String(appt.slot_date).slice(0,10).split('-').reverse().join('/');

  const subject = `Confirmation de votre rendez-vous — ${brandName}`;

  const clientContent = `
    <p>Bonjour <strong>${escHtml(appt.client_name)}</strong>,</p>
    <p>Votre rendez-vous a bien été enregistré.</p>
    <table style="margin:16px 0;font-size:13px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#888">Marque</td><td><strong>${escHtml(brandName)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">Date</td><td><strong>${escHtml(dateStr)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">Heure</td><td><strong>${escHtml(appt.slot_time)}</strong></td></tr>
    </table>
    <p>Notre équipe vous contactera pour confirmer les détails.</p>
    <p style="margin-top:28px">Cordialement,<br><strong>${escHtml(agentName || showroomName)}</strong>${agentPhone ? `<br>${escHtml(agentPhone)}` : ''}</p>
  `;

  const clientSend = await resend.emails.send({
    from: `${showroomName} <${from}>`,
    to: [appt.client_email],
    subject,
    html: emailLayout({ showroomName, brandName, content: clientContent })
  });
  if (clientSend.error) console.error('[resend] appointment-confirm client:', clientSend.error.message || clientSend.error);

  // Admin notification
  if (adminEmail) {
    const adminContent = `
      <p>Nouveau rendez-vous pris en ligne :</p>
      <table style="margin:16px 0;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#888">Marque</td><td><strong>${escHtml(brandName)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#888">Date</td><td><strong>${escHtml(dateStr)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#888">Heure</td><td><strong>${escHtml(appt.slot_time)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#888">Client</td><td><strong>${escHtml(appt.client_name)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#888">Email</td><td><a href="mailto:${escHtml(appt.client_email)}" style="color:#6b8500">${escHtml(appt.client_email)}</a></td></tr>
        ${appt.client_phone ? `<tr><td style="padding:4px 12px 4px 0;color:#888">Téléphone</td><td>${escHtml(appt.client_phone)}</td></tr>` : ''}
        ${appt.notes ? `<tr><td style="padding:4px 12px 4px 0;color:#888">Notes</td><td>${escHtml(appt.notes)}</td></tr>` : ''}
      </table>
    `;
    const { error } = await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [adminEmail],
      subject: `[RDV] ${appt.client_name} — ${brandName} — ${dateStr} ${appt.slot_time}`,
      html: emailLayout({ showroomName, brandName, content: adminContent })
    });
    if (error) console.error('[resend] appointment-confirm admin:', error.message || error);
  }
}

app.post('/api/brands/:brandId/repair-fields', requireBrandScope('owner','agent','designer'), async (req, res) => {
  const { brandId } = req.params;
  const prods = await pool.query('SELECT id, description, color, category, composition FROM products WHERE brand_id=$1', [brandId]);
  // Patterns: "Category: Top." / "Color: Black." / "Material: Cotton 100%." / "Matière: ..."
  const extract = (text, ...keys) => {
    for (const k of keys) {
      // \b : sans limite de mot, la clé "Type" matchait au milieu de
      // "Prototype:" (suffixe "type" collé au mot précédent), extrayant et
      // effaçant à tort un fragment de description qui n'était pas un label.
      const m = text.match(new RegExp('\\b' + k + '\\s*:\\s*([^.]+)\\.?', 'i'));
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

// 80 fichiers/appel (pas 200) : uploadLimiter plafonne le nombre d'APPELS/heure,
// pas le volume de fichiers — un import en lot reste un seul appel HTTP, donc
// jamais bloqué par cette limite pensée pour la fréquence. Réduire le plafond
// par appel borne le pire cas (compte compromis) sans gêner un import légitime
// (une séance photo complète dépasse rarement 80 références à la fois).
app.post('/api/brands/:brandId/bulk-photos', requireBrandScope('owner','agent','designer'), uploadLimiter, upload.array('photos', 80), async (req, res) => {
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
    if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype) || !looksLikeImage(file.buffer)) {
      results.push({ file: file.originalname, status: 'rejected', reason: 'type de fichier non autorisé' });
      continue;
    }
    const entry = pending.get(product.id);
    const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    // Ne jamais stocker le base64 brut en base en cas d'échec Cloudinary : ça
    // gonflerait la ligne produit sans limite (jusqu'à 200 fichiers/appel) tout
    // en répondant "ok" côté client alors que l'upload a en réalité échoué.
    try {
      const slug = `${product.reference}-${colorHint || product.color}-${crypto.randomBytes(6).toString('hex')}`.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
      const uploaded = await cloudinary.uploader.upload(base64, {
        folder: `showroom/${brandId}`,
        public_id: slug,
        overwrite: false,
        transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 80, fetch_format: 'auto', flags: 'strip_profile' }]
      });
      entry.images.push(uploaded.secure_url);
      entry.ranks.push(viewRank(colorHint));
      results.push({ file: file.originalname, status: 'ok', ref, color: colorHint || product.color });
    } catch(e) {
      console.error('Cloudinary upload error:', e.message);
      results.push({ file: file.originalname, status: 'error', reason: 'échec upload Cloudinary' });
    }
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
  if (!isBrandScoped(req)) return true;
  const o = await pool.query('SELECT brand_id FROM orders WHERE id=$1', [req.params.id]);
  if (!o.rows[0] || o.rows[0].brand_id !== req.userBrandId) {
    res.status(403).json({ error: 'Accès refusé' });
    return false;
  }
  return true;
}

// Buyers are shared across brands. A brand-scoped agent may only act on buyers
// who have at least one order with their brand.
async function checkBuyerBrandScope(req, res) {
  if (!isBrandScoped(req)) return true;
  const o = await pool.query('SELECT 1 FROM orders WHERE buyer_id=$1 AND brand_id=$2 LIMIT 1', [req.params.id, req.userBrandId]);
  if (!o.rows.length) {
    res.status(403).json({ error: 'Accès refusé' });
    return false;
  }
  return true;
}

app.get('/api/orders', requireRole('owner','agent','designer'), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const offset = parseInt(req.query.offset) || 0;
  const { dateFrom, dateTo, country, amountMin, amountMax } = req.query;

  const conditions = [];
  const params = [];

  if (req.userRole === 'designer' || req.userRole === 'agent') {
    params.push(req.userBrandId);
    conditions.push(`o.brand_id = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`o.created_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`o.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (country) {
    params.push(country);
    conditions.push(`LOWER(o.client_country) = LOWER($${params.length})`);
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // For amountMin/amountMax we need a HAVING clause (aggregate)
  const havingClauses = [];
  if (amountMin) { params.push(parseFloat(amountMin)); havingClauses.push(`SUM(ol.quantity * ol.unit_price) >= $${params.length}`); }
  if (amountMax) { params.push(parseFloat(amountMax)); havingClauses.push(`SUM(ol.quantity * ol.unit_price) <= $${params.length}`); }
  const havingClause = havingClauses.length ? 'HAVING ' + havingClauses.join(' AND ') : '';

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
    ${whereClause}
    GROUP BY o.id, o.order_number, b.name
    ${havingClause}
    ORDER BY o.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `, params);

  // Return total count for polling
  const countParams = params.slice(0, params.length - havingClauses.length);
  const countR = await pool.query(`
    SELECT COUNT(*) FROM (
      SELECT o.id FROM orders o
      JOIN brands b ON o.brand_id = b.id
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      ${whereClause}
      GROUP BY o.id
      ${havingClause}
    ) sub
  `, params).catch(() => ({ rows: [{ count: r.rows.length }] }));

  res.json({ rows: r.rows, total: parseInt(countR.rows[0]?.count || r.rows.length) });
});

app.get('/api/agent-selections', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    const needsScope = req.userRole === 'designer' || req.userRole === 'agent';
    const brandFilter = needsScope ? 'AND a.brand_id = $1' : '';
    const params = needsScope ? [req.userBrandId] : [];
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

// Suppression d'une sélection (ex. sélections de test). Bornée à la marque de
// l'agent ; le propriétaire peut tout supprimer. N'affecte pas une éventuelle
// commande déjà passée (les commandes vivent dans une autre table).
app.delete('/api/agent-selections/:token', requireRole('owner','agent'), async (req, res) => {
  try {
    const sel = await pool.query('SELECT brand_id FROM agent_selections WHERE token=$1', [req.params.token]);
    if (!sel.rows[0]) return res.status(404).json({ error: 'Sélection introuvable' });
    if (isBrandScoped(req) && sel.rows[0].brand_id !== req.userBrandId) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    await pool.query('DELETE FROM agent_selections WHERE token=$1', [req.params.token]);
    logAudit(req, 'delete_selection', 'agent_selection', req.params.token, '');
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Édition des références d'une sélection existante (ex. « on a oublié des réfs »).
// Remplace items_json par le jeu complet fourni. Bornée à la marque de l'agent.
// Refusée si la sélection a déjà été validée (used = commande passée) ou expirée.
// notify=true renvoie l'email à l'acheteur pour l'informer de la mise à jour.
app.put('/api/agent-selections/:token/items', requireRole('owner','agent'), async (req, res) => {
  try {
    const { items, notify } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items requis' });
    const sel = await pool.query(
      'SELECT a.brand_id, a.used, a.expires_at, a.client_email, a.client_name, a.selection_number, a.token, b.name AS brand_name FROM agent_selections a JOIN brands b ON b.id=a.brand_id WHERE a.token=$1',
      [req.params.token]);
    if (!sel.rows[0]) return res.status(404).json({ error: 'Sélection introuvable' });
    if (isBrandScoped(req) && sel.rows[0].brand_id !== req.userBrandId) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    if (sel.rows[0].used) return res.status(409).json({ error: 'Sélection déjà validée — impossible de la modifier.' });
    if (new Date(sel.rows[0].expires_at) < new Date()) return res.status(410).json({ error: 'Sélection expirée.' });
    // Une sélection = une liste de RÉFÉRENCES. Les quantités sont fixées par l'acheteur
    // sur /selection/, donc on accepte des lignes sans quantité (quantity 0). On garde
    // toute ligne avec un product_id valide, dédupliquée par product_id|taille.
    const candidateIds = [...new Set((items || []).map(i => i && i.product_id).filter(Boolean))];
    const ownProducts = candidateIds.length
      ? await pool.query('SELECT id FROM products WHERE id = ANY($1) AND brand_id = $2', [candidateIds, sel.rows[0].brand_id])
      : { rows: [] };
    const ownProductIds = new Set(ownProducts.rows.map(r => r.id));
    const seen = new Set();
    const cleanItems = [];
    for (const i of (items || [])) {
      const pid = i && i.product_id;
      // Un product_id qui n'appartient pas à la marque de la sélection est ignoré :
      // sinon le catalogue/prix d'une autre marque se retrouve exposé à l'acheteur
      // via /selection/:token, et pourrait finir dans une commande de cette marque.
      if (!pid || !ownProductIds.has(pid)) continue;
      const size = (i.size || '').toString();
      const key = pid + '|' + size;
      if (seen.has(key)) continue;
      seen.add(key);
      const note = typeof i.note === 'string' ? i.note.trim().slice(0, 300) : '';
      cleanItems.push({ product_id: pid, size, quantity: Math.max(0, parseInt(i.quantity) || 0), note });
    }
    if (!cleanItems.length) return res.status(400).json({ error: 'Sélectionnez au moins une référence' });
    const refCount = new Set(cleanItems.map(i => i.product_id)).size;
    await pool.query('UPDATE agent_selections SET items_json=$1 WHERE token=$2', [JSON.stringify(cleanItems), req.params.token]);
    logAudit(req, 'edit_selection_items', 'agent_selection', req.params.token, refCount + ' réf.');
    if (notify && sel.rows[0].client_email) {
      const url = `${getBaseUrl(req)}/selection/${req.params.token}`;
      sendAgentSelectionEmail({ email: sel.rows[0].client_email, name: sel.rows[0].client_name, brandName: sel.rows[0].brand_name, selectionNumber: sel.rows[0].selection_number, url, req }).catch(e => console.error('agent-selection edit email:', e.message));
    }
    res.json({ ok: true, count: refCount });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Export PDF d'une sélection (référence + prix, quantités "à déf." tant que
// l'acheteur ne les a pas fixées sur /selection/) — réutilise le même
// générateur que le PDF téléchargeable depuis /commande/:brandId.
app.get('/api/agent-selections/:token/pdf', requireRole('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT a.*, b.name AS brand_name, b.logo AS brand_logo, b.logo_url AS brand_logo_url FROM agent_selections a JOIN brands b ON b.id=a.brand_id WHERE a.token=$1',
      [req.params.token]);
    const s = r.rows[0];
    if (!s) return res.status(404).json({ error: 'Sélection introuvable' });
    if (isBrandScoped(req) && s.brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    const items = JSON.parse(s.items_json || '[]');
    const ids = [...new Set(items.map(i => i.product_id))];
    const prods = ids.length ? await pool.query('SELECT * FROM products WHERE id = ANY($1)', [ids]) : { rows: [] };
    const pmap = Object.fromEntries(prods.rows.map(p => [p.id, p]));
    const lines = items.filter(i => pmap[i.product_id]).map(i => ({ ...i, product: pmap[i.product_id] }));
    const [showroomName, agentName] = await Promise.all([getSetting('showroom_name'), getSetting('agent_name')]);
    const pdf = await generateSelectionPDF({
      brand: { name: s.brand_name, logo: s.brand_logo, logo_url: s.brand_logo_url },
      client_name: s.client_name, client_email: s.client_email, client_company: s.client_company, client_country: '',
      notes: s.notes, lines, showroomName, agentName
    });
    logAudit(req, 'download_selection_pdf', 'agent_selection', req.params.token, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', `attachment; filename="Selection-${(s.selection_number || req.params.token.slice(0,8)).replace(/\s/g,'-')}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Relance manuelle d'une sélection en attente : renvoie l'email (rappel) à l'acheteur
// avec le lien de sa sélection. Bornée à la marque de l'agent. Refusée si validée/expirée.
app.post('/api/agent-selections/:token/remind', requireRole('owner','agent'), prospectInviteLimiter, async (req, res) => {
  try {
    const sel = await pool.query(
      'SELECT a.brand_id, a.used, a.expires_at, a.client_email, a.client_name, a.selection_number, b.name AS brand_name FROM agent_selections a JOIN brands b ON b.id=a.brand_id WHERE a.token=$1',
      [req.params.token]);
    if (!sel.rows[0]) return res.status(404).json({ error: 'Sélection introuvable' });
    if (isBrandScoped(req) && sel.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    if (sel.rows[0].used) return res.status(409).json({ error: 'Sélection déjà validée.' });
    if (new Date(sel.rows[0].expires_at) < new Date()) return res.status(410).json({ error: 'Sélection expirée.' });
    if (!sel.rows[0].client_email) return res.status(400).json({ error: 'Aucun email acheteur sur cette sélection.' });
    const url = `${getBaseUrl(req)}/selection/${req.params.token}`;
    await sendAgentSelectionEmail({ email: sel.rows[0].client_email, name: sel.rows[0].client_name, brandName: sel.rows[0].brand_name, selectionNumber: sel.rows[0].selection_number, url, req, reminder: true });
    await pool.query('UPDATE agent_selections SET reminder_sent = true WHERE token=$1', [req.params.token]);
    logAudit(req, 'remind_selection', 'agent_selection', req.params.token, sel.rows[0].client_email);
    res.json({ ok: true, url, email: sel.rows[0].client_email, emailed: !!process.env.RESEND_API_KEY });
  } catch(e) { console.error('remind selection:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Correction des infos acheteur d'une sélection (nom/email/société parfois erronés).
// Bornée à la marque de l'agent. Refusée si la sélection est déjà validée.
app.put('/api/agent-selections/:token/client', requireRole('owner','agent'), async (req, res) => {
  try {
    const { client_name, client_email, client_company, created_by } = req.body;
    const sel = await pool.query('SELECT brand_id, used FROM agent_selections WHERE token=$1', [req.params.token]);
    if (!sel.rows[0]) return res.status(404).json({ error: 'Sélection introuvable' });
    if (isBrandScoped(req) && sel.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    if (sel.rows[0].used) return res.status(409).json({ error: 'Sélection déjà validée — impossible de la modifier.' });
    const email = String(client_email || '').trim().toLowerCase();
    if (email && !email.includes('@')) return res.status(400).json({ error: 'Email acheteur invalide' });
    const sentBy = String(created_by || '').trim().toLowerCase();
    if (sentBy && !sentBy.includes('@')) return res.status(400).json({ error: "Email d'envoi invalide" });
    // Email(s) : mis à jour seulement s'ils sont fournis (sinon on conserve l'existant)
    await pool.query(
      "UPDATE agent_selections SET client_name=$1, client_company=$2, client_email=COALESCE(NULLIF($3,''), client_email), created_by=COALESCE(NULLIF($4,''), created_by) WHERE token=$5",
      [String(client_name || '').slice(0, 160), String(client_company || '').slice(0, 160), email, sentBy, req.params.token]);
    logAudit(req, 'edit_selection_client', 'agent_selection', req.params.token, email || '');
    res.json({ ok: true });
  } catch(e) { console.error('edit selection client:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Historique des actions sur une sélection (création, relances, modifications…),
// avec auteur et horodatage. Source : admin_audit_log + la création de la sélection.
app.get('/api/agent-selections/:token/history', requireRole('owner','agent'), async (req, res) => {
  try {
    const sel = await pool.query('SELECT brand_id, created_at, created_by, client_email FROM agent_selections WHERE token=$1', [req.params.token]);
    if (!sel.rows[0]) return res.status(404).json({ error: 'Sélection introuvable' });
    if (isBrandScoped(req) && sel.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    const rows = await pool.query(
      "SELECT action, user_email, details, created_at FROM admin_audit_log WHERE target_type='agent_selection' AND target_id=$1 ORDER BY created_at ASC",
      [req.params.token]);
    // La création n'est pas dans le journal : on la reconstitue depuis la sélection.
    const events = [
      { action: 'create', user_email: sel.rows[0].created_by || '', details: sel.rows[0].client_email || '', created_at: sel.rows[0].created_at },
      ...rows.rows
    ];
    res.json({ events });
  } catch(e) { console.error('selection history:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Révocation manuelle du lien PDF public d'une commande (point 1 du rapport
// sécurité) : coupe l'accès immédiatement, indépendamment de la fenêtre 24h.
app.post('/api/orders/:id/revoke-pdf', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    await pool.query('UPDATE orders SET pdf_revoked=true WHERE id=$1', [req.params.id]);
    logAudit(req, 'revoke_order_pdf', 'order', req.params.id, '');
    res.json({ ok: true });
  } catch(e) { console.error('revoke-pdf:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/orders/:id/status', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const { status } = req.body;
    const orderId = req.params.id;
    const validStatuses = ['confirmed','validated','in_production','shipped','cancelled','archived'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    // SELECT ... FOR UPDATE + transaction : sans verrou, deux changements de statut
    // concurrents sur la même commande lisent le même oldStatus et écrivent chacun
    // une ligne d'historique avec un old_status devenu faux (piste d'audit corrompue).
    const dbClient = await pool.connect();
    let oldStatus;
    try {
      await dbClient.query('BEGIN');
      const prev = await dbClient.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      oldStatus = prev.rows[0]?.status || '';
      // "archived" est un état terminal : au-delà, plus aucun changement de
      // statut via cet endpoint (évite de ressusciter silencieusement une
      // commande classée, avec ré-envoi d'email client à l'appui).
      if (oldStatus === 'archived') { await dbClient.query('ROLLBACK'); return res.status(409).json({ error: 'Commande archivée : statut définitif.' }); }
      // Sortie de "draft" : seul /reorder crée une commande directement en
      // draft (sans passer par createOrder(), qui décrémente déjà le stock à
      // la création) — décrémenter ici évite qu'un brouillon confirmé plus
      // tard n'engage jamais la quantité correspondante dans stock_qty.
      if (oldStatus === 'draft' && status !== 'draft') {
        const stockResult = await decrementOrderStockOnActivation(orderId);
        if (stockResult.error) { await dbClient.query('ROLLBACK'); return res.status(409).json({ error: stockResult.error }); }
      }
      await dbClient.query('UPDATE orders SET status=$1 WHERE id=$2', [status, orderId]);
      await dbClient.query('COMMIT');
    } catch(e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
    logAudit(req, 'update_order_status', 'order', orderId, `${oldStatus} → ${status}`);
    const changedBy = req.session?.staffUser?.name || req.session?.staffUser?.email || (req.session?.admin ? 'admin' : 'system');
    // Log status change
    await pool.query(
      'INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by) VALUES ($1,$2,$3,$4,$5)',
      [uuidv4(), orderId, oldStatus, status, changedBy]
    ).catch(e => console.error('history insert error:', e.message));
    await addOrderEvent(orderId, status, `Statut → ${status}`, changedBy);
    // Recrédite le stock suivi uniquement sur une VRAIE transition vers annulé
    // (pas si la commande était déjà cancelled) — sinon ré-appliquer le même
    // statut recréditerait le stock plusieurs fois pour la même commande.
    if (status === 'cancelled' && oldStatus !== 'cancelled') {
      restoreOrderStock(orderId).catch(e => console.error('restoreOrderStock:', e.message));
    }
    // Notify buyer on meaningful transitions
    if (['validated','in_production','shipped'].includes(status)) {
      sendOrderStatusEmail(orderId, status).catch(e => console.error('status email error:', e.message));
    }
    // Copie email au propriétaire (modification / annulation de commande)
    notifyOwnerOrder(orderId, status === 'cancelled' ? 'Commande annulée' : 'Statut de commande modifié', `${oldStatus || '—'} → ${status} (par ${changedBy})`).catch(() => {});
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Signature agent/marque : capture la signature (canvas, comme côté acheteur),
// passe la commande en « validated » et régénère le PDF avec les DEUX
// signatures — c'est ce document, envoyé par email à l'acheteur, qui
// constitue le bon de commande définitif (cf. CGU, art. 4-5).
app.post('/api/orders/:id/sign', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const { signature } = req.body;
    if (!signature || typeof signature !== 'string' || !signature.startsWith('data:image')) {
      return res.status(400).json({ error: 'Signature requise' });
    }
    const orderId = req.params.id;
    const prev = await pool.query('SELECT status FROM orders WHERE id=$1', [orderId]);
    if (!prev.rows[0]) return res.status(404).json({ error: 'Commande introuvable' });
    const oldStatus = prev.rows[0].status;
    // Contrairement à PUT /status, cet endpoint ne vérifiait aucun état de
    // départ — signer une commande annulée ou archivée la ressuscitait
    // silencieusement en "validated" (avec régénération du PDF + email de
    // confirmation renvoyé à l'acheteur).
    if (oldStatus === 'cancelled' || oldStatus === 'archived') {
      return res.status(409).json({ error: `Commande ${oldStatus === 'cancelled' ? 'annulée' : 'archivée'} : impossible de la signer.` });
    }
    const signedBy = req.session?.staffUser?.name || req.session?.staffUser?.email || (req.session?.admin ? 'Owner' : 'Agent');

    await pool.query(
      'UPDATE orders SET agent_signature=$1, agent_signed_at=NOW(), agent_signed_by=$2, status=$3 WHERE id=$4',
      [signature, signedBy, 'validated', orderId]
    );
    logAudit(req, 'order_signed', 'order', orderId, signedBy);
    await pool.query(
      'INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by) VALUES ($1,$2,$3,$4,$5)',
      [uuidv4(), orderId, oldStatus, 'validated', signedBy]
    ).catch(e => console.error('history insert error:', e.message));
    await addOrderEvent(orderId, 'validated', `Commande validée et signée par ${signedBy}`, signedBy);

    // Régénère le PDF (désormais signé des deux parties) et l'envoie à l'acheteur.
    try {
      const pdf = await generateOrderPDF(orderId);
      await sendOrderSignedEmail(orderId, pdf);
    } catch(e) { console.error('signed PDF/email error:', e.message); }
    notifyOwnerOrder(orderId, 'Commande validée et signée', signedBy).catch(() => {});

    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/orders/:id/history', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const r = await pool.query(
      'SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY changed_at DESC',
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/orders/:id/events', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const r = await pool.query('SELECT * FROM order_events WHERE order_id=$1 ORDER BY created_at ASC', [req.params.id]);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/orders/:id/events', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const { note, event_type } = req.body;
    await addOrderEvent(req.params.id, event_type || 'note', note, req.session.staffUser?.name || req.session.admin && 'admin' || 'admin');
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.patch('/api/orders/:id/notes', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    await pool.query('UPDATE orders SET internal_notes=$1 WHERE id=$2', [req.body.notes || '', req.params.id]);
    await addOrderEvent(req.params.id, 'note', req.body.notes, req.session.staffUser?.name || (req.session.admin ? 'admin' : 'admin'));
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

async function sendOrderStatusEmail(orderId, status) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const [showroomName, agentName, fromAddress, showroomEmail] = await Promise.all([
    getSetting('showroom_name'), getSetting('agent_name'), getSetting('smtp_from'), getSetting('showroom_email')
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
  const resend = newResendClient(resendKey);
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
  const { error } = await resend.emails.send({
    from: `${showroomName} <${fromField}>`,
    to: [order.client_email],
    ...(showroomEmail ? { replyTo: showroomEmail } : {}), // réponses de l'acheteur → showroom
    ...(showroomEmail && showroomEmail.toLowerCase() !== order.client_email.toLowerCase() ? { bcc: [showroomEmail] } : {}),
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
  if (error) console.error('[resend] order-status-email:', error.message || error);
}

// Bon de commande définitif (signé par l'acheteur ET par l'agence/marque) —
// envoyé une fois la commande signée côté agence via POST /api/orders/:id/sign.
// Distinct de sendOrderEmails (proposition initiale, non contractuelle) et de
// sendOrderStatusEmail (simples notifications de statut, sans pièce jointe).
async function sendOrderSignedEmail(orderId, pdfBuffer) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('RESEND_API_KEY non configurée — email bon de commande signé non envoyé'); return; }
  const [showroomEmail, showroomName, agentName, fromAddress] = await Promise.all([
    getSetting('showroom_email'), getSetting('showroom_name'), getSetting('agent_name'), getSetting('smtp_from')
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
  const isEn = order.buyer_lang === 'en';
  const orderNo = order.order_number || orderId.slice(0,8).toUpperCase();
  const filename = `BonDeCommandeDefinitif-${order.brand_name.replace(/\s/g,'-')}-${orderNo}.pdf`;
  const totalStr = Number(order.order_total||0).toFixed(2).replace('.',',') + ' €';
  const resend = newResendClient(resendKey);
  const fromField = fromAddress || 'showroom@editionsstandard.com';

  const { error } = await resend.emails.send({
    from: `${showroomName} <${fromField}>`,
    to: [order.client_email],
    ...(showroomEmail ? { replyTo: showroomEmail } : {}), // réponses de l'acheteur → showroom
    ...(showroomEmail && showroomEmail.toLowerCase() !== order.client_email.toLowerCase() ? { bcc: [showroomEmail] } : {}),
    subject: isEn
      ? `Final signed order — ${order.brand_name} — ${showroomName}`
      : `Bon de commande définitif signé — ${order.brand_name} — ${showroomName}`,
    attachments: [{ filename, content: pdfBuffer.toString('base64'), contentType: 'application/pdf' }],
    html: emailLayout({ showroomName, brandName: order.brand_name, brandLogo: order.brand_logo || '', content: isEn ? `
      <p>Hello <strong>${escHtml(order.client_name)}</strong>,</p>
      <p>Good news — your order for <strong>${order.brand_name}</strong> has been <strong>validated and signed by both parties</strong>. It is now firm and final.</p>
      <p>The final signed purchase order (reference <code>${orderNo}</code>, total ex-VAT: <strong>${totalStr}</strong>) is attached to this email.</p>
      <p style="margin-top:28px">Best regards,<br><strong>${escHtml(agentName || showroomName)}</strong></p>
    ` : `
      <p>Bonjour <strong>${escHtml(order.client_name)}</strong>,</p>
      <p>Bonne nouvelle — votre commande pour <strong>${order.brand_name}</strong> a été <strong>validée et signée par les deux parties</strong>. Elle est désormais ferme et définitive.</p>
      <p>Le bon de commande définitif signé (référence <code>${orderNo}</code>, total HT : <strong>${totalStr}</strong>) est joint à cet email.</p>
      <p style="margin-top:28px">Cordialement,<br><strong>${escHtml(agentName || showroomName)}</strong></p>
    ` })
  });
  if (error) console.error('[resend] order-signed-email:', error.message || error);
}

app.get('/api/orders/export/csv', requireRole('owner','agent'), async (req, res) => {
  try {
    logAudit(req, 'export_orders_csv', 'orders', '', '');
    const scoped = isBrandScoped(req);
    const r = await pool.query(`
      SELECT o.id, o.order_number, o.created_at, o.client_name, o.client_email, o.client_company, o.client_phone, o.client_country,
             o.status, b.name as brand_name,
             ol.size, ol.quantity, ol.unit_price, ol.price_retail,
             p.reference, p.description, p.color
      FROM orders o
      JOIN brands b ON o.brand_id=b.id
      JOIN order_lines ol ON ol.order_id=o.id
      JOIN products p ON ol.product_id=p.id
      ${scoped ? 'WHERE o.brand_id = $1' : ''}
      ORDER BY o.created_at DESC, o.id, p.reference
    `, scoped ? [req.userBrandId] : []);
    const headers = ['Date','Référence commande','Client','Email','Société','Téléphone','Pays','Statut','Marque','Référence produit','Description','Couleur','Taille','Quantité','Prix HT','Prix PVC'];
    const rows = r.rows.map(row => [
      new Date(row.created_at).toLocaleDateString('fr-FR'),
      row.order_number || row.id.slice(0,8).toUpperCase(),
      row.client_name, row.client_email, row.client_company, row.client_phone, row.client_country,
      row.status, row.brand_name, row.reference, row.description, row.color,
      row.size, row.quantity, row.unit_price, row.price_retail
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${csvSafe(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="commandes-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('﻿' + csv); // BOM for Excel
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/orders/export-csv', requireRole('owner','agent'), async (req, res) => {
  try {
    logAudit(req, 'export_orders_csv', 'orders', '', '');
    const scoped = isBrandScoped(req);
    const r = await pool.query(`
      SELECT o.order_number, o.id, o.created_at, b.name as brand_name,
             o.client_name, o.client_email, o.client_company, o.client_country, o.status,
             COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total_ht
      FROM orders o
      JOIN brands b ON o.brand_id = b.id
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      ${scoped ? 'WHERE o.brand_id = $1' : ''}
      GROUP BY o.id, b.name
      ORDER BY o.created_at DESC
    `, scoped ? [req.userBrandId] : []);
    const headers = ['Référence','Date','Marque','Client','Email','Société','Pays','Statut','Total HT'];
    const rows = r.rows.map(row => [
      row.order_number || row.id.slice(0,8).toUpperCase(),
      new Date(row.created_at).toLocaleDateString('fr-FR'),
      row.brand_name,
      row.client_name, row.client_email, row.client_company || '', row.client_country || '',
      row.status,
      parseFloat(row.total_ht).toFixed(2)
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${csvSafe(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="commandes.csv"');
    res.send('﻿' + csv);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/buyers/export-csv', requireRole('owner','agent'), async (req, res) => {
  try {
    logAudit(req, 'export_buyers_csv', 'buyers', '', '');
    const scoped = isBrandScoped(req);
    const r = await pool.query(`
      SELECT name, email, company, phone, country, created_at
      FROM buyers
      ${scoped ? 'WHERE id IN (SELECT buyer_id FROM orders WHERE brand_id = $1 AND buyer_id IS NOT NULL)' : ''}
      ORDER BY created_at DESC
    `, scoped ? [req.userBrandId] : []);
    const headers = ['Nom','Email','Société','Téléphone','Pays','Inscrit le'];
    const rows = r.rows.map(row => [
      row.name, row.email, row.company || '', row.phone || '', row.country || '',
      new Date(row.created_at).toLocaleDateString('fr-FR')
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${csvSafe(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="acheteurs.csv"');
    res.send('﻿' + csv);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});


// Export commandes XLSX
app.get('/api/admin/export/orders.xlsx', requireRole('owner','agent'), async (req, res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx non disponible' });
  logAudit(req, 'export_orders_xlsx', 'orders', '', '');
  const { status, from, to } = req.query;
  // Agent scopé : forcer sa marque, ignorer tout brand_id fourni dans la query.
  const brand_id = isBrandScoped(req) ? req.userBrandId : req.query.brand_id;
  let q = `SELECT o.order_number, b.name as marque, o.client_name, o.client_company, o.client_email, o.client_country, o.status, o.created_at,
    COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total_amount,
    STRING_AGG(p.reference || ' x' || ol.quantity || ' (' || ol.size || ')', ', ') as lignes
    FROM orders o JOIN brands b ON b.id=o.brand_id LEFT JOIN order_lines ol ON ol.order_id=o.id LEFT JOIN products p ON p.id=ol.product_id WHERE 1=1`;
  const params = [];
  if (brand_id) { params.push(brand_id); q += ` AND o.brand_id=$${params.length}`; }
  if (status) { params.push(status); q += ` AND o.status=$${params.length}`; }
  if (from) { params.push(from); q += ` AND o.created_at >= $${params.length}`; }
  if (to) { params.push(to); q += ` AND o.created_at <= $${params.length}`; }
  q += ' GROUP BY o.id, b.name ORDER BY o.created_at DESC';
  const r = await pool.query(q, params);
  const ws = XLSX.utils.json_to_sheet(r.rows.map(row => ({
    'N° commande': row.order_number, 'Marque': csvSafe(row.marque), 'Client': csvSafe(row.client_name),
    'Société': csvSafe(row.client_company), 'Email': csvSafe(row.client_email), 'Pays': csvSafe(row.client_country),
    'Statut': row.status, 'Montant': row.total_amount,
    'Date': new Date(row.created_at).toLocaleDateString('fr-FR'), 'Lignes': csvSafe(row.lignes)
  })));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Commandes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="commandes.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Export produits XLSX
app.get('/api/admin/export/products.xlsx', requireRole('owner','agent'), async (req, res) => {
  if (!XLSX) return res.status(500).json({ error: 'xlsx non disponible' });
  logAudit(req, 'export_products_xlsx', 'products', '', '');
  const brand_id = isBrandScoped(req) ? req.userBrandId : req.query.brand_id;
  let q = `SELECT b.name as marque, p.reference, p.description, p.color, p.sizes, p.price, p.price_retail, p.collection_name, p.category, p.composition, p.active FROM products p JOIN brands b ON b.id=p.brand_id WHERE 1=1`;
  const params = [];
  if (brand_id) { params.push(brand_id); q += ` AND p.brand_id=$${params.length}`; }
  q += ' ORDER BY b.name, p.reference';
  const r = await pool.query(q, params);
  const ws = XLSX.utils.json_to_sheet(r.rows.map(row => ({
    'Marque': csvSafe(row.marque), 'Référence': row.reference, 'Description': csvSafe(row.description),
    'Couleur': csvSafe(row.color), 'Tailles': row.sizes, 'Prix HT': row.price,
    'Prix retail': row.price_retail, 'Collection': csvSafe(row.collection_name),
    'Catégorie': csvSafe(row.category), 'Composition': csvSafe(row.composition), 'Actif': row.active ? 'Oui' : 'Non'
  })));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Produits');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="produits.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/api/buyers/stats', requireRole('owner','agent'), async (req, res) => {
  try {
    // Agent scopé : uniquement les acheteurs ayant commandé chez sa marque, montants limités à sa marque.
    const scoped = isBrandScoped(req);
    const joinFilter = scoped ? 'AND o.brand_id = $1' : '';
    const r = await pool.query(`
      SELECT b.id, b.email, b.name, b.company, b.last_seen_at, b.lang,
             COUNT(DISTINCT o.id) as order_count,
             COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total_amount,
             COUNT(DISTINCT o.brand_id) as brands_count
      FROM buyers b
      ${scoped ? 'JOIN' : 'LEFT JOIN'} orders o ON o.buyer_id = b.id ${joinFilter}
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      GROUP BY b.id
      ORDER BY total_amount DESC
    `, scoped ? [req.userBrandId] : []);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.patch('/api/orders/bulk-status', requireRole('owner','agent'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    const validStatuses = ['confirmed','validated','in_production','shipped','cancelled','archived'];
    if (!status || !validStatuses.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Aucun identifiant fourni' });
    const changedBy = req.session?.staffUser?.email || (req.session?.admin ? 'admin' : 'system');
    const scoped = isBrandScoped(req);
    let updated = 0;
    // Même verrou que PUT /api/orders/:id/status, par commande — sans lui, deux
    // changements de statut concurrents sur la même commande (ex. une action
    // groupée qui recouvre un changement individuel simultané) lisent le même
    // oldStatus avant qu'aucun n'écrive : une annulation peut alors recréditer
    // le stock DEUX fois pour une seule commande (stock fantôme), ou une sortie
    // de brouillon le décrémenter deux fois (sur-engagement).
    for (const orderId of ids) {
      const dbClient = await pool.connect();
      let oldStatus, brandId, skip = false;
      try {
        await dbClient.query('BEGIN');
        const prev = await dbClient.query('SELECT status, brand_id FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
        if (!prev.rows[0]) { await dbClient.query('ROLLBACK'); continue; }
        brandId = prev.rows[0].brand_id;
        if (scoped && brandId !== req.userBrandId) { await dbClient.query('ROLLBACK'); continue; } // n'agit que sur sa marque
        oldStatus = prev.rows[0].status || '';
        if (oldStatus === 'archived') { await dbClient.query('ROLLBACK'); continue; } // statut terminal
        // Même logique de cohérence stock que PUT /api/orders/:id/status : une
        // annulation groupée doit recréditer le stock suivi, et confirmer un
        // brouillon (issu de /reorder) doit le décrémenter.
        if (oldStatus === 'draft' && status !== 'draft') {
          const stockResult = await decrementOrderStockOnActivation(orderId);
          if (stockResult.error) { await dbClient.query('ROLLBACK'); continue; } // stock insuffisant : ignorée, pas les autres
        }
        await dbClient.query('UPDATE orders SET status=$1 WHERE id=$2', [status, orderId]);
        await dbClient.query('COMMIT');
      } catch(e) {
        await dbClient.query('ROLLBACK');
        console.error('bulk-status transaction error:', e.message);
        skip = true;
      } finally {
        dbClient.release();
      }
      if (skip || oldStatus === undefined) continue;
      if (status === 'cancelled' && oldStatus !== 'cancelled') {
        restoreOrderStock(orderId).catch(e => console.error('restoreOrderStock (bulk):', e.message));
      }
      await pool.query(
        'INSERT INTO order_status_history (id, order_id, old_status, new_status, changed_by) VALUES ($1,$2,$3,$4,$5)',
        [uuidv4(), orderId, oldStatus, status, changedBy]
      ).catch(e => console.error('bulk history insert error:', e.message));
      await addOrderEvent(orderId, status, `Statut → ${status} (action groupée)`, changedBy);
      updated++;
    }
    // Copie email au propriétaire : un résumé pour l'action groupée
    if (updated > 0) {
      notifyOwner(
        `${updated} commande(s) — statut « ${status} »`,
        `<p><strong>Modification groupée de statut</strong></p>
         <p style="font-size:13px">${updated} commande(s) passée(s) au statut <strong>${escHtml(status)}</strong> par ${escHtml(changedBy)}.</p>
         <p style="font-size:12px;color:#888">Détails dans votre admin → Commandes.</p>`
      ).catch(() => {});
    }
    res.json({ updated });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/orders/:id', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    // Copie email au propriétaire AVANT suppression (la commande n'existera plus après)
    await notifyOwnerOrder(req.params.id, 'Commande supprimée');
    // Ne recréditer le stock que s'il est encore réellement engagé : une commande
    // 'cancelled' l'a déjà été recrédité par PUT/PATCH .../status, et une commande
    // 'draft' (issue de /reorder) n'a jamais décrémenté le stock à la création —
    // le recréditer quand même dans ces deux cas gonfle stock_qty artificiellement
    // (stock fantôme) sans qu'aucune vente correspondante n'ait jamais eu lieu.
    const cur = await pool.query('SELECT status FROM orders WHERE id=$1', [req.params.id]);
    if (cur.rows[0] && !['cancelled', 'draft'].includes(cur.rows[0].status)) {
      await restoreOrderStock(req.params.id);
    }
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
  const scoped = isBrandScoped(req);
  const r = await pool.query(`
    SELECT a.*, b.name AS brand_name
    FROM appointments a
    JOIN brands b ON b.id = a.brand_id
    ${scoped ? 'WHERE a.brand_id = $1' : ''}
    ORDER BY a.slot_date DESC, a.slot_time DESC
  `, scoped ? [req.userBrandId] : []);
  res.json(r.rows);
});

// SSRF : subscription.endpoint est fourni par le client et sendPushToAdmins()
// POSTe côté serveur vers CETTE url à chaque nouvelle commande (déclenché
// automatiquement, pas besoin d'action supplémentaire de l'attaquant une fois
// l'abonnement enregistré). Sans restriction, un agent peut faire pointer le
// serveur vers une cible interne. Les navigateurs ne génèrent jamais de
// subscription en dehors des services push connus des fournisseurs — on
// n'autorise que ces hôtes.
const ALLOWED_PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
function isSafePushEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch(e) { return false; }
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_PUSH_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
}
app.post('/api/admin/push-subscribe', requireRole('owner','agent'), async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.keys) return res.status(400).json({ error: 'Missing subscription' });
    if (!isSafePushEndpoint(subscription.endpoint)) return res.status(400).json({ error: 'Service de notification non reconnu' });
    const id = uuidv4();
    // ON CONFLICT (endpoint) — pas (id), toujours un UUID neuf donc jamais en
    // conflit : sans clé sur l'endpoint réel, chaque re-souscription (rechargement,
    // mise à jour du service worker) empilait une nouvelle ligne au lieu de
    // rafraîchir l'abonnement existant pour ce même appareil.
    await pool.query(
      `INSERT INTO push_subscriptions (id, subscription_json, staff_id, endpoint) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET subscription_json=EXCLUDED.subscription_json, staff_id=EXCLUDED.staff_id`,
      [id, JSON.stringify(subscription), req.session.staffUser?.id || null, subscription.endpoint]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur' }); }
});

app.get('/api/admin/vapid-public-key', requireRole('owner','agent'), (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.delete('/api/admin/appointments/:id', requireRole('owner','agent'), async (req, res) => {
  try {
    if (req.userRole === 'agent' && req.userBrandId) {
      const check = await pool.query('SELECT brand_id FROM appointments WHERE id=$1', [req.params.id]);
      if (!check.rows[0] || check.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    }
    await pool.query('DELETE FROM appointments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Définir / retirer le lien visioconférence d'un rendez-vous (owner/agent/designer, borné à leur marque)
app.put('/api/admin/appointments/:id', requireRole('owner','agent','designer'), async (req, res) => {
  try {
    const url = String(req.body?.video_link || '').trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Le lien doit commencer par http(s)://' });
    const cur = await pool.query('SELECT * FROM appointments WHERE id=$1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Rendez-vous introuvable' });
    if ((req.userRole === 'agent' || req.userRole === 'designer') && req.userBrandId && cur.rows[0].brand_id !== req.userBrandId) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    await pool.query('UPDATE appointments SET video_link=$1 WHERE id=$2', [url, req.params.id]);
    // Envoie le lien au client dès qu'il est défini (non bloquant si l'email échoue)
    let emailed = false;
    if (url) {
      emailed = await sendAppointmentVideoEmail({ ...cur.rows[0], video_link: url }).catch(e => { console.error('RDV visio email:', e.message); return false; });
    }
    res.json({ ok: true, emailed });
  } catch(e) { console.error('appt video-link:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Email : envoi du lien visioconférence au client
async function sendAppointmentVideoEmail(appt) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return false;
  const [showroomName, fromAddress, agentName, agentPhone, showroomEmail] = await Promise.all([
    getSetting('showroom_name'), getSetting('smtp_from'), getSetting('agent_name'), getSetting('agent_phone'), getSetting('showroom_email')
  ]);
  const from = fromAddress || 'showroom@editionsstandard.com';
  const resend = newResendClient(resendKey);
  const brandRes = await pool.query('SELECT name FROM brands WHERE id=$1', [appt.brand_id]);
  const brandName = brandRes.rows[0]?.name || showroomName;
  const dateStr = appt.slot_date instanceof Date
    ? appt.slot_date.toLocaleDateString('fr-FR')
    : String(appt.slot_date).slice(0,10).split('-').reverse().join('/');
  const content = `
    <p>Bonjour <strong>${escHtml(appt.client_name)}</strong>,</p>
    <p>Votre rendez-vous avec <strong>${escHtml(brandName)}</strong> le <strong>${escHtml(dateStr)}</strong> à <strong>${escHtml(appt.slot_time)}</strong> se tiendra en <strong>visioconférence</strong>.</p>
    <p style="margin:22px 0">
      <a href="${escHtml(appt.video_link)}" style="display:inline-block;background:#CCEB3C;color:#111;font-weight:700;padding:13px 26px;border-radius:0;text-decoration:none;font-family:'Courier New',monospace;font-size:13px;letter-spacing:1px">Rejoindre la visioconférence</a>
    </p>
    <p style="font-size:12px;color:#888;word-break:break-all">${escHtml(appt.video_link)}</p>
    <p style="margin-top:28px">À bientôt,<br><strong>${escHtml(agentName || showroomName)}</strong>${agentPhone ? `<br>${escHtml(agentPhone)}` : ''}</p>
  `;
  const { error } = await resend.emails.send({
    from: `${showroomName} <${from}>`,
    to: [appt.client_email],
    ...(showroomEmail && showroomEmail.toLowerCase() !== appt.client_email.toLowerCase() ? { bcc: [showroomEmail] } : {}),
    subject: `Lien visioconférence — votre rendez-vous ${brandName}`,
    html: emailLayout({ showroomName, brandName, content })
  });
  if (error) { console.error('[resend] video-link-email:', error.message || error); return false; }
  return true;
}

// ── Magic link accès direct portail ──────────────────────────────────
app.post('/api/admin/buyers/:id/send-access', requireRole('owner','agent'), prospectInviteLimiter, async (req, res) => {
  try {
    if (!await checkBuyerBrandScope(req, res)) return;
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
    const resend = newResendClient(resendKey);
    // Langue explicitement choisie par l'agent dans la modale d'envoi,
    // repli sur la langue enregistrée de l'acheteur si non précisée.
    const { lang } = req.body;
    const isEn = (lang === 'en' || lang === 'fr') ? lang === 'en' : buyer.lang === 'en';
    const tpl = await getEmailTemplate('access_link', isEn ? 'en' : 'fr');
    const buttonHtml = emailBtn(link, isEn ? 'ACCESS SHOWROOM →' : 'ACCÉDER AU SHOWROOM →');
    const subject = applyTemplateVars(tpl.subject, { showroom: escHtml(showroomName || '') });
    const bodyHtml = applyTemplateVars(tpl.body, { acheteur: escHtml(buyer.name), showroom: escHtml(showroomName || ''), bouton: buttonHtml });
    const { error } = await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [buyer.email],
      subject,
      html: emailLayout({ showroomName, content: bodyHtml })
    });
    if (error) { console.error('[resend] send-access:', error.message || error); return res.status(502).json({ error: 'Échec envoi email' }); }
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
    const buyer = (await pool.query('SELECT * FROM buyers WHERE id=$1', [r.rows[0].buyer_id])).rows[0];
    if (!buyer) return res.redirect('/portal');
    await pool.query('UPDATE buyer_access_tokens SET used=true WHERE token=$1', [token]);
    // Un lien magique authentifie au même niveau qu'un mot de passe — s'il
    // contournait le MFA de l'acheteur quand celui-ci est activé, n'importe quel
    // staff pouvant déclencher /api/admin/buyers/:id/send-access (agent inclus,
    // simple prérequis : une commande passée) obtiendrait un accès complet sans
    // jamais avoir à fournir le second facteur. Même passage par mfaPendingBuyer
    // que la connexion par mot de passe (/editions-showroom-b2b-portail).
    if (buyer.mfa_enabled) {
      req.session.mfaPendingBuyer = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country, next: '' };
      logAuditRaw(buyer.email, 'login_password_ok_mfa_pending', 'buyer', buyer.id, req.ip);
      return res.redirect('/editions-showroom-b2b-portail?step=mfa');
    }
    // Régénération de session — anti session fixation (même principe que les
    // autres points de connexion buyer/admin de ce fichier).
    req.session.regenerate(err => {
      if (err) return res.redirect('/portal');
      req.session.buyerPortal = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country };
      logAuditRaw(buyer.email, 'login_success', 'buyer', buyer.id, req.ip);
      req.session.save(() => res.redirect('/portal'));
    });
  } catch(e) { res.redirect('/portal'); }
});

app.post('/api/orders/:id/resend', requireRole('owner','agent'), prospectInviteLimiter, async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const pdf = await generateOrderPDF(req.params.id);
    await sendOrderEmails(req.params.id, pdf);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/orders/:id/pdf', requireRole('owner','agent','designer'), async (req, res) => {
  if (!await checkOrderBrandScope(req, res)) return;
  try {
    logAudit(req, 'download_order_pdf', 'order', req.params.id, '');
    const pdf = await generateOrderPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, private');
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

// Accès à /commande/:brandId (page + APIs publiques associées) : soit une
// session staff (owner/agent/designer, bornée à sa marque si assignée), soit
// un token /c/:token actif et non expiré pour CETTE marque. Le token est
// revérifié en base à chaque requête (pas mis en cache dans un booléen de
// session) pour qu'une révocation depuis l'admin coupe l'accès immédiatement.
// Fini l'accès direct par simple connaissance de l'UUID de la marque (P1
// audit — « aucune fonctionnalité sécurisée par une URL non devinable »).
async function hasCommandeAccess(req, brandId) {
  const role = getRole(req);
  if (role) {
    const staffBrand = req.session.staffUser?.brand_id;
    if (staffBrand && staffBrand !== brandId) return false;
    return true;
  }
  const tok = req.session?.commandeToken;
  if (!tok) return false;
  const r = await pool.query(
    'SELECT 1 FROM commande_links WHERE token=$1 AND brand_id=$2 AND active=1 AND expires_at > NOW()',
    [tok, brandId]
  );
  return !!r.rows[0];
}

const COMMANDE_ACCESS_DENIED_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Accès restreint</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f5f4f0;font-family:'Courier New',monospace;padding:32px;text-align:center;line-height:1.7}a{color:#6b8500}</style></head><body><div><p style="font-size:15px">Accès restreint.</p><p style="font-size:13px;color:#999">Ce lien de commande n'est plus valide ou a expiré. Contactez votre showroom pour en obtenir un nouveau.</p></div></body></html>`;

// Trace des refus d'accès à /commande/:brandId dans le journal d'audit —
// permet de repérer un scan/bruteforce d'UUID de marque (visible dans
// /api/admin/audit-log) même si l'entropie de l'UUID rend ça peu probable.
function logCommandeDenied(req, brandId) {
  const actor = req.session?.staffUser?.email || (req.session?.admin ? 'admin' : 'public');
  logAuditRaw(actor, 'commande_access_denied', 'brand', brandId || '', req.ip);
}

async function requireCommandeAccess(req, res, next) {
  try {
    if (await hasCommandeAccess(req, req.params.brandId)) return next();
    logCommandeDenied(req, req.params.brandId);
    res.status(403).type('html').send(COMMANDE_ACCESS_DENIED_HTML);
  } catch(e) { console.error('requireCommandeAccess:', e); res.status(500).send('Erreur serveur'); }
}

async function requireCommandeAccessBody(req, res, next) {
  try {
    const brandId = req.body?.brand_id;
    if (!brandId) return res.status(400).json({ error: 'Marque requise' });
    if (await hasCommandeAccess(req, brandId)) return next();
    logCommandeDenied(req, brandId);
    res.status(403).json({ error: 'access_denied', message: "Accès refusé — lien invalide ou expiré. Demandez un nouveau lien à votre contact showroom." });
  } catch(e) { console.error('requireCommandeAccessBody:', e); res.status(500).json({ error: 'Erreur serveur' }); }
}

// Variante JSON de requireCommandeAccess (params.brandId) pour les endpoints
// API — /commande/:brandId (page HTML) utilise requireCommandeAccess ci-dessus.
async function requireCommandeAccessParam(req, res, next) {
  try {
    if (await hasCommandeAccess(req, req.params.brandId)) return next();
    logCommandeDenied(req, req.params.brandId);
    res.status(403).json({ error: 'access_denied', message: "Accès refusé — lien invalide ou expiré. Demandez un nouveau lien à votre contact showroom." });
  } catch(e) { console.error('requireCommandeAccessParam:', e); res.status(500).json({ error: 'Erreur serveur' }); }
}

// Page publique (lien partageable agent→prospect, sans compte) mais qui affiche
// des prix wholesale/conditions commerciales confidentielles : renforcé au-delà
// du Cache-Control par défaut de sendPage() (no-cache/revalidate) vers no-store,
// pour qu'aucun proxy/cache intermédiaire ne conserve une version de la page.
app.get('/commande/:brandId', publicLimiter, requireCommandeAccess, (req, res) => sendPage(res, 'commande.html', 'no-store, private'));

// P0-04 — lien de commande privé & expirant : /c/:token → accorde l'accès (le
// token est mémorisé en session, revérifié en base à chaque usage) puis
// redirige vers la marque ; sinon page « lien expiré/invalide ».
// publicLimiter en défense en profondeur contre le brute-force du slug/token
// (jamais la seule protection : voir l'entropie du slug dans uniqueSlugFor()).
app.get('/c/:token', publicLimiter, async (req, res) => {
  try {
    const r = await pool.query('SELECT token, brand_id, expires_at, active FROM commande_links WHERE token=$1 OR slug=$1', [req.params.token]);
    const link = r.rows[0];
    if (link && link.active && new Date(link.expires_at) > new Date()) {
      // Toujours le token réel en session (pas le slug éventuellement utilisé
      // dans l'URL) : hasCommandeAccess() revérifie ensuite via la colonne
      // token, jamais slug — sinon l'accès serait refusé dès la requête suivante.
      req.session.commandeToken = link.token;
      const qs = req.query.product ? ('?product=' + encodeURIComponent(req.query.product)) : '';
      return res.redirect(302, '/commande/' + link.brand_id + qs);
    }
    // Lien invalide ou expiré : page minimaliste (au style du site), noindex hérité du header global.
    res.status(410).type('html').send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Lien expiré</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#111111;font-family:'Courier New',monospace;padding:32px;text-align:center;line-height:1.7}a{color:#6b8500}</style></head><body><div><p style="font-size:15px">Ce lien de commande a expiré.</p><p style="font-size:13px;color:#999">Contactez votre showroom pour en obtenir un nouveau.</p></div></body></html>`);
  } catch(e) { console.error('commande-link:', e); res.status(500).send('Erreur serveur'); }
});

// Génère un lien de commande expirant pour une marque (owner/agent, borné à la marque).
app.post('/api/brands/:brandId/commande-link', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const b = await pool.query('SELECT id, name FROM brands WHERE id=$1', [req.params.brandId]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
    const days = Math.min(90, Math.max(1, parseInt(req.body.days) || 30));
    const token = crypto.randomBytes(18).toString('base64url');
    const createdBy = req.session?.staffUser?.email || 'owner';
    const slug = await uniqueSlugFor('commande_links', b.rows[0].name);
    await pool.query(
      "INSERT INTO commande_links (token, brand_id, expires_at, created_by, slug) VALUES ($1,$2,NOW() + ($3 || ' days')::interval,$4,$5)",
      [token, req.params.brandId, String(days), createdBy, slug]);
    logAudit(req, 'create_commande_link', 'brand', req.params.brandId, days + 'j');
    res.json({ token, slug, url: `${getBaseUrl(req)}/c/${slug}`, days });
  } catch(e) { console.error('create commande-link:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/brands/:brandId/commande-links', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query('SELECT token, slug, expires_at, active, created_by, created_at FROM commande_links WHERE brand_id=$1 ORDER BY created_at DESC', [req.params.brandId]);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Révoque un lien de commande avant son expiration (fuite suspectée, marque désactivée, etc.)
app.put('/api/brands/:brandId/commande-link/:token/revoke', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const r = await pool.query('UPDATE commande_links SET active=0 WHERE token=$1 AND brand_id=$2', [req.params.token, req.params.brandId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Lien introuvable' });
    logAudit(req, 'revoke_commande_link', 'brand', req.params.brandId, req.params.token);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// PDF public — accessible 24h après la commande (pour share sheet mobile)
app.get('/api/public/orders/:id/pdf', publicLimiter, async (req, res) => {
  try {
    // Sécurité : l'UUID de la commande ne suffit plus — il faut le pdf_token
    // dédié (généré à la création, jamais dérivé de l'id), la commande ne doit
    // pas avoir été révoquée depuis l'admin, et la fenêtre de 24h reste une
    // défense en profondeur supplémentaire.
    const token = (req.query.token || '').toString().slice(0, 128);
    if (!token) return res.status(403).json({ error: 'Accès refusé' });
    const r = await pool.query(
      "SELECT id, pdf_token, pdf_revoked FROM orders WHERE id=$1 AND created_at > NOW() - INTERVAL '24 hours'",
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Non disponible' });
    if (r.rows[0].pdf_revoked) return res.status(403).json({ error: 'Accès révoqué' });
    const expected = (r.rows[0].pdf_token || '').padEnd(128, '_');
    const given = token.padEnd(128, '_');
    if (!r.rows[0].pdf_token || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    logAuditRaw('public-link', 'download_order_pdf', 'order', req.params.id, req.ip);
    const pdf = await generateOrderPDF(req.params.id);
    const orderNum2 = r.rows[0]?.order_number || req.params.id.slice(0,8).toUpperCase();
    const filename = `PropositionCommande-${orderNum2}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/public/cgv', async (req, res) => {
  const cgv_text = await getSetting('cgv_text');
  res.json({ cgv_text });
});

// Habillage public des pages d'entrée (connexion / demande d'accès) : rien de
// sensible ici — uniquement le nom du showroom et l'image de fond choisie
// dans Réglages (changeable à tout moment par l'owner).
app.get('/api/public/branding', async (req, res) => {
  const [showroom_name, login_bg_url, login_bg_url_mobile] = await Promise.all([
    getSetting('showroom_name'), getSetting('login_bg_url'), getSetting('login_bg_url_mobile')
  ]);
  res.json({ showroom_name: showroom_name || '', login_bg_url: login_bg_url || '', login_bg_url_mobile: login_bg_url_mobile || '' });
});

app.get('/api/public/brands/:brandId', requireCommandeAccessParam, async (req, res) => {
  const b = await pool.query("SELECT id,name,logo_url,logo,cover_image,thumbnail,cgv_text,about_text,moq_qty,moq_amount,delivery_terms,payment_terms,return_terms,TO_CHAR(order_deadline,'YYYY-MM-DD') AS order_deadline,subscription_status FROM brands WHERE id=$1", [req.params.brandId]);
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

app.post('/api/public/selection-pdf', publicLimiter, requireCommandeAccessBody, async (req, res) => {
  try {
    const { brand_id, client_name, client_email, client_company, client_country, notes, lines } = req.body;
    if (!brand_id) return res.status(400).json({ error: 'Marque requise' });
    if (!Array.isArray(lines) || lines.length > 500) return res.status(400).json({ error: 'Sélection invalide' });
    const bRes = await pool.query('SELECT * FROM brands WHERE id=$1', [brand_id]);
    const brand = bRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Marque introuvable' });
    const productIds = [...new Set((lines||[]).map(l => l.product_id))];
    // brand_id=$2 obligatoire — sans ce filtre, un product_id d'une autre marque
    // glissé dans les lignes serait résolu quand même (prix wholesale/retail
    // et catalogue d'une marque tierce exposés dans le PDF, cf. createOrder()).
    const pRes = await pool.query('SELECT * FROM products WHERE id = ANY($1) AND brand_id = $2', [productIds, brand_id]);
    const productMap = {};
    pRes.rows.forEach(p => { productMap[p.id] = p; });
    const resolvedLines = (lines||[]).filter(l => productMap[l.product_id]).map(l => ({ ...l, product: productMap[l.product_id] }));
    const showroomName = await getSetting('showroom_name');
    const agentName = await getSetting('agent_name');
    const pdf = await generateSelectionPDF({ brand, client_name, client_email, client_company, client_country, notes, lines: resolvedLines, showroomName, agentName });
    const ref = (client_name||'Selection').replace(/\s/g,'-').slice(0,20);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', `attachment; filename="Selection-${ref}-${brand.name.replace(/\s/g,'-')}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

const MAX_LINE_QTY = 100000; // garde-fou contre les quantités absurdes
async function createOrder({ brand_id, client_name, client_email, client_company, client_phone, client_country, notes, lines, buyer_signature, cgv_accepted, buyer_id }) {
  // Quantité : entier strictement positif et borné (évite floats, négatifs, valeurs démesurées).
  // Filtre d'abord les lignes non-objet (null, tableau, primitive) — sinon le spread/accès
  // à .quantity plante avant même la validation de quantité qui suit.
  const validLines = (lines || [])
    .filter(l => l && typeof l === 'object' && !Array.isArray(l))
    .map(l => ({ ...l, quantity: Math.floor(Number(l.quantity)) }))
    .filter(l => Number.isFinite(l.quantity) && l.quantity > 0 && l.quantity <= MAX_LINE_QTY);
  if (!validLines.length) return { error: 'Aucune quantité saisie' };
  if (!buyer_signature) return { error: 'Signature requise' };
  if (!cgv_accepted) return { error: 'Acceptation des CGV requise' };

  const brandCheck = await pool.query('SELECT subscription_status, moq_qty, moq_amount, moq_strict FROM brands WHERE id=$1', [brand_id]);
  if (!brandCheck.rows[0]) return { error: 'Marque introuvable' };
  if (brandCheck.rows[0].subscription_status === 'inactive') {
    return { error: 'subscription_inactive', message: 'Ce showroom est temporairement indisponible.' };
  }

  // Resolve product prices server-side (never trust client-submitted prices).
  // brand_id=$2 est obligatoire ici : sans ce filtre, un product_id d'une autre
  // marque glissé dans les lignes serait résolu quand même (prix/catalogue
  // d'une marque tiers injectés dans la commande de la marque courante).
  // active != 0 : sans ce filtre, un panier resté ouvert pendant qu'un agent
  // désactive une référence (rupture de stock, retrait catalogue) pouvait
  // encore aboutir à une commande confirmée sur ce produit — même garde déjà
  // appliquée à toutes les listes produits côté portail acheteur.
  // OR is_sample : les échantillons hors-catalogue sont créés avec active=0
  // PAR CONCEPTION (masqués du catalogue public, cf. /sample-product) mais
  // doivent rester commandables via leur product_id — les exclure ici
  // rejetait purement et simplement toute commande contenant un échantillon.
  const productIds = validLines.map(l => l.product_id);
  const productRows = await pool.query('SELECT * FROM products WHERE id = ANY($1) AND brand_id = $2 AND (active != 0 OR is_sample = true)', [productIds, brand_id]);
  const productMap = Object.fromEntries(productRows.rows.map(r => [r.id, r]));
  const resolvedLines = validLines.map(line => ({ ...line, product: productMap[line.product_id] })).filter(l => l.product);
  if (!resolvedLines.length) return { error: 'Aucun produit valide pour cette marque' };
  if (resolvedLines.length < validLines.length) {
    return { error: 'Un ou plusieurs articles de votre panier ne sont plus disponibles — veuillez actualiser la page et réessayer.' };
  }

  const totalQty = resolvedLines.reduce((s, l) => s + l.quantity, 0);
  const totalAmount = resolvedLines.reduce((s, l) => s + l.quantity * parseFloat(l.product.price || 0), 0);
  const moqQty = parseInt(brandCheck.rows[0].moq_qty) || 0;
  const moqAmount = parseFloat(brandCheck.rows[0].moq_amount) || 0;
  // moq_strict=false : minimum indicatif, pas un blocage serveur — même repli
  // que checkMoq() ci-dessus (double vérification MOQ, l'une pré-checkout,
  // l'autre ici dans createOrder, doivent rester cohérentes).
  if (brandCheck.rows[0].moq_strict) {
    if (moqQty > 0 && totalQty < moqQty) return { error: `Minimum ${moqQty} pièces requis pour cette marque (sélection actuelle : ${totalQty}).` };
    if (moqAmount > 0 && totalAmount < moqAmount) return { error: `Montant minimum de ${moqAmount.toFixed(2)} € HT requis pour cette marque (sélection actuelle : ${totalAmount.toFixed(2)} €).` };
  }

  const orderId = uuidv4();
  // Clé aléatoire dédiée (jamais l'UUID de la commande) exigée pour accéder au
  // PDF public — voir /api/public/orders/:id/pdf.
  const pdfToken = crypto.randomBytes(24).toString('base64url');
  const dedupKey = `order-dedup:${brand_id}:${buyer_id || (client_email || '').toLowerCase().trim()}`;
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    // Anti-double-soumission : un double-clic sur "Commander" ou une requête
    // rejouée après un timeout apparent côté client (ni /api/public/orders ni
    // /api/portal/checkout ne portent de clé d'idempotence) ne doit pas créer
    // deux commandes distinctes — double décrément de stock, double email/
    // notification. Le verrou consultatif transactionnel sérialise les
    // créations pour ce couple (marque, acheteur) : sans lui, deux requêtes
    // vraiment simultanées passeraient toutes les deux la vérification de
    // doublon ci-dessous avant qu'aucune n'ait committé la sienne. Fenêtre
    // courte (20s) et signature stricte (mêmes lignes/quantités/tailles) pour
    // ne jamais fusionner deux commandes réellement différentes passées coup
    // sur coup par le même acheteur.
    await dbClient.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [dedupKey]);
    const linesSignature = resolvedLines.map(l => `${l.product_id}:${l.quantity}:${l.size || ''}`).sort().join('|');
    const dupCandidates = await dbClient.query(
      `SELECT id, pdf_token, order_number FROM orders
       WHERE brand_id=$1 AND created_at > NOW() - INTERVAL '20 seconds'
         AND (($2::text IS NOT NULL AND buyer_id=$2) OR ($2::text IS NULL AND buyer_id IS NULL AND lower(client_email)=$3))
       ORDER BY created_at DESC LIMIT 5`,
      [brand_id, buyer_id || null, (client_email || '').toLowerCase().trim()]
    );
    for (const cand of dupCandidates.rows) {
      const candLines = (await dbClient.query('SELECT product_id, quantity, size FROM order_lines WHERE order_id=$1', [cand.id])).rows;
      const candSignature = candLines.map(l => `${l.product_id}:${l.quantity}:${l.size || ''}`).sort().join('|');
      if (candSignature === linesSignature) {
        await dbClient.query('COMMIT');
        return { order_id: cand.id, pdf_token: cand.pdf_token, order_number: cand.order_number };
      }
    }
    const seqRes = await dbClient.query("SELECT LPAD(nextval('order_number_seq')::TEXT, 4, '0') AS num");
    const orderNumber = 'ES-' + seqRes.rows[0].num;
    await dbClient.query(
      `INSERT INTO orders (id,brand_id,client_name,client_email,client_company,client_phone,client_country,notes,status,buyer_signature,cgv_accepted,buyer_id,order_number,pdf_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11,$12,$13)`,
      [orderId, brand_id, client_name, client_email, client_company||'', client_phone||'', client_country||'', notes||'', buyer_signature||'', cgv_accepted?1:0, buyer_id||null, orderNumber, pdfToken]
    );
    for (const line of resolvedLines) {
      // Décrément du stock si suivi : décrément atomique et conditionnel
      // (verrou ligne + garde stock_qty >= quantité) → évite le sur-engagement
      // et les conditions de course entre commandes simultanées.
      if (line.product.stock_enabled && line.product.stock_qty !== null) {
        const upd = await dbClient.query(
          'UPDATE products SET stock_qty = stock_qty - $1 WHERE id=$2 AND stock_enabled=true AND stock_qty IS NOT NULL AND stock_qty >= $1',
          [line.quantity, line.product_id]
        );
        if (upd.rowCount === 0) {
          const err = new Error('stock_insuffisant');
          err.stockRef = line.product.reference || line.product_id;
          throw err;
        }
      }
      await dbClient.query(
        'INSERT INTO order_lines (id,order_id,product_id,size,quantity,unit_price,price_retail,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [uuidv4(), orderId, line.product_id, line.size||'', line.quantity, line.product.price, line.product.price_retail||0, line.note||'']
      );
    }
    await dbClient.query('COMMIT');
  } catch(e) {
    await dbClient.query('ROLLBACK');
    if (e && e.message === 'stock_insuffisant') {
      return { error: `Stock insuffisant pour la référence ${e.stockRef}. Rafraîchissez votre sélection.` };
    }
    return { error: 'Erreur lors de la création de la commande' };
  } finally {
    dbClient.release();
  }

  await addOrderEvent(orderId, 'created', 'Commande passée par l\'acheteur', client_name || client_email || 'buyer');

  try {
    const pdf = await generateOrderPDF(orderId);
    await sendOrderEmails(orderId, pdf);
  } catch(e) { console.error('PDF/email error:', e.message, '| code:', e.code, '| errno:', e.errno, '| host:', e.host || '', '| port:', e.port || ''); }

  const totRes = await pool.query('SELECT SUM(quantity * unit_price) as total FROM order_lines WHERE order_id=$1', [orderId]);
  const orderTotal = parseFloat(totRes.rows[0]?.total || 0);
  syncAirtable(client_email, client_company, client_name, orderTotal).catch(e => console.error('Airtable sync error:', e.message));

  // Push notification Web Push vers admins
  const brandNameForPush = (await pool.query('SELECT name FROM brands WHERE id=$1', [brand_id]).catch(() => ({ rows: [] }))).rows[0]?.name || '';
  sendPushToAdmins('Nouvelle commande', `${client_name} — ${brandNameForPush}`, brand_id).catch(e => console.error('[push-order-error]', e.message));
  notifyOwnerOrder(orderId, 'Nouvelle commande').catch(() => {}); // copie email au propriétaire

  return { order_id: orderId, total: orderTotal, pdf_token: pdfToken };
}

app.post('/api/public/orders', publicLimiter, requireCommandeAccessBody, async (req, res) => {
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
    res.json({ ok: true, order_id: result.order_id, pdf_token: result.pdf_token });
  } catch(e) {
    console.error('createOrder error:', e.message);
    res.status(500).json({ error: 'Erreur serveur lors de la création de la commande.' });
  }
});

// ==================== SÉLECTION AGENT (préparée en RDV, confirmée par l'acheteur) ====================

// 1) L'agent prépare une sélection pour un acheteur et lui envoie un lien
// Réservé à l'agence (owner/agent) : l'envoi d'une sélection est un contact
// acheteur direct — une marque ne doit pas pouvoir solliciter les acheteurs.
app.post('/api/brands/:brandId/agent-selection', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const { client_name, client_email, client_company, notes, items } = req.body;
    if (!client_email || typeof client_email !== 'string' || !client_email.includes('@')) return res.status(400).json({ error: 'Email acheteur valide requis' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Sélectionnez au moins un article' });
    // Une sélection = une liste de RÉFÉRENCES ; l'acheteur fixe les quantités lui-même sur
    // /selection/, donc on accepte des lignes sans quantité (quantity 0) — même règle que
    // PUT /api/agent-selections/:token/items pour l'édition d'une sélection existante.
    const validItems = items.filter(i => i && typeof i === 'object' && i.product_id);
    if (!validItems.length) return res.status(400).json({ error: 'Sélectionnez au moins un article' });
    const brandId = req.params.brandId;
    const b = await pool.query('SELECT name FROM brands WHERE id=$1', [brandId]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
    // Ne garder que des product_id appartenant réellement à cette marque : sinon le
    // catalogue/prix d'une autre marque peut être injecté dans la sélection envoyée à l'acheteur.
    const candidateIds = [...new Set(validItems.map(i => i.product_id).filter(Boolean))];
    const ownProducts = candidateIds.length
      ? await pool.query('SELECT id FROM products WHERE id = ANY($1) AND brand_id = $2', [candidateIds, brandId])
      : { rows: [] };
    const ownProductIds = new Set(ownProducts.rows.map(r => r.id));
    const cleanItems = validItems.filter(i => ownProductIds.has(i.product_id)).map(i => ({ product_id: i.product_id, size: i.size || '', quantity: Math.max(0, parseInt(i.quantity) || 0), note: typeof i.note === 'string' ? i.note.trim().slice(0, 300) : '' }));
    if (!cleanItems.length) return res.status(400).json({ error: 'Sélectionnez au moins un article' });
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

async function sendAgentSelectionEmail({ email, name, brandName, selectionNumber, url, req, lang, reminder = false }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('RESEND_API_KEY non configurée — email sélection agent non envoyé'); return; }
  const resend = newResendClient(resendKey);
  const showroomName = await getSetting('showroom_name');
  const fromField = (await getSetting('smtp_from')) || 'showroom@editionsstandard.com';
  const ownerEmail = await getSetting('showroom_email'); // copie (BCC) au propriétaire
  // Lookup buyer lang if not provided
  if (!lang) {
    const bLang = await pool.query('SELECT lang FROM buyers WHERE email=$1', [email.toLowerCase().trim()]).catch(() => ({ rows: [] }));
    lang = bLang.rows[0]?.lang || 'fr';
  }
  const isEn = lang === 'en';
  const numLabel = selectionNumber ? (isEn ? ` — Ref. ${selectionNumber}` : ` — Réf. ${selectionNumber}`) : '';
  const reminderLine = reminder
    ? (isEn
        ? `<p style="background:rgba(224,176,58,.1);border-left:3px solid #d4a017;padding:10px 14px;font-size:13px;color:#8a6500;margin:0 0 16px">Friendly reminder — your selection is still waiting and its link will expire soon.</p>`
        : `<p style="background:rgba(224,176,58,.1);border-left:3px solid #d4a017;padding:10px 14px;font-size:13px;color:#8a6500;margin:0 0 16px">Petit rappel — votre sélection vous attend toujours et son lien va bientôt expirer.</p>`)
    : '';
  // Le SDK Resend ne lève PAS d'exception sur une erreur API (clé invalide,
  // quota dépassé, destinataire refusé…) — il résout avec { data: null, error }.
  // Sans cette vérification, un envoi réellement échoué serait considéré comme
  // réussi par tout appelant (ex. la validation manuelle des relances, où
  // marquer "envoyé" à tort casserait la garantie qu'on vient d'introduire).
  const { error } = await resend.emails.send({
    from: `${showroomName} <${fromField}>`,
    to: [email],
    ...(ownerEmail ? { replyTo: ownerEmail } : {}), // réponses de l'acheteur → showroom
    ...(ownerEmail && ownerEmail.toLowerCase() !== email.toLowerCase() ? { bcc: [ownerEmail] } : {}),
    subject: isEn
      ? `${reminder ? 'Reminder — ' : ''}Your ${brandName} selection${numLabel} — to confirm`
      : `${reminder ? 'Rappel — ' : ''}Votre sélection ${brandName}${numLabel} — à valider`,
    html: emailLayout({ showroomName, content: isEn ? `
      <p>Hello${name ? ' <strong>' + escHtml(name) + '</strong>' : ''},</p>
      ${reminderLine}
      <p>A <strong>${escHtml(brandName)}</strong> selection has been prepared for you during our appointment.</p>
      ${selectionNumber ? `<p style="font-size:13px;color:#888">Reference: <strong>${escHtml(selectionNumber)}</strong></p>` : ''}
      <p>Click below to view it, create your account, and confirm your order:</p>
      ${emailBtn(url, 'View and confirm my selection →')}
      <p style="font-size:13px;color:#888;margin-top:28px">This link is valid for 30 days.</p>
      <p>Best regards,<br><strong>${showroomName}</strong></p>
    ` : `
      <p>Bonjour${name ? ' <strong>' + escHtml(name) + '</strong>' : ''},</p>
      ${reminderLine}
      <p>Une sélection <strong>${escHtml(brandName)}</strong> a été préparée pour vous lors de notre rendez-vous.</p>
      ${selectionNumber ? `<p style="font-size:13px;color:#888">Référence : <strong>${escHtml(selectionNumber)}</strong></p>` : ''}
      <p>Cliquez ci-dessous pour la consulter, créer votre accès et la valider :</p>
      ${emailBtn(url, 'Voir et valider ma sélection →')}
      <p style="font-size:13px;color:#888;margin-top:28px">Ce lien est valable 30 jours.</p>
      <p>Cordialement,<br><strong>${showroomName}</strong></p>
    ` })
  });
  if (error) throw new Error(`Resend: ${error.message || error.name || 'échec envoi'}`);
}

// ── Notifications email au propriétaire (traçabilité sélections & commandes) ──
// Aperçu texte pour une notification push à partir du HTML d'un email owner —
// simple retrait de balises, aucune mise en forme requise pour un aperçu court.
function stripHtmlForPush(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

async function notifyOwner(subject, contentHtml) {
  // Push indépendant de l'email : deux canaux distincts (VAPID vs RESEND_API_KEY),
  // l'un ne doit jamais bloquer ni conditionner l'autre — sinon toute l'activité
  // du site (nouvelle commande, message acheteur, RDV, statut modifié…) qui passe
  // par notifyOwner() resterait invisible en push tant que l'email n'est pas
  // configuré, alors que les deux canaux sont indépendants pour l'utilisateur.
  sendPushToAdmins(subject, stripHtmlForPush(contentHtml)).catch(() => {});
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return;
    const [ownerEmail, showroomName, fromAddress] = await Promise.all([
      getSetting('showroom_email'), getSetting('showroom_name'), getSetting('smtp_from')
    ]);
    if (!ownerEmail) return; // pas d'adresse propriétaire configurée dans Réglages
    const resend = newResendClient(resendKey);
    const { error } = await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [ownerEmail],
      subject,
      html: emailLayout({ showroomName, content: contentHtml })
    });
    if (error) console.error('[resend] notifyOwner:', error.message || error);
  } catch(e) { console.error('notifyOwner:', e.message); }
}

async function notifyOwnerOrder(orderId, actionLabel, extraNote) {
  try {
    const o = (await pool.query(
      `SELECT o.*, b.name AS brand_name,
              COALESCE((SELECT SUM(ol.quantity * ol.unit_price) FROM order_lines ol WHERE ol.order_id=o.id),0) AS total
       FROM orders o JOIN brands b ON b.id=o.brand_id WHERE o.id=$1`, [orderId]
    )).rows[0];
    if (!o) return;
    const num = o.order_number || o.id.slice(0, 8);
    await notifyOwner(
      `${actionLabel} — ${o.client_company || o.client_name || ''} (${o.brand_name})`,
      `<p><strong>${escHtml(actionLabel)}</strong></p>
       ${extraNote ? `<p style="color:#666666;font-size:13px">${escHtml(extraNote)}</p>` : ''}
       <table style="margin:14px 0;font-size:13px;border-collapse:collapse">
         <tr><td style="padding:3px 14px 3px 0;color:#888">N°</td><td><strong>${escHtml(num)}</strong></td></tr>
         <tr><td style="padding:3px 14px 3px 0;color:#888">Client</td><td>${escHtml(o.client_name||'')}${o.client_company?(' — '+escHtml(o.client_company)):''}</td></tr>
         <tr><td style="padding:3px 14px 3px 0;color:#888">Email</td><td>${escHtml(o.client_email||'')}</td></tr>
         <tr><td style="padding:3px 14px 3px 0;color:#888">Marque</td><td>${escHtml(o.brand_name)}</td></tr>
         <tr><td style="padding:3px 14px 3px 0;color:#888">Total</td><td><strong>${Number(o.total).toFixed(2)} € HT</strong></td></tr>
         <tr><td style="padding:3px 14px 3px 0;color:#888">Statut</td><td>${escHtml(o.status||'')}</td></tr>
       </table>
       <p style="font-size:12px;color:#888">Détails dans votre admin → Commandes.</p>`
    );
  } catch(e) { console.error('notifyOwnerOrder:', e.message); }
}

// 2) L'acheteur ouvre le lien : page de confirmation
app.get('/selection/:token', (req, res) => sendPage(res, 'selection.html'));

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
    const ids = [...new Set(items.map(i => i.product_id))];
    const prods = await pool.query('SELECT id, reference, description, color, composition, price, price_retail, image_url, images, sizes FROM products WHERE id = ANY($1)', [ids]);
    const pmap = Object.fromEntries(prods.rows.map(p => [p.id, p]));
    // Regroupe par référence : le client choisit lui-même les quantités par taille.
    // Les quantités éventuellement pré-remplies par l'agent servent de valeurs de départ.
    const byProduct = {};
    for (const it of items) {
      const p = pmap[it.product_id]; if (!p) continue;
      if (!byProduct[it.product_id]) byProduct[it.product_id] = { product: p, preset: {}, note: '' };
      const sz = (it.size || '').toString();
      byProduct[it.product_id].preset[sz] = (byProduct[it.product_id].preset[sz] || 0) + (parseInt(it.quantity) || 0);
      if (it.note && !byProduct[it.product_id].note) byProduct[it.product_id].note = it.note;
    }
    const references = ids.map(id => byProduct[id]).filter(Boolean);
    const lines = items.map(i => ({ ...i, product: pmap[i.product_id] })).filter(l => l.product); // compat
    const existingBuyer = await pool.query('SELECT 1 FROM buyers WHERE email=$1', [sel.client_email]);
    res.json({
      brand: b.rows[0],
      client: { name: sel.client_name, email: sel.client_email, company: sel.client_company },
      notes: sel.notes,
      references,
      lines,
      account_exists: existingBuyer.rows.length > 0
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// 4) L'acheteur crée son compte (ou se connecte) et valide la commande
app.post('/api/selection/:token/confirm', confirmLimiter, async (req, res) => {
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
      if (!password || password.length < 12) return res.status(400).json({ error: 'Choisissez un mot de passe (12 caractères minimum)' });
      const hash = await bcrypt.hash(password, 10);
      const id = uuidv4();
      await pool.query('INSERT INTO buyers (id, email, password_hash, name, company) VALUES ($1,$2,$3,$4,$5)',
        [id, email, hash, sel.client_name || '', sel.client_company || '']);
      buyer = { id, email, name: sel.client_name || '', company: sel.client_company || '', phone: '', country: '' };
    }

    // Lignes : le client fixe lui-même les quantités par taille. On valide chaque ligne
    // contre les références de la sélection et leurs tailles réellement disponibles.
    const stored = JSON.parse(sel.items_json || '[]');
    const selectedIds = new Set(stored.map(i => i.product_id));
    const prodRows = (await pool.query('SELECT id, sizes FROM products WHERE id = ANY($1)', [[...selectedIds]])).rows;
    const sizeMap = Object.fromEntries(prodRows.map(p => [p.id, (p.sizes || '').split(',').map(s => s.trim()).filter(Boolean)]));
    const submitted = Array.isArray(lines) ? lines : stored; // repli : quantités stockées si rien n'est fourni
    // Agrège par product_id|size et ne garde que le valide
    const agg = {};
    for (const l of submitted) {
      if (!l || typeof l !== 'object') continue;
      const pid = l.product_id;
      if (!selectedIds.has(pid)) continue;                       // uniquement les références de la sélection
      const sz = (l.size || '').toString();
      const validSizes = sizeMap[pid] || [];
      if (validSizes.length && sz && !validSizes.includes(sz)) continue; // taille inexistante ignorée
      const q = parseInt(l.quantity) || 0;
      if (q <= 0) continue;
      agg[pid + '|' + sz] = (agg[pid + '|' + sz] || 0) + q;
    }
    const finalLines = Object.entries(agg).map(([k, quantity]) => {
      const idx = k.lastIndexOf('|');
      return { product_id: k.slice(0, idx), size: k.slice(idx + 1), quantity };
    });
    if (!finalLines.length) return res.status(400).json({ error: 'Veuillez indiquer au moins une quantité.' });

    // Réclame la sélection de façon atomique juste avant de créer la commande —
    // le "if (sel.used)" plus haut est lu depuis un SELECT fait avant toute la
    // validation mot de passe/tailles ci-dessus ; deux soumissions quasi
    // simultanées (double-clic, deux onglets) le passaient toutes les deux et
    // créaient chacune une commande complète (double décompte de stock, double
    // email, sélection consommée deux fois). Seule cette UPDATE conditionnelle
    // fait foi : une seule requête concurrente peut gagner la ligne WHERE used=false.
    const claim = await pool.query('UPDATE agent_selections SET used=true WHERE token=$1 AND used=false RETURNING token', [req.params.token]);
    if (!claim.rows.length) return res.status(410).json({ error: 'Cette sélection a déjà été validée.' });

    const result = await createOrder({
      brand_id: sel.brand_id, client_name: buyer.name || sel.client_name, client_email: email,
      client_company: buyer.company || sel.client_company, client_phone: buyer.phone, client_country: buyer.country,
      notes: sel.notes, lines: finalLines, buyer_signature: signature, cgv_accepted: cgv_accepted ? 1 : 0, buyer_id: buyer.id
    });
    if (result.error) {
      // La commande a échoué (MOQ non atteint, marque désactivée...) : on
      // libère la sélection réclamée ci-dessus pour ne pas la rendre
      // définitivement inutilisable alors qu'aucune commande n'a été créée.
      await pool.query('UPDATE agent_selections SET used=false WHERE token=$1', [req.params.token]);
      return res.status(result.error === 'subscription_inactive' ? 403 : 400).json(result);
    }
    // P0-08 — journalise la signature/validation (preuve en cas de litige) :
    // acteur = acheteur, horodatage (NOW), commande, IP + acceptation CGV.
    pool.query('INSERT INTO admin_audit_log (id,user_email,action,target_type,target_id,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
      [uuidv4(), email, 'order_signed', 'order', result.order_id, `Sélection ${sel.selection_number || sel.token.slice(0,8)} validée et signée · CGV acceptées · IP ${req.ip || ''}`]).catch(e => console.error('audit order_signed:', e.message));
    // Connecte l'acheteur
    req.session.regenerate(err => {
      if (err) return res.json({ ok: true, order_id: result.order_id });
      req.session.buyerPortal = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country };
      // Sauvegarde explicite avant de répondre : le JS client enchaîne
      // généralement sur un appel authentifié juste après ce {ok:true}, qui
      // échouerait si la nouvelle session n'est pas encore garantie persistée.
      req.session.save(() => res.json({ ok: true, order_id: result.order_id }));
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── Templates de sélection agent ─────────────────────────────────────

// Sauvegarder une sélection comme template
app.post('/api/agent-selections/:token/save-as-template', requireRole('owner','agent'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const sel = await pool.query('SELECT brand_id FROM agent_selections WHERE token=$1', [req.params.token]);
  if (!sel.rows[0]) return res.status(404).json({ error: 'Sélection introuvable' });
  if (isBrandScoped(req) && sel.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
  await pool.query('UPDATE agent_selections SET is_template=true, template_name=$1 WHERE token=$2', [name, req.params.token]);
  res.json({ ok: true });
});

// Lister les templates (agent scopé : uniquement ceux de sa marque)
app.get('/api/agent-selections/templates', requireRole('owner','agent','designer'), async (req, res) => {
  const scoped = isBrandScoped(req);
  const r = await pool.query(
    `SELECT token, template_name, brand_id, items_json, created_at, selection_number FROM agent_selections WHERE is_template=true ${scoped ? 'AND brand_id=$1' : ''} ORDER BY created_at DESC`,
    scoped ? [req.userBrandId] : []
  );
  res.json(r.rows);
});

// Créer une sélection depuis un template (copie)
app.post('/api/agent-selections/:token/use-template', requireRole('owner','agent'), async (req, res) => {
  const { client_name, client_email, client_company } = req.body;
  if (!client_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(client_email).trim())) return res.status(400).json({ error: 'Email acheteur valide requis' });
  const src = await pool.query('SELECT * FROM agent_selections WHERE token=$1 AND is_template=true', [req.params.token]);
  if (!src.rows[0]) return res.status(404).json({ error: 'Template introuvable' });
  const t = src.rows[0];
  if (isBrandScoped(req) && t.brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
  const newToken = uuidv4();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const numRes = await pool.query("SELECT nextval('selection_number_seq') as n");
  const selNum = 'SEL-' + String(numRes.rows[0].n).padStart(4, '0');
  await pool.query(
    `INSERT INTO agent_selections (token,brand_id,client_name,client_email,client_company,items_json,notes,created_by,expires_at,selection_number,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sent')`,
    [newToken, t.brand_id, client_name||'', client_email||'', client_company||'', t.items_json, t.notes||'', t.created_by||'', expires, selNum]
  );
  res.json({ token: newToken, selection_number: selNum });
});

// ==================== BUYER PORTAL (email + password, multi-brand) ====================

function requireBuyerAuth(req, res, next) {
  if (!req.session?.buyerPortal) return res.status(401).json({ error: 'Non connecté' });
  if (isSessionFresh(req, BUYER_IDLE_TIMEOUT_MS, BUYER_ABSOLUTE_TIMEOUT_MS)) return next();
  return req.session.destroy(() => res.status(401).json({ error: 'Session expirée, reconnectez-vous.' }));
}

// Ancien lien conservé pour compatibilité
app.get('/portal-login', (req, res) => res.redirect('/editions-showroom-b2b-portail'));

// Même correction que /admin/login : un acheteur déjà connecté qui revient
// ici (bouton Précédent) est redirigé plutôt que de revoir un formulaire de
// connexion (potentiellement figé sur l'étape MFA).
app.get('/editions-showroom-b2b-portail', (req, res) => {
  if (req.session?.buyerPortal) return res.redirect('/portal');
  sendPage(res, 'portal-login.html');
});

// Redirection post-login (next=) : n'accepte qu'un chemin RELATIF sous /portal
// (pas de schéma, pas d'hôte, pas de // protocol-relative, pas de .. ni de
// caractères non listés) — empêche toute redirection ouverte vers un site tiers.
function isSafeNextPath(next) {
  if (typeof next !== 'string' || !next) return false;
  if (!/^\/portal(?:[/?][a-zA-Z0-9?=&%_\-/]*)?$/.test(next)) return false;
  if (next.startsWith('//') || next.includes('..') || next.includes('\\')) return false;
  return true;
}

app.post('/editions-showroom-b2b-portail', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const r = await pool.query('SELECT id, email, name, company, phone, country, password_hash, mfa_enabled, locked_until FROM buyers WHERE email=$1', [(email||'').toLowerCase().trim()]);
  const buyer = r.rows[0];
  const safeNext = isSafeNextPath(req.body.next) ? req.body.next : '';
  const passwordOk = await bcrypt.compare(password || '', buyer?.password_hash || DUMMY_BCRYPT_HASH);
  const locked = isLocked(buyer);
  if (buyer && passwordOk && !locked) {
    await clearLoginFailures('buyers', buyer.id);
    if (buyer.mfa_enabled) {
      // Mot de passe correct mais MFA active côté acheteur : pas de session
      // privilégiée tant que le code TOTP n'est pas vérifié (même principe
      // que côté admin — voir /admin/login/mfa).
      req.session.mfaPendingBuyer = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country, next: safeNext };
      logAuditRaw(buyer.email, 'login_password_ok_mfa_pending', 'buyer', buyer.id, req.ip);
      return res.redirect('/editions-showroom-b2b-portail?step=mfa');
    }
    // Régénération de session — anti session fixation
    req.session.regenerate(err => {
      if (err) return res.redirect('/editions-showroom-b2b-portail?error=1');
      req.session.buyerPortal = { id: buyer.id, email: buyer.email, name: buyer.name, company: buyer.company, phone: buyer.phone, country: buyer.country };
      logAuditRaw(buyer.email, 'login_success', 'buyer', buyer.id, req.ip);
      // Sauvegarde explicite avant redirection — voir commentaire équivalent
      // sur /admin/login/mfa (évite un rebond côté navigateur si le 302 est
      // suivi avant la persistance garantie de la nouvelle session).
      req.session.save(err2 => err2 ? res.redirect('/editions-showroom-b2b-portail?error=1') : res.redirect(safeNext || '/portal'));
    });
    return;
  }
  const failNext = safeNext ? '&next=' + encodeURIComponent(safeNext) : '';
  if (buyer && locked) {
    logAuditRaw(buyer.email, 'login_blocked_locked', 'buyer', buyer.id, req.ip);
    return res.redirect('/editions-showroom-b2b-portail?error=locked' + failNext);
  }
  if (buyer) await recordLoginFailure('buyers', buyer.id);
  logAuditRaw((email||'').toLowerCase().trim(), 'login_failed', 'buyer', '', req.ip);
  res.redirect('/editions-showroom-b2b-portail?error=1' + failNext);
});

// Étape 2 du login acheteur : vérification du code TOTP (ou code de secours),
// identique dans le principe à /admin/login/mfa.
app.post('/editions-showroom-b2b-portail/mfa', loginLimiter, async (req, res) => {
  const pending = req.session.mfaPendingBuyer;
  if (!pending) return res.redirect('/editions-showroom-b2b-portail');
  const code = (req.body.code || '').toString().trim();
  const backupCode = (req.body.backup_code || '').toString().trim();
  let ok = false, usedBackup = false;

  const r = await pool.query('SELECT mfa_secret, mfa_backup_codes FROM buyers WHERE id=$1', [pending.id]);
  const row = r.rows[0];
  if (row?.mfa_secret) {
    const step = currentTotpStep();
    if (code && authenticator.check(code, row.mfa_secret)) {
      // Anti-rejeu atomique — cf. commentaire équivalent sur /admin/login/mfa :
      // l'UPDATE conditionnel garantit qu'une seule requête concurrente avec le
      // même code peut réclamer ce pas de temps.
      const claim = await pool.query('UPDATE buyers SET mfa_last_step=$1 WHERE id=$2 AND mfa_last_step IS DISTINCT FROM $1 RETURNING id', [step, pending.id]);
      ok = claim.rowCount > 0;
    } else if (backupCode) {
      const updated = consumeBackupCode(row.mfa_backup_codes, backupCode);
      if (updated) {
        const claim = await pool.query('UPDATE buyers SET mfa_backup_codes=$1 WHERE id=$2 AND mfa_backup_codes=$3 RETURNING id', [JSON.stringify(updated), pending.id, row.mfa_backup_codes]);
        ok = usedBackup = claim.rowCount > 0;
      }
    }
  }

  if (!ok) {
    logAuditRaw(pending.email, 'login_mfa_failed', 'buyer', pending.id, req.ip);
    return res.redirect('/editions-showroom-b2b-portail?step=mfa&error=1');
  }

  req.session.regenerate(err => {
    if (err) return res.redirect('/editions-showroom-b2b-portail?error=1');
    req.session.buyerPortal = { id: pending.id, email: pending.email, name: pending.name, company: pending.company, phone: pending.phone, country: pending.country };
    logAuditRaw(pending.email, usedBackup ? 'login_success_mfa_backup' : 'login_success_mfa', 'buyer', pending.id, req.ip);
    req.session.save(err2 => err2 ? res.redirect('/editions-showroom-b2b-portail?error=1') : res.redirect(pending.next || '/portal'));
  });
});

app.get('/portal-logout', (req, res) => {
  const email = req.session?.buyerPortal?.email || 'unknown';
  const id = req.session?.buyerPortal?.id || '';
  logAuditRaw(email, 'logout', 'buyer', id, req.ip);
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
  sendPage(res, 'portal.html');
});

app.get('/api/portal/me', requireBuyerAuth, async (req, res) => {
  const [agent_name, agent_title, agent_phone, showroom_name] = await Promise.all([
    getSetting('agent_name'), getSetting('agent_title'), getSetting('agent_phone'), getSetting('showroom_name')
  ]);
  res.json({ ...req.session.buyerPortal, agent_name, agent_title, agent_phone, showroom_name });
});

app.get('/api/portal/currencies', requireBuyerAuth, async (req, res) => {
  let currencies = [];
  try { currencies = JSON.parse(await getSetting('currencies_json') || '[]'); } catch(e) {}
  res.json(currencies);
});

// Invalide toutes les sessions actives d'un acheteur (sauf, optionnellement,
// la session en cours) après un changement de mot de passe — une session déjà
// ouverte sur un appareil volé/partagé ne doit pas survivre au changement.
async function invalidateBuyerSessions(buyerId, exceptSid) {
  try {
    await pool.query(
      "DELETE FROM user_sessions WHERE sess->'buyerPortal'->>'id' = $1 AND sid != COALESCE($2, '')",
      [buyerId, exceptSid || null]
    );
  } catch(e) { console.error('invalidateBuyerSessions:', e.message); }
}

app.post('/api/portal/change-password', requireBuyerAuth, passwordLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
  if (newPassword.length < 12) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 12 caractères' });

  const r = await pool.query('SELECT id, password_hash FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
  const buyer = r.rows[0];
  if (!buyer || !await bcrypt.compare(currentPassword, buyer.password_hash)) {
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE buyers SET password_hash=$1 WHERE id=$2', [hash, buyer.id]);
  await invalidateBuyerSessions(buyer.id, req.sessionID);
  res.json({ ok: true });
});

// ── MFA acheteur (optionnelle, self-service depuis « Mon profil ») ──────
app.get('/api/portal/mfa/status', requireBuyerAuth, async (req, res) => {
  const r = await pool.query('SELECT mfa_enabled FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
  res.json({ enabled: !!r.rows[0]?.mfa_enabled });
});

app.post('/api/portal/mfa/setup', requireBuyerAuth, passwordLimiter, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const uri = authenticator.keyuri(req.session.buyerPortal.email, 'Showroom Editions Standard', secret);
    const qr = await QRCode.toDataURL(uri);
    await pool.query('UPDATE buyers SET mfa_pending_secret=$1 WHERE id=$2', [secret, req.session.buyerPortal.id]);
    res.json({ secret, qr, uri });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/portal/mfa/confirm', requireBuyerAuth, passwordLimiter, async (req, res) => {
  try {
    const code = (req.body.code || '').toString().trim();
    const r = await pool.query('SELECT mfa_pending_secret FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
    const secret = r.rows[0]?.mfa_pending_secret;
    if (!secret || !code || !authenticator.check(code, secret)) return res.status(400).json({ error: 'Code invalide. Vérifiez l\'heure de votre appareil et réessayez.' });
    const { plain, hashed } = generateBackupCodes();
    await pool.query('UPDATE buyers SET mfa_secret=$1, mfa_pending_secret=NULL, mfa_enabled=true, mfa_backup_codes=$2 WHERE id=$3', [secret, JSON.stringify(hashed), req.session.buyerPortal.id]);
    logAudit(req, 'mfa_enabled', 'buyer', req.session.buyerPortal.id, '');
    res.json({ ok: true, backup_codes: plain });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/portal/mfa/disable', requireBuyerAuth, passwordLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    const r = await pool.query('SELECT password_hash FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
    if (!r.rows[0] || !await bcrypt.compare(password || '', r.rows[0].password_hash)) return res.status(403).json({ error: 'Mot de passe incorrect' });
    await pool.query('UPDATE buyers SET mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled=false, mfa_backup_codes=NULL WHERE id=$1', [req.session.buyerPortal.id]);
    logAudit(req, 'mfa_disabled', 'buyer', req.session.buyerPortal.id, '');
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
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

// RGPD — anonymise les commandes (conservation légale des montants/lignes)
// puis supprime le compte, le tout dans une transaction pour éviter un état
// incohérent en cas d'échec. Couvre TOUS les champs personnels de la commande
// — pas seulement nom/email/téléphone : la société, le pays et surtout la
// signature manuscrite (image) restaient jusqu'ici intacts après une demande
// d'effacement, ce qui videait la demande de son sens sur ces champs-là.
async function anonymizeAndDeleteBuyer(buyerId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(
      `UPDATE orders SET client_name='[Supprimé]', client_email='deleted@deleted', client_phone='',
         client_company='', client_country='', notes='', buyer_signature='', agent_signature=NULL, buyer_id=NULL
       WHERE buyer_id=$1`,
      [buyerId]
    );
    await dbClient.query('DELETE FROM buyers WHERE id=$1', [buyerId]);
    await dbClient.query('COMMIT');
  } catch(e) {
    await dbClient.query('ROLLBACK');
    throw e;
  } finally {
    dbClient.release();
  }
}

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
    await anonymizeAndDeleteBuyer(buyerId);
    req.session.destroy(() => {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur lors de la suppression' }); }
});

app.post('/api/portal/update-profile', requireBuyerAuth, async (req, res) => {
  const { name, company, phone, country } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom est requis' });
  const c = String(company||'').trim(), ph = String(phone||'').trim(), co = String(country||'').trim();
  await pool.query('UPDATE buyers SET name=$1, company=$2, phone=$3, country=$4 WHERE id=$5',
    [name.trim(), c, ph, co, req.session.buyerPortal.id]);
  req.session.buyerPortal = { ...req.session.buyerPortal, name: name.trim(), company: c, phone: ph, country: co };
  res.json({ ok: true });
});

// ── Historique commandes acheteur ───────────────────────────────────
app.get('/api/portal/my-orders', requireBuyerAuth, async (req, res) => {
  try {
    const buyerId = req.session.buyerPortal.id;
    const ordersRes = await pool.query(`
      SELECT o.id, o.order_number, o.status, o.created_at, o.notes,
             b.name as brand_name
      FROM orders o
      JOIN brands b ON o.brand_id = b.id
      WHERE o.buyer_id = $1
      ORDER BY o.created_at DESC
    `, [buyerId]);

    const orders = await Promise.all(ordersRes.rows.map(async o => {
      const linesRes = await pool.query(`
        SELECT ol.size, ol.quantity, ol.unit_price, ol.price_retail,
               p.reference, p.color, p.description
        FROM order_lines ol
        JOIN products p ON ol.product_id = p.id
        WHERE ol.order_id = $1
        ORDER BY p.reference
      `, [o.id]);
      return { ...o, lines: linesRes.rows };
    }));

    res.json(orders);
  } catch(e) { console.error('my-orders:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── Favoris persistants acheteur ─────────────────────────────────────
app.get('/api/portal/favorites', requireBuyerAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT favorites_json FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
    let favs = [];
    try { favs = JSON.parse(r.rows[0]?.favorites_json || '[]'); } catch(e) {}
    res.json(favs);
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Marques actuellement verrouillées (accès anticipé, acheteur non privilégié)
// parmi un lot de brand_id — même règle que GET /api/portal/brands/:brandId/products
// (early_access_until + buyer_brand_terms.is_privileged), mais réutilisable pour
// tout endpoint qui résout des produits par ID à travers plusieurs marques à la
// fois (favoris, recherche, envoi de sélection par email…). Sans ce filtre
// répliqué partout où un product_id est résolu, la vignette "verrouillée" du
// catalogue n'est qu'un habillage client-side contournable en récupérant le
// même produit via un de ces autres chemins.
async function getLockedBrandIds(buyerId, brandIds) {
  const uniqueIds = [...new Set(brandIds)].filter(Boolean);
  if (!uniqueIds.length) return new Set();
  const rows = (await pool.query(
    `SELECT b.id, b.early_access_until, bt.is_privileged
     FROM brands b LEFT JOIN buyer_brand_terms bt ON bt.brand_id = b.id AND bt.buyer_id = $2
     WHERE b.id = ANY($1)`,
    [uniqueIds, buyerId]
  )).rows;
  const now = new Date();
  const locked = new Set();
  rows.forEach(r => { if (r.early_access_until && new Date(r.early_access_until) > now && !r.is_privileged) locked.add(r.id); });
  return locked;
}

// Résolution générique d'IDs produits → objets produits (utilisée par les vues
// Favoris et Shortlist pour les produits pas déjà chargés dans currentProducts).
// DOIT rester déclarée AVANT /api/portal/favorites/:productId : sinon Express
// route toute requête vers /favorites/products en matchant :productId="products"
// sur la route paramétrée précédente (bug réel constaté — la route littérale
// n'était jamais atteinte, "Mes favoris" ne résolvait donc jamais les favoris
// venant d'une autre marque que celle affichée).
app.post('/api/portal/favorites/products', requireBuyerAuth, async (req, res) => {
  const ids = (req.body.ids || []).slice(0, 100);
  if (!ids.length) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT p.id, p.reference, p.description, p.color, p.price, p.price_retail, p.images, p.image_url, p.brand_id
       FROM products p WHERE p.id = ANY($1) AND p.active != 0`,
      [ids]
    );
    const locked = await getLockedBrandIds(req.session.buyerPortal.id, r.rows.map(p => p.brand_id));
    res.json(r.rows.filter(p => !locked.has(p.brand_id)));
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/portal/favorites/:productId', requireBuyerAuth, async (req, res) => {
  const buyerId = req.session.buyerPortal.id;
  const productId = req.params.productId;
  // SELECT...FOR UPDATE dans une transaction : sans verrou, deux clics rapides
  // (double-clic, requêtes concurrentes) lisent tous deux le même état de
  // départ et décident tous deux "ajouter" — le serveur finit par ajouter
  // l'article alors que côté client, deux toggles optimistes successifs
  // affichent "retiré". Même classe de bug que la race condition déjà
  // corrigée sur le changement de statut de commande.
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const r = await dbClient.query('SELECT favorites_json FROM buyers WHERE id=$1 FOR UPDATE', [buyerId]);
    let favs = [];
    try { favs = JSON.parse(r.rows[0]?.favorites_json || '[]'); } catch(e) {}
    const idx = favs.indexOf(productId);
    // Le retrait reste toujours possible (permet de nettoyer une entrée
    // invalide déjà présente) ; l'ajout, lui, exige un produit réel.
    if (idx >= 0) {
      favs.splice(idx, 1);
    } else {
      const exists = await dbClient.query('SELECT 1 FROM products WHERE id=$1', [productId]);
      if (!exists.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Produit introuvable' }); }
      favs.push(productId);
    }
    await dbClient.query('UPDATE buyers SET favorites_json=$1 WHERE id=$2', [JSON.stringify(favs), buyerId]);
    await dbClient.query('COMMIT');
    // Analytics distinctes du panier/shortlist — n'incrémente qu'à l'ajout, jamais au retrait.
    if (idx < 0) {
      pool.query(
        'INSERT INTO product_stats (product_id, favorite_adds) VALUES ($1,1) ON CONFLICT (product_id) DO UPDATE SET favorite_adds = product_stats.favorite_adds + 1, updated_at = NOW()',
        [productId]
      ).catch(() => {});
    }
    res.json({ favorites: favs, active: idx < 0 });
  } catch(e) { await dbClient.query('ROLLBACK'); res.status(500).json({ error: 'Erreur serveur' }); }
  finally { dbClient.release(); }
});

// ── Shortlist — niveau d'intention intermédiaire entre favoris et commande
// ("à montrer/étudier en équipe") — même mécanique que favorites_json ci-dessus,
// volontairement séparée (pas de fusion des deux listes) pour que buyer et
// analytics distinguent bien les trois signaux.
app.get('/api/portal/shortlist', requireBuyerAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT shortlist_json FROM buyers WHERE id=$1', [req.session.buyerPortal.id]);
    let list = [];
    try { list = JSON.parse(r.rows[0]?.shortlist_json || '[]'); } catch(e) {}
    res.json(list);
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/portal/shortlist/:productId', requireBuyerAuth, async (req, res) => {
  const buyerId = req.session.buyerPortal.id;
  const productId = req.params.productId;
  // Même verrou que /api/portal/favorites/:productId — voir commentaire là-bas.
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const r = await dbClient.query('SELECT shortlist_json FROM buyers WHERE id=$1 FOR UPDATE', [buyerId]);
    let list = [];
    try { list = JSON.parse(r.rows[0]?.shortlist_json || '[]'); } catch(e) {}
    const idx = list.indexOf(productId);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      const exists = await dbClient.query('SELECT 1 FROM products WHERE id=$1', [productId]);
      if (!exists.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Produit introuvable' }); }
      list.push(productId);
    }
    await dbClient.query('UPDATE buyers SET shortlist_json=$1 WHERE id=$2', [JSON.stringify(list), buyerId]);
    await dbClient.query('COMMIT');
    if (idx < 0) {
      pool.query(
        'INSERT INTO product_stats (product_id, shortlist_adds) VALUES ($1,1) ON CONFLICT (product_id) DO UPDATE SET shortlist_adds = product_stats.shortlist_adds + 1, updated_at = NOW()',
        [productId]
      ).catch(() => {});
    }
    res.json({ shortlist: list, active: idx < 0 });
  } catch(e) { await dbClient.query('ROLLBACK'); res.status(500).json({ error: 'Erreur serveur' }); }
  finally { dbClient.release(); }
});

app.get('/api/portal/brands', requireBuyerAuth, async (req, res) => {
  try {
    // != 'inactive' exclut les NULL en PG — on inclut explicitement les NULL
    const r = await pool.query("SELECT id, name, about_text, logo, logo_url, cover_image, thumbnail, cgv_text, moq_qty, moq_amount, moq_strict, delivery_terms, payment_terms, return_terms, TO_CHAR(order_deadline,'YYYY-MM-DD') AS order_deadline, lookbook_url, default_currency, created_at FROM brands WHERE (subscription_status IS NULL OR subscription_status != 'inactive') ORDER BY name");
    const season = (await getSetting('current_season')) || '';
    const brands = r.rows.map(b => ({
      ...b,
      season, // saison showroom globale (ex. "SS27") — affichée en pastille sur chaque carte
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
    const b = await pool.query("SELECT id, name, logo, logo_url, cover_image, thumbnail, about_text, cgv_text, moq_qty, moq_amount, moq_strict, delivery_terms, payment_terms, return_terms, TO_CHAR(order_deadline,'YYYY-MM-DD') AS order_deadline, subscription_status, lookbook_url, default_currency, website, instagram, facebook, tiktok, linkedin, video_url, early_access_until FROM brands WHERE id=$1", [req.params.brandId]);
    if (!b.rows[0] || b.rows[0].subscription_status === 'inactive') return res.status(404).json({ error: 'Marque indisponible' });
    const p = await pool.query('SELECT id, reference, description, color, sizes, price, price_retail, image_url, images, variants, collection_name, composition, category, season_id, active, created_at, stock_qty, stock_enabled, video_url, featured FROM products WHERE brand_id=$1 AND active != 0 ORDER BY collection_name, reference', [req.params.brandId]);
    // Track views for all products in this brand page load
    for (const prod of p.rows) {
      pool.query(
        'INSERT INTO product_stats (product_id, views) VALUES ($1, 1) ON CONFLICT (product_id) DO UPDATE SET views = product_stats.views + 1, updated_at = NOW()',
        [prod.id]
      ).catch(e => console.error('[product-stats-error]', e.message));
    }
    // Best-sellers : top 3 produits de la marque par quantité réellement commandée
    // (hors brouillons/annulées), avec un minimum pour éviter qu'une seule petite
    // commande suffise à décrocher le badge sur une marque peu active.
    const bestSellers = await pool.query(
      `SELECT ol.product_id, SUM(ol.quantity) AS qty
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id
       WHERE o.brand_id = $1 AND o.status NOT IN ('draft', 'cancelled')
       GROUP BY ol.product_id
       HAVING SUM(ol.quantity) >= 2
       ORDER BY qty DESC
       LIMIT 3`,
      [req.params.brandId]
    );
    const bestSellerIds = new Set(bestSellers.rows.map(r => r.product_id));
    // Mise en avant manuelle (featured) : s'ajoute au calcul automatique, ne le remplace pas.
    p.rows.forEach(prod => { if (prod.featured) bestSellerIds.add(prod.id); });
    // Réassort suggéré : produits de la dernière commande de cet acheteur avec
    // cette marque encore actifs au catalogue, complétés par des nouveautés de
    // la même collection qu'il n'a pas encore commandées.
    const lastOrder = (await pool.query(
      `SELECT id, TO_CHAR(created_at,'YYYY-MM-DD') AS created_at FROM orders
       WHERE buyer_id=$1 AND brand_id=$2 AND status NOT IN ('draft','cancelled')
       ORDER BY created_at DESC LIMIT 1`,
      [req.session.buyerPortal.id, req.params.brandId]
    )).rows[0];
    let reorderSuggestions = [];
    if (lastOrder) {
      const reorderedIds = new Set();
      const collections = new Set();
      const reordered = await pool.query(
        `SELECT DISTINCT ol.product_id, pr.collection_name FROM order_lines ol
         JOIN products pr ON pr.id = ol.product_id
         WHERE ol.order_id=$1 AND pr.active != 0`,
        [lastOrder.id]
      );
      reordered.rows.forEach(r => { reorderedIds.add(r.product_id); if (r.collection_name) collections.add(r.collection_name); });
      const reorderedProducts = p.rows.filter(prod => reorderedIds.has(prod.id))
        .map(prod => ({ ...prod, reason: 'reordered' }));
      const freshCount = Math.max(0, 4 - reorderedProducts.length);
      const freshProducts = freshCount > 0 && collections.size
        ? p.rows.filter(prod => !reorderedIds.has(prod.id) && collections.has(prod.collection_name))
            .sort((a, b2) => new Date(b2.created_at) - new Date(a.created_at))
            .slice(0, freshCount)
            .map(prod => ({ ...prod, reason: 'same_collection' }))
        : [];
      reorderSuggestions = [...reorderedProducts, ...freshProducts]
        .slice(0, 4)
        .map(prod => ({ ...prod, image_url: cloudinaryOpt(prod.image_url) }));
    }
    const brand = b.rows[0];
    // Conditions négociées pour cet acheteur avec cette marque, le cas échéant
    // — un champ vide dans la surcharge = pas de négociation sur ce point,
    // repli sur la condition par défaut de la marque.
    const termsOverride = (await pool.query(
      'SELECT payment_terms, delivery_terms, return_terms FROM buyer_brand_terms WHERE buyer_id=$1 AND brand_id=$2',
      [req.session.buyerPortal.id, req.params.brandId]
    )).rows[0];
    if (termsOverride) {
      brand.custom_terms = true;
      if (termsOverride.payment_terms) brand.payment_terms = termsOverride.payment_terms;
      if (termsOverride.delivery_terms) brand.delivery_terms = termsOverride.delivery_terms;
      if (termsOverride.return_terms) brand.return_terms = termsOverride.return_terms;
    }
    brand.logo = cloudinaryOpt(brand.logo);
    brand.logo_url = cloudinaryOpt(brand.logo_url);
    brand.cover_image = cloudinaryOpt(brand.cover_image);
    brand.thumbnail = cloudinaryOpt(brand.thumbnail);
    const following = await pool.query('SELECT 1 FROM brand_follows WHERE buyer_id=$1 AND brand_id=$2', [req.session.buyerPortal.id, req.params.brandId]);
    brand.following = following.rows.length > 0;
    // Accès anticipé : verrouillé pour tout acheteur non marqué "privilégié"
    // pour CETTE marque tant que la date d'ouverture générale n'est pas passée.
    brand.early_access_locked = false;
    if (brand.early_access_until && new Date(brand.early_access_until) > new Date()) {
      const priv = await pool.query('SELECT is_privileged FROM buyer_brand_terms WHERE buyer_id=$1 AND brand_id=$2', [req.session.buyerPortal.id, req.params.brandId]);
      brand.early_access_locked = !(priv.rows[0] && priv.rows[0].is_privileged);
    }
    // Accès anticipé verrouillé : le client se contente d'afficher une vignette
    // "verrouillée" (référence + description) sans jamais lire photos/prix/stock
    // — mais un acheteur non privilégié qui inspecte directement cette réponse
    // ne doit pas non plus pouvoir les récupérer. Les données commercialement
    // sensibles de la collection réservée sont donc retirées côté serveur, pas
    // seulement masquées côté client.
    const products = p.rows.map(prod => brand.early_access_locked
      ? { id: prod.id, reference: prod.reference, description: prod.description, collection_name: prod.collection_name, category: prod.category, season_id: prod.season_id, active: prod.active, created_at: prod.created_at, best_seller: false }
      : { ...prod, image_url: cloudinaryOpt(prod.image_url), best_seller: bestSellerIds.has(prod.id) });
    res.json({ brand, products, reorder_suggestions: brand.early_access_locked ? [] : reorderSuggestions, last_order_date: lastOrder ? lastOrder.created_at : null });
  } catch(e) { console.error('portal products:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Suivre / ne plus suivre une marque — bascule simple, idempotente des deux côtés.
app.post('/api/portal/brands/:brandId/follow', requireBuyerAuth, async (req, res) => {
  try {
    const buyerId = req.session.buyerPortal.id;
    const brandId = req.params.brandId;
    const existing = await pool.query('SELECT 1 FROM brand_follows WHERE buyer_id=$1 AND brand_id=$2', [buyerId, brandId]);
    if (existing.rows.length) {
      await pool.query('DELETE FROM brand_follows WHERE buyer_id=$1 AND brand_id=$2', [buyerId, brandId]);
      return res.json({ following: false });
    }
    await pool.query('INSERT INTO brand_follows (buyer_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [buyerId, brandId]);
    res.json({ following: true });
  } catch(e) { console.error('brand follow:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Notifications acheteur (alerte "nouvelle collection" pour l'instant — type
// ouvert pour de futurs types sans changer le contrat de l'endpoint).
app.get('/api/portal/notifications', requireBuyerAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT n.id, n.brand_id, n.type, n.title, n.body, n.read_at, n.created_at, b.name AS brand_name
       FROM buyer_notifications n LEFT JOIN brands b ON b.id = n.brand_id
       WHERE n.buyer_id=$1 ORDER BY n.created_at DESC LIMIT 30`,
      [req.session.buyerPortal.id]
    );
    res.json(r.rows);
  } catch(e) { console.error('notifications list:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});
app.get('/api/portal/notifications/unread', requireBuyerAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) AS n FROM buyer_notifications WHERE buyer_id=$1 AND read_at IS NULL', [req.session.buyerPortal.id]);
    res.json({ unread: parseInt(r.rows[0].n, 10) || 0 });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});
app.post('/api/portal/notifications/:id/read', requireBuyerAuth, async (req, res) => {
  try {
    await pool.query('UPDATE buyer_notifications SET read_at=NOW() WHERE id=$1 AND buyer_id=$2 AND read_at IS NULL', [req.params.id, req.session.buyerPortal.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});
app.post('/api/portal/notifications/read-all', requireBuyerAuth, async (req, res) => {
  try {
    await pool.query('UPDATE buyer_notifications SET read_at=NOW() WHERE buyer_id=$1 AND read_at IS NULL', [req.session.buyerPortal.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

async function checkMoq(brand_id, lines) {
  const validLines = (lines || []).filter(l => l.quantity > 0);
  const b = await pool.query('SELECT moq_qty, moq_amount, moq_strict FROM brands WHERE id=$1', [brand_id]);
  if (!b.rows[0]) return 'Marque introuvable';
  const moqQty = parseInt(b.rows[0].moq_qty) || 0;
  const moqAmount = parseFloat(b.rows[0].moq_amount) || 0;
  // moq_strict=false : le minimum n'est qu'une indication affichée côté
  // acheteur (barre de progression), pas un blocage serveur — sans ce
  // contrôle, toute commande sous le minimum échouait quand même à la
  // soumission, contredisant le réglage choisi par la marque.
  if (!moqQty && !moqAmount || !b.rows[0].moq_strict) return null;

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
  if (lines.some(l => !l || typeof l !== 'object' || !l.brand_id)) return res.status(400).json({ error: 'Sélection invalide' });
  if (!client_name || typeof client_name !== 'string' || client_name.length > 200) return res.status(400).json({ error: 'Nom requis' });
  if (!buyer_signature) return res.status(400).json({ error: 'Signature requise' });
  if (!cgv_accepted) return res.status(400).json({ error: 'Acceptation des CGV requise' });

  // Group lines by brand — one order per brand
  const byBrand = {};
  for (const line of lines) {
    if (!byBrand[line.brand_id]) byBrand[line.brand_id] = [];
    byBrand[line.brand_id].push(line);
  }

  // Validate MOQ + accès anticipé pour chaque marque AVANT de créer la moindre
  // commande — all or nothing. L'accès anticipé n'est pas qu'un habillage
  // visuel : un acheteur non privilégié ne doit pas pouvoir commander une
  // collection encore réservée en appelant directement l'API.
  const brandsList = await pool.query('SELECT id, name, early_access_until FROM brands WHERE id = ANY($1)', [Object.keys(byBrand)]);
  const brandNameOf = id => brandsList.rows.find(b => b.id === id)?.name || id;
  for (const [brand_id, brandLines] of Object.entries(byBrand)) {
    const brandRow = brandsList.rows.find(b => b.id === brand_id);
    if (brandRow && brandRow.early_access_until && new Date(brandRow.early_access_until) > new Date()) {
      const priv = await pool.query('SELECT is_privileged FROM buyer_brand_terms WHERE buyer_id=$1 AND brand_id=$2', [buyer.id, brand_id]);
      if (!(priv.rows[0] && priv.rows[0].is_privileged)) {
        return res.status(403).json({ error: `${brandNameOf(brand_id)} : collection encore en accès anticipé, pas encore ouverte aux commandes.` });
      }
    }
    const moqError = await checkMoq(brand_id, brandLines);
    if (moqError) return res.status(400).json({ error: `${brandNameOf(brand_id)} : ${moqError}` });
  }

  const results = [];
  let anyError = false;
  for (const [brand_id, brandLines] of Object.entries(byBrand)) {
    const r = await createOrder({
      brand_id, client_name,
      client_email: buyer.email,
      client_company: client_company || buyer.company,
      client_phone: client_phone || buyer.phone,
      client_country: client_country || buyer.country,
      notes, lines: brandLines, buyer_signature, cgv_accepted, buyer_id: buyer.id
    });
    if (r.error) anyError = true;
    results.push({ brand_id, brand_name: brandNameOf(brand_id), ...r });
  }

  res.json({ ok: !anyError, orders: results });
});

app.get('/api/portal/orders', requireBuyerAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT o.id, o.order_number, o.brand_id, o.client_name, o.client_email, o.client_company,
           o.client_phone, o.client_country, o.status, o.notes, o.cgv_accepted, o.created_at,
           o.delivery_window, b.name as brand_name, SUM(ol.quantity * ol.unit_price) as total
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
    logAuditRaw(req.session.buyerPortal.email, 'download_order_pdf', 'order', req.params.id, req.ip);
    const pdf = await generateOrderPDF(req.params.id);
    const oNum = o.rows[0].order_number || req.params.id.slice(0,8).toUpperCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', `attachment; filename="Commande-${oNum}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Email sélection ──────────────────────────────────────────────────
app.post('/api/portal/selection-email', requireBuyerAuth, emailLimiter, async (req, res) => {
  try {
    const { to, message, items } = req.body;
    if (!to || !items?.length) return res.status(400).json({ error: 'Données manquantes' });
    // Destinataire volontairement libre (partage de sélection à un tiers), mais
    // doit rester une adresse email syntaxiquement valide — sinon ce champ libre
    // + le domaine d'envoi vérifié du showroom en font un vecteur de phishing.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to).trim())) return res.status(400).json({ error: 'Email destinataire invalide' });
    // Plafond d'articles (même limite que /api/portal/selection-pdf, alignée pour
    // éviter le même DoS PDFKit synchrone).
    if (!Array.isArray(items) || items.length > 500) return res.status(400).json({ error: 'Sélection invalide' });
    const buyer = req.session.buyerPortal;
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(500).json({ error: 'Email non configuré' });

    // Le PDF part par email vers un tiers depuis le domaine vérifié du showroom,
    // sous le nom de l'acheteur authentifié — contrairement à /selection-pdf (un
    // simple téléchargement local), on ne peut pas faire confiance au contenu
    // (référence/description/prix/marque) fourni par le client : on ne garde de
    // chaque ligne que product_id/qty/size/note, et on résout tout le reste
    // (référence, désignation, couleur, prix, nom de marque) depuis la base.
    const productIds = [...new Set(items.map(l => l?.product_id).filter(Boolean))];
    if (!productIds.length) return res.status(400).json({ error: 'Sélection invalide' });
    const prodRows = await pool.query(
      `SELECT p.id, p.reference, p.description, p.color, p.price, p.brand_id, b.name AS brand_name
       FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id = ANY($1)`,
      [productIds]
    );
    const lockedBrands = await getLockedBrandIds(req.session.buyerPortal.id, prodRows.rows.map(p => p.brand_id));
    const prodMap = Object.fromEntries(prodRows.rows.filter(p => !lockedBrands.has(p.brand_id)).map(p => [p.id, p]));
    const trustedItems = items
      .filter(l => l && prodMap[l.product_id])
      .map(l => {
        const p = prodMap[l.product_id];
        return {
          brand_id: p.brand_id, brand_name: p.brand_name, reference: p.reference,
          description: p.description, color: p.color, price: p.price,
          size: (l.size || '').toString().slice(0, 20),
          qty: Math.max(1, parseInt(l.qty) || 0),
          note: (l.note || '').toString().slice(0, 200),
        };
      });
    if (!trustedItems.length) return res.status(400).json({ error: 'Sélection invalide' });

    const showroomName = await getSetting('showroom_name') || 'Showroom';
    const fromAddress = await getSetting('smtp_from') || 'showroom@editionsstandard.com';
    const showroomEmail = await getSetting('showroom_email');
    const dateStr = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    const byBrand = {};
    trustedItems.forEach(l => { (byBrand[l.brand_id] = byBrand[l.brand_id] || { name: l.brand_name, lines: [] }).lines.push(l); });
    const grandTotal = trustedItems.reduce((s, l) => s + l.qty * parseFloat(l.price || 0), 0);

    const pdf = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const F = registerPdfFonts(doc);
      const hTop = 50;
      const selLogo = loadPdfLogo();
      if (selLogo) doc.image(selLogo, 50, hTop, { width: 40, height: 40 });
      const seTx = selLogo ? 102 : 50;
      doc.fontSize(16).fillColor('#0a0a0a').font(F.bold).text((showroomName||'').toUpperCase(), seTx, hTop + 2, { lineBreak: false, characterSpacing: 1 });
      doc.fontSize(8).fillColor('#9a9a9a').font(F.reg).text('SÉLECTION ACHETEUR — NON CONTRACTUEL', seTx, hTop + 22, { lineBreak: false, characterSpacing: 1.2 });
      doc.fontSize(8).fillColor('#9a9a9a').text(dateStr, seTx, hTop + 34, { lineBreak: false });
      doc.moveTo(50, hTop + 54).lineTo(545, hTop + 54).strokeColor('#dcdcdc').lineWidth(0.5).stroke();
      const infoY = hTop + 64;
      doc.fontSize(7.5).fillColor('#aaa').font(F.reg).text('ACHETEUR', 50, infoY);
      doc.fontSize(11).fillColor('#0a0a0a').font(F.bold).text(buyer.name || '', 50, infoY + 12);
      doc.fontSize(9).fillColor('#555').font(F.reg).text(buyer.email || '', 50, infoY + 26);
      let rowY = infoY + 60;
      const col = { ref: 50, desc: 145, color: 295, size: 345, qty: 390, total: 455 };
      const colW = { ref: 90, desc: 145, color: 45, size: 40, qty: 30, total: 90 };
      Object.values(byBrand).forEach(({ name: brandName = 'Marque', lines }) => {
        if (rowY > 720) { doc.addPage(); rowY = 50; }
        doc.rect(50, rowY, 495, 20).fillColor('#0a0a0a').fill();
        doc.fontSize(9).fillColor('#ffffff').font(F.bold).text(brandName.toUpperCase(), 58, rowY + 5, { width: 477 });
        rowY += 26;
        doc.fontSize(7).fillColor('#aaa').font(F.reg);
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
          doc.fillColor('#0a0a0a').font(F.bold).text(l.reference || '', col.ref, rowY, { width: colW.ref });
          doc.fillColor('#333').font(F.reg).text((l.description||'').slice(0,55), col.desc, rowY, { width: colW.desc });
          doc.fillColor('#555').text(l.color||'—', col.color, rowY, { width: colW.color }).text(l.size||'—', col.size, rowY, { width: colW.size });
          doc.fillColor('#0a0a0a').font(F.bold).text(String(l.qty), col.qty, rowY, { width: colW.qty, align: 'right' });
          doc.fillColor('#333').font(F.reg).text(`${lineTotal} €`, col.total, rowY, { width: colW.total, align: 'right' });
          if (l.note) { rowY += 16; doc.fontSize(7).fillColor('#888').text(`↳ ${l.note}`, col.desc, rowY, { width: 350 }); doc.fontSize(7); }
          rowY += 16;
        });
        const brandTotal = lines.reduce((s, l) => s + l.qty * parseFloat(l.price || 0), 0);
        rowY += 4;
        doc.fontSize(8).fillColor('#555').font(F.reg).text(`Sous-total ${brandName}`, col.ref, rowY, { width: 320 });
        doc.fillColor('#0a0a0a').font(F.bold).text(`${brandTotal.toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });
        rowY += 26;
      });
      if (rowY > 700) { doc.addPage(); rowY = 50; }
      doc.rect(380, rowY, 165, 24).fillColor('#0a0a0a').fill();
      doc.fontSize(10).fillColor('#ffffff').font(F.bold).text('TOTAL HT', 390, rowY + 6, { width: 80 }).text(`${grandTotal.toFixed(2)} €`, 390, rowY + 6, { width: 145, align: 'right' });
      rowY += 36;
      doc.rect(50, rowY, 495, 36).fillColor('#fffde7').fill();
      doc.fontSize(8).fillColor('#b8860b').font(F.bold).text('⚠ DOCUMENT NON CONTRACTUEL', 60, rowY + 6, { width: 475, align: 'center' });
      doc.fontSize(7.5).fillColor('#b8860b').font(F.reg).text('Cette sélection ne constitue pas une commande ferme.', 60, rowY + 18, { width: 475, align: 'center' });
      doc.end();
    });

    const resend = newResendClient(resendKey);
    const { error } = await resend.emails.send({
      from: `${showroomName} <${fromAddress}>`,
      to: [to],
      ...(showroomEmail && showroomEmail.toLowerCase() !== String(to).toLowerCase() ? { bcc: [showroomEmail] } : {}),
      subject: `Sélection B2B — ${showroomName} — ${dateStr}`,
      html: emailLayout({ showroomName, content: `<p>Bonjour,</p>${message ? `<p>${escHtml(message).replace(/\n/g,'<br>')}</p>` : ''}<p>Veuillez trouver ci-joint la sélection de <strong>${escHtml(buyer.name)}</strong> (${escHtml(buyer.email)}).</p><p>Total HT : <strong>${grandTotal.toFixed(2)} €</strong></p><p style="color:#888;font-size:12px">Ce document est non contractuel.</p>` }),
      attachments: [{ filename: `Selection-${dateStr}.pdf`, content: pdf.toString('base64'), contentType: 'application/pdf' }]
    });
    if (error) { console.error('[resend] email-selection:', error.message || error); return res.status(502).json({ error: 'Échec envoi email' }); }
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
    `<h3 style="margin:24px 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid rgba(17,17,17,.1);padding-bottom:6px">${escHtml(brand)}</h3>` +
    lines.map(l => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:13px"><span><strong>${escHtml(l.reference)}</strong>${l.color?' · '+escHtml(l.color):''}${l.size?' · '+escHtml(l.size):''}</span><span>× ${escHtml(String(l.qty))} — ${(l.qty*parseFloat(l.price||0)).toFixed(2)} €</span></div>`).join('')
  ).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sélection — ${showroomName}</title><style>body{font-family:'Helvetica Neue',sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#111}.header{border-bottom:2px solid #111;padding-bottom:16px;margin-bottom:24px}.tag{display:inline-block;background:rgba(224,176,58,.1);border:1px solid #d4a017;color:#8a6500;font-size:11px;padding:3px 10px;border-radius:12px;margin-bottom:16px}.total{background:#111;color:#fff;padding:14px 18px;margin-top:24px;font-weight:700;display:flex;justify-content:space-between;font-size:15px}</style></head><body><div class="header"><h1 style="font-size:22px;margin:0 0 4px">${showroomName}</h1><p style="color:#888;font-size:12px;margin:0">Sélection partagée — lecture seule</p></div><span class="tag">NON CONTRACTUEL</span>${rows}<div class="total"><span>TOTAL HT</span><span>${grandTotal.toFixed(2)} €</span></div><p style="color:#aaa;font-size:11px;margin-top:24px;text-align:center">Ce document est non contractuel. La commande doit être validée sur le portail.</p></body></html>`);
});

app.get('/api/portal/cart', requireBuyerAuth, async (req, res) => {
  const r = await pool.query('SELECT cart_json FROM buyer_carts WHERE buyer_id=$1', [req.session.buyerPortal.id]);
  res.json(r.rows[0] ? JSON.parse(r.rows[0].cart_json || '{}') : {});
});

app.post('/api/portal/cart', requireBuyerAuth, cartLimiter, async (req, res) => {
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
    const scoped = isBrandScoped(req);
    const r = await pool.query(`
      SELECT p.id, p.reference, p.description, p.color, p.price, b.name as brand_name,
             COALESCE(ps.views, 0) as views,
             COALESCE(ps.cart_adds, 0) as cart_adds,
             COALESCE(ps.favorite_adds, 0) as favorite_adds,
             COALESCE(ps.shortlist_adds, 0) as shortlist_adds
      FROM products p
      JOIN brands b ON p.brand_id = b.id
      LEFT JOIN product_stats ps ON ps.product_id = p.id
      WHERE p.active != 0 ${scoped ? 'AND p.brand_id = $1' : ''}
      ORDER BY COALESCE(ps.views, 0) DESC
      LIMIT 100
    `, scoped ? [req.userBrandId] : []);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Analytics acheteurs enrichies ────────────────────────────────────
// Répartition géographique des clients : pays → acheteurs, commandes, CA.
// Sert la carte du monde du dashboard. Le pays vient de la commande
// (client_country) avec repli sur la fiche acheteur ; les acheteurs sans
// commande comptent quand même dans buyer_count via leur fiche.
app.get('/api/admin/buyers-by-country', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const scoped = isBrandScoped(req);
    const p = scoped ? [req.userBrandId] : [];
    const [buyers, orders] = await Promise.all([
      pool.query(`SELECT TRIM(country) AS country, COUNT(*)::int AS buyers
                  FROM buyers WHERE COALESCE(TRIM(country),'') <> ''
                  ${scoped ? 'AND id IN (SELECT buyer_id FROM orders WHERE brand_id = $1 AND buyer_id IS NOT NULL)' : ''}
                  GROUP BY TRIM(country)`, p),
      pool.query(`
        SELECT TRIM(COALESCE(NULLIF(TRIM(o.client_country),''), b.country, '')) AS country,
               COUNT(DISTINCT o.id)::int AS orders,
               COALESCE(SUM(ol.quantity * ol.unit_price), 0)::float AS revenue
        FROM orders o
        LEFT JOIN buyers b ON b.id = o.buyer_id
        LEFT JOIN order_lines ol ON ol.order_id = o.id
        WHERE o.status NOT IN ('draft','cancelled') ${scoped ? 'AND o.brand_id = $1' : ''}
        GROUP BY 1
      `, p)
    ]);
    const map = {};
    buyers.rows.forEach(r => { map[r.country] = { country: r.country, buyers: r.buyers, orders: 0, revenue: 0 }; });
    orders.rows.forEach(r => {
      if (!r.country) return;
      if (!map[r.country]) map[r.country] = { country: r.country, buyers: 0, orders: 0, revenue: 0 };
      map[r.country].orders += r.orders;
      map[r.country].revenue += r.revenue;
    });
    res.json(Object.values(map).sort((a, b) => b.revenue - a.revenue || b.buyers - a.buyers));
  } catch(e) { console.error('buyers-by-country:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/buyer-stats', requireRole('owner', 'agent'), async (req, res) => {
  try {
    // Agent scopé : analytics restreintes à sa marque (pas de CA des autres marques).
    const scoped = isBrandScoped(req);
    const p = scoped ? [req.userBrandId] : [];
    const [topBuyers, inactiveBuyers, topBrands, recentActivity] = await Promise.all([
      // Top 10 acheteurs par montant commandé
      pool.query(`
        SELECT b.name, b.company, b.email, b.last_seen_at,
               COUNT(o.id) as order_count,
               COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total_amount
        FROM buyers b
        ${scoped ? 'JOIN' : 'LEFT JOIN'} orders o ON o.buyer_id = b.id ${scoped ? 'AND o.brand_id = $1' : ''}
        LEFT JOIN order_lines ol ON ol.order_id = o.id
        GROUP BY b.id, b.name, b.company, b.email, b.last_seen_at
        ORDER BY total_amount DESC LIMIT 10
      `, p),
      // Acheteurs inactifs > 30 jours
      pool.query(`
        SELECT DISTINCT b.name, b.company, b.email, b.last_seen_at
        FROM buyers b
        ${scoped ? 'JOIN orders o ON o.buyer_id = b.id AND o.brand_id = $1' : ''}
        WHERE b.last_seen_at < NOW() - INTERVAL '30 days' OR b.last_seen_at IS NULL
        ORDER BY b.last_seen_at ASC NULLS FIRST LIMIT 20
      `, p),
      // Top marques par CA (limité à sa marque pour un agent scopé)
      pool.query(`
        SELECT br.name, COUNT(DISTINCT o.id) as order_count,
               COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total_amount,
               COUNT(DISTINCT o.buyer_id) as buyer_count
        FROM brands br
        LEFT JOIN orders o ON o.brand_id = br.id
        LEFT JOIN order_lines ol ON ol.order_id = o.id
        ${scoped ? 'WHERE br.id = $1' : ''}
        GROUP BY br.id, br.name
        ORDER BY total_amount DESC
      `, p),
      // Activité 30 derniers jours (commandes par jour)
      pool.query(`
        SELECT DATE(o.created_at) as day, COUNT(DISTINCT o.id) as count,
               COALESCE(SUM(ol.quantity * ol.unit_price), 0) as amount
        FROM orders o
        LEFT JOIN order_lines ol ON ol.order_id = o.id
        WHERE o.created_at >= NOW() - INTERVAL '30 days'
        ${scoped ? 'AND o.brand_id = $1' : ''}
        GROUP BY DATE(o.created_at)
        ORDER BY day ASC
      `, p)
    ]);
    res.json({
      topBuyers: topBuyers.rows,
      inactiveBuyers: inactiveBuyers.rows,
      topBrands: topBrands.rows,
      recentActivity: recentActivity.rows
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── Statistiques produits par marque ────────────────────────────────
app.get('/api/brands/:brandId/product-stats', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.reference, p.description, p.color, p.price, p.collection_name,
             COALESCE(ps.views, 0) as views,
             COALESCE(ps.cart_adds, 0) as cart_adds,
             ps.updated_at
      FROM products p
      LEFT JOIN product_stats ps ON ps.product_id = p.id
      WHERE p.brand_id = $1
      ORDER BY COALESCE(ps.views, 0) DESC
      LIMIT 50
    `, [req.params.brandId]);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Rapport de ventes agrégé par marque — partageable avec la marque (designer scopé
// à sa marque ; owner/agent à n'importe quelle marque). Données agrégées : pas de
// contacts acheteurs individuels (relations prospect gardées côté agence).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Rapport agrégé, avec filtre de période optionnel (from/to sur o.created_at).
async function getSalesReportData(bid, from, to) {
  from = ISO_DATE.test(from || '') ? from : null;
  to   = ISO_DATE.test(to   || '') ? to   : null;
  // Clause date partagée par summary/top/monthly (mêmes paramètres $2/$3).
  const params = [bid];
  let dc = '';
  if (from) { params.push(from); dc += ` AND o.created_at >= $${params.length}`; }
  if (to)   { params.push(to);   dc += ` AND o.created_at < ($${params.length}::date + 1)`; } // to inclus
  // Mensuel : plage filtrée si fournie, sinon 12 derniers mois par défaut.
  const monthlyRange = (from || to) ? dc : ` AND o.created_at > NOW() - INTERVAL '12 months'`;
  // RDV : compte sur la même période (created_at de la prise de RDV).
  const aParams = [bid]; let adc = '';
  if (from) { aParams.push(from); adc += ` AND created_at >= $${aParams.length}`; }
  if (to)   { aParams.push(to);   adc += ` AND created_at < ($${aParams.length}::date + 1)`; }

  const [summary, top, monthly, rdv] = await Promise.all([
    pool.query(`SELECT COUNT(DISTINCT o.id)::int AS orders,
                       COALESCE(SUM(ol.quantity),0)::int AS units,
                       COALESCE(SUM(ol.quantity*ol.unit_price),0)::float AS revenue,
                       COUNT(DISTINCT o.client_email)::int AS buyers
                FROM orders o JOIN order_lines ol ON ol.order_id=o.id
                WHERE o.brand_id=$1 AND o.status <> 'cancelled'${dc}`, params),
    pool.query(`SELECT p.reference, p.description,
                       SUM(ol.quantity)::int AS units,
                       COALESCE(SUM(ol.quantity*ol.unit_price),0)::float AS revenue
                FROM order_lines ol
                JOIN orders o ON o.id=ol.order_id
                JOIN products p ON p.id=ol.product_id
                WHERE o.brand_id=$1 AND p.brand_id=$1 AND o.status <> 'cancelled'${dc}
                GROUP BY p.id, p.reference, p.description
                ORDER BY units DESC LIMIT 10`, params),
    pool.query(`SELECT to_char(date_trunc('month', o.created_at),'YYYY-MM') AS month,
                       COUNT(DISTINCT o.id)::int AS orders,
                       COALESCE(SUM(ol.quantity*ol.unit_price),0)::float AS revenue
                FROM orders o JOIN order_lines ol ON ol.order_id=o.id
                WHERE o.brand_id=$1 AND o.status <> 'cancelled'${monthlyRange}
                GROUP BY 1 ORDER BY 1`, params),
    pool.query(`SELECT COUNT(*)::int AS rdv FROM appointments WHERE brand_id=$1${adc}`, aParams)
  ]);
  return { summary: summary.rows[0], top: top.rows, monthly: monthly.rows, rdv: rdv.rows[0].rdv, from, to };
}

app.get('/api/brands/:brandId/sales-report', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    res.json(await getSalesReportData(req.params.brandId, req.query.from, req.query.to));
  } catch(e) { console.error('sales-report:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Version PDF du rapport de ventes — présentable, à envoyer à la marque.
app.get('/api/brands/:brandId/sales-report/pdf', requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const bid = req.params.brandId;
    const bRes = await pool.query('SELECT name FROM brands WHERE id=$1', [bid]);
    if (!bRes.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
    const brandName = bRes.rows[0].name;
    const data = await getSalesReportData(bid, req.query.from, req.query.to);
    const showroomName = await getSetting('showroom_name');
    const periodLabel = (data.from || data.to)
      ? `Période : ${data.from || '…'} → ${data.to || "aujourd'hui"}`
      : 'Période : depuis le début';

    let logoBuf = null;
    try {
      const svg2img = require('svg2img');
      const svgSrc = fs.readFileSync(path.join(__dirname, 'public', 'logo.svg'), 'utf8');
      logoBuf = await new Promise((resolve, reject) =>
        svg2img(svgSrc, { width: 120, height: 120, preserveAspectRatio: true }, (err, buf) => err ? reject(err) : resolve(buf)));
    } catch(e) { /* logo optionnel */ }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const F = registerPdfFonts(doc);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => {
      const pdf = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-ventes-${brandName.replace(/[^a-zA-Z0-9]+/g,'-')}.pdf"`);
      res.send(pdf);
    });

    const eur = n => (Number(n)||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' €';
    const fmt = n => (Number(n)||0).toLocaleString('fr-FR');
    const s = data.summary || {};
    const avg = s.orders ? s.revenue / s.orders : 0;

    // En-tête
    if (logoBuf) doc.image(logoBuf, 50, 50, { width: 44, height: 44 });
    doc.fontSize(18).fillColor('#0a0a0a').font(F.bold).text(showroomName, logoBuf ? 106 : 50, 54, { lineBreak: false });
    doc.fontSize(10).fillColor('#888').font(F.reg).text('Rapport de ventes', logoBuf ? 106 : 50, 78, { lineBreak: false });
    doc.fontSize(7.5).fillColor('#aaa').font(F.reg).text(periodLabel, logoBuf ? 106 : 50, 92, { lineBreak: false });
    doc.fontSize(13).fillColor('#0a0a0a').font(F.bold).text(brandName, 400, 56, { width: 145, align: 'right' });
    doc.fontSize(8).fillColor('#aaa').font(F.reg).text(new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' }), 400, 76, { width: 145, align: 'right' });
    doc.moveTo(50, 104).lineTo(545, 104).strokeColor('#e0e0e0').lineWidth(0.5).stroke();

    // Cartes KPI (2 lignes de 3)
    const kpis = [['Commandes', fmt(s.orders)], ['Pièces', fmt(s.units)], ['CA HT', eur(s.revenue)],
                  ['Panier moyen', eur(avg)], ['Acheteurs', fmt(s.buyers)], ['RDV showroom', fmt(data.rdv)]];
    let kx = 50, ky = 120;
    const kw = 158, kh = 52, kgap = 10.5;
    kpis.forEach((k, i) => {
      doc.rect(kx, ky, kw, kh).fillColor('#f7f7f7').fill();
      doc.fontSize(7.5).fillColor('#888').font(F.reg).text(k[0].toUpperCase(), kx + 10, ky + 9, { width: kw - 20 });
      doc.fontSize(15).fillColor('#0a0a0a').font(F.bold).text(k[1], kx + 10, ky + 24, { width: kw - 20 });
      if ((i + 1) % 3 === 0) { kx = 50; ky += kh + kgap; } else { kx += kw + kgap; }
    });

    let y = ky + kh + 16;
    // Top produits
    doc.fontSize(11).fillColor('#0a0a0a').font(F.bold).text('Top produits (pièces commandées)', 50, y); y += 18;
    doc.fontSize(7.5).fillColor('#aaa').font(F.reg);
    doc.text('RÉFÉRENCE', 50, y).text('DÉSIGNATION', 150, y).text('PIÈCES', 400, y, { width: 60, align: 'right' }).text('CA HT', 470, y, { width: 75, align: 'right' });
    y += 12; doc.moveTo(50, y).lineTo(545, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke(); y += 6;
    if ((data.top||[]).length) {
      data.top.forEach((p, i) => {
        if (i % 2 === 0) { doc.rect(50, y - 2, 495, 16).fillColor('#fafafa').fill(); }
        const nm = (p.description || '').length > 42 ? p.description.slice(0, 40) + '…' : (p.description || '');
        doc.fontSize(8.5).fillColor('#0a0a0a').font(F.bold).text(p.reference || '', 50, y, { width: 95 });
        doc.fillColor('#444').font(F.reg).text(nm, 150, y, { width: 245 });
        doc.fillColor('#0a0a0a').font(F.bold).text(fmt(p.units), 400, y, { width: 60, align: 'right' });
        doc.fillColor('#444').font(F.reg).text(eur(p.revenue), 470, y, { width: 75, align: 'right' });
        y += 16;
      });
    } else { doc.fontSize(9).fillColor('#888').font(F.reg).text('Aucune vente.', 50, y); y += 16; }

    y += 14;
    // Évolution mensuelle
    if ((data.monthly||[]).length) {
      doc.fontSize(11).fillColor('#0a0a0a').font(F.bold).text('Évolution mensuelle (CA HT)', 50, y); y += 18;
      const max = Math.max(...data.monthly.map(m => m.revenue), 1);
      data.monthly.forEach(m => {
        if (y > 770) { doc.addPage(); y = 50; }
        const barW = Math.round((m.revenue / max) * 300);
        doc.fontSize(8).fillColor('#888').font(F.reg).text(m.month, 50, y + 1, { width: 60 });
        doc.rect(115, y, 300, 11).fillColor('#f0f0f0').fill();
        doc.rect(115, y, barW, 11).fillColor('#1a1a1a').fill();
        doc.fontSize(8).fillColor('#444').text(eur(m.revenue), 425, y + 1, { width: 120, align: 'right' });
        y += 16;
      });
    }

    doc.fontSize(7.5).fillColor('#bbb').font(F.reg).text(`Données agrégées (commandes confirmées) — généré automatiquement par ${showroomName}`, 50, 800, { align: 'center', width: 495 });
    doc.end();
  } catch(e) { console.error('sales-report-pdf:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Fiche acheteur 360° : infos + commandes + RDV (vue relation, owner/agent).
app.get('/api/admin/buyers/:id/profile', requireRole('owner','agent'), async (req, res) => {
  try {
    const bRes = await pool.query(
      'SELECT id, email, name, company, phone, country, tags, internal_notes, created_at, last_seen_at, favorites_json, shortlist_json FROM buyers WHERE id=$1',
      [req.params.id]
    );
    const buyer = bRes.rows[0];
    if (!buyer) return res.status(404).json({ error: 'Acheteur introuvable' });
    if (!(await checkBuyerBrandScope(req, res))) return;
    // Agent/designer borné à sa marque : n'agrège que les commandes et RDV de
    // sa marque (le propriétaire voit l'historique complet, toutes marques).
    const scoped = isBrandScoped(req);
    const brandId = req.userBrandId;
    const [orders, appts] = await Promise.all([
      pool.query(`SELECT o.id, o.order_number, o.created_at, o.status, o.brand_id, b.name AS brand_name,
                         COALESCE(SUM(ol.quantity*ol.unit_price),0)::float AS total
                  FROM orders o JOIN brands b ON b.id=o.brand_id
                  LEFT JOIN order_lines ol ON ol.order_id=o.id
                  WHERE (o.buyer_id=$1 OR LOWER(o.client_email)=LOWER($2))
                  ${scoped ? 'AND o.brand_id=$3' : ''}
                  GROUP BY o.id, b.name ORDER BY o.created_at DESC`,
                  scoped ? [req.params.id, buyer.email, brandId] : [req.params.id, buyer.email]),
      pool.query(`SELECT a.id, a.slot_date, a.slot_time, a.notes, b.name AS brand_name
                  FROM appointments a JOIN brands b ON b.id=a.brand_id
                  WHERE LOWER(a.client_email)=LOWER($1)
                  ${scoped ? 'AND a.brand_id=$2' : ''}
                  ORDER BY a.slot_date DESC, a.slot_time DESC`,
                  scoped ? [buyer.email, brandId] : [buyer.email])
    ]);
    // ── Historique centralisé (actions de notre côté) ──────────────────
    // Sélections de l'acheteur (par email), commandes, RDV, + journal d'audit
    // (relances, modifications…) et timeline de statut des commandes.
    const sels = await pool.query(
      `SELECT token, selection_number, created_at, created_by FROM agent_selections
       WHERE LOWER(client_email)=LOWER($1) ${scoped ? 'AND brand_id=$2' : ''} ORDER BY created_at DESC`,
      scoped ? [buyer.email, brandId] : [buyer.email]);
    const selTokens = sels.rows.map(s => s.token);
    const orderIds = orders.rows.map(o => o.id);
    const selNumByToken = Object.fromEntries(sels.rows.map(s => [s.token, s.selection_number]));
    const ordNumById = Object.fromEntries(orders.rows.map(o => [o.id, o.order_number || o.id.slice(0, 8)]));
    const auditRows = (await pool.query(
      `SELECT action, user_email, details, created_at, target_type, target_id FROM admin_audit_log
       WHERE (target_type='agent_selection' AND target_id = ANY($1))
          OR (target_type='order' AND target_id = ANY($2))
          OR (target_type='buyer' AND target_id=$3)
       ORDER BY created_at DESC`,
      [selTokens, orderIds, buyer.id])).rows;
    const orderEvents = orderIds.length
      ? (await pool.query('SELECT order_id, event_type, note, created_by, created_at FROM order_events WHERE order_id = ANY($1) ORDER BY created_at DESC', [orderIds])).rows
      : [];
    const AUDIT_TXT = {
      remind_selection: '↻ Relance de sélection', edit_selection_items: '➕ Références modifiées',
      edit_selection_client: '✎ Infos sélection corrigées', delete_selection: '🗑 Sélection supprimée',
      update_order_status: '🔄 Statut de commande', edit_order_lines: '✎ Lignes de commande modifiées',
      delete_buyer: '🗑 Acheteur supprimé'
    };
    const activity = [];
    sels.rows.forEach(s => activity.push({ at: s.created_at, who: s.created_by || '', icon: '📤', text: `Sélection ${s.selection_number || ''} créée` }));
    orders.rows.forEach(o => activity.push({ at: o.created_at, who: '', icon: '🧾', text: `Commande ${ordNumById[o.id]} — ${o.brand_name || ''}` }));
    appts.rows.forEach(a => activity.push({ at: a.slot_date, who: '', icon: '📅', text: `RDV ${a.brand_name || ''}${a.slot_time ? ' · ' + a.slot_time : ''}` }));
    auditRows.forEach(r => {
      let ref = r.target_type === 'agent_selection' ? (selNumByToken[r.target_id] || '') : r.target_type === 'order' ? (ordNumById[r.target_id] || '') : '';
      activity.push({ at: r.created_at, who: r.user_email || '', icon: '•', text: `${AUDIT_TXT[r.action] || r.action}${ref ? ' — ' + ref : ''}${r.details ? ' (' + r.details + ')' : ''}` });
    });
    orderEvents.forEach(e => activity.push({ at: e.created_at, who: e.created_by || '', icon: '📦', text: `Commande ${ordNumById[e.order_id] || ''} — ${e.event_type}${e.note ? ' : ' + e.note : ''}` }));
    activity.sort((a, b) => new Date(b.at) - new Date(a.at));

    // Favoris & shortlist — signaux d'intention (sans engagement) visibles sur
    // la fiche 360°, résolus en référence/marque/prix pour l'agence.
    let favIds = [], shortIds = [];
    try { favIds = JSON.parse(buyer.favorites_json || '[]'); } catch(e) {}
    try { shortIds = JSON.parse(buyer.shortlist_json || '[]'); } catch(e) {}
    delete buyer.favorites_json;
    delete buyer.shortlist_json;
    const allProductIds = [...new Set([...favIds, ...shortIds])];
    let productsById = {};
    if (allProductIds.length) {
      const pRes = await pool.query(
        `SELECT p.id, p.reference, p.price, br.name AS brand_name
         FROM products p JOIN brands br ON br.id=p.brand_id
         WHERE p.id = ANY($1) ${scoped ? 'AND p.brand_id=$2' : ''}`,
        scoped ? [allProductIds, brandId] : [allProductIds]
      );
      productsById = Object.fromEntries(pRes.rows.map(p => [p.id, p]));
    }
    const resolveList = ids => ids.map(id => productsById[id]).filter(Boolean);

    // Conditions négociées — une entrée par marque avec laquelle l'acheteur a
    // déjà commandé, comparant la condition par défaut de la marque et une
    // éventuelle surcharge négociée pour cet acheteur précis.
    const brandsForTerms = Object.fromEntries(orders.rows.map(o => [o.brand_id, o.brand_name]));
    const brandIds = Object.keys(brandsForTerms);
    let negotiatedTerms = [];
    if (brandIds.length) {
      const [defaultsRes, overridesRes] = await Promise.all([
        pool.query('SELECT id, payment_terms, delivery_terms, return_terms FROM brands WHERE id = ANY($1)', [brandIds]),
        pool.query('SELECT brand_id, payment_terms, delivery_terms, return_terms, is_privileged, updated_at, updated_by FROM buyer_brand_terms WHERE buyer_id=$1 AND brand_id = ANY($2)', [req.params.id, brandIds])
      ]);
      const defaultsByBrand = Object.fromEntries(defaultsRes.rows.map(b => [b.id, b]));
      const overridesByBrand = Object.fromEntries(overridesRes.rows.map(o => [o.brand_id, o]));
      negotiatedTerms = brandIds.map(bId => ({
        brand_id: bId,
        brand_name: brandsForTerms[bId],
        default: defaultsByBrand[bId] || { payment_terms: '', delivery_terms: '', return_terms: '' },
        override: overridesByBrand[bId] || null
      }));
    }

    res.json({ buyer, orders: orders.rows, appointments: appts.rows, activity, favorites: resolveList(favIds), shortlist: resolveList(shortIds), negotiatedTerms });
  } catch(e) { console.error('buyer-profile:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Conditions négociées acheteur × marque — un champ laissé vide efface la
// surcharge sur ce point précis (repli sur la condition par défaut de la
// marque) ; les 3 champs vides supprime la ligne entièrement.
app.post('/api/admin/buyers/:id/terms/:brandId', requireRole('owner','agent'), async (req, res) => {
  try {
    if (isBrandScoped(req) && req.userBrandId !== req.params.brandId) return res.status(403).json({ error: 'Accès refusé pour cette marque' });
    // Le check ci-dessus ne garantit que "brandId == la marque de l'agent" — sans
    // checkBuyerBrandScope, un agent pouvait écrire des conditions négociées pour
    // N'IMPORTE QUEL acheteur (via :id), même sans la moindre commande avec sa
    // propre marque, tant qu'il indiquait correctement son propre brandId.
    if (!await checkBuyerBrandScope(req, res)) return;
    const paymentTerms = (req.body.payment_terms || '').toString().trim();
    const deliveryTerms = (req.body.delivery_terms || '').toString().trim();
    const returnTerms = (req.body.return_terms || '').toString().trim();
    const isPrivileged = req.body.is_privileged === true;
    if (!paymentTerms && !deliveryTerms && !returnTerms && !isPrivileged) {
      await pool.query('DELETE FROM buyer_brand_terms WHERE buyer_id=$1 AND brand_id=$2', [req.params.id, req.params.brandId]);
      logAudit(req, 'buyer_terms_cleared', 'buyer', req.params.id, req.params.brandId);
      return res.json({ ok: true, cleared: true });
    }
    await pool.query(
      `INSERT INTO buyer_brand_terms (buyer_id, brand_id, payment_terms, delivery_terms, return_terms, is_privileged, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
       ON CONFLICT (buyer_id, brand_id) DO UPDATE SET payment_terms=$3, delivery_terms=$4, return_terms=$5, is_privileged=$6, updated_at=NOW(), updated_by=$7`,
      [req.params.id, req.params.brandId, paymentTerms, deliveryTerms, returnTerms, isPrivileged, req.session.staffUser?.email || (req.session.admin ? 'owner' : '')]
    );
    logAudit(req, 'buyer_terms_updated', 'buyer', req.params.id, req.params.brandId);
    res.json({ ok: true });
  } catch(e) { console.error('buyer terms update:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ==================== MESSAGERIE ACHETEUR ↔ AGENCE =========================
// Fil asynchrone, un par acheteur. L'acheteur écrit depuis son portail,
// l'agence répond depuis l'admin (fiche client). Notification email des deux côtés.
// Un message peut porter une pièce jointe (photo ou PDF) avec ou sans texte.

const ALLOWED_MSG_ATTACH_MIMES = [...ALLOWED_IMAGE_MIMES, 'application/pdf'];
const MSG_COLS = 'id, sender, body, subject, attachment_url, attachment_name, attachment_type, created_at';
// Même vérification par octets magiques que looksLikeImage()/upload-pdf — le
// mimetype déclaré par le client ne suffit pas.
function looksLikeMsgAttachment(mimetype, buf) {
  if (mimetype === 'application/pdf') return !!buf && buf.length >= 4 && buf.slice(0,4).toString('latin1') === '%PDF';
  return looksLikeImage(buf);
}

function attachmentEmailNote(name) {
  return name ? `<p style="font-size:12px;color:#888">📎 Pièce jointe : ${escHtml(name)}</p>` : '';
}

// Portail : upload d'une pièce jointe (image ou PDF) avant envoi du message
app.post('/api/portal/messages/attachment', requireBuyerAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file || !ALLOWED_MSG_ATTACH_MIMES.includes(req.file.mimetype) || !looksLikeMsgAttachment(req.file.mimetype, req.file.buffer)) return res.status(400).json({ error: 'Fichier image ou PDF requis (jpg, png, webp, gif, pdf)' });
  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'showroom/messages', resource_type: 'auto',
      transformation: req.file.mimetype === 'application/pdf' ? undefined : [{ width: 1600, height: 1600, crop: 'limit', quality: 80, fetch_format: 'auto', flags: 'strip_profile' }]
    });
    res.json({ url: result.secure_url, name: req.file.originalname || 'fichier', type: req.file.mimetype });
  } catch(e) {
    console.error('[upload-message-attachment] Cloudinary:', e.message);
    res.status(502).json({ error: "Échec de l'envoi du fichier" });
  }
});

// Admin : même upload, côté agence
app.post('/api/admin/buyers/:id/messages/attachment', requireRole('owner', 'agent'), uploadLimiter, upload.single('file'), async (req, res) => {
  if (!(await checkBuyerBrandScope(req, res))) return;
  if (!req.file || !ALLOWED_MSG_ATTACH_MIMES.includes(req.file.mimetype) || !looksLikeMsgAttachment(req.file.mimetype, req.file.buffer)) return res.status(400).json({ error: 'Fichier image ou PDF requis (jpg, png, webp, gif, pdf)' });
  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'showroom/messages', resource_type: 'auto',
      transformation: req.file.mimetype === 'application/pdf' ? undefined : [{ width: 1600, height: 1600, crop: 'limit', quality: 80, fetch_format: 'auto', flags: 'strip_profile' }]
    });
    res.json({ url: result.secure_url, name: req.file.originalname || 'fichier', type: req.file.mimetype });
  } catch(e) {
    console.error('[upload-message-attachment] Cloudinary:', e.message);
    res.status(502).json({ error: "Échec de l'envoi du fichier" });
  }
});

// Portail : fil de l'acheteur connecté (marque ses messages agence comme lus)
app.get('/api/portal/messages', requireBuyerAuth, async (req, res) => {
  try {
    const bid = req.session.buyerPortal.id;
    const r = await pool.query(`SELECT ${MSG_COLS} FROM buyer_messages WHERE buyer_id=$1 ORDER BY created_at ASC`, [bid]);
    await pool.query("UPDATE buyer_messages SET read_by_buyer=true WHERE buyer_id=$1 AND sender='staff' AND read_by_buyer=false", [bid]);
    res.json({ messages: r.rows });
  } catch(e) { console.error('portal messages:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Portail : badge de messages non lus (agence → acheteur)
app.get('/api/portal/messages/unread', requireBuyerAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT COUNT(*)::int n FROM buyer_messages WHERE buyer_id=$1 AND sender='staff' AND read_by_buyer=false", [req.session.buyerPortal.id]);
    res.json({ unread: r.rows[0].n });
  } catch(e) { res.json({ unread: 0 }); }
});

// Portail : l'acheteur envoie un message (texte et/ou pièce jointe) → notifie l'agence
app.post('/api/portal/messages', requireBuyerAuth, async (req, res) => {
  try {
    const body = (req.body.body || '').toString().trim();
    const subject = (req.body.subject || '').toString().trim().slice(0, 150);
    const attachmentUrl = (req.body.attachment_url || '').toString().trim();
    const attachmentName = (req.body.attachment_name || '').toString().trim().slice(0, 200);
    const attachmentType = (req.body.attachment_type || '').toString().trim().slice(0, 100);
    if (!body && !attachmentUrl) return res.status(400).json({ error: 'Message vide' });
    if (body.length > 4000) return res.status(400).json({ error: 'Message trop long' });
    if (attachmentUrl && !attachmentUrl.startsWith('https://res.cloudinary.com/')) return res.status(400).json({ error: 'Pièce jointe invalide' });
    const buyer = req.session.buyerPortal;
    await pool.query('INSERT INTO buyer_messages (id, buyer_id, sender, body, subject, attachment_url, attachment_name, attachment_type, read_by_staff) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)',
      [uuidv4(), buyer.id, 'buyer', body, subject, attachmentUrl, attachmentName, attachmentType]);
    notifyOwner(subject ? `${subject} — ${buyer.name || buyer.email}` : `Nouveau message de ${buyer.name || buyer.email}`,
      `<p><strong>${escHtml(buyer.name || '')} (${escHtml(buyer.email)})</strong> vous a écrit${subject ? ` — <strong>${escHtml(subject)}</strong>` : ''} :</p>
       ${body ? `<blockquote style="border-left:3px solid rgba(17,17,17,.2);padding-left:12px;color:#444444">${escHtml(body)}</blockquote>` : ''}
       ${attachmentEmailNote(attachmentName)}
       <p style="font-size:12px;color:#888">Répondez depuis votre admin → fiche client.</p>`).catch(() => {});
    res.json({ ok: true });
  } catch(e) { console.error('portal send message:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Admin : fil d'un acheteur (marque les messages acheteur comme lus)
app.get('/api/admin/buyers/:id/messages', requireRole('owner', 'agent'), async (req, res) => {
  try {
    if (!(await checkBuyerBrandScope(req, res))) return;
    const r = await pool.query(`SELECT ${MSG_COLS} FROM buyer_messages WHERE buyer_id=$1 ORDER BY created_at ASC`, [req.params.id]);
    await pool.query("UPDATE buyer_messages SET read_by_staff=true WHERE buyer_id=$1 AND sender='buyer' AND read_by_staff=false", [req.params.id]);
    res.json({ messages: r.rows });
  } catch(e) { console.error('admin messages:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Admin : l'agence répond (texte et/ou pièce jointe) → email à l'acheteur avec lien vers son portail
app.post('/api/admin/buyers/:id/messages', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const body = (req.body.body || '').toString().trim();
    const attachmentUrl = (req.body.attachment_url || '').toString().trim();
    const attachmentName = (req.body.attachment_name || '').toString().trim().slice(0, 200);
    const attachmentType = (req.body.attachment_type || '').toString().trim().slice(0, 100);
    if (!body && !attachmentUrl) return res.status(400).json({ error: 'Message vide' });
    if (body.length > 4000) return res.status(400).json({ error: 'Message trop long' });
    if (attachmentUrl && !attachmentUrl.startsWith('https://res.cloudinary.com/')) return res.status(400).json({ error: 'Pièce jointe invalide' });
    const b = (await pool.query('SELECT id, email, name FROM buyers WHERE id=$1', [req.params.id])).rows[0];
    if (!b) return res.status(404).json({ error: 'Acheteur introuvable' });
    if (!(await checkBuyerBrandScope(req, res))) return;
    await pool.query('INSERT INTO buyer_messages (id, buyer_id, sender, body, attachment_url, attachment_name, attachment_type, read_by_buyer) VALUES ($1,$2,$3,$4,$5,$6,$7,false)',
      [uuidv4(), b.id, 'staff', body, attachmentUrl, attachmentName, attachmentType]);
    logAudit(req, 'reply_buyer_message', 'buyer', b.id, '');
    (async () => {
      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) return;
      const [showroomName, fromAddress, ownerEmail] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from'), getSetting('showroom_email')]);
      const resend = newResendClient(resendKey);
      const portalUrl = `${getBaseUrl(req)}/portal`;
      const { error } = await resend.emails.send({
        from: `${showroomName || 'Showroom'} <${fromAddress || 'showroom@editionsstandard.com'}>`,
        to: [b.email],
        replyTo: ownerEmail || undefined,
        ...(ownerEmail && ownerEmail.toLowerCase() !== b.email.toLowerCase() ? { bcc: [ownerEmail] } : {}),
        subject: `${showroomName || 'Showroom'} — nouveau message`,
        html: emailLayout({ showroomName, content:
          `<p>Bonjour ${escHtml(b.name || '')},</p>
           <p>Vous avez un nouveau message de ${escHtml(showroomName || 'notre équipe')} :</p>
           ${body ? `<blockquote style="border-left:3px solid rgba(17,17,17,.2);padding-left:12px;color:#444444">${escHtml(body)}</blockquote>` : ''}
           ${attachmentEmailNote(attachmentName)}
           <p><a href="${portalUrl}" style="color:#6b8500">Répondre depuis votre espace →</a></p>` })
      });
      if (error) console.error('[resend] buyer-message-email:', error.message || error);
    })().catch(e => console.error('buyer message email:', e.message));
    res.json({ ok: true });
  } catch(e) { console.error('admin send message:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ==================== TRADUCTION DE CONTENU (Claude, avec cache) ============
const TRANSLATE_LANGS = { en: 'English', it: 'Italian', es: 'Spanish', de: 'German',
  zh: 'Chinese (Simplified)', ja: 'Japanese', ko: 'Korean', th: 'Thai' };

// Un seul appel Claude pour un petit lot de textes. Renvoie un tableau de même
// longueur (les cases non traduites valent null). Lève une erreur en cas
// d'échec dur (réseau, HTTP, JSON illisible) pour laisser le repli agir.
async function claudeTranslate(texts, langName) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{ role: 'user', content:
        `You are a fashion copy translator. Translate each string of this JSON array into ${langName}, preserving the brand/fashion tone. Do NOT translate proper nouns, brand names, references/SKUs. Return ONLY a JSON array of translations, same length and order, nothing else.\n\n${JSON.stringify(texts)}` }]
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 300); } catch (_) {}
    throw new Error('Anthropic HTTP ' + resp.status + (detail ? ' ' + detail : ''));
  }
  const data = await resp.json();
  if (data.stop_reason === 'max_tokens') throw new Error('réponse tronquée (max_tokens)');
  let txt = (data.content && data.content[0] && data.content[0].text) || '[]';
  txt = txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const m = txt.match(/\[[\s\S]*\]/);
  const arr = JSON.parse(m ? m[0] : txt);
  if (!Array.isArray(arr)) throw new Error('bad translation payload');
  return arr;
}

// Traduit une liste de textes vers `lang`, avec cache DB. Repli = texte original.
// Découpe les textes manquants en petits lots : un lot en échec (JSON tronqué,
// surcharge API…) n'impacte pas les autres langues ni les autres lots.
const TRANSLATE_CHUNK = 25;
async function translateBatch(texts, lang) {
  const langName = TRANSLATE_LANGS[lang];
  if (!langName) return texts.slice();
  const out = texts.map(t => (t == null ? '' : String(t)));
  const jobs = [];
  out.forEach((text, i) => {
    if (text.trim()) jobs.push({ i, text, hash: crypto.createHash('sha1').update(lang + '|' + text).digest('hex') });
  });
  if (!jobs.length) return out;
  // Cache
  const cached = await pool.query('SELECT source_hash, translated FROM content_translations WHERE lang=$1 AND source_hash = ANY($2)',
    [lang, jobs.map(j => j.hash)]);
  const cmap = Object.fromEntries(cached.rows.map(r => [r.source_hash, r.translated]));
  // Une entrée dont la traduction == texte source est un ancien repli « empoisonné »
  // (mis en cache pendant une panne de clé/crédits) : on l'ignore et on retraduit,
  // pour que le portail se répare tout seul sans purge manuelle du cache.
  const isReal = (j) => cmap[j.hash] != null && cmap[j.hash] !== j.text;
  jobs.forEach(j => { if (isReal(j)) out[j.i] = cmap[j.hash]; });
  const missing = jobs.filter(j => !isReal(j));
  if (!missing.length || !process.env.ANTHROPIC_API_KEY) return out;

  // Traduit un lot ; en cas d'échec, un seul nouvel essai avant repli.
  async function runChunk(chunk) {
    let tr;
    try {
      tr = await claudeTranslate(chunk.map(m => m.text), langName);
    } catch (e1) {
      try { tr = await claudeTranslate(chunk.map(m => m.text), langName); }
      catch (e2) { console.error(`[translate] ${lang} lot ${chunk.length} échec: ${e2.message}`); return; }
    }
    chunk.forEach((m, k) => {
      const val = (tr[k] != null && String(tr[k]).trim()) ? String(tr[k]) : m.text;
      out[m.i] = val;
      // On ne met en cache que ce qui a réellement été traduit (≠ repli original).
      if (val !== m.text) {
        pool.query('INSERT INTO content_translations (source_hash,lang,translated) VALUES ($1,$2,$3) ON CONFLICT (source_hash,lang) DO UPDATE SET translated = EXCLUDED.translated', [m.hash, lang, val]).catch(() => {});
      }
    });
  }

  const chunks = [];
  for (let i = 0; i < missing.length; i += TRANSLATE_CHUNK) chunks.push(missing.slice(i, i + TRANSLATE_CHUNK));
  await Promise.all(chunks.map(runChunk));
  return out;
}

app.post('/api/portal/translate', requireBuyerAuth, translateLimiter, async (req, res) => {
  try {
    const { texts, lang } = req.body;
    if (!Array.isArray(texts) || !lang || !TRANSLATE_LANGS[lang]) return res.status(400).json({ error: 'Requête invalide' });
    const clipped = texts.slice(0, 300).map(t => String(t == null ? '' : t).slice(0, 4000));
    res.json({ translations: await translateBatch(clipped, lang) });
  } catch(e) { console.error('translate endpoint:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Version publique (page /commande, sans session acheteur) — mêmes limites, rate-limitée.
app.post('/api/public/translate', publicLimiter, async (req, res) => {
  try {
    const { texts, lang } = req.body;
    if (!Array.isArray(texts) || !lang || !TRANSLATE_LANGS[lang]) return res.status(400).json({ error: 'Requête invalide' });
    const clipped = texts.slice(0, 300).map(t => String(t == null ? '' : t).slice(0, 4000));
    res.json({ translations: await translateBatch(clipped, lang) });
  } catch(e) { console.error('public translate:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/portal/search', requireBuyerAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const like = `%${escapeLike(q)}%`;
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
    const locked = await getLockedBrandIds(req.session.buyerPortal.id, r.rows.map(p => p.brand_id));
    res.json(r.rows.filter(p => !locked.has(p.brand_id)));
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/portal/selection-pdf', requireBuyerAuth, async (req, res) => {
  try {
    const items = req.body.items || [];
    if (!Array.isArray(items) || !items.length || items.length > 500) return res.status(400).json({ error: 'Sélection invalide' });
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
      const F = registerPdfFonts(doc);

      const hTop = 50;
      const selLogo = loadPdfLogo();
      if (selLogo) doc.image(selLogo, 50, hTop, { width: 40, height: 40 });
      const seTx = selLogo ? 102 : 50;
      doc.fontSize(16).fillColor('#0a0a0a').font(F.bold).text((showroomName||'').toUpperCase(), seTx, hTop + 2, { lineBreak: false, characterSpacing: 1 });
      doc.fontSize(8).fillColor('#9a9a9a').font(F.reg).text('SÉLECTION ACHETEUR — NON CONTRACTUEL', seTx, hTop + 22, { lineBreak: false, characterSpacing: 1.2 });
      doc.fontSize(8).fillColor('#9a9a9a').text(dateStr, seTx, hTop + 34, { lineBreak: false });
      doc.moveTo(50, hTop + 54).lineTo(545, hTop + 54).strokeColor('#dcdcdc').lineWidth(0.5).stroke();

      const infoY = hTop + 64;
      doc.fontSize(7.5).fillColor('#aaa').font(F.reg).text('ACHETEUR', 50, infoY);
      doc.fontSize(11).fillColor('#0a0a0a').font(F.bold).text(buyer.name || '', 50, infoY + 12);
      doc.fontSize(9).fillColor('#555').font(F.reg).text(buyer.email || '', 50, infoY + 26);
      if (buyer.company) doc.text(buyer.company, 50, infoY + 38);

      let rowY = infoY + 70;
      const col = { ref: 50, desc: 145, color: 295, size: 345, qty: 390, total: 455 };
      const colW = { ref: 90, desc: 145, color: 45, size: 40, qty: 30, total: 90 };

      Object.values(byBrand).forEach(({ name: brandName = 'Marque', lines }) => {
        if (rowY > 720) { doc.addPage(); rowY = 50; }
        doc.rect(50, rowY, 495, 20).fillColor('#0a0a0a').fill();
        doc.fontSize(9).fillColor('#ffffff').font(F.bold).text(brandName.toUpperCase(), 58, rowY + 5, { width: 477 });
        rowY += 26;

        doc.fontSize(7).fillColor('#aaa').font(F.reg);
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
          doc.fillColor('#0a0a0a').font(F.bold).text(l.reference || '', col.ref, rowY, { width: colW.ref });
          doc.fillColor('#333').font(F.reg).text(descText, col.desc, rowY, { width: colW.desc });
          doc.fillColor('#555')
            .text(l.color || '—', col.color, rowY, { width: colW.color })
            .text(l.size || '—', col.size, rowY, { width: colW.size });
          doc.fillColor('#0a0a0a').font(F.bold).text(String(l.qty), col.qty, rowY, { width: colW.qty, align: 'right' });
          doc.fillColor('#333').font(F.reg).text(`${lineTotal} €`, col.total, rowY, { width: colW.total, align: 'right' });
          rowY += 16;
        });

        const brandTotal = lines.reduce((s, l) => s + l.qty * parseFloat(l.price || 0), 0);
        doc.moveTo(380, rowY + 2).lineTo(545, rowY + 2).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        rowY += 6;
        doc.fontSize(8).fillColor('#555').font(F.reg).text(`Sous-total ${brandName}`, col.ref, rowY, { width: 320 });
        doc.fillColor('#0a0a0a').font(F.bold).text(`${brandTotal.toFixed(2)} €`, col.total, rowY, { width: colW.total, align: 'right' });
        rowY += 26;
      });

      if (rowY > 700) { doc.addPage(); rowY = 50; }
      doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#333').lineWidth(1).stroke();
      rowY += 10;
      doc.rect(380, rowY, 165, 24).fillColor('#0a0a0a').fill();
      doc.fontSize(10).fillColor('#ffffff').font(F.bold)
        .text('TOTAL HT', 390, rowY + 6, { width: 80 })
        .text(`${grandTotal.toFixed(2)} €`, 390, rowY + 6, { width: 145, align: 'right' });
      rowY += 36;

      doc.rect(50, rowY, 495, 36).fillColor('#fffde7').fill();
      doc.fontSize(8).fillColor('#b8860b').font(F.bold)
        .text('⚠ DOCUMENT NON CONTRACTUEL', 60, rowY + 6, { width: 475, align: 'center' });
      doc.fontSize(7.5).fillColor('#b8860b').font(F.reg)
        .text('Cette sélection ne constitue pas une commande ferme. Elle doit être validée et signée sur le portail.', 60, rowY + 18, { width: 475, align: 'center' });

      doc.end();
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', `attachment; filename="Selection-${Date.now()}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Forgot / reset password (public endpoints — no auth required)
app.post('/api/portal/forgot-password', buyerAuthLimiter, async (req, res) => {
  const { email } = req.body || {};
  res.json({ ok: true }); // always succeed — don't reveal if email exists
  if (!email) return;
  try {
    const b = await pool.query('SELECT id, name FROM buyers WHERE email=$1', [email.toLowerCase().trim()]);
    if (!b.rows[0]) return;
    const buyer = b.rows[0];
    // Seul le hash du token est stocké en base (comme un mot de passe) : un accès
    // en lecture seule à la base ne permet pas de rejouer un lien de reset actif.
    // Le token en clair ne part que dans l'email, jamais persisté.
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query('DELETE FROM buyer_password_resets WHERE buyer_id=$1', [buyer.id]);
    await pool.query(
      'INSERT INTO buyer_password_resets (token, buyer_id, expires_at) VALUES ($1,$2,$3)',
      [tokenHash, buyer.id, expires]
    );
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return;
    const resend = newResendClient(resendKey);
    const showroomName = await getSetting('showroom_name');
    const fromAddress = await getSetting('smtp_from');
    const resetUrl = `${getBaseUrl(req)}/editions-showroom-b2b-portail?token=${token}`;
    const buyerFull = await pool.query('SELECT lang FROM buyers WHERE id=$1', [buyer.id]);
    const isEn = buyerFull.rows[0]?.lang === 'en';
    const { error } = await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [email],
      subject: isEn
        ? `Password reset — ${showroomName}`
        : `Réinitialisation de mot de passe — ${showroomName}`,
      html: emailLayout({
        showroomName,
        content: isEn ? `
          <p>Hello${buyer.name ? ' <strong>' + escHtml(buyer.name) + '</strong>' : ''},</p>
          <p>You requested to reset your password for the <strong>${showroomName}</strong> B2B showroom.</p>
          ${emailBtn(resetUrl, 'Choose a new password →')}
          <p style="font-size:13px;color:#888;margin-top:24px">This link is valid for <strong>1 hour</strong>. If you did not make this request, ignore this email.</p>
          <p>Best regards,<br><strong>${showroomName}</strong></p>
        ` : `
          <p>Bonjour${buyer.name ? ' <strong>' + escHtml(buyer.name) + '</strong>' : ''},</p>
          <p>Vous avez demandé à réinitialiser votre mot de passe pour le showroom B2B <strong>${showroomName}</strong>.</p>
          ${emailBtn(resetUrl, 'Choisir un nouveau mot de passe →')}
          <p style="font-size:13px;color:#888;margin-top:24px">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
          <p>Cordialement,<br><strong>${showroomName}</strong></p>
        `
      })
    });
    if (error) console.error('[resend] forgot-password:', error.message || error);
  } catch (e) { console.error('forgot-password error:', e.message); }
});

app.post('/api/portal/reset-password', buyerAuthLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 12)
    return res.json({ error: 'Données invalides (12 caractères minimum).' });
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await pool.query(
      'SELECT buyer_id FROM buyer_password_resets WHERE token=$1 AND used=false AND expires_at > NOW()',
      [tokenHash]
    );
    if (!r.rows[0]) return res.json({ error: 'Lien invalide ou expiré.' });
    const hash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE buyers SET password_hash=$1 WHERE id=$2', [hash, r.rows[0].buyer_id]);
      await client.query('UPDATE buyer_password_resets SET used=true WHERE token=$1', [tokenHash]);
      await client.query('COMMIT');
    } catch(txErr) { await client.query('ROLLBACK'); throw txErr; }
    finally { client.release(); }
    // Un reset via lien mail invalide TOUTES les sessions existantes (pas de
    // session "courante" légitime à préserver ici, contrairement au change
    // via le portail où l'acheteur est déjà connecté).
    await invalidateBuyerSessions(r.rows[0].buyer_id, null);
    logAuditRaw('buyer:' + r.rows[0].buyer_id, 'password_reset', 'buyer', r.rows[0].buyer_id, req.ip);
    res.json({ ok: true });
  } catch (e) { res.json({ error: 'Erreur serveur.' }); }
});

// Admin: manage buyer accounts (owner + agent)
app.get('/api/buyers', requireRole('owner','agent'), async (req, res) => {
  const { country, active, minAmount } = req.query;
  const conditions = [];
  const params = [];
  if (isBrandScoped(req)) {
    params.push(req.userBrandId);
    conditions.push(`id IN (SELECT buyer_id FROM orders WHERE brand_id = $${params.length} AND buyer_id IS NOT NULL)`);
  }
  if (country) {
    params.push(country.toLowerCase());
    conditions.push(`LOWER(COALESCE(country,'')) = $${params.length}`);
  }
  if (active === 'active') {
    conditions.push(`last_seen_at > NOW() - INTERVAL '90 days'`);
  } else if (active === 'inactive') {
    conditions.push(`(last_seen_at IS NULL OR last_seen_at <= NOW() - INTERVAL '90 days')`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const r = await pool.query(
    `SELECT id, email, name, company, phone, country, lang, created_at, last_seen_at, tags, internal_notes FROM buyers ${where} ORDER BY created_at DESC`,
    params
  );
  let rows = r.rows;
  if (minAmount) {
    const min = parseFloat(minAmount) || 0;
    if (min > 0 && rows.length) {
      const amounts = await pool.query(
        `SELECT o.buyer_id, COALESCE(SUM(ol.quantity*ol.unit_price),0) as total
         FROM orders o LEFT JOIN order_lines ol ON ol.order_id=o.id
         WHERE o.buyer_id = ANY($1) GROUP BY o.buyer_id`,
        [rows.map(b => b.id)]
      );
      const amountMap = new Map(amounts.rows.map(a => [a.buyer_id, parseFloat(a.total)]));
      rows = rows.filter(b => (amountMap.get(b.id) || 0) >= min);
    }
  }
  res.json(rows);
});

// Tags et notes internes acheteur
app.patch('/api/buyers/:id/tags-notes', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkBuyerBrandScope(req, res)) return;
    const { tags, internal_notes } = req.body;
    if (tags !== undefined && tags !== null && typeof tags !== 'string') return res.status(400).json({ error: 'tags invalide' });
    if (internal_notes !== undefined && internal_notes !== null && typeof internal_notes !== 'string') return res.status(400).json({ error: 'internal_notes invalide' });
    await pool.query('UPDATE buyers SET tags=$1, internal_notes=$2 WHERE id=$3',
      [tags || '', internal_notes || '', req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/buyers/presence', requireRole('owner','agent'), async (req, res) => {
  const scoped = isBrandScoped(req);
  const r = await pool.query(
    `SELECT id, last_seen_at FROM buyers WHERE last_seen_at > NOW() - INTERVAL '90 seconds'
     ${scoped ? 'AND id IN (SELECT buyer_id FROM orders WHERE brand_id = $1 AND buyer_id IS NOT NULL)' : ''}`,
    scoped ? [req.userBrandId] : []
  );
  res.json(r.rows.map(b => b.id));
});

// Variante détaillée pour le dashboard (widget "Acheteurs en ligne") — nom/société
// affichés, contrairement à /api/buyers/presence qui ne renvoie que des IDs (utilisé
// ailleurs pour de simples correspondances de statut en/hors ligne).
app.get('/api/buyers/presence-detail', requireRole('owner','agent'), async (req, res) => {
  const scoped = isBrandScoped(req);
  const r = await pool.query(
    `SELECT id, name, company FROM buyers WHERE last_seen_at > NOW() - INTERVAL '90 seconds'
     ${scoped ? 'AND id IN (SELECT buyer_id FROM orders WHERE brand_id = $1 AND buyer_id IS NOT NULL)' : ''}
     ORDER BY name`,
    scoped ? [req.userBrandId] : []
  );
  res.json(r.rows);
});

app.post('/api/portal/ping', requireBuyerAuth, async (req, res) => {
  const { lang } = req.body;
  await pool.query('UPDATE buyers SET last_seen_at = NOW()' + (lang ? ', lang=$2' : '') + ' WHERE id = $1',
    lang ? [req.session.buyerPortal.id, lang] : [req.session.buyerPortal.id]);
  res.json({ ok: true });
});

app.put('/api/orders/:id/admin-notes', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const { admin_notes } = req.body;
    await pool.query('UPDATE orders SET admin_notes=$1 WHERE id=$2', [admin_notes || '', req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Fenêtre de livraison (ex. "Janvier – Février 2027") — fixée par l'agence
app.put('/api/orders/:id/delivery-window', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const dw = String(req.body.delivery_window || '').trim().slice(0, 120);
    await pool.query('UPDATE orders SET delivery_window=$1 WHERE id=$2', [dw, req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Modification d'une commande après envoi (agence) : ajuste les quantités et retire
// des lignes. Le stock est réajusté de façon atomique (restitue l'ancien, applique
// le nouveau). On ne touche pas aux prix (recalculés depuis les lignes).
app.put('/api/orders/:id/lines', requireRole('owner','agent'), async (req, res) => {
  if (!await checkOrderBrandScope(req, res)) return;
  const updates = Array.isArray(req.body.lines) ? req.body.lines : null;
  if (!updates) return res.status(400).json({ error: 'Lignes invalides' });
  // Map line_id -> nouvelle quantité (entier borné). Quantité 0 / ligne absente = suppression.
  const wanted = {};
  for (const u of updates) {
    if (!u || !u.id) continue;
    const q = Math.floor(Number(u.quantity));
    wanted[u.id] = Number.isFinite(q) && q > 0 && q <= MAX_LINE_QTY ? q : 0;
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const ord = await dbClient.query('SELECT status FROM orders WHERE id=$1', [req.params.id]);
    // 'cancelled' : le stock a déjà été recrédité en totalité par restoreOrderStock()
    // au moment de l'annulation — modifier les lignes ensuite recréditerait le stock
    // une seconde fois (delta<0) ou en réserverait à tort (delta>0). 'archived' est
    // un état terminal, comme sur /status et /sign.
    if (['cancelled','archived'].includes(ord.rows[0]?.status)) {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ error: 'Commande annulée ou archivée : lignes non modifiables.' });
    }
    // Lignes actuelles + état stock du produit (verrou ligne produit via FOR UPDATE indirect)
    const cur = await dbClient.query(
      `SELECT ol.id, ol.product_id, ol.quantity, ol.size, p.stock_enabled, p.stock_qty, p.reference
       FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id=$1`,
      [req.params.id]
    );
    if (!cur.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Commande sans ligne' }); }

    let remaining = 0;
    const changes = []; // { reference, size, old_qty, new_qty } — pour l'historique
    for (const line of cur.rows) {
      const newQty = (line.id in wanted) ? wanted[line.id] : line.quantity; // non fourni = inchangé
      const tracked = line.stock_enabled && line.stock_qty !== null;
      if (newQty === 0) {
        if (tracked) await dbClient.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id=$2', [line.quantity, line.product_id]);
        await dbClient.query('DELETE FROM order_lines WHERE id=$1', [line.id]);
        changes.push({ reference: line.reference, size: line.size, old_qty: line.quantity, new_qty: 0 });
        continue;
      }
      const delta = newQty - line.quantity;
      if (tracked && delta > 0) {
        const upd = await dbClient.query(
          'UPDATE products SET stock_qty = stock_qty - $1 WHERE id=$2 AND stock_qty IS NOT NULL AND stock_qty >= $1',
          [delta, line.product_id]
        );
        if (upd.rowCount === 0) { await dbClient.query('ROLLBACK'); return res.status(409).json({ error: `Stock insuffisant pour ${line.reference}` }); }
      } else if (tracked && delta < 0) {
        await dbClient.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id=$2', [-delta, line.product_id]);
      }
      if (delta !== 0) {
        await dbClient.query('UPDATE order_lines SET quantity=$1 WHERE id=$2', [newQty, line.id]);
        changes.push({ reference: line.reference, size: line.size, old_qty: line.quantity, new_qty: newQty });
      }
      remaining++;
    }
    if (remaining === 0) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'Une commande doit garder au moins une ligne. Annulez-la plutôt.' }); }
    await dbClient.query('COMMIT');

    logAudit(req, 'edit_order_lines', 'order', req.params.id, '');
    const changedBy = req.session?.staffUser?.email || (req.session?.admin ? 'admin' : 'system');
    const note = changes.length === 1
      ? `${changes[0].reference} (${changes[0].size || '—'}) : ${changes[0].old_qty} → ${changes[0].new_qty === 0 ? 'supprimée' : changes[0].new_qty}`
      : `${changes.length} ligne(s) modifiée(s)`;
    await addOrderEvent(req.params.id, 'lines_edited', note, changedBy, changes);
  } catch(e) {
    await dbClient.query('ROLLBACK').catch(() => {});
    console.error('[order-lines-edit]', e.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    dbClient.release();
  }
  const totRes = await pool.query('SELECT SUM(quantity * unit_price) AS total FROM order_lines WHERE order_id=$1', [req.params.id]);
  notifyOwnerOrder(req.params.id, 'Commande modifiée (quantités)').catch(() => {}); // copie email au propriétaire
  res.json({ ok: true, total: parseFloat(totRes.rows[0]?.total || 0) });
});

app.post('/api/admin/buyers/:id/relance', requireRole('owner','agent'), prospectInviteLimiter, async (req, res) => {
  try {
    if (!await checkBuyerBrandScope(req, res)) return;
    const b = await pool.query('SELECT * FROM buyers WHERE id=$1', [req.params.id]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Acheteur introuvable' });
    const buyer = b.rows[0];
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(503).json({ error: 'Email non configuré' });
    const [showroomName, agentName, fromAddress, showroomEmail] = await Promise.all([
      getSetting('showroom_name'), getSetting('agent_name'), getSetting('smtp_from'), getSetting('showroom_email')
    ]);
    const resend = newResendClient(resendKey);
    const { message, lang } = req.body;
    // Langue explicitement choisie par l'agent dans la modale de relance,
    // repli sur la langue enregistrée de l'acheteur si non précisée.
    const isEn = (lang === 'en' || lang === 'fr') ? lang === 'en' : buyer.lang === 'en';
    const tpl = await getEmailTemplate('relance', isEn ? 'en' : 'fr');
    const buttonHtml = emailBtn(`${getBaseUrl(req)}/portal`, isEn ? 'Access showroom →' : 'Accéder au showroom →');
    const subject = applyTemplateVars(tpl.subject, { showroom: escHtml(showroomName || '') });
    // Un message personnalisé (saisi pour cet envoi précis) remplace le corps
    // du modèle éditable — le bouton reste toujours présent.
    const bodyHtml = message
      ? `<p>${isEn ? `Hello <strong>${escHtml(buyer.name)}</strong>,` : `Bonjour <strong>${escHtml(buyer.name)}</strong>,`}</p><p>${escHtml(message).replace(/\n/g,'<br>')}</p>${buttonHtml}`
      : applyTemplateVars(tpl.body, { acheteur: escHtml(buyer.name), agent: escHtml(agentName || showroomName || ''), showroom: escHtml(showroomName || ''), bouton: buttonHtml });
    const { error } = await resend.emails.send({
      from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
      to: [buyer.email],
      ...(showroomEmail ? { replyTo: showroomEmail } : {}), // réponses de l'acheteur → showroom
      ...(showroomEmail && showroomEmail.toLowerCase() !== buyer.email.toLowerCase() ? { bcc: [showroomEmail] } : {}),
      subject,
      html: emailLayout({ showroomName, content: bodyHtml })
    });
    if (error) { console.error('[resend] relance:', error.message || error); return res.status(502).json({ error: 'Échec envoi email' }); }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/api/admin/search', requireRole('owner','agent'), async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ orders: [], buyers: [], selections: [] });
  const like = `%${escapeLike(q)}%`;
  // Agent scopé : la recherche ne remonte que les données de sa marque.
  const scoped = isBrandScoped(req);
  const bId = req.userBrandId;
  const [orders, buyers, selections] = await Promise.all([
    pool.query(`SELECT o.id, o.order_number, o.client_name, o.client_email, o.client_company, o.status, b.name as brand_name,
      SUM(ol.quantity*ol.unit_price) as total, o.created_at
      FROM orders o JOIN brands b ON o.brand_id=b.id LEFT JOIN order_lines ol ON ol.order_id=o.id
      WHERE (o.client_name ILIKE $1 OR o.client_email ILIKE $1 OR o.client_company ILIKE $1 OR o.order_number ILIKE $1)
      ${scoped ? 'AND o.brand_id = $2' : ''}
      GROUP BY o.id, b.name ORDER BY o.created_at DESC LIMIT 5`, scoped ? [like, bId] : [like]),
    pool.query(`SELECT id, name, email, company FROM buyers
      WHERE (name ILIKE $1 OR email ILIKE $1 OR company ILIKE $1)
      ${scoped ? 'AND id IN (SELECT buyer_id FROM orders WHERE brand_id = $2 AND buyer_id IS NOT NULL)' : ''}
      LIMIT 5`, scoped ? [like, bId] : [like]),
    pool.query(`SELECT id, selection_number, client_name, client_email FROM agent_selections
      WHERE (client_name ILIKE $1 OR client_email ILIKE $1 OR selection_number ILIKE $1)
      ${scoped ? 'AND brand_id = $2' : ''}
      ORDER BY created_at DESC LIMIT 5`, scoped ? [like, bId] : [like]).catch(() => ({ rows: [] }))
  ]);
  res.json({ orders: orders.rows, buyers: buyers.rows, selections: selections.rows });
});

app.get('/api/stats', requireRole('owner','agent'), async (req, res) => {
  try {
    // Un agent rattaché à une marque ne voit que ses propres chiffres (pas le CA global du showroom).
    const scoped = isBrandScoped(req);
    const bId = req.userBrandId;
    const oFilter = scoped ? 'AND o.brand_id = $1' : '';
    const p = scoped ? [bId] : [];
    const [brandsR, ordersR, revenueR, buyersR, orders30R, selConvR] = await Promise.all([
      scoped
        ? pool.query(`SELECT COUNT(*) as brands_count FROM brands WHERE id = $1`, p)
        : pool.query(`SELECT COUNT(*) as brands_count FROM brands WHERE subscription_status != 'inactive' OR subscription_status IS NULL`),
      pool.query(`SELECT COUNT(*) as orders_count FROM orders o WHERE o.status NOT IN ('draft','cancelled','archived') ${oFilter}`, p),
      pool.query(`SELECT COALESCE(SUM(ol.quantity * ol.unit_price), 0) as revenue_total FROM orders o LEFT JOIN order_lines ol ON ol.order_id = o.id WHERE o.status NOT IN ('draft','cancelled','archived') ${oFilter}`, p),
      scoped
        ? pool.query(`SELECT COUNT(DISTINCT o.buyer_id) as buyers_count FROM orders o WHERE o.buyer_id IS NOT NULL AND o.brand_id = $1`, p)
        : pool.query(`SELECT COUNT(*) as buyers_count FROM buyers`),
      pool.query(`SELECT COUNT(*) as orders_last30 FROM orders o WHERE o.status NOT IN ('draft','cancelled') AND o.created_at >= NOW() - INTERVAL '30 days' ${oFilter}`, p),
      // Conversion sélections → commandes (sélections confirmées / envoyées, hors templates)
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE used = true)::int AS confirmed
                  FROM agent_selections a
                  WHERE (a.is_template IS NULL OR a.is_template = false) ${scoped ? 'AND a.brand_id = $1' : ''}`, p)
    ]);
    const selTotal = parseInt(selConvR.rows[0]?.total) || 0;
    const selConfirmed = parseInt(selConvR.rows[0]?.confirmed) || 0;
    res.json({
      brands_count: parseInt(brandsR.rows[0].brands_count) || 0,
      orders_count: parseInt(ordersR.rows[0].orders_count) || 0,
      revenue_total: parseFloat(revenueR.rows[0].revenue_total) || 0,
      buyers_count: parseInt(buyersR.rows[0].buyers_count) || 0,
      orders_last30: parseInt(orders30R.rows[0].orders_last30) || 0,
      selections_total: selTotal,
      selections_confirmed: selConfirmed,
      conversion_rate: selTotal ? Math.round((selConfirmed / selTotal) * 100) : 0
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Timeline commerciale — fil chronologique des événements business récents,
// tous acheteurs confondus (contrairement à l'historique de la fiche buyer
// 360°, qui est déjà filtré sur un seul acheteur). Utile pour un coup d'œil
// rapide sur "ce qu'il s'est passé" sans ouvrir chaque fiche client.
app.get('/api/admin/dashboard/timeline', requireRole('owner','agent'), async (req, res) => {
  try {
    const lang = req.query.lang === 'en' ? 'en' : 'fr';
    const scoped = isBrandScoped(req);
    const bId = req.userBrandId;
    const p = scoped ? [bId] : [];
    const LIMIT = 40;
    const [sels, orders, appts, reminders, orderEvents] = await Promise.all([
      pool.query(`SELECT s.created_at AS at, s.created_by AS who, s.selection_number, s.client_name, s.client_company, b.name AS brand_name
                  FROM agent_selections s JOIN brands b ON b.id = s.brand_id
                  WHERE (s.is_template IS NULL OR s.is_template = false) ${scoped ? 'AND s.brand_id = $1' : ''}
                  ORDER BY s.created_at DESC LIMIT ${LIMIT}`, p),
      pool.query(`SELECT o.created_at AS at, o.order_number, o.client_name, o.client_company, b.name AS brand_name
                  FROM orders o JOIN brands b ON b.id = o.brand_id
                  WHERE o.status != 'draft' ${scoped ? 'AND o.brand_id = $1' : ''}
                  ORDER BY o.created_at DESC LIMIT ${LIMIT}`, p),
      pool.query(`SELECT a.created_at AS at, to_char(a.slot_date, 'YYYY-MM-DD') AS slot_date, a.slot_time, a.client_name, b.name AS brand_name
                  FROM appointments a JOIN brands b ON b.id = a.brand_id
                  WHERE 1=1 ${scoped ? 'AND a.brand_id = $1' : ''}
                  ORDER BY a.created_at DESC LIMIT ${LIMIT}`, p),
      scoped
        ? pool.query(`SELECT p.resolved_at AS at, p.type, p.label, p.status, p.resolved_by
                      FROM pending_reminders p JOIN agent_selections s ON s.token = p.target_id
                      WHERE p.status != 'pending' AND p.resolved_at IS NOT NULL AND p.type = 'selection_reminder' AND s.brand_id = $1
                      ORDER BY p.resolved_at DESC LIMIT ${LIMIT}`, [bId])
        : pool.query(`SELECT resolved_at AS at, type, label, status, resolved_by
                  FROM pending_reminders WHERE status != 'pending' AND resolved_at IS NOT NULL
                  ORDER BY resolved_at DESC LIMIT ${LIMIT}`),
      pool.query(`SELECT e.created_at AS at, e.event_type, e.note, e.created_by, o.order_number, b.name AS brand_name
                  FROM order_events e JOIN orders o ON o.id = e.order_id JOIN brands b ON b.id = o.brand_id
                  WHERE 1=1 ${scoped ? 'AND o.brand_id = $1' : ''}
                  ORDER BY e.created_at DESC LIMIT ${LIMIT}`, p)
    ]);
    const events = [];
    if (lang === 'en') {
      sels.rows.forEach(s => events.push({ at: s.at, icon: '📤', text: `Selection ${s.selection_number || ''} sent to ${s.client_name || s.client_company || ''} — ${s.brand_name}`, who: s.who || '' }));
      orders.rows.forEach(o => events.push({ at: o.at, icon: '🧾', text: `Order ${o.order_number || ''} from ${o.client_name || o.client_company || ''} — ${o.brand_name}`, who: '' }));
      appts.rows.forEach(a => events.push({ at: a.at, icon: '📅', text: `Appointment booked with ${a.client_name || ''} on ${a.slot_date}${a.slot_time ? ' at ' + a.slot_time : ''} — ${a.brand_name}`, who: '' }));
      reminders.rows.forEach(r => events.push({ at: r.at, icon: r.status === 'sent' ? '✉️' : '🚫', text: `Reminder ${r.status === 'sent' ? 'sent' : 'rejected'} — ${r.label || r.type}`, who: r.resolved_by || '' }));
      orderEvents.rows.forEach(e => events.push({ at: e.at, icon: '📦', text: `Order ${e.order_number || ''} — ${e.event_type}${e.note ? ' : ' + e.note : ''} — ${e.brand_name}`, who: e.created_by || '' }));
    } else {
      sels.rows.forEach(s => events.push({ at: s.at, icon: '📤', text: `Sélection ${s.selection_number || ''} envoyée à ${s.client_name || s.client_company || ''} — ${s.brand_name}`, who: s.who || '' }));
      orders.rows.forEach(o => events.push({ at: o.at, icon: '🧾', text: `Commande ${o.order_number || ''} de ${o.client_name || o.client_company || ''} — ${o.brand_name}`, who: '' }));
      appts.rows.forEach(a => events.push({ at: a.at, icon: '📅', text: `RDV pris avec ${a.client_name || ''} le ${a.slot_date}${a.slot_time ? ' à ' + a.slot_time : ''} — ${a.brand_name}`, who: '' }));
      reminders.rows.forEach(r => events.push({ at: r.at, icon: r.status === 'sent' ? '✉️' : '🚫', text: `Relance ${r.status === 'sent' ? 'envoyée' : 'rejetée'} — ${r.label || r.type}`, who: r.resolved_by || '' }));
      orderEvents.rows.forEach(e => events.push({ at: e.at, icon: '📦', text: `Commande ${e.order_number || ''} — ${e.event_type}${e.note ? ' : ' + e.note : ''} — ${e.brand_name}`, who: e.created_by || '' }));
    }
    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ events: events.slice(0, LIMIT) });
  } catch(e) { console.error('dashboard timeline:', e.message); res.status(500).json({ error: lang === 'en' ? 'Server error' : 'Erreur serveur' }); }
});

// Vue « priorités du jour » — agrège tout ce qui attend une action de
// l'agence aujourd'hui : relances à valider, RDV du jour, demandes d'accès
// en attente, sélections sur le point d'expirer, commandes signées par
// l'acheteur mais pas encore contresignées par l'agent. Chaque type a son
// propre workflow existant (relances-a-valider, demandes-d-acces…) — cette
// vue ne fait qu'agréger ce qui est déjà en base pour un coup d'œil unique.
app.get('/api/admin/dashboard/priorities', requireRole('owner','agent'), async (req, res) => {
  try {
    const scoped = isBrandScoped(req);
    const bId = req.userBrandId;
    const p = scoped ? [bId] : [];
    const [pendingReminders, todayAppts, accessRequests, expiringSels, unsignedOrders] = await Promise.all([
      scoped
        ? pool.query(`SELECT p.id, p.type, p.label, p.created_at
                      FROM pending_reminders p JOIN agent_selections s ON s.token = p.target_id
                      WHERE p.status = 'pending' AND p.type = 'selection_reminder' AND s.brand_id = $1
                      ORDER BY p.created_at ASC LIMIT 20`, [bId])
        : pool.query(`SELECT id, type, label, created_at FROM pending_reminders WHERE status='pending' ORDER BY created_at ASC LIMIT 20`),
      pool.query(`SELECT a.id, a.client_name, a.slot_time, b.name AS brand_name
                  FROM appointments a JOIN brands b ON b.id = a.brand_id
                  WHERE a.slot_date = CURRENT_DATE ${scoped ? 'AND a.brand_id = $1' : ''}
                  ORDER BY a.slot_time ASC`, p),
      pool.query(`SELECT id, name, company, email, created_at FROM access_requests WHERE status='pending' ORDER BY created_at ASC LIMIT 20`),
      pool.query(`SELECT s.token, s.selection_number, s.client_name, s.client_company, s.expires_at, b.name AS brand_name
                  FROM agent_selections s JOIN brands b ON b.id = s.brand_id
                  WHERE s.used = false AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
                  ${scoped ? 'AND s.brand_id = $1' : ''}
                  ORDER BY s.expires_at ASC LIMIT 20`, p),
      pool.query(`SELECT o.id, o.order_number, o.client_name, o.client_company, o.created_at, b.name AS brand_name
                  FROM orders o JOIN brands b ON b.id = o.brand_id
                  WHERE o.agent_signature IS NULL AND o.status NOT IN ('draft','cancelled','archived')
                  ${scoped ? 'AND o.brand_id = $1' : ''}
                  ORDER BY o.created_at ASC LIMIT 20`, p)
    ]);
    res.json({
      pendingReminders: pendingReminders.rows,
      todayAppointments: todayAppts.rows,
      accessRequests: accessRequests.rows,
      expiringSelections: expiringSels.rows,
      unsignedOrders: unsignedOrders.rows,
      total: pendingReminders.rows.length + todayAppts.rows.length + accessRequests.rows.length + expiringSels.rows.length + unsignedOrders.rows.length
    });
  } catch(e) { console.error('dashboard priorities:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/search', requireRole('owner','agent'), async (req, res) => {
  req.url = req.url.replace('/api/search', '/api/admin/search');
  res.redirect(307, '/api/admin/search?' + new URLSearchParams({ q: req.query.q || '' }));
});

app.get('/api/dashboard/revenue-chart', requireRole('owner','agent'), async (req, res) => {
  try {
    const lang = req.query.lang === 'en' ? 'en-GB' : 'fr-FR';
    const scoped = isBrandScoped(req);
    const r = await pool.query(`
      SELECT DATE_TRUNC('month', o.created_at) as month_date,
             COALESCE(SUM(ol.quantity * ol.unit_price), 0) as total
      FROM orders o
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      WHERE o.created_at >= NOW() - INTERVAL '6 months'
        AND o.status NOT IN ('draft', 'cancelled')
        ${scoped ? 'AND o.brand_id = $1' : ''}
      GROUP BY DATE_TRUNC('month', o.created_at)
      ORDER BY month_date ASC
    `, scoped ? [req.userBrandId] : []);
    // Build a map of existing data
    const byMonth = {};
    r.rows.forEach(row => {
      const key = new Date(row.month_date).toISOString().slice(0, 7);
      byMonth[key] = { total: parseFloat(row.total) || 0 };
    });
    // Fill in all 6 months including those with 0
    const result = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthName = d.toLocaleDateString(lang, { month: 'short' });
      result.push({ month: monthName, total: (byMonth[key] || { total: 0 }).total });
    }
    res.json(result);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/dashboard/top-products', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const scoped = isBrandScoped(req);
    const r = await pool.query(`
      SELECT p.id, p.reference, p.description, p.color, b.name as brand_name,
             SUM(ol.quantity) as qty, COALESCE(SUM(ol.quantity * ol.unit_price), 0) as revenue
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN products p ON p.id = ol.product_id
      JOIN brands b ON b.id = p.brand_id
      WHERE o.created_at >= NOW() - INTERVAL '6 months'
        AND o.status NOT IN ('draft', 'cancelled')
        ${scoped ? 'AND o.brand_id = $1' : ''}
      GROUP BY p.id, p.reference, p.description, p.color, b.name
      ORDER BY qty DESC
      LIMIT 8
    `, scoped ? [req.userBrandId] : []);
    res.json(r.rows.map(row => ({ ...row, qty: parseInt(row.qty, 10) || 0, revenue: parseFloat(row.revenue) || 0 })));
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
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
  const times = APPOINTMENT_TIMES;
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
  if (!isValidAppointmentSlot(String(slot_date), String(slot_time))) {
    return res.status(400).json({ error: 'Créneau invalide' });
  }
  const id = crypto.randomUUID();
  try {
    const brand = await pool.query('SELECT name FROM brands WHERE id=$1', [brand_id]);
    if (!brand.rows.length) return res.status(404).json({ error: 'Marque introuvable' });
    await pool.query(
      'INSERT INTO appointments (id,brand_id,client_name,client_email,client_phone,slot_date,slot_time,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, brand_id, buyer.name, buyer.email, buyer.phone||'', slot_date, slot_time, notes||'']
    );
    res.json({ ok: true, id });
    airtableTouchStore(buyer.email).catch(() => {}); // reflète le RDV dans le CRM Airtable
    // Contrairement à /api/public/appointments, cette route (acheteur déjà
    // connecté) n'avait aucune notification propriétaire — ni email ni push.
    sendPushToAdmins('Nouveau rendez-vous', `${buyer.name || buyer.email} — ${brand.rows[0].name} — ${slot_date} ${slot_time}`, brand_id).catch(() => {});
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ce créneau est déjà réservé' });
    console.error(e); res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post('/api/buyers', requireRole('owner','agent'), async (req, res) => {
  const { email, password, name, company, phone, country } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  for (const [k, v] of Object.entries({ email, name, company, phone, country })) {
    if (v !== undefined && v !== null && typeof v !== 'string') return res.status(400).json({ error: `Champ "${k}" invalide` });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) return res.status(400).json({ error: 'Email invalide' });
  if (password.length < 12) return res.status(400).json({ error: 'Mot de passe trop court (12 caractères minimum)' });
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

async function sendBuyerWelcomeEmail({ email, password, name, req, lang }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('RESEND_API_KEY non configurée — email de bienvenue acheteur non envoyé'); return; }
  const resend = newResendClient(resendKey);
  const showroomName = await getSetting('showroom_name');
  const fromAddress = await getSetting('smtp_from');
  const fromField = fromAddress || 'showroom@editionsstandard.com';
  const portalUrl = `${getBaseUrl(req)}/editions-showroom-b2b-portail`;
  const isEn = lang === 'en';

  const { error } = await resend.emails.send({
    from: `${showroomName} <${fromField}>`,
    to: [email],
    subject: isEn ? `Your showroom access — ${showroomName}` : `Votre accès au showroom — ${showroomName}`,
    html: emailLayout({
      showroomName,
      content: isEn ? `
        <p>Hello${name ? ' <strong>' + escHtml(name) + '</strong>' : ''},</p>
        <p>Your B2B showroom access for <strong>${showroomName}</strong> has been created. You can now browse our brands, view collections, and place orders online.</p>
        ${emailInfoBox([
          ['Email', email],
          ['Password', password],
        ])}
        <p style="font-size:13px;color:#888">You can change this password at any time from your account, under <strong>My profile</strong>.</p>
        ${emailBtn(portalUrl, 'Access showroom →')}
        <p style="font-size:13px;color:#888;margin-top:28px">Feel free to contact us if you have any questions.</p>
        <p>Best regards,<br><strong>${showroomName}</strong></p>
      ` : `
        <p>Bonjour${name ? ' <strong>' + escHtml(name) + '</strong>' : ''},</p>
        <p>Votre accès au showroom B2B <strong>${showroomName}</strong> a été créé. Vous pouvez dès à présent parcourir nos marques, consulter les collections et passer vos commandes en ligne.</p>
        ${emailInfoBox([
          ['Email', email],
          ['Mot de passe', password],
        ])}
        <p style="font-size:13px;color:#888">Vous pouvez modifier ce mot de passe à tout moment depuis votre espace, rubrique <strong>Mon profil</strong>.</p>
        ${emailBtn(portalUrl, 'Accéder au showroom →')}
        <p style="font-size:13px;color:#888;margin-top:28px">En cas de question, n'hésitez pas à nous contacter.</p>
        <p>Cordialement,<br><strong>${showroomName}</strong></p>
      `
    })
  });
  if (error) console.error('[resend] buyer-welcome-email:', error.message || error);
}

app.put('/api/buyers/:id', requireRole('owner','agent'), async (req, res) => {
  try {
    if (!await checkBuyerBrandScope(req, res)) return;
    const { name, company, email, phone, country, password } = req.body;
    // Un tableau/objet accepté tel quel dans une colonne text se sérialise en
    // littéral Postgres illisible (ex. email="{a@x.com,b@x.com}") et corrompt
    // silencieusement le compte (login impossible) sans jamais lever d'erreur.
    for (const [k, v] of Object.entries({ name, company, email, phone, country })) {
      if (v !== undefined && v !== null && typeof v !== 'string') return res.status(400).json({ error: `Champ "${k}" invalide` });
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) return res.status(400).json({ error: 'Email invalide' });
    if (password) {
      if (password.length < 12) return res.status(400).json({ error: 'Mot de passe trop court (12 caractères minimum)' });
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
    // Un acheteur est partagé entre marques : un agent scopé ne peut pas supprimer
    // un compte global (cela impacterait les commandes d'autres marques).
    if (isBrandScoped(req)) return res.status(403).json({ error: 'Suppression réservée à un administrateur showroom.' });
    // Même traitement que la suppression en libre-service (RGPD) : un simple
    // DELETE FROM buyers laissait nom/email/téléphone/société/pays/notes et la
    // signature manuscrite intacts et en clair dans orders (buyer_id passe juste
    // à NULL) — un acheteur supprimé côté admin restait donc entièrement
    // identifiable dans l'historique des commandes.
    await anonymizeAndDeleteBuyer(req.params.id);
    logAudit(req, 'delete_buyer', 'buyer', req.params.id, '');
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
  const b = await pool.query('SELECT name FROM brands WHERE id=$1', [req.params.brandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  const token = crypto.randomBytes(24).toString('hex');
  // DELETE avant de calculer le slug : cf. commentaire équivalent plus haut
  // (auto-création du lien) — évite de faire dériver le slug à chaque régénération.
  await pool.query('DELETE FROM brand_invite_links WHERE brand_id=$1', [req.params.brandId]);
  const slug = await uniqueSlugFor('brand_invite_links', b.rows[0].name);
  await pool.query('INSERT INTO brand_invite_links (token, brand_id, active, slug) VALUES ($1,$2,1,$3)', [token, req.params.brandId, slug]);
  res.json({ token, slug });
});

app.put('/api/brands/:brandId/invite-link/toggle', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const { active } = req.body;
    await pool.query('UPDATE brand_invite_links SET active=$1 WHERE brand_id=$2', [active ? 1 : 0, req.params.brandId]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Demandes de lien de partage (marque → agence) ───────────────────────────
// La distribution est réservée à l'agence ; une marque peut demander un lien,
// l'agence reçoit la demande puis génère/partage le lien elle-même.
app.post('/api/brands/:brandId/share-request', emailLimiter, requireBrandScope('owner','agent','designer'), async (req, res) => {
  try {
    const message = String(req.body.message || '').trim().slice(0, 1000);
    const brand = await pool.query('SELECT name FROM brands WHERE id=$1', [req.params.brandId]);
    if (!brand.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
    const requestedBy = req.session?.staffUser?.email || (req.session?.admin ? 'owner' : '');
    await pool.query(
      'INSERT INTO share_requests (id, brand_id, requested_by, message) VALUES ($1,$2,$3,$4)',
      [uuidv4(), req.params.brandId, requestedBy, message]
    );
    // Notifie l'agence (push + email best-effort, non bloquant)
    sendPushToAdmins('Demande de lien de partage', `${brand.rows[0].name}${requestedBy ? ' — ' + requestedBy : ''}`).catch(() => {});
    (async () => {
      const resendKey = process.env.RESEND_API_KEY;
      const [showroomName, adminEmail, fromAddress] = await Promise.all([
        getSetting('showroom_name'), getSetting('showroom_email'), getSetting('smtp_from')
      ]);
      if (!resendKey || !adminEmail) return;
      const resend = newResendClient(resendKey);
      const { error } = await resend.emails.send({
        from: `${showroomName} <${fromAddress || 'showroom@editionsstandard.com'}>`,
        to: [adminEmail],
        subject: `Demande de lien de partage — ${brand.rows[0].name}`,
        html: emailLayout({ showroomName, content: `
          <p>La marque <strong>${escHtml(brand.rows[0].name)}</strong> demande un lien de partage.</p>
          ${requestedBy ? `<p style="color:#888;font-size:13px">Demandé par : ${escHtml(requestedBy)}</p>` : ''}
          ${message ? `<p style="background:#f6f6f6;padding:12px;border-radius:6px">${escHtml(message)}</p>` : ''}
          <p style="color:#888;font-size:13px">Gérez les demandes depuis votre tableau de bord admin.</p>
        ` })
      });
      if (error) console.error('[resend] share-request-notify:', error.message || error);
    })().catch(e => console.error('share-request notify:', e.message));
    res.json({ ok: true });
  } catch(e) { console.error('share-request:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Liste des demandes en attente (vue agence)
app.get('/api/share-requests', requireRole('owner','agent'), async (req, res) => {
  const scoped = isBrandScoped(req);
  const r = await pool.query(`
    SELECT s.id, s.brand_id, s.requested_by, s.message, s.created_at, b.name as brand_name
    FROM share_requests s JOIN brands b ON b.id = s.brand_id
    WHERE s.status='pending' ${scoped ? 'AND s.brand_id = $1' : ''}
    ORDER BY s.created_at DESC
  `, scoped ? [req.userBrandId] : []);
  res.json(r.rows);
});

// Marque une demande comme traitée
app.post('/api/share-requests/:id/handle', requireRole('owner','agent'), async (req, res) => {
  try {
    const row = await pool.query('SELECT brand_id FROM share_requests WHERE id=$1', [req.params.id]);
    if (!row.rows[0]) return res.status(404).json({ error: 'Demande introuvable' });
    if (isBrandScoped(req) && row.rows[0].brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    await pool.query("UPDATE share_requests SET status='handled' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/rejoindre/:token', (req, res) => sendPage(res, 'invite.html'));
app.get('/demande-acces', (req, res) => sendPage(res, 'demande-acces.html'));
app.get('/confidentialite', (req, res) => sendPage(res, 'confidentialite.html'));
app.get('/cgu', (req, res) => sendPage(res, 'cgu.html'));
app.get('/mentions-legales', (req, res) => sendPage(res, 'mentions-legales.html'));

// ── Demandes d'accès acheteur ──────────────────────────────────────────────

app.post('/api/access-request', publicLimiter, async (req, res) => {
 try {
  const { name, company, phone, email, country, instagram, website, message, privacy_accepted, marketing_consent } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Nom et email requis' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) return res.status(400).json({ error: 'Email invalide' });
  // RGPD (P0-11) : acceptation de la politique de confidentialité obligatoire.
  if (privacy_accepted !== true) return res.status(400).json({ error: 'Vous devez accepter la politique de confidentialité.' });
  // Vérifier doublon (même email en pending)
  const dup = await pool.query("SELECT id FROM access_requests WHERE email=$1 AND status='pending'", [email.toLowerCase().trim()]);
  if (dup.rows.length) return res.status(409).json({ error: 'Une demande est déjà en cours pour cet email.' });
  const id = uuidv4();
  await pool.query(
    "INSERT INTO access_requests (id,name,company,phone,email,country,instagram,website,message,marketing_consent,privacy_accepted_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW() + INTERVAL '30 days')",
    [id, name.trim(), (company||'').trim(), (phone||'').trim(), email.toLowerCase().trim(), (country||'').trim(), (instagram||'').trim(), safeHttpUrl(website), (message||'').trim(), marketing_consent === true]
  );
  // CRM Airtable : crée une fiche « Prospect » (non bloquant)
  airtableUpsertProspect({ email: email.toLowerCase().trim(), name: name.trim(), company: (company||'').trim() }).catch(() => {});
  sendPushToAdmins('Nouvelle demande d\'accès', `${name}${company ? ' — ' + company : ''}`).catch(() => {});
  // Notifier l'admin
  const [showroomName, adminEmail, fromAddress] = await Promise.all([
    getSetting('showroom_name'), getSetting('showroom_email'), getSetting('smtp_from')
  ]);
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && adminEmail) {
    const resend = newResendClient(resendKey);
    const from = fromAddress || 'showroom@editionsstandard.com';
    const adminUrl = `${req.protocol}://${req.get('host')}/admin`;
    const { error: sendErr } = await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [adminEmail],
      subject: `Nouvelle demande d'accès — ${name} (${company || email})`,
      html: emailLayout({ showroomName, content: `
        <p>Une nouvelle demande d'accès au showroom vient d'être soumise.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888;width:120px">Nom</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)"><strong>${escHtml(name)}</strong></td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888">Société</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)">${escHtml(company||'—')}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888">Téléphone</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)">${escHtml(phone||'—')}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888">Email</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)">${escHtml(email)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888">Pays</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)">${escHtml(country||'—')}</td></tr>
          ${instagram ? `<tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888">Instagram</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)">${escHtml(instagram)}</td></tr>` : ''}
          ${website ? `<tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888">Website</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)"><a href="${escHtml(safeHttpUrl(website))}" style="color:#6b8500">${escHtml(website)}</a></td></tr>` : ''}
          ${message ? `<tr><td style="padding:8px;color:#888;vertical-align:top">Message</td><td style="padding:8px">${escHtml(message)}</td></tr>` : ''}
        </table>
        ${emailBtn(adminUrl, 'GÉRER LES DEMANDES →')}
      ` })
    });
    if (sendErr) console.error('[resend] access-request-notify:', sendErr.message || sendErr);
  }
  res.json({ ok: true });
 } catch(e) { console.error('access-request error:', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/access-requests', requireRole('owner','agent'), async (req, res) => {
  // existing_account : signale au staff qu'un compte acheteur existe déjà pour cet
  // email — approuver réinitialisera son mot de passe plutôt que d'en créer un nouveau.
  const r = await pool.query(`
    SELECT ar.*, (b.id IS NOT NULL) AS existing_account
    FROM access_requests ar
    LEFT JOIN buyers b ON LOWER(b.email) = LOWER(ar.email)
    ORDER BY ar.created_at DESC
  `);
  res.json(r.rows);
});

app.post('/api/access-requests/:id/approve', requireRole('owner','agent'), async (req, res) => {
 try {
  const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Demande introuvable' });
  const req2 = r.rows[0];
  if (req2.status !== 'pending') return res.status(400).json({ error: 'Demande déjà traitée' });

  // Créer (ou réutiliser) le compte acheteur avec un mot de passe temporaire.
  // Un compte peut déjà exister (ré-inscription, test, approbation partielle
  // antérieure) : dans ce cas on réinitialise son mot de passe au lieu
  // d'échouer, sinon la demande resterait bloquée « en attente » pour toujours.
  const email = String(req2.email || '').toLowerCase().trim();
  const tempPassword = crypto.randomBytes(12).toString('hex'); // mot de passe temporaire, envoyé par email — forte entropie requise
  const hash = await bcrypt.hash(tempPassword, 10);
  const existing = await pool.query('SELECT id FROM buyers WHERE LOWER(email)=$1', [email]);
  let buyerId, reused = false;
  if (existing.rows.length) {
    buyerId = existing.rows[0].id;
    reused = true;
    await pool.query('UPDATE buyers SET password_hash=$1 WHERE id=$2', [hash, buyerId]);
    // Cohérent avec change-password et reset-password : un mot de passe réinitialisé
    // invalide les sessions existantes (sinon une session déjà ouverte reste valide
    // avec l'ancien mot de passe alors que le nouveau vient d'être envoyé par email).
    await invalidateBuyerSessions(buyerId, null);
  } else {
    buyerId = uuidv4();
    await pool.query(
      'INSERT INTO buyers (id,email,password_hash,name,company,phone,country) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [buyerId, email, hash, req2.name, req2.company, req2.phone, req2.country]
    );
  }
  await pool.query("UPDATE access_requests SET status='approved' WHERE id=$1", [req.params.id]);
  logAudit(req, 'approve_access_request', 'access_request', req.params.id, req2.email);

  // Email de bienvenue avec les identifiants
  const [showroomName, fromAddress] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from')]);
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const resend = newResendClient(resendKey);
    const from = fromAddress || 'showroom@editionsstandard.com';
    const loginUrl = `${req.protocol}://${req.get('host')}/editions-showroom-b2b-portail`;
    // Fetch buyer lang (just created — default 'fr', can't be 'en' yet unless set elsewhere)
    const buyerLangRes = await pool.query('SELECT lang FROM buyers WHERE id=$1', [buyerId]);
    const isEn = buyerLangRes.rows[0]?.lang === 'en';
    const { error: sendErr } = await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [req2.email],
      subject: isEn
        ? `Your showroom access to ${showroomName} is confirmed`
        : `Votre accès au showroom ${showroomName} est confirmé`,
      html: emailLayout({ showroomName, content: isEn ? `
        <p>Hello <strong>${escHtml(req2.name)}</strong>,</p>
        <p>Your access request to the <strong>${escHtml(showroomName)}</strong> showroom has been approved.</p>
        <p>Here are your login credentials:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888;width:120px">Email</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)"><strong>${escHtml(req2.email)}</strong></td></tr>
          <tr><td style="padding:8px;color:#888">Password</td><td style="padding:8px"><strong style="font-family:monospace;font-size:16px;letter-spacing:2px">${escHtml(tempPassword)}</strong></td></tr>
        </table>
        <p style="font-size:12px;color:#888">You can change your password after your first login.</p>
        ${emailBtn(loginUrl, 'ACCESS SHOWROOM →')}
      ` : `
        <p>Bonjour <strong>${escHtml(req2.name)}</strong>,</p>
        <p>Votre demande d'accès au showroom <strong>${escHtml(showroomName)}</strong> a été acceptée.</p>
        <p>Voici vos identifiants de connexion :</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1);color:#888;width:120px">Email</td><td style="padding:8px;border-bottom:1px solid rgba(17,17,17,.1)"><strong>${escHtml(req2.email)}</strong></td></tr>
          <tr><td style="padding:8px;color:#888">Mot de passe</td><td style="padding:8px"><strong style="font-family:monospace;font-size:16px;letter-spacing:2px">${escHtml(tempPassword)}</strong></td></tr>
        </table>
        <p style="font-size:12px;color:#888">Vous pourrez modifier votre mot de passe après votre première connexion.</p>
        ${emailBtn(loginUrl, 'ACCÉDER AU SHOWROOM →')}
      ` })
    });
    // Le SDK Resend résout avec {data:null,error} au lieu de rejeter — sans cette
    // vérification, un envoi échoué laissait le compte acheteur créé avec un mot
    // de passe temporaire que ni l'acheteur (pas d'email) ni l'admin (réponse sans
    // mot de passe) ne connaissaient. On le renvoie dans la réponse si l'email
    // n'est pas confirmé envoyé, pour transmission manuelle.
    if (sendErr) { console.error('[resend] access-request-approve:', sendErr.message || sendErr); return res.json({ ok: true, reused, emailed: false, temp_password: tempPassword }); }
  } else {
    // Pas de RESEND_API_KEY configurée : sans ce repli, le mot de passe temporaire
    // n'était communiqué nulle part (ni email, ni réponse) — le compte acheteur
    // était créé mais définitivement inaccessible.
    return res.json({ ok: true, reused, emailed: false, temp_password: tempPassword });
  }
  res.json({ ok: true, reused, emailed: true });
 } catch(e) { console.error('approve access request:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/access-requests/:id/reject', requireRole('owner','agent'), async (req, res) => {
  const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Demande introuvable' });
  const req2 = r.rows[0];
  if (req2.status !== 'pending') return res.status(400).json({ error: 'Demande déjà traitée' });
  await pool.query("UPDATE access_requests SET status='rejected' WHERE id=$1", [req.params.id]);
  logAudit(req, 'reject_access_request', 'access_request', req.params.id, req2.email);

  const [showroomName, fromAddress, showroomEmail] = await Promise.all([getSetting('showroom_name'), getSetting('smtp_from'), getSetting('showroom_email')]);
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const resend = newResendClient(resendKey);
    const from = fromAddress || 'showroom@editionsstandard.com';
    const { error: sendErr } = await resend.emails.send({
      from: `${showroomName} <${from}>`,
      to: [req2.email],
      ...(showroomEmail && showroomEmail.toLowerCase() !== req2.email.toLowerCase() ? { bcc: [showroomEmail] } : {}),
      subject: `Votre demande d'accès — ${showroomName}`,
      html: emailLayout({ showroomName, content: `
        <p>Bonjour <strong>${escHtml(req2.name)}</strong>,</p>
        <p>Nous avons bien reçu votre demande d'accès au showroom <strong>${escHtml(showroomName)}</strong>.</p>
        <p>Après examen, nous ne sommes pas en mesure de donner suite à votre demande pour le moment.</p>
        <p>N'hésitez pas à nous contacter directement pour plus d'informations.</p>
      ` })
    });
    if (sendErr) console.error('[resend] access-request-reject:', sendErr.message || sendErr);
  }
  res.json({ ok: true });
});

// ── Admin audit log ──────────────────────────────────────
app.get('/api/admin/audit-log', requireRole('owner'), async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const r = await pool.query('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ==================== CENTRE DE SÉCURITÉ (owner uniquement) ====================
// Boîte à outils incident : couper les accès en un geste sans passer par la base.

app.get('/api/admin/security/status', requireRole('owner'), async (req, res) => {
  try {
    const mode = await getSetting('maintenance_mode');
    const sessions = await pool.query("SELECT count(*) FILTER (WHERE sess->'buyerPortal' IS NOT NULL) AS buyers, count(*) FILTER (WHERE sess->'staffUser' IS NOT NULL OR sess->'admin' IS NOT NULL) AS staff FROM user_sessions WHERE expire > NOW()");
    const links = await pool.query("SELECT count(*) AS n FROM commande_links WHERE active != 0 AND expires_at > NOW()");
    res.json({
      maintenance_mode: mode === 'on',
      active_buyer_sessions: parseInt(sessions.rows[0]?.buyers) || 0,
      active_staff_sessions: parseInt(sessions.rows[0]?.staff) || 0,
      active_order_links: parseInt(links.rows[0]?.n) || 0
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/security/maintenance', requireRole('owner'), async (req, res) => {
  try {
    const on = !!req.body.on;
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', ['maintenance_mode', on ? 'on' : 'off']);
    invalidateMaintenanceCache();
    logAudit(req, on ? 'maintenance_on' : 'maintenance_off', 'system', '', '');
    res.json({ ok: true, maintenance_mode: on });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Déconnecte tous les acheteurs (ne touche pas la session de l'owner qui déclenche l'action).
app.post('/api/admin/security/revoke-all-buyer-sessions', requireRole('owner'), async (req, res) => {
  try {
    const r = await pool.query("DELETE FROM user_sessions WHERE sess->'buyerPortal' IS NOT NULL");
    logAudit(req, 'revoke_all_buyer_sessions', 'system', '', `${r.rowCount} session(s)`);
    res.json({ ok: true, revoked: r.rowCount });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Déconnecte tout le staff SAUF la session courante (sinon l'owner se déconnecte lui-même).
app.post('/api/admin/security/revoke-all-staff-sessions', requireRole('owner'), async (req, res) => {
  try {
    const r = await pool.query("DELETE FROM user_sessions WHERE (sess->'staffUser' IS NOT NULL OR sess->'admin' IS NOT NULL) AND sid != $1", [req.sessionID]);
    logAudit(req, 'revoke_all_staff_sessions', 'system', '', `${r.rowCount} session(s)`);
    res.json({ ok: true, revoked: r.rowCount });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Révoque tous les liens de commande /c/:token actifs (ex : suspicion de fuite).
app.post('/api/admin/security/revoke-all-order-links', requireRole('owner'), async (req, res) => {
  try {
    const r = await pool.query("UPDATE commande_links SET active=0 WHERE active != 0");
    logAudit(req, 'revoke_all_order_links', 'system', '', `${r.rowCount} lien(s)`);
    res.json({ ok: true, revoked: r.rowCount });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Révoque tous les PDF de commande publics accessibles (fenêtre 24h) — laisse
// intacte l'archive interne (staff), coupe uniquement l'accès sans authentification.
app.post('/api/admin/security/revoke-all-pdf-tokens', requireRole('owner'), async (req, res) => {
  try {
    const r = await pool.query("UPDATE orders SET pdf_revoked=true WHERE pdf_revoked=false AND created_at > NOW() - INTERVAL '24 hours'");
    logAudit(req, 'revoke_all_pdf_tokens', 'system', '', `${r.rowCount} commande(s)`);
    res.json({ ok: true, revoked: r.rowCount });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/invite/:token', publicLimiter, async (req, res) => {
  const r = await pool.query(`
    SELECT bil.*, b.name as brand_name, b.logo as brand_logo, b.invite_bg_url as brand_bg
    FROM brand_invite_links bil
    JOIN brands b ON b.id = bil.brand_id
    WHERE (bil.token=$1 OR bil.slug=$1) AND bil.active != 0
  `, [req.params.token]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Lien invalide ou désactivé.' });
  res.json({ brand_name: r.rows[0].brand_name, brand_logo: r.rows[0].brand_logo, brand_bg: r.rows[0].brand_bg || '' });
});

// emailLimiter (IP, 5/h) plutôt que buyerAuthLimiter : ce dernier est keyé par
// email quand fourni, donc inefficace ici — la création de compte spammée
// utilise justement un email différent à chaque appel.
app.post('/api/invite/:token', emailLimiter, async (req, res) => {
  const r = await pool.query(`
    SELECT bil.brand_id, b.name as brand_name
    FROM brand_invite_links bil
    JOIN brands b ON b.id = bil.brand_id
    WHERE (bil.token=$1 OR bil.slug=$1) AND bil.active != 0
  `, [req.params.token]);
  if (!r.rows[0]) return res.status(400).json({ error: 'Lien invalide ou désactivé.' });

  const { name, company, email, password } = req.body;
  if (!email || !password || password.length < 12) return res.status(400).json({ error: 'Email et mot de passe requis (12 caractères min).' });
  if (!name) return res.status(400).json({ error: 'Nom requis.' });

  const cleanEmail = email.toLowerCase().trim();
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO buyers (id, email, password_hash, name, company) VALUES ($1,$2,$3,$4,$5)',
      [id, cleanEmail, hash, name.trim(), (company||'').trim()]
    );
    // Régénération de session — anti session fixation (cohérent avec les autres logins)
    req.session.regenerate(() => {
      req.session.buyerPortal = { id, email: cleanEmail, name: name.trim(), company: (company||'').trim(), phone: '', country: '' };
      req.session.save(() => res.json({ ok: true }));
      sendBuyerWelcomeEmail({ email: cleanEmail, password, name: name.trim(), req }).catch(() => {});
    });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Cet email est déjà utilisé. Connectez-vous directement sur le portail.' });
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ==================== BUYER ACCESS (magic link) ====================

app.post('/api/buyer/request-link', buyerAuthLimiter, async (req, res) => {
  const { brand_id, email } = req.body;
  if (!brand_id || !email) return res.status(400).json({ error: 'Email requis' });

  const b = await pool.query('SELECT id, name FROM brands WHERE id=$1', [brand_id]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });

  const hasOrders = await pool.query('SELECT 1 FROM orders WHERE brand_id=$1 AND client_email=$2 LIMIT 1', [brand_id, email]);
  // Always respond success regardless, to avoid leaking which emails have ordered
  if (hasOrders.rows[0]) {
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      // Un compte du portail acheteur protégé par MFA existe pour cet email :
      // /api/buyer/verify refuse désormais ce lien magique (il contournerait
      // le MFA). Envoyer quand même un lien qui échouera serait trompeur — on
      // renvoie plutôt vers la connexion complète du portail dans ce cas.
      const acct = await pool.query('SELECT mfa_enabled FROM buyers WHERE email=$1', [email]);
      const mfaProtected = !!acct.rows[0]?.mfa_enabled;
      let url, content;
      if (mfaProtected) {
        url = `${getBaseUrl(req)}/editions-showroom-b2b-portail`;
        content = `<p>Bonjour,</p><p>Un compte sécurisé existe pour cet email. Connectez-vous via le portail acheteur pour accéder à l'historique de vos commandes pour <strong>${b.rows[0].name}</strong>.</p>${emailBtn(url, 'Me connecter →')}`;
      } else {
        const token = uuidv4();
        const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
        await pool.query('INSERT INTO buyer_magic_links (token, brand_id, email, expires_at) VALUES ($1,$2,$3,$4)', [token, brand_id, email, expires]);
        url = `${getBaseUrl(req)}/buyer/${brand_id}?token=${token}`;
        content = `<p>Bonjour,</p><p>Cliquez sur le lien ci-dessous pour accéder à l'historique de vos commandes pour <strong>${b.rows[0].name}</strong>.</p>${emailBtn(url, 'Accéder à mon espace →')}<p style="font-size:13px;color:#888;margin-top:24px">Ce lien est valable <strong>30 minutes</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>`;
      }

      const resend = newResendClient(resendKey);
      const fromAddress = await getSetting('smtp_from');
      const showroomName = await getSetting('showroom_name');
      const fromField = fromAddress || 'showroom@editionsstandard.com';
      const { error: sendErr } = await resend.emails.send({
        from: `${showroomName} <${fromField}>`,
        to: [email],
        subject: `Votre espace commandes — ${b.rows[0].name}`,
        html: emailLayout({ showroomName, brandName: b.rows[0].name, content })
      });
      if (sendErr) console.error('[resend] buyer-magic-link:', sendErr.message || sendErr);
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
  // Ce lien magique n'exige qu'un accès à la boîte mail — s'il correspond à un
  // compte du portail acheteur protégé par MFA, l'accepter reviendrait à
  // contourner ce MFA (accès en lecture à l'historique de commandes + PDF de
  // facture). On bloque plutôt cette voie légère et on renvoie vers le
  // portail complet, qui applique le MFA normalement.
  const acct = await pool.query('SELECT mfa_enabled FROM buyers WHERE email=$1', [link.email]);
  if (acct.rows[0]?.mfa_enabled) {
    return res.status(403).json({ error: 'Un compte sécurisé existe pour cet email. Veuillez vous connecter via <a href="/editions-showroom-b2b-portail">le portail acheteur</a>.' });
  }
  // Régénération de session — anti fixation, même principe que les autres points
  // de connexion (cette route héritée était la seule à en manquer).
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erreur serveur' });
    req.session.buyerEmail = link.email;
    req.session.buyerBrandId = brand_id;
    req.session.save(() => res.json({ ok: true, email: link.email }));
  });
});

app.get('/api/buyer/brand', async (req, res) => {
  if (!req.session.buyerBrandId) return res.status(401).json({ error: 'Non connecté' });
  const b = await pool.query('SELECT id, name, logo_url, logo, about_text, lookbook_url FROM brands WHERE id=$1', [req.session.buyerBrandId]);
  if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
  res.json(b.rows[0]);
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
    res.setHeader('Cache-Control', 'no-store, private');
    const oNumPublic = (await pool.query('SELECT order_number FROM orders WHERE id=$1', [req.params.id])).rows[0]?.order_number || req.params.id.slice(0,8).toUpperCase();
    res.setHeader('Content-Disposition', `attachment; filename="Commande-${oNumPublic}.pdf"`);
    res.send(pdf);
  } catch(e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get('/buyer/:brandId', (req, res) => sendPage(res, 'buyer.html'));
app.get('/rdv/:brandId', (req, res) => sendPage(res, 'rdv.html'));

// ==================== PDF ====================

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

async function generateOrderPDF(orderId) {
  const oRes = await pool.query(`
    SELECT o.*, b.name as brand_name, b.cgv_text as brand_cgv, b.logo as brand_logo, b.logo_url as brand_logo_url FROM orders o JOIN brands b ON o.brand_id=b.id WHERE o.id=$1
  `, [orderId]);
  const order = oRes.rows[0];
  if (!order) throw new Error('Commande introuvable');

  const lRes = await pool.query(`
    SELECT ol.*, p.reference, p.description as product_name, p.color, p.composition, p.image_url, p.images, ol.note
    FROM order_lines ol JOIN products p ON ol.product_id=p.id
    WHERE ol.order_id=$1
  `, [orderId]);
  const lines = lRes.rows;

  // Pré-chargement des vignettes produit (PNG borné → compatible PDFKit) pour le
  // récapitulatif visuel. Dédupliqué par produit. Échec d'une image = simplement omise.
  const lineImages = {};
  await Promise.all([...new Set(lines.map(l => l.product_id))].map(async (pid) => {
    const l = lines.find(x => x.product_id === pid);
    let img = l.image_url;
    if (!img && l.images) { try { const arr = JSON.parse(l.images); img = Array.isArray(arr) ? arr[0] : null; } catch(e) {} }
    if (img && typeof img === 'object') img = img.url || img.src || img.secure_url || null;
    if (!img || typeof img !== 'string') return;
    try {
      if (img.startsWith('data:image')) {
        lineImages[pid] = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      } else if (/^https?:\/\//i.test(img)) {
        const buf = await fetchCloudinaryImage(img, 'w_300,h_300,c_limit,f_png', 10000);
        if (buf) lineImages[pid] = buf;
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

    // Regroupe les lignes par produit (référence+couleur partagent le même
    // product_id, une taille = une ligne order_lines) pour afficher toutes les
    // tailles commandées et leur quantité sur une seule ligne PDF, au lieu
    // d'une ligne par taille comme auparavant.
    const grouped = [];
    const byProduct = new Map();
    lines.forEach(l => {
      let g = byProduct.get(l.product_id);
      if (!g) {
        g = { reference: l.reference, product_name: l.product_name, color: l.color, composition: l.composition, unit_price: l.unit_price, price_retail: l.price_retail, sizes: [], lineTotal: 0, notes: [] };
        byProduct.set(l.product_id, g);
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
    const visualProductIds = [];
    const visualProducts = {};
    lines.forEach(l => {
      if (!lineImages[l.product_id]) return;
      if (!visualProducts[l.product_id]) {
        visualProducts[l.product_id] = { reference: l.reference, color: l.color, composition: l.composition, sizes: [], totalQty: 0 };
        visualProductIds.push(l.product_id);
      }
      visualProducts[l.product_id].sizes.push({ size: l.size || '—', qty: l.quantity });
      visualProducts[l.product_id].totalQty += l.quantity;
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

// ==================== EMAIL ====================

const LOGO_URL = 'https://showroom.editionsstandard.com/logo.svg';

// Gabarit email aligné sur l'atmosphère des portails (page /demande-acces) :
// fond sombre #0a0a0a, monospace, kickers/labels majuscules à fort interlettrage,
// hairlines, accent lime, logo BLANC centré (logo-email.png — le SVG noir + filtre
// CSS du site ne s'affiche pas en email). Table-based + styles inline (email-safe).
// Gabarit email aligné sur l'atmosphère des portails (/demande-acces) :
// monospace, kickers majuscules interlettrés, hairlines, logo centré.
// THÈME : SOMBRE par défaut (marche partout, y compris Gmail qui ignore les
// media queries) + variante CLAIRE automatique via @media (prefers-color-scheme:
// light) pour les clients qui la supportent (Apple Mail, iOS…), avec bascule du
// logo blanc↔noir. Défauts inline = sombre ; overrides !important = clair.
// Logos servis en <img src="https://…"> hébergé (et non en pièce jointe cid:) —
// Gmail webmail (le client largement majoritaire chez nos acheteurs/marques) ne
// résout jamais les URI cid:, il réécrit les src d'image via son propre proxy ;
// un logo cid: y reste donc invisible en permanence, contrairement à une image
// distante classique (constaté en pratique — cf. rapport "logo absent des emails").
const EMAIL_LOGO_URL = () => `${getBaseUrl()}/logo-email.png`;   // blanc (sombre)
const EMAIL_LOGO_BLACK = () => `${getBaseUrl()}/logo-pdf.png`;   // noir (clair)
const EMAIL_MONO = "'Courier New', Courier, monospace";
const EMAIL_ACCENT = '#CCEB3C';

// Icônes réseaux sociaux du footer — mêmes tracés que brandSocialIcon() du
// portail (public/portal.html), rendus en PNG statique (voir scripts de
// génération) car un <svg> inline n'est pas fiable dans les clients mail
// (notamment Outlook desktop). Deux variantes de couleur, comme le logo.
const EMAIL_SOCIAL_ICON = (name, mode) => `${getBaseUrl()}/email-icon-${name}-${mode}.png`; // mode: 'black'|'white'

// Liens du showroom (site + réseaux + email de contact public) affichés dans
// le footer de TOUS les emails — mis en cache en mémoire pour qu'emailLayout()
// reste une fonction synchrone (~20 points d'appel dans ce fichier, tous
// n'attendent pas de Promise sur son retour). Rafraîchi au démarrage, toutes
// les 5 minutes, et immédiatement après une sauvegarde de Paramètres qui les
// concerne — un email envoyé avant le premier rafraîchissement affiche
// simplement le footer sans cette ligne (dégradation silencieuse, jamais une
// erreur), auto-corrigé au rafraîchissement suivant.
let _showroomLinksCache = {};
async function refreshShowroomLinksCache() {
  try {
    const [website, instagram, facebook, tiktok, linkedin, contactEmail] = await Promise.all([
      getSetting('showroom_website'), getSetting('showroom_instagram'), getSetting('showroom_facebook'),
      getSetting('showroom_tiktok'), getSetting('showroom_linkedin'), getSetting('showroom_contact_email')
    ]);
    _showroomLinksCache = { website, instagram, facebook, tiktok, linkedin, contactEmail };
  } catch(e) { console.error('refreshShowroomLinksCache:', e.message); }
  return _showroomLinksCache;
}

// Conservé pour compatibilité de signature aux ~20 points d'envoi d'email du
// fichier (`const resend = newResendClient(resendKey)`) — plus de logo à
// attacher désormais (voir EMAIL_LOGO_URL ci-dessus), donc simple passthrough.
function newResendClient(apiKey) {
  return new Resend(apiKey);
}
// Petit carré plein — marqueur de section signature du portail
// (h2.section-title::before, badges, puces non lues), jamais en ::before
// (non fiable en email) : un <span> inline-block direct dans le HTML.
function dot(size, color) {
  return `<span style="display:inline-block;width:${size}px;height:${size}px;background:${color || EMAIL_ACCENT};margin-right:10px;vertical-align:1px;line-height:0">&nbsp;</span>`;
}

// Ligne d'icônes footer (site + réseaux du showroom) — n'affiche que les
// liens réellement configurés (Admin > Paramètres > Showroom). Aucune
// couleur de marque tierce (rose Instagram, bleu Facebook…) : icônes
// monochromes, cohérentes avec le système accent + encre du showroom.
function emailSocialRow(links) {
  if (!links) return '';
  const chip = (href, name, label) => `
    <td style="padding:0 8px">
      <a href="${escHtml(href)}" style="display:inline-block;text-decoration:none" title="${escHtml(label)}">
        <img class="lg-l" src="${EMAIL_SOCIAL_ICON(name, 'black')}" width="18" height="18" alt="${escHtml(label)}" style="display:inline-block">
        <img class="lg-d" src="${EMAIL_SOCIAL_ICON(name, 'white')}" width="18" height="18" alt="${escHtml(label)}" style="display:none">
      </a>
    </td>`;
  const cells = [];
  if (links.website) cells.push(`<td style="padding:0 8px"><a href="${escHtml(links.website)}" class="em-ink" style="display:inline-block;text-decoration:none;font-family:${EMAIL_MONO};font-size:16px">🌐</a></td>`);
  if (links.instagram) cells.push(chip(links.instagram, 'instagram', 'Instagram'));
  if (links.facebook) cells.push(chip(links.facebook, 'facebook', 'Facebook'));
  if (links.tiktok) cells.push(chip(links.tiktok, 'tiktok', 'TikTok'));
  if (links.linkedin) cells.push(chip(links.linkedin, 'linkedin', 'LinkedIn'));
  if (!cells.length) return '';
  return `<table cellpadding="0" cellspacing="0" style="margin:14px auto 0"><tr>${cells.join('')}</tr></table>`;
}

function emailLayout({ showroomName, brandName = '', brandLogo = '', eyebrow = '', content, footer = '' }) {
  const links = _showroomLinksCache;
  const brandBlock = brandName ? `
  <tr><td style="padding:2px 0 22px;text-align:center">
    <div class="em-ink" style="font-family:${EMAIL_MONO};font-size:11px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:#111111">${escHtml(brandName.toUpperCase())}</div>
    <div class="em-muted" style="font-family:${EMAIL_MONO};font-size:8px;letter-spacing:.24em;text-transform:uppercase;color:rgba(17,17,17,.4);margin-top:8px">${dot(6)}Collection</div>
  </td></tr>` : '';
  const eyebrowBlock = eyebrow ? `
  <tr><td style="padding-bottom:16px">
    <div class="em-muted" style="font-family:${EMAIL_MONO};font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:rgba(17,17,17,.55)">${dot(7)}${escHtml(eyebrow)}</div>
  </td></tr>` : '';

  const style = `
  <style>
    /* Filet de sécurité typographique : le style inline du <td class="em-body">
       ne se propage pas de façon fiable aux <table>/<td> qu'un contenu d'email
       imbrique (comportement connu de nombreux moteurs de rendu mail) — sans
       cette règle, un tableau de détails de commande construit sans font-family
       explicite retombe sur la police système (sans-serif) au lieu du monospace
       du reste du gabarit. */
    .em-body, .em-body table, .em-body td, .em-body th, .em-body p, .em-body div,
    .em-body span, .em-body strong, .em-body b, .em-body a, .em-body li {
      font-family: 'Courier New', Courier, monospace !important;
    }
    @media (prefers-color-scheme: dark) {
      .em-wash { background:#0a0a0a !important; }
      .em-card { background:#111111 !important; border-color:rgba(255,255,255,.14) !important; }
      .em-ink { color:#f5f4f0 !important; }
      .em-muted { color:rgba(255,255,255,.5) !important; }
      .em-line { border-color:rgba(255,255,255,.14) !important; }
      .em-box { border-color:rgba(255,255,255,.16) !important; }
      .lg-l { display:none !important; }
      .lg-d { display:inline-block !important; }
      .em-body p, .em-body td, .em-body h2, .em-body strong, .em-body div, .em-body li { color:#e6e6e6 !important; }
      .em-body span[style*="rgba(17,17,17"] { color:rgba(255,255,255,.55) !important; }
      .em-body a { color:${EMAIL_ACCENT} !important; }
      .em-body td[style*="border-bottom"], .em-body td[style*="border-top"] { border-color:rgba(255,255,255,.12) !important; }
      .em-body [style*="rgba(224,176,58"] { color:#e6c15a !important; }
      .em-btn-primary a, .em-btn-primary td { color:#111111 !important; }
    }
  </style>`;

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">${style}</head>
<body class="em-wash" style="margin:0;padding:0;background:#f5f4f0">
<table class="em-wash" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f0;padding:44px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px">

  <!-- Carte flottante — panneau distinct du fond, comme .card du portail -->
  <tr><td class="em-card" style="background:#ffffff;border:1px solid rgba(17,17,17,.12)">
  <table width="100%" cellpadding="0" cellspacing="0">

    <!-- Filet d'accent en tête de carte : signature de marque, jamais absente -->
    <tr><td style="height:3px;line-height:3px;font-size:0;background:${EMAIL_ACCENT}">&nbsp;</td></tr>

    <tr><td style="padding:40px 40px 0">
    <table width="100%" cellpadding="0" cellspacing="0">

      <!-- HEADER : logo (noir en clair / blanc en sombre) + nom showroom + kicker -->
      <tr><td style="text-align:center;padding-bottom:28px">
        <img class="lg-l" src="${EMAIL_LOGO_BLACK()}" alt="${escHtml(showroomName)}" width="72" height="72" style="display:inline-block">
        <img class="lg-d" src="${EMAIL_LOGO_URL()}" alt="${escHtml(showroomName)}" width="72" height="72" style="display:none">
        <div class="em-ink" style="font-family:${EMAIL_MONO};font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#111111;margin-top:16px">${escHtml(showroomName)}</div>
        <div class="em-muted" style="font-family:${EMAIL_MONO};font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:rgba(17,17,17,.4);margin-top:8px">B2B Showroom</div>
      </td></tr>
      <tr><td class="em-line" style="border-top:1px solid rgba(17,17,17,.12);font-size:0;line-height:0">&nbsp;</td></tr>
      ${brandBlock ? `<tr><td style="height:24px;font-size:0;line-height:0">&nbsp;</td></tr>${brandBlock}` : `<tr><td style="height:28px;font-size:0;line-height:0">&nbsp;</td></tr>`}

      ${eyebrowBlock}

      <!-- BODY -->
      <tr><td class="em-body em-ink" style="font-family:${EMAIL_MONO};font-size:14px;color:#1a1a1a;line-height:1.75;padding-bottom:36px">
        ${content}
      </td></tr>

    </table>
    </td></tr>

    <!-- FOOTER — dans la carte, séparé par un filet -->
    <tr><td class="em-line" style="border-top:1px solid rgba(17,17,17,.1);padding:20px 40px 22px;text-align:center">
      <img class="lg-l" src="${EMAIL_LOGO_BLACK()}" alt="${escHtml(showroomName)}" width="68" height="68" style="display:inline-block;margin-bottom:12px">
      <img class="lg-d" src="${EMAIL_LOGO_URL()}" alt="${escHtml(showroomName)}" width="68" height="68" style="display:none;margin-bottom:12px">
      <div class="em-muted" style="font-family:${EMAIL_MONO};font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:rgba(17,17,17,.4)">
        ${footer || `${escHtml(showroomName)} — Showroom`}
      </div>
      ${emailSocialRow(links)}
      ${links.contactEmail ? `<div style="margin-top:14px"><a href="mailto:${escHtml(links.contactEmail)}" class="em-muted" style="font-family:${EMAIL_MONO};font-size:8px;letter-spacing:.04em;color:rgba(17,17,17,.4);text-decoration:underline">${escHtml(links.contactEmail)}</a></div>` : ''}
    </td></tr>

  </table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// Bouton principal plein accent — comme .btn-compare-go / #modal-share-copy-btn
// du portail : un seul par email, l'action qu'on veut voir cliquée.
function emailBtn(url, label) {
  return `<table cellpadding="0" cellspacing="0" style="margin:30px auto" class="em-btn-primary">
    <tr><td style="background:${EMAIL_ACCENT};padding:15px 32px;text-align:center">
      <a href="${url}" style="color:#111111;font-family:${EMAIL_MONO};font-size:11px;font-weight:700;text-decoration:none;letter-spacing:.28em;text-transform:uppercase">${label}</a>
    </td></tr>
  </table>`;
}

// Bouton secondaire filaire (ex-emailBtn) : pour une action de moindre
// priorité, quand un email a déjà son bouton principal plein accent.
function emailBtnGhost(url, label) {
  return `<table cellpadding="0" cellspacing="0" style="margin:16px auto">
    <tr><td class="em-btn" style="border:1px solid rgba(17,17,17,.35);padding:13px 28px;text-align:center">
      <a href="${url}" class="em-ink" style="color:#111111;font-family:${EMAIL_MONO};font-size:10.5px;font-weight:400;text-decoration:none;letter-spacing:.24em;text-transform:uppercase">${label}</a>
    </td></tr>
  </table>`;
}

// ── Modèles d'email éditables (owner, onglet "Modèles email") ──────────
// Texte par défaut du corps + sujet de chaque email sortant. Une ligne en
// base (table email_templates) surcharge le texte pour une (modèle, langue)
// donnée sans jamais toucher au code — absence de ligne = texte par défaut
// ci-dessous. La mise en page (logo, mode sombre, typographie) reste gérée
// par emailLayout()/emailBtn() : l'admin édite uniquement le texte, jamais
// du HTML brut, pour ne jamais casser le rendu sur un client mail.
const EMAIL_TEMPLATE_DEFAULTS = {
  prospect_invite: {
    fr: {
      subject: '{{showroom}} — Découvrez {{marque_txt}}',
      body: `<p>Vous êtes invité(e) à découvrir {{marque}} sur {{showroom}}, notre showroom B2B digital.</p>
<p style="color:#666;font-size:13px">Collections sélectionnées · conditions négociées · commande en ligne, à votre rythme.</p>
{{bouton}}
<p style="color:#888;font-size:12px">À très bientôt,<br>{{showroom}}</p>`
    },
    en: {
      subject: '{{showroom}} — Discover {{marque_txt}}',
      body: `<p>You're invited to discover {{marque}} on {{showroom}}, our digital B2B showroom.</p>
<p style="color:#666;font-size:13px">Curated collections · negotiated terms · order online, at your own pace.</p>
{{bouton}}
<p style="color:#888;font-size:12px">See you soon,<br>{{showroom}}</p>`
    }
  },
  relance: {
    fr: {
      subject: 'Votre accès showroom — {{showroom}}',
      body: `<p>Bonjour <strong>{{acheteur}}</strong>,</p>
<p>Vos sélections showroom vous attendent. N'hésitez pas à parcourir les collections et passer commande.</p>
{{bouton}}
<p style="margin-top:28px">Cordialement,<br><strong>{{agent}}</strong></p>`
    },
    en: {
      subject: 'Your showroom access — {{showroom}}',
      body: `<p>Hello <strong>{{acheteur}}</strong>,</p>
<p>Your showroom selections are waiting for you. Don't hesitate to browse the collections and place your order.</p>
{{bouton}}
<p style="margin-top:28px">Best regards,<br><strong>{{agent}}</strong></p>`
    }
  },
  access_link: {
    fr: {
      subject: 'Votre accès showroom — {{showroom}}',
      body: `<p>Bonjour <strong>{{acheteur}}</strong>,</p>
<p>Cliquez ci-dessous pour accéder au showroom, sans mot de passe.</p>
{{bouton}}
<p style="font-size:12px;color:#888;margin-top:20px">Ce lien est valable 24 heures.</p>`
    },
    en: {
      subject: 'Your showroom access — {{showroom}}',
      body: `<p>Hello <strong>{{acheteur}}</strong>,</p>
<p>Click below to access the showroom — no password needed.</p>
{{bouton}}
<p style="font-size:12px;color:#888;margin-top:20px">This link expires in 24 hours.</p>`
    }
  }
};
// Variables disponibles par modèle, documentées côté UI.
const EMAIL_TEMPLATE_VARS = {
  prospect_invite: [
    ['{{marque}}', 'Marque ciblée ("la collection Nom") ou formule générique si aucune marque précise'],
    ['{{marque_txt}}', 'Comme {{marque}} mais en texte brut (sujet uniquement)'],
    ['{{showroom}}', 'Nom du showroom (Paramètres)'],
    ['{{bouton}}', "Bouton d'action — à conserver, sinon le prospect n'a aucun lien cliquable"],
  ],
  relance: [
    ['{{acheteur}}', "Nom de l'acheteur"],
    ['{{agent}}', "Nom de l'agent (Paramètres) ou du showroom à défaut"],
    ['{{showroom}}', 'Nom du showroom'],
    ['{{bouton}}', "Bouton d'action vers le portail"],
  ],
  access_link: [
    ['{{acheteur}}', "Nom de l'acheteur"],
    ['{{showroom}}', 'Nom du showroom'],
    ['{{bouton}}', "Bouton d'accès direct — lien valable 24h"],
  ]
};
function applyTemplateVars(str, vars) {
  return (str || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}
async function getEmailTemplate(key, lang) {
  const def = EMAIL_TEMPLATE_DEFAULTS[key][lang];
  const row = (await pool.query('SELECT subject, body FROM email_templates WHERE template_key=$1 AND lang=$2', [key, lang])).rows[0];
  return {
    subject: (row && row.subject) ? row.subject : def.subject,
    body: (row && row.body) ? row.body : def.body,
  };
}

// Encadré d'infos : hairline, labels majuscules muets, valeurs foncées (défaut clair).
function emailInfoBox(rows) {
  return `<table class="em-box" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid rgba(17,17,17,.12);border-left:3px solid ${EMAIL_ACCENT};margin:22px 0">
    <tr><td style="padding:18px 22px">
      ${rows.map(([label, value, raw]) => `
        <p style="margin:0 0 11px;font-size:13px;font-family:${EMAIL_MONO}"><span class="em-muted" style="color:rgba(17,17,17,.5);display:inline-block;min-width:120px;font-size:10px;letter-spacing:.12em;text-transform:uppercase">${escHtml(label)}</span><strong class="em-ink" style="color:#111111">${raw ? String(value||'') : escHtml(String(value||''))}</strong></p>
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
      SUM(ol.quantity * ol.unit_price) as order_total,
      by2.lang as buyer_lang
    FROM orders o
    JOIN brands b ON o.brand_id=b.id
    LEFT JOIN order_lines ol ON ol.order_id=o.id
    LEFT JOIN buyers by2 ON by2.id=o.buyer_id
    WHERE o.id=$1
    GROUP BY o.id, b.name, b.cgv_text, b.logo, by2.lang
  `, [orderId]);
  const order = oRes.rows[0];
  const isEn = order?.buyer_lang === 'en';
  const filename = `PropositionCommande-${order.brand_name.replace(/\s/g,'-')}-${order.order_number || orderId.slice(0,8).toUpperCase()}.pdf`;
  const totalStr = Number(order.order_total||0).toFixed(2).replace('.',',') + ' €';
  const dateStr = new Date(order.created_at).toLocaleDateString(isEn ? 'en-GB' : 'fr-FR', { day:'2-digit', month:'long', year:'numeric' });
  const cgvText = order.brand_cgv || globalCgv;

  const resend = newResendClient(resendKey);
  const fromField = fromAddress || 'showroom@editionsstandard.com';
  const fromFormatted = `${showroomName} <${fromField}>`;
  const attachment = { filename, content: pdfBuffer.toString('base64'), contentType: 'application/pdf' };

  // Vignettes produit pour le corps de l'email (jusqu'à 4, images distantes) —
  // grille 2 colonnes cadrée (ratio 3:4, comme les cartes du catalogue
  // portail) plutôt que 4 minuscules images en bande : nettement plus
  // vendeur, cohérent avec le reste du gabarit (marqueur de section carré,
  // cadre em-box).
  let thumbsHtml = '';
  try {
    const lImgs = await pool.query(
      `SELECT DISTINCT ON (p.id) p.reference, p.color, p.image_url, p.images
       FROM order_lines ol JOIN products p ON p.id = ol.product_id
       WHERE ol.order_id = $1`, [orderId]);
    const pickImg = (row) => {
      let img = row.image_url;
      if (!img && row.images) { try { const a = JSON.parse(row.images); img = Array.isArray(a) ? a[0] : null; } catch(e) {} }
      if (img && typeof img === 'object') img = img.url || img.src || img.secure_url || null;
      if (typeof img !== 'string' || !/^https?:\/\//i.test(img)) return null;
      return img.includes('res.cloudinary.com') ? img.replace('/upload/', '/upload/w_400,h_533,c_fill,f_auto,q_auto/') : img;
    };
    const thumbs = lImgs.rows.map(r => ({ ref: r.reference, color: r.color, src: pickImg(r) })).filter(t => t.src).slice(0, 4);
    if (thumbs.length) {
      const card = (t) => `
        <td style="width:50%;padding:0 8px 12px 0;vertical-align:top">
          <table cellpadding="0" cellspacing="0" class="em-box" style="width:100%;border:1px solid rgba(17,17,17,.12)">
            <tr><td><img src="${escHtml(t.src)}" alt="${escHtml(t.ref || '')}" width="100%" style="width:100%;height:auto;display:block"></td></tr>
            <tr><td style="padding:10px 12px">
              <div class="em-ink" style="font-family:'Courier New',Courier,monospace;font-size:11.5px;font-weight:700;color:#111111">${escHtml(t.ref || '')}</div>
              ${t.color ? `<div class="em-muted" style="font-family:'Courier New',Courier,monospace;font-size:10px;letter-spacing:.06em;color:rgba(17,17,17,.5);margin-top:3px">${escHtml(t.color)}</div>` : ''}
            </td></tr>
          </table>
        </td>`;
      const rows = [];
      for (let i = 0; i < thumbs.length; i += 2) rows.push(thumbs.slice(i, i + 2));
      thumbsHtml = `
        <table cellpadding="0" cellspacing="0" style="width:100%;margin:6px 0 8px">
          <tr><td class="em-muted" style="font-family:'Courier New',Courier,monospace;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:rgba(17,17,17,.5);padding-bottom:12px">${dot(6)}${isEn ? 'Items ordered' : 'Articles commandés'}</td></tr>
        </table>
        <table cellpadding="0" cellspacing="0" style="width:100%">
          ${rows.map(r => `<tr>${r.map(card).join('')}${r.length === 1 ? '<td style="width:50%"></td>' : ''}</tr>`).join('')}
        </table>`;
    }
  } catch(e) { console.error('[order-email-thumbs]', e.message); }

  // ── Email acheteur ──
  const buyerSend = await resend.emails.send({
    from: fromFormatted,
    to: [order.client_email],
    ...(showroomEmail ? { replyTo: showroomEmail } : {}), // réponses de l'acheteur → showroom
    subject: isEn
      ? `Order proposal — ${order.brand_name} — ${showroomName}`
      : `Proposition de commande — ${order.brand_name} — ${showroomName}`,
    html: emailLayout({
      showroomName,
      brandName: order.brand_name,
      brandLogo: order.brand_logo || '',
      eyebrow: isEn ? 'Order proposal' : 'Proposition de commande',
      content: isEn ? `
        <p>Hello <strong>${escHtml(order.client_name)}</strong>,</p>
        <p>We have received your order proposal for <strong>${order.brand_name}</strong> dated ${dateStr}.</p>
        <p>Your signed order proposal (total ex-VAT: <strong>${totalStr}</strong>) is attached to this email as a PDF.</p>
        ${thumbsHtml}

        <table cellpadding="0" cellspacing="0" style="width:100%;background:rgba(224,176,58,.1);border-left:3px solid #d4a017;border-radius:0 4px 4px 0;margin:24px 0">
          <tr><td style="padding:16px 20px">
            <p style="margin:0 0 8px;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;color:#8a6500;letter-spacing:1px;text-transform:uppercase">Important — Non-binding proposal</p>
            <p style="margin:0;font-size:13px;color:#555;line-height:1.7">
              This proposal is <strong>not a firm commitment</strong>. It will be final after:<br>
              &bull; Formal acceptance by <strong>${order.brand_name}</strong><br>
              &bull; Signature of the purchase order by both parties<br><br>
              Please allow <strong>7 business days</strong> for the final signed version.
            </p>
          </td></tr>
        </table>

        <p style="color:#555;font-size:13px">We will get back to you once confirmed. Feel free to contact us if you have any questions.</p>
        <p style="margin-top:28px">Best regards,<br><strong>${agentName || showroomName}</strong></p>

        ${cgvText ? `
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(17,17,17,.1)">
          <p style="margin:0 0 8px;font-family:'Courier New',Courier,monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#bbb">Terms & Conditions — ${order.brand_name}</p>
          <p style="margin:0;font-size:11px;color:#aaa;line-height:1.7;white-space:pre-wrap">${cgvText}</p>
        </div>` : ''}
      ` : `
        <p>Bonjour <strong>${escHtml(order.client_name)}</strong>,</p>
        <p>Nous avons bien reçu votre proposition de commande pour la marque <strong>${order.brand_name}</strong> en date du ${dateStr}.</p>
        <p>Votre proposition de commande signée (total HT : <strong>${totalStr}</strong>) est jointe à cet email en PDF.</p>
        ${thumbsHtml}

        <table cellpadding="0" cellspacing="0" style="width:100%;background:rgba(224,176,58,.1);border-left:3px solid #d4a017;border-radius:0 4px 4px 0;margin:24px 0">
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
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(17,17,17,.1)">
          <p style="margin:0 0 8px;font-family:'Courier New',Courier,monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#bbb">Conditions générales — ${order.brand_name}</p>
          <p style="margin:0;font-size:11px;color:#aaa;line-height:1.7;white-space:pre-wrap">${cgvText}</p>
        </div>` : ''}
      `
    }),
    attachments: [attachment]
  });
  if (buyerSend.error) console.error('[resend] order-proposal-buyer:', buyerSend.error.message || buyerSend.error);

  // ── Copie showroom ──
  const copyTo = showroomEmail || fromField;
  const { error: ownerCopyErr } = await resend.emails.send({
    from: fromFormatted,
    to: [copyTo],
    subject: `[BDC] ${order.client_name} — ${order.brand_name} — ${totalStr}`,
    html: emailLayout({
      showroomName,
      brandName: order.brand_name,
      brandLogo: order.brand_logo || '',
      eyebrow: 'Nouvelle proposition de commande',
      content: `
        ${emailInfoBox([
          ['Client', order.client_name],
          ...(order.client_company ? [['Société', order.client_company]] : []),
          ['Email', `<a href="mailto:${escHtml(order.client_email)}" style="color:#111111">${escHtml(order.client_email)}</a>`, true],
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
  if (ownerCopyErr) console.error('[resend] order-proposal-owner-copy:', ownerCopyErr.message || ownerCopyErr);
}

// ==================== AIRTABLE SYNC ====================


// Un email attaquant contenant un guillemet double casserait le littéral de la
// formule Airtable (injection dans filterByFormula) — échappé ici avant interpolation.
function airtableFormulaEscape(s) {
  return String(s || '').replace(/"/g, '\\"');
}

async function syncAirtable(clientEmail, clientCompany, clientName, orderTotal) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) return;

  const base = 'appquOEohNkpH6sbB';
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const today = new Date().toISOString().split('T')[0];

  // Search STORES by email
  let storeRecordId = null;
  try {
    const searchUrl = `https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm?filterByFormula=LOWER({fldbGIrhVTpvBBnZk})="${airtableFormulaEscape(clientEmail.toLowerCase())}"&maxRecords=1`;
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

// Touche la fiche STORE Airtable (Last Contact = aujourd'hui) sans rien écraser
// d'autre — réutilise les champs connus. Sert à refléter l'activité showroom
// (ex. prise de RDV) dans le CRM Airtable de l'agence.
async function airtableTouchStore(clientEmail) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey || !clientEmail) return;
  const base = 'appquOEohNkpH6sbB';
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  try {
    const searchUrl = `https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm?filterByFormula=LOWER({fldbGIrhVTpvBBnZk})="${airtableFormulaEscape(clientEmail.toLowerCase())}"&maxRecords=1`;
    const sr = await fetch(searchUrl, { headers });
    const sd = await sr.json();
    const rec = sd.records && sd.records[0];
    if (!rec) return;
    await fetch(`https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm/${rec.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ fields: { 'fldoXxM2cxB8pRWSj': new Date().toISOString().split('T')[0] } })
    });
  } catch(e) { console.error('Airtable touch error:', e.message); }
}

// Crée une fiche STORE « Prospect » dans Airtable (sur demande d'accès). Si la fiche
// existe déjà, on ne rétrograde PAS (un client reste client) : on touche Last Contact.
async function airtableUpsertProspect({ email, name, company }) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey || !email) return;
  const base = 'appquOEohNkpH6sbB';
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const today = new Date().toISOString().split('T')[0];
  try {
    const searchUrl = `https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm?filterByFormula=LOWER({fldbGIrhVTpvBBnZk})="${airtableFormulaEscape(email.toLowerCase())}"&maxRecords=1`;
    const sr = await fetch(searchUrl, { headers });
    const sd = await sr.json();
    if (sd.records && sd.records[0]) {
      // Déjà présent → ne pas écraser le statut, juste dater le contact
      await fetch(`https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm/${sd.records[0].id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ fields: { 'fldoXxM2cxB8pRWSj': today } })
      });
      return;
    }
    await fetch(`https://api.airtable.com/v0/${base}/tblQCsZU8DeokGygm`, {
      method: 'POST', headers,
      body: JSON.stringify({ typecast: true, fields: {
        'fldbGIrhVTpvBBnZk': email,          // Email
        'fldiiGOlzIQNvdGTh': company || '',   // Store name
        'fldbnSDcnI2mb9qjj': name || '',      // Name Buyers
        'fldNdh83yBoZONLhP': 'Prospect',      // Statut
        'fldoXxM2cxB8pRWSj': today            // Last Contact
      } })
    });
  } catch(e) { console.error('Airtable prospect upsert:', e.message); }
}

// ==================== SEASONS ====================

app.post('/api/brands/:brandId/seasons/:seasonId/archive', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const { brandId, seasonId } = req.params;
    await pool.query('UPDATE seasons SET active=0 WHERE id=$1 AND brand_id=$2', [seasonId, brandId]);
    const r = await pool.query('UPDATE products SET active=0 WHERE season_id=$1 AND brand_id=$2', [seasonId, brandId]);
    res.json({ ok: true, products_affected: r.rowCount });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/brands/:brandId/seasons/:seasonId/restore', requireBrandScope('owner','agent'), async (req, res) => {
  try {
    const { brandId, seasonId } = req.params;
    await pool.query('UPDATE seasons SET active=1 WHERE id=$1 AND brand_id=$2', [seasonId, brandId]);
    const r = await pool.query('UPDATE products SET active=1 WHERE season_id=$1 AND brand_id=$2', [seasonId, brandId]);
    res.json({ ok: true, products_affected: r.rowCount });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/reset-password', (req, res) => sendPage(res, 'reset-password.html'));

// ==================== BROUILLONS DE SÉLECTION ====================

app.post('/api/selections/draft', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const { brand_id, client_name, client_email, client_company, items_json, notes, draft_name } = req.body;
    if (!brand_id || !client_email) return res.status(400).json({ error: 'brand_id et client_email requis' });
    if (isBrandScoped(req) && brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    // Ne garder que des product_id appartenant réellement à cette marque — même
    // garde que /api/brands/:brandId/agent-selection, sinon un brouillon peut
    // injecter le catalogue/prix d'une autre marque dans un lien envoyé à un
    // acheteur via /api/selections/drafts/:token/send puis GET /api/selection/:token.
    let items = [];
    try { items = JSON.parse(items_json || '[]'); } catch(e) {}
    if (!Array.isArray(items)) items = [];
    const candidateIds = [...new Set(items.map(i => i && i.product_id).filter(Boolean))];
    const ownProductIds = candidateIds.length
      ? new Set((await pool.query('SELECT id FROM products WHERE id = ANY($1) AND brand_id = $2', [candidateIds, brand_id])).rows.map(r => r.id))
      : new Set();
    const cleanItemsJson = JSON.stringify(items.filter(i => i && ownProductIds.has(i.product_id)));
    const token = uuidv4();
    const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000); // 90 jours
    await pool.query(
      `INSERT INTO agent_selections (token, brand_id, client_name, client_email, client_company, items_json, notes, created_by, expires_at, status, draft_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`,
      [token, brand_id, client_name||'', client_email.toLowerCase().trim(), client_company||'', cleanItemsJson, notes||'', req.session?.staffUser?.email || 'owner', expires, draft_name||'']
    );
    res.json({ token });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/selections/drafts', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const brandFilter = req.userBrandId ? 'AND a.brand_id = $1' : '';
    const params = req.userBrandId ? [req.userBrandId] : [];
    const r = await pool.query(`
      SELECT a.token, a.draft_name, a.brand_id, a.client_name, a.client_email, a.client_company,
             a.notes, a.created_by, a.created_at, a.expires_at, a.items_json,
             b.name as brand_name
      FROM agent_selections a
      JOIN brands b ON a.brand_id = b.id
      WHERE a.status = 'draft' ${brandFilter}
      ORDER BY a.created_at DESC
    `, params);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/selections/drafts/:token', requireRole('owner', 'agent'), async (req, res) => {
  try {
    // Récupère la sélection avant suppression pour la copie email au propriétaire
    const sel = (await pool.query("SELECT a.*, b.name AS brand_name FROM agent_selections a JOIN brands b ON b.id=a.brand_id WHERE a.token=$1 AND a.status='draft'", [req.params.token])).rows[0];
    if (!sel) return res.status(404).json({ error: 'Brouillon introuvable' });
    if (isBrandScoped(req) && sel.brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    await pool.query("DELETE FROM agent_selections WHERE token=$1 AND status='draft'", [req.params.token]);
    notifyOwner(
      `Sélection supprimée — ${sel.client_company || sel.client_name || ''} (${sel.brand_name})`,
      `<p><strong>Brouillon de sélection supprimé</strong></p>
       <table style="margin:14px 0;font-size:13px;border-collapse:collapse">
         <tr><td style="padding:3px 14px 3px 0;color:#888">Client</td><td>${escHtml(sel.client_name||'')}${sel.client_company?(' — '+escHtml(sel.client_company)):''}</td></tr>
         <tr><td style="padding:3px 14px 3px 0;color:#888">Email</td><td>${escHtml(sel.client_email||'')}</td></tr>
         <tr><td style="padding:3px 14px 3px 0;color:#888">Marque</td><td>${escHtml(sel.brand_name)}</td></tr>
       </table>`
    ).catch(() => {});
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/selections/drafts/:token/send', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM agent_selections WHERE token=$1 AND status='draft'", [req.params.token]);
    const draft = r.rows[0];
    if (!draft) return res.status(404).json({ error: 'Brouillon introuvable' });
    if (isBrandScoped(req) && draft.brand_id !== req.userBrandId) return res.status(403).json({ error: 'Accès refusé' });
    const b = await pool.query('SELECT name FROM brands WHERE id=$1', [draft.brand_id]);
    if (!b.rows[0]) return res.status(404).json({ error: 'Marque introuvable' });
    const seqSel = await pool.query("SELECT LPAD(nextval('selection_number_seq')::TEXT, 4, '0') AS num");
    const selectionNumber = 'SEL-' + seqSel.rows[0].num;
    await pool.query(
      "UPDATE agent_selections SET status='sent', selection_number=$1 WHERE token=$2",
      [selectionNumber, req.params.token]
    );
    const url = `${getBaseUrl(req)}/selection/${draft.token}`;
    sendAgentSelectionEmail({ email: draft.client_email, name: draft.client_name, brandName: b.rows[0].name, selectionNumber, url, req }).catch(e => console.error('draft-send email:', e.message));
    res.json({ ok: true, token: draft.token, url, selection_number: selectionNumber });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ==================== BADGE COUNTS ADMIN NAV ====================

app.get('/api/admin/badge-counts', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const scoped = isBrandScoped(req);
    const p = scoped ? [req.userBrandId] : [];
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '24 hours' ${scoped ? 'AND brand_id = $1' : ''}) as new_orders,
        (SELECT COUNT(*) FROM access_requests WHERE status='pending') as pending_requests,
        (SELECT COUNT(*) FROM appointments WHERE created_at > NOW() - INTERVAL '48 hours' ${scoped ? 'AND brand_id = $1' : ''}) as pending_appointments
    `, p);
    res.json({
      new_orders: parseInt(r.rows[0].new_orders) || 0,
      pending_requests: parseInt(r.rows[0].pending_requests) || 0,
      pending_appointments: parseInt(r.rows[0].pending_appointments) || 0
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// PWA assets
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.json')));
app.get('/agent-manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public', 'agent-manifest.json')));
// NB : /sw.js est servi plus haut (avec injection de APP_VERSION pour le cache-bust).
// L'ancienne définition en double ici servait le fichier statique sans versionnage
// (route morte, masquée par la première) → supprimée.

// Agent PWA
app.get('/agent', (req, res) => sendPage(res, 'agent.html'));

async function agentBrandsFor(user) {
  if (!user.brand_id) {
    const r = await pool.query("SELECT id, name, logo, logo_url, thumbnail FROM brands ORDER BY name");
    return r.rows;
  }
  const r = await pool.query('SELECT id, name, logo, logo_url, thumbnail FROM brands WHERE id=$1', [user.brand_id]);
  return r.rows;
}

app.post('/api/agent/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    const user = rows[0];
    const valid = await bcrypt.compare(password, user?.password_hash || DUMMY_BCRYPT_HASH);
    const locked = isLocked(user);
    if (user && locked) {
      logAuditRaw(user.email, 'login_blocked_locked', 'staff', user.id, req.ip);
      return res.status(423).json({ error: 'account_locked', message: 'Compte temporairement verrouillé suite à trop de tentatives. Réessayez dans quelques minutes.' });
    }
    if (!user || !valid) {
      if (user) await recordLoginFailure('admin_users', user.id);
      logAuditRaw(email.toLowerCase().trim(), 'login_failed', 'staff', '', req.ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await clearLoginFailures('admin_users', user.id);
    if (!user.mfa_enabled) {
      // MFA obligatoire sur tous les comptes admin_users, mais l'app agent (PWA
      // légère, sans page profil) n'a pas d'écran d'enrôlement QR — on renvoie
      // vers /admin où le flux d'activation existe déjà, plutôt que d'accorder
      // une session bloquée sans aucun moyen de la débloquer depuis cet écran.
      logAuditRaw(user.email, 'login_blocked_mfa_setup_required', 'staff', user.id, req.ip);
      return res.status(403).json({ error: 'mfa_setup_required', message: "Double authentification obligatoire. Connectez-vous une première fois sur /admin pour l'activer, puis revenez ici." });
    }
    // Mot de passe correct, MFA active : aucune session privilégiée tant que
    // le code TOTP n'est pas vérifié (même logique que /admin/login).
    req.session.mfaPending = { kind: 'staff', id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, name: user.name };
    logAuditRaw(user.email, 'login_password_ok_mfa_pending', 'staff', user.id, req.ip);
    return res.json({ mfaRequired: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Étape 2 du login agent PWA : vérification TOTP/code de secours, miroir JSON
// de /admin/login/mfa (qui répond par redirection HTML, inadapté au fetch()
// de agent.html).
app.post('/api/agent/login/mfa', loginLimiter, async (req, res) => {
  const pending = req.session.mfaPending;
  if (!pending || pending.kind !== 'staff') return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
  const code = (req.body.code || '').toString().trim();
  const backupCode = (req.body.backup_code || '').toString().trim();
  try {
    const r = await pool.query('SELECT mfa_secret, mfa_backup_codes FROM admin_users WHERE id=$1', [pending.id]);
    const row = r.rows[0];
    let ok = false, usedBackup = false;
    if (row?.mfa_secret) {
      const step = currentTotpStep();
      // Anti-rejeu atomique — cf. commentaire équivalent sur /admin/login/mfa.
      if (code && authenticator.check(code, row.mfa_secret)) {
        const claim = await pool.query('UPDATE admin_users SET mfa_last_step=$1 WHERE id=$2 AND mfa_last_step IS DISTINCT FROM $1 RETURNING id', [step, pending.id]);
        ok = claim.rowCount > 0;
      } else if (backupCode) {
        const updated = consumeBackupCode(row.mfa_backup_codes, backupCode);
        if (updated) {
          const claim = await pool.query('UPDATE admin_users SET mfa_backup_codes=$1 WHERE id=$2 AND mfa_backup_codes=$3 RETURNING id', [JSON.stringify(updated), pending.id, row.mfa_backup_codes]);
          ok = usedBackup = claim.rowCount > 0;
        }
      }
    }
    if (!ok) {
      logAuditRaw(pending.email, 'login_mfa_failed', 'staff', pending.id, req.ip);
      return res.status(401).json({ error: 'Code invalide' });
    }
    const brands = await agentBrandsFor(pending);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Server error' });
      req.session.staffUser = { id: pending.id, email: pending.email, role: pending.role, brand_id: pending.brand_id, name: pending.name, mfaEnrolled: true };
      logAuditRaw(pending.email, usedBackup ? 'login_success_mfa_backup' : 'login_success_mfa', 'staff', pending.id, req.ip);
      req.session.save(err2 => err2 ? res.status(500).json({ error: 'Server error' }) : res.json({ name: pending.name || pending.email, email: pending.email, role: pending.role, brands }));
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/agent/me', async (req, res) => {
  const user = req.session?.staffUser;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  let brands;
  try {
    if (!user.brand_id) {
      const r = await pool.query('SELECT id, name, logo, logo_url, thumbnail FROM brands ORDER BY name');
      brands = r.rows;
    } else {
      const r = await pool.query('SELECT id, name, logo, logo_url, thumbnail FROM brands WHERE id=$1', [user.brand_id]);
      brands = r.rows;
    }
    res.json({ name: user.name || user.email, email: user.email, role: user.role, brands });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/agent/logout', (req, res) => {
  const email = req.session?.user?.email || req.session?.staffUser?.email || 'unknown';
  logAuditRaw(email, 'logout', 'staff', '', req.ip);
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Reorder — dupliquer une commande existante ───────────────────────
app.post('/api/orders/:id/reorder', requireRole('owner', 'agent'), async (req, res) => {
  try {
    if (!await checkOrderBrandScope(req, res)) return;
    const src = await pool.query(
      'SELECT brand_id, buyer_id, client_name, client_email, client_company, client_phone, client_country, notes FROM orders WHERE id=$1',
      [req.params.id]
    );
    if (!src.rows.length) return res.status(404).json({ error: 'Commande introuvable' });
    const o = src.rows[0];
    const lines = await pool.query(
      'SELECT product_id, size, quantity, unit_price, price_retail, note FROM order_lines WHERE order_id=$1',
      [req.params.id]
    );
    const newId = uuidv4();
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      const seqRes = await dbClient.query("SELECT LPAD(nextval('order_number_seq')::TEXT, 4, '0') AS num");
      const orderNumber = 'ES-' + seqRes.rows[0].num;
      await dbClient.query(
        `INSERT INTO orders (id,brand_id,buyer_id,client_name,client_email,client_company,client_phone,client_country,notes,status,order_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`,
        [newId, o.brand_id, o.buyer_id, o.client_name, o.client_email, o.client_company, o.client_phone, o.client_country, o.notes, orderNumber]
      );
      for (const l of lines.rows) {
        await dbClient.query(
          'INSERT INTO order_lines (id,order_id,product_id,size,quantity,unit_price,price_retail,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [uuidv4(), newId, l.product_id, l.size, l.quantity, l.unit_price, l.price_retail, l.note]
        );
      }
      await dbClient.query('COMMIT');
    } catch(e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
    res.json({ id: newId });
  } catch(e) { console.error('reorder:', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── RGPD — Export données acheteur connecté ──────────────────────────
app.get('/api/portal/my-data-export', requireBuyerAuth, async (req, res) => {
  try {
    const buyerId = req.session.buyerPortal.id;
    const [profile, orders, favs] = await Promise.all([
      pool.query('SELECT id, email, name, company, phone, country, created_at, last_seen_at, lang FROM buyers WHERE id=$1', [buyerId]),
      pool.query(`SELECT o.id, o.order_number, o.brand_id, o.status, o.notes, o.created_at,
                         b.name as brand_name
                  FROM orders o JOIN brands b ON o.brand_id=b.id
                  WHERE o.buyer_id=$1 ORDER BY o.created_at DESC`, [buyerId]),
      pool.query('SELECT favorites_json FROM buyers WHERE id=$1', [buyerId]),
    ]);
    let favorites = [];
    try { favorites = JSON.parse(favs.rows[0]?.favorites_json || '[]'); } catch(e) {}
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="mes-donnees.json"');
    res.json({
      generated_at: new Date().toISOString(),
      profile: profile.rows[0] || null,
      orders: orders.rows,
      favorites,
    });
  } catch(e) { res.status(500).json({ error: 'Erreur export' }); }
});

// ── RGPD — Suppression compte acheteur (POST) ────────────────────────
app.post('/api/portal/delete-account', requireBuyerAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Mot de passe requis' });
    const buyerId = req.session.buyerPortal.id;
    const r = await pool.query('SELECT id, password_hash FROM buyers WHERE id=$1', [buyerId]);
    const buyer = r.rows[0];
    if (!buyer || !await bcrypt.compare(password, buyer.password_hash)) {
      return res.status(400).json({ error: 'Mot de passe incorrect' });
    }
    await anonymizeAndDeleteBuyer(buyerId);
    req.session.destroy(() => {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ── File de validation des relances automatiques ──────────────────────
// La détection (candidats à relancer) est automatique et planifiée — voir
// scheduleInactiveReminders / scheduleSelectionReminders plus loin, lancées
// une fois la base prête — mais l'ENVOI reste soumis à validation manuelle
// ici : ces deux relances partaient jusqu'ici sans regard humain malgré leur
// caractère commercial sensible.
async function sendInactiveReminderNow(buyerId) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY non configurée');
  const r = await pool.query('SELECT id, email, name, company, lang FROM buyers WHERE id=$1', [buyerId]);
  const buyer = r.rows[0];
  if (!buyer) throw new Error('Acheteur introuvable');
  const showroomName = await getSetting('showroom_name');
  const showroomEmail = await getSetting('showroom_email');
  const baseUrl = process.env.BASE_URL || 'https://showroom.editionsstandard.com';
  const isFr = (buyer.lang || 'fr') === 'fr';
  const subject = isFr ? `${showroomName} — Découvrez les nouveautés` : `${showroomName} — Discover new arrivals`;
  const content = isFr
    ? `<p>Bonjour ${escHtml(buyer.name || buyer.company || '')},</p><p>Cela fait un moment que vous n'avez pas visité le showroom <strong>${escHtml(showroomName)}</strong>. De nouvelles références sont disponibles.</p>${emailBtn(baseUrl + '/editions-showroom-b2b-portail', 'Accéder au showroom →')}`
    : `<p>Hello ${escHtml(buyer.name || buyer.company || '')},</p><p>It's been a while since you visited <strong>${escHtml(showroomName)}</strong>. New references are available.</p>${emailBtn(baseUrl + '/editions-showroom-b2b-portail', 'Visit the showroom →')}`;
  const resend = newResendClient(resendKey);
  // Le SDK Resend résout avec { data: null, error } sur une erreur API plutôt
  // que de lever une exception — sans ce contrôle, un envoi échoué serait
  // marqué "envoyé" à tort dans la file de validation.
  const { error } = await resend.emails.send({ from: `${showroomName} <noreply@editionsstandard.com>`, to: [buyer.email], ...(showroomEmail && showroomEmail.toLowerCase() !== buyer.email.toLowerCase() ? { bcc: [showroomEmail] } : {}), subject, html: emailLayout({ showroomName, content }) });
  if (error) throw new Error(`Resend: ${error.message || error.name || 'échec envoi'}`);
  await pool.query('UPDATE buyers SET last_seen_at=NOW() WHERE id=$1', [buyer.id]);
}

async function sendSelectionReminderNow(token) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY non configurée');
  const baseUrl = process.env.BASE_URL || 'https://showroom.editionsstandard.com';
  const r = await pool.query(
    `SELECT a.token, a.client_email, a.client_name, a.selection_number, b.name AS brand_name
     FROM agent_selections a JOIN brands b ON b.id = a.brand_id WHERE a.token=$1`, [token]
  );
  const s = r.rows[0];
  if (!s) throw new Error('Sélection introuvable');
  const url = `${baseUrl}/selection/${s.token}`;
  await sendAgentSelectionEmail({
    email: s.client_email, name: s.client_name, brandName: s.brand_name,
    selectionNumber: s.selection_number, url, reminder: true
  });
}

// pending_reminders n'a pas de brand_id propre : seul le type
// 'selection_reminder' est rattachable à une marque (via agent_selections),
// 'buyer_inactive' concerne l'acheteur tous marques confondues et n'est donc
// visible/actionnable QUE par un owner (pas de marque unique légitime à qui
// l'attribuer pour un agent borné).
async function reminderBrandId(row) {
  if (row.type !== 'selection_reminder') return null;
  const s = await pool.query('SELECT brand_id FROM agent_selections WHERE token=$1', [row.target_id]);
  return s.rows[0]?.brand_id || null;
}
async function checkReminderBrandScope(req, res, row) {
  if (!isBrandScoped(req)) return true;
  const bId = await reminderBrandId(row);
  if (bId !== req.userBrandId) {
    res.status(403).json({ error: 'Accès refusé' });
    return false;
  }
  return true;
}

app.get('/api/admin/pending-reminders', requireRole('owner','agent'), async (req, res) => {
  try {
    if (isBrandScoped(req)) {
      const r = await pool.query(
        `SELECT p.* FROM pending_reminders p
         JOIN agent_selections s ON s.token = p.target_id
         WHERE p.type = 'selection_reminder' AND s.brand_id = $1
         ORDER BY p.created_at DESC LIMIT 200`,
        [req.userBrandId]
      );
      return res.json(r.rows);
    }
    const r = await pool.query('SELECT * FROM pending_reminders ORDER BY created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/pending-reminders/:id/approve', requireRole('owner','agent'), async (req, res) => {
  try {
    const p = await pool.query("SELECT * FROM pending_reminders WHERE id=$1 AND status='pending'", [req.params.id]);
    const row = p.rows[0];
    if (!row) return res.status(404).json({ error: 'Relance introuvable ou déjà traitée' });
    if (!(await checkReminderBrandScope(req, res, row))) return;
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Email non configuré' });
    if (row.type === 'buyer_inactive') await sendInactiveReminderNow(row.target_id);
    else if (row.type === 'selection_reminder') await sendSelectionReminderNow(row.target_id);
    else return res.status(400).json({ error: 'Type de relance inconnu' });
    const by = req.session?.staffUser?.email || (req.session?.admin ? 'owner' : 'unknown');
    await pool.query("UPDATE pending_reminders SET status='sent', resolved_at=NOW(), resolved_by=$1 WHERE id=$2", [by, row.id]);
    logAudit(req, 'reminder_approved', row.type, row.target_id, row.label);
    res.json({ ok: true });
  } catch(e) { console.error('[pending-reminder-approve]', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/pending-reminders/:id/reject', requireRole('owner','agent'), async (req, res) => {
  try {
    const p = await pool.query("SELECT * FROM pending_reminders WHERE id=$1 AND status='pending'", [req.params.id]);
    const row = p.rows[0];
    if (!row) return res.status(404).json({ error: 'Relance introuvable ou déjà traitée' });
    if (!(await checkReminderBrandScope(req, res, row))) return;
    const by = req.session?.staffUser?.email || (req.session?.admin ? 'owner' : 'unknown');
    await pool.query("UPDATE pending_reminders SET status='rejected', resolved_at=NOW(), resolved_by=$1 WHERE id=$2", [by, row.id]);
    logAudit(req, 'reminder_rejected', row.type, row.target_id, row.label);
    res.json({ ok: true });
  } catch(e) { console.error('[pending-reminder-reject]', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Catch-all 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Gestionnaire d'erreur global Express — capture les exceptions des routes
// (placé après toutes les routes) pour renvoyer une 500 propre au lieu de planter.
app.use((err, req, res, next) => {
  log.error('[error]', { method: req.method, path: req.path, err: err.message });
  if (res.headersSent) return next(err);
  // JSON malformé côté client (express.json()) : erreur d'entrée, pas une
  // panne serveur — 400 plutôt que 500.
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Requête invalide (JSON malformé).' });
  }
  // Upload trop volumineux / malformé (multer) : erreur d'entrée, pas une panne serveur.
  if (err.name === 'MulterError') {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(code).json({ error: 'Fichier invalide ou trop volumineux.' });
  }
  res.status(500).json({ error: 'Erreur serveur' });
});

// Filet de sécurité au niveau du process : une erreur asynchrone non capturée
// ne doit PAS faire planter tout le serveur (sinon site down jusqu'au redémarrage).
process.on('unhandledRejection', (reason) => {
  log.error('[unhandledRejection]', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('[uncaughtException]', { err: err.message, stack: err.stack });
});

// Start
init().then(() => {
  // Préchauffe le cache des liens showroom (footer email) au démarrage, puis
  // rafraîchit périodiquement en filet de sécurité (POST /api/settings le
  // fait déjà immédiatement à la sauvegarde — ceci couvre un cache resté
  // stale après un redémarrage sans passer par cette route, cas rare).
  refreshShowroomLinksCache().catch(() => {});
  setInterval(() => refreshShowroomLinksCache().catch(() => {}), 5 * 60 * 1000);

  // Nettoyage périodique des tokens expirés (toutes les 6h)
  setInterval(async () => {
    try {
      await pool.query(`
        DELETE FROM buyer_magic_links WHERE expires_at < NOW();
        DELETE FROM buyer_password_resets WHERE expires_at < NOW();
        DELETE FROM buyer_access_tokens WHERE expires_at < NOW();
        DELETE FROM selection_shares WHERE expires_at < NOW();
        DELETE FROM agent_selections WHERE expires_at < NOW() - INTERVAL '30 days';
      `);
      await pool.query("DELETE FROM user_sessions WHERE expire < NOW()");
      // Rétention du journal d'audit : 12 mois — suffisant pour investiguer un
      // incident détecté tardivement, sans accumuler indéfiniment des emails/IPs.
      await pool.query("DELETE FROM admin_audit_log WHERE created_at < NOW() - INTERVAL '12 months'");
    } catch(e) { log.error('[cleanup]', { err: e.message }); }
  }, 6 * 60 * 60 * 1000);

  // ── Backup hebdomadaire (lundi 7h UTC) ───────────────────────────────
  function scheduleWeeklyBackup() {
    function msUntilNextMonday7h() {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(7, 0, 0, 0);
      const day = now.getUTCDay(); // 0=dim, 1=lun
      const daysUntilMonday = day === 1 ? (now.getUTCHours() >= 7 ? 7 : 0) : (8 - day) % 7;
      next.setUTCDate(now.getUTCDate() + daysUntilMonday);
      return next.getTime() - now.getTime();
    }

    async function runBackup() {
      try {
        const resendKey = process.env.RESEND_API_KEY;
        const adminEmail = process.env.ADMIN_EMAIL || await getSetting('showroom_email');
        if (!resendKey || !adminEmail) return;

        const [buyers, orders, brands] = await Promise.all([
          pool.query('SELECT id,email,name,company,country,created_at FROM buyers ORDER BY created_at DESC'),
          pool.query('SELECT o.id,o.order_number,b.name as brand,o.client_name,o.client_email,o.client_company,o.status,o.created_at FROM orders o JOIN brands b ON b.id=o.brand_id ORDER BY o.created_at DESC LIMIT 500'),
          pool.query('SELECT id,name,subscription_status,created_at FROM brands ORDER BY name'),
        ]);

        function toCSV(rows) {
          if (!rows.length) return '';
          const headers = Object.keys(rows[0]);
          return [headers.join(','), ...rows.map(r => headers.map(h => `"${(r[h]||'').toString().replace(/"/g,'""')}"`).join(','))].join('\n');
        }

        const buyersCSV = toCSV(buyers.rows);
        const ordersCSV = toCSV(orders.rows);
        const brandsCSV = toCSV(brands.rows);
        const date = new Date().toISOString().split('T')[0];
        const backupShowroomName = (await getSetting('showroom_name')) || 'Showroom';

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Showroom Backup <noreply@editionsstandard.com>',
            to: [adminEmail],
            subject: `[Backup] Showroom ES — ${date}`,
            html: emailLayout({ showroomName: backupShowroomName, content: `<p>Backup hebdomadaire du ${date}.</p><p>${buyers.rows.length} acheteurs, ${orders.rows.length} commandes, ${brands.rows.length} marques.</p><p>Fichiers CSV en pièces jointes.</p>`, footer: 'Sauvegarde automatique' }),
            attachments: [
              { filename: `buyers-${date}.csv`, content: Buffer.from(buyersCSV).toString('base64') },
              { filename: `orders-${date}.csv`, content: Buffer.from(ordersCSV).toString('base64') },
              { filename: `brands-${date}.csv`, content: Buffer.from(brandsCSV).toString('base64') },
            ]
          })
        });
        log.info('[backup] Backup hebdomadaire envoyé', { to: adminEmail });
      } catch(e) { log.error('[backup] Erreur', { err: e.message }); }

      setTimeout(runBackup, 7 * 24 * 60 * 60 * 1000);
    }

    setTimeout(runBackup, msUntilNextMonday7h());
  }
  scheduleWeeklyBackup();

  // ── Rappels RDV (toutes les heures) ─────────────────────────────────
  setInterval(async () => {
    try {
      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) return;
      const showroomName = await getSetting('showroom_name');
      const agentPhone = await getSetting('agent_phone');
      const showroomEmail = await getSetting('showroom_email');

      // RDV demain dont le rappel n'a pas encore été envoyé
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const rdvs = await pool.query(
        `SELECT * FROM appointments WHERE slot_date = $1 AND (reminder_sent IS NULL OR reminder_sent = false)`,
        [tomorrowStr]
      ).catch(() => ({ rows: [] }));

      const tomorrowDisplay = tomorrow.toLocaleDateString('fr-FR');
      for (const rdv of rdvs.rows) {
        // client_name/video_link viennent du formulaire de prise de RDV (public,
        // non authentifié) — jamais interpolés bruts en HTML, sinon un rendez-vous
        // pris avec un nom contenant du markup s'exécuterait dans la boîte mail du
        // client au rappel J-1 (cf. escHtml partout ailleurs pour le même champ).
        const content = `<p>Bonjour <strong>${escHtml(rdv.client_name)}</strong>,</p><p>Nous vous rappelons votre rendez-vous au showroom <strong>${escHtml(showroomName)}</strong> demain <strong>${escHtml(tomorrowDisplay)}</strong> à <strong>${escHtml(rdv.slot_time)}</strong>.</p>${rdv.video_link ? emailBtn(escHtml(rdv.video_link), 'Rejoindre la visioconférence →') : ''}${agentPhone ? `<p>Contact : ${escHtml(agentPhone)}</p>` : ''}<p>À demain !</p>`;
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `${showroomName} <noreply@editionsstandard.com>`,
            to: [rdv.client_email],
            ...(showroomEmail && showroomEmail.toLowerCase() !== rdv.client_email.toLowerCase() ? { bcc: [showroomEmail] } : {}),
            subject: `Rappel — Rendez-vous ${showroomName} demain`,
            html: emailLayout({ showroomName, content })
          })
        }).catch(e => { console.error('[rdv-email-error]', e.message); return null; });
        if (r && !r.ok) console.error('[rdv-email-error] Resend a répondu', r.status);

        await pool.query('UPDATE appointments SET reminder_sent = true WHERE id = $1', [rdv.id]).catch(e => console.error('[rdv-reminder-update-error]', e.message));
      }
      if (rdvs.rows.length) log.info('[rdv-reminders] rappels envoyés', { count: rdvs.rows.length });
    } catch(e) { log.error('[rdv-reminders]', { err: e.message }); }
  }, 60 * 60 * 1000);

  // ── Relances acheteurs inactifs (lundi 8h UTC) ───────────────────────
  // Détection automatique et planifiée, mais l'envoi ne part plus tout seul :
  // chaque candidat est mis en file dans pending_reminders, à valider ou
  // refuser depuis l'admin (POST /api/admin/pending-reminders/:id/approve|reject).
  function scheduleInactiveReminders() {
    async function runReminders() {
      try {
        const inactive = await pool.query(`
          SELECT b.id, b.email, b.name, b.company, b.lang
          FROM buyers b
          WHERE (b.last_seen_at < NOW() - INTERVAL '45 days' OR b.last_seen_at IS NULL)
            AND b.created_at < NOW() - INTERVAL '45 days'
            AND NOT EXISTS (
              SELECT 1 FROM pending_reminders p
              WHERE p.type='buyer_inactive' AND p.target_id=b.id AND p.status='pending'
            )
          ORDER BY b.last_seen_at ASC NULLS FIRST
          LIMIT 10
        `);

        for (const buyer of inactive.rows) {
          await pool.query(
            `INSERT INTO pending_reminders (id, type, target_id, label, preview) VALUES ($1,$2,$3,$4,$5)`,
            [uuidv4(), 'buyer_inactive', buyer.id, `${buyer.name || buyer.company || buyer.email}`, `Relance inactivité — ${buyer.email}`]
          );
        }
        if (inactive.rows.length) log.info('[reminders] relances mises en attente de validation', { count: inactive.rows.length });
      } catch(e) { log.error('[reminders] Erreur', { err: e.message }); }

      setTimeout(runReminders, 7 * 24 * 60 * 60 * 1000);
    }

    // Le déclenchement attendait auparavant le prochain lundi 8h UTC via un
    // setTimeout à durée fixe — sur une plateforme qui redéploie fréquemment
    // (chaque merge redémarre le process), ce minuteur repart de zéro à
    // chaque redémarrage et n'atteint jamais l'échéance si les déploiements
    // sont plus fréquents qu'une semaine, laissant l'onglet "Relances à
    // valider" vide indéfiniment. Un premier passage a désormais lieu peu
    // après le démarrage (comme pour les relances de sélection ci-dessous),
    // puis toutes les 7 jours à partir de ce moment-là.
    setTimeout(runReminders, 2 * 60 * 1000);
  }
  scheduleInactiveReminders();

  // ── Relance des sélections non confirmées (toutes les 12 h) ──────────
  // Un acheteur a reçu une sélection mais ne l'a pas validée : on met le
  // rappel en file d'attente quand le lien approche de son expiration —
  // l'envoi reste soumis à validation manuelle en admin (voir plus haut).
  function scheduleSelectionReminders() {
    async function run() {
      try {
        const due = await pool.query(`
          SELECT a.token, a.client_email, a.client_name, a.selection_number, b.name AS brand_name
          FROM agent_selections a JOIN brands b ON b.id = a.brand_id
          WHERE (a.used IS NULL OR a.used = false)
            AND a.expires_at > NOW()
            AND a.expires_at < NOW() + INTERVAL '5 days'
            AND a.created_at < NOW() - INTERVAL '3 days'
            AND (a.reminder_sent IS NULL OR a.reminder_sent = false)
            AND a.client_email IS NOT NULL AND a.client_email <> ''
            AND (a.is_template IS NULL OR a.is_template = false)
          ORDER BY a.expires_at ASC
          LIMIT 20
        `);
        for (const s of due.rows) {
          await pool.query(
            `INSERT INTO pending_reminders (id, type, target_id, label, preview) VALUES ($1,$2,$3,$4,$5)`,
            [uuidv4(), 'selection_reminder', s.token, `${s.client_name || s.client_email} — ${s.brand_name}`, `Relance sélection ${s.selection_number || ''} — ${s.client_email}`]
          );
          // Marqué immédiatement pour ne pas remettre la même sélection en file
          // à chaque passage du cron tant que la relance n'a pas été traitée.
          await pool.query('UPDATE agent_selections SET reminder_sent = true WHERE token = $1', [s.token]);
        }
        if (due.rows.length) log.info('[sel-reminders] relances mises en attente de validation', { count: due.rows.length });
      } catch(e) { log.error('[sel-reminders]', { err: e.message }); }
      setTimeout(run, 12 * 60 * 60 * 1000);
    }
    setTimeout(run, 90 * 1000); // premier passage ~1,5 min après le démarrage
  }
  scheduleSelectionReminders();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Showroom BDC démarré sur http://localhost:${PORT}`);
    console.log(`   Admin : http://localhost:${PORT}/admin\n`);
  });
}).catch(err => {
  console.error('Erreur démarrage DB:', err.message);
  process.exit(1);
});
