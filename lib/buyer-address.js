'use strict';
const {getCountryCode}=require('./territories');

// Validate new writes only. Historical JSON remains untouched until explicitly edited.
function validateAddress(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || JSON.stringify(value).length>5000)return null;
  const limits={address:500,address_line2:200,postal_code:32,city:200,country:2};
  for(const [key,max] of Object.entries(limits)) {
    if(value[key]!==undefined && (typeof value[key]!=='string' || value[key].length>max))return null;
  }
  if(!value.address?.trim() || !value.city?.trim() || !getCountryCode(value.country))return null;
  return {...value,address:value.address.trim(),city:value.city.trim(),country:getCountryCode(value.country)};
}
module.exports={validateAddress};
