'use strict';
require('./no-outbound');
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const net=require('node:net'),tls=require('node:tls'),{Client}=require('pg');
const {buildPostgresConfig}=require('../lib/postgres-connection');
let directory,ca,key,cert,otherCa;

before(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'showroom-tls-'));
  await fs.writeFile(path.join(directory,'root.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=synthetic-root\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  await fs.writeFile(path.join(directory,'server.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  const run=args=>execFileSync('openssl',args,{cwd:directory,stdio:'ignore'});
  for(const prefix of ['root','other'])run(['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','2','-config','root.cnf','-keyout',prefix+'.key','-out',prefix+'.crt']);
  run(['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout','server.key','-out','server.csr']);
  run(['x509','-req','-in','server.csr','-CA','root.crt','-CAkey','root.key','-CAcreateserial','-days','2','-extfile','server.cnf','-out','server.crt']);
  [ca,key,cert,otherCa]=await Promise.all(['root.crt','server.key','server.crt','other.crt'].map(file=>fs.readFile(path.join(directory,file),'utf8')));
});
after(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});

test('remote databases always require authenticated TLS and channel binding support',()=>{
  const value=buildPostgresConfig({DATABASE_URL:'postgresql://synthetic:secret@db.example.test/showroom'});
  assert.equal(value.ssl.rejectUnauthorized,true);assert.equal(value.ssl.minVersion,'TLSv1.2');assert.equal(value.enableChannelBinding,true);
});
test('loopback development and CI remain non-TLS unless explicitly requested',()=>{
  for(const host of ['localhost','127.0.0.1','[::1]'])assert.equal(buildPostgresConfig({DATABASE_URL:'postgresql://synthetic@'+host+'/test'}).ssl,false);
  assert.equal(buildPostgresConfig({}).ssl,false);
  assert.equal(buildPostgresConfig({PGHOST:'db.example.test'}).ssl.rejectUnauthorized,true);
  assert.equal(buildPostgresConfig({DATABASE_URL:'postgresql://synthetic@127.0.0.1/test?sslmode=require'}).ssl.rejectUnauthorized,true);
});
test('URL TLS modes cannot overwrite the driver ssl object',()=>{
  for(const mode of ['require','verify-ca','verify-full']){
    const config=buildPostgresConfig({DATABASE_URL:'postgresql://synthetic:secret@db.example.test/test?sslmode='+mode,PG_TLS_CA_PEM:ca});
    const client=new Client(config);assert.equal(client.connectionParameters.ssl.rejectUnauthorized,true);assert.equal(client.connectionParameters.ssl.ca,ca.trim()+'\n');
    assert.equal(new URL(config.connectionString).searchParams.has('sslmode'),false);
  }
});
test('remote plaintext, unverified modes and duplicate modes are rejected without leaking credentials',()=>{
  for(const query of ['sslmode=disable','sslmode=no-verify','sslmode=prefer','sslmode=allow','sslmode=require&sslmode=disable']){
    assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://synthetic:DO_NOT_LOG@db.example.test/test?'+query}),error=>/^database_tls_/.test(error.code)&&!error.message.includes('DO_NOT_LOG'));
  }
  assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://synthetic@db.example.test/test',PGSSLMODE:'disable'}),{code:'database_tls_remote_disable_forbidden'});
});
test('URL file, host, nested connection and ssl overrides fail closed',()=>{
  for(const query of ['sslrootcert=/tmp/other','sslcert=/tmp/client','sslkey=/tmp/key','ssl=true','sslnegotiation=direct','host=localhost','hostaddr=127.0.0.1','port=1234','connectionString=postgresql%3A%2F%2Flocalhost%2Ftest']){
    assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://synthetic@db.example.test/test?'+query}),{code:'database_url_connection_override'});
  }
});
test('CA parsing rejects private keys, invalid encoding, extra text and ambiguous sources',()=>{
  for(const value of ['not a certificate',ca+'unexpected text',key])assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://db.example.test/test',PG_TLS_CA_PEM:value}),{code:'database_tls_invalid_ca'});
  for(const value of ['garbage%%%','YQ','===='])assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://db.example.test/test',PG_TLS_CA_BASE64:value}),{code:'database_tls_invalid_ca'});
  assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://db.example.test/test',PG_TLS_CA_PEM:ca,PG_TLS_CA_BASE64:Buffer.from(ca).toString('base64')}),{code:'database_tls_multiple_ca_sources'});
  assert.equal(buildPostgresConfig({DATABASE_URL:'postgresql://db.example.test/test',PG_TLS_CA_BASE64:Buffer.from(ca).toString('base64')}).ssl.ca,ca.trim()+'\n');
});
test('an alternate certificate identity requires an explicit valid CA',()=>{
  for(const name of ['localhost','bad name','bad\nname','/etc/passwd'])assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://db.example.test/test',PG_TLS_SERVERNAME:name}),{code:'database_tls_invalid_servername'});
  assert.throws(()=>buildPostgresConfig({DATABASE_URL:'postgresql://localhost/test',PG_TLS_CA_PEM:ca}),{code:'database_tls_local_mode_required'});
});
test('unrelated URL application options survive TLS sanitization',()=>{
  const value=buildPostgresConfig({DATABASE_URL:'postgresql://synthetic:p%40ss@db.example.test/test?application_name=showroom&sslmode=require'});
  const client=new Client(value);assert.equal(client.connectionParameters.password,'p@ss');assert.equal(client.connectionParameters.application_name,'showroom');assert.equal(client.connectionParameters.host,'db.example.test');
});

