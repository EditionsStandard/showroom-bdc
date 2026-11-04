'use strict';
// Editorial approval only. No provider, recipient, link generation or dispatch.
const {createHash}=require('node:crypto');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const rules=['welcome','inactive','cart'];
const selector=v=>!!v&&rules.includes(v.rule_id)&&['fr','en'].includes(v.lang)&&Number.isInteger(v.template_version)&&v.template_version>0;
const contentHash=t=>hash({rule_id:t.rule_id,lang:t.lang,version:t.version,subject:t.subject,body:t.body});
async function transaction(pool,fn,readOnly=false){const db=await pool.connect();try{await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='15s'");const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
function draftValid(t){if(!t||typeof t.subject!=='string'||!t.subject.trim()||t.subject.length>200||/[\r\n]/.test(t.subject)||typeof t.body!=='string'||!t.body.trim()||t.body.length>10000)return false;
 const full=t.subject+'\n'+t.body;const tokens=[...full.matchAll(/{{\s*([^{}]+?)\s*}}/g)];return tokens.every(m=>['buyer_name','portal_url'].includes(m[1]))&&!/[{}]/.test(full.replace(/{{\s*([^{}]+?)\s*}}/g,''));}
async function template(db,value){return (await db.query('SELECT * FROM buyer_engagement_templates WHERE rule_id=$1 AND lang=$2 AND version=$3',[value.rule_id,value.lang,value.template_version])).rows[0];}
async function approvalFor(db,ruleId,lang,version){
 const value={rule_id:ruleId,lang,template_version:version};if(!selector(value))return {approved:false,reason:'unsupported_template',sending_enabled:false};const t=await template(db,value);if(!t)return {approved:false,reason:'template_missing',sending_enabled:false};
 const latest=(await db.query('SELECT MAX(version) AS v FROM buyer_engagement_templates WHERE rule_id=$1 AND lang=$2',[ruleId,lang])).rows[0].v;
 const signoff=(await db.query('SELECT * FROM buyer_engagement_template_signoffs WHERE rule_id=$1 AND lang=$2 AND template_version=$3',[ruleId,lang,version])).rows[0]||null;
 const reason=latest!==version?'newer_draft_exists':!draftValid(t)?'template_invalid':!signoff?'not_reviewed':signoff.content_hash!==contentHash(t)?'content_changed':signoff.decision!=='approved'?'approval_revoked':'editorial_approved';
 return {approved:reason==='editorial_approved',reason,scope:'editorial_only',sending_enabled:false,content_hash:contentHash(t),signoff};
}
async function listSignoffs(pool){return transaction(pool,async db=>{const latest=(await db.query("SELECT DISTINCT ON(rule_id,lang) * FROM buyer_engagement_templates WHERE rule_id=ANY($1::text[]) ORDER BY rule_id,lang,version DESC",[rules])).rows;
 const templates=[];for(const t of latest){const state=await approvalFor(db,t.rule_id,t.lang,t.version);const history=(await db.query("SELECT request_key,revision,decision,reason,content_hash,actor,created_at FROM buyer_engagement_template_signoff_operations WHERE rule_id=$1 AND lang=$2 AND template_version=$3 AND status='saved' ORDER BY revision DESC LIMIT 5",[t.rule_id,t.lang,t.version])).rows;templates.push({...t,content_hash:contentHash(t),valid:draftValid(t),approval:state,history});}
 return {mode:'editorial_only',sending_enabled:false,templates};},true);}
async function lockTemplate(db,value){await db.query('SELECT id FROM buyer_engagement_rules WHERE id=$1 FOR UPDATE',[value.rule_id]);const t=await template(db,value);if(!t)throw fail(404,'template_missing');return t;}
async function room(db,v,withdrawal=false){const n=(await db.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_template_signoff_operations WHERE rule_id=$1 AND lang=$2 AND template_version=$3',[v.rule_id,v.lang,v.template_version])).rows[0].n;if(n>=200&&!withdrawal)throw fail(422,'signoff_history_limit');}
async function saveSignoff(pool,body,actor='legacy_owner'){
 if(!selector(body)||!uuid(body.request_key)||!Number.isInteger(body.expected_revision)||body.expected_revision<0||!['approved','revoked'].includes(body.decision)||typeof body.content_hash!=='string'||!/^[a-f0-9]{64}$/.test(body.content_hash)||body.ack_editorial_only!==true||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>1000)throw fail(400,'invalid_template_signoff');
 const v={rule_id:body.rule_id,lang:body.lang,template_version:body.template_version,request_key:body.request_key,expected_revision:body.expected_revision,decision:body.decision,content_hash:body.content_hash,reason:body.reason.trim(),ack_editorial_only:true};const bodyHash=hash(v);
 return transaction(pool,async db=>{await db.query("SELECT pg_advisory_xact_lock(hashtext('template-signoff-op:'||$1))",[v.request_key]);const t=await lockTemplate(db,v);
  const previous=(await db.query('SELECT * FROM buyer_engagement_template_signoff_operations WHERE request_key=$1',[v.request_key])).rows[0];if(previous){if(previous.status==='cancelled')throw fail(409,'signoff_operation_cancelled');if(previous.body_hash!==bodyHash)throw fail(409,'signoff_key_reused');return {operation:previous,replayed:true};}
  const latest=(await db.query('SELECT MAX(version) AS v FROM buyer_engagement_templates WHERE rule_id=$1 AND lang=$2',[v.rule_id,v.lang])).rows[0].v;
  if(v.content_hash!==contentHash(t))throw fail(409,'signoff_content_changed');if(v.decision==='approved'&&(latest!==v.template_version||!draftValid(t)))throw fail(409,latest!==v.template_version?'newer_draft_exists':'template_invalid');
  const current=(await db.query('SELECT * FROM buyer_engagement_template_signoffs WHERE rule_id=$1 AND lang=$2 AND template_version=$3 FOR UPDATE',[v.rule_id,v.lang,v.template_version])).rows[0];if(v.decision==='approved'&&(current?.revision||0)!==v.expected_revision)throw fail(409,'signoff_revision_conflict');if(v.decision==='approved'&&(current?.revision||0)>=100)throw fail(422,'signoff_history_limit');await room(db,v,v.decision==='revoked'&&current?.decision==='approved');
  const revision=(current?.revision||0)+1;await db.query(`INSERT INTO buyer_engagement_template_signoffs(rule_id,lang,template_version,revision,decision,content_hash,reason,decided_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(rule_id,lang,template_version) DO UPDATE SET revision=$4,decision=$5,content_hash=$6,reason=$7,decided_by=$8,decided_at=NOW()`,[v.rule_id,v.lang,v.template_version,revision,v.decision,v.content_hash,v.reason,actor]);
  const operation=(await db.query(`INSERT INTO buyer_engagement_template_signoff_operations(request_key,rule_id,lang,template_version,status,body_hash,revision,decision,reason,content_hash,actor) VALUES($1,$2,$3,$4,'saved',$5,$6,$7,$8,$9,$10) RETURNING *`,[v.request_key,v.rule_id,v.lang,v.template_version,bodyHash,revision,v.decision,v.reason,v.content_hash,actor])).rows[0];return {operation,replayed:false};
 });
}
async function signoffReceipt(pool,key){if(!uuid(key))throw fail(400,'invalid_signoff_operation');return transaction(pool,async db=>{const operation=(await db.query('SELECT * FROM buyer_engagement_template_signoff_operations WHERE request_key=$1',[key])).rows[0];return operation?{found:true,operation}:{found:false};},true);}
async function cancelSignoff(pool,key,value,actor='legacy_owner'){
 if(!uuid(key)||!selector(value))throw fail(400,'invalid_signoff_operation');return transaction(pool,async db=>{await db.query("SELECT pg_advisory_xact_lock(hashtext('template-signoff-op:'||$1))",[key]);await lockTemplate(db,value);const previous=(await db.query('SELECT * FROM buyer_engagement_template_signoff_operations WHERE request_key=$1',[key])).rows[0];if(previous){if(previous.rule_id!==value.rule_id||previous.lang!==value.lang||previous.template_version!==value.template_version)throw fail(409,'signoff_key_reused');return {operation:previous};}await room(db,value);return {operation:(await db.query("INSERT INTO buyer_engagement_template_signoff_operations(request_key,rule_id,lang,template_version,status,actor) VALUES($1,$2,$3,$4,'cancelled',$5) RETURNING *",[key,value.rule_id,value.lang,value.template_version,actor])).rows[0]};});
}
function registerTemplateSignoffs({app,pool,ownerAuth,audit}){
 const base='/api/admin/buyer-engagement/template-signoffs',wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(e){if(!e.status)console.error('[template-signoff]',e.code||'failed');res.status(e.status||503).json({code:e.status?e.code:'signoff_unavailable'});}};
 app.get(base,ownerAuth,wrap(async(req,res)=>res.json(await listSignoffs(pool))));
 app.get(base+'/operations/:key',ownerAuth,wrap(async(req,res)=>res.json(await signoffReceipt(pool,req.params.key))));
 app.post(base+'/operations/:key/cancel',ownerAuth,wrap(async(req,res)=>res.json(await cancelSignoff(pool,req.params.key,req.body,req.session.staffUser?.id||'legacy_owner'))));
 app.post(base,ownerAuth,wrap(async(req,res)=>{const r=await saveSignoff(pool,req.body,req.session.staffUser?.id||'legacy_owner');if(!r.replayed)audit(req,'template_editorial_review','engagement_template',r.operation.rule_id,r.operation.decision);res.json(r);}));
}
module.exports={listSignoffs,saveSignoff,signoffReceipt,cancelSignoff,approvalFor,contentHash,draftValid,registerTemplateSignoffs};
