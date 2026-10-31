// Synthetic browser fixtures only. Run with PLAYWRIGHT_MODULE and optionally
// CHROME_EXECUTABLE / SCREENSHOT_DIR. No production connection is made.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),args:['--no-sandbox']});
  try {
    for(const width of [360,1440])for(const lang of ['fr','en']) {
      const page=await browser.newPage({viewport:{width,height:900}}),errors=[],nativeDialogs=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{nativeDialogs.push(d.type());d.dismiss();});
      await page.addInitScript(lang=>localStorage.setItem('portal_lang',lang),lang);
      let billing={address:'Legacy street',reference:'KEEP'},billingWrites=0,failBilling=true,checkoutBody,checkoutCalls=0;
      let lists=[{id:'list1',owner_id:'buyer',name:'Existing list',notes:'Existing notes',product_ids:[],shared:false}];
      const brand={id:'b',name:'Test brand',min_per_reference:1,cgv_text:'Test terms',payment_terms:'Test payment terms',delivery_terms:'Test delivery terms'};
      await page.route('**/*',async route=>{
        const request=route.request(),u=new URL(request.url());if(u.hostname!=='showroom.test')return route.abort();
        const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
        if(u.pathname==='/logo.svg')return route.fulfill({contentType:'image/svg+xml',body:fs.readFileSync(root+'/public/logo.svg','utf8')});
        if(u.pathname==='/portal')return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'/public/portal.html','utf8')});
        if(['/countries.js','/buyer-tools.js','/ordering-rules.js'].includes(u.pathname))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(root+'/public'+u.pathname,'utf8')});
        if(u.pathname==='/api/portal/me')return send({id:'buyer',email:'synthetic@example.test',name:'Test buyer',company:'Test shop',country:'Other'});
        if(u.pathname==='/api/portal/brands')return send([brand]);
        if(u.pathname==='/api/portal/cart')return send({});
        if(u.pathname==='/api/portal/company' && request.method()==='GET')return send({company:{id:'company',name:'Test shop',billing},role:'owner',users:[],locations:[]});
        if(u.pathname==='/api/portal/company' && request.method()==='PUT'){
          billingWrites++;
          if(failBilling){failBilling=false;return send({error:'Temporary error — retry'},503);}
          billing=request.postDataJSON().billing;return send({ok:true});
        }
        if(u.pathname==='/api/portal/company/invites')return send({url:'/portal?company_invite=synthetic-token'});
        if(u.pathname==='/api/portal/buying-shortlists' && request.method()==='GET')return send(lists);
        if(u.pathname==='/api/portal/buying-shortlists' && request.method()==='POST'){lists.push({id:'new',owner_id:'buyer',product_ids:[],...request.postDataJSON()});return send({id:'new'});}
        if(u.pathname==='/api/portal/buying-shortlists/list1'){lists[0]={...lists[0],...request.postDataJSON()};return send({ok:true});}
        if(u.pathname==='/api/portal/checkout'){checkoutBody=request.postDataJSON();checkoutCalls++;const recorded={brand_id:checkoutCalls===1?'b':'c',brand_name:'Test brand',order_id:'o',order_number:'TEST-ONLY',reference_count:1,pieces:1,total:100,payment_terms:'Test payment terms'};return send(checkoutCalls===1?{ok:false,orders:[recorded,{brand_id:'c',brand_name:'Second brand',error:'Temporarily unavailable'}]}:{ok:true,orders:[recorded]});}
        if(u.pathname.startsWith('/api/'))return send([]);
        return route.fulfill({status:404,body:''});
      });
      await page.goto('http://showroom.test/portal');
      await page.waitForFunction(()=>typeof allBrands!=='undefined' && allBrands.length===1);
      await page.evaluate(async()=>{showView('account');await BuyerTools.loadCompany();});
      assert.equal(await page.locator('#prof-country').inputValue(),'Other');
      assert.match(await page.locator('#prof-country option:checked').innerText(),lang==='fr'?/À vérifier/:/To verify/);
      await page.locator('[data-company-action=billing]').click();
      const dialog=page.locator('dialog[open]');
      assert.equal(await dialog.locator('[name=address]').inputValue(),'Legacy street');
      await dialog.locator('[name=city]').fill('Paris');await dialog.locator('[name=country]').selectOption('FR');
      await dialog.locator('[type=submit]').click();
      await page.waitForFunction(()=>document.querySelector('dialog [role=alert]').textContent.includes('Temporary error'));
      assert.equal(await dialog.locator('[name=city]').inputValue(),'Paris');
      await dialog.locator('[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
      assert.equal(billingWrites,2);assert.equal(billing.reference,'KEEP');assert.equal(billing.country,'FR');
      await page.locator('[data-company-action=location]').click();
      if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`buyer-address-${width}-${lang}.png`)});}
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
      await page.locator('[data-company-action=invite]').click();await dialog.locator('[name=email]').fill('colleague@example.test');await dialog.locator('[type=submit]').click();
      await page.locator('[data-invite-link]').waitFor();assert.match(await page.locator('[data-invite-link]').inputValue(),/synthetic-token/);
      assert.match(await dialog.innerText(),lang==='fr'?/Aucun email n’a été envoyé/:/No email was sent/);await dialog.locator('[data-cancel]').click();
      await page.evaluate(async()=>{showView('shortlist');await BuyerTools.loadShortlists();document.getElementById('named-shortlists').scrollIntoView();});
      // The owner can edit existing notes without losing them on cancellation.
      await page.locator('[data-shortlist-action=notes][data-id=list1]').click();
      assert.equal(await dialog.locator('[name=notes]').inputValue(),'Existing notes');await dialog.locator('[name=notes]').fill('Edited notes');await dialog.locator('[type=submit]').click();
      await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(lists[0].notes,'Edited notes');
      await page.evaluate(()=>{allBrands.push({...allBrands[0],id:'c',name:'Second brand'});cart={line:{brand_id:'b',brand_name:'Test brand',product_id:'p',reference:'TEST',qty:1,price:100,size:'',color:''},second:{brand_id:'c',brand_name:'Second brand',product_id:'p2',reference:'TEST2',qty:1,price:100,size:'',color:''}};showView('cart');});
      await page.locator('#btn-confirm-order').click();assert.equal(checkoutBody,undefined);
      assert.match(await page.locator('#checkout-msg').innerText(),lang==='fr'?/Sélectionnez un pays/:/Select a country/);
      await page.locator('#ck-country').selectOption('DK');
      await page.evaluate(()=>{document.querySelectorAll('.cgv-brand-checkbox').forEach(cb=>{cb.disabled=false;cb.checked=true;openedCgvBrands.add(cb.dataset.brandId);});sigMode='type';document.getElementById('sig-typed').value='Synthetic Buyer';});
      await page.locator('#btn-confirm-order').click();await page.waitForFunction(()=>document.getElementById('checkout-msg').textContent.includes('Temporarily unavailable'));
      assert.equal(await page.locator('#ck-country').inputValue(),'DK');
      assert.deepEqual(await page.evaluate(()=>Object.values(cart).map(l=>l.brand_id)),['c']);
      await page.locator('#btn-confirm-order').click();await page.locator('#view-success').waitFor({state:'visible'});
      assert.equal(checkoutBody.client_country,'DK');assert.match(await page.locator('#success-detail').innerText(),/TEST-ONLY/);
      assert.doesNotMatch(await page.locator('#view-success').innerText(),/7 days|7 jours|email.*(?:sent|envoyé)/i);
      assert.equal(await page.evaluate(()=>window.scrollY),0);
      if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`buyer-confirmation-${width}-${lang}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'horizontal overflow');
      assert.deepEqual(nativeDialogs,[]);assert.deepEqual(errors,[]);
      console.log(`PASS buyer forms, retry, legacy preservation, invite, notes, country, partial retry and confirmation: ${width}px ${lang}`);
      await page.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
