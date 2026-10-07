const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ProviderCircuit}=require('../lib/provider-circuit');
test('credit failures open circuit, avoid retries, and recover after expiry',async()=>{
  let now=1000,calls=0;
  const circuit=new ProviderCircuit({now:()=>now});
  const fail=()=>{calls++;throw Object.assign(new Error('credits'),{statusCode:400});};
  await assert.rejects(circuit.run(fail));
  for(let i=0;i<10;i++)await assert.rejects(circuit.run(fail),e=>e.circuitOpen);
  assert.equal(calls,1);
  now+=900001;
  assert.equal(await circuit.run(async()=> 'translation'),'translation');
  assert.equal(circuit.status().open,false);
});
test('concurrent provider calls cannot produce a retry storm',async()=>{
  let release;
  const circuit=new ProviderCircuit();
  const operation=circuit.run(()=>new Promise(resolve=>{release=resolve;}));
  await assert.rejects(circuit.run(()=> 'second'),e=>e.circuitOpen);
  release('first');assert.equal(await operation,'first');
});
