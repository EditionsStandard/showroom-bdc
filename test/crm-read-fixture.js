'use strict';
const http=require('node:http'),contract=require('../docs/buyer-engagement-airtable-contract.json');
const entities={store:contract.entities.stores,buyer:contract.entities.buyers,brand:contract.entities.brands,season:contract.entities.seasons};
const links={store:'recAAAAAAAAAAAAAA',buyer:'recBBBBBBBBBBBBBB',brand:'recCCCCCCCCCCCCCC',season:'recDDDDDDDDDDDDDD'};
function schema(){return {tables:Object.values(entities).map(e=>({id:e.table_id,fields:Object.values(e).filter(v=>v&&typeof v==='object').map(f=>({id:f.id,type:f.type,...(f.linked_table_id?{options:{linkedTableId:f.linked_table_id}}:{})}))}))};}
async function fixture(port){const state={requests:[],status:200,missing:[],schemaChanged:false,badRecord:false,buyerStore:links.store,email:'crm-buyer@example.test',brandName:'Synthetic Brand'};
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');state.requests.push({method:req.method,url:req.url});res.setHeader('Content-Type','application/json');if(req.method!=='GET'){res.statusCode=405;res.end('{}');return;}
  if(state.status!==200){res.statusCode=state.status;res.end(JSON.stringify({error:'synthetic unavailable'}));return;}
  if(url.pathname==='/v0/meta/bases/'+contract.base_id+'/tables'){const value=schema();if(state.schemaChanged)value.tables[0].fields[0].type='number';res.end(JSON.stringify(value));return;}
  const pair=Object.entries(entities).find(([,e])=>url.pathname==='/v0/'+contract.base_id+'/'+e.table_id);if(!pair){res.statusCode=404;res.end('{}');return;}
  const [key,e]=pair;if(state.missing.includes(key)){res.end('{"records":[]}');return;}
  const fields={[e.name.id]:key==='brand'?state.brandName:'Synthetic '+key};if(e.email)fields[e.email.id]=state.email;if(e.store)fields[e.store.id]=[state.buyerStore];res.end(JSON.stringify({records:[{id:state.badRecord?'recZZZZZZZZZZZZZZ':links[key],fields}]}));
 });await new Promise(r=>server.listen(port,'127.0.0.1',r));return {...state,state,url:'http://127.0.0.1:'+port,close:()=>new Promise(r=>server.close(r))};}
module.exports={fixture,entities,links,schema};
