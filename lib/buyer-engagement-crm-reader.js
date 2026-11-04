'use strict';
// Dedicated read-only transport: fixed base, GET only, no legacy credential fallback.
const contract=require('../docs/buyer-engagement-airtable-contract.json');
const fail=code=>Object.assign(new Error(code),{code});
function readerConfig(env=process.env){
  const enabled=env.AIRTABLE_ENGAGEMENT_READS_ENABLED==='true'&&!!env.AIRTABLE_ENGAGEMENT_READ_TOKEN;
  let origin='https://api.airtable.com';
  if(env.NODE_ENV==='test'&&env.ENGAGEMENT_CRM_TEST_URL){const u=new URL(env.ENGAGEMENT_CRM_TEST_URL);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw fail('crm_test_origin_invalid');origin=u.origin;}
  return {enabled,origin,token:env.AIRTABLE_ENGAGEMENT_READ_TOKEN};
}
function createReader({config=readerConfig(),fetchImpl=fetch}={}){
  return {available:config.enabled,async inspect(links,local){
    if(!config.enabled)throw fail('crm_reader_unavailable');
    for(const key of ['store','buyer','brand','season'])if(!/^rec[A-Za-z0-9]{14}$/.test(links[key]||''))throw fail('crm_links_incomplete');
    const deadline=Date.now()+20000;
    async function get(path){
      const remaining=deadline-Date.now();if(remaining<=0)throw fail('crm_read_timeout');let response;
      try{response=await fetchImpl(config.origin+path,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+config.token},signal:AbortSignal.timeout(Math.min(5000,remaining))});}catch{throw fail('crm_read_unavailable');}
      if(!response.ok)throw fail(response.status===429?'crm_rate_limited':response.status===401||response.status===403?'crm_read_forbidden':'crm_read_unavailable');
      try{return await response.json();}catch{throw fail('crm_response_invalid');}
    }
    const schema=await get('/v0/meta/bases/'+contract.base_id+'/tables');if(!Array.isArray(schema?.tables))throw fail('crm_schema_invalid');
    const entities={store:contract.entities.stores,buyer:contract.entities.buyers,brand:contract.entities.brands,season:contract.entities.seasons};
    for(const entity of Object.values(entities)){
      const table=schema.tables.find(t=>t.id===entity.table_id);if(!Array.isArray(table?.fields))throw fail('crm_schema_changed');
      for(const expected of Object.values(entity).filter(v=>v&&typeof v==='object')){
        const field=table.fields.find(f=>f.id===expected.id);if(field?.type!==expected.type||expected.linked_table_id&&field.options?.linkedTableId!==expected.linked_table_id)throw fail('crm_schema_changed');
      }
    }
    const records={};
    for(const [key,entity] of Object.entries(entities)){
      const params=new URLSearchParams({filterByFormula:"RECORD_ID()='"+links[key]+"'",maxRecords:'2',returnFieldsByFieldId:'true'});
      for(const field of Object.values(entity).filter(v=>v&&typeof v==='object'))params.append('fields[]',field.id);
      const result=await get('/v0/'+contract.base_id+'/'+entity.table_id+'?'+params);
      if(!Array.isArray(result?.records)||result.records.length>1||result.offset||result.records.some(r=>r.id!==links[key]||!r.fields||typeof r.fields!=='object'||Array.isArray(r.fields)))throw fail('crm_response_invalid');
      records[key]=result.records[0]?.fields||null;
    }
    const clean=v=>typeof v==='string'?v.trim().toLowerCase():'',hasName=(row,entity)=>!!clean(row?.[entity.name.id]);
    const matches=(v,reference)=>!!clean(v)&&!!clean(reference)&&clean(v)===clean(reference);
    const storeLinks=records.buyer?.[entities.buyer.store.id];if(storeLinks!==undefined&&(!Array.isArray(storeLinks)||storeLinks.some(v=>typeof v!=='string'||!/^rec[A-Za-z0-9]{14}$/.test(v))))throw fail('crm_response_invalid');
    const checks=Object.fromEntries(Object.entries(entities).map(([key,entity])=>[key,{record_id:links[key],found:!!records[key],name_present:hasName(records[key],entity)}]));
    checks.store.email_matches_local=matches(records.store?.[entities.store.email.id],local.email);
    checks.buyer.email_matches_local=matches(records.buyer?.[entities.buyer.email.id],local.email);
    checks.buyer.linked_store_matches=!!records.buyer&&Array.isArray(storeLinks)&&storeLinks.includes(links.store);
    checks.brand.name_matches_local=matches(records.brand?.[entities.brand.name.id],local.brand_name);
    return {entities:checks,structural_checks_passed:Object.values(checks).every(c=>c.found&&c.name_present)&&checks.buyer.linked_store_matches,
      identity_verified:false,season_verified:false,ready_to_transfer:false,crm_writes_enabled:false,
      limitations:['identity_review_required','season_review_required','destination_not_confirmed','duplicate_check_missing','external_side_effects_unverified','transfer_not_implemented']};
  }};
}
module.exports={createReader,readerConfig};
