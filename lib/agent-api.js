'use strict';
const { scopeSql, loadGrants, contains } = require('./agent-scopes');
const { getCountryCode } = require('./territories');

// All agent API requests pass here, including legacy/public shortcuts. Routes
// not audited for shared-data isolation are owner-only until explicitly added.
function registerAgentApi({app,pool,auth,getRole}) {
  const guard = auth('agent');
  app.use(async(req,res,next)=>{
    if(getRole(req)!=='agent' || !req.path.startsWith('/api/')) return next();
    const p=req.path;
    if(p==='/api/me' || p==='/api/staff/ping' || p.startsWith('/api/staff/mfa/') || p==='/api/agent/logout') return next();
    guard(req,res,async()=>{
      try {
        const id=req.session.staffUser.id;
        // Refresh role and grants from DB on every request: revoked roles and
        // scopes cannot survive in a cached staff session.
        const user=(await pool.query('SELECT id,role,parent_agent_id,name,email FROM admin_users WHERE id=$1',[id])).rows[0];
        if(user?.role!=='agent') return res.status(403).json({error:'Compte agent révoqué'});
        const grants=await loadGrants(pool,id);
        const q=(sql,args=[])=>pool.query(sql,[id,...args]);
        const s=(alias,country='client_country')=>scopeSql(`${alias}.brand_id`,`UPPER(TRIM(${alias}.${country}))`);
        const brandAllowed=brand=>grants.some(g=>g.brand_id===brand);
        const allowed=(brand,country)=>contains(grants,{brand_id:brand,country_code:getCountryCode(country)});
        // Only requests validated here may bypass legacy single-brand checks.
        const pass=()=>{req.agentScopeAuthorized=true;next();};
        if(p==='/api/agent/me' && req.method==='GET') {
          const brands=(await q('SELECT id,name,logo_url,logo FROM brands WHERE id IN (SELECT brand_id FROM agent_scope_grants WHERE staff_id=$1) ORDER BY name')).rows;
          return res.json({...user,brands,grants});
        }
        if(p==='/api/wholesale-commissions' && req.method==='GET') return pass();
        if(p==='/api/brands' && req.method==='GET') return res.json((await q('SELECT * FROM brands WHERE id IN (SELECT brand_id FROM agent_scope_grants WHERE staff_id=$1) ORDER BY name')).rows);
        if(p==='/api/orders' && req.method==='GET') {
          const limit=Math.max(1,Math.min(Number.parseInt(req.query.limit)||500,2000));
          const offset=Math.max(0,Number.parseInt(req.query.offset)||0);
          const filters=[s('o')], params=[];
          for(const [key,sql] of [['dateFrom','o.created_at >= ?::date'],['dateTo',"o.created_at < (?::date + INTERVAL '1 day')"],['country','UPPER(TRIM(o.client_country)) = UPPER(?)']]) {
            if(req.query[key]) {params.push(req.query[key]);filters.push(sql.replace('?',`$${params.length+1}`));}
          }
          const having=[];
          for(const [key,op] of [['amountMin','>='],['amountMax','<=']]) if(req.query[key]) {
            const value=Number(req.query[key]);if(!Number.isFinite(value)) return res.status(400).json({error:'Montant invalide'});
            params.push(value);having.push(`COALESCE(SUM(ol.quantity*ol.unit_price),0) ${op} $${params.length+1}`);
          }
          const query=`SELECT o.*,b.name AS brand_name,COUNT(ol.id) AS line_count,COALESCE(SUM(ol.quantity*ol.unit_price),0) AS total FROM orders o JOIN brands b ON b.id=o.brand_id LEFT JOIN order_lines ol ON ol.order_id=o.id WHERE ${filters.join(' AND ')} GROUP BY o.id,b.name ${having.length?'HAVING '+having.join(' AND '):''}`;
          const rows=await q(`${query} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,params);
          const total=(await q(`SELECT COUNT(*)::int AS count FROM (${query}) scoped_orders`,params)).rows[0].count;
          return res.json({rows:rows.rows,total});
        }
        if(['/api/buyers','/api/buyers/presence','/api/buyers/presence-detail'].includes(p) && req.method==='GET') {
          const rows=(await q(`SELECT b.id,b.email,b.name,b.company,b.phone,b.country,b.lang,b.created_at,b.last_seen_at FROM buyers b WHERE EXISTS (SELECT 1 FROM orders o WHERE o.buyer_id=b.id AND ${s('o')}) ORDER BY b.created_at DESC`)).rows;
          if(p.endsWith('/presence')) return res.json(rows.filter(b=>b.last_seen_at && Date.now()-new Date(b.last_seen_at)<90000).map(b=>b.id));
          if(p.endsWith('/presence-detail')) return res.json(rows.filter(b=>b.last_seen_at && Date.now()-new Date(b.last_seen_at)<90000));
          return res.json(rows.filter(b=>!req.query.country || b.country?.toLowerCase()===String(req.query.country).toLowerCase()));
        }
        if(['/api/agent-selections','/api/agent-selections/templates','/api/selections/drafts'].includes(p) && req.method==='GET') {
          return res.json((await q(`SELECT a.*,b.name AS brand_name FROM agent_selections a JOIN brands b ON b.id=a.brand_id WHERE ${s('a')} ${p.endsWith('/templates')?'AND a.is_template=true':p.endsWith('/drafts')?"AND a.status='draft'":''} ORDER BY a.created_at DESC LIMIT 1000`)).rows);
        }
        if(p==='/api/admin/appointments' && req.method==='GET') return res.json((await q(`SELECT a.*,b.name AS brand_name FROM appointments a JOIN brands b ON b.id=a.brand_id WHERE ${s('a')} ORDER BY a.slot_date DESC,a.slot_time DESC`)).rows);
        if(p==='/api/stats' && req.method==='GET') {
          const row=(await q(`SELECT COUNT(DISTINCT o.id)::int AS orders_count,COUNT(DISTINCT o.buyer_id)::int AS buyers_count,
            COALESCE(SUM(ol.quantity*ol.unit_price),0) AS revenue_total,
            COALESCE(SUM(ol.quantity*ol.unit_price) FILTER (WHERE o.status='confirmed'),0) AS pending_validation_total,
            COALESCE(SUM(ol.quantity*ol.unit_price) FILTER (WHERE o.status IN ('validated','in_production','shipped')),0) AS validated_orders_total
            FROM orders o LEFT JOIN order_lines ol ON ol.order_id=o.id WHERE o.status NOT IN ('draft','cancelled','archived') AND ${s('o')}`)).rows[0];
          const selections=(await q(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE a.used)::int AS confirmed FROM agent_selections a WHERE NOT COALESCE(a.is_template,false) AND ${s('a')}`)).rows[0];
          return res.json({...row,brands_count:new Set(grants.map(g=>g.brand_id)).size,selections_total:selections.total,selections_confirmed:selections.confirmed,conversion_rate:selections.total?Math.round(selections.confirmed/selections.total*100):0,orders_last30:(await q(`SELECT COUNT(*)::int AS count FROM orders o WHERE o.created_at>=NOW()-INTERVAL '30 days' AND o.status NOT IN ('draft','cancelled') AND ${s('o')}`)).rows[0].count});
        }
        if(p==='/api/admin/badge-counts' && req.method==='GET') {
          const orders=(await q(`SELECT COUNT(*)::int AS count FROM orders o WHERE o.created_at>NOW()-INTERVAL '24 hours' AND ${s('o')}`)).rows[0].count;
          const appointments=(await q(`SELECT COUNT(*)::int AS count FROM appointments a WHERE a.created_at>NOW()-INTERVAL '48 hours' AND ${s('a')}`)).rows[0].count;
          return res.json({new_orders:orders,pending_requests:0,pending_appointments:appointments});
        }
        if(p==='/api/admin/dashboard/priorities' && req.method==='GET') {
          const selections=(await q(`SELECT a.token,a.selection_number,a.client_name,a.client_company,a.expires_at,b.name AS brand_name FROM agent_selections a JOIN brands b ON b.id=a.brand_id WHERE NOT a.used AND a.expires_at BETWEEN NOW() AND NOW()+INTERVAL '48 hours' AND ${s('a')} LIMIT 20`)).rows;
          const orders=(await q(`SELECT o.id,o.order_number,o.client_name,o.client_company,o.created_at,b.name AS brand_name FROM orders o JOIN brands b ON b.id=o.brand_id WHERE o.agent_signature IS NULL AND o.status NOT IN ('draft','cancelled','archived') AND ${s('o')} LIMIT 20`)).rows;
          const appointments=(await q(`SELECT a.id,a.client_name,a.slot_time,b.name AS brand_name FROM appointments a JOIN brands b ON b.id=a.brand_id WHERE a.slot_date=CURRENT_DATE AND ${s('a')}`)).rows;
          const reminders=(await q(`SELECT r.id,r.type,r.label,r.created_at FROM pending_reminders r JOIN agent_selections a ON a.token=r.target_id WHERE r.type='selection_reminder' AND r.status='pending' AND ${s('a')} LIMIT 20`)).rows;
          return res.json({pendingReminders:reminders,todayAppointments:appointments,accessRequests:[],expiringSelections:selections,unsignedOrders:orders,total:reminders.length+appointments.length+selections.length+orders.length});
        }
        if(p==='/api/admin/pending-reminders' && req.method==='GET') return res.json((await q(`SELECT r.* FROM pending_reminders r JOIN agent_selections a ON a.token=r.target_id WHERE r.type='selection_reminder' AND ${s('a')} ORDER BY r.created_at DESC LIMIT 200`)).rows);
        if(p==='/api/dashboard/revenue-chart' && req.method==='GET') return res.json((await q(`SELECT to_char(o.created_at,'Mon') AS month,COALESCE(SUM(l.quantity*l.unit_price),0) AS total FROM orders o LEFT JOIN order_lines l ON l.order_id=o.id WHERE o.status NOT IN ('draft','cancelled') AND o.created_at>=NOW()-INTERVAL '6 months' AND ${s('o')} GROUP BY date_trunc('month',o.created_at),to_char(o.created_at,'Mon') ORDER BY date_trunc('month',o.created_at)`)).rows);
        if(p==='/api/dashboard/top-products' && req.method==='GET') return res.json((await q(`SELECT p.id,p.reference,p.description,p.color,b.name AS brand_name,SUM(l.quantity)::int AS qty,SUM(l.quantity*l.unit_price) AS revenue FROM order_lines l JOIN orders o ON o.id=l.order_id JOIN products p ON p.id=l.product_id JOIN brands b ON b.id=o.brand_id WHERE o.status NOT IN ('draft','cancelled') AND o.created_at>=NOW()-INTERVAL '6 months' AND ${s('o')} GROUP BY p.id,b.name ORDER BY qty DESC LIMIT 8`)).rows);
        if (['/api/orders/export-csv','/api/orders/export/csv','/api/admin/export/orders.xlsx','/api/buyers/export-csv'].includes(p)) return deny();
        let match;
        if((match=p.match(/^\/api\/orders\/([^/]+)(?:\/(pdf|history|events|notes|admin-notes|delivery-window|status|sign|revoke-pdf|resend))?$/))) {
          if(!['GET','PUT','PATCH','POST'].includes(req.method) || (!match[2] && req.method!=='GET')) return deny();
          const row=(await q(`SELECT o.id FROM orders o WHERE o.id=$2 AND ${s('o')}`,[match[1]])).rows[0];
          return row?pass():res.status(404).json({error:'Commande inaccessible'});
        }
        if((match=p.match(/^\/api\/(?:public\/)?brands\/([^/]+)(?:\/(products|products\/export-csv|seasons|linesheet-pdf))?$/)) && req.method==='GET') {
          return brandAllowed(match[1])?pass():deny();
        }
        if((match=p.match(/^\/api\/brands\/([^/]+)\/agent-selection$/)) && req.method==='POST') {
          const country=getCountryCode(req.body.client_country);
          const buyer=(await pool.query('SELECT country FROM buyers WHERE LOWER(email)=LOWER($1)',[String(req.body.client_email||'').trim()])).rows[0];
          if(!country || !buyer || getCountryCode(buyer.country)!==country) return res.status(403).json({error:'Le pays du compte client doit être qualifié par l’owner avant une sélection agent'});
          if(!allowed(match[1],country)) return deny();
          return pass();
        }
        if((match=p.match(/^\/api\/agent-selections\/([^/]+)\/(pdf|history|proposal|items|remind)$/))) {
          if(!['GET','PUT','PATCH','POST'].includes(req.method)) return deny();
          const row=(await q(`SELECT a.token FROM agent_selections a WHERE a.token=$2 AND ${s('a')}`,[match[1]])).rows[0];
          return row?pass():res.status(404).json({error:'Sélection inaccessible'});
        }
        if((match=p.match(/^\/api\/admin\/pending-reminders\/([^/]+)\/(approve|reject)$/)) && req.method==='POST') {
          const row=(await q(`SELECT r.id FROM pending_reminders r JOIN agent_selections a ON a.token=r.target_id WHERE r.id=$2 AND r.type='selection_reminder' AND ${s('a')}`,[match[1]])).rows[0];
          return row?pass():deny();
        }
        if(req.method==='GET' && ['/api/public/branding','/api/public/cgv'].includes(p)) return pass();
        return deny();
        function deny(){return res.status(403).json({error:'Action réservée à l’owner ou hors de vos affectations',code:'agent_scope_denied'});}
      } catch(e) {console.error('[agent-scope]',e.message);res.status(503).json({error:'Vérification des droits indisponible'});}
    });
  });
}
module.exports={registerAgentApi};
