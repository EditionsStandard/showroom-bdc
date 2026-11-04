'use strict';
const {createHash}=require('node:crypto'),{createReader}=require('./buyer-engagement-crm-reader');
const {transaction,detail,lockCandidate}=require('./buyer-engagement-reviews').reviewStorage;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const GLOBAL_LOCK="SELECT pg_advisory_xact_lock(hashtext('buyer-engagement:crm-check-start:v1'))";
async function snapshot(db,id){
 const review=await detail(db,id),local=(await db.query(`SELECT b.email,b.name,br.name AS brand_name FROM buyer_brand_interest_candidates c JOIN buyers b ON b.id=c.buyer_id JOIN brands br ON br.id=c.brand_id WHERE c.id=$1`,[id])).rows[0];
 if(!local)throw fail(404,'review_source_missing');const latest=(await db.query('SELECT request_key FROM buyer_brand_crm_checks WHERE candidate_id=$1 ORDER BY created_at DESC,request_key LIMIT 1',[id])).rows[0];return {review,local,identity_hash:hash(local),latest_key:latest?.request_key};
}
function decorate(row,s){const age=Date.now()-new Date(row.finished_at).getTime();const current=!!s&&row.request_key===s.latest_key&&row.status==='completed'&&row.review_version===(s.review.review?.version||0)&&row.source_token===s.review.source.source_token&&row.identity_hash===s.identity_hash&&JSON.stringify(row.links)===JSON.stringify(s.review.review?.links||{})&&age>=0&&age<=3600000;
 return {...row,current,identity_verified:false,season_verified:false,ready_to_transfer:false};}
