'use strict';
// This module has no provider, HTTP, SMTP or activation-token adapter. SQL also
// forbids delivery_enabled=true, any mode other than dry_run, and sent states.
const {randomUUID}=require('node:crypto');
const {evaluateBuyer}=require('./buyer-engagement');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENGINE_LOCK="SELECT pg_try_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1')) AS acquired";
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
const sourceFields=`id,lang,activation_pending,login_history_known,approved_at,first_login_at,last_login_at,
  last_meaningful_activity_at,last_seen_at,last_engagement_email_at,
  approved_at::text AS approval_anchor,last_meaningful_activity_at::text AS activity_anchor`;
const anchor=(buyer,rule)=>rule.id==='welcome'?buyer.approval_anchor:buyer.activity_anchor;
const key=(buyer,rule,time)=>JSON.stringify([buyer,rule,time]);
const batchSize=value=>{
  if(!Number.isInteger(value)||value<1||value>10)throw fail(400,'invalid_batch_size','Taille de lot invalide (1 à 10)');
  return value;
};
async function transaction(pool,fn,{readOnly=false}={}) {
  const db=await pool.connect();
  try {
    await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='20s'");
    const result=await fn(db);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function lockEngine(db) {
  if(!(await db.query(ENGINE_LOCK)).rows[0].acquired)throw fail(409,'preparation_busy','Un calcul est déjà en cours. Réessayez.');
}
async function event(db,job,type,reason) {
  await db.query('INSERT INTO buyer_engagement_preparation_events(job_id,event,reason,attempt_count) VALUES($1,$2,$3,$4)',[job.id,type,reason,job.attempt_count]);
}
async function pruneInside(db) {
  await db.query(`DELETE FROM buyer_engagement_preparation_jobs WHERE created_at<NOW()-INTERVAL '90 days'
    AND (status<>'reserved' OR lease_expires_at<NOW())`);
  await db.query("DELETE FROM buyer_engagement_preparation_enqueue_operations WHERE created_at<NOW()-INTERVAL '365 days'");
}
async function prunePreparationQueue(pool) {
  return transaction(pool,async db=>{if((await db.query(ENGINE_LOCK)).rows[0].acquired)await pruneInside(db);});
}
function currentDecision(buyer,rule,template,record,now) {
  if(!buyer)return {eligible:false,reason:'buyer_missing'};
  if(!rule || !['welcome','inactive'].includes(rule.id))return {eligible:false,reason:'unsupported_rule'};
  const decision=evaluateBuyer(buyer,rule,now);
  if(!decision.eligible)return decision;
  if(anchor(buyer,rule)!==record.anchor_key)return {eligible:false,reason:'episode_changed'};
  if(rule.version!==record.rule_version || rule.delay_hours!==record.delay_hours)return {eligible:false,reason:'rule_changed'};
  if(!template || template.lang!==record.template_lang || template.version!==record.template_version)return {eligible:false,reason:'template_changed'};
  if(record.activation_pending_snapshot!==undefined && Boolean(buyer.activation_pending)!==record.activation_pending_snapshot)
    return {eligible:false,reason:'activation_changed'};
  return decision;
}
async function enqueuePreparations(pool,{request_key}={}) {
  if(typeof request_key!=='string'||!UUID.test(request_key))throw fail(400,'invalid_preparation_request','Identifiant de requête invalide');
  return transaction(pool,async db=>{
    await lockEngine(db);
    const previous=(await db.query('SELECT * FROM buyer_engagement_preparation_enqueue_operations WHERE request_key=$1',[request_key])).rows[0];
    if(previous)return {...previous,replayed:true};
    await db.query('SELECT id FROM buyer_engagement_preparation_control WHERE id=true FOR SHARE');
    const rules=(await db.query('SELECT * FROM buyer_engagement_rules ORDER BY id FOR SHARE')).rows;
    const templates=(await db.query('SELECT DISTINCT ON(rule_id,lang) rule_id,lang,version FROM buyer_engagement_templates ORDER BY rule_id,lang,version DESC')).rows;
    const candidates=(await db.query(`SELECT *,anchor_at::text AS anchor_key FROM buyer_engagement_simulation_candidates
      WHERE status='eligible' AND rule_id IN ('welcome','inactive') ORDER BY id LIMIT 1001`)).rows;
    if(candidates.length>1000)throw fail(422,'preparation_cohort_limit','Préparation refusée : plus de 1 000 candidats. Un traitement par lots est nécessaire.');
    const buyers=(await db.query(`SELECT ${sourceFields} FROM buyers WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`,[candidates.map(c=>c.buyer_id)])).rows;
    const preferences=(await db.query('SELECT buyer_id,status FROM buyer_email_preferences WHERE buyer_id=ANY($1::text[])',[buyers.map(b=>b.id)])).rows;
    const prefMap=new Map(preferences.map(p=>[p.buyer_id,p.status]));buyers.forEach(b=>{b.email_status=prefMap.get(b.id)||'unknown';});
    const buyerMap=new Map(buyers.map(b=>[b.id,b]));
    await pruneInside(db);
    const existing=(await db.query(`SELECT buyer_id,rule_id,anchor_at::text AS anchor_key FROM buyer_engagement_preparation_jobs WHERE buyer_id=ANY($1::text[])`,[buyers.map(b=>b.id)])).rows;
    const known=new Set(existing.map(j=>key(j.buyer_id,j.rule_id,j.anchor_key)));
    const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
    const jobs=[],counts={created_count:0,reused_count:0,rejected_count:0};
    const simPaused=(await db.query('SELECT paused FROM buyer_engagement_simulation_control WHERE id=true')).rows[0].paused;
    for(const candidate of candidates) {
      const buyer=buyerMap.get(candidate.buyer_id),rule=rules.find(r=>r.id===candidate.rule_id);
      const template=templates.find(t=>t.rule_id===candidate.rule_id&&t.lang===(buyer?.lang==='en'?'en':'fr'));
      if(simPaused || !currentDecision(buyer,rule,template,candidate,now).eligible){counts.rejected_count++;continue;}
      if(known.has(key(buyer.id,rule.id,candidate.anchor_key))){counts.reused_count++;continue;}
      jobs.push({id:randomUUID(),buyer_id:buyer.id,candidate_id:candidate.id,rule_id:rule.id,anchor_at:candidate.anchor_key,
        rule_version:rule.version,delay_hours:rule.delay_hours,template_lang:template.lang,template_version:template.version,
        activation_pending_snapshot:Boolean(buyer.activation_pending)});counts.created_count++;
    }
    if(jobs.length) {
      await db.query(`INSERT INTO buyer_engagement_preparation_jobs(id,buyer_id,candidate_id,rule_id,anchor_at,rule_version,delay_hours,
        template_lang,template_version,activation_pending_snapshot)
        SELECT id,buyer_id,candidate_id,rule_id,anchor_at,rule_version,delay_hours,template_lang,template_version,activation_pending_snapshot
        FROM jsonb_to_recordset($1::jsonb) AS rows(id uuid,buyer_id text,candidate_id uuid,rule_id text,anchor_at timestamptz,
          rule_version integer,delay_hours integer,template_lang text,template_version integer,activation_pending_snapshot boolean)`,[JSON.stringify(jobs)]);
      await db.query(`INSERT INTO buyer_engagement_preparation_events(job_id,event,reason,attempt_count)
        SELECT id,'enqueued','prepared',0 FROM buyer_engagement_preparation_jobs WHERE id=ANY($1::uuid[])`,[jobs.map(j=>j.id)]);
    }
    const result=(await db.query(`INSERT INTO buyer_engagement_preparation_enqueue_operations(request_key,created_count,reused_count,rejected_count)
      VALUES($1,$2,$3,$4) RETURNING *`,[request_key,counts.created_count,counts.reused_count,counts.rejected_count])).rows[0];
    return {...result,replayed:false};
  });
}
async function reserveBatch(pool,{batch_size=10}={}) {
  batchSize(batch_size);
  return transaction(pool,async db=>{
    const control=(await db.query('SELECT * FROM buyer_engagement_preparation_control WHERE id=true FOR SHARE')).rows[0];
    if(control.paused)throw fail(409,'preparation_paused','Le traitement de préparation est en pause.');
    const jobs=(await db.query(`SELECT *,anchor_at::text AS anchor_key FROM buyer_engagement_preparation_jobs
      WHERE created_at>=NOW()-INTERVAL '90 days' AND ((status='pending' AND next_attempt_at<=NOW())
        OR (status='reserved' AND lease_expires_at<=NOW()))
      ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[batch_size])).rows;
    const claims=[];let expired_failed=0;
    for(const job of jobs) {
      if(job.attempt_count>=3) {
        await db.query("UPDATE buyer_engagement_preparation_jobs SET status='failed',reason='lease_exhausted',lease_token=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1",[job.id]);
        await event(db,job,'failed','lease_exhausted');expired_failed++;continue;
      }
      const claimed=(await db.query(`UPDATE buyer_engagement_preparation_jobs SET status='reserved',reason='reserved',attempt_count=attempt_count+1,
        lease_token=$2,lease_expires_at=NOW()+INTERVAL '60 seconds',updated_at=NOW() WHERE id=$1 RETURNING *,anchor_at::text AS anchor_key`,[job.id,randomUUID()])).rows[0];
      await event(db,claimed,job.status==='reserved'?'lease_recovered':'reserved','reserved');claims.push(claimed);
    }
    return {claims,expired_failed};
  });
}
async function claimPreparations(pool,options) {return (await reserveBatch(pool,options)).claims;}
function validateDraft(template) {
  const variables=[...(template.subject+'\n'+template.body).matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(m=>m[1]);
  if(variables.some(v=>!['buyer_name','portal_url'].includes(v)))throw new Error('unsupported_draft_variable');
  return {ok:true};
}
async function releaseClaim(pool,claim,reason) {
  return transaction(pool,async db=>{
    const result=await db.query(`UPDATE buyer_engagement_preparation_jobs SET status='pending',reason=$3,
      attempt_count=GREATEST(0,attempt_count-1),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND lease_token=$2 AND status='reserved' AND lease_expires_at>NOW() RETURNING *`,[claim.id,claim.lease_token,reason]);
    if(!result.rowCount)return 'stale';await event(db,result.rows[0],'released',reason);return 'released';
  });
}
async function processClaim(pool,claim,{probe=validateDraft}={}) {
  if(!claim||!UUID.test(claim.id||'')||!UUID.test(claim.lease_token||''))throw fail(400,'invalid_claim','Réservation invalide');
  try {
    return await transaction(pool,async db=>{
      await lockEngine(db);
      const control=(await db.query('SELECT * FROM buyer_engagement_preparation_control WHERE id=true FOR SHARE')).rows[0];
      if(control.paused)throw fail(409,'preparation_paused','Le traitement de préparation est en pause.');
      const source=(await db.query('SELECT buyer_id,rule_id FROM buyer_engagement_preparation_jobs WHERE id=$1',[claim.id])).rows[0];
      if(!source)return 'stale';
      const rule=(await db.query('SELECT * FROM buyer_engagement_rules WHERE id=$1 FOR SHARE',[source.rule_id])).rows[0];
      const buyer=(await db.query(`SELECT ${sourceFields} FROM buyers WHERE id=$1 FOR SHARE`,[source.buyer_id])).rows[0];
      if(buyer)buyer.email_status=(await db.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[buyer.id])).rows[0]?.status||'unknown';
      const template=(await db.query('SELECT * FROM buyer_engagement_templates WHERE rule_id=$1 AND lang=$2 ORDER BY version DESC LIMIT 1',[source.rule_id,buyer?.lang==='en'?'en':'fr'])).rows[0];
      const job=(await db.query(`SELECT *,anchor_at::text AS anchor_key,(lease_expires_at>clock_timestamp()) AS lease_valid
        FROM buyer_engagement_preparation_jobs WHERE id=$1 FOR UPDATE`,[claim.id])).rows[0];
      if(!job||job.status!=='reserved'||job.lease_token!==claim.lease_token||!job.lease_valid)return 'stale';
      const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
      const simPaused=(await db.query('SELECT paused FROM buyer_engagement_simulation_control WHERE id=true')).rows[0].paused;
      if(simPaused)throw fail(409,'simulation_paused','Les simulations sont en pause.');
      const decision=currentDecision(buyer,rule,template,job,now);
      let status='simulated',reason='dry_run_validated',next=now;
      if(!decision.eligible){status='cancelled';reason=decision.reason;}
      else {
        try {const checked=await probe(template);if(checked?.ok!==true)throw new Error('draft_validation_failed');}
        catch(error) {
          if(error.retryable===true){status=job.attempt_count>=3?'failed':'pending';reason=status==='failed'?'retry_exhausted':'preparation_retry';next=new Date(+now+60000*(2**(job.attempt_count-1)));}
          else {status='cancelled';reason='template_invalid';}
        }
      }
      // A lease can expire while a validation hook is running. Never let an old
      // worker overwrite a newer reservation, even with the original claim.
      const result=await db.query(`UPDATE buyer_engagement_preparation_jobs SET status=$3,reason=$4,next_attempt_at=$5,
        lease_token=NULL,lease_expires_at=NULL,checked_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 AND status='reserved' AND lease_expires_at>clock_timestamp() RETURNING *`,[job.id,claim.lease_token,status,reason,next]);
      if(!result.rowCount)return 'stale';
      const outcome=status==='pending'?'retry_scheduled':status;
      await event(db,result.rows[0],outcome,reason);return outcome;
    });
  }catch(error){
    if(['preparation_busy','preparation_paused','simulation_paused'].includes(error.code))return releaseClaim(pool,claim,error.code);
    throw error;
  }
}
async function processPreparations(pool,{batch_size=10}={},options={}) {
  const {claims,expired_failed}=await reserveBatch(pool,{batch_size});
  const counts={claimed:claims.length,simulated:0,cancelled:0,retry_scheduled:0,failed:expired_failed,stale:0,expired_failed};
  for(const claim of claims) {
    const result=await processClaim(pool,claim,options);
    counts[result==='released'?'retry_scheduled':result]++;
  }
  return counts;
}
async function setPreparationControl(pool,{paused,version}={}) {
  if(typeof paused!=='boolean'||!Number.isInteger(version))throw fail(400,'invalid_preparation_control','Pause ou version invalide');
  return transaction(pool,async db=>{
    await lockEngine(db);
    const result=await db.query(`UPDATE buyer_engagement_preparation_control SET paused=$1,version=version+1,updated_at=NOW()
      WHERE id=true AND version=$2 RETURNING *`,[paused,version]);
    if(!result.rowCount)throw fail(409,'preparation_control_conflict','Le réglage a changé. Rechargez la page.');
    return result.rows[0];
  });
}
async function getPreparationQueue(pool,{offset=0}={}) {
  offset=Math.max(0,Math.min(1000000,Number.parseInt(offset)||0));
  return transaction(pool,async db=>{
    const control=(await db.query('SELECT * FROM buyer_engagement_preparation_control WHERE id=true')).rows[0];
    const rows=(await db.query(`SELECT j.id,j.buyer_id,b.name AS buyer_name,b.email AS buyer_email,j.rule_id,j.status,j.reason,
      j.attempt_count,j.next_attempt_at,j.lease_expires_at,j.created_at,j.updated_at,j.checked_at
      FROM buyer_engagement_preparation_jobs j JOIN buyers b ON b.id=j.buyer_id ORDER BY j.created_at DESC,j.id DESC LIMIT 50 OFFSET $1`,[offset])).rows;
    const counts={pending:0,reserved:0,simulated:0,cancelled:0,failed:0};
    for(const row of (await db.query('SELECT status,COUNT(*)::int AS n FROM buyer_engagement_preparation_jobs GROUP BY status')).rows)counts[row.status]=row.n;
    return {mode:'dry_run',delivery_enabled:false,control,jobs:{rows,total:Object.values(counts).reduce((a,b)=>a+b,0),offset,limit:50},counts};
  },{readOnly:true});
}
async function exportPreparationQueue(pool,buyerId) {
  const [jobs,events]=await Promise.all([
    pool.query(`SELECT id,buyer_id,candidate_id,rule_id,scope_key,anchor_at,mode,status,reason,rule_version,delay_hours,
      template_lang,template_version,activation_pending_snapshot,attempt_count,next_attempt_at,lease_expires_at,created_at,updated_at,checked_at
      FROM buyer_engagement_preparation_jobs WHERE buyer_id=$1 ORDER BY created_at,id`,[buyerId]),
    pool.query(`SELECT e.* FROM buyer_engagement_preparation_events e JOIN buyer_engagement_preparation_jobs j ON j.id=e.job_id WHERE j.buyer_id=$1 ORDER BY e.id`,[buyerId])
  ]);
  return {jobs:jobs.rows,events:events.rows};
}
function registerPreparationQueue({app,pool,ownerAuth,audit}) {
  const wrap=fn=>async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{await fn(req,res);}catch(error){if(!error.status)console.error('[engagement-preparation]',error.code||'failed');
      res.status(error.status||500).json({error:error.status?error.message:'Préparation indisponible. Consultez la file avant de réessayer.',code:error.code||'preparation_failed'});}
  };
  app.get('/api/admin/buyer-engagement/preparation-queue',ownerAuth,wrap(async(req,res)=>res.json(await getPreparationQueue(pool,req.query))));
  app.post('/api/admin/buyer-engagement/preparation-queue/enqueue',ownerAuth,wrap(async(req,res)=>{
    const result=await enqueuePreparations(pool,req.body||{});if(!result.replayed)audit(req,'engagement_enqueue','engagement_queue',req.body.request_key);res.json(result);
  }));
  app.post('/api/admin/buyer-engagement/preparation-queue/process',ownerAuth,wrap(async(req,res)=>{
    const result=await processPreparations(pool,req.body||{});audit(req,'engagement_dry_run','engagement_queue','dry_run',JSON.stringify(result));res.json(result);
  }));
  app.put('/api/admin/buyer-engagement/preparation-queue/control',ownerAuth,wrap(async(req,res)=>{
    const result=await setPreparationControl(pool,req.body||{});audit(req,'engagement_queue_control','engagement_queue','dry_run',result.paused?'paused':'resumed');res.json(result);
  }));
}
module.exports={enqueuePreparations,claimPreparations,processPreparations,processClaim,setPreparationControl,getPreparationQueue,prunePreparationQueue,exportPreparationQueue,registerPreparationQueue,currentDecision};
