'use strict';

const PROFILE_FIELDS = 'access_source, approved_at, activated_at, first_login_at, last_login_at, last_meaningful_activity_at, login_history_known, last_engagement_email_at';
const NOTICE_VERSION = 'buyer-email-preferences-v1';
const BLOCKED = { cart: 'cart_conversion_not_reliable', brand_interest: 'brand_events_not_collected' };

async function recordLogin(pool, buyerId) {
  if (!buyerId) return;
  await pool.query(`UPDATE buyers SET first_login_at=COALESCE(first_login_at,NOW()),
    last_login_at=NOW(), last_meaningful_activity_at=NOW() WHERE id=$1`, [buyerId]);
}
// A preference from an access request must never overwrite a later withdrawal.
async function captureRequestPreference(db, buyerId, request) {
  const result = await db.query(`INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version,recorded_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`, [buyerId,
    request.privacy_accepted_at ? (request.marketing_consent === true ? 'granted' : 'denied') : 'unknown',
    'access_request:' + request.id, 'access-request:version-unrecorded', request.privacy_accepted_at || new Date()]);
  if (result.rows.length) {
    const p = result.rows[0];
    await db.query(`INSERT INTO buyer_email_preference_events(buyer_id,status,source,notice_version,recorded_at)
      VALUES($1,$2,$3,$4,$5)`, [buyerId,p.status,p.source,p.notice_version,p.recorded_at]);
  }
}
async function exportEngagement(pool, buyerId) {
  const [profile, preference, history] = await Promise.all([
    pool.query(`SELECT ${PROFILE_FIELDS} FROM buyers WHERE id=$1`,[buyerId]),
    pool.query('SELECT status,source,notice_version,recorded_at FROM buyer_email_preferences WHERE buyer_id=$1',[buyerId]),
    pool.query('SELECT status,source,notice_version,recorded_at FROM buyer_email_preference_events WHERE buyer_id=$1 ORDER BY id',[buyerId])
  ]);
  return { cart_simulation:await require('./buyer-cart-engagement').exportCartSimulation(pool,buyerId), activity:profile.rows[0] || null, email_preference:preference.rows[0] || {status:'unknown'}, preference_history:history.rows, simulation_ledger:await require('./buyer-engagement-ledger').exportSimulationLedger(pool,buyerId), preparation_queue:await require('./buyer-engagement-preparation').exportPreparationQueue(pool,buyerId) };
}
// Pure calculation: no job, email, token, event or pending_reminder is created.
function evaluateBuyer(buyer, rule, now = new Date()) {
  const exclude = reason => ({eligible:false,reason});
  if (BLOCKED[rule.id]) return exclude(BLOCKED[rule.id]);
  if (rule.mode !== 'simulation') return exclude('rule_disabled');
  if (buyer.email_status !== 'granted') return exclude('marketing_permission_missing');
  if (!buyer.login_history_known) return exclude('history_unknown');
  const threshold = now.getTime() - rule.delay_hours * 3600000;
  if (rule.id === 'welcome') {
    if (!buyer.approved_at) return exclude('approval_unknown');
    if (buyer.first_login_at || buyer.last_login_at) return exclude('already_logged_in');
    if (new Date(buyer.approved_at).getTime() > threshold) return exclude('delay_not_reached');
    return {eligible:true,reason:buyer.activation_pending ? 'activation_pending' : 'approved_never_logged_in'};
  }
  if (rule.id === 'inactive') {
    if (buyer.activation_pending || !buyer.last_login_at) return exclude('no_completed_login');
    if (!buyer.last_meaningful_activity_at) return exclude('activity_unknown');
    // Presence can only exclude a candidate, never establish inactivity.
    if (buyer.last_seen_at && new Date(buyer.last_seen_at).getTime() > threshold) return exclude('recent_presence');
    if (new Date(buyer.last_meaningful_activity_at).getTime() > threshold) return exclude('recent_activity');
    return {eligible:true,reason:'no_recorded_action_since_threshold'};
  }
  return exclude('unsupported_rule');
}
function registerBuyerEngagement({app,pool,ownerAuth,buyerAuth,audit}) {
  require('./buyer-cart-engagement').registerCartSimulation({app,pool,ownerAuth,audit});
  require('./buyer-engagement-ledger').registerSimulationLedger({app,pool,ownerAuth,audit});
  require('./buyer-engagement-preparation').registerPreparationQueue({app,pool,ownerAuth,audit});
  const wrap = fn => async(req,res) => {
    res.set('Cache-Control','no-store');
    try { await fn(req,res); } catch(error) {
      console.error('[buyer-engagement]',error.message);
      res.status(500).json({error:'Buyer Engagement indisponible'});
    }
  };
  app.get('/api/admin/buyer-engagement',ownerAuth,wrap(async(req,res)=>{
    const limit=100, offset=Math.max(0,Math.min(1000000,Number.parseInt(req.query.offset)||0));
    // One snapshot for rules, buyers, totals and clock, even with concurrent edits.
    const db=await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rules=(await db.query('SELECT * FROM buyer_engagement_rules ORDER BY id')).rows;
      const templates=(await db.query('SELECT DISTINCT ON(rule_id,lang) * FROM buyer_engagement_templates ORDER BY rule_id,lang,version DESC')).rows;
      const buyers=(await db.query(`SELECT b.id,b.name,b.company,b.email,b.activation_pending,b.last_seen_at,
        ${PROFILE_FIELDS.split(', ').map(f=>'b.'+f).join(',')}, COALESCE(p.status,'unknown') AS email_status
        FROM buyers b LEFT JOIN buyer_email_preferences p ON p.buyer_id=b.id ORDER BY b.id LIMIT $1 OFFSET $2`,[limit,offset])).rows;
      const total=(await db.query('SELECT COUNT(*)::int AS count FROM buyers')).rows[0].count;
      const now=(await db.query('SELECT NOW() AS now')).rows[0].now;
      await db.query('COMMIT');
      res.json({mode:'simulation_only',sending_enabled:false,now,total,offset,limit,rules,templates,
        limitations:['activity_covers_login_cart_order_only','no_historic_backfill','no_delivery_metrics'],
        buyers:buyers.map(b=>({...b,evaluations:Object.fromEntries(rules.map(r=>[r.id,evaluateBuyer(b,r,now)]))}))});
    } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }));
  app.put('/api/admin/buyer-engagement/rules/:id',ownerAuth,wrap(async(req,res)=>{
    const {mode,delay_hours,version}=req.body;
    if (!['disabled','simulation'].includes(mode) || !Number.isInteger(delay_hours) || delay_hours<1 || delay_hours>8760 || !Number.isInteger(version))
      return res.status(400).json({error:'Mode ou délai invalide (1 à 8760 heures)'});
    const result=await pool.query(`UPDATE buyer_engagement_rules SET mode=$1,delay_hours=$2,version=version+1,updated_at=NOW()
      WHERE id=$3 AND version=$4 RETURNING *`,[mode,delay_hours,req.params.id,version]);
    if(!result.rows.length) return res.status(409).json({error:'Règle modifiée ailleurs ou introuvable. Rechargez la page.'});
    audit(req,'engagement_rule_updated','engagement_rule',req.params.id);
    res.json(result.rows[0]);
  }));
  app.put('/api/admin/buyer-engagement/templates/:id/:lang',ownerAuth,wrap(async(req,res)=>{
    const {subject,body,version}=req.body;
    if (!['fr','en'].includes(req.params.lang) || typeof subject!=='string' || !subject.trim() || subject.length>200 || /[\r\n]/.test(subject) ||
      typeof body!=='string' || !body.trim() || body.length>10000 || !Number.isInteger(version))
      return res.status(400).json({error:'Modèle invalide'});
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const rule=await db.query('SELECT id FROM buyer_engagement_rules WHERE id=$1 FOR UPDATE',[req.params.id]);
      const latest=await db.query('SELECT MAX(version) AS version FROM buyer_engagement_templates WHERE rule_id=$1 AND lang=$2',[req.params.id,req.params.lang]);
      if(!rule.rows.length || latest.rows[0].version!==version) {
        await db.query('ROLLBACK');return res.status(409).json({error:'Modèle modifié ailleurs ou introuvable. Rechargez la page.'});
      }
      await db.query('INSERT INTO buyer_engagement_templates(rule_id,lang,version,subject,body) VALUES($1,$2,$3,$4,$5)',[req.params.id,req.params.lang,version+1,subject,body]);
      await db.query('COMMIT');
    } catch(error) { await db.query('ROLLBACK');throw error; } finally {db.release();}
    audit(req,'engagement_template_updated','engagement_rule',req.params.id,req.params.lang);
    res.json({ok:true,version:version+1});
  }));
  app.get('/api/portal/email-preferences',buyerAuth,wrap(async(req,res)=>{
    const result=await pool.query('SELECT status,recorded_at FROM buyer_email_preferences WHERE buyer_id=$1',[req.session.buyerPortal.id]);
    res.json(result.rows[0] || {status:'unknown'});
  }));
  app.put('/api/portal/email-preferences',buyerAuth,wrap(async(req,res)=>{
    if(typeof req.body.marketing_consent!=='boolean') return res.status(400).json({error:'Choix explicite requis'});
    const buyerId=req.session.buyerPortal.id, status=req.body.marketing_consent?'granted':'denied';
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT id FROM buyers WHERE id=$1 FOR UPDATE',[buyerId]);
      const changed=await db.query(`INSERT INTO buyer_email_preferences(buyer_id,status,source,notice_version)
        VALUES($1,$2,'buyer_profile',$3) ON CONFLICT(buyer_id) DO UPDATE SET status=$2,source='buyer_profile',notice_version=$3,recorded_at=NOW()
        WHERE buyer_email_preferences.status IS DISTINCT FROM $2 RETURNING buyer_id`,[buyerId,status,NOTICE_VERSION]);
      if(changed.rowCount) await db.query(`INSERT INTO buyer_email_preference_events(buyer_id,status,source,notice_version)
        VALUES($1,$2,'buyer_profile',$3)`,[buyerId,status,NOTICE_VERSION]);
      await db.query('COMMIT');
    } catch(error) { await db.query('ROLLBACK');throw error; } finally {db.release();}
    res.json({ok:true,status});
  }));
}
module.exports={recordLogin,captureRequestPreference,exportEngagement,evaluateBuyer,registerBuyerEngagement};
