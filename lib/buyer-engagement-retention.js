'use strict';
// Local retention only. This module has no mailer, CRM client or delivery queue.
const {randomUUID}=require('node:crypto');
const ENGINE="hashtext('buyer-engagement:simulation-engine:v1')";
const CHECK_MS=5*60*1000,INTERVAL_HOURS=6,GRACE_HOURS=8,BATCH=1000;
const SCOPES=[
  {key:'brand_candidates',table:'buyer_brand_interest_candidates',keyColumn:'id',age:'created_at',days:90},
  {key:'brand_observations',table:'buyer_brand_interest_days',keyColumn:'buyer_id,brand_id,visit_day',age:'observed_at',days:30},
  {key:'brand_runs',table:'buyer_brand_interest_runs',keyColumn:'id',age:'created_at',days:365},
  {key:'cart_candidates',table:'buyer_cart_simulation_candidates',keyColumn:'id',age:'created_at',days:90},
  {key:'cart_runs',table:'buyer_cart_simulation_runs',keyColumn:'id',age:'created_at',days:365},
  {key:'outbox',table:'buyer_engagement_outbox',keyColumn:'id',age:'created_at',days:90},
  {key:'outbox_operations',table:'buyer_engagement_outbox_operations',keyColumn:'request_key',age:'created_at',days:365}
];
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
let runtime={enabled:false,last_tick_at:null};
function errorCode(error){return error.code==='57014'?'retention_timeout':error.code==='55P03'?'retention_lock_timeout':'retention_failed';}
async function runRetention(pool,{trigger='manual',request_key=randomUUID(),onlyIfDue=false}={}) {
  if(!['startup','scheduled','manual'].includes(trigger)||!uuid(request_key))throw fail(400,'invalid_retention_request');
  const db=await pool.connect();let owned=false,run,releaseError;
  try {
    const previous=(await db.query('SELECT * FROM buyer_engagement_retention_runs WHERE request_key=$1',[request_key])).rows[0];
    if(previous&&previous.trigger!==trigger)throw fail(409,'retention_key_reused');
    if(previous&&previous.status!=='running')return {run:previous,replayed:true};
    owned=(await db.query(`SELECT pg_try_advisory_lock(${ENGINE}) AS acquired`)).rows[0].acquired;
    if(!owned) {
      if(previous)return {run:previous,replayed:true};
      const inserted=(await db.query(`INSERT INTO buyer_engagement_retention_runs(id,request_key,trigger,status,finished_at)
        VALUES($1,$2,$3,'skipped_busy',NOW()) ON CONFLICT(request_key) DO NOTHING RETURNING *`,[randomUUID(),request_key,trigger])).rows[0];
      return {run:inserted||(await db.query('SELECT * FROM buyer_engagement_retention_runs WHERE request_key=$1',[request_key])).rows[0],replayed:!inserted};
    }
    // The session lock survives each commit. A running entry without this lock
    // is interrupted: its cleanup transaction cannot still be executing.
    await db.query("UPDATE buyer_engagement_retention_runs SET status='interrupted',finished_at=NOW(),error_code='retention_interrupted' WHERE status='running'");
    if(previous)return {run:(await db.query('SELECT * FROM buyer_engagement_retention_runs WHERE id=$1',[previous.id])).rows[0],replayed:true};
    if(onlyIfDue) {
      const due=(await db.query(`SELECT NOT EXISTS(SELECT 1 FROM buyer_engagement_retention_runs WHERE status='succeeded' AND finished_at>NOW()-make_interval(hours=>$1))
        OR COALESCE((SELECT status IN ('partial','failed','interrupted','skipped_busy') FROM buyer_engagement_retention_runs ORDER BY started_at DESC,id DESC LIMIT 1),false) AS due`,[INTERVAL_HOURS])).rows[0].due;
      if(!due)return {not_due:true};
    }
    run=(await db.query(`INSERT INTO buyer_engagement_retention_runs(id,request_key,trigger,status) VALUES($1,$2,$3,'running')
      ON CONFLICT(request_key) DO NOTHING RETURNING *`,[randomUUID(),request_key,trigger])).rows[0];
    if(!run)return {run:(await db.query('SELECT * FROM buyer_engagement_retention_runs WHERE request_key=$1',[request_key])).rows[0],replayed:true};
    // The attempt is committed before cleanup. A crash rolls back deletions but
    // leaves evidence of an unconfirmed attempt, never a false success.
    try {
      await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='20s'");
      const counts={},remaining={};
      for(const scope of SCOPES) {
        // Identifiers are code constants, never supplied by a request.
        const keys=scope.keyColumn.split(','),predicate=keys.map(key=>`t.${key}=doomed.${key}`).join(' AND ');
        const result=await db.query(`WITH doomed AS(SELECT ${scope.keyColumn} FROM ${scope.table}
          WHERE ${scope.age}<NOW()-make_interval(days=>$1) ORDER BY ${scope.age},${scope.keyColumn} LIMIT $2 FOR UPDATE SKIP LOCKED)
          DELETE FROM ${scope.table} t USING doomed WHERE ${predicate}`,[scope.days,BATCH]);
        counts[scope.key]=result.rowCount;
        remaining[scope.key]=(await db.query(`SELECT EXISTS(SELECT 1 FROM ${scope.table} WHERE ${scope.age}<NOW()-make_interval(days=>$1)) AS remaining`,[scope.days])).rows[0].remaining;
      }
      const payloads=await db.query(`WITH old AS(SELECT id FROM buyer_engagement_outbox WHERE sealed_payload IS NOT NULL AND first_attempt_at<NOW()-INTERVAL '24 hours' ORDER BY first_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
        UPDATE buyer_engagement_outbox o SET sealed_payload=NULL,needs_attention=true,reason='replay_window_expired',updated_at=NOW() FROM old WHERE o.id=old.id RETURNING o.id,o.attempt_count`,[BATCH]);
      counts.outbox_payloads=payloads.rowCount;remaining.outbox_payloads=(await db.query("SELECT EXISTS(SELECT 1 FROM buyer_engagement_outbox WHERE sealed_payload IS NOT NULL AND first_attempt_at<NOW()-INTERVAL '24 hours') AS remaining")).rows[0].remaining;
      for(const row of payloads.rows)await db.query("INSERT INTO buyer_engagement_outbox_events(outbox_id,event,reason,attempt_no) VALUES($1,'payload_redacted','replay_window_expired',$2)",[row.id,row.attempt_count]);
      await db.query("DELETE FROM buyer_engagement_retention_runs WHERE finished_at<NOW()-INTERVAL '30 days'");
      const status=Object.values(remaining).some(Boolean)?'partial':'succeeded';
      run=(await db.query(`UPDATE buyer_engagement_retention_runs SET status=$2,finished_at=clock_timestamp(),counts=$3,remaining=$4 WHERE id=$1 RETURNING *`,[run.id,status,JSON.stringify(counts),JSON.stringify(remaining)])).rows[0];
      await db.query('COMMIT');return {run,replayed:false};
    } catch(error) {
      await db.query('ROLLBACK');
      const failed=(await db.query("UPDATE buyer_engagement_retention_runs SET status='failed',finished_at=clock_timestamp(),error_code=$2 WHERE id=$1 AND status='running' RETURNING *",[run.id,errorCode(error)])).rows[0];
      run=failed||(await db.query('SELECT * FROM buyer_engagement_retention_runs WHERE id=$1',[run.id])).rows[0];
      return {run,replayed:false};
    }
  } catch(error) {
    // An unconfirmed lock-acquisition reply may still have granted the lease.
    // Discard the session on unexpected outer errors so it cannot return to the pool.
    if(!error.status)releaseError=error;
    throw error;
  } finally {
    if(owned)try{await db.query(`SELECT pg_advisory_unlock(${ENGINE})`);}catch(error){releaseError=error;}
    // Destroy a connection whose session lock could not be released.
    db.release(releaseError);
  }
}
async function retentionHealth(pool) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const now=(await db.query('SELECT NOW() AS now')).rows[0].now;
    const runs=(await db.query('SELECT * FROM buyer_engagement_retention_runs ORDER BY started_at DESC,id DESC LIMIT 10')).rows;
    const lastSuccess=(await db.query("SELECT finished_at FROM buyer_engagement_retention_runs WHERE status='succeeded' ORDER BY finished_at DESC LIMIT 1")).rows[0]?.finished_at||null;
    const late=!lastSuccess||+now-+lastSuccess>GRACE_HOURS*3600000;
    const latest=runs[0],stalled=latest?.status==='running'&&+now-+latest.started_at>10*60000;
    const attention=!runtime.enabled||late||stalled||['failed','partial','interrupted'].includes(latest?.status);
    await db.query('COMMIT');return {now,last_success_at:lastSuccess,late,stalled,attention,runs,runtime:{...runtime},
      interval_hours:INTERVAL_HOURS,grace_hours:GRACE_HOURS,check_minutes:CHECK_MS/60000,batch_limit:BATCH,
      policy:[...SCOPES.map(s=>({key:s.key,days:s.days})),{key:'outbox_payloads',days:1,action:'redact'}],sending_enabled:false,crm_writes_enabled:false};
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
function startRetentionScheduler(pool,{enabled=true,schedule=setTimeout,cancel=clearTimeout}={}) {
  runtime={enabled:!!enabled,last_tick_at:null};let stopped=false,timer;
  if(!enabled)return {stop(){}};
  const next=()=>{if(!stopped){timer=schedule(tick,CHECK_MS);timer?.unref?.();}};
  async function tick(){
    if(stopped)return;runtime.last_tick_at=new Date().toISOString();
    try{const result=await runRetention(pool,{trigger:'scheduled',onlyIfDue:true});if(result.run?.status==='failed')console.error('[engagement-retention] retention_failed');}
    catch(error){console.error('[engagement-retention]',errorCode(error));}
    finally{next();}
  }
  next();return {stop(){stopped=true;runtime.enabled=false;cancel(timer);}};
}
function registerRetention({app,pool,ownerAuth,audit}) {
  const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(error){if(!error.status)console.error('[engagement-retention]',errorCode(error));res.status(error.status||503).json({code:error.status?error.code:'retention_unavailable'});}};
  app.get('/api/admin/buyer-engagement/retention',ownerAuth,wrap(async(req,res)=>res.json(await retentionHealth(pool))));
  app.post('/api/admin/buyer-engagement/retention/runs',ownerAuth,wrap(async(req,res)=>{
    if(!uuid(req.body?.request_key))throw fail(400,'invalid_retention_request');
    const result=await runRetention(pool,{trigger:'manual',request_key:req.body.request_key});
    if(!result.replayed)audit(req,'engagement_retention','engagement_retention_run',result.run.id,result.run.status);
    res.json(result);
  }));
}
module.exports={runRetention,retentionHealth,startRetentionScheduler,registerRetention,schedulerEnabled:()=>runtime.enabled};
