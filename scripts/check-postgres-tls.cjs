'use strict';
// Read-only TLS preflight. No migrations, providers, credentials or buyer data
// are printed. The connection uses exactly the application's configuration.
const {Client}=require('pg');
const {buildPostgresConfig}=require('../lib/postgres-connection');
(async()=>{
  if(!process.env.DATABASE_URL)throw Object.assign(Error(),{code:'database_url_required'});
  const config=buildPostgresConfig();
  if(!config.ssl)throw Object.assign(Error(),{code:'database_tls_required'});
  const client=new Client({...config,connectionTimeoutMillis:15000});
  try{
    await client.connect();
    if(client.connection.stream.authorized!==true)throw Object.assign(Error(),{code:'database_tls_peer_not_authorized'});
    await client.query('BEGIN READ ONLY');
    const result=(await client.query('SELECT ssl,version,cipher,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
    if(result?.ssl!==true)throw Object.assign(Error(),{code:'database_tls_not_in_use'});
    await client.query('ROLLBACK');
    console.log(JSON.stringify({read_only:true,tls_authorized:true,...result}));
  }finally{await client.end();}
})().catch(error=>{console.error(JSON.stringify({read_only:true,passed:false,error_code:/^[A-Za-z0-9_]{2,80}$/.test(error.code||'')?error.code:'database_tls_check_failed'}));process.exitCode=1;});
