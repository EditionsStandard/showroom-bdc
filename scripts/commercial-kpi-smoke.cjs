'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {startServer,withDb,id}=require('../test/helpers');
const {authenticator}=require('otplib');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  let server,browser;
  try {
    server=await startServer({dbNameSuffix:'commercial_ui_'+Date.now(),port:3226});
    const secret=authenticator.generateSecret(),brand=id('kpi_brand'),buyer=id('kpi_buyer'),product=id('kpi_product');
    await withDb(server.dbUrl,async db=>{
      await db.query("INSERT INTO settings(key,value) VALUES('owner_mfa_enabled','on'),('owner_mfa_secret',$1),('owner_mfa_last_step','0') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[secret]);
      await db.query("INSERT INTO brands(id,name,subscription_status) VALUES($1,'Synthetic KPI brand','active')",[brand]);
      await db.query("INSERT INTO buyers(id,email,password_hash,name,company) VALUES($1,'kpi@example.test','not-a-password','Synthetic KPI buyer','Synthetic shop')",[buyer]);
      await db.query("INSERT INTO products(id,brand_id,reference,description,price) VALUES($1,$2,'TEST-KPI-PRODUCT','Synthetic product',100)",[product,brand]);
      for(const [status,amount] of [['confirmed',100],['draft',10000],['cancelled',10000],['archived',10000]]){
        const order=id('kpi_order');
        await db.query("INSERT INTO orders(id,brand_id,buyer_id,status,client_name,client_email,client_country,order_number) VALUES($1,$2,$3,$4,'Synthetic KPI buyer','kpi@example.test','FR','TEST-ONLY')",[order,brand,buyer,status]);
        for(const price of [amount,amount,amount/2])await db.query('INSERT INTO order_lines(id,order_id,product_id,quantity,unit_price) VALUES($1,$2,$3,1,$4)',[id('line'),order,product,price]);
      }
      for(const [status,used,template] of [['sent',true,false],['sent',false,false],['sent',false,false],['draft',true,false],['sent',true,true]]) {
        await db.query("INSERT INTO agent_selections(token,brand_id,client_email,items_json,expires_at,status,used,is_template) VALUES($1,$2,'kpi@example.test','[]',NOW()+INTERVAL '30 days',$3,$4,$5)",[id('selection'),brand,status,used,template]);
      }
    });
    const post=(route,body,cookie)=>fetch(server.baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),redirect:'manual'});
    const initial=await post('/admin/login',{password:'TestAdmin123!'});
    const final=await post('/admin/login/mfa',{code:authenticator.generate(secret)},initial.headers.get('set-cookie').split(';')[0]);
    const cookie=(final.headers.get('set-cookie')||initial.headers.get('set-cookie')).split(';')[0];
    const expectedStats=await (await fetch(server.baseUrl+'/api/stats',{headers:{Cookie:cookie}})).json();
    browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
    for(const width of [360,1440])for(const lang of ['fr','en']) {
      const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
      await context.addCookies([{name:cookie.slice(0,cookie.indexOf('=')),value:cookie.slice(cookie.indexOf('=')+1),url:server.baseUrl}]);
      await context.addInitScript(lang=>localStorage.setItem('portal_lang',lang),lang);
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      let failChart=true,failProducts=true,chartCalls=0,productCalls=0,statsMode='http',holdNextStats=false,heldStats;
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());if(url.origin!==server.baseUrl)return route.abort();
        if(url.pathname==='/api/stats'){
          const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
          if(holdNextStats){holdNextStats=false;return new Promise(resolve=>{heldStats=async()=>{await send({...expectedStats,orders_count:999});resolve();};});}
          if(statsMode==='http')return send({error:'synthetic unavailable'},500);
          if(statsMode==='json')return route.fulfill({contentType:'application/json',body:'{invalid'});
          if(statsMode==='object')return send({});
          if(statsMode==='network')return route.abort();
          if(statsMode==='zero')return send({...expectedStats,brands_count:0,orders_count:0,buyers_count:0,revenue_total:0,pending_validation_total:0,validated_orders_total:0,selections_proposed:0,selections_accepted:0,selection_acceptance_rate:0});
        }
        if(url.pathname==='/api/dashboard/revenue-chart'){
          chartCalls++;if(failChart)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic unavailable"}'});
        }
        if(url.pathname==='/api/dashboard/top-products'){
          productCalls++;if(failProducts)return route.fulfill({status:500,contentType:'application/json',body:'{"error":"synthetic unavailable"}'});
        }
        return route.continue();
      });
      await page.goto(server.baseUrl+'/admin');
      await page.waitForFunction(()=>document.querySelector('[data-dashboard-stats-retry]')&&document.querySelector('[data-revenue-chart-retry]')&&document.querySelector('[data-top-products-retry]'));
      assert.equal(await page.locator('#stat-orders').innerText(),'—');
      assert.equal(await page.locator('#stat-conversion').innerText(),'—');
      assert.match(await page.locator('#stat-conv-sub').innerText(),lang==='fr'?/indisponibles/:/unavailable/);
      statsMode='ok';const previousChartCalls=chartCalls,previousProductCalls=productCalls;
      await page.locator('[data-dashboard-stats-retry]').click();
      await page.waitForFunction(()=>document.querySelector('#stat-conversion').textContent==='33%');
      assert.equal(chartCalls,previousChartCalls,'stats retry must not refetch the chart');
      assert.equal(productCalls,previousProductCalls,'stats retry must not refetch products');
      assert.equal(await page.locator('#stat-orders').innerText(),'1');assert.match(await page.locator('#stat-total').innerText(),/250/);
      assert.match(await page.locator('[data-t=stat_conversion]').innerText(),lang==='fr'?/Acceptation/i:/acceptance/i);
      assert.equal(await page.locator('#chart-total').innerText(),'—');assert.equal(await page.evaluate(()=>_lastChartData.length),0);
      assert.equal(await page.locator('#top-buyers-body tr').first().locator('td').nth(2).innerText(),'1');
      failChart=false;const previousProducts=productCalls;
      await page.locator('[data-revenue-chart-retry]').click();
      await page.waitForFunction(()=>document.getElementById('chart-total').textContent.includes('250'));
      assert.equal(productCalls,previousProducts,'chart retry must not refetch the independent product list');
      assert.equal(await page.evaluate(()=>_lastChartData.length),6);
      assert.equal(await page.evaluate(()=>_lastChartData.reduce((sum,row)=>sum+row.total,0)),250);
      const previousCharts=chartCalls;failProducts=false;await page.locator('[data-top-products-retry]').click();
      await page.waitForFunction(()=>document.getElementById('top-products-list').textContent.includes('TEST-KPI-PRODUCT'));
      assert.equal(chartCalls,previousCharts);assert.match(await page.locator('#top-products-list').innerText(),/250/);
      const healthyCharts=chartCalls,healthyProducts=productCalls;
      for(const mode of ['json','object','network']){
        statsMode=mode;await page.evaluate(()=>loadDashboardStats());
        assert.equal(await page.locator('#dashboard-stats-status').getAttribute('data-state'),'error');
        assert.equal(await page.locator('#stat-orders').innerText(),'—');
        assert.match(await page.locator('#stat-conv-sub').innerText(),lang==='fr'?/indisponibles/:/unavailable/);
      }
      statsMode='zero';await page.evaluate(()=>loadDashboardStats());
      assert.equal(await page.locator('#stat-orders').innerText(),'0');assert.equal(await page.locator('#stat-total').innerText(),'0.00 €');
      assert.equal(await page.locator('#stat-conversion').innerText(),'—');
      assert.match(await page.locator('#stat-conv-sub').innerText(),lang==='fr'?/Aucune proposition/:/No recorded proposal/);
      statsMode='ok';holdNextStats=true;await page.evaluate(()=>{window.oldStatsLoad=loadDashboardStats();});
      while(!heldStats)await new Promise(resolve=>setTimeout(resolve,5));
      await page.evaluate(()=>loadDashboardStats());await heldStats();await page.evaluate(()=>window.oldStatsLoad);
      assert.equal(await page.locator('#stat-orders').innerText(),'1','old stats response must not overwrite newer success');
      assert.equal(chartCalls,healthyCharts);assert.equal(productCalls,healthyProducts);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'admin overflow');
      if(process.env.SCREENSHOT_DIR){fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.locator('#conversion-card').screenshot({path:path.join(process.env.SCREENSHOT_DIR,`selection-acceptance-${width}-${lang}.png`)});}
      assert.deepEqual(errors,[]);console.log(`PASS commercial KPI labels, active totals, distinct orders, independent stats/chart/product retries and stale response protection: ${width}px ${lang}`);
      await context.close();
    }
  }finally{await browser?.close();server?.stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
