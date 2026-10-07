(function() {
  const en=()=>typeof currentLang!=='undefined' && currentLang==='en';
  const label=(fr,english)=>en()?english:fr;
  async function request(url,body,method='POST') {
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error || 'Erreur');return data;
  }
  async function loadCompany() {
    const el=document.getElementById('company-tools');if(!el)return;
    try {
      const data=await request('/api/portal/company',undefined,'GET');
      el.innerHTML=`<h3>${esc(label('Société et magasins','Company and locations'))}</h3><p>${esc(data.company.name)}</p><p>${data.users.map(u=>esc(u.name || u.email)+' · '+esc(u.role)).join('<br>')}</p><p>${data.locations.map(l=>esc(l.name)+' · '+esc(l.shipping.address || '')).join('<br>')}</p>${data.role==='owner' ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-secondary" data-company-action="billing">${esc(label('Facturation','Billing'))}</button><button class="btn-secondary" data-company-action="location">${esc(label('Ajouter un magasin','Add location'))}</button><button class="btn-secondary" data-company-action="invite">${esc(label('Inviter un acheteur','Invite buyer'))}</button></div>`:''}`;
      el._company=data.company;
    }catch(e){el.textContent=e.message;}
  }
  async function loadShortlists() {
    const el=document.getElementById('named-shortlists');if(!el)return;
    try {
      const lists=await request('/api/portal/buying-shortlists',undefined,'GET');
      el.innerHTML=`<button class="btn-secondary" data-shortlist-action="create">${esc(label('Créer une liste avec cette shortlist','Create a buying list from this shortlist'))}</button>`+lists.map(l=>`<div style="border:1px solid var(--border);padding:14px;margin-top:14px"><strong>${esc(l.name)}</strong><p>${esc(l.notes)}</p><p>${l.product_ids.length} ${esc(label('références','references'))}${l.shared ? ' · '+esc(label('Partagée avec la société','Shared with company')):''}${l.ready_for_review ? ' · '+esc(label('Prête pour revue','Ready for review')):''}</p><a class="btn-secondary" href="/api/portal/buying-shortlists/${encodeURIComponent(l.id)}/export">CSV</a>${l.owner_id===me?.id ? ` <button class="btn-secondary" data-shortlist-action="notes" data-id="${esc(l.id)}">${esc(label('Notes','Notes'))}</button> <button class="btn-secondary" data-shortlist-action="share" data-id="${esc(l.id)}" data-value="${!l.shared}">${esc(label('Partager / privé','Share / private'))}</button> <button class="btn-secondary" data-shortlist-action="ready" data-id="${esc(l.id)}" data-value="${!l.ready_for_review}">${esc(label('Prêt pour revue','Ready for review'))}</button>`:''}</div>`).join('');
    }catch(e){el.textContent=e.message;}
  }
  let quickProducts=[];
  function initQuickOrder() {
    const el=document.getElementById('quick-order-tool');if(!el)return;
    el.innerHTML=`<summary>${esc(label('Commande rapide par référence','Quick order by reference'))}</summary><div style="padding:16px 0"><label>${esc(label('Marque','Brand'))}</label><select id="quick-order-brand" style="max-width:100%"></select><div style="margin:12px 0"><input id="quick-order-search" type="search" placeholder="Reference / SKU" style="width:100%;box-sizing:border-box"><div id="quick-order-matches"></div></div><p>${esc(label('Coller un CSV : reference, quantity, color, size. Les prix et disponibilités seront vérifiés avant ajout.','Paste CSV: reference, quantity, color, size. Prices and availability are checked before adding.'))}</p><textarea id="quick-order-csv" rows="5" style="width:100%;box-sizing:border-box" placeholder='reference,quantity,color,size'></textarea><input id="quick-order-file" type="file" accept=".csv,text/csv" style="width:100%;margin:10px 0"><button class="btn-secondary" data-quick-review>${esc(label('Vérifier la commande','Review order'))}</button><div id="quick-order-review" aria-live="polite"></div></div>`;
    el.addEventListener('toggle',()=>{if(el.open)document.getElementById('quick-order-brand').innerHTML=allBrands.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');});
    let searchTimer;
    document.getElementById('quick-order-search').addEventListener('input',()=>{
      clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{
        const query=document.getElementById('quick-order-search').value.trim().toLowerCase();
        const matches=document.getElementById('quick-order-matches');if(!query){matches.innerHTML='';return;}
        try{
          const data=await request('/api/portal/brands/'+encodeURIComponent(document.getElementById('quick-order-brand').value)+'/products',undefined,'GET');
          quickProducts=(data.products || []).filter(p=>p.reference.toLowerCase().includes(query)).slice(0,10);
          matches.innerHTML=quickProducts.map((p,index)=>{
            let variants=[];try{variants=JSON.parse(p.variants || '[]');}catch(_){}
            const colors=[...new Set([p.color || '',...variants.map(v=>v.color || '')])];
            const sizes=String(p.sizes || '').split(',').map(s=>s.trim()).filter(Boolean);
            return `<div data-quick-row="${index}" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span>${esc(p.reference)} · ${fmtPrice(p.price)}</span><select data-quick-color>${colors.map(c=>`<option>${esc(c)}</option>`).join('')}</select><select data-quick-size>${(sizes.length?sizes:['']).map(size=>`<option>${esc(size)}</option>`).join('')}</select><input type="number" data-quick-qty min="1" max="100000" step="1" value="${OrderingRules.minimum(data.brand)}" style="width:58px"><button class="btn-secondary" data-quick-pick="${index}">+</button></div>`;
          }).join('');
        }catch(e){matches.textContent=e.message;}
      },250);
    });
    document.getElementById('quick-order-file').addEventListener('change',async event=>{const file=event.target.files[0];if(file && file.size<=100000)document.getElementById('quick-order-csv').value=await file.text();});
  }
  let quickReview;
  document.addEventListener('click',async event=>{
    try {
      const company=event.target.closest('[data-company-action]');
      if(company) {
        const action=company.dataset.companyAction;
        if(action==='invite') {
          const email=prompt(label('Email du collègue (compte acheteur existant ou à activer)','Colleague email (existing or newly activated buyer account)'));if(!email)return;
          const invite=await request('/api/portal/company/invites',{email});
          prompt(label('Lien privé à transmettre au collègue','Private link to send to your colleague'),new URL(invite.url,location.origin).href);
        } else {
          const address=prompt(label(action==='billing'?'Adresse de facturation':'Adresse du magasin',action==='billing'?'Billing address':'Store address'));if(address===null)return;
          if(action==='billing'){const company=document.getElementById('company-tools')._company;await request('/api/portal/company',{name:company.name || me.company || me.name,billing:{address}},'PUT');}
          else {const name=prompt(label('Nom du magasin','Location name'));if(!name)return;await request('/api/portal/company/locations',{name,shipping:{address}});}
        }
        await loadCompany();
      }
      const shortlistAction=event.target.closest('[data-shortlist-action]');
      if(shortlistAction) {
        const action=shortlistAction.dataset.shortlistAction;
        if(action==='create'){const name=prompt(label('Nom de la liste','Buying list name'));if(!name)return;await request('/api/portal/buying-shortlists',{name,product_ids:[...shortlist]});}
        else {
          let body;
          if(action==='notes'){const notes=prompt(label('Notes pour cette liste','Notes for this list'));if(notes===null)return;body={notes};}
          else body=action==='share'?{shared:shortlistAction.dataset.value==='true'}:{ready_for_review:shortlistAction.dataset.value==='true'};
          await request('/api/portal/buying-shortlists/'+encodeURIComponent(shortlistAction.dataset.id),body,'PATCH');
        }
        await loadShortlists();
      }
      const pick=event.target.closest('[data-quick-pick]');
      if(pick) {
        const row=pick.closest('[data-quick-row]'),product=quickProducts[Number(pick.dataset.quickPick)];
        if(!product)return;
        const cell=value=>String(value || '').replace(/"/g,'""');
        const csv=[product.reference,row.querySelector('[data-quick-qty]').value,row.querySelector('[data-quick-color]').value,row.querySelector('[data-quick-size]').value].map(v=>'"'+cell(v)+'"').join(',');
        const textarea=document.getElementById('quick-order-csv');textarea.value+=(textarea.value.trim()?'\n':'reference,quantity,color,size\n')+csv;
      }
      if(event.target.closest('[data-quick-review]')) {
        const el=document.getElementById('quick-order-review');quickReview=null;
        const data=await request('/api/portal/quick-order/reconcile',{brand_id:document.getElementById('quick-order-brand').value,csv:document.getElementById('quick-order-csv').value});
        if(!data.ok){el.textContent=data.errors.map(e=>(e.row?e.row+' · ':'')+e.reference+' : '+e.error).join('\n');el.style.whiteSpace='pre-wrap';return;}
        quickReview=data;
        el.innerHTML=data.lines.map(l=>`<p>${esc(l.reference)} · ${esc(l.color)} · ${esc(l.size)} · ${l.qty} × ${fmtPrice(l.price)}</p>`).join('')+`<p>${esc(quantityMinimumLabel(data.brand))}</p><button class="btn-secondary" data-quick-add>${esc(label('Ajouter au panier','Add to cart'))}</button>`;
      }
      if(event.target.closest('[data-quick-add]') && quickReview) {
        for(const l of quickReview.lines){const key=OrderingRules.key(l.brand_id,l.product_id,l.color,l.size);if(cart[key]){cart[key].qty+=l.qty;cart[key].price=l.price;}else cart[key]=l;}
        cart=OrderingRules.normalize(cart,allBrands);saveCart();updateCartBar();quickReview=null;showView('cart');
      }
    }catch(e){showToast(e.message,5000);}
  });
  window.BuyerTools={loadCompany,loadShortlists};
  initQuickOrder();
  const invite=new URLSearchParams(location.search).get('company_invite');
  if(invite) {
    history.replaceState({},'', '/portal');
    if(confirm(label('Rejoindre la société qui vous a invité ?','Join the company that invited you?'))) request('/api/portal/company/invites/accept',{token:invite}).then(()=>loadCompany()).catch(e=>showToast(e.message,5000));
  }
})();
