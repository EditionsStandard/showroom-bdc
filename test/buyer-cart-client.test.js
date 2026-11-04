'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=require('../public/buyer-cart-client');
const id='11111111-1111-4111-8111-111111111111',cycle='22222222-2222-4222-8222-222222222222',key='33333333-3333-4333-8333-333333333333';
const line=(product='p',qty=1)=>({brand_id:'b',product_id:product,color:'Gold',size:'7"',qty,note:''});
const cart=(...rows)=>Object.fromEntries(rows.map(row=>[JSON.stringify([row.brand_id,row.product_id,row.color,row.size]),row]));
const state=(value={},revision=0,cycles=[])=>({cart_id:id,revision,cart:value,cycles});
const open={brand_id:'b',cycle_id:cycle,revision:1,state:'open'};
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};

test('disjoint device edits merge and remote price metadata survives unchanged local intent',()=>{
  const base=state(cart(line(),line('q')),1,[open]);
  const result=api.merge(base,cart(line('p',2),line('q')),state(cart(line(),{...line('q',3),price:42}),2,[{...open,revision:2}]));
  assert.deepEqual(result.conflicts,[]);assert.deepEqual(Object.values(result.cart).map(l=>l.qty).sort(),[2,3]);
  assert.equal(Object.values(result.cart).find(l=>l.product_id==='q').price,42);
});
test('conflicting quantity edits retain all three recoverable versions without summing quantities',()=>{
  const result=api.merge(state(cart(line()),1,[open]),cart(line('p',2)),state(cart(line('p',3)),2,[open]));
  assert.equal(result.conflicts[0].kind,'line_changed');assert.equal(Object.values(result.recovery.local)[0].qty,2);
  assert.equal(Object.values(result.recovery.remote.cart)[0].qty,3);assert.equal(Object.values(result.cart)[0].qty,3);
});
test('local removal survives remote metadata refresh, while remote deletion conflicts with local edit',()=>{
  const base=state(cart(line()),1,[open]);
  assert.deepEqual(api.merge(base,{},state(cart({...line(),price:99}),2,[open])).cart,{});
  assert.equal(api.merge(base,cart(line('p',2)),state({},2,[open])).conflicts[0].kind,'line_changed');
});
test('converted or replaced cycles cannot resurrect an old local brand snapshot',()=>{
  const base=state(cart(line()),1,[open]);
  for(const latest of [{...open,state:'converted'},{...open,cycle_id:key}]){
    const result=api.merge(base,cart(line('p',2)),state({},2,[latest]));
    assert.equal(result.conflicts[0].kind,'cycle_changed');assert.deepEqual(result.cart,{});
  }
});
test('unbased historical local data requires review and remains recoverable',()=>{
  const result=api.merge(null,cart(line()),state());assert.equal(result.conflicts[0].kind,'unbased_local');
  assert.equal(Object.values(result.recovery.local).length,1);assert.deepEqual(result.cart,{});
});
test('initialization waits for server and preserves edits made during the read',async()=>{
  const pending=gate();let writes=0;
  const client=api.create({read:()=>pending.promise,write:()=>{writes++;}});
  const loading=client.initialize();assert.throws(()=>client.flush(),/cart_not_ready/);
  client.edit(cart(line()));pending.resolve(state());await loading;
  assert.equal(client.inspect().phase,'review');assert.equal(writes,0);assert.equal(Object.values(client.inspect().cart).length,1);
});
test('writes are serialized and a newer edit is rebased onto the exact acknowledgement',async()=>{
  const pending=gate(),writes=[];
  const client=api.create({read:async()=>state(),write:async body=>{writes.push(body);return writes.length===1?pending.promise:state(body.cart,2,[open]);}});
  await client.initialize();client.edit(cart(line()));const first=client.flush(),second=client.flush();assert.equal(first,second);
  client.edit(cart(line('p',2)));pending.resolve(state(cart(line()),1,[open]));await first;
  assert.equal(writes.length,2);assert.equal(writes[1].revision,1);assert.equal(Object.values(writes[1].cart)[0].qty,2);
  assert.equal(client.inspect().phase,'ready');
});
test('lost write response requires re-read and explicit review without automatic POST retry',async()=>{
  let remote=state(),writes=0;
  const client=api.create({read:async()=>remote,write:async body=>{writes++;remote=state(body.cart,1,[open]);throw new Error('response_lost');}});
  await client.initialize();client.edit(cart(line()));await assert.rejects(client.flush(),/response_lost/);
  assert.throws(()=>client.flush(),/cart_not_ready/);const merged=await client.reconcile();assert.equal(writes,1);
  assert.equal(client.inspect().phase,'review');client.resolve(merged.cart);assert.equal(client.inspect().phase,'ready');
});
test('empty offline deletion is written and invalid acknowledgements never mark the draft saved',async()=>{
  const base=state(cart(line()),1,[open]);let sent;
  const client=api.create({read:async()=>base,write:async body=>{sent=body;return state({},2,[open]);}});
  await client.initialize({base,local:base.cart});client.edit({});await client.flush();assert.deepEqual(sent.cart,{});
  const broken=api.create({read:async()=>state(),write:async()=>state({},1)});await broken.initialize();broken.edit(cart(line()));
  await assert.rejects(broken.flush(),/invalid_cart_ack/);assert.equal(Object.values(broken.inspect().cart).length,1);assert.equal(broken.inspect().phase,'error');
});
test('failed reads and stale snapshots preserve the local recovery data',async()=>{
  const base=state(cart(line()),5,[open]);const client=api.create({read:async()=>state({},4),write:async()=>{}});
  await assert.rejects(client.initialize({base,local:cart(line('p',2))}),/stale_cart_response/);
  assert.equal(Object.values(client.inspect().cart)[0].qty,2);assert.equal(client.inspect().base.revision,5);
});
test('pending attempt storage is buyer scoped, immutable and excludes signature and contact data',()=>{
  const store=storage(),value={request_key:key,cart_id:id,revision:1,brands:['b'],buyer_signature:'SECRET',email:'PRIVATE'};
  const saved=api.saveAttempt(store,'buyer',value);assert.equal(JSON.stringify(saved).includes('SECRET'),false);assert.equal(JSON.stringify(saved).includes('PRIVATE'),false);
  assert.equal(api.readAttempt(store,'other'),null);assert.throws(()=>api.saveAttempt(store,'buyer',{...value,request_key:cycle}),/pending_attempt_exists/);
  assert.throws(()=>api.saveAttempt(store,'buyer',{...value,revision:2}),/pending_attempt_changed/);
});
test('incomplete or wrong checkout acknowledgements keep the pending key; complete partial result clears it',()=>{
  const store=storage();api.saveAttempt(store,'buyer',{request_key:key,cart_id:id,revision:1,brands:['a','b']});
  const receipt={request_key:key,state:'complete',pending_brands:[],ok:false,orders:[{brand_id:'a',order_id:'order'},{brand_id:'b',error:'unavailable'}]};
  for(const bad of [{...receipt,state:'pending'},{...receipt,orders:[]},{...receipt,request_key:cycle},{...receipt,orders:[receipt.orders[0],receipt.orders[0]]},{...receipt,ok:true}]){
    assert.throws(()=>api.finishAttempt(store,'buyer',bad));assert.equal(api.readAttempt(store,'buyer').request_key,key);
  }
  api.finishAttempt(store,'buyer',receipt);assert.equal(api.readAttempt(store,'buyer'),null);
});
test('unavailable storage blocks starting an attempt instead of losing its identity',()=>{
  const store=storage();store.setItem=()=>{throw new Error('quota');};
  assert.throws(()=>api.saveAttempt(store,'buyer',{request_key:key,cart_id:id,revision:1,brands:['b']}),/quota/);
});

test('a persisted review stays blocked across reload even if the new base would allow a clean merge',async()=>{
  const client=api.create({read:async()=>state(),write:async()=>{throw new Error('must_not_write');}});
  await client.initialize({base:state(),local:cart(line()),review:true});
  assert.equal(client.inspect().phase,'review');assert.equal(Object.values(client.inspect().cart).length,1);
  assert.throws(()=>client.flush(),/cart_not_ready/);
});
