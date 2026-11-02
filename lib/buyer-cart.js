'use strict';
const {createHash,randomUUID}=require('node:crypto');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validUuid=value=>typeof value==='string'&&UUID.test(value);
const MAX_CART_BYTES=100000;
class CartError extends Error {
  constructor(status,code,message) {
    super(message);this.cartError=true;this.status=status;this.result={error:message,code};
  }
}
const fail=(code,message,status=409)=>{throw new CartError(status,code,message);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function stable(value) {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
const digest=value=>createHash('sha256').update(stable(value)).digest('hex');
const compare=(left,right)=>left<right?-1:left>right?1:0;
const EMPTY_HASH=digest([]);
function clone(value) {return JSON.parse(JSON.stringify(value));}
function revision(value) {
  const number=Number(value);
  if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isSafeInteger(number)||number<0)
    fail('invalid_cart_revision','Révision du panier invalide.',400);
  return number;
}
function identifier(value,label) {
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>200)
    fail('invalid_cart_line',label+' invalide.',400);
  return value;
}
function text(value,max=10000) {
  if(value===undefined||value===null)return '';
  if(typeof value!=='string'||value.length>max)fail('invalid_cart_line','Ligne de panier invalide.',400);
  return value;
}
function lineIntent(line,fromCart=false,strict=true) {
  if(!object(line)) {
    if(strict)fail('invalid_cart_line','Ligne de panier invalide.',400);
    return null;
  }
  try {
    const brand_id=identifier(line.brand_id,'Marque'),product_id=identifier(line.product_id,'Produit');
    const rawQuantity=fromCart?line.qty:line.quantity;
    // Historic JSON can contain numeric strings. Reading their intent must not
    // turn a later type-only normalization into a newly observed cart action.
    const quantity=!strict&&typeof rawQuantity==='string'&&rawQuantity.trim()!==''?Number(rawQuantity):rawQuantity;
    if(typeof quantity!=='number'||!Number.isInteger(quantity)||quantity<1||quantity>100000)
      fail('invalid_cart_line','Quantité de panier invalide.',400);
    const size=text(line.size,200),variant_color=text(fromCart?(line.color??line.variant_color):line.variant_color,60),note=text(line.note);
    if(variant_color!==variant_color.trim())fail('invalid_cart_line','Coloris de panier invalide.',400);
    return {brand_id,product_id,size,quantity,note,variant_color};
  } catch(error) {if(strict)throw error;return null;}
}
function groupIntents(lines) {
  const groups=new Map();
  for(const line of lines) {
    if(!line)continue;
    if(!groups.has(line.brand_id))groups.set(line.brand_id,[]);
    groups.get(line.brand_id).push([line.product_id,line.size,line.quantity,line.note,line.variant_color]);
  }
  for(const rows of groups.values())rows.sort((a,b)=>compare(stable(a),stable(b)));
  return groups;
}
function cartGroups(cart,strict=false) {
  if(!object(cart)) {
    if(strict)fail('invalid_cart','Panier invalide.',400);
    return new Map();
  }
  if(strict&&Object.keys(cart).length>500)fail('invalid_cart','Panier trop volumineux.',400);
  return groupIntents(Object.values(cart).map(row=>lineIntent(row,true,strict)));
}
function parseLegacy(value) {
  try{return JSON.parse(value||'{}')??{};}catch{return {};}
}
function checkedCart(cart,strict) {
  if(strict&&!object(cart))fail('invalid_cart','Panier invalide.',400);
  let encoded;
  try {encoded=JSON.stringify(cart??{});}catch{fail('invalid_cart','Panier invalide.',400);}
  if(!encoded||Buffer.byteLength(encoded)>MAX_CART_BYTES)fail('invalid_cart','Panier trop volumineux.',400);
  const copy=JSON.parse(encoded);cartGroups(copy,strict);return copy;
}
function toSnapshot(state,cycles) {
  return {cart_id:state.cart_id,revision:revision(state.revision),cart:state.cart_json,
    cycles:cycles.map(row=>({brand_id:row.brand_id,cycle_id:row.cycle_id,revision:revision(row.revision),
      state:row.state,provenance:row.provenance,content_hash:row.content_hash,
      changed_at:row.changed_at,converted_order_id:row.converted_order_id}))};
}

