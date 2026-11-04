'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createResendAdapter}=require('../lib/buyer-engagement-resend-adapter');
const outbox=require('../lib/buyer-engagement-outbox');
const payload=()=>({from:'Synthetic <sender@example.test>',to:['buyer@example.test'],subject:'Synthetic message',text:'Synthetic text only',headers:{'List-Unsubscribe':'<https://showroom.editionsstandard.com/api/public/buyer-engagement/unsubscribe/'+'a'.repeat(64)+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}});
const args=()=>({idempotency_key:'engagement/'+randomUUID(),signal:new AbortController().signal});
const adapter=fetchImpl=>createResendAdapter({enabled:true,apiKey:'synthetic-unused-key',from:payload().from,fetchImpl});
test('adapter is disabled by default even if an HTTP function is supplied',async()=>{let calls=0;const a=createResendAdapter({fetchImpl:async()=>{calls++;}});assert.equal(a.sending_enabled,false);await assert.rejects(a.submit(payload(),args()),e=>e.code==='resend_adapter_disabled');assert.equal(calls,0);});
test('prepared adapter cannot be passed to the isolated outbox',async()=>{await assert.rejects(outbox.rehearseOne({}, {transport:adapter(async()=>{}),key:Buffer.alloc(32)}),e=>e.code==='fixture_transport_required');});
test('no key, sender, global fetch or abort-signal fallback is used',async()=>{
  await assert.rejects(createResendAdapter({enabled:true}).submit(payload(),args()),e=>e.code==='resend_transport_required');
  await assert.rejects(adapter(async()=>{}).submit(payload(),{idempotency_key:'synthetic'}),e=>e.code==='resend_abort_signal_required');
  await assert.rejects(createResendAdapter({enabled:true,fetchImpl:async()=>{throw Error('must not call');}}).submit(payload(),args()),e=>e.code==='resend_configuration_invalid');
});
test('request preserves the frozen body and key, sends list headers, and rejects redirects',async()=>{
  const p=payload(),before=JSON.stringify(p),options=args(),provider=randomUUID(),calls=[];
  const a=adapter(async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({id:provider}),{status:200});});
  assert.deepEqual(await a.submit(p,options),{outcome:'accepted',provider_id:provider});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].init.body,before);assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers['Idempotency-Key'],options.idempotency_key);assert.equal(calls[0].init.signal,options.signal);assert.equal(JSON.stringify(p),before);
});
test('bad envelopes cannot add recipients, replace sender, inject headers or use another unsubscribe host',async()=>{
  let calls=0;const a=adapter(async()=>{calls++;});
  for(const modify of [p=>p.to.push('other@example.test'),p=>p.from='changed@example.test',p=>p.subject='x\r\nBcc: y',p=>p.html='<p>extra</p>',p=>p.headers.Authorization='extra',p=>p.headers['List-Unsubscribe']=p.headers['List-Unsubscribe'].replace('showroom.editionsstandard.com','attacker.example')]){const p=payload();modify(p);await assert.rejects(a.submit(p,args()));}
  assert.equal(calls,0);
});
test('HTTP failures and malformed acceptance remain uncertain and never trigger an internal retry',async()=>{
  for(const response of [new Response('{}',{status:400}),new Response('{}',{status:409}),new Response('{}',{status:429}),new Response('{}',{status:500}),new Response('not-json',{status:200}),new Response('{"id":"not-a-provider-id"}',{status:200})]){
    let calls=0;const a=adapter(async()=>{calls++;return response;});assert.deepEqual(await a.submit(payload(),args()),{outcome:'uncertain'});assert.equal(calls,1);
  }
});
test('network loss and an aborted call expose no provider error or secret',async()=>{
  const a=adapter(async()=>{throw Error('synthetic-unused-key raw-token provider details');});assert.deepEqual(await a.submit(payload(),args()),{outcome:'uncertain'});
  const controller=new AbortController();controller.abort();let calls=0;const b=adapter(async()=>{calls++;});assert.deepEqual(await b.submit(payload(),{idempotency_key:'synthetic',signal:controller.signal}),{outcome:'uncertain'});assert.equal(calls,0);
});
