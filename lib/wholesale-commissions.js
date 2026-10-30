'use strict';
const { randomUUID } = require('node:crypto');
const { getCountryCode } = require('./territories');
const { scopeSql } = require('./agent-scopes');
const transitions = { draft: ['approved','cancelled'], approved: ['invoiced','cancelled'], invoiced: ['paid','cancelled'], paid: [], cancelled: [] };
function validateCommission(body) {
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
  if (!text(body.brand_id,100) || !getCountryCode(body.country_code)) throw new Error('Marque et pays ISO requis');
  if (!['agency_receivable','agent_payable','subagent_payable'].includes(body.kind)) throw new Error('Type de commission requis');
  if (!['ordered_net','invoiced_net','collected_net','manual_net'].includes(body.basis_kind)) throw new Error('Assiette requise');
  // Decimal strings avoid exponent notation, silent parseFloat truncation and rounding inputs.
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(String(body.basis_amount))) throw new Error('Assiette positive, 2 décimales maximum');
  if (!/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/.test(String(body.rate_percent)) || Number(body.rate_percent) > 100) throw new Error('Taux de 0 à 100, 4 décimales maximum');
  if (!text(body.currency,3) || !/^[A-Z]{3}$/.test(body.currency)) throw new Error('Devise requise (code ISO à 3 lettres)');
  if (!text(body.source_reference,1000)) throw new Error('Référence du justificatif requise');
  if (body.kind !== 'agency_receivable' && !text(body.beneficiary_id,100)) throw new Error('Bénéficiaire requis');
  if (body.kind === 'agency_receivable' && body.beneficiary_id) throw new Error('Une créance agence ne doit pas avoir de bénéficiaire agent');
  if (body.order_id != null && !text(body.order_id,100)) throw new Error('Commande invalide');
  return { ...body, country_code: getCountryCode(body.country_code), beneficiary_id: body.beneficiary_id || null, order_id: body.order_id || null, source_reference: body.source_reference.trim() };
}
function registerWholesaleCommissions({app,pool,auth,audit}) {
  const actor = req => req.session?.staffUser?.email || 'owner';
  app.get('/api/wholesale-commissions', auth('owner','agent'), async(req,res) => {
    try {
      const agent = req.userRole === 'agent';
      const rows = await pool.query(`SELECT c.*,b.name AS brand_name,u.name AS beneficiary_name
        FROM wholesale_commissions c JOIN brands b ON b.id=c.brand_id
        LEFT JOIN admin_users u ON u.id=c.beneficiary_id
        ${agent ? `WHERE c.beneficiary_id=$1 AND c.status <> 'draft' AND ${scopeSql('c.brand_id','c.country_code')}` : ''}
        ORDER BY c.created_at DESC LIMIT 1000`, agent ? [req.session.staffUser.id] : []);
      // No totals across currencies, no automatic inference from order value.
      res.json(rows.rows);
    } catch(e) { res.status(500).json({error:'Lecture des commissions impossible'}); }
  });
  app.post('/api/wholesale-commissions', auth('owner'), async(req,res) => {
    let body;
    try { body=validateCommission(req.body); } catch(e) { return res.status(400).json({error:e.message}); }
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtext('agent-scope-edits'))");
      if(body.beneficiary_id) {
        const beneficiary=(await db.query('SELECT role,parent_agent_id FROM admin_users WHERE id=$1 FOR SHARE',[body.beneficiary_id])).rows[0];
        if(beneficiary?.role!=='agent' || Boolean(beneficiary.parent_agent_id)!==(body.kind==='subagent_payable')) throw new Error('Type de bénéficiaire incohérent');
        const grant=await db.query(`SELECT 1 FROM agent_scope_grants WHERE staff_id=$1 AND brand_id=$2 AND country_code IN ('*',$3)`,[body.beneficiary_id,body.brand_id,body.country_code]);
        if(!grant.rows.length) throw new Error('Bénéficiaire non affecté à cette marque et ce pays');
      }
      if(body.order_id) {
        const order=(await db.query('SELECT brand_id,client_country FROM orders WHERE id=$1 FOR SHARE',[body.order_id])).rows[0];
        if(!order || order.brand_id!==body.brand_id || getCountryCode(order.client_country)!==body.country_code) throw new Error('Commande, marque et pays incohérents (pays ISO requis)');
      }
      const id=randomUUID();
      const result=await db.query(`INSERT INTO wholesale_commissions(id,brand_id,order_id,beneficiary_id,kind,country_code,currency,basis_kind,basis_amount,rate_percent,source_reference,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[id,body.brand_id,body.order_id,body.beneficiary_id,body.kind,body.country_code,body.currency,body.basis_kind,body.basis_amount,body.rate_percent,body.source_reference,actor(req)]);
      await db.query('INSERT INTO wholesale_commission_events(commission_id,actor,new_status,reference) VALUES($1,$2,$3,$4)',[id,actor(req),'draft',body.source_reference]);
      await db.query('COMMIT');
      audit(req,'commission_created','commission',id,body.kind);
      res.status(201).json(result.rows[0]);
    } catch(e) { await db.query('ROLLBACK'); res.status(400).json({error:e.code==='23503'?'Marque, commande ou bénéficiaire inconnu':e.message}); }
    finally {db.release();}
  });
  app.patch('/api/wholesale-commissions/:id/status',auth('owner'),async(req,res)=>{
    const {status,reference,version}=req.body;
    if(!Number.isSafeInteger(version) || typeof reference!=='string' || !reference.trim() || reference.length>1000) return res.status(400).json({error:'Version et justificatif du changement requis'});
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const row=(await db.query('SELECT * FROM wholesale_commissions WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!row) {await db.query('ROLLBACK');return res.status(404).json({error:'Commission introuvable'});}
      if(row.version!==version || !transitions[row.status].includes(status)) {await db.query('ROLLBACK');return res.status(409).json({error:'Version périmée ou transition interdite'});}
      const result=await db.query('UPDATE wholesale_commissions SET status=$1,updated_at=NOW(),version=version+1 WHERE id=$2 RETURNING *',[status,row.id]);
      await db.query('INSERT INTO wholesale_commission_events(commission_id,actor,old_status,new_status,reference) VALUES($1,$2,$3,$4,$5)',[row.id,actor(req),row.status,status,reference.trim()]);
      await db.query('COMMIT');
      audit(req,'commission_status','commission',row.id,`${row.status} → ${status}`);
      res.json(result.rows[0]);
    } catch(e) {await db.query('ROLLBACK');res.status(500).json({error:'Mise à jour impossible'});} finally {db.release();}
  });
  app.get('/api/wholesale-commissions/:id/history',auth('owner'),async(req,res)=>{
    try {res.json((await pool.query('SELECT actor,old_status,new_status,reference,created_at FROM wholesale_commission_events WHERE commission_id=$1 ORDER BY id',[req.params.id])).rows);}
    catch(e) {res.status(500).json({error:'Historique indisponible'});}
  });
}
module.exports={validateCommission,transitions,registerWholesaleCommissions};
