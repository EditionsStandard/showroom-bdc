const crypto=require('node:crypto');
const {csvSafe}=require('./csv');

function registerBuyerCompany({app,pool,auth,getLockedBrandIds,audit}) {
  async function companyFor(buyerId) {
    // New accounts created since startup are initialized on first company use.
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const buyer=(await db.query('SELECT id,company,company_id FROM buyers WHERE id=$1 FOR UPDATE',[buyerId])).rows[0];
      if(!buyer) throw new Error('Buyer unavailable');
      let companyId=buyer.company_id;
      if(!companyId) {
        companyId='legacy:'+buyerId;
        await db.query('INSERT INTO companies(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[companyId,buyer.company]);
        await db.query('UPDATE buyers SET company_id=$1 WHERE id=$2',[companyId,buyerId]);
        await db.query("INSERT INTO company_users(company_id,buyer_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[companyId,buyerId]);
      }
      const membership=(await db.query('SELECT role FROM company_users WHERE company_id=$1 AND buyer_id=$2',[companyId,buyerId])).rows[0];
      await db.query('COMMIT');
      if(!membership) throw new Error('Company membership unavailable');
      return {id:companyId,role:membership.role};
    } catch(e) {await db.query('ROLLBACK');throw e;} finally {db.release();}
  }
  const route=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){console.error('[buyer-company]',e.message);res.status(500).json({error:'Erreur serveur'});}};
  app.get('/api/portal/company',auth,route(async(req,res)=>{
    const member=await companyFor(req.session.buyerPortal.id);
    const [company,locations,users]=await Promise.all([
      pool.query('SELECT * FROM companies WHERE id=$1',[member.id]),
      pool.query('SELECT * FROM company_locations WHERE company_id=$1 ORDER BY created_at',[member.id]),
      pool.query('SELECT b.id,b.name,b.email,cu.role FROM company_users cu JOIN buyers b ON b.id=cu.buyer_id WHERE cu.company_id=$1',[member.id])
    ]);
    res.json({company:company.rows[0],locations:locations.rows,users:users.rows,role:member.role});
  }));
  app.put('/api/portal/company',auth,route(async(req,res)=>{
    const member=await companyFor(req.session.buyerPortal.id);
    if(member.role!=='owner')return res.status(403).json({error:'Company owner required'});
    const name=String(req.body.name || '').trim();
    const billing=req.body.billing;
    if(!name || name.length>200 || !billing || typeof billing!=='object' || Array.isArray(billing) || JSON.stringify(billing).length>5000)return res.status(400).json({error:'Invalid company details'});
    await pool.query('UPDATE companies SET name=$1,billing=$2 WHERE id=$3',[name,billing,member.id]);
    audit(req,'company_updated','company',member.id,'');res.json({ok:true});
  }));
  app.post('/api/portal/company/locations',auth,route(async(req,res)=>{
    const member=await companyFor(req.session.buyerPortal.id);
    if(member.role!=='owner')return res.status(403).json({error:'Company owner required'});
    const name=String(req.body.name || '').trim(),shipping=req.body.shipping;
    if(!name || name.length>200 || !shipping || typeof shipping!=='object' || Array.isArray(shipping) || JSON.stringify(shipping).length>5000)return res.status(400).json({error:'Invalid location'});
    const id=crypto.randomUUID();await pool.query('INSERT INTO company_locations(id,company_id,name,shipping) VALUES($1,$2,$3,$4)',[id,member.id,name,shipping]);
    audit(req,'company_location_added','company',member.id,id);res.json({id});
  }));
  app.post('/api/portal/company/invites',auth,route(async(req,res)=>{
    const member=await companyFor(req.session.buyerPortal.id);
    if(member.role!=='owner')return res.status(403).json({error:'Company owner required'});
    const email=String(req.body.email || '').toLowerCase().trim();
    if(email.length>200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:'Invalid email'});
    const token=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(token).digest('hex');
    await pool.query("INSERT INTO company_invites(token_hash,company_id,email,invited_by,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '7 days')",[hash,member.id,email,req.session.buyerPortal.id]);
    audit(req,'company_user_invited','company',member.id,email);res.json({url:'/portal?company_invite='+token});
  }));
  app.post('/api/portal/company/invites/accept',auth,route(async(req,res)=>{
    const buyer=req.session.buyerPortal,hash=crypto.createHash('sha256').update(String(req.body.token || '')).digest('hex');
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const invite=(await db.query('UPDATE company_invites SET consumed_at=NOW() WHERE token_hash=$1 AND email=LOWER($2) AND consumed_at IS NULL AND expires_at>NOW() RETURNING company_id,role',[hash,buyer.email])).rows[0];
      if(!invite){await db.query('ROLLBACK');return res.status(400).json({error:'Invitation invalid or expired'});}
      await db.query('INSERT INTO company_users(company_id,buyer_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[invite.company_id,buyer.id,invite.role]);
      await db.query('UPDATE buyers SET company_id=$1 WHERE id=$2',[invite.company_id,buyer.id]);
      await db.query('COMMIT');audit(req,'company_invite_accepted','company',invite.company_id,'');res.json({ok:true});
    } catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }));
  async function shortlistFor(id,buyerId) {
    const member=await companyFor(buyerId);
    return (await pool.query('SELECT * FROM buying_shortlists WHERE id=$1 AND (owner_id=$2 OR (shared=true AND company_id=$3))',[id,buyerId,member.id])).rows[0];
  }
  app.get('/api/portal/buying-shortlists',auth,route(async(req,res)=>{
    const buyerId=req.session.buyerPortal.id,member=await companyFor(buyerId);
    res.json((await pool.query('SELECT * FROM buying_shortlists WHERE owner_id=$1 OR (shared=true AND company_id=$2) ORDER BY updated_at DESC',[buyerId,member.id])).rows);
  }));
  app.post('/api/portal/buying-shortlists',auth,route(async(req,res)=>{
    const buyerId=req.session.buyerPortal.id,member=await companyFor(buyerId),name=String(req.body.name || '').trim();
    const notes=String(req.body.notes || ''),ids=req.body.product_ids;
    if(!name || name.length>120 || notes.length>5000 || !Array.isArray(ids) || ids.length>500)return res.status(400).json({error:'Invalid shortlist'});
    const existing=(await pool.query('SELECT id,brand_id FROM products WHERE id=ANY($1)',[ids])).rows;
    const locked=await getLockedBrandIds(buyerId,existing.map(p=>p.brand_id));
    if(existing.some(p=>locked.has(p.brand_id)))return res.status(403).json({error:'Collection in early access'});
    const id=crypto.randomUUID();await pool.query('INSERT INTO buying_shortlists(id,owner_id,company_id,name,notes,product_ids,shared) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,buyerId,member.id,name,notes,JSON.stringify(existing.map(p=>p.id)),req.body.shared===true]);
    audit(req,'shortlist_created','shortlist',id,'');res.json({id});
  }));
  app.patch('/api/portal/buying-shortlists/:id',auth,route(async(req,res)=>{
    const buyerId=req.session.buyerPortal.id,list=await shortlistFor(req.params.id,buyerId);
    if(!list || list.owner_id!==buyerId)return res.status(403).json({error:'Only shortlist owner can edit'});
    const notes=req.body.notes===undefined ? list.notes : String(req.body.notes);
    const name=req.body.name===undefined ? list.name : String(req.body.name).trim();
    if(!name || name.length>120 || notes.length>5000)return res.status(400).json({error:'Invalid shortlist'});
    await pool.query('UPDATE buying_shortlists SET name=$1,notes=$2,shared=$3,ready_for_review=$4,updated_at=NOW() WHERE id=$5',[name,notes,req.body.shared===undefined ? list.shared:req.body.shared===true,req.body.ready_for_review===undefined ? list.ready_for_review:req.body.ready_for_review===true,list.id]);
    audit(req,'shortlist_updated','shortlist',list.id,'');res.json({ok:true});
  }));
  app.get('/api/portal/buying-shortlists/:id/export',auth,route(async(req,res)=>{
    const buyerId=req.session.buyerPortal.id,list=await shortlistFor(req.params.id,buyerId);
    if(!list)return res.status(404).json({error:'Shortlist unavailable'});
    const products=(await pool.query('SELECT p.reference,p.color,p.sizes,p.price,p.brand_id,b.name AS brand_name FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.id=ANY($1) AND p.active!=0',[list.product_ids])).rows;
    const locked=await getLockedBrandIds(buyerId,products.map(p=>p.brand_id));
    const csv=[['brand','reference','color','sizes','current_wholesale_price'],...products.filter(p=>!locked.has(p.brand_id)).map(p=>[p.brand_name,p.reference,p.color,p.sizes,p.price])].map(row=>row.map(value=>'"'+csvSafe(value).replace(/"/g,'""')+'"').join(',')).join('\r\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="shortlist.csv"');res.send(csv);
  }));
}
module.exports={registerBuyerCompany};
