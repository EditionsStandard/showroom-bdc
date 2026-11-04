'use strict';
// Browser smoke tests follow the same tabs/disclosures as an owner.
async function revealEngagementPanel(page,panel){
  const routes={contacts:['actions','engagement-contacts-detail'],cart:['actions','engagement-carts-detail'],brand:['actions','engagement-brands-detail'],reviews:['actions','engagement-brands-detail'],templates:['automations','engagement-approval-detail'],diagnostics:['actions','engagement-diagnostics']};
  const route=routes[panel];if(!route)throw Error('Unknown engagement panel');
  await page.locator('#engagement-tab-'+route[0]).click();const details=page.locator('#'+route[1]);
  if(await details.getAttribute('open')===null)await details.locator('summary').first().click();
}
module.exports={revealEngagementPanel};
