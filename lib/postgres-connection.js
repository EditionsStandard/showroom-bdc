'use strict';
const tls=require('node:tls');
const {X509Certificate}=require('node:crypto');

const fail=code=>Object.assign(new Error(code),{code});
const localHost=host=>['localhost','127.0.0.1','::1'].includes(host.replace(/^\[|\]$/g,''));

function certificateBundle(env){
  if(env.PG_TLS_CA_PEM&&env.PG_TLS_CA_BASE64)throw fail('database_tls_multiple_ca_sources');
  let value=env.PG_TLS_CA_PEM;
  if(env.PG_TLS_CA_BASE64){
    const encoded=env.PG_TLS_CA_BASE64.replace(/\s/g,'');
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||Buffer.from(encoded,'base64').toString('base64')!==encoded)throw fail('database_tls_invalid_ca');
    value=Buffer.from(encoded,'base64').toString('utf8');
  }
  if(!value)return undefined;
  if(typeof value!=='string'||value.length>131072||/PRIVATE KEY/.test(value))throw fail('database_tls_invalid_ca');
  const blocks=value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if(!blocks?.length||value.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,'').trim())throw fail('database_tls_invalid_ca');
  try{for(const block of blocks)new X509Certificate(block);tls.createSecureContext({ca:value});}
  catch{throw fail('database_tls_invalid_ca');}
  return blocks.join('\n')+'\n';
}

// Remote connections always authenticate their TLS peer. URL options may not
// replace the ssl object: node-postgres reparses connectionString last.
function buildPostgresConfig(env=process.env){
  let url;
  if(env.DATABASE_URL){
    try{url=new URL(env.DATABASE_URL);if(!['postgres:','postgresql:'].includes(url.protocol))throw Error();}
    catch{throw fail('database_invalid_url');}
  }
  const host=url?.hostname||env.PGHOST||'localhost',local=localHost(host);
  let mode=env.PGSSLMODE;
  if(url){
    let urlMode;
    for(const [name,value] of [...url.searchParams]){
      const key=name.toLowerCase();
      if(key==='sslmode'){
        if(urlMode!==undefined)throw fail('database_tls_duplicate_mode');
        urlMode=value;url.searchParams.delete(name);
      }else if(/^(ssl|uselibpqcompat)/.test(key)||['host','hostaddr','port','user','password','database','dbname','connectionstring','stream','service','servicefile'].includes(key)){
        throw fail('database_url_connection_override');
      }
    }
    if(urlMode!==undefined)mode=urlMode;
  }
  if(mode!==undefined&&!['disable','require','verify-ca','verify-full'].includes(mode))throw fail('database_tls_invalid_mode');
  if(!local&&mode==='disable')throw fail('database_tls_remote_disable_forbidden');
  const required=!local||['require','verify-ca','verify-full'].includes(mode);
  const ca=certificateBundle(env),expected=env.PG_TLS_SERVERNAME;
  if(expected&&(!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(expected)||!ca))throw fail('database_tls_invalid_servername');
  if(!required&&(ca||expected))throw fail('database_tls_local_mode_required');
  const ssl=required?{rejectUnauthorized:true,minVersion:'TLSv1.2',...(ca?{ca}:{}),
    // pg sets SNI only for DNS names. Always bind the certificate check to the
    // actual destination (including IPs), or to its explicitly approved name.
    checkServerIdentity:(_transportHost,certificate)=>tls.checkServerIdentity(expected||host.replace(/^\[|\]$/g,''),certificate)}:false;
  return {...(url?{connectionString:url.toString()}:{host}),ssl,enableChannelBinding:true};
}

module.exports={buildPostgresConfig};
