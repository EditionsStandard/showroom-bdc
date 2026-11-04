'use strict';
window.BuyerBrandInterestAdmin=(()=>{
  const $=name=>document.getElementById('engagement-brand-'+name),text=(fr,en)=>currentLang==='en'?en:fr;
  const storageKey='buyer_brand_interest_pending_v1';let state,pending=null,busy=false,storageError=false,offset=0;
  const reasons={simulation_paused:['Simulations en pause','Simulations paused'],rule_disabled:['Règle désactivée','Rule disabled'],interest_rule_invalid:['Paramètres à corriger','Settings need review'],interest_permission_missing:['Accord de suivi absent ou retiré','Tracking permission missing or withdrawn'],marketing_permission_missing:['Accord marketing absent ou retiré','Marketing permission missing or withdrawn'],access_incomplete:['Accès ou connexion non documenté','Access or login undocumented'],brand_unavailable:['Marque indisponible','Brand unavailable'],early_access:['Collection réservée','Restricted collection'],interest_days_insufficient:['Nombre de jours insuffisant dans la fenêtre','Insufficient days in the window'],order_since_observations:['Commande déjà enregistrée depuis ces observations','Order already recorded since these observations'],recent_contact:['Contact enregistré il y a moins de 24 h','Contact recorded less than 24h ago'],repeated_brand_days:['Consultations sur plusieurs jours : à qualifier','Views on multiple days: needs qualification']};
  const reason=code=>reasons[code]?text(...reasons[code]):text('État à vérifier','Status to verify');
  const date=value=>value?new Date(value).toLocaleString(currentLang==='en'?'en-GB':'fr-FR'):'—';
  async function api(body) {
    const response=await fetch('/api/admin/buyer-engagement/brand-interest'+(body?'/runs':'?offset='+offset),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
    const value=await response.json();if(!response.ok)throw new Error(value.code||'interest_unavailable');return value;
  }
  function controls() {
    $('refresh').disabled=busy;
    $('generate').disabled=busy||storageError||(!pending&&(!state||state.paused))||!!(pending&&pending.kind!=='generate');
    $('recheck').disabled=busy||storageError||(!pending&&!state)||!!(pending&&pending.kind!=='recheck');
    $('prev').disabled=busy||!state||offset===0;$('next').disabled=busy||!state||offset+50>=state.total;
    for(const kind of ['generate','recheck'])$(kind).textContent=pending?.kind===kind?text('Réessayer la même opération','Retry same operation'):kind==='generate'?text('Enregistrer les signaux','Record signals'):text('Recontrôler les signaux','Recheck signals');
  }
  function clear(){state=null;$('rows').replaceChildren();$('runs').replaceChildren();$('count').textContent='';}
  function render(value) {
    if(!value||value.mode!=='simulation'||value.sending_enabled!==false||value.crm_writes_enabled!==false||typeof value.paused!=='boolean'||!value.rule||!value.counts||!Array.isArray(value.rows)||!Array.isArray(value.runs)||!Number.isInteger(value.total))throw new Error('invalid_response');
    state=value;$('title').textContent=text('Intérêt marque — signaux à qualifier','Brand interest — signals to qualify');
    $('note').textContent=text('Simulation manuelle. Une observation autorisée par marque et par jour UTC ; les rechargements du même jour ne renforcent pas le signal. L’état actuel est recalculé, le contrôle enregistré reste historique. Aucun email ni écriture CRM. Ce signal ne prouve pas une intention d’achat.','Manual simulation. One permitted observation per brand per UTC day; same-day reloads do not strengthen the signal. Current status is recalculated; recorded checks remain historical. No email or CRM write. This signal does not prove purchase intent.');
    $('refresh').textContent=text('Actualiser les signaux','Refresh signals');
    $('count').textContent=`${date(value.now)} · ${value.rule.min_distinct_days} ${text('jours UTC sur','UTC days within')} ${value.rule.delay_hours/24} ${text('jours glissants','rolling days')} · ${value.counts.eligible} ${text('à qualifier','to qualify')} / ${value.counts.excluded} ${text('exclus','excluded')} · ${value.total?offset+1:0}–${Math.min(offset+50,value.total)}/${value.total}`;
    const labels=[text('Acheteur / marque','Buyer / brand'),text('Observations actuelles','Current observations'),text('État actuel','Current status'),text('Dernier contrôle enregistré','Last recorded check')];
    $('head').innerHTML='<tr>'+labels.map(v=>'<th>'+esc(v)+'</th>').join('')+'</tr>';
    $('rows').innerHTML=value.rows.map(row=>`<tr><td>${esc(row.buyer_name||row.buyer_id)}<br>${esc(row.brand_name||row.brand_id)}</td><td data-label="${esc(labels[1])}">${esc(row.distinct_days)} ${text('jours distincts','distinct days')}<br>${esc(date(row.first_observed_at))}<br>${esc(date(row.last_observed_at))}</td><td data-label="${esc(labels[2])}">${esc(reason(row.reason))}</td><td data-label="${esc(labels[3])}">${row.recorded?esc(date(row.recorded.checked_at))+'<br>'+esc(reason(row.recorded.reason))+'<br>'+esc(row.recorded.distinct_days)+' '+text('jours au contrôle','days at check'):text('Non enregistré','Not recorded')}</td></tr>`).join('')||`<tr><td colspan="4">${text('Aucune observation autorisée ou signal conservé sur cette page.','No permitted observation or retained signal on this page.')}</td></tr>`;
    $('runs-title').textContent=text('Dix derniers calculs de signaux','Last ten signal calculations');
    $('runs').innerHTML=value.runs.map(run=>`<li>${esc(date(run.created_at))} · ${run.kind==='generate'?text('Calcul','Calculation'):text('Recontrôle','Recheck')} · ${esc(run.created_count)} ${text('créés','created')} · ${esc(run.rechecked_count)} ${text('recontrôlés','rechecked')} · ${esc(run.eligible_count)}/${esc(run.excluded_count)} ${text('éligibles/exclus enregistrés','recorded eligible/excluded')}</li>`).join('')||`<li>${text('Aucun calcul enregistré.','No recorded calculation.')}</li>`;
    $('prev').setAttribute('aria-label',text('Page précédente des signaux','Previous signal page'));$('next').setAttribute('aria-label',text('Page suivante des signaux','Next signal page'));
    $('status').textContent=storageError?text('Stockage de reprise indisponible ou invalide : calculs bloqués.','Recovery storage unavailable or invalid: calculations blocked.'):pending?text('Calcul non confirmé. Réessayez la même opération.','Calculation unconfirmed. Retry the same operation.'):'';
  }
  function errorText(error) {
    if(storageError)return text('Stockage de reprise indisponible : calculs bloqués.','Recovery storage unavailable: calculations blocked.');
    if(error.message==='interest_cohort_limit')return text('Limite de 5 000 couples acheteur/marque atteinte : traitement par lots nécessaire.','The 5,000 buyer/brand pair limit was reached: batch processing is required.');
    if(error.message==='simulation_paused')return text('Les simulations sont en pause.','Simulations are paused.');
    return text('Opération non confirmée. Actualisez ou réessayez la même opération.','Operation unconfirmed. Refresh or retry the same operation.');
  }
  async function load(){
    if(busy)return;busy=true;controls();clear();$('status').textContent=text('Chargement des signaux…','Loading signals…');
    try{render(await api());}catch(error){clear();$('status').textContent=text('Signaux indisponibles. ','Signals unavailable. ')+errorText(error);}
    finally{busy=false;controls();}
  }
  async function run(kind){
    if(busy||storageError)return;busy=true;controls();
    try{
      if(pending&&pending.kind!==kind)throw new Error('pending_operation');
      if(!pending){const operation={kind,request_key:crypto.randomUUID()};try{localStorage.setItem(storageKey,JSON.stringify(operation));}catch{storageError=true;throw new Error('storage_unavailable');}pending=operation;}
      await api(pending);localStorage.removeItem(storageKey);pending=null;render(await api());
    }catch(error){clear();$('status').textContent=errorText(error);}finally{busy=false;controls();}
  }
  try{pending=JSON.parse(localStorage.getItem(storageKey)||'null');if(pending!==null&&(typeof pending!=='object'||Array.isArray(pending)||!['generate','recheck'].includes(pending.kind)||typeof pending.request_key!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(pending.request_key)))storageError=true;}catch{storageError=true;}
  $('refresh').onclick=load;$('generate').onclick=()=>run('generate');$('recheck').onclick=()=>run('recheck');
  $('prev').onclick=()=>{offset=Math.max(0,offset-50);load();};$('next').onclick=()=>{offset+=50;load();};controls();return {load};
})();