function createBuyerCartService(pool) {
  async function transaction(fn) {
    const db=await pool.connect();
    try {await db.query('BEGIN');const value=await fn(db);await db.query('COMMIT');return value;}
    catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
    finally{db.release();}
  }
  async function lock(db,buyerId) {await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',['cart:'+buyerId]);}
  async function ensureState(db,buyerId) {
    const existing=(await db.query('SELECT * FROM buyer_cart_states WHERE buyer_id=$1 FOR UPDATE',[buyerId])).rows[0];
    if(existing)return existing;
    const legacy=(await db.query('SELECT cart_json,updated_at::timestamptz AS updated_at FROM buyer_carts WHERE buyer_id=$1',[buyerId])).rows[0];
    const cart=parseLegacy(legacy?.cart_json),cartId=randomUUID();
    const state=(await db.query(`INSERT INTO buyer_cart_states(buyer_id,cart_id,cart_json,updated_at)
      VALUES($1,$2,$3,COALESCE($4::timestamptz,NOW())) RETURNING *`,[buyerId,cartId,JSON.stringify(cart),legacy?.updated_at??null])).rows[0];
    for(const [brandId,items] of cartGroups(cart))await db.query(`INSERT INTO buyer_cart_cycles
      (cycle_id,buyer_id,brand_id,state,provenance,content_hash,changed_at)
      VALUES($1,$2,$3,'unknown','legacy_unknown',$4,$5)`,[randomUUID(),buyerId,brandId,digest(items),state.updated_at]);
    return state;
  }
  async function cyclesFor(db,buyerId) {
    return (await db.query('SELECT * FROM buyer_cart_cycles WHERE buyer_id=$1 AND is_current ORDER BY brand_id',[buyerId])).rows;
  }
  async function snapshotLocked(db,buyerId) {
    const state=await ensureState(db,buyerId);return toSnapshot(state,await cyclesFor(db,buyerId));
  }
  async function snapshot(buyerId) {return transaction(async db=>{await lock(db,buyerId);return snapshotLocked(db,buyerId);});}
  async function mirror(db,buyerId,cart,changed=true) {
    if(!changed)return;
    await db.query(`INSERT INTO buyer_carts(buyer_id,cart_json,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(buyer_id) DO UPDATE SET cart_json=EXCLUDED.cart_json,updated_at=EXCLUDED.updated_at`,[buyerId,JSON.stringify(cart)]);
  }
  async function replaceCycle(db,buyerId,brandId,old,state,provenance,hash) {
    if(old)await db.query('UPDATE buyer_cart_cycles SET is_current=false WHERE cycle_id=$1',[old.cycle_id]);
    await db.query(`INSERT INTO buyer_cart_cycles(cycle_id,buyer_id,brand_id,state,provenance,content_hash)
      VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),buyerId,brandId,state,provenance,hash]);
  }
  async function save(buyerId,body) {
    if(!object(body)||!validUuid(body.cart_id))fail('invalid_cart','Identité du panier invalide.',400);
    const expectedRevision=revision(body.revision),cart=checkedCart(body.cart,true);
    return transaction(async db=>{
      await lock(db,buyerId);const state=await ensureState(db,buyerId);
      if(state.cart_id!==body.cart_id.toLowerCase()||revision(state.revision)!==expectedRevision)
        fail('cart_conflict','Le panier a été modifié ailleurs. Rechargez-le avant de réessayer.');
      if(stable(state.cart_json)===stable(cart))return toSnapshot(state,await cyclesFor(db,buyerId));
      const before=cartGroups(state.cart_json),after=cartGroups(cart,true),current=await cyclesFor(db,buyerId);
      const oldByBrand=new Map(current.map(row=>[row.brand_id,row]));let semanticChange=false;
      for(const brandId of new Set([...before.keys(),...after.keys()])) {
        const previous=before.get(brandId)||[],next=after.get(brandId)||[];
        if(stable(previous)===stable(next))continue;
        semanticChange=true;const old=oldByBrand.get(brandId),hash=digest(next),nextState=next.length?'open':'empty';
        if(!old||['unknown','empty','converted'].includes(old.state))
          await replaceCycle(db,buyerId,brandId,old,nextState,'versioned',hash);
        else await db.query(`UPDATE buyer_cart_cycles SET revision=revision+1,state=$2,provenance='versioned',
          content_hash=$3,changed_at=NOW(),converted_order_id=NULL WHERE cycle_id=$1`,[old.cycle_id,nextState,hash]);
      }
      const updated=(await db.query(`UPDATE buyer_cart_states SET cart_json=$2,revision=revision+1,updated_at=NOW()
        WHERE buyer_id=$1 RETURNING *`,[buyerId,JSON.stringify(cart)])).rows[0];
      await mirror(db,buyerId,cart);
      if(semanticChange)await db.query('UPDATE buyers SET last_meaningful_activity_at=NOW() WHERE id=$1',[buyerId]);
      return toSnapshot(updated,await cyclesFor(db,buyerId));
    });
  }
  async function saveLegacy(buyerId,input) {
    const cart=checkedCart(input,false);
    return transaction(async db=>{
      await lock(db,buyerId);const state=await ensureState(db,buyerId),current=await cyclesFor(db,buyerId);
      const changed=stable(state.cart_json)!==stable(cart),groups=cartGroups(cart),oldByBrand=new Map(current.map(row=>[row.brand_id,row]));
      let certaintyChanged=false;
      for(const brandId of new Set([...groups.keys(),...oldByBrand.keys()])) {
        const old=oldByBrand.get(brandId),items=groups.get(brandId)||[],hash=digest(items);
        if(old?.state==='converted'&&!items.length)continue;
        if(old?.state==='unknown'&&old.provenance==='legacy_unknown'&&old.content_hash===hash)continue;
        certaintyChanged=true;
        if(!old||old.state==='converted')await replaceCycle(db,buyerId,brandId,old,'unknown','legacy_unknown',hash);
        else await db.query(`UPDATE buyer_cart_cycles SET revision=revision+1,state='unknown',provenance='legacy_unknown',
          content_hash=$2,changed_at=NOW(),converted_order_id=NULL WHERE cycle_id=$1`,[old.cycle_id,hash]);
      }
      if(changed||certaintyChanged)await db.query(`UPDATE buyer_cart_states SET cart_json=$2,revision=revision+1,
        updated_at=CASE WHEN $3 THEN NOW() ELSE updated_at END WHERE buyer_id=$1`,[buyerId,JSON.stringify(cart),changed]);
      await mirror(db,buyerId,cart,changed);
      if(changed&&object(cart)&&Object.keys(cart).length)await db.query('UPDATE buyers SET last_meaningful_activity_at=NOW() WHERE id=$1',[buyerId]);
      return snapshotLocked(db,buyerId);
    });
  }
  async function invalidateLegacyOrder(db,buyerId,brandId) {
    await lock(db,buyerId);await ensureState(db,buyerId);
    const cycle=(await db.query('SELECT * FROM buyer_cart_cycles WHERE buyer_id=$1 AND brand_id=$2 AND is_current',[buyerId,brandId])).rows[0];
    if(cycle?.state==='converted')await replaceCycle(db,buyerId,brandId,cycle,'unknown','legacy_unknown',EMPTY_HASH);
    else if(cycle)await db.query(`UPDATE buyer_cart_cycles SET revision=revision+1,state='unknown',provenance='legacy_unknown',
      changed_at=NOW(),converted_order_id=NULL WHERE cycle_id=$1`,[cycle.cycle_id]);
    else await replaceCycle(db,buyerId,brandId,null,'unknown','legacy_unknown',EMPTY_HASH);
    await db.query('UPDATE buyer_cart_states SET revision=revision+1 WHERE buyer_id=$1',[buyerId]);
  }
  function reservationFor(row) {
    const reservation={buyerId:row.buyer_id,request_key:row.request_key,cart_id:row.cart_id,
      expected_cycles:row.expected_cycles,brands:Object.keys(row.expected_cycles).sort()};
    reservation.context=brandId=>{
      const expected=reservation.expected_cycles[brandId];
      if(!expected)fail('invalid_checkout_brand','Marque absente de la réservation.',400);
      const context={brand_id:brandId,...expected};
      async function receipt(db) {
        return (await db.query(`SELECT result_json FROM buyer_cart_checkout_results
          WHERE buyer_id=$1 AND request_key=$2 AND brand_id=$3`,[reservation.buyerId,reservation.request_key,brandId])).rows[0]?.result_json??null;
      }
      async function current(db) {
        const cycle=(await db.query('SELECT * FROM buyer_cart_cycles WHERE cycle_id=$1 AND buyer_id=$2',[expected.cycle_id,reservation.buyerId])).rows[0];
        if(!cycle||!cycle.is_current||cycle.state==='converted'||revision(cycle.revision)!==revision(expected.revision)||cycle.content_hash!==expected.content_hash)
          fail('cart_conflict','Cette sélection a changé ou a déjà été commandée. Rechargez le panier.');
        return cycle;
      }
      context.replay=()=>transaction(async db=>{await lock(db,reservation.buyerId);return receipt(db);});
      context.beforeCreate=async db=>{await lock(db,reservation.buyerId);const old=await receipt(db);if(old)return old;await current(db);return null;};
      context.complete=async(db,orderId,result)=>{
        await lock(db,reservation.buyerId);
        if(await receipt(db))fail('checkout_already_recorded','Cette demande a déjà été enregistrée.');
        await current(db);const state=await ensureState(db,reservation.buyerId),cart=clone(state.cart_json);
        if(!object(cart))fail('cart_conflict','Le panier doit être rechargé.');
        for(const key of Object.keys(cart))if(cart[key]?.brand_id===brandId)delete cart[key];
        const completed={...clone(result),brand_id:brandId,order_id:orderId};
        await db.query(`UPDATE buyer_cart_cycles SET state='converted',revision=revision+1,
          converted_order_id=$2,changed_at=NOW() WHERE cycle_id=$1`,[expected.cycle_id,orderId]);
        await db.query('UPDATE buyer_cart_states SET cart_json=$2,revision=revision+1,updated_at=NOW() WHERE buyer_id=$1',[reservation.buyerId,JSON.stringify(cart)]);
        await mirror(db,reservation.buyerId,cart);
        await db.query(`INSERT INTO buyer_cart_checkout_results(buyer_id,request_key,brand_id,cycle_id,order_id,success,result_json)
          VALUES($1,$2,$3,$4,$5,true,$6)`,[reservation.buyerId,reservation.request_key,brandId,expected.cycle_id,orderId,JSON.stringify(completed)]);
        return completed;
      };
      return context;
    };
    return reservation;
  }
  async function reserveCheckout(buyerId,body,effectiveContext={}) {
    if(!object(body)||!validUuid(body.request_key))fail('invalid_checkout_key','Identifiant de demande invalide.',400);
    if(!object(effectiveContext))fail('invalid_checkout_context','Contexte de commande invalide.',400);
    const payload=clone(body);
    if(Array.isArray(payload.lines))payload.lines.sort((a,b)=>compare(stable(a),stable(b)));
    const hash=digest(payload),contextHash=digest(effectiveContext),key=body.request_key.toLowerCase();
    return transaction(async db=>{
      await lock(db,buyerId);
      const existing=(await db.query('SELECT * FROM buyer_cart_checkouts WHERE buyer_id=$1 AND request_key=$2',[buyerId,key])).rows[0];
      if(existing) {
        if(existing.request_hash!==hash)fail('checkout_key_conflict','Cette demande a déjà été utilisée avec un autre contenu.');
        const recorded=Number((await db.query('SELECT COUNT(*) AS count FROM buyer_cart_checkout_results WHERE buyer_id=$1 AND request_key=$2',[buyerId,key])).rows[0].count);
        if(recorded<Object.keys(existing.expected_cycles).length&&existing.context_hash!==contextHash)
          fail('checkout_context_changed','Vos coordonnées ont changé. Vérifiez votre panier et créez une nouvelle demande.');
        return reservationFor(existing);
      }
      if(!validUuid(body.cart_id))fail('invalid_cart','Identité du panier invalide.',400);
      const expectedRevision=revision(body.revision);
      if(!Array.isArray(body.lines)||!body.lines.length||body.lines.length>500)fail('invalid_checkout_lines','Sélection vide ou trop volumineuse.',400);
      const groups=groupIntents(body.lines.map(line=>lineIntent(line))),state=await ensureState(db,buyerId);
      if(state.cart_id!==body.cart_id.toLowerCase()||revision(state.revision)!==expectedRevision)
        fail('cart_conflict','Le panier a été modifié ailleurs. Rechargez-le avant de commander.');
      const stored=cartGroups(state.cart_json,true),cycles=new Map((await cyclesFor(db,buyerId)).map(row=>[row.brand_id,row])),expected=Object.create(null);
      for(const [brandId,items] of groups) {
        const cycle=cycles.get(brandId),hash=digest(items);
        if(!cycle||cycle.state==='converted'||!stored.has(brandId)||stable(items)!==stable(stored.get(brandId))||cycle.content_hash!==hash)
          fail('cart_conflict','Les lignes commandées ne correspondent plus au panier enregistré.');
        expected[brandId]={cycle_id:cycle.cycle_id,revision:revision(cycle.revision),content_hash:hash};
      }
      const row=(await db.query(`INSERT INTO buyer_cart_checkouts(buyer_id,request_key,request_hash,context_hash,cart_id,expected_cycles)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[buyerId,key,hash,contextHash,state.cart_id,JSON.stringify(expected)])).rows[0];
      return reservationFor(row);
    });
  }
  async function recordResult(reservation,brandId,result) {
    if(!object(result)||!result.error)fail('invalid_checkout_result','Résultat de commande invalide.',400);
    const expected=reservation.expected_cycles[brandId];
    if(!expected)fail('invalid_checkout_brand','Marque absente de la réservation.',400);
    return transaction(async db=>{
      await lock(db,reservation.buyerId);
      const old=(await db.query('SELECT result_json FROM buyer_cart_checkout_results WHERE buyer_id=$1 AND request_key=$2 AND brand_id=$3',[reservation.buyerId,reservation.request_key,brandId])).rows[0];
      if(old)return old.result_json;
      const completed={...clone(result),brand_id:brandId};
      await db.query(`INSERT INTO buyer_cart_checkout_results(buyer_id,request_key,brand_id,cycle_id,success,result_json)
        VALUES($1,$2,$3,$4,false,$5)`,[reservation.buyerId,reservation.request_key,brandId,expected.cycle_id,JSON.stringify(completed)]);
      return completed;
    });
  }
  async function result(buyerId,key) {
    if(!validUuid(key))fail('invalid_checkout_key','Identifiant de demande invalide.',400);
    return transaction(async db=>{
      await lock(db,buyerId);
      const checkout=(await db.query('SELECT * FROM buyer_cart_checkouts WHERE buyer_id=$1 AND request_key=$2',[buyerId,key])).rows[0];
      if(!checkout)fail('checkout_not_found','Demande de commande introuvable.',404);
      const rows=(await db.query('SELECT brand_id,result_json,success FROM buyer_cart_checkout_results WHERE buyer_id=$1 AND request_key=$2 ORDER BY brand_id',[buyerId,key])).rows;
      const recorded=new Set(rows.map(row=>row.brand_id)),pending_brands=Object.keys(checkout.expected_cycles).filter(brand=>!recorded.has(brand)).sort();
      return {request_key:checkout.request_key,state:pending_brands.length?'pending':'complete',ok:!pending_brands.length&&rows.every(row=>row.success),
        orders:rows.map(row=>row.result_json),pending_brands,cart:await snapshotLocked(db,buyerId)};
    });
  }
  // Closing an uncertain attempt also fences a POST that has not reserved yet.
  // The cart lock orders cancellation against in-flight conversion commits.
  async function cancel(buyerId,key,brands) {
    if(!validUuid(key)||!Array.isArray(brands)||!brands.length||brands.length>500||new Set(brands).size!==brands.length)
      fail('invalid_checkout_key','Demande invalide.',400);
    brands.forEach(b=>identifier(b,'Marque'));
    await transaction(async db=>{
      await lock(db,buyerId);const state=await ensureState(db,buyerId);
      let checkout=(await db.query('SELECT * FROM buyer_cart_checkouts WHERE buyer_id=$1 AND request_key=$2',[buyerId,key])).rows[0];
      if(!checkout){
        const expected=Object.create(null),cycles=new Map((await cyclesFor(db,buyerId)).map(c=>[c.brand_id,c]));
        for(const brand of brands){
          let cycle=cycles.get(brand);
          if(!cycle){await replaceCycle(db,buyerId,brand,null,'unknown','legacy_unknown',EMPTY_HASH);cycle=(await cyclesFor(db,buyerId)).find(c=>c.brand_id===brand);}
          expected[brand]={cycle_id:cycle.cycle_id,revision:revision(cycle.revision),content_hash:cycle.content_hash};
        }
        checkout=(await db.query(`INSERT INTO buyer_cart_checkouts(buyer_id,request_key,request_hash,cart_id,expected_cycles)
          VALUES($1,$2,$3,$4,$5) RETURNING *`,[buyerId,key,'0'.repeat(64),state.cart_id,JSON.stringify(expected)])).rows[0];
      }
      if(stable(Object.keys(checkout.expected_cycles).sort())!==stable([...brands].sort()))fail('checkout_key_conflict','Marques de la demande différentes.');
      for(const [brand,cycle] of Object.entries(checkout.expected_cycles))await db.query(`INSERT INTO buyer_cart_checkout_results
        (buyer_id,request_key,brand_id,cycle_id,success,result_json) VALUES($1,$2,$3,$4,false,$5)
        ON CONFLICT(buyer_id,request_key,brand_id) DO NOTHING`,[buyerId,key,brand,cycle.cycle_id,JSON.stringify({brand_id:brand,error:'Tentative clôturée sans nouvelle commande / Attempt closed without a new order',code:'checkout_cancelled'})]);
    });
    return result(buyerId,key);
  }
  async function expireCarts() {
    const candidates=(await pool.query(`SELECT buyer_id FROM buyer_cart_states WHERE updated_at<NOW()-INTERVAL '90 days' AND cart_json<>'{}'::jsonb
      UNION SELECT b.buyer_id FROM buyer_carts b LEFT JOIN buyer_cart_states s ON s.buyer_id=b.buyer_id
      WHERE s.buyer_id IS NULL AND b.updated_at<NOW()-INTERVAL '90 days'`)).rows;
    let expired=0;
    for(const {buyer_id:buyerId} of candidates)expired+=await transaction(async db=>{
      await lock(db,buyerId);await ensureState(db,buyerId);
      const old=(await db.query("SELECT buyer_id FROM buyer_cart_states WHERE buyer_id=$1 AND updated_at<NOW()-INTERVAL '90 days' AND cart_json<>'{}'::jsonb",[buyerId])).rows[0];
      if(!old)return 0;
      await db.query("UPDATE buyer_cart_states SET cart_json='{}',revision=revision+1,updated_at=NOW() WHERE buyer_id=$1",[buyerId]);
      await db.query(`UPDATE buyer_cart_cycles SET state='empty',provenance='expired',content_hash=$2,revision=revision+1,
        changed_at=NOW(),converted_order_id=NULL WHERE buyer_id=$1 AND is_current AND state<>'converted'`,[buyerId,EMPTY_HASH]);
      await db.query('DELETE FROM buyer_carts WHERE buyer_id=$1',[buyerId]);return 1;
    });
    return {expired};
  }
  async function exportData(buyerId) {
    const db=await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state=(await db.query('SELECT cart_id,revision,cart_json,updated_at FROM buyer_cart_states WHERE buyer_id=$1',[buyerId])).rows[0]??null;
      const cycles=(await db.query('SELECT cycle_id,brand_id,is_current,revision,state,provenance,content_hash,changed_at,converted_order_id FROM buyer_cart_cycles WHERE buyer_id=$1 ORDER BY changed_at,cycle_id',[buyerId])).rows;
      const checkouts=(await db.query('SELECT request_key,request_hash,context_hash,cart_id,expected_cycles,created_at FROM buyer_cart_checkouts WHERE buyer_id=$1 ORDER BY created_at,request_key',[buyerId])).rows;
      const results=(await db.query("SELECT request_key,brand_id,cycle_id,order_id,success,result_json-'pdf_token' AS result,created_at FROM buyer_cart_checkout_results WHERE buyer_id=$1 ORDER BY created_at,brand_id",[buyerId])).rows;
      await db.query('COMMIT');return {state,cycles,checkouts,results};
    } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
    finally{db.release();}
  }
  return {snapshot,save,saveLegacy,invalidateLegacyOrder,reserveCheckout,recordResult,result,cancel,expireCarts,exportData};
}

module.exports={createBuyerCartService,CartError};
