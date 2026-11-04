'use strict';
// Prepared boundary only: no environment reads, SDK, global fetch fallback,
// registration, worker or scheduler. The isolated outbox rejects this kind.
const fail=code=>Object.assign(new Error(code),{code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const line=v=>typeof v==='string'&&v.length>0&&!/[\r\n]/.test(v);
function requestFor(payload,idempotencyKey,{apiKey,from}){
  if(!line(apiKey)||apiKey.length>512||!line(from))throw fail('resend_configuration_invalid');
  if(!line(idempotencyKey)||idempotencyKey.length>256||/\s/.test(idempotencyKey))throw fail('resend_idempotency_key_invalid');
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!['from','to','subject','text','headers'].includes(k)))throw fail('resend_payload_invalid');
  if(payload.from!==from||!Array.isArray(payload.to)||payload.to.length!==1||!line(payload.to[0])||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.to[0])||!line(payload.subject)||typeof payload.text!=='string'||!payload.text||payload.text.length>100000)throw fail('resend_payload_invalid');
  const headers=payload.headers;
  if(!headers||Object.keys(headers).length!==2||headers['List-Unsubscribe-Post']!=='List-Unsubscribe=One-Click'||!line(headers['List-Unsubscribe'])||!/^<https:\/\/showroom\.editionsstandard\.com\/api\/public\/buyer-engagement\/unsubscribe\/[a-f0-9]{64}>$/.test(headers['List-Unsubscribe']))throw fail('resend_unsubscribe_headers_invalid');
  return {url:'https://api.resend.com/emails',options:{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify(payload)}};
}
function createResendAdapter({enabled=false,apiKey,from,fetchImpl}={}){
  return Object.freeze({kind:'resend_prepared',sending_enabled:enabled===true,
    async submit(payload,{idempotency_key,signal}={}){
      if(enabled!==true)throw fail('resend_adapter_disabled');
      if(typeof fetchImpl!=='function')throw fail('resend_transport_required');
      if(!(signal instanceof AbortSignal))throw fail('resend_abort_signal_required');
      const request=requestFor(payload,idempotency_key,{apiKey,from});
      if(signal.aborted)return {outcome:'uncertain'};
      try {
        // Exactly one HTTP request, no automatic retry or redirect. Unknown
        // responses remain uncertain, including errors after a prior request.
        const response=await fetchImpl(request.url,{...request.options,signal});
        if(response.status!==200&&response.status!==201)return {outcome:'uncertain'};
        const result=await response.json();
        return uuid(result?.id)?{outcome:'accepted',provider_id:result.id}:{outcome:'uncertain'};
      } catch {return {outcome:'uncertain'};}
    }
  });
}
module.exports={createResendAdapter};
