'use strict';

// Move existing nodes, retaining IDs, badges, listeners and history behavior.
(function groupAdminNavigation(){
  const nav=document.querySelector('.sidebar nav');
  const groups=[
    ['overview','Pilotage','Overview',['dashboard','stats','sales-report']],
    ['business','Ventes','Sales',['orders','commissions','agenda']],
    ['customers','Clients','Customers',['buyers','access-requests','pending-reminders']],
    ['catalogue','Catalogue','Catalogue',['brands']],
    ['administration','Administration','Administration',['staff','settings','email-templates','security','mfa']]
  ];
  const commissions=document.createElement('a');
  commissions.dataset.section='commissions';commissions.id='nav-commissions';
  commissions.innerHTML='<span class="icon">%</span><span data-t="nav_commissions">Commissions wholesale</span>';
  commissions.addEventListener('click',e=>{e.preventDefault();showSection('commissions');});
  nav.append(commissions);
  for(const [id,fr,en,sections] of groups){
    TRANSLATIONS.fr['group_'+id]=fr;TRANSLATIONS.en['group_'+id]=en;
    const group=document.createElement('details');group.className='nav-group';group.open=!window.matchMedia('(max-width: 768px)').matches;
    const heading=document.createElement('summary');heading.dataset.t='group_'+id;heading.textContent=currentLang==='en'?en:fr;group.append(heading);
    const linksContainer=document.createElement('div');linksContainer.className='nav-group-links';group.append(linksContainer);
    group.addEventListener('toggle',()=>{if(group.open && window.matchMedia('(max-width: 768px)').matches)nav.querySelectorAll('details').forEach(other=>{if(other!==group)other.open=false;});});
    for(const section of sections){
      const link=nav.querySelector(`[data-section="${section}"]`);
      if(link){link.href='#'+section;link.setAttribute('role','link');linksContainer.append(link);}
    }
    nav.append(group);
  }
  TRANSLATIONS.fr.nav_commissions='Commissions wholesale';TRANSLATIONS.en.nav_commissions='Wholesale commissions';
  const refresh=()=>{
    for(const group of nav.querySelectorAll('.nav-group')){
      const links=[...group.querySelectorAll('a')];group.hidden=links.every(a=>a.style.display==='none');
      links.forEach(a=>a.setAttribute('aria-current',a.classList.contains('active')?'page':'false'));
      if(!window.matchMedia('(max-width: 768px)').matches && links.some(a=>a.classList.contains('active')))group.open=true;
    }
  };
  // Attribute updates in refresh do not re-trigger the watched attributes.
  nav.addEventListener('click',event=>{if(event.target.closest('a') && window.matchMedia('(max-width: 768px)').matches)nav.querySelectorAll('details').forEach(group=>group.open=false);});
  new MutationObserver(refresh).observe(nav,{subtree:true,attributes:true,attributeFilter:['style','class']});refresh();
})();

async function commercialApi(url,options){
  const response=await fetch(url,options);const result=await response.json();
  if(!response.ok)throw new Error(result.error||'Erreur');return result;
}
const jsonRequest=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

