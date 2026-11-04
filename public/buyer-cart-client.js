(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BuyerCartClient=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x));
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
  const assert=(ok,message)=>{if(!ok)throw new Error(message);};
  function intent(row){return JSON.stringify([row.brand_id,row.product_id,row.color??row.variant_color??'',row.size??'',row.qty,row.note??'']);}
  function index(cart){
    assert(object(cart),'invalid_cart');
    const rows=new Map();
    for(const row of Object.values(cart)){
      assert(object(row)&&typeof row.brand_id==='string'&&row.brand_id&&typeof row.product_id==='string'&&row.product_id&&Number.isSafeInteger(row.qty)&&row.qty>0&&row.qty<=100000,'invalid_cart_line');
      assert([row.color,row.variant_color,row.size,row.note].every(v=>v==null||typeof v==='string'),'invalid_cart_text');
      const key=JSON.stringify([row.brand_id,row.product_id,row.color??row.variant_color??'',row.size??'']);
      assert(!rows.has(key),'duplicate_cart_line');rows.set(key,copy(row));
    }
    return rows;
  }
  function snapshot(value){
    assert(object(value)&&uuid(value.cart_id)&&Number.isSafeInteger(value.revision)&&value.revision>=0&&Array.isArray(value.cycles),'invalid_cart_snapshot');
    index(value.cart);const brands=new Set();
    for(const cycle of value.cycles){
      assert(object(cycle)&&typeof cycle.brand_id==='string'&&!brands.has(cycle.brand_id)&&uuid(cycle.cycle_id)&&Number.isSafeInteger(cycle.revision)&&cycle.revision>=1&&['open','empty','converted','unknown'].includes(cycle.state),'invalid_cart_cycle');
      brands.add(cycle.brand_id);
    }
    return copy(value);
  }
  const same=(a,b)=>a===undefined?b===undefined:b!==undefined&&intent(a)===intent(b);
  function merge(base,local,remote){
    remote=snapshot(remote);const theirs=index(remote.cart),ours=index(local);
    if(!base){
      return {cart:copy(remote.cart),conflicts:ours.size?[{kind:'unbased_local'}]:[],recovery:{base:null,local:copy(local),remote}};
    }
    base=snapshot(base);
    assert(base.cart_id!==remote.cart_id||remote.revision>=base.revision,'stale_cart_response');
    const before=index(base.cart),result=new Map(theirs),conflicts=[];
    const oldCycles=new Map(base.cycles.map(c=>[c.brand_id,c])),newCycles=new Map(remote.cycles.map(c=>[c.brand_id,c]));
    const cycleConflicts=new Set();
    for(const key of new Set([...before.keys(),...ours.keys()])){
      const previous=before.get(key),next=ours.get(key),current=theirs.get(key);
      if(same(previous,next))continue;
      const brand=(next||previous).brand_id,old=oldCycles.get(brand),latest=newCycles.get(brand);
      if(base.cart_id!==remote.cart_id||(old&&(!latest||old.cycle_id!==latest.cycle_id||latest.state==='converted'))){
        if(!cycleConflicts.has(brand)){conflicts.push({kind:'cycle_changed',brand_id:brand});cycleConflicts.add(brand);}continue;
      }
      if(!same(previous,current)&&!same(next,current)){
        conflicts.push({kind:'line_changed',key,base:previous||null,local:next||null,remote:current||null});continue;
      }
      if(next)result.set(key,same(next,current)?current:next);else result.delete(key);
    }
    return {cart:Object.fromEntries(result),conflicts,recovery:{base,local:copy(local),remote}};
  }
  // Transport adapters must reject HTTP errors and malformed JSON. No automatic
  // retry of a failed write: re-read and require an explicit resolution instead.
  function create({read,write,onChange=()=>{}}){
    let base=null,local={},phase='idle',recovery=null,conflicts=[],flight=null,started=false;
    const inspect=()=>copy({base,cart:local,phase,recovery,conflicts});
    const emit=()=>onChange(inspect());
    function edit(cart){index(cart);local=copy(cart);emit();}
    async function initialize(saved={}){
      assert(!started,'already_initialized');started=true;
      local=copy(saved.local||{});index(local);base=saved.base?snapshot(saved.base):null;
      phase='loading';emit();
      try{
        const remote=await read();
        const merged=merge(base,local,remote);
        base=merged.recovery.remote;recovery=merged.recovery;conflicts=merged.conflicts;
        if(!conflicts.length&&!saved.review)local=merged.cart;
        phase=conflicts.length||saved.review?'review':'ready';emit();return inspect();
      }catch(error){phase='error';emit();throw error;}
    }
    async function reconcile(){
      phase='loading';emit();
      try{
        const remote=await read();
        const merged=merge(base,local,remote);
        base=merged.recovery.remote;recovery=merged.recovery;conflicts=merged.conflicts;
        // Even a disjoint merge after a failed write requires a deliberate retry.
        phase='review';emit();return copy(merged);
      }catch(error){phase='error';emit();throw error;}
    }
    function resolve(cart){assert(phase==='review','review_required');index(cart);local=copy(cart);conflicts=[];phase='ready';emit();}
    function flush(){
      if(flight)return flight;
      assert(phase==='ready'&&base,'cart_not_ready');
      const run=async()=>{
        while(true){
          const sent=copy(local),expected=copy(base);phase='saving';emit();
          let acknowledged;
          try{acknowledged=snapshot(await write({cart_id:expected.cart_id,revision:expected.revision,cart:sent}));
            assert(acknowledged.cart_id===expected.cart_id&&acknowledged.revision>=expected.revision,'stale_cart_response');
            const desired=index(sent),actual=index(acknowledged.cart);
            assert(desired.size===actual.size&&[...desired].every(([key,row])=>same(row,actual.get(key))),'invalid_cart_ack');
          }catch(error){phase='error';emit();throw error;}
          // Rebase edits made while the write was in flight onto that exact ack.
          const merged=merge({...acknowledged,cart:sent},local,acknowledged);
          base=acknowledged;local=merged.cart;phase='ready';emit();
          if(JSON.stringify([...index(local)].map(([k,v])=>[k,intent(v)]).sort())===JSON.stringify([...index(sent)].map(([k,v])=>[k,intent(v)]).sort()))return inspect();
        }
      };
      flight=run().finally(()=>{flight=null;});return flight;
    }
    return {inspect,edit,initialize,reconcile,resolve,flush};
  }
  const storageKey=buyer=>'buyer_cart_attempt_v2:'+encodeURIComponent(buyer);
  function readAttempt(storage,buyer){
    assert(typeof buyer==='string'&&buyer,'invalid_buyer');
    const raw=storage.getItem(storageKey(buyer));if(raw===null)return null;
    const value=JSON.parse(raw);
    assert(object(value)&&value.buyer_id===buyer&&uuid(value.request_key)&&uuid(value.cart_id)&&Number.isSafeInteger(value.revision)&&value.revision>=0&&Array.isArray(value.brands)&&value.brands.length&&value.brands.every(b=>typeof b==='string'&&b)&&new Set(value.brands).size===value.brands.length,'invalid_pending_attempt');
    return value;
  }
  function saveAttempt(storage,buyer,value){
    const previous=readAttempt(storage,buyer);
    assert(!previous||previous.request_key===value.request_key,'pending_attempt_exists');
    const record={buyer_id:buyer,request_key:value.request_key,cart_id:value.cart_id,revision:value.revision,brands:value.brands};
    assert(uuid(record.request_key)&&uuid(record.cart_id)&&Number.isSafeInteger(record.revision)&&record.revision>=0&&Array.isArray(record.brands)&&record.brands.length&&record.brands.every(b=>typeof b==='string'&&b)&&new Set(record.brands).size===record.brands.length,'invalid_pending_attempt');
    assert(!previous||JSON.stringify(previous)===JSON.stringify(record),'pending_attempt_changed');
    storage.setItem(storageKey(buyer),JSON.stringify(record));return copy(record);
  }
  function finishAttempt(storage,buyer,receipt){
    const attempt=readAttempt(storage,buyer);assert(attempt,'pending_attempt_missing');
    assert(object(receipt)&&receipt.request_key===attempt.request_key&&receipt.state==='complete'&&Array.isArray(receipt.pending_brands)&&!receipt.pending_brands.length&&Array.isArray(receipt.orders)&&receipt.orders.length===attempt.brands.length,'incomplete_checkout_receipt');
    const brands=new Set();let success=true;
    for(const row of receipt.orders){
      const refused=typeof row?.error==='string'&&!!row.error;
      const recorded=typeof row?.order_id==='string'&&!!row.order_id;
      assert(object(row)&&attempt.brands.includes(row.brand_id)&&!brands.has(row.brand_id)&&refused!==recorded,'invalid_checkout_receipt');
      brands.add(row.brand_id);if(row.error)success=false;
    }
    assert(receipt.ok===success,'invalid_checkout_receipt');
    storage.removeItem(storageKey(buyer));return copy(receipt);
  }
  return {merge,create,saveAttempt,readAttempt,finishAttempt};
});
