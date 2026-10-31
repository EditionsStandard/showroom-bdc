(function(root,factory){
  if(typeof module==='object' && module.exports) module.exports=factory();
  else root.BuyerCountries=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // ISO 3166-1 alpha-2; legacy country names are never inferred or rewritten.
  const codes=Object.freeze('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
  const valid=new Set(codes);
  function getCountryCode(value){
    if(typeof value!=='string')return null;
    const code=value.trim().toUpperCase();return valid.has(code)?code:null;
  }
  function fill(select,value,lang='fr'){
    value=String(value || '');
    const english=lang==='en';
    const names=typeof Intl.DisplayNames==='function'?new Intl.DisplayNames([lang],{type:'region'}):null;
    const options=codes.map(code=>({code,name:names?names.of(code):code})).sort((a,b)=>a.name.localeCompare(b.name,lang));
    select.replaceChildren(new Option(english?'Choose a country':'Choisir un pays',''));
    for(const item of options)select.add(new Option(item.name,item.code));
    // Keep the exact legacy value visible until the buyer explicitly qualifies it.
    if(value && !valid.has(value))select.add(new Option((english?'To verify: ':'À vérifier : ')+value,value));
    select.value=value;
  }
  return {codes,getCountryCode,fill};
});
