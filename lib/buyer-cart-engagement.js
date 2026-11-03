'use strict';
// Simulation only: no provider, job queue, email renderer or CRM write adapter.
const {randomUUID}=require('node:crypto');
const {cartEpisodeContent}=require('./buyer-cart');
const ordering=require('../public/ordering-rules');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const MAX_CYCLES=1000,MAX_CANDIDATES=5000;
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
const episode=c=>JSON.stringify([c.cycle_id,String(c.cycle_revision??c.revision),c.content_hash]);
const LOCK="SELECT pg_try_advisory_xact_lock(hashtext('buyer-engagement:simulation-engine:v1')) AS acquired";
async function transaction(pool,fn,readOnly=false){
 const db=await pool.connect();try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ'+(readOnly?' READ ONLY':''));
  await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='20s'");
  const value=await fn(db);await db.query('COMMIT');return value;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function sources(db,ids=[]){
 const rule=(await db.query("SELECT * FROM buyer_engagement_rules WHERE id='cart'")).rows[0];
 const paused=(await db.query('SELECT paused FROM buyer_engagement_simulation_control WHERE id=true')).rows[0].paused;
 const templates=(await db.query("SELECT DISTINCT ON(lang) lang,version FROM buyer_engagement_templates WHERE rule_id='cart' ORDER BY lang,version DESC")).rows;
 const now=(await db.query('SELECT NOW() AS now')).rows[0].now;
 const rows=(await db.query(`SELECT c.*,s.cart_json,b.name AS buyer_name,b.lang,b.activation_pending,b.approved_at,b.last_login_at,
  b.last_meaningful_activity_at,b.last_seen_at,b.last_engagement_email_at,COALESCE(p.status,'unknown') AS email_status,
  br.id AS existing_brand,br.name AS brand_name,br.subscription_status,br.early_access_until,br.min_per_reference,br.moq_qty,br.moq_amount,br.moq_strict,
  bt.is_privileged,bt.min_per_reference_override,
  (c.changed_at<=NOW()-make_interval(hours=>$2)) AS delay_reached,
  (b.last_meaningful_activity_at<=NOW()-make_interval(hours=>$2)) AS activity_old,
  (b.last_seen_at IS NULL OR b.last_seen_at<=NOW()-make_interval(hours=>$2)) AS presence_old,
  (b.last_engagement_email_at IS NULL OR b.last_engagement_email_at<=NOW()-make_interval(hours=>24)) AS contact_old,
  (b.approved_at<=NOW() AND b.last_login_at<=NOW()) AS access_dates_valid,
  EXISTS(SELECT 1 FROM buyer_cart_checkouts ch WHERE ch.buyer_id=c.buyer_id AND ch.expected_cycles ? c.brand_id
   AND ch.expected_cycles->c.brand_id->>'cycle_id'=c.cycle_id::text
   AND ch.expected_cycles->c.brand_id->>'revision'=c.revision::text AND ch.expected_cycles->c.brand_id->>'content_hash'=c.content_hash
   AND NOT EXISTS(SELECT 1 FROM buyer_cart_checkout_results cr WHERE cr.buyer_id=ch.buyer_id AND cr.request_key=ch.request_key AND cr.brand_id=c.brand_id)) AS checkout_pending
  FROM buyer_cart_cycles c JOIN buyer_cart_states s ON s.buyer_id=c.buyer_id JOIN buyers b ON b.id=c.buyer_id
  LEFT JOIN buyer_email_preferences p ON p.buyer_id=b.id LEFT JOIN brands br ON br.id=c.brand_id
  LEFT JOIN buyer_brand_terms bt ON bt.buyer_id=c.buyer_id AND bt.brand_id=c.brand_id
  WHERE c.is_current OR c.cycle_id=ANY($1::uuid[]) ORDER BY c.buyer_id,c.brand_id,c.cycle_id LIMIT $3`,[ids,rule.delay_hours,MAX_CYCLES+ids.length+1])).rows;
 if(rows.filter(c=>c.is_current).length>MAX_CYCLES)throw fail(422,'cart_cohort_limit','Plus de 1 000 cycles courants : traitement par lots nécessaire.');
 const productIds=new Set();for(const row of rows)if(row.cart_json&&typeof row.cart_json==='object')for(const line of Object.values(row.cart_json))if(line&&typeof line.product_id==='string')productIds.add(line.product_id);
 if(productIds.size>10000)throw fail(422,'cart_catalogue_limit','Plus de 10 000 produits à contrôler : traitement par lots nécessaire.');
 const products=new Map((await db.query('SELECT * FROM products WHERE id=ANY($1::text[])',[[...productIds]])).rows.map(p=>[p.id,p]));
 return {rule,paused,templates,now,rows,products};
}
function decision(row,source,candidate){
 const no=reason=>({eligible:false,reason}),{rule,paused,templates,products}=source;
 if(paused)return no('simulation_paused');
 if(rule.mode!=='simulation')return no('rule_disabled');
 if(rule.delay_hours<48)return no('cart_delay_below_minimum');
 if(!row)return no('cycle_missing');
 if(!row.is_current)return no('episode_changed');
 if(row.state==='converted')return no('cart_converted');
 if(row.state==='empty')return no('cart_empty');
 if(row.state!=='open'||row.provenance!=='versioned')return no('cart_history_unknown');
 if(candidate&&(String(candidate.cycle_revision)!==String(row.revision)||candidate.content_hash!==row.content_hash))return no('episode_changed');
 if(row.email_status!=='granted')return no('marketing_permission_missing');
 if(!row.approved_at)return no('approval_unknown');
 if(row.activation_pending||!row.last_login_at)return no('no_completed_login');
 if(!row.access_dates_valid)return no('access_dates_invalid');
 if(!row.delay_reached)return no('delay_not_reached');
 if(!row.last_meaningful_activity_at)return no('activity_unknown');
 if(!row.activity_old)return no('recent_activity');
 if(!row.presence_old)return no('recent_presence');
 if(!row.contact_old)return no('recent_contact');
 if(row.checkout_pending)return no('checkout_pending');
 if(!row.existing_brand||row.subscription_status==='inactive')return no('brand_unavailable');
 if(row.early_access_until&&+new Date(row.early_access_until)>+source.now&&!row.is_privileged)return no('early_access');
 const lang=row.lang==='en'?'en':'fr';if(!templates.some(t=>t.lang===lang))return no('template_missing');
 let content;try{content=cartEpisodeContent(row.cart_json,row.brand_id);}catch{return no('cart_invalid');}
 if(!content.lines.length)return no('cart_empty');
 if(content.content_hash!==row.content_hash)return no('cart_hash_mismatch');
 const allocated=new Map(),resolved=[];let total=0;
 for(const line of content.lines){const product=products.get(line.product_id);
  if(!product||product.brand_id!==row.brand_id||ordering.catalogIssue(product,line,{allocated:allocated.get(line.product_id)||0}))return no('cart_not_orderable');
  const price=Number(product.price);if(product.price==null||product.price===''||!Number.isFinite(price)||price<0)return no('cart_not_orderable');
  allocated.set(line.product_id,(allocated.get(line.product_id)||0)+line.quantity);total+=price*line.quantity;resolved.push({...line,reference:product.reference});
 }
 if([...ordering.aggregate(resolved,'quantity').values()].some(q=>q<ordering.minimum(row)))return no('cart_minimum_not_met');
 const quantity=resolved.reduce((n,line)=>n+line.quantity,0);
 if(row.moq_strict&&((Number(row.moq_qty)||0)>quantity||(Number(row.moq_amount)||0)>total))return no('cart_minimum_not_met');
 return {eligible:true,reason:'known_open_cart_after_delay'};
}
function viewRow(row,source,candidate){
 const outcome=decision(row,source,candidate);
 return {buyer_id:row?.buyer_id||candidate.buyer_id,buyer_name:row?.buyer_name||null,brand_id:row?.brand_id||candidate.brand_id,brand_name:row?.brand_name||null,
  cycle_id:row?.cycle_id||candidate.cycle_id,cycle_revision:candidate?candidate.cycle_revision:row.revision,current_cycle_revision:row?.revision||null,changed_at:row?.changed_at||null,
  ...outcome};
}
async function prune(db){
 await db.query("DELETE FROM buyer_cart_simulation_candidates WHERE created_at<NOW()-INTERVAL '90 days'");
 await db.query("DELETE FROM buyer_cart_simulation_runs WHERE created_at<NOW()-INTERVAL '365 days'");
}
async function runCartSimulation(pool,{request_key,kind}={}){
 if(!uuid(request_key)||!['generate','recheck'].includes(kind))throw fail(400,'invalid_cart_simulation','Requête de simulation invalide.');
 return transaction(pool,async db=>{
  if(!(await db.query(LOCK)).rows[0].acquired)throw fail(409,'simulation_busy','Un calcul est déjà en cours.');
  const previous=(await db.query('SELECT * FROM buyer_cart_simulation_runs WHERE request_key=$1',[request_key])).rows[0];
  if(previous){if(previous.kind!==kind)throw fail(409,'request_key_reused','Référence utilisée pour un autre calcul.');return {run:previous,replayed:true};}
  await db.query("SELECT id FROM buyer_engagement_rules WHERE id='cart' FOR SHARE");
  const old=(await db.query("SELECT * FROM buyer_cart_simulation_candidates WHERE created_at>=NOW()-INTERVAL '90 days' ORDER BY id LIMIT $1",[MAX_CANDIDATES+1])).rows;
  if(old.length>MAX_CANDIDATES)throw fail(422,'cart_candidate_limit','Plus de 5 000 candidats : traitement par lots nécessaire.');
  const source=await sources(db,old.map(c=>c.cycle_id));
  if(kind==='generate'&&source.paused)throw fail(409,'simulation_paused','Les simulations sont en pause.');
  const cycleMap=new Map(source.rows.map(c=>[c.cycle_id,c])),known=new Set(old.map(episode));
  const updates=old.map(c=>({candidate:c,row:cycleMap.get(c.cycle_id),outcome:decision(cycleMap.get(c.cycle_id),source,c)}));
  if(kind==='generate')for(const row of source.rows.filter(c=>c.is_current)){
   const outcome=decision(row,source);if(!outcome.eligible||known.has(episode(row)))continue;
   updates.push({candidate:{id:randomUUID(),buyer_id:row.buyer_id,brand_id:row.brand_id,cycle_id:row.cycle_id,cycle_revision:row.revision,content_hash:row.content_hash},row,outcome,isNew:true});
  }
  if(updates.length>MAX_CANDIDATES)throw fail(422,'cart_candidate_limit','Plus de 5 000 candidats : traitement par lots nécessaire.');
  const counts={scanned_count:source.rows.filter(c=>c.is_current).length,created_count:updates.filter(u=>u.isNew).length,rechecked_count:old.length,
   eligible_count:updates.filter(u=>u.outcome.eligible).length,excluded_count:updates.filter(u=>!u.outcome.eligible).length};
  const run=(await db.query(`INSERT INTO buyer_cart_simulation_runs(id,request_key,kind,scanned_count,created_count,rechecked_count,eligible_count,excluded_count,rule_snapshot)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),request_key,kind,counts.scanned_count,counts.created_count,counts.rechecked_count,counts.eligible_count,counts.excluded_count,JSON.stringify({rule:source.rule,templates:source.templates,paused:source.paused})])).rows[0];
  await prune(db);
  const records=updates.map(({candidate:c,row,outcome})=>{
   const lang=row?.lang==='en'?'en':'fr',template=source.templates.find(t=>t.lang===lang);
   return {...c,status:outcome.eligible?'eligible':'excluded',reason:outcome.reason,rule_version:source.rule.version,delay_hours:source.rule.delay_hours,template_lang:lang,template_version:template?.version||null};
  });
  if(records.length){
   await db.query(`INSERT INTO buyer_cart_simulation_candidates(id,buyer_id,brand_id,cycle_id,cycle_revision,content_hash,status,reason,rule_version,delay_hours,template_lang,template_version,last_run_id)
    SELECT id,buyer_id,brand_id,cycle_id,cycle_revision,content_hash,status,reason,rule_version,delay_hours,template_lang,template_version,$2
    FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,buyer_id text,brand_id text,cycle_id uuid,cycle_revision bigint,content_hash text,status text,reason text,rule_version integer,delay_hours integer,template_lang text,template_version integer)
    ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,rule_version=EXCLUDED.rule_version,delay_hours=EXCLUDED.delay_hours,
    template_lang=EXCLUDED.template_lang,template_version=EXCLUDED.template_version,last_run_id=EXCLUDED.last_run_id,checked_at=NOW()`,[JSON.stringify(records),run.id]);
   await db.query(`INSERT INTO buyer_cart_simulation_checks(run_id,candidate_id,status,reason,rule_version,delay_hours,template_lang,template_version)
    SELECT $1,id,status,reason,rule_version,delay_hours,template_lang,template_version FROM buyer_cart_simulation_candidates WHERE last_run_id=$1`,[run.id]);
  }

  return {run,replayed:false};
 });
}
async function getCartSimulation(pool,{offset=0}={}){
 offset=Math.max(0,Math.min(1000000,Number.parseInt(offset)||0));
 return transaction(pool,async db=>{
  const candidates=(await db.query('SELECT * FROM buyer_cart_simulation_candidates ORDER BY created_at DESC,id LIMIT 50 OFFSET $1',[offset])).rows;
  const source=await sources(db,candidates.map(c=>c.cycle_id)),map=new Map(source.rows.map(c=>[c.cycle_id,c]));
  const preview=source.rows.filter(c=>c.is_current).map(c=>viewRow(c,source));
  const counts={eligible:preview.filter(r=>r.eligible).length,excluded:preview.filter(r=>!r.eligible).length};
  return {mode:'simulation',sending_enabled:false,preparation_enabled:false,now:source.now,paused:source.paused,rule:source.rule,counts,
   preview:{rows:preview.slice(offset,offset+50),total:preview.length,offset,limit:50},
   candidates:{rows:candidates.map(c=>({...c,recorded_status:c.status,recorded_reason:c.reason,...viewRow(map.get(c.cycle_id),source,c)})),
    total:(await db.query('SELECT COUNT(*)::int AS n FROM buyer_cart_simulation_candidates')).rows[0].n,offset,limit:50},
   runs:(await db.query('SELECT * FROM buyer_cart_simulation_runs ORDER BY created_at DESC,id DESC LIMIT 10')).rows};
 },true);
}
async function pruneCartSimulation(pool){return transaction(pool,async db=>{if((await db.query(LOCK)).rows[0].acquired)await prune(db);});}
async function exportCartSimulation(pool,buyerId){
 const candidates=(await pool.query('SELECT * FROM buyer_cart_simulation_candidates WHERE buyer_id=$1 ORDER BY created_at,id',[buyerId])).rows;
 const checks=(await pool.query(`SELECT h.* FROM buyer_cart_simulation_checks h JOIN buyer_cart_simulation_candidates c ON c.id=h.candidate_id WHERE c.buyer_id=$1 ORDER BY h.checked_at`,[buyerId])).rows;
 return {candidates,checks};
}
function registerCartSimulation({app,pool,ownerAuth,audit}){
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(error){if(!error.status)console.error('[cart-simulation]',error.code||'failed');res.status(error.status||503).json({code:error.code||'cart_simulation_failed',error:error.status?error.message:'Simulation panier indisponible.'});}};
 app.get('/api/admin/buyer-engagement/cart-simulation',ownerAuth,wrap(async(req,res)=>res.json(await getCartSimulation(pool,req.query))));
 app.post('/api/admin/buyer-engagement/cart-simulation/runs',ownerAuth,wrap(async(req,res)=>{const result=await runCartSimulation(pool,req.body);if(!result.replayed)audit(req,'cart_simulation_run','engagement_cart_run',result.run.id,result.run.kind);res.json(result);}));
}
module.exports={decision,runCartSimulation,getCartSimulation,exportCartSimulation,registerCartSimulation,pruneCartSimulation};
