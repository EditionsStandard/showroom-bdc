'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{scrubEmailTelemetry}=require('../lib/buyer-email-telemetry');
test('telemetry removes action tokens and password form values from URLs, objects, JSON and encoded bodies',()=>{
  const token='a'.repeat(64),secret='synthetic password';const data={request:{url:'https://example.test/api/public/buyer-engagement/unsubscribe/'+token,data:{token,password:secret}},breadcrumbs:[{message:'https://example.test/buyer-engagement/activate#token='+token+'&lang=fr'},{message:JSON.stringify({token,password:secret})},{message:'token='+token+'&password='+encodeURIComponent(secret)}],safe:'unchanged'};
  const result=scrubEmailTelemetry(data),encoded=JSON.stringify(result);assert.equal(encoded.includes(token),false);assert.equal(encoded.includes(secret),false);assert.equal(encoded.includes(encodeURIComponent(secret)),false);assert.equal(result.safe,'unchanged');assert.equal(data.request.data.token,token);
});
test('telemetry handles cycles without throwing',()=>{const data={};data.self=data;assert.deepEqual(scrubEmailTelemetry(data),{self:'[Filtered]'});});
test('provider request telemetry removes the entire body, headers, cookies and query while preserving route and method',()=>{
  for(const route of ['/api/webhooks/buyer-engagement/resend','/API/WEBHOOKS/BUYER-ENGAGEMENT/RESEND/']){
    const data={request:{url:'https://example.test'+route+'?secret=private',method:'POST',data:{subject:'PRIVATE',to:['private@example.test']},headers:{'svix-signature':'PRIVATE'},cookies:'PRIVATE'}};
    assert.deepEqual(scrubEmailTelemetry(data),{request:{url:'https://example.test'+route,method:'POST',data:'[Filtered]'}});
  }
});
