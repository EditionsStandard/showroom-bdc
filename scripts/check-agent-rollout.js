'use strict';
// Read-only deployment preflight. Uses DATABASE_URL from the environment, never prints it.
const { pool } = require('../database');
(async()=>{
  try {
    const agents=(await pool.query("SELECT id,brand_id FROM admin_users WHERE role='agent' ORDER BY id")).rows;
    const exists=(await pool.query("SELECT to_regclass('agent_scope_grants') AS name")).rows[0].name;
    const grants=exists?(await pool.query('SELECT staff_id,brand_id,country_code FROM agent_scope_grants')).rows:[];
    const missing=agents.filter(a=>!grants.some(g=>g.staff_id===a.id)).map(a=>a.id);
    const countries=(await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE TRIM(COALESCE(client_country,'')) !~ '^[A-Za-z]{2}$'")).rows[0].count;
    console.log(JSON.stringify({schema_prepared:!!exists,agents:agents.length,agents_requiring_owner_assignment:missing,orders_requiring_country_review:countries},null,2));
    if(missing.length) process.exitCode=1;
  } catch(e) {console.error('Preflight impossible:',e.code||'database_error');process.exitCode=1;}
  finally {await pool.end();}
})();
