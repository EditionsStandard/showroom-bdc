'use strict';
window.BuyerEngagementPreparation = (() => {
  const $=id=>document.getElementById('engagement-preparation-'+id);
  const panel=$('panel');
  let state=null,offset=0,loading=false,busy=false,pendingEnqueueKey=null;
  const t=(fr,en)=>typeof currentLang!=='undefined' && currentLang==='en'?en:fr;
  const labels={
    welcome:['Activation / première connexion','Activation / first login'],inactive:['Inactivité','Inactivity'],
    pending:['En attente du test','Awaiting test'],reserved:['Réservé pour recontrôle','Reserved for recheck'],
    simulated:['Test de préparation réussi','Preparation test passed'],cancelled:['Préparation annulée','Preparation cancelled'],failed:['Test en échec','Preparation test failed']
  };
  const reasons={
    prepared:['Préparation enregistrée','Preparation recorded'],dry_run_validated:['Test terminé, aucun email envoyé','Test completed, no email sent'],
    activation_changed:['Activation modifiée depuis la préparation','Activation changed since preparation'],
    preparation_retry:['Nouvel essai possible après délai','Retry available after delay'],retry_exhausted:['Nombre maximal d’essais atteint','Maximum test attempts reached'],lease_exhausted:['Réservations expirées : limite atteinte','Expired reservations: limit reached'],preparation_busy:['Calcul en cours : test différé','Calculation running: test deferred'],
    queued:['Préparation enregistrée','Preparation recorded'],enqueued:['Préparation enregistrée','Preparation recorded'],
    pending:['En attente du test','Awaiting test'],reserved:['Réservé pour recontrôle','Reserved for recheck'],
    simulated:['Test terminé, aucun email envoyé','Test completed, no email sent'],dry_run_complete:['Test terminé, aucun email envoyé','Test completed, no email sent'],
    dry_run_passed:['Test terminé, aucun email envoyé','Test completed, no email sent'],
    queue_paused:['Traitement de test en pause','Test processing paused'],preparation_paused:['Traitement de test en pause','Test processing paused'],
    simulation_paused:['Simulations en pause','Simulations paused'],rule_disabled:['Règle désactivée','Rule disabled'],
    marketing_permission_missing:['Accord marketing absent ou retiré','Marketing permission missing or withdrawn'],history_unknown:['Historique incomplet','Incomplete history'],
    approval_unknown:['Approbation non documentée','Undocumented approval'],already_logged_in:['Acheteur déjà connecté','Buyer already logged in'],
    delay_not_reached:['Délai non atteint','Delay not reached'],recent_activity:['Action récente','Recent action'],recent_presence:['Présence récente','Recent presence'],
    episode_changed:['Épisode d’activité modifié','Activity episode changed'],rule_changed:['Règle modifiée depuis la préparation','Rule changed since preparation'],
    template_changed:['Modèle modifié depuis la préparation','Template changed since preparation'],template_missing:['Brouillon introuvable','Draft missing'],
    template_invalid:['Brouillon à corriger','Draft needs correction'],buyer_missing:['Compte supprimé','Account deleted'],
    no_completed_login:['Aucune connexion complète observée','No completed login observed'],activity_unknown:['Activité inconnue','Unknown activity'],
    preparation_failed:['Échec du test de préparation','Preparation test failed'],retry_scheduled:['Nouvel essai possible après délai','Retry available after delay'],
    lease_expired:['Réservation expirée','Reservation expired'],attempts_exhausted:['Nombre maximal d’essais atteint','Maximum test attempts reached'],
    unsupported_rule:['Règle non prise en charge','Unsupported rule'],cart_conversion_not_reliable:['Panier non fiabilisé','Cart conversion not reliable'],brand_events_not_collected:['Données marque non collectées','Brand events not collected']
  };
  const label=id=>labels[id]?t(...labels[id]):id||'—';
  const reason=id=>reasons[id]?t(...reasons[id]):id||'—';
  const date=value=>value?new Date(value).toLocaleString(typeof currentLang!=='undefined'&&currentLang==='en'?'en-GB':'fr-FR'):'—';
  const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const errorMessages={
    preparation_paused:['Le traitement de test est en pause. Reprenez-le pour tester un lot.','Test processing is paused. Resume it to test a batch.'],
    queue_paused:['Le traitement de test est en pause. Reprenez-le pour tester un lot.','Test processing is paused. Resume it to test a batch.'],
    preparation_busy:['Une opération est en cours. Réessayez la même préparation.','An operation is running. Retry the same preparation.'],
    simulation_busy:['Un calcul est en cours. Réessayez la même préparation.','A calculation is running. Retry the same preparation.'],
    control_conflict:['Le réglage a changé ailleurs. Vérifiez son état actualisé et réessayez.','The control changed elsewhere. Check its refreshed state and retry.'],
    preparation_control_conflict:['Le réglage a changé ailleurs. Vérifiez son état actualisé et réessayez.','The control changed elsewhere. Check its refreshed state and retry.'],
    preparation_cohort_limit:['La cohorte dépasse la limite de ce lot. Aucune préparation partielle n’est créée.','The cohort exceeds this batch limit. No partial preparation is created.'],
    invalid_preparation_request:['Requête de préparation invalide.','Invalid preparation request'],
    preparation_failed:['Opération indisponible. Vérifiez la file avant de poursuivre.','Operation unavailable. Check the queue before continuing.']
  };
  async function api(suffix='',options) {
    const response=await fetch('/api/admin/buyer-engagement/preparation-queue'+suffix,options);
    const data=await response.json();
    if(!response.ok){const error=new Error(errorMessages[data.code]?t(...errorMessages[data.code]):data.error||t('File indisponible','Queue unavailable'));error.status=response.status;error.code=data.code;throw error;}
    return data;
  }
  function syncControls() {
    const disabled=loading||busy;
    panel.querySelectorAll('button').forEach(button=>{button.disabled=disabled;});
    $('enqueue').disabled=disabled||!state;
    $('process').disabled=disabled||!state||state.control.paused||Boolean(pendingEnqueueKey);
    $('pause').disabled=disabled||!state;
    $('prev').disabled=disabled||!state||state.jobs.offset===0;
    $('next').disabled=disabled||!state||state.jobs.offset+state.jobs.limit>=state.jobs.total;
    $('enqueue').textContent=pendingEnqueueKey?t('Réessayer la même préparation','Retry the same preparation'):t('Préparer les candidats','Prepare candidates');
  }
  function clear() {
    state=null;$('rows').replaceChildren();$('count').textContent='';$('counts').textContent='';$('control').textContent='';$('asof').textContent='';
  }
  function translate() {
    $('title').textContent=t('File de préparation — test uniquement','Preparation queue — test only');
    $('note').textContent=t('Les candidats sont préparés puis recontrôlés dans une file de test. L’expédition est verrouillée : aucun email ne peut partir depuis cette file. Les lots sont déclenchés manuellement. Ces compteurs mesurent les tests, pas les envois ou les conversions. La pause ci-dessous concerne ce traitement de test, pas les anciens rappels ou emails du portail.',
      'Candidates are prepared, then rechecked in a test queue. Delivery is locked: this queue cannot send email. Batches are started manually. These counters measure tests, not deliveries or conversions. The pause below controls this test processing, not the portal’s existing reminders or emails.');
    $('refresh').textContent=t('Actualiser la file','Refresh queue');
    $('process').textContent=t('Tester un lot de 10','Test a batch of 10');
    $('head').innerHTML='<tr>'+[t('Acheteur / règle','Buyer / rule'),t('État / motif','Status / reason'),t('Essais / réessai possible dès','Attempts / retry available after'),t('Réservation jusqu’au','Reserved until'),t('Dernière mise à jour','Last updated')].map(value=>'<th>'+esc(value)+'</th>').join('')+'</tr>';
    $('prev').setAttribute('aria-label',t('Page précédente de la file de préparation','Previous preparation queue page'));
    $('next').setAttribute('aria-label',t('Page suivante de la file de préparation','Next preparation queue page'));
  }
  function render(data) {
    if(data.mode!=='dry_run'||data.delivery_enabled!==false||!data.control||data.control.delivery_enabled!==false||typeof data.control.paused!=='boolean'||!data.jobs||!Array.isArray(data.jobs.rows)||!data.counts||!['pending','reserved','simulated','cancelled','failed'].every(key=>Number.isFinite(Number(data.counts[key]))))
      throw new Error(t('État de sécurité de la file non confirmé. Rechargez les données.','Queue safety state is unconfirmed. Refresh the data.'));
    state=data;
    $('pause').textContent=data.control.paused?t('Reprendre les tests de préparation','Resume preparation tests'):t('Suspendre les tests de préparation','Pause preparation tests');
    $('control').textContent=data.control.paused?t('Traitement de test en pause. La préparation de candidats reste disponible. Expédition verrouillée.','Test processing paused. Candidate preparation remains available. Delivery locked.'):
      t('Traitement de test disponible. Expédition verrouillée.','Test processing available. Delivery locked.');
    $('asof').textContent=t('État chargé le ','State loaded at ')+date(new Date());
    $('counts').textContent=['pending','reserved','simulated','cancelled','failed'].map(status=>label(status)+' : '+String(data.counts?.[status]??0)).join(' · ');
    $('count').textContent=`${data.jobs.total?data.jobs.offset+1:0}–${Math.min(data.jobs.offset+data.jobs.rows.length,data.jobs.total)} / ${data.jobs.total}`;
    $('rows').innerHTML=data.jobs.rows.map(job=>`<tr><td>${esc(job.buyer_name||job.buyer_email||job.buyer_id)}<br><small>${esc(job.buyer_email||'')}</small><br>${esc(label(job.rule_id))}</td><td>${esc(label(job.status))}<br>${esc(reason(job.reason))}</td><td>${esc(job.attempt_count)}<br>${esc(date(job.next_attempt_at))}</td><td>${esc(date(job.lease_expires_at))}</td><td>${esc(date(job.updated_at))}</td></tr>`).join('')||`<tr><td colspan="5">${t('Aucune préparation enregistrée.','No recorded preparation.')}</td></tr>`;
  }
  async function read() {
    const data=await api('?offset='+offset);
    if(data.jobs&&data.jobs.total>0&&data.jobs.offset>=data.jobs.total){offset=Math.floor((data.jobs.total-1)/data.jobs.limit)*data.jobs.limit;return read();}
    render(data);
  }
  async function load(internal=false) {
    if(loading||(busy&&!internal))return;
    loading=true;clear();translate();syncControls();$('status').textContent=t('Chargement…','Loading…');
    try {await read();$('status').textContent=pendingEnqueueKey?t('La dernière préparation n’est pas confirmée. Réessayez la même opération avec sa référence conservée.','The last preparation is unconfirmed. Retry the same operation with its retained reference.'):'';return true;}
    catch(error){clear();$('status').textContent=error.message;return false;}
    finally {loading=false;syncControls();}
  }
  async function mutate(action,{process=false}={}) {
    if(loading||busy)return;
    busy=true;syncControls();
    try {const message=await action();const refreshed=await load(true);$('status').textContent=message+(refreshed?'':' '+t('Actualisation impossible : rechargez la file pour vérifier les états.','Unable to refresh: reload the queue to inspect statuses.'));}
    catch(error){
      let message=error.message;
      if(process&&(!error.status||error.status>=500))message=t('Résultat du lot non confirmé. La file va être actualisée : vérifiez les états avant de lancer un autre lot. Aucun nouvel essai automatique n’est déclenché.',
        'Batch result unconfirmed. The queue will refresh: inspect statuses before starting another batch. No automatic retry is triggered.');
      // The server remains authoritative after a conflict or ambiguous response.
      const refreshed=await load(true);$('status').textContent=message+(refreshed?'':' '+t('La file n’a pas pu être actualisée. Rechargez-la avant de poursuivre.','The queue could not be refreshed. Reload it before continuing.'));
      if(pendingEnqueueKey)$('status').textContent+=' '+t('La référence de préparation a été conservée pour la reprise.','The preparation reference has been retained for retry.');
    }finally{busy=false;syncControls();}
  }
  $('refresh').onclick=()=>load();
  $('enqueue').onclick=()=>mutate(async()=>{
    pendingEnqueueKey=pendingEnqueueKey||crypto.randomUUID();
    let result;
    try {result=await api('/enqueue',json('POST',{request_key:pendingEnqueueKey}));}
    catch(error){if(error.status>=400&&error.status<500&&!['preparation_busy','simulation_busy'].includes(error.code))pendingEnqueueKey=null;throw error;}
    pendingEnqueueKey=null;offset=0;
    return (result.replayed?t('Préparation déjà enregistrée, résultat récupéré. ','Preparation already recorded; result recovered. '):t('Préparation enregistrée. ','Preparation recorded. '))+
      t('Créés : ','Created: ')+String(result.created_count)+t(' · Réutilisés : ',' · Reused: ')+String(result.reused_count)+t(' · Écartés : ',' · Rejected: ')+String(result.rejected_count);
  });
  $('process').onclick=()=>mutate(async()=>{
    const result=await api('/process',json('POST',{batch_size:10}));
    return t('Lot de test terminé. Réservés : ','Test batch completed. Claimed: ')+String(result.claimed)+t(' · Tests réussis : ',' · Tests passed: ')+String(result.simulated)+
      t(' · Annulés : ',' · Cancelled: ')+String(result.cancelled)+t(' · Nouveaux essais différés : ',' · Deferred retries: ')+String(result.retry_scheduled)+
      t(' · Échecs : ',' · Failed: ')+String(result.failed)+t(' · Réservations périmées : ',' · Stale claims: ')+String(result.stale);
  },{process:true});
  $('pause').onclick=()=>mutate(async()=>{
    await api('/control',json('PUT',{paused:!state.control.paused,version:state.control.version}));
    return t('Réglage du traitement de test enregistré. Expédition verrouillée.','Test processing control saved. Delivery locked.');
  });
  $('prev').onclick=()=>{offset=Math.max(0,offset-(state?.jobs.limit||50));load();};
  $('next').onclick=()=>{offset+=state?.jobs.limit||50;load();};
  translate();syncControls();return {load};
})();
