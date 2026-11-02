'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {startServer,withDb,id}=require('../test/helpers');
const {randomUUID,createHmac}=require('node:crypto');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 let server,browser;
 try{
  server=await startServer({dbNameSuffix:'cart_ui_'+Date.now(),port:3230});
  const db=fn=>withDb(server.dbUrl,fn),brand=id('brand'),product=id('product');
  await db(async c=>{
   await c.query('CREATE TABLE IF NOT EXISTS user_sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp NOT NULL)');
   await c.query("INSERT INTO brands(id,name,subscription_status,min_per_reference,cgv_text) VALUES($1,'Synthetic cart brand','active',1,'Synthetic terms')",[brand]);
   await c.query("INSERT INTO products(id,brand_id,reference,price,sizes,color,stock_enabled,stock_qty) VALUES($1,$2,'CART-UI-ONLY',12.5,'M','Gold',true,100)",[product,brand]);
  });
  browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  for(const width of [360,1440])for(const lang of ['fr','en']){
   const buyer=id('buyer'),sid=randomUUID(),now=Date.now();
   await db(async c=>{
    await c.query("INSERT INTO buyers(id,email,password_hash,name,company,country) VALUES($1,$2,'not-a-password','Synthetic Buyer','Synthetic Shop','FR')",[buyer,buyer+'@example.test']);
    await c.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sid,JSON.stringify({cookie:{originalMaxAge:86400000,expires:new Date(now+86400000).toISOString(),httpOnly:true,path:'/'},authAt:now,lastActive:now,buyerPortal:{id:buyer,email:buyer+'@example.test',name:'Synthetic Buyer',company:'Synthetic Shop'}})]);
   });
   const signed='s:'+sid+'.'+createHmac('sha256','test-secret-not-for-production').update(sid).digest('base64').replace(/=+$/,'');
   const cookie='sid='+encodeURIComponent(signed);
   const api=async(url,method='GET',body)=>{const r=await fetch(server.baseUrl+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
   const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
   await context.addCookies([{name:'sid',value:encodeURIComponent(signed),url:server.baseUrl}]);
   await context.addInitScript(lang=>localStorage.setItem('portal_lang',lang),lang);
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   let posts=0,payload,holdRead=false,heldRead,oldSnapshot;
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.origin!==server.baseUrl)return route.abort();
    if(u.pathname==='/api/portal/cart-state'&&route.request().method()==='GET'&&holdRead){holdRead=false;return new Promise(resolve=>{heldRead=async()=>{await route.fulfill({contentType:'application/json',body:JSON.stringify(oldSnapshot)});resolve();};});}
    if(u.pathname==='/api/portal/checkout-v2'&&route.request().method()==='POST'){
     posts++;payload=route.request().postDataJSON();
     if(width===1440)await route.fetch(); // commit, then lose the response
     if(width===360&&lang==='en')return route.fulfill({contentType:'application/json',body:'{}'});
     return route.abort();
    }
    return route.continue();
   });
   await page.goto(server.baseUrl+'/portal');await page.waitForFunction(()=>typeof PortalCart!=='undefined'&&document.getElementById('save-status-cart').classList.contains('saved'));
   await page.evaluate(async({brand,product})=>{await openBrand(brand);changeQty(product,'M',1,'Gold');showView('cart');await PortalCart.sync();},{brand,product});
   const base=(await api('/api/portal/cart-state')).body,remote=JSON.parse(JSON.stringify(base.cart));Object.values(remote)[0].qty=2;
   assert.equal((await api('/api/portal/cart-state','PUT',{cart_id:base.cart_id,revision:base.revision,cart:remote})).status,200);
   await page.locator('[data-cart-input]').first().fill('3');await page.locator('[data-cart-input]').first().dispatchEvent('change');
   await page.evaluate(()=>PortalCart.sync().catch(()=>{}));
   await page.locator('[data-cart-reread]').click();await page.locator('[data-cart-new-intent]').waitFor();
   assert.match(await page.locator('#cart-sync-panel').innerText(),lang==='fr'?/version locale/:/local version/);
   if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`cart-conflict-${width}-${lang}.png`)});}
   await page.locator('[data-cart-new-intent]').check();await page.locator('[data-cart-local]').click();
   await page.waitForFunction(()=>document.getElementById('cart-sync-panel').hidden);await page.evaluate(()=>PortalCart.sync());
   assert.equal(Object.values((await api('/api/portal/cart-state')).body.cart)[0].qty,3);
   const original=await page.evaluate(()=>JSON.parse(JSON.stringify(cart)));
   await context.setOffline(true);await page.evaluate(()=>{cart={};saveCart();});
   await context.setOffline(false);await page.evaluate(()=>PortalCart.sync());
   assert.deepEqual((await api('/api/portal/cart-state')).body.cart,{});
   await page.evaluate(async original=>{cart=original;saveCart();await PortalCart.sync();renderCart(true);},original);
   if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`cart-ready-${width}-${lang}.png`)});}
   await page.locator('#ck-name').fill('Synthetic Buyer');await page.locator('#ck-country').selectOption('FR');
   await page.evaluate(()=>{document.querySelectorAll('.cgv-brand-checkbox').forEach(cb=>{cb.disabled=false;cb.checked=true;openedCgvBrands.add(cb.dataset.brandId);});sigMode='type';document.getElementById('sig-typed').value='Synthetic Buyer';});
   oldSnapshot=(await api('/api/portal/cart-state')).body;
   await page.locator('#btn-confirm-order').click();await page.locator('[data-cart-recover]').waitFor();await page.locator('#cart-transfer-lock').waitFor({state:'detached'});
   assert.equal(posts,1);assert.ok(payload.request_key);assert.equal(await page.locator('#cart-pending-dialog').evaluate(el=>el.open),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#cart-pending-dialog').evaluate(el=>el.open),true);
   const persisted=await page.evaluate(()=>localStorage.getItem('buyer_cart_attempt_v2:'+encodeURIComponent(me.id)));
   assert.ok(persisted.includes(payload.request_key));assert.equal(persisted.includes('data:image'),false);
   if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`cart-pending-${width}-${lang}.png`)});
   holdRead=width===1440;await page.reload();await page.waitForFunction(()=>typeof PortalCart!=='undefined'&&typeof me!=='undefined'&&me?.id);
   await page.evaluate(()=>showView('cart'));await page.locator('[data-cart-recover]').waitFor();
   if(width===1440){
    await page.locator('[data-cart-recover]').click();await page.locator('#view-success').waitFor({state:'visible'});
    assert.match(await page.locator('#success-detail').innerText(),/ES-/);
    while(!heldRead)await new Promise(resolve=>setTimeout(resolve,5));await heldRead();
    await page.waitForFunction(()=>Object.keys(cart).length===0);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem(CART_KEY+'_v2')).local),{});
   }else{
    await page.locator('[data-cart-close]').click();await page.waitForFunction(()=>!document.querySelector('[data-cart-close]'));
    const delayed=await api('/api/portal/checkout-v2','POST',payload);assert.equal(delayed.status,409);
    assert.equal(Object.values((await api('/api/portal/cart-state')).body.cart)[0].qty,3);
   }
   const count=await db(async c=>Number((await c.query('SELECT COUNT(*) AS n FROM orders WHERE buyer_id=$1',[buyer])).rows[0].n));assert.equal(count,width===1440?1:0);
   assert.equal(posts,1);assert.equal(await page.evaluate(()=>localStorage.getItem('buyer_cart_attempt_v2:'+encodeURIComponent(me.id))),null);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
   if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`cart-resolved-${width}-${lang}.png`)});
   console.log(`PASS real local server cart conflict, explicit choice, reload and ${width===1440?'lost response recovery':'unknown attempt closure'}: ${width}px ${lang}`);
   await page.evaluate(()=>{localStorage.setItem('buyer_cart_attempt_v2:test','test');portalLogout();});assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('portal_cart_')||k.startsWith('buyer_cart_attempt_v2:'))),false);
   await context.close();
  }
 }finally{await browser?.close();server?.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
