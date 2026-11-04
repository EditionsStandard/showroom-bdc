'use strict';
// No public token issuer, provider or sender. Raw tokens exist only in the
// first sealed message; public reads never change a preference or activate.
const {randomBytes,createHash}=require('node:crypto'),path=require('node:path');
const digest=v=>createHash('sha256').update(v).digest('hex');
const emailHash=v=>digest(String(v||'').trim().toLowerCase());
const tokenOK=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
function checkedOrigin(value,{fixture=false}={}){let u;try{u=new URL(value);}catch{throw fail(400,'email_origin_invalid');}
 const local=fixture&&u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname);
 const fixtureTLS=fixture&&u.protocol==='https:'&&u.hostname.endsWith('.test');
 if(!local&&!fixtureTLS&&!(u.protocol==='https:'&&u.hostname==='showroom.editionsstandard.com'&&!u.port)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw fail(400,'email_origin_invalid');return u.origin;}
// Caller must own the buyer + outbox row locks and commit this in the same
// transaction as the immutable sealed envelope. No existing reset is deleted.
async function issueEmailLinks(db,outbox,buyer,origin,{fixture=false}={}){
 origin=checkedOrigin(origin,{fixture});if(outbox.buyer_id!==buyer.id||!['welcome','inactive'].includes(outbox.rule_id)||outbox.first_attempt_at)throw fail(409,'email_link_source_invalid');
 if(!buyer.approved_at||(await db.query('SELECT $1::timestamptz>NOW() AS future',[buyer.approved_at])).rows[0].future)throw fail(409,'email_link_approval_missing');
 const email_hash=emailHash(buyer.email),unsubscribe=randomBytes(32).toString('hex');
 await db.query('INSERT INTO buyer_engagement_unsubscribe_links(token_hash,outbox_id,buyer_id,email_hash) VALUES($1,$2,$3,$4)',[digest(unsubscribe),outbox.id,buyer.id,email_hash]);
 const lang=buyer.lang==='en'?'en':'fr';let activationURL=null;
 if(outbox.rule_id==='welcome'&&buyer.activation_pending){if(buyer.first_login_at||buyer.last_login_at)throw fail(409,'email_link_already_activated');const token=randomBytes(32).toString('hex'),token_hash=digest(token);
  await db.query("INSERT INTO buyer_password_resets(token,buyer_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '60 minutes')",[token_hash,buyer.id]);
  await db.query('INSERT INTO buyer_engagement_activation_links(token_hash,outbox_id,buyer_id,email_hash) VALUES($1,$2,$3,$4)',[token_hash,outbox.id,buyer.id,email_hash]);
  activationURL=origin+'/buyer-engagement/activate#'+new URLSearchParams({token,lang});
 }
 return {portal_url:activationURL||origin+'/portal',unsubscribe_url:origin+'/buyer-engagement/unsubscribe#'+new URLSearchParams({token:unsubscribe,lang}),
  headers:{'List-Unsubscribe':'<'+origin+'/api/public/buyer-engagement/unsubscribe/'+unsubscribe+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}};
}
async function frozenLinksValid(db,outbox,buyer){
 const unsubscribe=(await db.query('SELECT email_hash,expires_at>NOW() AS valid FROM buyer_engagement_unsubscribe_links WHERE outbox_id=$1',[outbox.id])).rows[0];
 if(!unsubscribe||!unsubscribe.valid||unsubscribe.email_hash!==emailHash(buyer.email))return {valid:false,reason:'unsubscribe_link_unavailable'};
 if(outbox.rule_id==='welcome'&&outbox.activation_pending_snapshot){const activation=(await db.query('SELECT l.email_hash,r.used,l.expires_at>NOW()+INTERVAL \'1 minute\' AND r.expires_at>NOW()+INTERVAL \'1 minute\' AS valid FROM buyer_engagement_activation_links l JOIN buyer_password_resets r ON r.token=l.token_hash WHERE l.outbox_id=$1',[outbox.id])).rows[0];if(!activation||!activation.valid||activation.used||activation.email_hash!==emailHash(buyer.email))return {valid:false,reason:'activation_link_unavailable'};}
 return {valid:true};
}
async function lockManagedActivation(db,tokenHash,buyerId){
 const link=(await db.query('SELECT *,expires_at>NOW() AS valid FROM buyer_engagement_activation_links WHERE token_hash=$1',[tokenHash])).rows[0];if(!link)return {managed:false};
 if(link.buyer_id!==buyerId||!link.valid)throw fail(400,'activation_invalid');
 const buyer=(await db.query('SELECT id,email,approved_at,activation_pending,first_login_at,last_login_at,approved_at<=NOW() AS approval_valid FROM buyers WHERE id=$1 FOR UPDATE',[buyerId])).rows[0];
 if(!buyer?.approved_at||!buyer.approval_valid||!buyer.activation_pending||buyer.first_login_at||buyer.last_login_at||emailHash(buyer.email)!==link.email_hash)throw fail(400,'activation_invalid');
 return {managed:true};
}
async function unsubscribeBuyer(pool,token){if(!tokenOK(token))throw fail(400,'email_link_invalid');const db=await pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='10s'");
 const hash=digest(token),source=(await db.query('SELECT buyer_id FROM buyer_engagement_unsubscribe_links WHERE token_hash=$1',[hash])).rows[0];if(!source)throw fail(400,'email_link_invalid');
 const buyer=(await db.query('SELECT id,email FROM buyers WHERE id=$1 FOR UPDATE',[source.buyer_id])).rows[0];
 const link=(await db.query('SELECT *,expires_at>NOW() AS valid FROM buyer_engagement_unsubscribe_links WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
 if(!buyer||!link?.valid||link.email_hash!==emailHash(buyer.email))throw fail(400,'email_link_invalid');
 const changed=await db.query(`INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version) VALUES($1,'denied','email_link','buyer-email-unsubscribe-v1')
  ON CONFLICT(buyer_id) DO UPDATE SET status='denied',source='email_link',notice_version='buyer-email-unsubscribe-v1',recorded_at=NOW() WHERE buyer_email_preferences.status IS DISTINCT FROM 'denied' RETURNING buyer_id`,[buyer.id]);
 if(changed.rowCount)await db.query("INSERT INTO buyer_email_preference_events(buyer_id,status,source,notice_version) VALUES($1,'denied','email_link','buyer-email-unsubscribe-v1')",[buyer.id]);
 await db.query('UPDATE buyer_engagement_unsubscribe_links SET last_used_at=NOW() WHERE token_hash=$1',[hash]);
 const cancelled=(await db.query("UPDATE buyer_engagement_outbox SET status='cancelled',reason='marketing_permission_missing',lease_token=NULL,lease_expires_at=NULL,sealed_payload=NULL,updated_at=NOW() WHERE buyer_id=$1 AND first_attempt_at IS NULL AND status IN ('staged','reserved') RETURNING id,attempt_count",[buyer.id])).rows;
 const uncertain=(await db.query("UPDATE buyer_engagement_outbox SET status='uncertain',reason='marketing_permission_missing',needs_attention=true,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE buyer_id=$1 AND first_attempt_at IS NOT NULL AND status IN ('reserved','submitting','uncertain') RETURNING id,attempt_count",[buyer.id])).rows;
 for(const row of [...cancelled,...uncertain])await db.query("INSERT INTO buyer_engagement_outbox_events(outbox_id,event,reason,attempt_no) VALUES($1,'marketing_withdrawn','marketing_permission_missing',$2)",[row.id,row.attempt_count]);
 await db.query('COMMIT');return {ok:true};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function exportEmailLinks(pool,buyerId){return {unsubscribe_links:(await pool.query('SELECT created_at,expires_at,last_used_at FROM buyer_engagement_unsubscribe_links WHERE buyer_id=$1 ORDER BY created_at',[buyerId])).rows,
 activation_links:(await pool.query('SELECT l.created_at,l.expires_at,r.used FROM buyer_engagement_activation_links l JOIN buyer_password_resets r ON r.token=l.token_hash WHERE l.buyer_id=$1 ORDER BY l.created_at',[buyerId])).rows};}
function registerPublicEmailLinks({app,pool}){
 const express=require('express'),rateLimit=require('express-rate-limit').rateLimit,multer=require('multer');
 const headers=(req,res,next)=>{res.set({'Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});next();};
 const root=path.join(__dirname,'../public');
 for(const route of ['/buyer-engagement/activate','/buyer-engagement/unsubscribe','/api/public/buyer-engagement/unsubscribe/:token'])app.get(route,headers,(req,res)=>res.sendFile(path.join(root,'buyer-email-action.html')));
 for(const [route,file,type] of [['/buyer-email-action.js','buyer-email-action.js','application/javascript'],['/buyer-email-action.css','buyer-email-action.css','text/css']])app.get(route,headers,(req,res)=>res.type(type).sendFile(path.join(root,file)));
 const limit=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-7',legacyHeaders:false,handler:(req,res)=>res.status(429).json({code:'email_link_rate_limited'})});
 const multipart=multer({limits:{fields:1,files:0,parts:2,fieldNameSize:50,fieldSize:100}}).none();
 const parse=[express.json({limit:'2kb'}),express.urlencoded({extended:false,limit:'2kb'}),(req,res,next)=>req.is('multipart/form-data')?multipart(req,res,next):next()];
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){if(!e.status)console.error('[email-links]',e.code||'failed');res.status(e.status||503).json({code:e.status?e.code:'email_link_unavailable'});}};
 app.post('/api/public/buyer-engagement/unsubscribe',headers,limit,...parse,wrap(async(req,res)=>{if(Object.keys(req.body||{}).some(k=>k!=='token'))throw fail(400,'email_link_invalid');res.json(await unsubscribeBuyer(pool,req.body?.token));}));
 app.post('/api/public/buyer-engagement/unsubscribe/:token',headers,limit,...parse,wrap(async(req,res)=>{if(req.body?.['List-Unsubscribe']!=='One-Click'||Object.keys(req.body||{}).length!==1)throw fail(400,'email_link_invalid');res.json(await unsubscribeBuyer(pool,req.params.token));}));
 // Bounded parsers fail without logging a bearer URL or body.
 app.use('/api/public/buyer-engagement/unsubscribe',(error,req,res,next)=>{res.status(error.status===413?413:400).json({code:'email_link_invalid'});});
}
module.exports={issueEmailLinks,frozenLinksValid,lockManagedActivation,unsubscribeBuyer,exportEmailLinks,checkedOrigin,registerPublicEmailLinks};
