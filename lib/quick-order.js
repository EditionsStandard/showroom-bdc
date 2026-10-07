const rules=require('../public/ordering-rules');
const {splitCSVLines,parseCSVRow}=require('./csv');
function registerQuickOrder({app,pool,auth,getLockedBrandIds}) {
  app.post('/api/portal/quick-order/reconcile',auth,async(req,res)=>{
    try {
      let rows=req.body.rows;
      if(typeof req.body.csv==='string') {
        if(req.body.csv.length>100000)return res.status(400).json({error:'CSV too large'});
        const csv=splitCSVLines(req.body.csv).filter(s=>s.trim()).map(s=>parseCSVRow(s));
        if(csv[0]?.[0]?.toLowerCase().trim()==='reference')csv.shift();
        rows=csv.map(([reference,quantity,color,size])=>({reference,quantity,color,size}));
      }
      if(!Array.isArray(rows) || !rows.length || rows.length>500)return res.status(400).json({error:'1–500 rows required'});
      const buyerId=req.session.buyerPortal.id;
      const brandId=String(req.body.brand_id || '');
      const brand=(await pool.query('SELECT b.*,bt.min_per_reference_override FROM brands b LEFT JOIN buyer_brand_terms bt ON bt.brand_id=b.id AND bt.buyer_id=$2 WHERE b.id=$1',[brandId,buyerId])).rows[0];
      if(!brand || brand.subscription_status==='inactive' || (await getLockedBrandIds(buyerId,[brandId])).size)return res.status(403).json({error:'Brand unavailable'});
      const products=(await pool.query('SELECT * FROM products WHERE brand_id=$1 AND active!=0 AND (reference=ANY($2) OR id=ANY($3))',[brandId,rows.map(r=>String(r?.reference || '')),rows.map(r=>String(r?.product_id || ''))])).rows;
      const lines=[],errors=[];
      for(const [index,row] of rows.entries()) {
        const matches=products.filter(p=>row?.product_id ? p.id===row.product_id:p.reference===String(row?.reference || '').trim());
        const p=matches.length===1 ? matches[0]:null;
        const qty=Number(row?.quantity),size=String(row?.size || '').trim(),color=String(row?.color || p?.color || '').trim();
        const issue=rules.catalogIssue(p,{qty,size,color},{requireSize:true});
        const messages={unavailable:'Reference unavailable',quantity:'Positive integer quantity required',size:'Choose an available size',color:'Color unavailable',stock:'Insufficient stock'};
        const error=!p && matches.length>1 ? 'Ambiguous reference: use product ID' : issue ? messages[issue] : null;
        if(error){errors.push({row:index+1,reference:row?.reference || '',error});continue;}
        lines.push({brand_id:brand.id,brand_name:brand.name,product_id:p.id,reference:p.reference,color,size,qty,price:p.price,price_retail:p.price_retail,description:p.description,image_url:p.image_url});
      }
      const totals=rules.aggregate(lines);
      const min=rules.minimum(brand);
      for(const [key,quantity] of totals)if(quantity<min)errors.push({reference:JSON.parse(key)[1],error:`Minimum ${min} pc(s) per reference; current ${quantity}`,required_minimum:min,current_quantity:quantity});
      for(const p of products) {
        const quantity=lines.filter(l=>l.product_id===p.id).reduce((n,l)=>n+l.qty,0);
        if(p.stock_enabled && p.stock_qty!==null && quantity>p.stock_qty)errors.push({reference:p.reference,error:'Insufficient stock',available:p.stock_qty});
      }
      res.json({brand,lines,errors,ok:errors.length===0});
    }catch(e){console.error('[quick-order]',e.message);res.status(500).json({error:'Unable to review quick order'});}
  });
}
module.exports={registerQuickOrder};
