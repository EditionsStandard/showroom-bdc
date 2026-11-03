'use strict';
window.BuyerCartEngagement=(()=>{
 const $=name=>document.getElementById('engagement-cart-'+name),L=(fr,en)=>currentLang==='en'?en:fr;
 const storageKey='buyer_cart_simulation_pending_v1';let data,pending,busy=false,offset=0,storageError=false;
 const reasons={simulation_paused:['Simulations en pause','Simulations paused'],rule_disabled:['Règle désactivée','Rule disabled'],cart_delay_below_minimum:['Délai inférieur au minimum de 48 h','Delay below the 48h minimum'],episode_changed:['Cycle ou version remplacé','Cycle or version replaced'],cart_converted:['Déjà commandé','Already ordered'],cart_empty:['Panier vide','Empty cart'],cart_history_unknown:['Historique panier inconnu','Unknown cart history'],marketing_permission_missing:['Accord marketing absent ou retiré','Marketing permission missing or withdrawn'],approval_unknown:['Approbation non documentée','Approval undocumented'],no_completed_login:['Activation ou connexion non achevée','Activation or login incomplete'],access_dates_invalid:['Dates d’accès incohérentes','Inconsistent access dates'],delay_not_reached:['Délai non atteint','Delay not reached'],activity_unknown:['Activité inconnue','Unknown activity'],recent_activity:['Action récente','Recent action'],recent_presence:['Présence récente','Recent presence'],recent_contact:['Contact enregistré il y a moins de 24 h','Contact recorded less than 24h ago'],checkout_pending:['Transmission de commande non résolue','Unresolved order submission'],brand_unavailable:['Marque indisponible','Brand unavailable'],early_access:['Collection réservée','Restricted collection'],template_missing:['Brouillon de modèle absent','Template draft missing'],cart_invalid:['Contenu panier invalide','Invalid cart content'],cart_hash_mismatch:['Contenu et cycle incohérents','Content and cycle mismatch'],cart_not_orderable:['Articles indisponibles ou invalides','Unavailable or invalid items'],cart_minimum_not_met:['Minimum de commande non atteint','Order minimum not met'],known_open_cart_after_delay:['Cycle connu, ouvert et inchangé après le délai','Known, open and unchanged cycle after delay'],cycle_missing:['Cycle supprimé','Cycle deleted']};
 const reason=value=>reasons[value]?L(...reasons[value]):L('État à vérifier','Status to verify');
 const failures={simulation_busy:['Un autre calcul est en cours. Réessayez dans quelques instants.','Another calculation is running. Try again shortly.'],simulation_paused:['Les simulations sont en pause.','Simulations are paused.'],cart_cohort_limit:['La limite de cycles est atteinte. Un traitement par lots est nécessaire.','The cycle limit was reached. Batch processing is required.'],cart_catalogue_limit:['La limite de produits est atteinte. Un traitement par lots est nécessaire.','The product limit was reached. Batch processing is required.'],cart_candidate_limit:['La limite de candidats est atteinte. Un traitement par lots est nécessaire.','The candidate limit was reached. Batch processing is required.'],storage_unavailable:['Le stockage de reprise est indisponible. Les calculs sont bloqués.','Recovery storage is unavailable. Calculations are blocked.']};
 const failure=error=>failures[error.message]?L(...failures[error.message]):L('Opération non confirmée. Actualisez ou réessayez la même opération.','Operation unconfirmed. Refresh or retry the same operation.');
 const date=value=>new Date(value).toLocaleString(currentLang==='en'?'en-GB':'fr-FR');
 async function api(suffix='',body){const response=await fetch('/api/admin/buyer-engagement/cart-simulation'+suffix,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const value=await response.json();if(!response.ok)throw new Error(value.code||'cart_simulation_failed');return value;}
 function controls(){
  for(const button of $('panel').querySelectorAll('button'))button.disabled=busy;
  $('generate').disabled=busy||storageError||(!pending&&(!data||data.paused))||!!(pending&&pending.kind!=='generate');
  $('recheck').disabled=busy||storageError||(!pending&&!data)||!!(pending&&pending.kind!=='recheck');
  $('prev').disabled=busy||!data||offset===0;$('next').disabled=busy||!data||offset+50>=Math.max(data.preview.total,data.candidates.total);
  for(const kind of ['generate','recheck'])$(kind).textContent=pending?.kind===kind?L('Réessayer la même opération','Retry same operation'):kind==='generate'?L('Enregistrer un calcul panier','Record cart calculation'):L('Recontrôler les candidats panier','Recheck cart candidates');
 }
 function render(value){
  if(!value||value.mode!=='simulation'||value.sending_enabled!==false||value.preparation_enabled!==false||typeof value.paused!=='boolean'||!value.rule||!value.counts||![value.preview,value.candidates].every(v=>v&&Array.isArray(v.rows)&&Number.isInteger(v.total)&&v.total>=0)||!Array.isArray(value.runs))throw new Error('invalid_response');
  data=value;$('title').textContent=L('Paniers inactifs — simulation par marque','Inactive carts — simulation by brand');
  $('note').textContent=L('Aucun email, aucune préparation d’envoi ni opportunité CRM. Seuls les cycles connus, ouverts et inchangés sont examinés. L’état actuel est recalculé à la lecture ; le dernier calcul enregistré reste un historique. Contact récent : exclusion pendant 24 h.','No email, sending preparation or CRM opportunity. Only known, open and unchanged cycles are considered. Current status is recalculated on read; the last recorded check remains historical. Recent contact: excluded for 24h.');
  $('asof').textContent=`${date(value.now)} · ${L('Délai configuré','Configured delay')}: ${value.rule.delay_hours} h · ${L('Minimum','Minimum')}: 48 h · ${value.counts.eligible} ${L('à examiner','to review')} / ${value.counts.excluded} ${L('exclus','excluded')}`;
  $('refresh').textContent=L('Actualiser les paniers','Refresh carts');
  $('prev').setAttribute('aria-label',L('Page précédente des paniers','Previous cart page'));$('next').setAttribute('aria-label',L('Page suivante des paniers','Next cart page'));
  $('head').innerHTML='<tr>'+[L('Acheteur / marque','Buyer / brand'),L('Dernière modification','Last change'),L('État actuel','Current status')].map(v=>'<th>'+esc(v)+'</th>').join('')+'</tr>';
  $('rows').innerHTML=value.preview.rows.map(row=>`<tr><td>${esc(row.buyer_name||row.buyer_id)}<br>${esc(row.brand_name||row.brand_id)}</td><td data-label="${esc(L('Dernière modification','Last change'))}">${esc(date(row.changed_at))}<br>v${esc(row.cycle_revision)}</td><td data-label="${esc(L('État actuel','Current status'))}">${esc(row.eligible?L('À examiner en simulation','Review in simulation'):L('Exclu','Excluded'))}<br>${esc(reason(row.reason))}</td></tr>`).join('')||`<tr><td colspan="3">${L('Aucun cycle sur cette page.','No cycles on this page.')}</td></tr>`;
  $('candidate-title').textContent=L('Candidats panier enregistrés','Recorded cart candidates');
  $('candidate-head').innerHTML='<tr>'+[L('Acheteur / marque','Buyer / brand'),L('Dernier contrôle enregistré','Last recorded check'),L('État actuel','Current status')].map(v=>'<th>'+esc(v)+'</th>').join('')+'</tr>';
  $('candidates').innerHTML=value.candidates.rows.map(row=>`<tr><td>${esc(row.buyer_name||row.buyer_id)}<br>${esc(row.brand_name||row.brand_id)} · v${esc(row.cycle_revision)}</td><td data-label="${esc(L('Dernier contrôle enregistré','Last recorded check'))}">${esc(date(row.checked_at))}<br>${esc(reason(row.recorded_reason))}</td><td data-label="${esc(L('État actuel','Current status'))}">${esc(row.eligible?L('À examiner en simulation','Review in simulation'):L('Exclu','Excluded'))}<br>${esc(reason(row.reason))}</td></tr>`).join('')||`<tr><td colspan="3">${L('Aucun candidat enregistré.','No recorded candidate.')}</td></tr>`;
  $('count').textContent=`${L('Cycles','Cycles')}: ${Math.min(offset+50,value.preview.total)}/${value.preview.total} · ${L('Candidats','Candidates')}: ${Math.min(offset+50,value.candidates.total)}/${value.candidates.total}`;
  $('runs-title').textContent=L('Dix derniers calculs panier','Last ten cart calculations');
  $('runs').innerHTML=value.runs.map(run=>`<li>${esc(date(run.created_at))} · ${run.kind==='generate'?L('Calcul','Calculation'):L('Recontrôle','Recheck')} · ${esc(run.created_count)} ${L('créés','created')} · ${esc(run.rechecked_count)} ${L('recontrôlés','rechecked')} · ${esc(run.eligible_count)}/${esc(run.excluded_count)} ${L('éligibles/exclus enregistrés','recorded eligible/excluded')}</li>`).join('')||`<li>${L('Aucun calcul enregistré.','No recorded calculation.')}</li>`;
  $('status').textContent=storageError?L('Stockage indisponible : calculs bloqués.','Storage unavailable: calculations blocked.'):pending?L('Calcul non confirmé. Réessayez la même référence ; aucun envoi n’est possible.','Calculation unconfirmed. Retry the same reference; sending is unavailable.'):'';
 }
 function clear(){data=null;$('rows').replaceChildren();$('candidates').replaceChildren();$('runs').replaceChildren();$('asof').textContent='';$('count').textContent='';}
 async function load(){
  if(busy)return;busy=true;controls();$('status').textContent=L('Chargement des paniers…','Loading carts…');
  clear();
  try{render(await api('?offset='+offset));}catch(error){clear();$('status').textContent=L('Paniers indisponibles. ','Carts unavailable. ')+failure(error);}
  finally{busy=false;controls();}
 }
 async function run(kind){
  if(busy||storageError)return;busy=true;controls();
  try{
   if(pending&&pending.kind!==kind)throw new Error('pending_operation');
   if(!pending){const operation={kind,request_key:crypto.randomUUID()};try{localStorage.setItem(storageKey,JSON.stringify(operation));}catch{storageError=true;throw new Error('storage_unavailable');}pending=operation;}
   await api('/runs',pending);localStorage.removeItem(storageKey);pending=null;
   render(await api('?offset='+offset));
  }catch(error){clear();$('status').textContent=L('Calcul non confirmé. ','Calculation unconfirmed. ')+failure(error);}
  finally{busy=false;controls();}
 }
 try{pending=JSON.parse(localStorage.getItem(storageKey)||'null');if(pending!==null&&(typeof pending!=='object'||Array.isArray(pending)||!['generate','recheck'].includes(pending.kind)||typeof pending.request_key!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(pending.request_key)))storageError=true;}
 catch{storageError=true;}
 $('refresh').onclick=load;$('generate').onclick=()=>run('generate');$('recheck').onclick=()=>run('recheck');
 $('prev').onclick=()=>{offset=Math.max(0,offset-50);load();};$('next').onclick=()=>{offset+=50;load();};
 controls();return {load};
})();