async function listChecks(pool,candidateId,reader=createReader()){
 if(!uuid(candidateId))throw fail(400,'invalid_review_source');return transaction(pool,async db=>{const s=await snapshot(db,candidateId),rows=(await db.query('SELECT * FROM buyer_brand_crm_checks WHERE candidate_id=$1 ORDER BY created_at DESC,request_key LIMIT 5',[candidateId])).rows;
 return {mode:'read_only_crm_checks',reader_available:reader.available,crm_writes_enabled:false,identity_verified:false,ready_to_transfer:false,checks:rows.map(r=>decorate(r,s))};},true);
}
async function receipt(pool,key){
 if(!uuid(key))throw fail(400,'invalid_crm_check');return transaction(pool,async db=>{const row=(await db.query('SELECT * FROM buyer_brand_crm_checks WHERE request_key=$1',[key])).rows[0];if(!row)return {found:false};return {found:true,operation:decorate(row,await snapshot(db,row.candidate_id))};},true);
}
async function startCheck(pool,candidateId,body,actor='legacy_owner',reader=createReader()){
 if(!uuid(candidateId)||!body||!uuid(body.request_key)||!Number.isInteger(body.review_version)||body.review_version<1||!/^[a-f0-9]{64}$/.test(body.source_token||''))throw fail(400,'invalid_crm_check');
 const started=await transaction(pool,async db=>{
  await db.query(GLOBAL_LOCK);await lockCandidate(db,candidateId);const s=await snapshot(db,candidateId);
  const prior=(await db.query('SELECT * FROM buyer_brand_crm_checks WHERE request_key=$1',[body.request_key])).rows[0];
  if(prior){if(prior.candidate_id!==candidateId)throw fail(409,'crm_check_key_reused');if(prior.status==='cancelled')throw fail(409,'crm_check_cancelled');if(prior.review_version!==body.review_version||prior.source_token!==body.source_token)throw fail(409,'crm_check_key_reused');return {existing:true,operation:decorate(prior,s)};}
  if(!reader.available)throw fail(503,'crm_reader_unavailable');
  if(s.review.review?.version!==body.review_version||s.review.source.source_token!==body.source_token||!s.review.review_state.current||!s.review.source.live.eligible)throw fail(409,'crm_check_source_changed');
  const links=s.review.review.links;for(const key of ['store','buyer','brand','season'])if(!/^rec[A-Za-z0-9]{14}$/.test(links[key]||''))throw fail(400,'crm_links_incomplete');
  if((await db.query('SELECT COUNT(*)::int AS n FROM buyer_brand_crm_checks WHERE candidate_id=$1',[candidateId])).rows[0].n>=50)throw fail(422,'crm_check_history_limit');
  if((await db.query("SELECT 1 FROM buyer_brand_crm_checks WHERE status='running' AND created_at>NOW()-INTERVAL '2 minutes' LIMIT 1")).rowCount)throw fail(409,'crm_check_busy');
  const operation=(await db.query(`INSERT INTO buyer_brand_crm_checks(request_key,candidate_id,status,review_version,source_token,identity_hash,links,requested_by) VALUES($1,$2,'running',$3,$4,$5,$6,$7) RETURNING *`,[body.request_key,candidateId,body.review_version,body.source_token,s.identity_hash,JSON.stringify(links),actor])).rows[0];return {operation,local:s.local};
 });
 if(started.existing)return {operation:started.operation,replayed:true};
 let result,errorCode;try{result=await reader.inspect(started.operation.links,started.local);}catch(e){errorCode=['crm_rate_limited','crm_read_forbidden','crm_read_unavailable','crm_read_timeout','crm_response_invalid','crm_schema_invalid','crm_schema_changed','crm_reader_unavailable'].includes(e.code)?e.code:'crm_read_unavailable';}
 return transaction(pool,async db=>{
  await lockCandidate(db,candidateId);const row=(await db.query('SELECT *,created_at<NOW()-INTERVAL \'2 minutes\' AS expired FROM buyer_brand_crm_checks WHERE request_key=$1 FOR UPDATE',[body.request_key])).rows[0];if(!row)throw fail(404,'review_source_missing');const s=await snapshot(db,candidateId);
  if(row.status!=='running')return {operation:decorate(row,s),replayed:true};
  if(row.expired)errorCode='crm_check_expired';else if(row.review_version!==s.review.review?.version||row.source_token!==s.review.source.source_token||row.identity_hash!==s.identity_hash||JSON.stringify(row.links)!==JSON.stringify(s.review.review?.links||{})||!s.review.source.live.eligible)errorCode='crm_check_source_changed';
  const saved=(await db.query("UPDATE buyer_brand_crm_checks SET status=$2,result=$3,error_code=$4,finished_at=NOW() WHERE request_key=$1 RETURNING *",[body.request_key,errorCode?'failed':'completed',errorCode?null:JSON.stringify(result),errorCode||null])).rows[0];return {operation:decorate(saved,s),replayed:false};
 });
}
async function cancelCheck(pool,candidateId,key,actor='legacy_owner'){
 if(!uuid(candidateId)||!uuid(key))throw fail(400,'invalid_crm_check');return transaction(pool,async db=>{
  await db.query(GLOBAL_LOCK);await lockCandidate(db,candidateId,false);const prior=(await db.query('SELECT * FROM buyer_brand_crm_checks WHERE request_key=$1 FOR UPDATE',[key])).rows[0];
  if(prior&&prior.candidate_id!==candidateId)throw fail(409,'crm_check_key_reused');
  if(prior&&prior.status!=='running')return {operation:decorate(prior,await snapshot(db,candidateId))};
  if(prior){const row=(await db.query("UPDATE buyer_brand_crm_checks SET status='cancelled',finished_at=NOW(),result=NULL WHERE request_key=$1 RETURNING *",[key])).rows[0];return {operation:decorate(row,null)};}
  if((await db.query('SELECT COUNT(*)::int AS n FROM buyer_brand_crm_checks WHERE candidate_id=$1',[candidateId])).rows[0].n>=50)throw fail(422,'crm_check_history_limit');
  return {operation:decorate((await db.query("INSERT INTO buyer_brand_crm_checks(request_key,candidate_id,status,requested_by,finished_at) VALUES($1,$2,'cancelled',$3,NOW()) RETURNING *",[key,candidateId,actor])).rows[0],null)};
 });
}
function registerCRMChecks({app,pool,ownerAuth,audit}){
 const base='/api/admin/buyer-engagement/reviews',reader=createReader(),wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(e){if(!e.status)console.error('[engagement-crm-check]',e.code||'failed');res.status(e.status||503).json({code:e.status?e.code:'crm_check_unavailable'});}};
 app.get(base+'/crm-operations/:key',ownerAuth,wrap(async(req,res)=>res.json(await receipt(pool,req.params.key))));
 app.post(base+'/crm-operations/:key/cancel',ownerAuth,wrap(async(req,res)=>res.json(await cancelCheck(pool,req.body?.candidate_id,req.params.key,req.session.staffUser?.id||'legacy_owner'))));
 app.get(base+'/:id/crm-checks',ownerAuth,wrap(async(req,res)=>res.json(await listChecks(pool,req.params.id,reader))));
 app.post(base+'/:id/crm-checks',ownerAuth,wrap(async(req,res)=>{const r=await startCheck(pool,req.params.id,req.body,req.session.staffUser?.id||'legacy_owner',reader);if(!r.replayed)audit(req,'brand_crm_read_check','engagement_crm_check',r.operation.request_key,r.operation.status);res.json(r);}));
}
module.exports={startCheck,listChecks,receipt,cancelCheck,registerCRMChecks};
