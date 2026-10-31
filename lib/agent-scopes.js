'use strict';
const { getCountryCode } = require('./territories');

function normalizeGrants(input) {
  if (!Array.isArray(input) || input.length > 500) throw new Error('Affectations invalides (500 maximum)');
  const result = new Map();
  for (const grant of input) {
    if (!grant || typeof grant.brand_id !== 'string' || !grant.brand_id || grant.brand_id.length > 100) throw new Error('Marque requise');
    const country = grant.country_code === '*' ? '*' : getCountryCode(grant.country_code);
    if (!country) throw new Error('Pays ISO requis ou * pour tous pays');
    result.set(`${grant.brand_id}:${country}`, { brand_id: grant.brand_id, country_code: country });
  }
  return [...result.values()];
}
function contains(parent, child) {
  return parent.some(p => p.brand_id === child.brand_id && (p.country_code === '*' || p.country_code === child.country_code));
}
// Fixed, programmer-owned SQL expressions only. Values always use bind parameters.
function scopeSql(brand, country, param = '$1') {
  return `EXISTS (SELECT 1 FROM agent_scope_grants g WHERE g.staff_id = ${param} AND g.brand_id = ${brand} AND (g.country_code = '*' OR g.country_code = ${country}))`;
}
async function loadGrants(db, id) {
  return (await db.query('SELECT brand_id,country_code FROM agent_scope_grants WHERE staff_id=$1 ORDER BY brand_id,country_code', [id])).rows;
}
function registerAgentScopes({ app, pool, auth, audit }) {
  app.get('/api/staff/:id/scopes', auth('owner'), async (req, res) => {
    try {
      const target = (await pool.query('SELECT id,role,parent_agent_id FROM admin_users WHERE id=$1', [req.params.id])).rows[0];
      if (!target) return res.status(404).json({ error: 'Compte introuvable' });
      res.json({ ...target, grants: await loadGrants(pool, target.id) });
    } catch (e) { res.status(500).json({ error: 'Lecture des affectations impossible' }); }
  });
  app.put('/api/staff/:id/scopes', auth('owner'), async (req, res) => {
    let grants;
    try { grants = normalizeGrants(req.body.grants); } catch (e) { return res.status(400).json({ error: e.message }); }
    const parent = req.body.parent_agent_id || null;
    if (parent !== null && typeof parent !== 'string') return res.status(400).json({ error: 'Agent référent invalide' });
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Serializes hierarchy/grant edits, including concurrent parent reductions.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('agent-scope-edits'))");
      const target = (await db.query('SELECT role FROM admin_users WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (target?.role !== 'agent') throw new Error('Affectations réservées aux agents');
      const children = (await db.query('SELECT id FROM admin_users WHERE parent_agent_id=$1', [req.params.id])).rows;
      if (parent) {
        const p = (await db.query('SELECT role,parent_agent_id FROM admin_users WHERE id=$1 FOR UPDATE', [parent])).rows[0];
        if (parent === req.params.id || p?.role !== 'agent' || p.parent_agent_id || children.length) throw new Error('Hiérarchie limitée à agent et sous-agent, sans cycle');
        const parentGrants = await loadGrants(db, parent);
        if (grants.some(g => !contains(parentGrants, g))) throw new Error('Le sous-agent dépasse les droits de son référent');
      }
      for (const child of children) {
        if ((await loadGrants(db, child.id)).some(g => !contains(grants, g))) throw new Error('Réduisez d’abord les droits des sous-agents concernés');
      }
      await db.query('DELETE FROM agent_scope_grants WHERE staff_id=$1', [req.params.id]);
      for (const g of grants) await db.query('INSERT INTO agent_scope_grants(staff_id,brand_id,country_code) VALUES($1,$2,$3)', [req.params.id, g.brand_id, g.country_code]);
      await db.query('UPDATE admin_users SET parent_agent_id=$1 WHERE id=$2', [parent, req.params.id]);
      await db.query('COMMIT');
      audit(req, 'agent_scopes_updated', 'staff', req.params.id, JSON.stringify({ parent_agent_id: parent, grants }));
      res.json({ ok: true, parent_agent_id: parent, grants });
    } catch (e) {
      await db.query('ROLLBACK');
      res.status(e.code === '23503' ? 400 : 409).json({ error: e.code === '23503' ? 'Marque ou compte inconnu' : e.message });
    } finally { db.release(); }
  });
}
module.exports = { normalizeGrants, contains, scopeSql, loadGrants, registerAgentScopes };
