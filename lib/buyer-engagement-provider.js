'use strict';
// No sender, provider API calls, automatic unblock or account approval.
const {createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(value).digest('hex');
const emailHash=value=>digest(value.trim().toLowerCase());
const email=value=>typeof value==='string'&&value.length<=320&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const COLUMNS={'email.sent':'sent_at','email.delivered':'delivered_at','email.delivery_delayed':'delayed_at','email.bounced':'bounced_at','email.complained':'complained_at','email.failed':'failed_at','email.suppressed':'suppressed_at'};
const NEGATIVE={'email.bounced':'bounced','email.complained':'complained','email.suppressed':'suppressed'};
const GLOBAL=new Set(['suppression.added','suppression.removed']);
let runtime={enabled:false,configured:false};

async function tx(pool,fn,readOnly=false) {
  const db=await pool.connect();
  try {await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='15s'");const result=await fn(db);await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
// Called only after an accepted outcome in the isolated protocol. It cannot
// manufacture a real-provider association, including from an incoming webhook.
async function bindAcceptedFixture(db,row,providerId) {
  if(row.mode!=='isolated_transport'||!row.first_attempt_at||!uuid(providerId))throw fail(409,'provider_binding_invalid');
  const link=(await db.query('SELECT email_hash FROM buyer_engagement_unsubscribe_links WHERE outbox_id=$1',[row.id])).rows[0];
  if(!link)throw fail(409,'provider_binding_identity_missing');
  await db.query(`INSERT INTO buyer_engagement_provider_messages(provider_kind,provider_id,outbox_id,buyer_id,recipient_hash)
    VALUES('local_fixture',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,[providerId,row.id,row.buyer_id,link.email_hash]);
  const known=(await db.query("SELECT outbox_id,recipient_hash FROM buyer_engagement_provider_messages WHERE provider_kind='local_fixture' AND provider_id=$1",[providerId])).rows[0];
  if(!known||known.outbox_id!==row.id||known.recipient_hash!==link.email_hash)throw fail(409,'provider_binding_conflict');
}
async function hasProviderBlock(db,buyer) {
  if(!email(buyer.email))return false;
  return (await db.query('SELECT 1 FROM buyer_engagement_provider_blocks WHERE buyer_id=$1 AND recipient_hash=$2 LIMIT 1',[buyer.id,emailHash(buyer.email)])).rowCount>0;
}
async function blockAddress(db,buyer,kind,recipientHash,reason,eventAt) {
  await db.query(`INSERT INTO buyer_engagement_provider_blocks(provider_kind,buyer_id,recipient_hash,reason,last_event_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(provider_kind,buyer_id,recipient_hash) DO UPDATE SET last_event_at=GREATEST(buyer_engagement_provider_blocks.last_event_at,EXCLUDED.last_event_at),
    reason=CASE WHEN buyer_engagement_provider_blocks.reason='complained' OR EXCLUDED.reason='complained' THEN 'complained'
      WHEN buyer_engagement_provider_blocks.reason='bounced' OR EXCLUDED.reason='bounced' THEN 'bounced'
      WHEN buyer_engagement_provider_blocks.reason='bounce_unclassified' OR EXCLUDED.reason='bounce_unclassified' THEN 'bounce_unclassified' ELSE buyer_engagement_provider_blocks.reason END`,[kind,buyer.id,recipientHash,reason,eventAt]);
  // An old-address bounce must not block a newly changed address.
  if(emailHash(buyer.email)!==recipientHash)return;
  await db.query(`UPDATE buyer_engagement_outbox SET status=CASE WHEN first_attempt_at IS NULL THEN 'cancelled' ELSE 'uncertain' END,
    reason='provider_suppression',needs_attention=(first_attempt_at IS NOT NULL),lease_token=NULL,lease_expires_at=NULL,
    sealed_payload=CASE WHEN first_attempt_at IS NULL THEN NULL ELSE sealed_payload END,updated_at=NOW()
    WHERE buyer_id=$1 AND status IN ('staged','reserved','submitting','uncertain')`,[buyer.id]);
}
function normalizeEvent(event) {
  if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string')throw fail(400,'provider_event_invalid');
  if(!Object.hasOwn(COLUMNS,event.type)&&!GLOBAL.has(event.type))return null; // No open/click tracking.
  const data=event.data,at=typeof event.created_at==='string'?new Date(event.created_at):null;
  if(!at||!/^\d{4}-\d{2}-\d{2}T/.test(event.created_at)||!Number.isFinite(+at)||+at>Date.now()+300000||!data||typeof data!=='object'||Array.isArray(data))throw fail(400,'provider_event_invalid');
  if(GLOBAL.has(event.type)) {
    if(!email(data.email)||!uuid(data.id))throw fail(400,'provider_event_invalid');
    return {type:event.type,at,provider_id:null,recipient_hash:emailHash(data.email),global:true};
  }
  if(!uuid(data.email_id)||!Array.isArray(data.to)||data.to.length!==1||!email(data.to[0]))throw fail(400,'provider_event_invalid');
  const block_reason=event.type==='email.bounced'?data.bounce?.type==='Temporary'?null:data.bounce?.type==='Permanent'?'bounced':'bounce_unclassified':NEGATIVE[event.type]||null;
  return {type:event.type,at,provider_id:data.email_id,recipient_hash:emailHash(data.to[0]),global:false,block_reason};
}
async function processVerifiedEvent(pool,{deliveryId,raw,event,providerKind='resend'}) {
  if(!['resend','local_fixture'].includes(providerKind)||typeof deliveryId!=='string'||!/^[a-z0-9_-]{1,128}$/i.test(deliveryId)||!Buffer.isBuffer(raw)||raw.length>32768)throw fail(400,'provider_event_invalid');
  const item=normalizeEvent(event);if(!item)return {ignored:true};
  const payloadHash=digest(raw);
  return tx(pool,async db=>{
    // Serializes the bounded inbox and repeated delivery IDs across processes.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('engagement-provider-inbox:v1'))");
    const previous=(await db.query('SELECT * FROM buyer_engagement_provider_receipts WHERE provider_kind=$1 AND delivery_id=$2',[providerKind,deliveryId])).rows[0];
    if(previous&&previous.payload_hash!==payloadHash)throw fail(409,'provider_event_id_conflict');
    if(previous&&previous.status!=='unmatched')return {replayed:true,status:previous.status};
    if(!previous&&(await db.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_provider_receipts')).rows[0].n>=10000)throw fail(503,'provider_inbox_full');
    let messages;
    if(item.global) messages=(await db.query(`SELECT DISTINCT ON(buyer_id) * FROM buyer_engagement_provider_messages WHERE provider_kind=$1 AND recipient_hash=$2 ORDER BY buyer_id,created_at DESC LIMIT 101`,[providerKind,item.recipient_hash])).rows;
    else messages=(await db.query('SELECT * FROM buyer_engagement_provider_messages WHERE provider_kind=$1 AND provider_id=$2',[providerKind,item.provider_id])).rows;
    if(messages.length>100)throw fail(503,'provider_scope_limit');
    let status='unmatched',matchedBuyer=null,matchedOutbox=null;
    // An unknown ID is never linked by email. Only a later authenticated replay
    // may apply it once an authoritative association exists. No raw body/address
    // is retained for unknown messages, and nothing sends or replays externally.
    for(const source of messages){
      const buyer=(await db.query('SELECT id,email FROM buyers WHERE id=$1 FOR UPDATE',[source.buyer_id])).rows[0];if(!buyer)continue;
      const message=(await db.query('SELECT m.*,o.first_attempt_at FROM buyer_engagement_provider_messages m JOIN buyer_engagement_outbox o ON o.id=m.outbox_id AND o.provider_id=m.provider_id AND o.buyer_id=m.buyer_id WHERE m.provider_kind=$1 AND m.provider_id=$2 FOR UPDATE OF m',[providerKind,source.provider_id])).rows[0];if(!message)continue;
      matchedBuyer=buyer.id;matchedOutbox=message.outbox_id;
      if(message.recipient_hash!==item.recipient_hash||!item.global&&+item.at<+message.first_attempt_at-300000){status='mismatch';continue;}
      status='applied';
      if(item.global){
        if(item.type==='suppression.added')await blockAddress(db,buyer,providerKind,item.recipient_hash,'suppression_added',item.at);
        else await db.query('UPDATE buyer_engagement_provider_blocks SET removal_notice_at=GREATEST(removal_notice_at,$4::timestamptz) WHERE provider_kind=$1 AND buyer_id=$2 AND recipient_hash=$3',[providerKind,buyer.id,item.recipient_hash,item.at]);
      } else {
        const column=COLUMNS[item.type]; // Code constant, never a request identifier.
        await db.query(`UPDATE buyer_engagement_provider_messages SET ${column}=LEAST(${column},$3::timestamptz),last_event_at=GREATEST(last_event_at,$3::timestamptz) WHERE provider_kind=$1 AND provider_id=$2`,[providerKind,message.provider_id,item.at]);
        if(item.block_reason)await blockAddress(db,buyer,providerKind,item.recipient_hash,item.block_reason,item.at);
        if(NEGATIVE[item.type]||item.type==='email.failed')await db.query("UPDATE buyer_engagement_outbox SET needs_attention=true,reason=CASE WHEN reason='provider_id_conflict' THEN reason ELSE 'provider_delivery_problem' END,updated_at=NOW() WHERE id=$1",[message.outbox_id]);
      }
    }
    // Multi-account suppression notices keep no arbitrary buyer association.
    if(messages.length>1){matchedBuyer=null;matchedOutbox=null;}
    const result=(await db.query(`INSERT INTO buyer_engagement_provider_receipts(provider_kind,delivery_id,payload_hash,event_type,event_at,provider_id,outbox_id,buyer_id,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()+make_interval(days=>$10))
      ON CONFLICT(provider_kind,delivery_id) DO UPDATE SET outbox_id=EXCLUDED.outbox_id,buyer_id=EXCLUDED.buyer_id,status=EXCLUDED.status,
      expires_at=CASE WHEN buyer_engagement_provider_receipts.buyer_id IS NULL AND EXCLUDED.buyer_id IS NOT NULL THEN buyer_engagement_provider_receipts.received_at+INTERVAL '90 days' ELSE buyer_engagement_provider_receipts.expires_at END RETURNING status`,
      [providerKind,deliveryId,payloadHash,item.type,item.at,item.provider_id,matchedOutbox,matchedBuyer,status,matchedBuyer?90:7])).rows[0];
    return {status:result.status,replayed:!!previous};
  });
}
function signingConfig({enabled=false,secrets=[]}={}) {
  const valid=Array.isArray(secrets)&&secrets.length>=1&&secrets.length<=2&&secrets.every(s=>typeof s==='string'&&/^whsec_[a-z0-9+/]+={0,2}$/i.test(s)&&Buffer.from(s.slice(6),'base64').length>=32&&s.length<=128&&Buffer.from(s.slice(6),'base64').toString('base64')===s.slice(6));
  return {enabled:enabled===true,configured:valid,secrets:valid?secrets:[]};
}
function registerProviderReceiver({app,pool,enabled=false,secrets=[]}) {
  const express=require('express'),{rateLimit}=require('express-rate-limit'),config=signingConfig({enabled,secrets});runtime={enabled:config.enabled,configured:config.configured};
  const verifier=config.enabled&&config.configured?new (require('resend').Resend)('signature-verification-only'):null;
  const base='/api/webhooks/buyer-engagement/resend';
  const headers=(req,res,next)=>{res.set({'Cache-Control':'no-store, private','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'});next();};
  const gate=(req,res,next)=>{if(!verifier)return res.status(503).json({code:'provider_receiver_disabled'});if(!req.is('application/json')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')return res.status(415).json({code:'provider_content_type_invalid'});next();};
  const limiter=rateLimit({windowMs:60000,limit:600,standardHeaders:'draft-7',legacyHeaders:false,handler:(req,res)=>res.status(429).json({code:'provider_rate_limited'})});
  app.post(base,headers,gate,limiter,express.raw({type:'application/json',limit:'32kb',inflate:false}),async(req,res)=>{
    const id=req.headers['svix-id'],timestamp=req.headers['svix-timestamp'],signature=req.headers['svix-signature'];
    if(typeof id!=='string'||!/^[a-z0-9_-]{1,128}$/i.test(id)||typeof timestamp!=='string'||!/^\d{10,11}$/.test(timestamp)||typeof signature!=='string'||signature.length>4096||!Buffer.isBuffer(req.body))return res.status(401).json({code:'provider_signature_invalid'});
    let event;
    for(const secret of config.secrets)try{event=verifier.webhooks.verify({payload:req.body,headers:{id,timestamp,signature},webhookSecret:secret});break;}catch{}
    if(!event)return res.status(401).json({code:'provider_signature_invalid'});
    try{await processVerifiedEvent(pool,{deliveryId:id,raw:req.body,event});res.json({received:true});}
    catch(error){if(!error.status)console.error('[engagement-provider] provider_event_failed');res.status(error.status||503).json({code:error.status?error.code:'provider_event_unavailable'});}
  });
  app.use(base,(error,req,res,next)=>res.status(error.status===413?413:400).json({code:'provider_body_invalid'}));
}
async function exportProvider(pool,buyerId) {
  return {messages:(await pool.query('SELECT provider_kind,provider_id,outbox_id,created_at,last_event_at,sent_at,delivered_at,delayed_at,bounced_at,complained_at,failed_at,suppressed_at FROM buyer_engagement_provider_messages WHERE buyer_id=$1 ORDER BY created_at',[buyerId])).rows,
    blocks:(await pool.query('SELECT provider_kind,reason,created_at,last_event_at,removal_notice_at FROM buyer_engagement_provider_blocks WHERE buyer_id=$1 ORDER BY created_at',[buyerId])).rows,
    receipts:(await pool.query('SELECT provider_kind,event_type,event_at,status,received_at,expires_at FROM buyer_engagement_provider_receipts WHERE buyer_id=$1 ORDER BY received_at',[buyerId])).rows};
}
async function providerOverview(pool,{offset=0}={}) {
  offset=Math.max(0,Number.parseInt(offset)||0);
  return tx(pool,async db=>{
    const messages=(await db.query(`SELECT m.provider_kind,m.provider_id,m.outbox_id,b.name AS buyer_name,m.created_at,m.sent_at,m.delivered_at,m.delayed_at,m.bounced_at,m.complained_at,m.failed_at,m.suppressed_at
      FROM buyer_engagement_provider_messages m JOIN buyers b ON b.id=m.buyer_id ORDER BY m.created_at DESC,m.provider_id LIMIT 50 OFFSET $1`,[offset])).rows;
    const blocks=(await db.query(`SELECT p.provider_kind,b.name AS buyer_name,p.reason,p.created_at,p.last_event_at,p.removal_notice_at,p.recipient_hash,b.email FROM buyer_engagement_provider_blocks p JOIN buyers b ON b.id=p.buyer_id ORDER BY p.created_at DESC,p.buyer_id LIMIT 50`)).rows.map(({recipient_hash,email:address,...r})=>({...r,current_address:emailHash(address)===recipient_hash}));
    const counts=(await db.query('SELECT provider_kind,status,COUNT(*)::int AS count FROM buyer_engagement_provider_receipts GROUP BY provider_kind,status')).rows;
    const total=(await db.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_provider_messages')).rows[0].n;
    const blocksTotal=(await db.query('SELECT COUNT(*)::int AS n FROM buyer_engagement_provider_blocks')).rows[0].n;
    const stats=(await db.query(`SELECT provider_kind,COUNT(*)::int AS messages,COUNT(*) FILTER(WHERE delivered_at IS NOT NULL)::int AS delivered,
      COUNT(*) FILTER(WHERE bounced_at IS NOT NULL)::int AS bounced,COUNT(*) FILTER(WHERE complained_at IS NOT NULL)::int AS complained,
      COUNT(*) FILTER(WHERE failed_at IS NOT NULL)::int AS failed,COUNT(*) FILTER(WHERE suppressed_at IS NOT NULL)::int AS suppressed
      FROM buyer_engagement_provider_messages GROUP BY provider_kind ORDER BY provider_kind`)).rows;
    return {sending_enabled:false,receiver:{...runtime},messages,blocks,blocks_total:blocksTotal,counts,stats,total,offset,limit:50};
  },true);
}
function registerProviderAdmin({app,pool,ownerAuth}) {
  app.get('/api/admin/buyer-engagement/provider-events',ownerAuth,async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await providerOverview(pool,req.query));}catch{res.status(503).json({code:'provider_overview_unavailable'});}});
}
module.exports={bindAcceptedFixture,hasProviderBlock,processVerifiedEvent,registerProviderReceiver,registerProviderAdmin,providerOverview,exportProvider,signingConfig};
