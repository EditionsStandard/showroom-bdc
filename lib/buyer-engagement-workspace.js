'use strict';
// Read-only presentation: reuse current candidate engines and recorded facts.
// No sender, CRM writer, scheduler, inferred attribution or historic backfill.
const {activeOrdersSql}=require('./commercial-metrics');
async function buyerSummary(pool,days){
  const db=await pool.connect();
  try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='15s'");
    const now=(await db.query('SELECT NOW() AS now,NOW()-make_interval(days=>$1) AS since',[days])).rows[0];
    const rules=(await db.query("SELECT * FROM buyer_engagement_rules WHERE id IN ('welcome','inactive') ORDER BY id")).rows;
    const paused=(await db.query('SELECT paused FROM buyer_engagement_simulation_control WHERE id=true')).rows[0].paused;
    const buyers=(await db.query(`SELECT b.id,b.name,b.company,b.email,b.lang,b.activation_pending,b.login_history_known,b.approved_at,b.first_login_at,b.last_login_at,b.last_seen_at,b.last_meaningful_activity_at,b.last_engagement_email_at,
      COALESCE(p.status,'unknown') AS email_status,
      EXISTS(SELECT 1 FROM buyer_engagement_provider_blocks s WHERE s.buyer_id=b.id AND s.recipient_hash=encode(sha256(convert_to(lower(btrim(b.email)),'UTF8')),'hex')) AS provider_blocked
      FROM buyers b LEFT JOIN buyer_email_preferences p ON p.buyer_id=b.id ORDER BY b.id LIMIT 10001`)).rows;
    if(buyers.length>10000)throw Object.assign(Error('workspace_cohort_limit'),{code:'workspace_cohort_limit'});
    const evaluate=require('./buyer-engagement').evaluateBuyer,actions={};
    for(const rule of rules){const rows=buyers.filter(b=>!paused&&!b.provider_blocked&&b.approved_at&&+b.approved_at<=+now.now&&(!b.first_login_at||+b.first_login_at<=+now.now)&&(!b.last_login_at||+b.last_login_at<=+now.now)&&(!b.last_meaningful_activity_at||+b.last_meaningful_activity_at<=+now.now)&&(!b.last_engagement_email_at||+b.last_engagement_email_at<=+now.now-86400000)&&evaluate(b,rule,now.now).eligible);
      actions[rule.id]={now:now.now,rule,paused,count:rows.length,rows:rows.slice(0,8).map(b=>({buyer_id:b.id,buyer_name:b.name,company:b.company,lang:b.lang,approved_at:b.approved_at,last_meaningful_activity_at:b.last_meaningful_activity_at}))};}
    const results=(await db.query(`SELECT
      (SELECT COUNT(*)::int FROM buyers WHERE activated_at>=$1 AND activated_at<=$2 AND NOT activation_pending) AS activations,
      (SELECT COUNT(*)::int FROM buyers WHERE first_login_at>=$1 AND first_login_at<=$2) AS first_observed_logins,
      (SELECT COUNT(*)::int FROM orders o WHERE ${activeOrdersSql('o')} AND o.buyer_id IS NOT NULL AND o.created_at>=$1 AND o.created_at<=$2) AS active_orders,
      (SELECT COUNT(DISTINCT r.order_id)::int FROM buyer_cart_checkout_results r JOIN orders o ON o.id=r.order_id AND o.buyer_id=r.buyer_id
        JOIN buyer_cart_cycles c ON c.cycle_id=r.cycle_id AND c.buyer_id=r.buyer_id AND c.state='converted' AND c.converted_order_id=r.order_id
        WHERE r.success AND ${activeOrdersSql('o')} AND r.created_at>=$1 AND r.created_at<=$2 AND o.created_at>=$1 AND o.created_at<=$2) AS cart_orders`,[now.since,now.now])).rows[0];
    await db.query('COMMIT');return {now:now.now,buyers_scanned:buyers.length,actions,results:{...results,from:now.since,to:now.now,days,attributed_orders:null,attribution_available:false}};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function getWorkspace(pool,{days='30'}={}){
  if(!['string','number'].includes(typeof days)||!['7','30','90'].includes(String(days)))throw Object.assign(Error('invalid_workspace_period'),{status:400,code:'invalid_workspace_period'});
  const [buyers,cart,brand]=await Promise.allSettled([buyerSummary(pool,Number(days)),require('./buyer-cart-engagement').getCartActionSummary(pool),require('./buyer-brand-interest').getBrandActionSummary(pool)]);
  const failure=result=>({status:'unavailable',reason:/cohort_limit/.test(result.reason?.code||'')?'cohort_limit':'temporarily_unavailable'});
  const actions=buyers.status==='fulfilled'?Object.fromEntries(Object.entries(buyers.value.actions).map(([key,value])=>[key,{status:'available',...value}])):{welcome:failure(buyers),inactive:failure(buyers)};
  actions.cart=cart.status==='fulfilled'?{status:'available',...cart.value}:failure(cart);actions.brand_interest=brand.status==='fulfilled'?{status:'available',...brand.value}:failure(brand);
  return {mode:'simulation_only',sending_enabled:false,read_only:true,days:Number(days),actions,results:buyers.status==='fulfilled'?{status:'available',...buyers.value.results}:failure(buyers),
    partial:Object.values(actions).some(a=>a.status!=='available'),buyers_scanned:buyers.status==='fulfilled'?buyers.value.buyers_scanned:null};
}
function registerWorkspace({app,pool,ownerAuth}){
  app.get('/api/admin/buyer-engagement/workspace',ownerAuth,async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await getWorkspace(pool,req.query));}catch(error){res.status(error.status||503).json({code:error.status?error.code:'workspace_unavailable'});}});
}
module.exports={getWorkspace,registerWorkspace};