async function openAgentScopes(id){
  try{
    const [staff,brands,current]=await Promise.all([commercialApi('/api/staff'),commercialApi('/api/brands'),commercialApi('/api/staff/'+encodeURIComponent(id)+'/scopes')]);
    const modal=document.getElementById('modal-agent-scopes');modal.dataset.staffId=id;
    document.getElementById('scope-parent').innerHTML='<option value="">Agent — vous référez directement à l’owner</option>'+staff.filter(s=>s.role==='agent'&&s.id!==id&&!s.parent_agent_id).map(s=>`<option value="${esc(s.id)}">${esc(s.name||s.email)}</option>`).join('');
    document.getElementById('scope-parent').value=current.parent_agent_id||'';
    modal._brands=brands;document.getElementById('scope-rows').replaceChildren();
    current.grants.forEach(g=>addScopeRow(g));openModal('modal-agent-scopes');
  }catch(e){toast(e.message,true);}
}
function addScopeRow(grant={}){
  const row=document.createElement('div');row.className='form-row scope-row';
  row.innerHTML='<div class="form-group"><label>Marque</label><select class="scope-brand">'+document.getElementById('modal-agent-scopes')._brands.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')+'</select></div><div class="form-group"><label>Pays ISO (FR, BE…) ou * tous pays</label><input class="scope-country" maxlength="2" placeholder="FR" autocomplete="off"></div><button type="button" class="btn btn-secondary">Retirer</button>';
  if(grant.brand_id)row.querySelector('select').value=grant.brand_id;
  row.querySelector('input').value=grant.country_code||'';
  row.querySelector('button').onclick=()=>row.remove();document.getElementById('scope-rows').append(row);
}
async function saveAgentScopes(){
  const modal=document.getElementById('modal-agent-scopes');
  const grants=[...modal.querySelectorAll('.scope-row')].map(row=>({brand_id:row.querySelector('select').value,country_code:row.querySelector('input').value.trim().toUpperCase()}));
  try{
    await commercialApi('/api/staff/'+encodeURIComponent(modal.dataset.staffId)+'/scopes',jsonRequest('PUT',{parent_agent_id:document.getElementById('scope-parent').value||null,grants}));
    closeModal('modal-agent-scopes');loadStaff();toast('Affectations enregistrées');
  }catch(e){toast(e.message,true);}
}

const commissionStatusLabel={draft:'Brouillon',approved:'Validée',invoiced:'Facturée',paid:'Réglée',cancelled:'Annulée'};
const commissionKindLabel={agency_receivable:'À recevoir — agence',agent_payable:'À payer — agent',subagent_payable:'À payer — sous-agent'};
const commissionBasisLabel={ordered_net:'Commandé net HT',invoiced_net:'Facturé net HT',collected_net:'Encaissé net HT',manual_net:'Assiette contractuelle HT'};
let commissionRows=[];
async function loadCommissions(){
  const owner=currentUserRole==='owner';document.getElementById('commission-create').hidden=!owner;
  try{
    commissionRows=await commercialApi('/api/wholesale-commissions');
    if(owner){
      const [brands,staff]=await Promise.all([commercialApi('/api/brands'),commercialApi('/api/staff')]);
      document.getElementById('commission-brand').innerHTML='<option value="">Choisir…</option>'+brands.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
      document.getElementById('commission-beneficiary').innerHTML='<option value="">Agence</option>'+staff.filter(s=>s.role==='agent').map(s=>`<option value="${esc(s.id)}">${s.parent_agent_id?'Sous-agent':'Agent'} — ${esc(s.name||s.email)}</option>`).join('');
    }
    const allowed={draft:['approved','cancelled'],approved:['invoiced','cancelled'],invoiced:['paid','cancelled'],paid:[],cancelled:[]};
    document.getElementById('commission-body').innerHTML=commissionRows.map(c=>`<tr><td>${esc(c.brand_name)}<br><small>${esc(c.country_code)}</small></td><td>${esc(commissionKindLabel[c.kind])}<br>${esc(c.beneficiary_name||'Agence')}</td><td>${esc(commissionBasisLabel[c.basis_kind])}<br>${esc(c.basis_amount)} ${esc(c.currency)}</td><td>${esc(c.rate_percent)} %</td><td>${esc(c.amount)} ${esc(c.currency)}</td><td>${esc(commissionStatusLabel[c.status])}</td><td>${esc(c.source_reference)}${c.order_id?'<br>Commande : '+esc(c.order_id):''}</td><td>${owner?allowed[c.status].map(status=>`<button class="btn btn-sm" data-commission-id="${esc(c.id)}" data-status="${status}">${commissionStatusLabel[status]}</button>`).join('')+`<button class="btn btn-sm" data-commission-history="${esc(c.id)}">Historique</button>`:''}</td></tr>`).join('')||'<tr><td colspan="8">Aucune commission renseignée.</td></tr>';
  }catch(e){document.getElementById('commission-body').innerHTML='<tr><td colspan="8">'+esc(e.message)+'</td></tr>';}
}
async function createCommission(event){
  event.preventDefault();const value=id=>document.getElementById('commission-'+id).value.trim();
  const body={kind:value('kind'),brand_id:value('brand'),beneficiary_id:value('beneficiary')||null,order_id:value('order')||null,country_code:value('country').toUpperCase(),currency:value('currency').toUpperCase(),basis_kind:value('basis-kind'),basis_amount:value('basis'),rate_percent:value('rate'),source_reference:value('source')};
  try{await commercialApi('/api/wholesale-commissions',jsonRequest('POST',body));event.target.reset();await loadCommissions();toast('Brouillon enregistré');}catch(e){toast(e.message,true);}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-commission-id],[data-commission-history]');if(!button)return;
  if(button.dataset.commissionHistory){
    try{const rows=await commercialApi('/api/wholesale-commissions/'+encodeURIComponent(button.dataset.commissionHistory)+'/history');document.getElementById('commission-history').textContent=rows.map(r=>`${new Date(r.created_at).toLocaleString()} · ${r.actor} · ${r.old_status||'Création'} → ${r.new_status} · ${r.reference}`).join('\n');}catch(e){toast(e.message,true);}return;
  }
  const row=commissionRows.find(c=>c.id===button.dataset.commissionId);
  const reference=prompt('Référence justificative de ce changement (facture, paiement…)');if(!reference)return;
  try{await commercialApi('/api/wholesale-commissions/'+encodeURIComponent(row.id)+'/status',jsonRequest('PATCH',{status:button.dataset.status,version:row.version,reference}));loadCommissions();}catch(e){toast(e.message,true);}
});

