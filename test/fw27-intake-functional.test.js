'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const {webcrypto} = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname,'..','infra','fw27-cargo-intake.ts'),'utf8');
function fixture(change={}){
  return { preferred_date:'2027-01-20',preferred_time:'09:30',full_name:'Synthetic buyer',
    store_or_company:'Synthetic Store',city_and_country:'Paris, France',business_email:'synthetic@example.invalid',
    collections_of_interest:['Menswear'],brands_or_collections:'', ...change };
}
function harness(upstream=async()=>new Response('',{status:200})){
  let route, calls=0;
  const logs=[];
  const env={FW27_AIRTABLE_WEBHOOK:'https://hooks.example.invalid/synthetic',PORT:'3000'};
  const sandbox={Bun:{env,serve(c){route=c.fetch;}},crypto:webcrypto,TextEncoder,Headers,Response,Request,URL,AbortSignal,Date,
    fetch:async(url,init)=>{calls++;assert.equal(url,env.FW27_AIRTABLE_WEBHOOK);return upstream(url,init);},
    console:{error:(...args)=>logs.push(args)}};
  vm.runInNewContext(stripTypeScriptTypes(source),sandbox,{timeout:2500,filename:'fw27-cargo-intake.ts'});
  assert.equal(typeof route,'function');
  const send=(body,headers={})=>route(new Request('https://railway.example.invalid/fw27-appointment',{
    method:'POST',headers:{origin:'https://editionsstandard.com','content-type':'application/json','x-forwarded-for':'192.0.2.1',...headers},body:JSON.stringify(body)
  }));
  return {send,requests:()=>calls,logs};
}

test('FW27 identical successful submission is forwarded once but accepted again on retry',async()=>{
  const h=harness();
  const first=await h.send(fixture());
  assert.equal(first.status,202);
  assert.deepEqual(await first.json(),{ok:true});
  const retry=await h.send(fixture());
  assert.equal(retry.status,202);
  assert.equal((await retry.json()).duplicate,true);
  assert.equal(h.requests(),1);
});

test('FW27 retries are not discarded when Airtable returns an error',async()=>{
  let upstreamCalls=0;
  const h=harness(async()=>new Response('',{status:++upstreamCalls===1?503:200}));
  assert.equal((await h.send(fixture())).status,502);
  assert.equal((await h.send(fixture())).status,202);
  assert.equal(h.requests(),2);
});

test('FW27 throttles a targeted email even when caller changes their forwarded IP',async()=>{
  const h=harness();
  for(let i=0;i<6;i++){
    const r=await h.send(fixture({brands_or_collections:'distinct '+i}),{'x-forwarded-for':'198.51.100.'+(i+10)});
    assert.equal(r.status,202,'request '+i);
  }
  const blocked=await h.send(fixture({brands_or_collections:'seventh'}),{'x-forwarded-for':'203.0.113.200'});
  assert.equal(blocked.status,429);
  assert.equal(h.requests(),6);
});

test('FW27 in-flight duplicate is not forwarded to Airtable a second time',async()=>{
  let release;
  const gate=new Promise(resolve=>release=resolve);
  let onStart;
  const started=new Promise(resolve=>onStart=resolve);
  const h=harness(async()=>{onStart();await gate;return new Response('',{status:200});});
  const first=h.send(fixture());
  await started;
  const second=h.send(fixture());
  release();
  assert.equal((await first).status,202);
  assert.equal((await second).status,202);
  assert.equal(h.requests(),1);
});

test('FW27 cross-origin submissions never reach Airtable',async()=>{
  const h=harness();
  const response=await h.send(fixture(),{origin:'https://unauthorised.invalid'});
  assert.equal(response.status,403);
  assert.equal(h.requests(),0);
});
