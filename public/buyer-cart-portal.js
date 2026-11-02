// Loaded before portal code; global portal bindings are read only on invocation.
const PortalCart=(()=>{
  let engine,proposal,busy=false,storedError=false,otherTab=false,generation=0;
  const L=(fr,en)=>currentLang==='en'?en:fr;
  const key=()=>CART_KEY+'_v2';
  function newKey(){
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
  }
  async function json(url,options){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{const response=await fetch(url,{...options,signal:controller.signal});if(!response.ok){const error=new Error('cart_http_'+response.status);error.status=response.status;throw error;}return await response.json();}
    finally{clearTimeout(timer);}
  }
  const send=(url,body,method='POST')=>json(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  function pending(){return BuyerCartClient.readAttempt(localStorage,me.id);}
  function changed(s,version){
    if(version!==generation)return;
    cart=OrderingRules.normalize(s.cart,allBrands);
    try{
      localStorage.setItem(key(),JSON.stringify({base:s.phase==='review'?s.recovery?.base:s.base,local:s.cart,review:['review','error'].includes(s.phase),recorded_at:Date.now()}));
      localStorage.setItem(CART_KEY,JSON.stringify(s.cart));storedError=false;
    }catch{storedError=true;}
    const dirty=JSON.stringify(s.cart)!==JSON.stringify(s.base?.cart);
    clearTimeout(cartSyncTimer);
    if(s.phase==='ready'&&dirty&&!busy&&!storedError&&!pending())cartSyncTimer=setTimeout(()=>sync().catch(()=>{}),1200);
    setSaveStatus(storedError||['error','review'].includes(s.phase)?'error':s.phase==='saving'?'saving':s.phase==='ready'&&!dirty?'saved':'saving','');
    updateCartBar();render();
  }
  function render(){
    const box=document.getElementById('cart-sync-panel');if(!box||(!engine&&!storedError))return;
    let attempt;try{attempt=pending();}catch{storedError=true;}
    const s=engine?engine.inspect():{phase:'error'};box.hidden=!(storedError||attempt||['error','review','loading'].includes(s.phase)||otherTab);
    if(box.hidden){box.textContent='';const previous=document.getElementById('cart-pending-dialog');if(previous){previous.close();previous.remove();}return;}
    let html='';
    if(storedError)html+=`<p>${L('Le stockage local est indisponible ou invalide. La commande est bloquée. Conservez cette page ouverte.','Local storage is unavailable or invalid. Ordering is blocked. Keep this page open.')}</p>`;
    if(attempt)html+=`<p>${L('Une transmission reste à vérifier. Aucun renvoi automatique ne sera effectué.','A submission still needs checking. It will not be sent again automatically.')}</p><button type="button" data-cart-recover>${L('Vérifier les commandes','Check orders')}</button> <button type="button" data-cart-close>${L('Clôturer la tentative — conserver les commandes déjà enregistrées','Close attempt — keep orders already recorded')}</button> <button type="button" data-cart-logout>${L('Se déconnecter de cet appareil','Log out of this device')}</button>`;
    else if(['error','loading'].includes(s.phase)||otherTab)html+=`<p>${L('Vérification du panier nécessaire. Vos modifications locales sont conservées.','Your cart needs checking. Your local changes are preserved.')}</p><button type="button" data-cart-reread>${L('Relire le panier serveur','Read server cart')}</button>`;
    else if(s.phase==='review'){
      proposal=BuyerCartClient.merge(s.recovery?.base,s.cart,s.base);
      const list=value=>Object.values(value).map(row=>`<li>${esc(row.brand_name||row.brand_id)} · ${esc(row.reference||row.product_id)} · ${esc(row.color||'')} ${esc(row.size||'')} × ${esc(row.qty)}${row.note?' · '+esc(row.note):''}</li>`).join('')||`<li>${L('Panier vide','Empty cart')}</li>`;
      html+=`<p>${L('Le panier a changé ou provient d’une ancienne session. Choisissez la version à conserver.','The cart changed or comes from an older session. Choose which version to keep.')}</p><details open><summary>${L('Votre version locale','Your local version')}</summary><ul>${list(s.cart)}</ul></details><details open><summary>${L('Version serveur','Server version')}</summary><ul>${list(s.base.cart)}</ul></details><button type="button" data-cart-remote>${L('Garder la version serveur','Keep server version')}</button> <button type="button" data-cart-merge>${L('Appliquer seulement les changements compatibles','Apply compatible changes only')}</button><p><label><input type="checkbox" data-cart-new-intent> ${L('Remplacer le panier serveur par ma version locale ; les marques déjà commandées constitueront un nouvel achat.','Replace the server cart with my local version; previously ordered brands will become a new purchase.')}</label></p><button type="button" data-cart-local disabled>${L('Utiliser ma version locale','Use my local version')}</button>`;
    }
    let surface=box;
    let dialog=document.getElementById('cart-pending-dialog');
    if(attempt){
      box.hidden=true;
      if(!dialog){dialog=document.createElement('dialog');dialog.id='cart-pending-dialog';dialog.className='buyer-dialog';dialog.setAttribute('aria-label',L('Vérifier la transmission','Check submission'));dialog.style='width:600px;max-width:calc(100vw - 32px);max-height:80vh;overflow:auto;padding:24px;overflow-wrap:anywhere';dialog.addEventListener('cancel',event=>event.preventDefault());document.body.append(dialog);}
      surface=dialog;
      if(busy&&dialog.open)dialog.close();
      if(!busy&&!dialog.open)dialog.showModal();
    }else if(dialog){dialog.close();dialog.remove();}
    surface.innerHTML=html;
    const bind=(selector,fn)=>surface.querySelector(selector)?.addEventListener('click',()=>Promise.resolve().then(fn).catch(()=>{setSaveStatus('error');render();}));
    bind('[data-cart-logout]',()=>{portalLogout();window.location.href='/portal-logout';});bind('[data-cart-reread]',reconcile);bind('[data-cart-recover]',recover);bind('[data-cart-close]',close);
    bind('[data-cart-remote]',()=>resolve(s.base.cart));bind('[data-cart-merge]',()=>resolve(proposal.cart));bind('[data-cart-local]',()=>resolve(s.cart));
    surface.querySelector('[data-cart-new-intent]')?.addEventListener('change',event=>{surface.querySelector('[data-cart-local]').disabled=!event.target.checked;});
    surface.querySelectorAll('button').forEach(button=>{button.classList.add('btn-secondary');if(busy)button.disabled=true;});
  }
  async function initialize(){
    let saved;
    try{const raw=localStorage.getItem(key()),backupKey=CART_KEY+'_legacy_backup';
      const backup=localStorage.getItem(backupKey);if(backup&&Date.now()-JSON.parse(backup).recorded_at>90*86400000)localStorage.removeItem(backupKey);
      if(!raw){const original=localStorage.getItem(CART_KEY);if(original&&!localStorage.getItem(backupKey))localStorage.setItem(backupKey,JSON.stringify({raw:original,recorded_at:Date.now()}));if(original)JSON.parse(original);}
      saved=raw?JSON.parse(raw):{local:cart};
      if(saved.recorded_at&&Date.now()-saved.recorded_at>90*86400000)saved={local:cart,review:true};
      pending();
    }catch{storedError=true;render();return false;}
    const version=++generation;
    engine=BuyerCartClient.create({read:()=>json('/api/portal/cart-state'),write:body=>send('/api/portal/cart-state',body,'PUT'),onChange:s=>changed(s,version)});
    try{await engine.initialize(saved);render();return true;}catch{render();return false;}
  }
  function save(){
    if(busy)return;
    if(engine&&pending()){cart=OrderingRules.normalize(engine.inspect().cart,allBrands);render();return;}
    if(!engine){setSaveStatus('error');return;}
    engine.edit(OrderingRules.normalize(cart,allBrands));setSaveStatus('saving');clearTimeout(cartSyncTimer);
    if(engine.inspect().phase==='ready')cartSyncTimer=setTimeout(()=>sync().catch(()=>{}),1200);
  }
  async function sync(owner=false){
    if(!engine||(busy&&!owner)||storedError||pending())throw new Error('cart_blocked');
    if(navigator.onLine===false){setSaveStatus('offline');throw new Error('offline');}
    if(otherTab||engine.inspect().phase==='error'){await reconcile();throw new Error('review_required');}
    engine.edit(cart);await engine.flush();return engine.inspect().base;
  }
  async function reconcile(){if(busy)return;if(!engine)return initialize();clearTimeout(cartSyncTimer);try{await engine.reconcile();otherTab=false;}finally{render();}}
  async function resolve(value){engine.resolve(value);await sync();renderCart(true);}
  function lock(value){
    busy=value;
    if(value){const overlay=document.createElement('div');overlay.id='cart-transfer-lock';overlay.setAttribute('role','status');overlay.style='position:fixed;inset:0;z-index:99999;background:rgba(255,255,255,.92);display:grid;place-items:center;padding:24px';overlay.textContent=L('Vérification et transmission en cours…','Checking and submitting…');document.body.append(overlay);
      [...document.body.children].filter(el=>el!==overlay&&el.tagName!=='SCRIPT').forEach(el=>{el.dataset.cartWasInert=el.inert?'1':'0';el.inert=true;});
    }else{document.getElementById('cart-transfer-lock')?.remove();document.querySelectorAll('[data-cart-was-inert]').forEach(el=>{el.inert=el.dataset.cartWasInert==='1';delete el.dataset.cartWasInert;});}
    render();
  }
  async function accept(receipt){
    // Validate a complete, brand-by-brand receipt before modifying the cart or key.
    const check={getItem:k=>localStorage.getItem(k),removeItem:()=>{}};BuyerCartClient.finishAttempt(check,me.id,receipt);
    const version=++generation;
    const next=BuyerCartClient.create({read:async()=>receipt.cart,write:body=>send('/api/portal/cart-state',body,'PUT'),onChange:s=>changed(s,version)});
    engine=next;await next.initialize({base:receipt.cart,local:receipt.cart.cart});
    if(storedError)throw new Error('storage_failed');
    BuyerCartClient.finishAttempt(localStorage,me.id,receipt);render();return receipt;
  }
  async function checkout(body){
    if(busy)throw new Error('checkout_busy');
    clearTimeout(cartSyncTimer);lock(true);
    try{
      const state=await sync(true);
      const request_key=newKey(),brands=[...new Set(Object.values(state.cart).map(row=>row.brand_id))].sort();
      BuyerCartClient.saveAttempt(localStorage,me.id,{request_key,cart_id:state.cart_id,revision:state.revision,brands});
      return await accept(await send('/api/portal/checkout-v2',{...body,request_key,cart_id:state.cart_id,revision:state.revision}));
    }finally{lock(false);}
  }

  async function recover(){if(busy)return;const attempt=pending();if(!attempt)return;lock(true);try{const receipt=await json('/api/portal/checkout-v2/'+encodeURIComponent(attempt.request_key));if(receipt.state!=='complete')throw new Error('checkout_pending');applyCheckoutResult(await accept(receipt));}finally{lock(false);}}
  async function close(){if(busy)return;const attempt=pending();if(!attempt)return;lock(true);try{const receipt=await send('/api/portal/checkout-v2/'+encodeURIComponent(attempt.request_key)+'/cancel',{brands:attempt.brands});applyCheckoutResult(await accept(receipt));}finally{lock(false);}}
  window.addEventListener('online',()=>{if(engine&&!busy)sync().catch(()=>{});});
  window.addEventListener('storage',event=>{if(!engine)return;if(event.key===key()||event.key===CART_KEY){otherTab=true;render();}});
  return {initialize,save,sync,render,checkout,recover,hasPending:()=>!!pending(),get busy(){return busy;}};
})();
