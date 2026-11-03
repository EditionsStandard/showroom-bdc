'use strict';
// First-party, consent-gated daily observations; simulations never feed a sender or CRM.
const {randomUUID}=require('node:crypto');
const rateLimit=require('express-rate-limit').rateLimit;
const NOTICE_VERSION='brand-interest-v1';
const LIMIT=5000;
const LOCK="SELECT pg_try_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1')) AS acquired";
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
async function transaction(pool,fn,readOnly=false) {
  const db=await pool.connect();
  try {
    await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='20s'");
    const result=await fn(db);await db.query('COMMIT');return result;
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
async function preference(db,buyerId) {
  const row=(await db.query('SELECT status,version,notice_version,recorded_at FROM buyer_interest_preferences WHERE buyer_id=$1',[buyerId])).rows[0];
  const enabled=(await db.query("SELECT r.mode='simulation' AND NOT c.paused AS enabled FROM buyer_engagement_rules r CROSS JOIN buyer_engagement_simulation_control c WHERE r.id='brand_interest'")).rows[0].enabled;
  const usable=row?.notice_version===NOTICE_VERSION;
  return {status:usable?row.status:'unknown',version:row?.version||0,recorded_at:usable?row.recorded_at:null,
    notice_version:NOTICE_VERSION,collecting_enabled:enabled&&usable&&row.status==='granted',
    retention_schedule_enabled:require('./buyer-engagement-retention').schedulerEnabled()};
}
async function savePreference(pool,buyerId,body={}) {
  if(typeof body.interest_consent!=='boolean'||!Number.isInteger(body.version)||body.version<0||body.notice_version!==NOTICE_VERSION)throw fail(400,'invalid_interest_preference');
  return transaction(pool,async db=>{
    if(!(await db.query('SELECT id FROM buyers WHERE id=$1 FOR UPDATE',[buyerId])).rowCount)throw fail(404,'buyer_missing');
    const current=(await db.query('SELECT * FROM buyer_interest_preferences WHERE buyer_id=$1',[buyerId])).rows[0];
    // Withdrawal always wins over a stale granting form. A grant must use the current version.
    if(body.interest_consent&&(current?.version||0)!==body.version)throw fail(409,'interest_preference_conflict');
    const status=body.interest_consent?'granted':'denied';
    if(current?.status!==status||current.notice_version!==NOTICE_VERSION) {
      if(body.interest_consent) {
        await db.query('DELETE FROM buyer_brand_interest_candidates WHERE buyer_id=$1',[buyerId]);
        await db.query('DELETE FROM buyer_brand_interest_days WHERE buyer_id=$1',[buyerId]);
      }
      const version=(current?.version||0)+1;
      await db.query(`INSERT INTO buyer_interest_preferences(buyer_id,status,version,notice_version) VALUES($1,$2,$3,$4)
        ON CONFLICT(buyer_id) DO UPDATE SET status=$2,version=$3,notice_version=$4,recorded_at=NOW()`,[buyerId,status,version,NOTICE_VERSION]);
      await db.query('INSERT INTO buyer_interest_preference_events(buyer_id,status,version,notice_version) VALUES($1,$2,$3,$4)',[buyerId,status,version,NOTICE_VERSION]);
    }
    if(!body.interest_consent) {
      await db.query('DELETE FROM buyer_brand_interest_candidates WHERE buyer_id=$1',[buyerId]);
      await db.query('DELETE FROM buyer_brand_interest_days WHERE buyer_id=$1',[buyerId]);
    }
    return preference(db,buyerId);
  });
}
async function recordBrandDay(pool,buyerId,body={}) {
  if(typeof body.brand_id!=='string'||!body.brand_id||body.brand_id.length>200||!Number.isInteger(body.consent_version)||body.consent_version<1)throw fail(400,'invalid_interest_observation');
  return transaction(pool,async db=>{
    // Rule/control locks precede buyer locks in every collector. A pause or rule
    // disable waits for in-flight observations before it can be acknowledged.
    const gate=(await db.query(`SELECT NOW() AS now,r.mode='simulation' AND NOT c.paused AS enabled FROM buyer_engagement_rules r CROSS JOIN buyer_engagement_simulation_control c WHERE r.id='brand_interest' FOR SHARE OF r,c`)).rows[0];
    const buyer=(await db.query('SELECT approved_at,last_login_at,activation_pending FROM buyers WHERE id=$1 FOR UPDATE',[buyerId])).rows[0];
    const prefs=(await db.query('SELECT * FROM buyer_interest_preferences WHERE buyer_id=$1',[buyerId])).rows[0];
    if(!gate.enabled||prefs?.status!=='granted'||prefs.notice_version!==NOTICE_VERSION||prefs.version!==body.consent_version||!buyer?.approved_at||!buyer.last_login_at||buyer.activation_pending||+buyer.approved_at>+gate.now||+buyer.last_login_at>+gate.now)return {recorded:false};
    const brand=(await db.query(`SELECT b.subscription_status,b.early_access_until,t.is_privileged FROM brands b LEFT JOIN buyer_brand_terms t ON t.brand_id=b.id AND t.buyer_id=$2 WHERE b.id=$1`,[body.brand_id,buyerId])).rows[0];
    if(!brand||brand.subscription_status==='inactive'||(brand.early_access_until&&+brand.early_access_until>+gate.now&&!brand.is_privileged))return {recorded:false};
    const result=await db.query(`INSERT INTO buyer_brand_interest_days(buyer_id,brand_id,consent_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING buyer_id`,[buyerId,body.brand_id,prefs.version]);
    return {recorded:!!result.rowCount};
  });
}
async function sources(db,buyerIds=null) {
  const rule=(await db.query("SELECT * FROM buyer_engagement_rules WHERE id='brand_interest'")).rows[0];
  const paused=(await db.query('SELECT paused FROM buyer_engagement_simulation_control WHERE id=true')).rows[0].paused;
  const now=(await db.query('SELECT NOW() AS now')).rows[0].now;
  const rows=(await db.query(`WITH visits AS (
    SELECT d.buyer_id,d.brand_id,COUNT(*)::int AS distinct_days,MIN(d.observed_at) AS first_observed_at,MAX(d.observed_at) AS last_observed_at
    FROM buyer_brand_interest_days d JOIN buyer_interest_preferences p ON p.buyer_id=d.buyer_id AND p.version=d.consent_version
    WHERE p.status='granted' AND p.notice_version=$2 AND d.observed_at>=NOW()-make_interval(hours=>$1) AND d.observed_at<=NOW()
      AND d.visit_day=(d.observed_at AT TIME ZONE 'UTC')::date
    GROUP BY d.buyer_id,d.brand_id
  ), pairs AS (
    SELECT buyer_id,brand_id FROM visits UNION SELECT buyer_id,brand_id FROM buyer_brand_interest_candidates
  ) SELECT pairs.*,b.name AS buyer_name,br.name AS brand_name,COALESCE(v.distinct_days,0)::int AS distinct_days,v.first_observed_at,v.last_observed_at,
    b.approved_at,b.last_login_at,b.activation_pending,COALESCE(p.status,'unknown') AS interest_status,p.notice_version,
    COALESCE(e.status,'unknown') AS email_status,br.subscription_status,br.early_access_until,t.is_privileged,
    b.approved_at<=NOW() AND b.last_login_at<=NOW() AS access_dates_valid,
    b.last_engagement_email_at IS NULL OR b.last_engagement_email_at<=NOW()-INTERVAL '24 hours' AS contact_old,
    EXISTS(SELECT 1 FROM orders o WHERE o.buyer_id=pairs.buyer_id AND o.brand_id=pairs.brand_id AND o.status NOT IN ('draft','cancelled') AND o.created_at>=v.first_observed_at) AS ordered
    FROM pairs JOIN buyers b ON b.id=pairs.buyer_id JOIN brands br ON br.id=pairs.brand_id
    LEFT JOIN visits v ON v.buyer_id=pairs.buyer_id AND v.brand_id=pairs.brand_id LEFT JOIN buyer_interest_preferences p ON p.buyer_id=b.id
    LEFT JOIN buyer_email_preferences e ON e.buyer_id=b.id LEFT JOIN buyer_brand_terms t ON t.buyer_id=b.id AND t.brand_id=br.id
    WHERE ($4::text[] IS NULL OR pairs.buyer_id=ANY($4))
    ORDER BY pairs.buyer_id,pairs.brand_id LIMIT $3`,[rule.delay_hours,NOTICE_VERSION,LIMIT+1,buyerIds])).rows;
  if(rows.length>LIMIT)throw fail(422,'interest_cohort_limit');
  return {rule,paused,now,rows};
}
function decision(row,source) {
  const no=reason=>({eligible:false,reason}),{rule,paused,now}=source;
  if(paused)return no('simulation_paused');
  if(rule.mode!=='simulation')return no('rule_disabled');
  if(rule.delay_hours<72||rule.delay_hours>720||rule.delay_hours%24||rule.min_distinct_days>rule.delay_hours/24)return no('interest_rule_invalid');
  if(row.interest_status!=='granted'||row.notice_version!==NOTICE_VERSION)return no('interest_permission_missing');
  if(row.email_status!=='granted')return no('marketing_permission_missing');
  if(!row.approved_at||!row.last_login_at||row.activation_pending||!row.access_dates_valid)return no('access_incomplete');
  if(row.subscription_status==='inactive')return no('brand_unavailable');
  if(row.early_access_until&&+row.early_access_until>+now&&!row.is_privileged)return no('early_access');
  if(row.distinct_days<rule.min_distinct_days)return no('interest_days_insufficient');
  if(row.ordered)return no('order_since_observations');
  if(!row.contact_old)return no('recent_contact');
  return {eligible:true,reason:'repeated_brand_days'};
}
async function prune(db) {
  await db.query("DELETE FROM buyer_brand_interest_candidates WHERE created_at<NOW()-INTERVAL '90 days'");
  await db.query("DELETE FROM buyer_brand_interest_days WHERE observed_at<NOW()-INTERVAL '30 days'");
  await db.query("DELETE FROM buyer_brand_interest_runs WHERE created_at<NOW()-INTERVAL '365 days'");
}
async function runBrandInterest(pool,{kind,request_key}={}) {
  if(!['generate','recheck'].includes(kind)||!uuid(request_key))throw fail(400,'invalid_interest_run');
  return transaction(pool,async db=>{
    if(!(await db.query(LOCK)).rows[0].acquired)throw fail(409,'simulation_busy');
    const previous=(await db.query('SELECT * FROM buyer_brand_interest_runs WHERE request_key=$1',[request_key])).rows[0];
    if(previous){if(previous.kind!==kind)throw fail(409,'request_key_reused');return {run:previous,replayed:true};}
    // Preference changes use the same buyer locks, so a withdrawal cannot be followed by a stale candidate insert.
    // Rule editors use the rule row; simulation engines share the global advisory lock.
    await db.query("SELECT id FROM buyer_engagement_rules WHERE id='brand_interest' FOR SHARE");
    const buyers=(await db.query(`SELECT b.id FROM buyers b WHERE EXISTS(SELECT 1 FROM buyer_brand_interest_days d WHERE d.buyer_id=b.id)
      OR EXISTS(SELECT 1 FROM buyer_brand_interest_candidates c WHERE c.buyer_id=b.id) ORDER BY b.id LIMIT $1 FOR UPDATE`,[LIMIT+1])).rows;
    if(buyers.length>LIMIT)throw fail(422,'interest_cohort_limit');
    await prune(db);
    const source=await sources(db,buyers.map(b=>b.id));
    if(kind==='generate'&&source.paused)throw fail(409,'simulation_paused');
    const old=(await db.query('SELECT * FROM buyer_brand_interest_candidates ORDER BY id')).rows;
    const oldMap=new Map(old.map(c=>[JSON.stringify([c.buyer_id,c.brand_id]),c]));
    const updates=[];
    for(const row of source.rows) {
      const prior=oldMap.get(JSON.stringify([row.buyer_id,row.brand_id])),outcome=decision(row,source);
      if(prior||(kind==='generate'&&outcome.eligible))updates.push({row,prior,outcome});
    }
    const counts={scanned:source.rows.length,created:updates.filter(u=>!u.prior).length,rechecked:updates.filter(u=>u.prior).length,
      eligible:updates.filter(u=>u.outcome.eligible).length,excluded:updates.filter(u=>!u.outcome.eligible).length};
    const run=(await db.query(`INSERT INTO buyer_brand_interest_runs(id,request_key,kind,scanned_count,created_count,rechecked_count,eligible_count,excluded_count,rule_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),request_key,kind,counts.scanned,counts.created,counts.rechecked,counts.eligible,counts.excluded,JSON.stringify({rule:source.rule,paused:source.paused})])).rows[0];
    const records=updates.map(({row,prior,outcome})=>({id:prior?.id||randomUUID(),buyer_id:row.buyer_id,brand_id:row.brand_id,
      status:outcome.eligible?'eligible':'excluded',reason:outcome.reason,distinct_days:row.distinct_days,first_observed_at:row.first_observed_at,
      last_observed_at:row.last_observed_at,rule_version:source.rule.version,window_hours:source.rule.delay_hours,min_distinct_days:source.rule.min_distinct_days}));
    if(records.length) {
      await db.query(`INSERT INTO buyer_brand_interest_candidates(id,buyer_id,brand_id,status,reason,distinct_days,first_observed_at,last_observed_at,rule_version,window_hours,min_distinct_days,last_run_id)
        SELECT id,buyer_id,brand_id,status,reason,distinct_days,first_observed_at,last_observed_at,rule_version,window_hours,min_distinct_days,$2
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,buyer_id text,brand_id text,status text,reason text,distinct_days integer,first_observed_at timestamptz,last_observed_at timestamptz,rule_version integer,window_hours integer,min_distinct_days integer)
        ON CONFLICT(buyer_id,brand_id) DO UPDATE SET
        status=EXCLUDED.status,reason=EXCLUDED.reason,distinct_days=EXCLUDED.distinct_days,first_observed_at=EXCLUDED.first_observed_at,last_observed_at=EXCLUDED.last_observed_at,
        rule_version=EXCLUDED.rule_version,window_hours=EXCLUDED.window_hours,min_distinct_days=EXCLUDED.min_distinct_days,checked_at=NOW(),last_run_id=EXCLUDED.last_run_id`,[JSON.stringify(records),run.id]);
      await db.query(`INSERT INTO buyer_brand_interest_checks(candidate_id,run_id,status,reason,distinct_days,first_observed_at,last_observed_at,rule_version,window_hours,min_distinct_days)
        SELECT id,$1,status,reason,distinct_days,first_observed_at,last_observed_at,rule_version,window_hours,min_distinct_days FROM buyer_brand_interest_candidates WHERE last_run_id=$1`,[run.id]);
    }
    return {run,replayed:false};
  });
}
async function getBrandInterest(pool,{offset=0}={}) {
  offset=Math.max(0,Math.min(1000000,Number.parseInt(offset)||0));
  return transaction(pool,async db=>{
    const source=await sources(db),candidates=(await db.query('SELECT * FROM buyer_brand_interest_candidates ORDER BY buyer_id,brand_id')).rows;
    const oldMap=new Map(candidates.map(c=>[JSON.stringify([c.buyer_id,c.brand_id]),c]));
    const rows=source.rows.map(row=>{
      const old=oldMap.get(JSON.stringify([row.buyer_id,row.brand_id]));
      return {buyer_id:row.buyer_id,buyer_name:row.buyer_name,brand_id:row.brand_id,brand_name:row.brand_name,distinct_days:row.distinct_days,
        first_observed_at:row.first_observed_at,last_observed_at:row.last_observed_at,...decision(row,source),
        recorded:old?{status:old.status,reason:old.reason,distinct_days:old.distinct_days,checked_at:old.checked_at}:null};
    });
    return {mode:'simulation',sending_enabled:false,crm_writes_enabled:false,now:source.now,rule:source.rule,paused:source.paused,
      counts:{eligible:rows.filter(r=>r.eligible).length,excluded:rows.filter(r=>!r.eligible).length,candidates:candidates.length},
      rows:rows.slice(offset,offset+50),total:rows.length,offset,limit:50,
      runs:(await db.query('SELECT * FROM buyer_brand_interest_runs ORDER BY created_at DESC,id DESC LIMIT 10')).rows};
  },true);
}
async function exportBrandInterest(pool,buyerId) {
  const result={};
  for(const [key,sql] of Object.entries({preference:'SELECT * FROM buyer_interest_preferences WHERE buyer_id=$1',
    preference_history:'SELECT * FROM buyer_interest_preference_events WHERE buyer_id=$1 ORDER BY version',
    observations:'SELECT * FROM buyer_brand_interest_days WHERE buyer_id=$1 ORDER BY observed_at',
    candidates:'SELECT * FROM buyer_brand_interest_candidates WHERE buyer_id=$1',
    checks:'SELECT h.* FROM buyer_brand_interest_checks h JOIN buyer_brand_interest_candidates c ON c.id=h.candidate_id WHERE c.buyer_id=$1 ORDER BY h.checked_at'}))result[key]=(await pool.query(sql,[buyerId])).rows;
  return result;
}
async function pruneBrandInterest(pool){return transaction(pool,async db=>{if((await db.query(LOCK)).rows[0].acquired)await prune(db);});}
function registerBrandInterest({app,pool,ownerAuth,buyerAuth,audit}) {
  const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(error){if(!error.status)console.error('[brand-interest]',error.code||'failed');res.status(error.status||503).json({code:error.status?error.code:'interest_unavailable'});}};
  app.get('/api/portal/interest-preferences',buyerAuth,wrap(async(req,res)=>res.json(await preference(pool,req.session.buyerPortal.id))));
  app.put('/api/portal/interest-preferences',buyerAuth,wrap(async(req,res)=>res.json(await savePreference(pool,req.session.buyerPortal.id,req.body))));
  const limiter=rateLimit({windowMs:60000,limit:60,keyGenerator:req=>req.session.buyerPortal.id,standardHeaders:'draft-7',legacyHeaders:false});
  app.post('/api/portal/brand-interest',buyerAuth,limiter,wrap(async(req,res)=>res.json(await recordBrandDay(pool,req.session.buyerPortal.id,req.body))));
  app.get('/api/admin/buyer-engagement/brand-interest',ownerAuth,wrap(async(req,res)=>res.json(await getBrandInterest(pool,req.query))));
  app.post('/api/admin/buyer-engagement/brand-interest/runs',ownerAuth,wrap(async(req,res)=>{const result=await runBrandInterest(pool,req.body);if(!result.replayed)audit(req,'brand_interest_simulation','engagement_brand_run',result.run.id,result.run.kind);res.json(result);}));
}
module.exports={NOTICE_VERSION,preference,savePreference,recordBrandDay,decision,runBrandInterest,getBrandInterest,exportBrandInterest,pruneBrandInterest,registerBrandInterest};
