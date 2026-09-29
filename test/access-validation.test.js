const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validate} = require('../public/access-validation');
const valid = {name:'Jane Smith',company:'Store',job_title:'Buyer',country:'Singapore',city:'Singapore',email:'buyer@example.com',business_type:'Retailer',website:'https://example.com',privacy_accepted:true};
test('each required identity field is enforced, including whitespace and non-strings', () => {
  for(const key of ['name','company','job_title','country','city','email','business_type']) {
    for(const value of ['', '  ', {}, []]) assert.equal(validate({...valid,[key]:value}).valid,false,key);
  }
});
test('website OR professional Instagram; validates both when supplied',()=>{
  assert.equal(validate(valid).valid,true);
  assert.equal(validate({...valid,website:'',instagram:'@store.name'}).valid,true);
  assert.equal(validate({...valid,website:'',instagram:'https://www.instagram.com/store.name/'}).data.instagram,'store.name');
  assert.equal(validate({...valid,website:''}).valid,false);
  for(const website of ['javascript:alert(1)','data:text/html,x','example.com','https://user:pass@example.com']) assert.equal(validate({...valid,website}).valid,false);
  for(const instagram of ['https://evil.com/store','https://instagram.com/p/123','https://instagram.com/reels','bad username','a..b']) assert.equal(validate({...valid,instagram}).valid,false);
});
test('consent, lengths, actual country and business values',()=>{
  for(const patch of [{privacy_accepted:'true'},{country:'Other'},{business_type:'invalid'},{name:'x'.repeat(201)}]) assert.equal(validate({...valid,...patch}).valid,false);
  assert.equal(validate({...valid,email:' BUYER@EXAMPLE.COM '}).data.email,'buyer@example.com');
});
