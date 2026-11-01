'use strict';
const {randomUUID}=require('node:crypto');
const {evaluateBuyer}=require('./buyer-engagement');
const MAX_BUYERS=10000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK="SELECT pg_try_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1')) AS acquired";
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
const episodeKey=(buyer,rule,anchor)=>JSON.stringify([buyer,rule,anchor]);
const anchorFor=(buyer,rule)=>rule.id==='welcome'?buyer.approval_anchor:buyer.activity_anchor;

async function pruneInTransaction(db) {
  // Fixed creation age, not last_checked_at: repeated scans cannot retain
  // personal episodes forever. Dedupe scope is consequently this 90-day window.
  await db.query("DELETE FROM buyer_engagement_simulation_candidates WHERE created_at<NOW()-INTERVAL '90 days'");
  await db.query("DELETE FROM buyer_engagement_simulation_runs WHERE completed_at<NOW()-INTERVAL '365 days'");
}
async function pruneLedger(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'");
    await db.query("SET LOCAL statement_timeout='20s'");
    if((await db.query(LOCK)).rows[0].acquired)await pruneInTransaction(db);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
async function runSimulation(pool,{request_key,kind}) {
  if(typeof request_key!=='string' || !UUID.test(request_key) || !['generate','recheck'].includes(kind))
    throw fail(400,'invalid_simulation_request','Identifiant de requête ou type de calcul invalide');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'");
    await db.query("SET LOCAL statement_timeout='20s'");
    // Transaction-scoped, automatically released on crash/disconnection.
    if(!(await db.query(LOCK)).rows[0].acquired)throw fail(409,'simulation_busy','Un calcul est déjà en cours. Réessayez avec la même requête.');
    const previous=(await db.query('SELECT * FROM buyer_engagement_simulation_runs WHERE request_key=$1',[request_key])).rows[0];
    if(previous) {
      if(previous.kind!==kind)throw fail(409,'request_key_reused','Cette requête correspond à un autre type de calcul.');
      await db.query('COMMIT');return {run:previous,replayed:true};
    }
    const control=(await db.query('SELECT * FROM buyer_engagement_simulation_control WHERE id=true FOR UPDATE')).rows[0];
    if(kind==='generate' && control.paused)throw fail(409,'simulation_paused','Les simulations sont en pause.');
    // All writers to rules/templates use this same parent row. Lock before
    // loading templates so a run never mixes template and rule versions.
    const rules=(await db.query('SELECT * FROM buyer_engagement_rules ORDER BY id FOR SHARE')).rows;
    const templates=(await db.query('SELECT DISTINCT ON(rule_id,lang) rule_id,lang,version FROM buyer_engagement_templates ORDER BY rule_id,lang,version DESC')).rows;
    // Preference changes also lock their buyer first. No names/emails, message
    // bodies, tokens or URLs are copied into this ledger.
    const buyers=(await db.query(`SELECT id,lang,activation_pending,login_history_known,approved_at,first_login_at,last_login_at,
      last_meaningful_activity_at,last_seen_at,last_engagement_email_at,
      approved_at::text AS approval_anchor,last_meaningful_activity_at::text AS activity_anchor
      FROM buyers ORDER BY id LIMIT $1 FOR SHARE`,[MAX_BUYERS+1])).rows;
    if(buyers.length>MAX_BUYERS)throw fail(422,'simulation_cohort_limit','Calcul non exécuté : plus de 10 000 acheteurs. Un traitement par lots est nécessaire.');
    const preferences=(await db.query('SELECT buyer_id,status FROM buyer_email_preferences WHERE buyer_id=ANY($1::text[])',[buyers.map(b=>b.id)])).rows;
    const prefMap=new Map(preferences.map(p=>[p.buyer_id,p.status]));
    buyers.forEach(b=>{b.email_status=prefMap.get(b.id)||'unknown';});
    const buyerMap=new Map(buyers.map(b=>[b.id,b]));
    const ruleMap=new Map(rules.map(r=>[r.id,r]));
    const templateFor=(b,r)=>templates.find(t=>t.rule_id===r.id && t.lang===(b.lang==='en'?'en':'fr'));
    await pruneInTransaction(db);
    const existing=(await db.query('SELECT *,anchor_at::text AS anchor_key FROM buyer_engagement_simulation_candidates ORDER BY id FOR UPDATE')).rows;
    const known=new Map(existing.map(c=>[episodeKey(c.buyer_id,c.rule_id,c.anchor_key),c]));
    const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
    const runId=randomUUID();
    await db.query(`INSERT INTO buyer_engagement_simulation_runs(id,request_key,kind,started_at,rule_snapshot)
      VALUES($1,$2,$3,$4,$5)`,[runId,request_key,kind,now,JSON.stringify({rules:rules.map(({id,version,delay_hours,mode})=>({id,version,delay_hours,mode})),templates,paused:control.paused})]);
    const counts={created_count:0,reused_count:0,eligible_count:0,excluded_count:0,evaluated_count:0};
    const updates=[];
    function record(candidate,buyer,rule,decision,template) {
      const status=decision.eligible?'eligible':'excluded';
      updates.push({id:candidate.id,buyer_id:buyer.id,rule_id:rule.id,
        anchor_at:candidate.anchor_key || anchorFor(buyer,rule),status,reason:decision.reason,
        rule_version:rule.version,delay_hours:rule.delay_hours,
        template_lang:template?.lang || candidate.template_lang,
        template_version:template?.version || candidate.template_version,
        first_run_id:candidate.first_run_id || runId,
        created_at:candidate.created_at || now});
      counts[decision.eligible?'eligible_count':'excluded_count']++;
    }
    // Reconcile every existing episode, even if it no longer appears in a list
    // of fresh eligible buyers. Old activity anchors never become eligible again.
    for(const candidate of existing) {
      const buyer=buyerMap.get(candidate.buyer_id),rule=ruleMap.get(candidate.rule_id);
      let decision=control.paused?{eligible:false,reason:'simulation_paused'}:evaluateBuyer(buyer,rule,now);
      if(decision.eligible && anchorFor(buyer,rule)!==candidate.anchor_key)decision={eligible:false,reason:'episode_changed'};
      const template=templateFor(buyer,rule);
      if(decision.eligible && !template)decision={eligible:false,reason:'template_missing'};
      record(candidate,buyer,rule,decision,template);counts.reused_count++;
      if(kind==='recheck')counts.evaluated_count++;
    }
    if(kind==='generate')for(const buyer of buyers)for(const rule of rules) {
      counts.evaluated_count++;
      const decision=evaluateBuyer(buyer,rule,now),template=templateFor(buyer,rule);
      if(!decision.eligible || !template)continue;
      const anchor=anchorFor(buyer,rule);
      if(known.has(episodeKey(buyer.id,rule.id,anchor)))continue;
      const candidate={id:randomUUID()};
      record(candidate,buyer,rule,decision,template);counts.created_count++;
    }
    if(updates.length) {
      // Two batched statements, not thousands of round trips while buyer rows
      // are SHARE-locked. No rendered message or personal contact is persisted.
      await db.query(`INSERT INTO buyer_engagement_simulation_candidates(id,buyer_id,rule_id,anchor_at,status,reason,
        rule_version,delay_hours,template_lang,template_version,first_run_id,last_run_id,created_at,last_checked_at)
        SELECT id,buyer_id,rule_id,anchor_at,status,reason,rule_version,delay_hours,template_lang,template_version,first_run_id,$2,created_at,$3
        FROM jsonb_to_recordset($1::jsonb) AS rows(id uuid,buyer_id text,rule_id text,anchor_at timestamptz,status text,reason text,
          rule_version integer,delay_hours integer,template_lang text,template_version integer,first_run_id uuid,created_at timestamptz)
        ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,rule_version=EXCLUDED.rule_version,
          delay_hours=EXCLUDED.delay_hours,template_lang=EXCLUDED.template_lang,template_version=EXCLUDED.template_version,
          last_run_id=EXCLUDED.last_run_id,last_checked_at=EXCLUDED.last_checked_at`,[JSON.stringify(updates),runId,now]);
      await db.query(`INSERT INTO buyer_engagement_simulation_checks(run_id,candidate_id,status,reason,rule_version,delay_hours,template_lang,template_version,checked_at)
        SELECT last_run_id,id,status,reason,rule_version,delay_hours,template_lang,template_version,last_checked_at
        FROM buyer_engagement_simulation_candidates WHERE last_run_id=$1`,[runId]);
    }
    const run=(await db.query(`UPDATE buyer_engagement_simulation_runs SET completed_at=clock_timestamp(),scanned_count=$2,evaluated_count=$3,
      created_count=$4,reused_count=$5,eligible_count=$6,excluded_count=$7 WHERE id=$1 RETURNING *`,
      [runId,buyers.length,counts.evaluated_count,counts.created_count,counts.reused_count,counts.eligible_count,counts.excluded_count])).rows[0];
    await db.query('COMMIT');return {run,replayed:false};
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
async function setSimulationControl(pool,{paused,version}) {
  if(typeof paused!=='boolean' || !Number.isInteger(version))throw fail(400,'invalid_control','Pause ou version invalide');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'");
    await db.query("SET LOCAL statement_timeout='20s'");
    if(!(await db.query(LOCK)).rows[0].acquired)throw fail(409,'simulation_busy','Un calcul est déjà en cours. Réessayez.');
    const result=await db.query(`UPDATE buyer_engagement_simulation_control SET paused=$1,version=version+1,updated_at=NOW()
      WHERE id=true AND version=$2 RETURNING *`,[paused,version]);
    if(!result.rowCount)throw fail(409,'control_conflict','Le réglage a changé. Rechargez la page.');
    await db.query('COMMIT');return result.rows[0];
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
async function getLedger(pool,{offset=0,run_offset=0}={}) {
  offset=Math.max(0,Math.min(1000000,Number.parseInt(offset)||0));
  run_offset=Math.max(0,Math.min(1000000,Number.parseInt(run_offset)||0));
  const db=await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const control=(await db.query('SELECT * FROM buyer_engagement_simulation_control WHERE id=true')).rows[0];
    const candidates=(await db.query(`SELECT c.*,b.name AS buyer_name,b.email AS buyer_email FROM buyer_engagement_simulation_candidates c
      JOIN buyers b ON b.id=c.buyer_id ORDER BY c.created_at DESC,c.id DESC LIMIT 50 OFFSET $1`,[offset])).rows;
    const total=(await db.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_simulation_candidates')).rows[0].n;
    const runs=(await db.query('SELECT * FROM buyer_engagement_simulation_runs ORDER BY started_at DESC,id DESC LIMIT 10 OFFSET $1',[run_offset])).rows;
    const runTotal=(await db.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_simulation_runs')).rows[0].n;
    await db.query('COMMIT');
    return {sending_enabled:false,control,candidates:{rows:candidates.map(c=>control.paused?{...c,status:'excluded',reason:'simulation_paused'}:c),total,offset,limit:50},runs:{rows:runs,total:runTotal,offset:run_offset,limit:10}};
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
async function exportSimulationLedger(pool,buyerId) {
  const [candidates,checks]=await Promise.all([
    pool.query('SELECT * FROM buyer_engagement_simulation_candidates WHERE buyer_id=$1 ORDER BY created_at,id',[buyerId]),
    pool.query(`SELECT h.* FROM buyer_engagement_simulation_checks h JOIN buyer_engagement_simulation_candidates c ON c.id=h.candidate_id
      WHERE c.buyer_id=$1 ORDER BY h.checked_at,h.run_id`,[buyerId])
  ]);
  return {candidates:candidates.rows,checks:checks.rows};
}
function registerSimulationLedger({app,pool,ownerAuth,audit}) {
  const wrap=fn=>async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {await fn(req,res);}catch(error){
      if(!error.status)console.error('[engagement-simulation]',error.code||'failed');
      res.status(error.status||500).json({error:error.status?error.message:'Calcul indisponible. Réessayez avec la même requête.',code:error.code||'simulation_failed'});
    }
  };
  app.get('/api/admin/buyer-engagement/ledger',ownerAuth,wrap(async(req,res)=>res.json(await getLedger(pool,req.query))));
  app.post('/api/admin/buyer-engagement/simulation-runs',ownerAuth,wrap(async(req,res)=>{
    const result=await runSimulation(pool,req.body||{});
    if(!result.replayed)audit(req,'engagement_simulation_run','engagement_run',result.run.id,result.run.kind);
    res.json(result);
  }));
  app.put('/api/admin/buyer-engagement/simulation-control',ownerAuth,wrap(async(req,res)=>{
    const result=await setSimulationControl(pool,req.body||{});
    audit(req,'engagement_simulation_control','engagement_control','simulation',result.paused?'paused':'resumed');
    res.json(result);
  }));
}
module.exports={runSimulation,setSimulationControl,getLedger,exportSimulationLedger,registerSimulationLedger,pruneLedger};
