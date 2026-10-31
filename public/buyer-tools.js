(function() {
  const en=()=>typeof currentLang!=='undefined' && currentLang==='en';
  const label=(fr,english)=>en()?english:fr;
  async function request(url,body,method='POST') {
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error || 'Erreur');return data;
  }
  // One accessible dialog, with inline validation and retryable server errors.
  function openForm({title,fields=[],help='',submitLabel,onSubmit}) {
    if(document.querySelector('.buyer-dialog[open]'))return;
    const dialog=document.createElement('dialog');dialog.className='buyer-dialog';
    dialog.setAttribute('aria-labelledby','buyer-dialog-title');
    dialog.innerHTML=`<form><h3 id="buyer-dialog-title">${esc(title)}</h3>${help?`<p class="buyer-help">${esc(help)}</p>`:''}${fields.map(f=>`<label>${esc(f.label)}${f.required?' *':''}${f.type==='textarea'?`<textarea name="${esc(f.name)}" rows="3" maxlength="${f.max || 5000}" ${f.required?'required':''}></textarea>`:f.type==='country'?`<select name="${esc(f.name)}" ${f.required?'required':''}></select>`:`<input name="${esc(f.name)}" type="${esc(f.type || 'text')}" maxlength="${f.max || 200}" ${f.autocomplete?`autocomplete="${esc(f.autocomplete)}"`:''} ${f.required?'required':''}>`}</label>`).join('')}<p class="buyer-dialog-error" role="alert"></p><div data-form-result aria-live="polite"></div><div class="buyer-dialog-actions"><button class="btn-secondary" type="button" data-cancel>${esc(label('Annuler','Cancel'))}</button><button class="btn-secondary" type="submit">${esc(submitLabel || label('Enregistrer','Save'))}</button></div></form>`;
    document.body.append(dialog);
    const form=dialog.querySelector('form'),submit=form.querySelector('[type=submit]'),error=form.querySelector('[role=alert]');
    fields.forEach(f=>{const input=form.elements.namedItem(f.name);if(f.type==='country')BuyerCountries.fill(input,f.value,currentLang);else input.value=f.value || '';});
    let busy=false;
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.addEventListener('close',()=>dialog.remove());
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      error.textContent='';
      const data=Object.fromEntries(fields.map(f=>[f.name,form.elements.namedItem(f.name).value.trim()]));
      const invalid=fields.find(f=>(f.required && !data[f.name]) || (f.type==='country' && !BuyerCountries.getCountryCode(data[f.name])));
      if(invalid){error.textContent=label('Vérifiez le champ : ','Check field: ')+invalid.label;form.elements.namedItem(invalid.name).focus();return;}
      busy=true;submit.disabled=true;form.querySelector('[data-cancel]').disabled=true;
      try {
        const result=await onSubmit(data);
        if(result?.inviteUrl){
          form.querySelectorAll('label').forEach(el=>el.remove());
          form.querySelector('[data-form-result]').innerHTML=`<p>${esc(label('Invitation créée. Aucun email n’a été envoyé : transmettez ce lien privé au collègue. Il expire dans 7 jours et ne peut être utilisé qu’une fois, avec le compte correspondant à son email.','Invitation created. No email was sent: send this private link to your colleague. It expires in 7 days and can only be used once, by the matching email account.'))}</p><label>${esc(label('Lien privé','Private link'))}<input data-invite-link readonly></label>`;
          const input=form.querySelector('[data-invite-link]');input.value=new URL(result.inviteUrl,location.origin).href;
          submit.remove();const close=form.querySelector('[data-cancel]');close.disabled=false;close.textContent=label('Fermer','Close');
          input.focus();input.select();busy=false;return;
        }
        dialog.close();showToast(label('Enregistré','Saved'));
      }catch(e){error.textContent=e.message;}
      finally{busy=false;submit.disabled=false;const cancel=form.querySelector('[data-cancel]');if(cancel)cancel.disabled=false;}
    });
    dialog.showModal();
  }
  function addressFields(value={}) {
    return [
      {name:'address',label:label('Adresse','Street address'),value:value.address,required:true,max:500,autocomplete:'street-address',type:'textarea'},
      {name:'address_line2',label:label('Complément d’adresse','Address line 2'),value:value.address_line2,max:200},
      {name:'postal_code',label:label('Code postal (si applicable)','Postal code (if applicable)'),value:value.postal_code,max:32,autocomplete:'postal-code'},
      {name:'city',label:label('Ville','City'),value:value.city,required:true,max:200,autocomplete:'address-level2'},
      {name:'country',label:label('Pays','Country'),value:value.country,required:true,type:'country'}
    ];
  }
  function companyForm(action) {
    const company=document.getElementById('company-tools')._company;
    if(action==='invite')return openForm({title:label('Inviter un acheteur','Invite buyer'),help:label('Le lien sera à transmettre vous-même. Le collègue doit disposer d’un compte acheteur activé ; cette invitation n’accorde pas d’accès automatique au portail.','You will need to send the link yourself. The colleague needs an activated buyer account; this invitation does not automatically grant portal access.'),fields:[{name:'email',label:label('Email du collègue','Colleague email'),type:'email',required:true,autocomplete:'email'}],submitLabel:label('Créer le lien d’invitation','Create invitation link'),onSubmit:async data=>({inviteUrl:(await request('/api/portal/company/invites',data)).url})});
    const billing=action==='billing';
    const previous=billing?(company.billing || {}):{};
    openForm({title:label(billing?'Adresse de facturation':'Ajouter un magasin',billing?'Billing address':'Add location'),help:label('Ces coordonnées sont enregistrées pour la société ; elles ne modifient pas les commandes déjà passées.','These details are saved for the company; they do not change existing orders.'),fields:[...(billing?[]:[{name:'name',label:label('Nom du magasin','Location name'),required:true}]),...addressFields(previous)],onSubmit:async data=>{
      const {name,...address}=data;
      if(billing)await request('/api/portal/company',{name:company.name || me.company || me.name,billing:{...previous,...address}},'PUT');
      else await request('/api/portal/company/locations',{name,shipping:address});
      await loadCompany();
    }});
  }
  async function loadCompany() {
    const el=document.getElementById('company-tools');if(!el)return;
    try {
      const data=await request('/api/portal/company',undefined,'GET');
      el.innerHTML=`<h3>${esc(label('Société et magasins','Company and locations'))}</h3><p>${esc(data.company.name)}</p><p>${data.users.map(u=>esc(u.name || u.email)+' · '+esc(u.role)).join('<br>')}</p><p>${data.locations.map(l=>esc(l.name)+' · '+esc([l.shipping.address,l.shipping.address_line2,l.shipping.postal_code,l.shipping.city,l.shipping.country].filter(Boolean).join(', '))).join('<br>')}</p>${data.role==='owner' ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-secondary" data-company-action="billing">${esc(label('Facturation','Billing'))}</button><button class="btn-secondary" data-company-action="location">${esc(label('Ajouter un magasin','Add location'))}</button><button class="btn-secondary" data-company-action="invite">${esc(label('Inviter un acheteur','Invite buyer'))}</button></div>`:''}`;
      el._company=data.company;
      if(data.company.billing?.address){const details=document.createElement('p');details.textContent=label('Facturation : ','Billing: ')+[data.company.billing.address,data.company.billing.address_line2,data.company.billing.postal_code,data.company.billing.city,data.company.billing.country].filter(Boolean).join(', ');el.querySelector('h3').after(details);}
    }catch(e){el.textContent=e.message;}
  }
  async function loadShortlists() {
    const el=document.getElementById('named-shortlists');if(!el)return;
    try {
      const lists=await request('/api/portal/buying-shortlists',undefined,'GET');
      el._lists=lists;
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
      if(company) companyForm(company.dataset.companyAction);
      const shortlistAction=event.target.closest('[data-shortlist-action]');
      if(shortlistAction) {
        const action=shortlistAction.dataset.shortlistAction;
        if(action==='create' || action==='notes') {
          const existing=document.getElementById('named-shortlists')._lists?.find(l=>l.id===shortlistAction.dataset.id);
          openForm({title:label(action==='create'?'Créer une liste':'Notes de la liste',action==='create'?'Create buying list':'Buying list notes'),fields:action==='create'?[{name:'name',label:label('Nom de la liste','List name'),required:true,max:120}]:[{name:'notes',label:label('Notes','Notes'),type:'textarea',value:existing?.notes,max:5000}],onSubmit:async data=>{
            if(action==='create')await request('/api/portal/buying-shortlists',{...data,product_ids:[...shortlist]});
            else await request('/api/portal/buying-shortlists/'+encodeURIComponent(shortlistAction.dataset.id),data,'PATCH');
            await loadShortlists();
          }});
        } else {
          const body=action==='share'?{shared:shortlistAction.dataset.value==='true'}:{ready_for_review:shortlistAction.dataset.value==='true'};
          await request('/api/portal/buying-shortlists/'+encodeURIComponent(shortlistAction.dataset.id),body,'PATCH');
          await loadShortlists();
        }
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
    openForm({title:label('Rejoindre la société qui vous a invité ?','Join the company that invited you?'),help:label('Votre compte sera rattaché à cette société après acceptation de son invitation.','Your account will be linked to this company after accepting its invitation.'),submitLabel:label('Accepter l’invitation','Accept invitation'),onSubmit:async()=>{await request('/api/portal/company/invites/accept',{token:invite});await loadCompany();}});
  }
})();
