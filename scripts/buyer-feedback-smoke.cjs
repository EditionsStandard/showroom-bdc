'use strict';
// Synthetic browser fixtures only: no backend, real buyer, notification or email.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  try {
    for(const width of [360,1440])for(const lang of ['fr','en']) {
      const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(lang=>localStorage.setItem('portal_lang',lang),lang);
      let pendingMode='http',ordersMode='ok',messageMode='ok',threadMode='ok';
      let pendingCount=0,ordersCount=0,postCount=0,holdNextOrder=false,heldOrder,holdNextPost=false,heldPost;
      let orderNumber='INITIAL-ORDER',thread=[];const payloads=[];
      const order=number=>({id:'synthetic-order',order_number:number,brand_name:'Synthetic brand',status:'confirmed',created_at:'2026-11-01T12:00:00Z',total:'120.00'});
      const attachment={url:'https://res.cloudinary.com/test-only/example.pdf',name:'Synthetic <img src=x>.pdf',type:'application/pdf'};
      await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());if(url.hostname!=='showroom.test')return route.abort();
        const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(url.pathname==='/portal')return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'/public/portal.html','utf8')});
        if(['/countries.js','/ordering-rules.js','/buyer-tools.js','/buyer-email-preferences.js'].includes(url.pathname))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(root+'/public'+url.pathname,'utf8')});
        if(url.pathname==='/logo.svg')return route.fulfill({contentType:'image/svg+xml',body:fs.readFileSync(root+'/public/logo.svg','utf8')});
        if(url.pathname==='/api/portal/me')return send({id:'synthetic-buyer',email:'synthetic@example.test',name:'Synthetic buyer',company:'Synthetic shop',country:'FR'});
        if(url.pathname==='/api/portal/brands')return send([]);
        if(url.pathname==='/api/portal/cart')return send({});
        if(url.pathname==='/api/portal/pending-selections'){
          pendingCount++;
          if(pendingMode==='http')return send({error:'<img src=x onerror=alert(1)>'},503);
          if(pendingMode==='object')return send({unexpected:true});
          if(pendingMode==='row')return send([{}]);
          if(pendingMode==='empty')return send([]);
          return send([{token:'synthetic-selection',brand_name:'Synthetic proposal',piece_count:3}]);
        }
        if(url.pathname==='/api/portal/orders'){
          ordersCount++;
          if(holdNextOrder){holdNextOrder=false;return new Promise(resolve=>{heldOrder=async()=>{await send([order('STALE-ORDER')]);resolve();};});}
          if(ordersMode==='http')return send({error:'unavailable'},500);
          if(ordersMode==='json')return route.fulfill({contentType:'application/json',body:'{invalid'});
          if(ordersMode==='row')return send([{}]);
          if(ordersMode==='network')return route.abort();
          if(ordersMode==='empty')return send([]);
          return send([order(orderNumber)]);
        }
        if(url.pathname==='/api/portal/messages'&&request.method()==='POST'){
          postCount++;const payload=request.postDataJSON();payloads.push(payload);
          if(holdNextPost){holdNextPost=false;return new Promise(resolve=>{heldPost=async()=>{await send({ok:true});resolve();};});}
          if(messageMode==='rejected')return send({error:'synthetic rejection'},400);
          if(messageMode==='408')return send({error:'timeout'},408);
          if(messageMode==='500')return send({error:'synthetic failure'},500);
          if(messageMode==='ack')return send({unexpected:true});
          if(messageMode==='json')return route.fulfill({contentType:'application/json',body:'{invalid'});
          if(messageMode==='lost'){
            thread.push({id:'recorded-'+postCount,sender:'buyer',body:payload.body,subject:payload.subject,created_at:'2026-11-02T12:00:00Z'});
            return route.abort();
          }
          return send({ok:true});
        }
        if(url.pathname==='/api/portal/messages'){
          if(threadMode==='http')return send({error:'unavailable'},503);
          if(threadMode==='row')return send([]);
          return send({messages:thread});
        }
        if(url.pathname==='/api/portal/messages/unread'||url.pathname==='/api/portal/notifications/unread')return send({unread:0});
        if(url.pathname==='/api/portal/email-preferences')return send({status:'unknown'});
        if(url.pathname.startsWith('/api/'))return send([]);
        return route.fulfill({status:404,body:''});
      });
      await page.goto('http://showroom.test/portal');
      await page.waitForFunction(()=>window._pingInterval&&document.querySelector('#dash-pending').dataset.state==='error'&&document.querySelector('#dash-orders').dataset.state==='ready');
      assert.match(await page.locator('#dash-orders').innerText(),/INITIAL-ORDER/);
      assert.doesNotMatch(await page.locator('#dash-next-action').innerText(),/tout est à jour|Nothing needs/i);
      assert.equal(await page.locator('#dash-pending img').count(),0);
      const initialOrders=ordersCount;pendingMode='ok';await page.locator('[data-dashboard-retry=pending]').click();
      await page.waitForFunction(()=>document.querySelector('#dash-pending').dataset.state==='ready');
      assert.equal(ordersCount,initialOrders,'pending retry must preserve healthy orders without refetch');
      assert.match(await page.locator('#dash-pending').innerText(),/Synthetic proposal/);
      for(const mode of ['http','json','row','network']){
        ordersMode=mode;const previousPending=pendingCount;
        await page.evaluate(()=>retryDashboardSection('orders'));
        assert.equal(await page.locator('#dash-orders').getAttribute('data-state'),'error');
        assert.equal(pendingCount,previousPending);assert.match(await page.locator('#dash-pending').innerText(),/Synthetic proposal/);
      }
      ordersMode='ok';await page.locator('[data-dashboard-retry=orders]').click();
      await page.waitForFunction(()=>document.querySelector('#dash-orders').dataset.state==='ready');
      for(const mode of ['object','row']){
        pendingMode=mode;await page.evaluate(()=>retryDashboardSection('pending'));
        assert.equal(await page.locator('#dash-pending').getAttribute('data-state'),'error');
        assert.doesNotMatch(await page.locator('#dash-next-action').innerText(),/tout est à jour|Nothing needs/i);
      }
      pendingMode='empty';ordersMode='empty';await page.evaluate(()=>loadDashboard());
      assert.match(await page.locator('#dash-next-action').innerText(),lang==='fr'?/tout est à jour/:/Nothing needs/);
      assert.match(await page.locator('#dash-orders').innerText(),lang==='fr'?/Aucune commande/:/No orders/);
      pendingMode='ok';ordersMode='ok';holdNextOrder=true;
      await page.evaluate(()=>{window.oldDashboardLoad=loadDashboard();});
      await page.waitForFunction(()=>document.querySelector('#dash-orders').dataset.state==='loading');
      // Wait for interception, not an arbitrary delay.
      while(!heldOrder)await new Promise(resolve=>setTimeout(resolve,5));
      orderNumber='NEW-ORDER';await page.evaluate(()=>loadDashboard());
      await heldOrder();await page.evaluate(()=>window.oldDashboardLoad);
      assert.match(await page.locator('#dash-orders').innerText(),/NEW-ORDER/);assert.doesNotMatch(await page.locator('#dash-orders').innerText(),/STALE-ORDER/);
      if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`buyer-dashboard-${width}-${lang}.png`)});}
      await page.evaluate(()=>{openChatWidget();stopPmsgPolling();});
      await page.locator('#pmsg-input').fill('Preserved draft <img src=x>');await page.locator('#pmsg-subject').fill('Synthetic subject');
      await page.evaluate(attachment=>{_pmsgPendingAttachment=attachment;renderPmsgAttachPreview();},attachment);
      messageMode='rejected';await page.locator('#pmsg-send').click();
      await page.waitForFunction(()=>!document.getElementById('pmsg-send-retry').hidden);
      assert.equal(postCount,1);assert.equal(await page.locator('#pmsg-input').inputValue(),'Preserved draft <img src=x>');
      assert.match(await page.locator('#pmsg-send-status').innerText(),lang==='fr'?/refusé/:/rejected/);
      assert.equal(await page.evaluate(()=>_pmsgPendingAttachment.url),attachment.url);
      messageMode='ok';await page.locator('#pmsg-send-retry').click();
      await page.waitForFunction(()=>document.getElementById('pmsg-input').value==='');
      assert.equal(postCount,2);assert.deepEqual(payloads[0],payloads[1]);assert.equal(await page.evaluate(()=>_pmsgPendingAttachment),null);
      for(const mode of ['lost','500','408','ack','json']){
        messageMode=mode;const previous=postCount;
        await page.locator('#pmsg-input').fill('Ambiguous '+mode);await page.locator('#pmsg-subject').fill('Keep subject');
        await page.evaluate(attachment=>{_pmsgPendingAttachment=attachment;renderPmsgAttachPreview();},attachment);
        await page.locator('#pmsg-send').click();
        await page.waitForFunction(()=>!document.getElementById('pmsg-send-review').hidden&&!document.getElementById('pmsg-send-review').disabled);
        assert.equal(await page.locator('#pmsg-send').isDisabled(),true);assert.equal(await page.locator('#pmsg-input').inputValue(),'Ambiguous '+mode);
        await page.evaluate(()=>sendPortalMessage());assert.equal(postCount,previous+1,'uncertain outcome cannot auto-resend');
        threadMode='http';await page.locator('#pmsg-send-review').click();
        await page.waitForFunction(()=>!document.getElementById('pmsg-send-review').disabled);
        assert.equal(await page.locator('#pmsg-send').isDisabled(),true);
        threadMode='ok';await page.locator('#pmsg-send-review').click();
        await page.waitForFunction(()=>!document.getElementById('pmsg-send-retry').hidden);
        assert.equal(postCount,previous+1,'reviewing conversation is GET only');
        if(mode==='lost')assert.match(await page.locator('#pmsg-thread').innerText(),/Ambiguous lost/);
        if(process.env.SCREENSHOT_DIR&&mode==='lost')await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`buyer-message-review-${width}-${lang}.png`)});
        messageMode='ok';await page.locator('#pmsg-send-retry').click();
        await page.waitForFunction(()=>document.getElementById('pmsg-input').value==='');assert.equal(postCount,previous+2);
      }
      await page.locator('#pmsg-input').fill('Concurrent click fixture');holdNextPost=true;
      const previous=postCount;
      await page.evaluate(()=>{window.firstMessage=sendPortalMessage();window.secondMessage=sendPortalMessage();});
      while(!heldPost)await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(postCount,previous+1);await heldPost();await page.evaluate(()=>Promise.all([window.firstMessage,window.secondMessage]));
      assert.equal(postCount,previous+1,'concurrent sends must be serialized');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
      assert.deepEqual(errors,[]);
      console.log(`PASS buyer dashboard partial failures/retries/races and preserved chat drafts/ambiguous outcomes: ${width}px ${lang}`);
      await context.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
