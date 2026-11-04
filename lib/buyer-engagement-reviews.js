'use strict';
// Local review and hypothetical CRM payloads only. No remote client or sender.
const {randomUUID,createHash}=require('node:crypto');
const {reviewContexts}=require('./buyer-brand-interest');
const contract=require('../docs/buyer-engagement-airtable-contract.json');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const recordId=v=>typeof v==='string'&&/^rec[A-Za-z0-9]{14}$/.test(v);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const LINK_KEYS=['store','buyer','brand','season'];
async function transaction(pool,fn,readOnly=false) {
  const db=await pool.connect();try{
    await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='20s'");
    const result=await fn(db);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
function checked(body={}) {
  if(!body||typeof body!=='object'||!uuid(body.request_key)||!Number.isInteger(body.version)||body.version<0||!['review','qualified','dismissed'].includes(body.decision)||typeof body.note!=='string'||body.note.length>2000||typeof body.source_token!=='string'||!/^[a-f0-9]{64}$/.test(body.source_token)||typeof body.ack_evidence!=='boolean')throw fail(400,'invalid_review');
  if(!body.links||typeof body.links!=='object'||Array.isArray(body.links)||Object.keys(body.links).some(k=>!LINK_KEYS.includes(k)))throw fail(400,'invalid_review_links');
  const links={};for(const key of LINK_KEYS){const value=body.links[key];if(value!==undefined&&value!==''){if(!recordId(value))throw fail(400,'invalid_review_links');links[key]=value;}}
  const note=body.note.trim();if(body.decision!=='review'&&!note)throw fail(400,'review_reason_required');
  if(body.decision==='qualified'&&!body.ack_evidence)throw fail(400,'review_ack_required');
  return {request_key:body.request_key,version:body.version,decision:body.decision,note,links,source_token:body.source_token,ack_evidence:body.ack_evidence};
}
async function context(db,candidateId){const found=(await reviewContexts(db,candidateId))[0];if(!found)throw fail(404,'review_source_missing');return {...found,source_token:digest(found.evidence)};}
function state(source,review) {
  const current=!!review&&review.evidence_hash===source.source_token;
  return {reviewed:!!review,current,qualified:!!review&&review.decision==='qualified'&&current&&source.live.eligible,
    label:!review?'review':!current?'stale':review.decision};
}
function previews(source,review,reviewState) {
  const links=review?.links||{},common=['destination_not_confirmed','crm_links_unverified','remote_duplicate_check_missing','integration_key_missing','external_side_effects_unverified','transfer_not_implemented'];
  if(!reviewState.qualified)common.push(review?.decision==='qualified'&&!reviewState.current?'qualification_stale':'qualification_required');
  if(!source.live.eligible)common.push('signal_ineligible');
  for(const key of LINK_KEYS)if(!links[key])common.push(key+'_link_missing');
  return Object.entries(contract.destinations).map(([key,destination])=>{
    const fields={},set=(name,value)=>{if(destination.fields[name]&&value!==undefined)fields[destination.fields[name].id]=value;};
    set('Opportunity Name',('Signal B2B — '+(source.buyer_name||source.buyer_id)+' / '+(source.brand_name||source.brand_id)).slice(0,200));
    for(const [link,names] of Object.entries({store:['Store name','Store'],buyer:['Buyer Name','Buyer'],brand:['Brand'],season:['Season']}))for(const name of names)if(links[link])set(name,[links[link]]);
    const note=`Signal de navigation à qualifier : ${source.evidence.distinct_days} jours UTC observés dans une fenêtre de ${source.evidence.window_hours} heures. Source locale : ${source.candidate_id}. Aucune intention d’achat, valeur ou probabilité déduite.`;
    set(key==='opportunities'?'Notes':'Internal Notes',note);
    if(key==='ss27_pipeline'&&reviewState.qualified){set('Pipeline Status','To qualify');set('Source','Online showroom');}
    return {destination:key,base_id:contract.base_id,table_id:destination.table_id,hypothetical:true,ready_to_transfer:false,
      blocking_reasons:[...common,...(key==='opportunities'?['initial_crm_status_unconfirmed']:['ss27_scope_unconfirmed'])],fields};
  });
}
async function detail(db,candidateId) {
  const source=await context(db,candidateId),review=(await db.query('SELECT * FROM buyer_brand_reviews WHERE candidate_id=$1',[candidateId])).rows[0]||null;
  const reviewState=state(source,review),history=review?(await db.query('SELECT * FROM buyer_brand_review_events WHERE review_id=$1 ORDER BY version DESC LIMIT 10',[review.id])).rows:[];
  return {mode:'local_review',sending_enabled:false,crm_writes_enabled:false,source,review,review_state:reviewState,history,
    previews:previews(source,review,reviewState),schema_verified_on:contract.verified_on,mapping_verification:'not_verified'};
}
async function listReviews(pool,{offset=0}={}) {
  offset=Math.max(0,Math.min(1000000,Number.parseInt(offset)||0));
  return transaction(pool,async db=>{
    const contexts=await reviewContexts(db),reviews=(await db.query('SELECT candidate_id,decision,evidence_hash,version,updated_at FROM buyer_brand_reviews')).rows;
    const map=new Map(reviews.map(r=>[r.candidate_id,r]));
    const rows=contexts.map(c=>{const source={...c,source_token:digest(c.evidence)},review=map.get(c.candidate_id);return {...source,review_state:state(source,review),review_version:review?.version||0};});
    return {mode:'local_review',sending_enabled:false,crm_writes_enabled:false,total:rows.length,offset,limit:50,rows:rows.slice(offset,offset+50),
      counts:{qualified:rows.filter(r=>r.review_state.qualified).length,stale:rows.filter(r=>r.review_state.label==='stale').length,dismissed:rows.filter(r=>r.review_state.label==='dismissed').length}};
  },true);
}
async function lockCandidate(db,candidateId,withRule=true) {
  const candidate=(await db.query('SELECT buyer_id FROM buyer_brand_interest_candidates WHERE id=$1',[candidateId])).rows[0];if(!candidate)throw fail(404,'review_source_missing');
  if(withRule)await db.query("SELECT r.id FROM buyer_engagement_rules r CROSS JOIN buyer_engagement_simulation_control c WHERE r.id='brand_interest' FOR SHARE OF r,c");
  if(!(await db.query('SELECT id FROM buyers WHERE id=$1 FOR UPDATE',[candidate.buyer_id])).rowCount)throw fail(404,'review_source_missing');
  if(!(await db.query('SELECT id FROM buyer_brand_interest_candidates WHERE id=$1 FOR UPDATE',[candidateId])).rowCount)throw fail(404,'review_source_missing');
}
async function saveReview(pool,candidateId,body,actor='legacy_owner') {
  if(!uuid(candidateId))throw fail(400,'invalid_review_source');const value=checked(body),bodyHash=digest({candidate_id:candidateId,...value});
  return transaction(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('brand-review-op:'||$1))",[value.request_key]);await lockCandidate(db,candidateId);
    const old=(await db.query('SELECT * FROM buyer_brand_review_operations WHERE request_key=$1',[value.request_key])).rows[0];
    if(old){if(old.candidate_id!==candidateId)throw fail(409,'review_key_reused');if(old.status==='cancelled')throw fail(409,'review_operation_cancelled');if(old.body_hash!==bodyHash)throw fail(409,'review_key_reused');return {operation:old,replayed:true,detail:await detail(db,candidateId)};}
    const source=await context(db,candidateId);if(source.source_token!==value.source_token)throw fail(409,'review_evidence_changed');
    if(source.live.reason==='candidate_expired')throw fail(409,'review_source_expired');
    if(value.decision==='qualified'&&!source.live.eligible)throw fail(409,'review_signal_ineligible');
    const current=(await db.query('SELECT * FROM buyer_brand_reviews WHERE candidate_id=$1 FOR UPDATE',[candidateId])).rows[0];
    if((current?.version||0)!==value.version)throw fail(409,'review_version_conflict');
    if((current?.version||0)>=100||(await db.query('SELECT COUNT(*)::int AS n FROM buyer_brand_review_operations WHERE candidate_id=$1',[candidateId])).rows[0].n>=500)throw fail(422,'review_history_limit');
    const review=(await db.query(`INSERT INTO buyer_brand_reviews(id,candidate_id,version,decision,note,links,evidence,evidence_hash,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(candidate_id) DO UPDATE SET version=EXCLUDED.version,decision=EXCLUDED.decision,note=EXCLUDED.note,
      links=EXCLUDED.links,evidence=EXCLUDED.evidence,evidence_hash=EXCLUDED.evidence_hash,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING *`,
      [current?.id||randomUUID(),candidateId,value.version+1,value.decision,value.note,JSON.stringify(value.links),JSON.stringify(source.evidence),source.source_token,actor])).rows[0];
    await db.query(`INSERT INTO buyer_brand_review_events(review_id,version,decision,note,links,evidence,evidence_hash,reviewed_by)
      SELECT id,version,decision,note,links,evidence,evidence_hash,updated_by FROM buyer_brand_reviews WHERE id=$1`,[review.id]);
    const operation=(await db.query("INSERT INTO buyer_brand_review_operations(request_key,candidate_id,status,body_hash,review_version) VALUES($1,$2,'saved',$3,$4) RETURNING *",[value.request_key,candidateId,bodyHash,review.version])).rows[0];
    return {operation,replayed:false,detail:await detail(db,candidateId)};
  });
}
async function cancelReviewOperation(pool,candidateId,requestKey) {
  if(!uuid(candidateId)||!uuid(requestKey))throw fail(400,'invalid_review_operation');
  return transaction(pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('brand-review-op:'||$1))",[requestKey]);await lockCandidate(db,candidateId,false);
    const old=(await db.query('SELECT * FROM buyer_brand_review_operations WHERE request_key=$1',[requestKey])).rows[0];
    if(old){if(old.candidate_id!==candidateId)throw fail(409,'review_key_reused');return {operation:old};}
    if((await db.query('SELECT COUNT(*)::int AS n FROM buyer_brand_review_operations WHERE candidate_id=$1',[candidateId])).rows[0].n>=500)throw fail(422,'review_history_limit');
    return {operation:(await db.query("INSERT INTO buyer_brand_review_operations(request_key,candidate_id,status) VALUES($1,$2,'cancelled') RETURNING *",[requestKey,candidateId])).rows[0]};
  });
}
async function operationReceipt(pool,key) {
  if(!uuid(key))throw fail(400,'invalid_review_operation');
  return transaction(pool,async db=>{
    const operation=(await db.query('SELECT * FROM buyer_brand_review_operations WHERE request_key=$1',[key])).rows[0];
    return operation?{found:true,operation,detail:await detail(db,operation.candidate_id)}:{found:false};
  },true);
}
async function exportReviews(pool,buyerId) {
  const result={};for(const [key,sql] of Object.entries({reviews:'SELECT r.* FROM buyer_brand_reviews r JOIN buyer_brand_interest_candidates c ON c.id=r.candidate_id WHERE c.buyer_id=$1',
    history:'SELECT e.* FROM buyer_brand_review_events e JOIN buyer_brand_reviews r ON r.id=e.review_id JOIN buyer_brand_interest_candidates c ON c.id=r.candidate_id WHERE c.buyer_id=$1 ORDER BY e.created_at',
    operations:'SELECT o.* FROM buyer_brand_review_operations o JOIN buyer_brand_interest_candidates c ON c.id=o.candidate_id WHERE c.buyer_id=$1'}))result[key]=(await pool.query(sql,[buyerId])).rows;return result;
}
function registerReviews({app,pool,ownerAuth,audit}) {
  const base='/api/admin/buyer-engagement/reviews';
  const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(error){if(!error.status)console.error('[engagement-review]',error.code||'failed');res.status(error.status||503).json({code:error.status?error.code:'review_unavailable'});}};
  app.get(base,ownerAuth,wrap(async(req,res)=>res.json(await listReviews(pool,req.query))));
  app.get(base+'/operations/:key',ownerAuth,wrap(async(req,res)=>res.json(await operationReceipt(pool,req.params.key))));
  app.post(base+'/operations/:key/cancel',ownerAuth,wrap(async(req,res)=>res.json(await cancelReviewOperation(pool,req.body?.candidate_id,req.params.key))));
  app.get(base+'/:id',ownerAuth,wrap(async(req,res)=>{if(!uuid(req.params.id))throw fail(400,'invalid_review_source');res.json(await transaction(pool,db=>detail(db,req.params.id),true));}));
  app.put(base+'/:id',ownerAuth,wrap(async(req,res)=>{const result=await saveReview(pool,req.params.id,req.body,req.session.staffUser?.id||'legacy_owner');if(!result.replayed)audit(req,'brand_review_saved','engagement_review',req.params.id,result.operation.review_version);res.json(result);}));
}
module.exports={listReviews,saveReview,cancelReviewOperation,operationReceipt,exportReviews,registerReviews};