async function loadAgentDashboard(){
  const dashboard=document.getElementById('dashboard');
  [...dashboard.children].forEach(child=>{if(child.id!=='agent-dashboard')child.style.display='none';});
  let panel=document.getElementById('agent-dashboard');
  if(!panel){panel=document.createElement('div');panel.id='agent-dashboard';dashboard.append(panel);}
  panel.innerHTML='<h1>Votre activité</h1><p>Chargement de votre périmètre…</p>';
  try{
    const [stats,orders,brands]=await Promise.all([commercialApi('/api/stats'),commercialApi('/api/orders?limit=10'),commercialApi('/api/brands')]);
    const money=value=>Number(value).toLocaleString('fr-FR',{style:'currency',currency:'EUR'});
    panel.innerHTML=`<h1>Votre activité</h1><p>Uniquement vos marques et pays autorisés. Les comptes clients, exports globaux, tarifs et droits sont gérés par l’owner.</p>
      <div class="stats"><div class="stat"><div class="num">${esc(stats.brands_count)}</div><div class="label">Marques attribuées</div></div><div class="stat"><div class="num">${esc(stats.orders_count)}</div><div class="label">Commandes actives</div></div><div class="stat"><div class="num">${esc(money(stats.revenue_total))}</div><div class="label">Commandes actives HT</div></div></div>
      <div class="card"><p>À valider HT : ${esc(money(stats.pending_validation_total))} · Validées / expédiées HT : ${esc(money(stats.validated_orders_total))}</p><p>Montants des commandes, distincts des factures, encaissements et commissions.</p></div>
      <div class="card"><h3>Vos marques</h3><p>${brands.map(b=>esc(b.name)).join(' · ')||'Aucune affectation. Contactez l’owner.'}</p><button class="btn btn-secondary" onclick="showSection('brands')">Ouvrir le catalogue</button><button class="btn btn-secondary" onclick="showSection('commissions')">Vos commissions validées</button></div>
      <div class="card"><h3>Dernières commandes de votre périmètre</h3>${orders.rows.map(o=>`<p>${esc(o.order_number)} · ${esc(o.client_company||o.client_name)} · ${esc(o.brand_name)} · ${esc(money(o.total))} <button class="btn btn-sm" onclick="viewOrder('${escJs(o.id)}')">Voir</button></p>`).join('')||'<p>Aucune commande accessible.</p>'}</div>`;
  }catch(e){panel.innerHTML='<h1>Votre activité</h1><p>'+esc(e.message)+'</p>';}
}
