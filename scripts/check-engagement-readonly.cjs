'use strict';
// Does not import server/database.js, run migrations or invoke providers.
// Supply a read-only database credential through ENGAGEMENT_AUDIT_DATABASE_URL.
const {Client}=require('pg');
(async()=>{
  if(!process.env.ENGAGEMENT_AUDIT_DATABASE_URL)throw new Error('ENGAGEMENT_AUDIT_DATABASE_URL requis (identifiant en lecture seule)');
  const db=new Client({connectionString:process.env.ENGAGEMENT_AUDIT_DATABASE_URL,application_name:'engagement-readonly-audit'});
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='15s'");
    const version=(await db.query('SHOW server_version')).rows[0];
    const schema=(await db.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('buyers','buyer_carts','buyer_email_preferences','buyer_engagement_rules','buyer_engagement_templates','buyer_engagement_simulation_runs','buyer_engagement_simulation_candidates','buyer_engagement_simulation_checks','buyer_engagement_simulation_control')
      ORDER BY table_name,ordinal_position`)).rows;
    const counts=(await db.query(`SELECT (SELECT COUNT(*) FROM buyers) AS buyers,
      (SELECT COUNT(*) FROM buyer_carts) AS saved_carts,
      (SELECT COUNT(*) FROM access_requests WHERE status='pending') AS pending_requests,
      (SELECT COUNT(*) FROM access_requests WHERE status='rejected' AND created_at<NOW()-INTERVAL '30 days') AS overdue_rejected_requests`)).rows[0];
    let coverage=null;
    if(schema.some(c=>c.table_name==='buyers' && c.column_name==='login_history_known')) {
      coverage=(await db.query(`SELECT COUNT(*) FILTER(WHERE login_history_known) AS complete_login_histories,
        COUNT(*) FILTER(WHERE NOT login_history_known) AS unknown_login_histories,
        COUNT(*) FILTER(WHERE last_login_at IS NOT NULL) AS observed_logins FROM buyers`)).rows[0];
    }
    let simulation_ledger=null;
    if(schema.some(c=>c.table_name==='buyer_engagement_simulation_runs')) {
      simulation_ledger=(await db.query(`SELECT (SELECT COUNT(*) FROM buyer_engagement_simulation_runs) AS runs,
        (SELECT COUNT(*) FROM buyer_engagement_simulation_candidates) AS candidates,
        (SELECT COUNT(*) FROM buyer_engagement_simulation_checks) AS checks,
        (SELECT paused FROM buyer_engagement_simulation_control WHERE id=true) AS paused`)).rows[0];
    }
    await db.query('ROLLBACK');
    console.log(JSON.stringify({read_only:true,generated_at:new Date().toISOString(),version,schema,counts,coverage,simulation_ledger},null,2));
  } finally {await db.end();}
})().catch(()=>{console.error('Audit impossible. Vérifier les droits, la connexion et le schéma ; aucun identifiant n’est affiché.');process.exitCode=1;});
