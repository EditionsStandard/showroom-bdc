const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');const assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const brand={id:'b',name:'WODD',min_per_reference:3,moq_amount:3500,moq_qty:3,moq_strict:false,payment_terms:'100% upon confirmation',cgv_text:'Terms'};
 const product={id:'p',brand_id:'b',reference:'REF\"quoted',description:'Test',color:'Gold',sizes:'7",16-18"',price:248,active:1,variants:JSON.stringify([{color:'Silver'}])};
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname!=='showroom.test') return route.abort();
  if(u.pathname==='/portal')return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'/public/portal.html','utf8')});
  if(u.pathname==='/buyer-tools.js')return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(root+'/public/buyer-tools.js','utf8')});
  if(u.pathname==='/ordering-rules.js')return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(root+'/public/ordering-rules.js','utf8')});
  if(u.pathname.startsWith('/api/')){
   let body=[];
   if(u.pathname==='/api/portal/me')body={email:'buyer@test',name:'Buyer',company:'Retailer'};
   if(u.pathname==='/api/portal/brands')body=[brand];
   if(u.pathname==='/api/portal/brands/b/products')body={brand,products:[product]};
   if(u.pathname==='/api/portal/cart')body={};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  }
  return route.fulfill({status:404,body:''});
 });
 await page.goto('http://showroom.test/portal');
 await page.waitForFunction(()=>typeof allBrands!=='undefined'&&allBrands.length===1);
 await page.evaluate(()=>openBrand('b'));
 const plus=page.locator('[data-qty-product="p"][data-qty-size="7\\\""][data-qty-delta="1"]').first();
 await plus.click();assert.equal(await page.evaluate(()=>Object.values(cart)[0].qty),3);
 await plus.click();assert.equal(await page.evaluate(()=>Object.values(cart)[0].qty),4);
 const minus=page.locator('[data-qty-product="p"][data-qty-delta="-1"]').first();
 await minus.click();await minus.click();assert.equal(await page.evaluate(()=>Object.keys(cart).length),0);
 await plus.click();
 await page.evaluate(()=>{changeQty('p','7"',1,'Silver');showView('cart');});
 assert.equal(await page.locator('[data-cart-input]').count(),2);
 const quantities=await page.evaluate(()=>Object.values(cart).map(l=>l.qty));assert.deepEqual(quantities,[3,1]);
 await page.locator('[data-cart-input]').first().fill('4');await page.locator('[data-cart-input]').first().dispatchEvent('change');
 assert.equal(await page.evaluate(()=>Object.values(cart)[0].qty),4);
 assert.match(await page.locator('#cart-lines').innerText(),/Recommended|recommandée/);
 assert.equal(await page.locator('#btn-confirm-order').isDisabled(),false);
 const horizontal=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
 assert.equal(horizontal,false,'mobile overflow');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/showroom-cart-mobile.png',fullPage:true});
 console.log('PASS: mobile inch sizes, 0→3→4→3→0, distinct colors, direct cart edit, non-blocking MOQ, no script errors');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
