'use strict';
window.BuyerEngagementRetention=(()=>{
  const $=name=>document.getElementById('engagement-retention-'+name),text=(fr,en)=>currentLang==='en'?en:fr;
  const storageKey='buyer_engagement_retention_pending_v1';let state,busy=false,pending=null,storageError=false;
  const statuses={running:['En cours, résultat non confirmé','Running, result unconfirmed'],succeeded:['Périmètre expiré entièrement traité','Expired scope fully processed'],partial:['Lot traité, données expirées restantes','Batch processed, expired data remains'],skipped_busy:['Reporté : autre calcul en cours','Deferred: another calculation is running'],failed:['Échec, suppressions annulées','Failed, deletions rolled back'],interrupted:['Interrompu, résultat non confirmé','Interrupted, result unconfirmed']};
  const scopes={brand_observations:['Observations marque','Brand observations'],brand_candidates:['Signaux marque','Brand signals'],brand_runs:['Calculs marque','Brand calculations'],cart_candidates:['Candidats panier','Cart candidates'],cart_runs:['Calculs panier','Cart calculations']};
  const date=value=>value?new Date(value).toLocaleString(currentLang==='en'?'en-GB':'fr-FR'):text('Aucune réussite confirmée','No confirmed success');
  const label=value=>statuses[value]?text(...statuses[value]):text('État à vérifier','Status to verify');
  function controls(){
    $('refresh').disabled=busy;$('run').disabled=busy||storageError||(!state&&!pending);
    $('run').textContent=pending?text('Vérifier la même opération','Check the same operation'):text('Exécuter un lot de conservation','Run a retention batch');
  }
  function clear(){state=null;$('health').textContent='';$('policy').textContent='';$('runs').replaceChildren();}
  async function api(body){
    const response=await fetch('/api/admin/buyer-engagement/retention'+(body?'/runs':''),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
    const value=await response.json();if(!response.ok)throw new Error('retention_unavailable');return value;
  }
  function render(value){
    if(!value||value.sending_enabled!==false||value.crm_writes_enabled!==false||!value.runtime||typeof value.runtime.enabled!=='boolean'||typeof value.attention!=='boolean'||!Array.isArray(value.runs)||!Array.isArray(value.policy))throw new Error('invalid_response');
    state=value;$('title').textContent=text('Conservation des données — surveillance','Data retention — monitoring');
    $('note').textContent=text('Supprime uniquement les observations et simulations dépassant leurs durées. Aucun compte ni commande n’est supprimé. Les preuves de préférences restent liées au compte. Une réussite confirme le périmètre vérifié à cet instant ; un lot partiel exige un nouveau passage. Aucun email ni écriture CRM.','Deletes only observations and simulations beyond their retention periods. No account or order is deleted. Preference evidence stays linked to the account. Success confirms the scope checked at that time; a partial batch requires another pass. No email or CRM write.');
    $('refresh').textContent=text('Actualiser la surveillance','Refresh monitoring');
    $('health').textContent=(value.attention?text('À surveiller. ','Needs attention. '):text('Conservation à jour. ','Retention up to date. '))+
      (value.runtime.enabled?text('Planification active. ','Scheduling active. '):text('Planification désactivée sur ce serveur. ','Scheduling disabled on this server. '))+
      text('Dernière réussite complète : ','Last complete success: ')+date(value.last_success_at)+
      ` · ${text('Contrôle toutes les','Check every')} ${value.check_minutes} min · ${text('Objectif de passage complet toutes les','Target complete run every')} ${value.interval_hours} h · ${text('Retard signalé après','Delay flagged after')} ${value.grace_hours} h`;
    $('policy').textContent=value.policy.map(p=>`${scopes[p.key]?text(...scopes[p.key]):text('Périmètre','Scope')} : ${p.days} ${text('jours','days')}`).join(' · ')+` · ${text('Maximum','Maximum')} ${value.batch_limit} ${text('éléments par catégorie et passage ; les historiques associés sont aussi supprimés.','items per category per pass; associated history is also deleted.')}`;
    $('runs-title').textContent=text('Dix derniers passages','Last ten runs');
    $('runs').innerHTML=value.runs.map(run=>`<li>${esc(date(run.started_at))} · ${esc(label(run.status))}${Object.entries(run.counts||{}).map(([key,n])=>`<br>${esc(scopes[key]?text(...scopes[key]):text('Périmètre','Scope'))} : ${esc(String(n))}`).join('')}</li>`).join('')||`<li>${text('Aucun passage enregistré.','No recorded run.')}</li>`;
    $('status').textContent=storageError?text('Stockage de reprise indisponible ou invalide : exécution manuelle bloquée.','Recovery storage unavailable or invalid: manual execution blocked.'):pending?text('Résultat non confirmé : vérifiez la même opération.','Result unconfirmed: check the same operation.'):'';
  }
  async function load(){
    if(busy)return;busy=true;controls();clear();$('status').textContent=text('Chargement de la surveillance…','Loading monitoring…');
    try{render(await api());}catch{clear();$('status').textContent=text('Surveillance indisponible. Aucune réussite ne peut être confirmée ici.','Monitoring unavailable. No success can be confirmed here.');}
    finally{busy=false;controls();}
  }
  async function run(){
    if(busy||storageError)return;busy=true;controls();let result;
    try{
      if(!pending){const operation={request_key:crypto.randomUUID()};try{localStorage.setItem(storageKey,JSON.stringify(operation));}catch{storageError=true;throw new Error('storage_unavailable');}pending=operation;}
      result=await api(pending);
      if(!result.run||!Object.hasOwn(statuses,result.run.status))throw new Error('invalid_result');
      if(result.run.status!=='running'){localStorage.removeItem(storageKey);pending=null;}
      render(await api());$('status').textContent=label(result.run.status);
    }catch{clear();$('status').textContent=storageError?text('Stockage de reprise indisponible : aucun nouveau lot engagé.','Recovery storage unavailable: no new batch started.'):text('Résultat non confirmé. Vérifiez la même opération ; sa référence est conservée.','Result unconfirmed. Check the same operation; its reference is retained.');}
    finally{busy=false;controls();}
  }
  try{pending=JSON.parse(localStorage.getItem(storageKey)||'null');if(pending!==null&&(typeof pending!=='object'||Array.isArray(pending)||typeof pending.request_key!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(pending.request_key)))storageError=true;}catch{storageError=true;}
  $('refresh').onclick=load;$('run').onclick=run;controls();return {load};
})();