// Real node-postgres + real TLS handshake against a minimal PostgreSQL transport.
// No production credentials, data or external network access are used.
async function transport({supportsTls=true}={}){
  const sockets=new Set();let startups=0;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.once('data',request=>{
      if(request.length!==8||request.readInt32BE(4)!==80877103)return socket.destroy();
      if(!supportsTls){socket.write('N');return;}
      socket.write('S');
      const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext({key,cert:cert+ca})});
      sockets.add(secure);secure.on('error',()=>{});secure.on('close',()=>sockets.delete(secure));
      secure.once('data',()=>{startups++;secure.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]));});
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:server.address().port,startups:()=>startups,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
async function connectFixture(server,extra={}){
  const config=buildPostgresConfig({DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:'+server.port+'/synthetic?sslmode=require',...extra});
  const client=new Client({...config,connectionTimeoutMillis:2000});
  try{await client.connect();return client.connection.stream.authorized;}
  finally{await client.end();}
}
test('driver accepts the trusted CA and explicit certificate identity over a distinct transport address',async()=>{
  const server=await transport();try{assert.equal(await connectFixture(server,{PG_TLS_CA_PEM:ca,PG_TLS_SERVERNAME:'localhost'}),true);assert.equal(server.startups(),1);}finally{await server.close();}
});
test('unknown CA is rejected before any PostgreSQL startup credentials are transmitted',async()=>{
  const server=await transport();try{await assert.rejects(connectFixture(server,{PG_TLS_CA_PEM:otherCa,PG_TLS_SERVERNAME:'localhost'}));assert.equal(server.startups(),0);}finally{await server.close();}
});
test('wrong certificate identity is rejected with a trusted CA',async()=>{
  const server=await transport();try{await assert.rejects(connectFixture(server,{PG_TLS_CA_PEM:ca,PG_TLS_SERVERNAME:'different.example.test'}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});assert.equal(server.startups(),0);}finally{await server.close();}
});
test('certificate hostname is also checked when no identity override is configured',async()=>{
  const server=await transport();try{await assert.rejects(connectFixture(server,{PG_TLS_CA_PEM:ca}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});assert.equal(server.startups(),0);}finally{await server.close();}
});
test('TLS refusal never falls back to a plaintext startup',async()=>{
  const server=await transport({supportsTls:false});try{await assert.rejects(connectFixture(server,{PG_TLS_CA_PEM:ca,PG_TLS_SERVERNAME:'localhost'}),/does not support SSL/);assert.equal(server.startups(),0);}finally{await server.close();}
});
