// Utilitaires partagés par les tests d'intégration : lance le vrai serveur
// (node server.js) contre une base Postgres de test dédiée, et fournit des
// raccourcis de seed. Chaque fichier de test tourne dans son propre process
// worker (comportement par défaut de node:test) — DB et port dédiés par
// fichier pour éviter toute collision quand les tests s'exécutent en parallèle.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const crypto = require('node:crypto');

const PG_ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

async function ensureDb(dbName) {
  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
    if (!exists.rows.length) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

function dbUrlFor(dbName) {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = '/' + dbName;
  return u.toString();
}

async function waitForServer(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(baseUrl + '/');
      if (r.status) return true;
    } catch (e) { /* pas encore prêt */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Le serveur de test n\'a pas démarré à temps: ' + baseUrl);
}

async function startServer({ dbNameSuffix, port }) {
  const dbName = 'showroom_test_' + dbNameSuffix;
  await ensureDb(dbName);
  const databaseUrl = dbUrlFor(dbName);

  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      SESSION_SECRET: 'test-secret-not-for-production',
      ADMIN_PASSWORD: 'TestAdmin123!',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl);
  } catch (e) {
    proc.kill();
    throw new Error(e.message + '\nstderr:\n' + stderr);
  }

  return {
    baseUrl,
    dbUrl: databaseUrl,
    stop: () => { try { proc.kill(); } catch (e) {} },
  };
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

// Connexion directe pour seeder des données de test (bcrypt côté appelant si besoin).
async function withDb(dbUrl, fn) {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

module.exports = { startServer, id, withDb };
