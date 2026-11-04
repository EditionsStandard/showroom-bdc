'use strict';
// Transport protocol with an injected local fixture only. No provider SDK, key,
// HTTP adapter, dispatch route or scheduler. SQL forbids delivery_enabled=true.
const {randomUUID,createHash,randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {currentDecision}=require('./buyer-engagement-preparation'),{approvalFor}=require('./buyer-engagement-template-signoffs');
const {issueEmailLinks,frozenLinksValid}=require('./buyer-engagement-email-links');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const sourceFields=`id,email,name,lang,activation_pending,login_history_known,approved_at,first_login_at,last_login_at,last_meaningful_activity_at,last_seen_at,last_engagement_email_at,approved_at::text AS approval_anchor,last_meaningful_activity_at::text AS activity_anchor`;
const identity=b=>hash({email:b.email,name:b.name,lang:b.lang});
async function transaction(pool,fn,readOnly=false){const db=await pool.connect();try{await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='20s'");const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function event(db,row,type,reason){await db.query('INSERT INTO buyer_engagement_outbox_events(outbox_id,event,reason,attempt_no) VALUES($1,$2,$3,$4)',[row.id,type,reason,row.attempt_count||0]);}
async function policy(db,record,lock=true){
 const control=(await db.query('SELECT paused FROM buyer_engagement_simulation_control WHERE id=true'+(lock?' FOR SHARE':''))).rows[0];
 const rule=(await db.query('SELECT * FROM buyer_engagement_rules WHERE id=$1'+(lock?' FOR SHARE':''),[record.rule_id])).rows[0];
 const buyer=(await db.query('SELECT '+sourceFields+' FROM buyers WHERE id=$1'+(lock?' FOR UPDATE':''),[record.buyer_id])).rows[0];
 if(!buyer)return {eligible:false,reason:'buyer_missing'};
 buyer.email_status=(await db.query('SELECT status FROM buyer_email_preferences WHERE buyer_id=$1',[buyer.id])).rows[0]?.status||'unknown';
 if(await require('./buyer-engagement-provider').hasProviderBlock(db,buyer))return {eligible:false,reason:'provider_suppression'};
 const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
 if(!buyer.approved_at||+buyer.approved_at>+now||buyer.last_login_at&&+buyer.last_login_at>+now||buyer.last_meaningful_activity_at&&+buyer.last_meaningful_activity_at>+now)return {eligible:false,reason:'access_dates_invalid'};
 const template=(await db.query('SELECT * FROM buyer_engagement_templates WHERE rule_id=$1 AND lang=$2 ORDER BY version DESC LIMIT 1',[record.rule_id,buyer.lang==='en'?'en':'fr'])).rows[0];
 if(control.paused)return {eligible:false,reason:'simulation_paused'};
 const outcome=currentDecision(buyer,rule,template,record,now);if(!outcome.eligible)return outcome;
 const editorial=await approvalFor(db,record.rule_id,template.lang,template.version);if(!editorial.approved)return {eligible:false,reason:'editorial_approval_missing'};
 if(record.template_hash&&record.template_hash!==editorial.content_hash||record.signoff_revision&&record.signoff_revision!==editorial.signoff.revision)return {eligible:false,reason:'editorial_approval_changed'};
 if(record.identity_hash&&record.identity_hash!==identity(buyer))return {eligible:false,reason:'buyer_identity_changed'};
 if(buyer.last_engagement_email_at&&(await db.query("SELECT $1::timestamptz>NOW()-INTERVAL '24 hours' AS recent",[buyer.last_engagement_email_at])).rows[0].recent)return {eligible:false,reason:'recent_contact'};
 return {eligible:true,buyer,template,editorial};
}
async function op(db,key,kind,source){const previous=(await db.query('SELECT * FROM buyer_engagement_outbox_operations WHERE request_key=$1',[key])).rows[0];if(previous&&(previous.kind!==kind||previous.source_id!==(source||null)))throw fail(409,'outbox_key_reused');return previous;}
async function stageIntent(pool,body={}){
 if(!body||typeof body!=='object')throw fail(400,'invalid_outbox_request');const {request_key,preparation_job_id}=body;
 if(!uuid(request_key)||!uuid(preparation_job_id))throw fail(400,'invalid_outbox_request');return transaction(pool,async db=>{
  await db.query("SELECT pg_advisory_xact_lock(hashtext('outbox-op:'||$1))",[request_key]);const previous=await op(db,request_key,'stage',preparation_job_id);if(previous)return {operation:previous,replayed:true};
  const source=(await db.query('SELECT *,anchor_at::text AS anchor_key FROM buyer_engagement_preparation_jobs WHERE id=$1',[preparation_job_id])).rows[0];
  if(!source||source.status!=='simulated'||source.mode!=='dry_run')throw fail(409,'outbox_source_not_validated');
  const p=await policy(db,source);if(!p.eligible)throw fail(409,p.reason);
  const still=(await db.query("SELECT 1 FROM buyer_engagement_preparation_jobs WHERE id=$1 AND status='simulated' AND created_at>=NOW()-INTERVAL '90 days' FOR SHARE",[preparation_job_id])).rowCount;if(!still)throw fail(409,'outbox_source_expired');
  const known=(await db.query('SELECT id FROM buyer_engagement_outbox WHERE buyer_id=$1 AND rule_id=$2 AND anchor_at=$3',[source.buyer_id,source.rule_id,source.anchor_key])).rows[0];
  if(!known&&(await db.query("SELECT COUNT(*)::int AS n FROM buyer_engagement_outbox")).rows[0].n>=1000)throw fail(422,'outbox_cohort_limit');
  const id=randomUUID(),row=(await db.query(`INSERT INTO buyer_engagement_outbox(id,buyer_id,preparation_job_id,rule_id,anchor_at,rule_version,delay_hours,template_lang,template_version,template_hash,signoff_revision,activation_pending_snapshot,identity_hash,provider_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(buyer_id,rule_id,scope_key,anchor_at) DO NOTHING RETURNING *`,[id,source.buyer_id,source.id,source.rule_id,source.anchor_key,source.rule_version,source.delay_hours,source.template_lang,source.template_version,p.editorial.content_hash,p.editorial.signoff.revision,source.activation_pending_snapshot,identity(p.buyer),'engagement/'+id])).rows[0];
  const existing=row||(await db.query('SELECT * FROM buyer_engagement_outbox WHERE buyer_id=$1 AND rule_id=$2 AND anchor_at=$3',[source.buyer_id,source.rule_id,source.anchor_key])).rows[0];if(row)await event(db,row,'staged','staged');
  const operation=(await db.query("INSERT INTO buyer_engagement_outbox_operations(request_key,kind,source_id,outbox_id,result) VALUES($1,'stage',$2,$3,$4) RETURNING *",[request_key,preparation_job_id,existing.id,JSON.stringify({created:!!row})])).rows[0];return {operation,replayed:false};
 });
}
async function recoverInside(db){
 const rows=(await db.query("SELECT * FROM buyer_engagement_outbox WHERE status IN ('reserved','submitting') AND lease_expires_at<=clock_timestamp() ORDER BY lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED")).rows;
 const counts={released:0,uncertain:0,redacted:0};for(const row of rows){const uncertain=!!row.first_attempt_at,status=uncertain?'uncertain':'staged';
  await db.query("UPDATE buyer_engagement_outbox SET status=$2,reason='lease_expired',needs_attention=needs_attention OR (attempt_count>=3),next_attempt_at=CASE WHEN first_attempt_at IS NULL THEN next_attempt_at ELSE GREATEST(next_attempt_at,NOW()+INTERVAL '60 seconds') END,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1",[row.id,status]);
  if(uncertain)await db.query("UPDATE buyer_engagement_outbox_attempts SET status='uncertain',reason='lease_expired',finished_at=COALESCE(finished_at,NOW()) WHERE outbox_id=$1 AND status='submitting'",[row.id]);await event(db,row,'lease_recovered','lease_expired');counts[uncertain?'uncertain':'released']++;
 }
 const old=(await db.query("SELECT * FROM buyer_engagement_outbox WHERE sealed_payload IS NOT NULL AND first_attempt_at<NOW()-INTERVAL '24 hours' ORDER BY first_attempt_at,id LIMIT 100 FOR UPDATE SKIP LOCKED")).rows;
 for(const row of old){await db.query("UPDATE buyer_engagement_outbox SET sealed_payload=NULL,needs_attention=true,reason='replay_window_expired',updated_at=NOW() WHERE id=$1",[row.id]);await event(db,row,'payload_redacted','replay_window_expired');counts.redacted++;}
 return counts;
}
async function recoverOutbox(pool,body={}){const request_key=body?.request_key;if(!uuid(request_key))throw fail(400,'invalid_outbox_request');return transaction(pool,async db=>{await db.query("SELECT pg_advisory_xact_lock(hashtext('outbox-op:'||$1))",[request_key]);const previous=await op(db,request_key,'recover');if(previous)return {operation:previous,replayed:true};const result=await recoverInside(db);return {operation:(await db.query("INSERT INTO buyer_engagement_outbox_operations(request_key,kind,result) VALUES($1,'recover',$2) RETURNING *",[request_key,JSON.stringify(result)])).rows[0],replayed:false};});}
async function claimNext(pool){return transaction(pool,async db=>{const control=(await db.query('SELECT * FROM buyer_engagement_outbox_control WHERE id=true FOR SHARE')).rows[0];if(control.paused)throw fail(409,'outbox_paused');await recoverInside(db);
 const row=(await db.query(`SELECT * FROM buyer_engagement_outbox WHERE status IN ('staged','uncertain') AND NOT needs_attention AND attempt_count<3 AND next_attempt_at<=NOW()
  AND created_at>=NOW()-INTERVAL '90 days' AND (first_attempt_at IS NULL OR (first_attempt_at<=NOW() AND first_attempt_at>NOW()-INTERVAL '23 hours')) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];if(!row)return null;
 const token=randomUUID();const claimed=(await db.query("UPDATE buyer_engagement_outbox SET status='reserved',reason='reserved',lease_token=$2,lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',updated_at=NOW() WHERE id=$1 RETURNING *",[row.id,token])).rows[0];await event(db,claimed,'reserved','reserved');return {id:row.id,lease_token:token};});}
function cryptoKey(key){if(!Buffer.isBuffer(key)||key.length!==32)throw fail(400,'outbox_key_required');return key;}
function seal(payload,key,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));const data=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
function open(payload,key,aad){const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(payload.iv,'base64'));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(Buffer.from(payload.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data,'base64')),decipher.final()]).toString('utf8'));}
async function authorizeRehearsal(pool,claim,key,{origin='https://example.test'}={}){cryptoKey(key);if(!uuid(claim?.id)||!uuid(claim?.lease_token))throw fail(400,'invalid_outbox_claim');return transaction(pool,async db=>{
 const source=(await db.query('SELECT *,anchor_at::text AS anchor_key FROM buyer_engagement_outbox WHERE id=$1',[claim.id])).rows[0];if(!source)return {stale:true};
 const control=(await db.query('SELECT * FROM buyer_engagement_outbox_control WHERE id=true FOR SHARE')).rows[0];const p=await policy(db,source);
 const row=(await db.query('SELECT *,lease_expires_at>clock_timestamp() AS lease_valid,first_attempt_at>NOW()-INTERVAL \'23 hours\' AND first_attempt_at<=NOW() AS replay_valid FROM buyer_engagement_outbox WHERE id=$1 FOR UPDATE',[source.id])).rows[0];if(row.status!=='reserved'||row.lease_token!==claim.lease_token||!row.lease_valid)return {stale:true};
 let reason=control.paused?'outbox_paused':!p.eligible?p.reason:null;
 if(!reason&&(!/^[^\s@]+@[^\s@]+\.(test|invalid)$/i.test(p.buyer.email)||row.mode!=='isolated_transport'))reason='fixture_recipient_required';
 if(!reason&&row.first_attempt_at&&!row.replay_valid)reason='replay_window_expired';if(!reason&&row.attempt_count>=3)reason='attempt_limit';
 if(!reason&&(await db.query("SELECT 1 FROM buyer_engagement_outbox WHERE buyer_id=$1 AND id<>$2 AND first_attempt_at>NOW()-INTERVAL '24 hours' AND status<>'rejected' LIMIT 1",[row.buyer_id,row.id])).rowCount)reason='contact_limit';
 let payload,messageHash=row.message_hash,sealed=row.sealed_payload;
 if(!reason&&row.first_attempt_at){const links=await frozenLinksValid(db,row,p.buyer);if(!links.valid)reason=links.reason;
  if(!reason)try{if(!sealed)throw Error('missing');payload=open(sealed,key,row.id+':'+messageHash);if(hash(payload)!==messageHash||payload.to[0]!==p.buyer.email)throw Error('changed');}catch{reason='payload_unavailable';}}
 // Token issuance, sealing and attempt insertion share one transaction. An
 // issuance/encryption error must roll everything back, never commit orphan links.
 if(!reason&&!row.first_attempt_at){const links=await issueEmailLinks(db,row,p.buyer,origin,{fixture:true});
  const render=s=>s.replace(/{{\s*(buyer_name|portal_url)\s*}}/g,(_,v)=>v==='buyer_name'?(p.buyer.name||''):links.portal_url);
  payload={from:'no-reply@example.test',to:[p.buyer.email],subject:render(p.template.subject).replace(/[\r\n]/g,' '),text:render(p.template.body)+'\n\n'+(p.buyer.lang==='en'?'Unsubscribe from commercial emails: ':'Ne plus recevoir de communications commerciales : ')+links.unsubscribe_url+'\n\n[ISOLATED TRANSPORT FIXTURE]',headers:links.headers};messageHash=hash(payload);sealed=seal(payload,key,row.id+':'+messageHash);}
 if(reason){const status=row.first_attempt_at?'uncertain':'cancelled';await db.query('UPDATE buyer_engagement_outbox SET status=$2,reason=$3,needs_attention=$4,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1',[row.id,status,reason,!!row.first_attempt_at]);await event(db,row,'blocked',reason);return {blocked:true,reason};}
 const updated=(await db.query(`UPDATE buyer_engagement_outbox SET status='submitting',reason='authorized_fixture',lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,clock_timestamp()),message_hash=$3,sealed_payload=$4,updated_at=NOW()
  WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() RETURNING *`,[row.id,claim.lease_token,messageHash,JSON.stringify(sealed)])).rows[0];if(!updated)throw fail(409,'outbox_lease_expired');
 const attempt=(await db.query('INSERT INTO buyer_engagement_outbox_attempts(id,outbox_id,attempt_no,lease_token,message_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),row.id,updated.attempt_count,claim.lease_token,messageHash])).rows[0];await event(db,updated,'submission_authorized','authorized_fixture');return {attempt,payload,provider_key:row.provider_key};
 });}
async function recordOutcome(pool,attempt,outcome){return transaction(pool,async db=>{
 const source=(await db.query('SELECT buyer_id FROM buyer_engagement_outbox WHERE id=$1',[attempt.outbox_id])).rows[0];if(!source)return {gone:true};await db.query('SELECT id FROM buyers WHERE id=$1 FOR UPDATE',[source.buyer_id]);const row=(await db.query('SELECT * FROM buyer_engagement_outbox WHERE id=$1 FOR UPDATE',[attempt.outbox_id])).rows[0];if(!row)return {gone:true};
 const old=(await db.query('SELECT * FROM buyer_engagement_outbox_attempts WHERE id=$1 AND outbox_id=$2 FOR UPDATE',[attempt.id,row.id])).rows[0];if(!old||old.message_hash!==row.message_hash)return {stale:true};
 const accepted=outcome?.outcome==='accepted'&&uuid(outcome.provider_id),rejected=outcome?.outcome==='rejected';let status=accepted?'accepted':rejected?'rejected':'uncertain';
 if(old.status==='accepted')return {status:row.status};if(old.status==='rejected'&&status!=='accepted')return {status:row.status};
 await db.query('UPDATE buyer_engagement_outbox_attempts SET status=$2,provider_id=$3,reason=$4,finished_at=NOW() WHERE id=$1',[old.id,status,accepted?outcome.provider_id:null,accepted?'fixture_accepted':rejected?'fixture_rejected':'response_unconfirmed']);
 if(accepted){if(row.provider_id&&row.provider_id!==outcome.provider_id){await db.query("UPDATE buyer_engagement_outbox SET needs_attention=true,reason='provider_id_conflict',updated_at=NOW() WHERE id=$1",[row.id]);await event(db,row,'attention','provider_id_conflict');return {status:row.status,attention:true};}
  await require('./buyer-engagement-provider').bindAcceptedFixture(db,row,outcome.provider_id);
  await db.query("UPDATE buyer_engagement_outbox SET status='accepted',provider_id=$2,sealed_payload=NULL,needs_attention=(reason IN ('provider_id_conflict','provider_delivery_problem','provider_suppression')),reason=CASE WHEN reason IN ('provider_id_conflict','provider_delivery_problem','provider_suppression') THEN reason ELSE 'fixture_accepted' END,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1",[row.id,outcome.provider_id]);await event(db,row,'accepted','fixture_accepted');return {status:'accepted'};}
 if(row.status==='accepted')return {status:'accepted'};
 const uncertainAttempts=(await db.query("SELECT COUNT(*)::int AS n FROM buyer_engagement_outbox_attempts WHERE outbox_id=$1 AND status IN ('submitting','uncertain')",[row.id])).rows[0].n;
 const allRejected=rejected&&uncertainAttempts===0;
 if(allRejected||row.attempt_count===old.attempt_no&&(rejected||row.lease_token===old.lease_token&&row.status==='submitting')){
  const finalStatus=allRejected?'rejected':'uncertain',reason=rejected&&!allRejected?'rejection_after_uncertainty':allRejected?'fixture_rejected':'response_unconfirmed';
  await db.query(`UPDATE buyer_engagement_outbox SET status=$2,reason=$3,sealed_payload=CASE WHEN $2='rejected' THEN NULL ELSE sealed_payload END,needs_attention=($2='uncertain' AND (attempt_count>=3 OR $3='rejection_after_uncertainty')),
   lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NOW()+make_interval(secs=>60*power(2,attempt_count-1)::int),updated_at=NOW() WHERE id=$1`,[row.id,finalStatus,reason]);await event(db,row,finalStatus,reason);}
 return {status:(await db.query('SELECT status FROM buyer_engagement_outbox WHERE id=$1',[row.id])).rows[0].status};
 });}
async function rehearseOne(pool,{transport,key,timeout_ms=10000,origin='https://example.test'}={}){
 if(transport?.kind!=='local_fixture'||typeof transport.submit!=='function'||!Number.isInteger(timeout_ms)||timeout_ms<1||timeout_ms>10000)throw fail(400,'fixture_transport_required');cryptoKey(key);const claim=await claimNext(pool);if(!claim)return {empty:true};const authorized=await authorizeRehearsal(pool,claim,key,{origin});if(!authorized.attempt)return authorized;
 const {attempt,payload,provider_key}=authorized,abort=new AbortController();let timer;
 const response=Promise.resolve().then(()=>transport.submit(payload,{idempotency_key:provider_key,signal:abort.signal})).catch(()=>({outcome:'uncertain'})).then(value=>recordOutcome(pool,attempt,value));
 // Keep late acceptance evidence, even if the caller already received a timeout.
 response.catch(()=>{});try{return await Promise.race([response,new Promise((resolve,reject)=>{timer=setTimeout(()=>{abort.abort();recordOutcome(pool,attempt,{outcome:'uncertain'}).then(resolve,reject);},timeout_ms);})]);}finally{clearTimeout(timer);}
}
async function listOutbox(pool,{offset=0}={}){offset=Math.max(0,Number.parseInt(offset)||0);return transaction(pool,async db=>{
 const control=(await db.query('SELECT * FROM buyer_engagement_outbox_control WHERE id=true')).rows[0];const rows=(await db.query(`SELECT o.id,o.buyer_id,b.name AS buyer_name,o.rule_id,o.status,o.reason,o.needs_attention,o.attempt_count,o.provider_id,o.first_attempt_at,o.created_at,o.updated_at,
 o.lease_expires_at IS NOT NULL AND o.lease_expires_at<=NOW() AS recovery_due,o.first_attempt_at IS NOT NULL AND o.first_attempt_at<NOW()-INTERVAL '23 hours' AND o.status='uncertain' AS replay_expired
 FROM buyer_engagement_outbox o JOIN buyers b ON b.id=o.buyer_id ORDER BY o.created_at DESC,o.id LIMIT 50 OFFSET $1`,[offset])).rows;
 const sources=(await db.query("SELECT j.id,j.rule_id,j.template_lang,j.template_version,b.name AS buyer_name FROM buyer_engagement_preparation_jobs j JOIN buyers b ON b.id=j.buyer_id WHERE j.status='simulated' ORDER BY j.created_at DESC,j.id LIMIT 50")).rows;
 const counts=(await db.query('SELECT status,COUNT(*)::int AS count FROM buyer_engagement_outbox GROUP BY status ORDER BY status')).rows;
 return {mode:'isolated_transport',sending_enabled:false,worker_available:false,control,rows,sources,counts,total:counts.reduce((n,r)=>n+r.count,0),offset,limit:50};},true);}
async function outboxReceipt(pool,key){if(!uuid(key))throw fail(400,'invalid_outbox_request');const row=(await pool.query('SELECT * FROM buyer_engagement_outbox_operations WHERE request_key=$1',[key])).rows[0];return row?{found:true,operation:row}:{found:false};}
async function exportOutbox(pool,buyerId){return {intents:(await pool.query('SELECT id,rule_id,scope_key,anchor_at,mode,status,reason,rule_version,delay_hours,template_lang,template_version,template_hash,signoff_revision,identity_hash,message_hash,first_attempt_at,attempt_count,provider_id,needs_attention,created_at,updated_at FROM buyer_engagement_outbox WHERE buyer_id=$1 ORDER BY created_at,id',[buyerId])).rows,
 attempts:(await pool.query('SELECT a.id,a.attempt_no,a.message_hash,a.status,a.provider_id,a.reason,a.authorized_at,a.finished_at FROM buyer_engagement_outbox_attempts a JOIN buyer_engagement_outbox o ON o.id=a.outbox_id WHERE o.buyer_id=$1 ORDER BY a.authorized_at,a.id',[buyerId])).rows,
 operations:(await pool.query('SELECT p.request_key,p.kind,p.source_id,p.outbox_id,p.result,p.created_at FROM buyer_engagement_outbox_operations p JOIN buyer_engagement_outbox o ON o.id=p.outbox_id WHERE o.buyer_id=$1 ORDER BY p.created_at,p.request_key',[buyerId])).rows,
 events:(await pool.query('SELECT e.* FROM buyer_engagement_outbox_events e JOIN buyer_engagement_outbox o ON o.id=e.outbox_id WHERE o.buyer_id=$1 ORDER BY e.id',[buyerId])).rows};}
function registerOutbox({app,pool,ownerAuth,audit}){const base='/api/admin/buyer-engagement/outbox',wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(e){if(!e.status)console.error('[outbox]',e.code||'failed');res.status(e.status||503).json({code:e.status?e.code:'outbox_unavailable'});}};
 app.get(base,ownerAuth,wrap(async(req,res)=>res.json(await listOutbox(pool,req.query))));app.get(base+'/operations/:key',ownerAuth,wrap(async(req,res)=>res.json(await outboxReceipt(pool,req.params.key))));
 app.post(base+'/stage',ownerAuth,wrap(async(req,res)=>{const r=await stageIntent(pool,req.body);if(!r.replayed)audit(req,'outbox_staged','engagement_outbox',r.operation.outbox_id);res.json(r);}));
 app.post(base+'/recover',ownerAuth,wrap(async(req,res)=>{const r=await recoverOutbox(pool,req.body);if(!r.replayed)audit(req,'outbox_recovered','engagement_outbox',r.operation.request_key);res.json(r);}));
}
module.exports={stageIntent,recoverOutbox,claimNext,authorizeRehearsal,recordOutcome,rehearseOne,listOutbox,outboxReceipt,exportOutbox,registerOutbox,recoverInside};
