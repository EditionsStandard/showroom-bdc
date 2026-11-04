'use strict';
// Scrub bearer URL paths, fragment/query values and action form secrets before
// Sentry receives events, transactions or breadcrumbs. No request is persisted.
function scrubEmailTelemetry(value,seen=new WeakMap()){
 if(typeof value==='string')return value.replace(/(\/api\/public\/buyer-engagement\/unsubscribe\/)[a-f0-9]{64}/gi,'$1[Filtered]')
  .replace(/([?#&]token=)[a-f0-9]{64}/gi,'$1[Filtered]')
  .replace(/("(?:token|password|password_confirmation)"\s*:\s*")[^"\\]*(?:\\.[^"\\]*)*"/gi,'$1[Filtered]"')
  .replace(/((?:^|[&?])(?:token|password|password_confirmation)=)[^&\s]*/gi,'$1[Filtered]');
 if(!value||typeof value!=='object'||value instanceof Date)return value;if(seen.has(value))return '[Filtered]';const out=Array.isArray(value)?[]:{};seen.set(value,out);
 for(const [key,item] of Object.entries(value))out[key]=/^(token|password|password_confirmation)$/i.test(key)?'[Filtered]':scrubEmailTelemetry(item,seen);return out;
}
module.exports={scrubEmailTelemetry};
