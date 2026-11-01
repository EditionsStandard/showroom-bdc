'use strict';
window.BuyerEngagement = (() => {
  let state, ledgerState, offset=0, candidateOffset=0, runOffset=0;
  let loading=false, mutationBusy=false, pendingRun=null;
  const $=id=>document.getElementById('engagement-'+id);
  const text=(fr,en)=>currentLang==='en'?en:fr;
  const labels={welcome:['Activation / première connexion','Activation / first login'],inactive:['Inactivité','Inactivity'],cart:['Panier incomplet','Incomplete cart'],brand_interest:['Intérêt marque','Brand interest']};
  const reasons={
    cart_conversion_not_reliable:['Bloqué : clôture des paniers non fiabilisée','Blocked: cart conversion not reliable'],
    brand_events_not_collected:['Bloqué : événements marque non collectés','Blocked: brand events not collected'],
    rule_disabled:['Désactivée','Disabled'],marketing_permission_missing:['Accord marketing absent ou retiré','Marketing permission missing or withdrawn'],
    history_unknown:['Historique inconnu','Unknown history'],approval_unknown:['Approbation non documentée','Undocumented approval'],
    already_logged_in:['Déjà connecté','Already logged in'],delay_not_reached:['Délai non atteint','Delay not reached'],activation_pending:['Activation à terminer','Activation pending'],
    approved_never_logged_in:['Approuvé, jamais connecté','Approved, never logged in'],no_completed_login:['Aucune connexion complète observée','No completed login observed'],
    activity_unknown:['Activité inconnue','Unknown activity'],recent_presence:['Présence récente','Recent presence'],recent_activity:['Action récente','Recent action'],
    no_recorded_action_since_threshold:['Aucune action enregistrée depuis le seuil','No recorded action since threshold'],
    simulation_paused:['Simulations en pause','Simulations paused'],episode_changed:['Épisode modifié depuis le calcul','Episode changed since calculation'],
    activity_changed:['Activité modifiée depuis le calcul','Activity changed since calculation'],buyer_missing:['Compte supprimé','Account deleted'],
    template_missing:['Brouillon de modèle introuvable','Template draft missing']
  };
  const label=id=>labels[id]?text(...labels[id]):id;
  const reason=id=>reasons[id]?text(...reasons[id]):id;
  const date=value=>value?new Date(value).toLocaleString(currentLang==='en'?'en-GB':'fr-FR'):'—';
  const pageCount=data=>`${data.total?data.offset+1:0}–${Math.min(data.offset+data.rows.length,data.total)} / ${data.total}`;
  async function api(url,options) {
    const response=await fetch('/api/admin/buyer-engagement'+url,options);
    const data=await response.json();
    if(!response.ok){
      const messages={
        simulation_busy:['Un calcul est déjà en cours. Réessayez la même opération.','A calculation is already running. Retry the same operation.'],
        simulation_paused:['Les simulations sont en pause. Reprenez-les pour générer un calcul.','Simulations are paused. Resume them to generate a calculation.'],
        simulation_cohort_limit:['Calcul non exécuté : plus de 10 000 acheteurs. Un traitement par lots est nécessaire.','Calculation not executed: more than 10,000 buyers. Batch processing is required.'],
        control_conflict:['Le réglage a changé ailleurs. Les données ont été rechargées ; réessayez.','The control changed elsewhere. Data has been refreshed; please retry.'],
        request_key_reused:['Cette référence correspond à une autre opération. Réessayez pour créer une nouvelle référence.','This reference belongs to another operation. Retry to create a new reference.'],
        invalid_simulation_request:['Requête de simulation invalide.','Invalid simulation request.'],
        simulation_failed:['Calcul indisponible. Réessayez la même opération.','Calculation unavailable. Retry the same operation.']
      };
      const error=new Error(messages[data.code]?text(...messages[data.code]):data.error||text('Erreur de chargement','Loading error'));
      error.status=response.status;error.code=data.code;throw error;
    }
    return data;
  }
  const request=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  function syncControls() {
    const busy=loading||mutationBusy;
    document.querySelectorAll('#buyer-engagement button,#buyer-engagement input,#buyer-engagement select,#buyer-engagement textarea').forEach(el=>{if(!el.closest('#engagement-preparation-panel'))el.disabled=busy;});
    $('prev').disabled=busy||!state||offset===0;
    $('next').disabled=busy||!state||offset+state.limit>=state.total;
    $('template-choice').disabled=busy||!state;
    $('generate').disabled=busy||!ledgerState||ledgerState.control.paused||Boolean(pendingRun&&pendingRun.kind!=='generate');
    $('recheck').disabled=busy||!ledgerState||Boolean(pendingRun&&pendingRun.kind!=='recheck');
    $('pause').disabled=busy||!ledgerState;
    $('generate').textContent=pendingRun?.kind==='generate'?text('Réessayer le même calcul','Retry the same calculation'):text('Enregistrer un calcul','Record a calculation');
    $('recheck').textContent=pendingRun?.kind==='recheck'?text('Réessayer le même recontrôle','Retry the same recheck'):text('Recontrôler les candidats','Recheck candidates');
    for(const [prefix,data] of [['candidate',ledgerState?.candidates],['run',ledgerState?.runs]]) {
      $(prefix+'-prev').disabled=busy||!data||data.offset===0;
      $(prefix+'-next').disabled=busy||!data||data.offset+data.limit>=data.total;
    }
  }
  function preview() {
    const sample=$('body').value.replaceAll('{{buyer_name}}',text('Acheteur exemple','Example buyer')).replaceAll('{{portal_url}}','[URL du portail — exemple]');
    $('preview').textContent=$('subject').value+'\n\n'+sample;
  }
  function selectTemplate() {
    const selected=state?.templates.find(t=>t.rule_id+':'+t.lang===$('template-choice').value);
    if(!selected)return;
    $('subject').value=selected.subject;$('body').value=selected.body;
    $('template-form').dataset.version=selected.version;preview();
  }
  function clearPreview() {
    state=null;$('rules').replaceChildren();$('buyers').replaceChildren();$('template-form').hidden=true;
    $('head').replaceChildren();$('count').textContent='';$('preview').textContent='';$('template-choice').replaceChildren();
  }
  function clearLedger() {
    ledgerState=null;$('candidates').replaceChildren();$('runs').replaceChildren();
    $('candidate-count').textContent='';$('run-count').textContent='';$('control-state').textContent='';
  }
  function renderPreview(data,choice) {
    state=data;
    $('intro').textContent=text('Simulation uniquement. Les calculs enregistrés conservent des candidats et un journal ; aucun email ni aucune opportunité CRM n’est créé. Les dates couvrent les connexions, modifications de panier et commandes, sans prouver toutes les visites. Les comptes historiques incomplets sont exclus. Les performances d’envoi et de conversion ne sont pas encore disponibles.',
      'Simulation only. Recorded calculations keep candidates and a journal; no email or CRM opportunity is created. Dates cover logins, cart changes and orders, without proving every visit. Incomplete historic accounts are excluded. Delivery and conversion metrics are not available yet.');
    $('refresh').textContent=text('Actualiser les données','Refresh data');
    $('status').textContent=text('Aperçu calculé le ','Preview calculated at ')+date(state.now);
    $('rules').innerHTML=state.rules.map(r=>`<form class="card" data-rule="${esc(r.id)}"><h3>${esc(label(r.id))}</h3><p>${esc(['cart','brand_interest'].includes(r.id)?reason(r.id==='cart'?'cart_conversion_not_reliable':'brand_events_not_collected'):text('Candidats indicatifs, à contrôler avant toute relance.','Indicative candidates; review before any follow-up.'))}</p><div class="form-row"><div class="form-group"><label for="engagement-mode-${r.id}">${text('Mode','Mode')}</label><select id="engagement-mode-${r.id}" name="mode"><option value="disabled" ${r.mode==='disabled'?'selected':''}>${text('Désactivée','Disabled')}</option><option value="simulation" ${r.mode==='simulation'?'selected':''}>Simulation</option></select></div><div class="form-group"><label for="engagement-delay-${r.id}">${text('Délai en heures','Delay in hours')}</label><input id="engagement-delay-${r.id}" name="delay" type="number" min="1" max="8760" step="1" value="${r.delay_hours}" required></div></div><button class="btn btn-secondary">${text('Enregistrer','Save')}</button> <small>v${r.version}</small></form>`).join('');
    $('buyers-title').textContent=text('Acheteurs — aperçu','Buyers — preview');
    $('count').textContent=`${state.total?offset+1:0}–${Math.min(offset+state.limit,state.total)} / ${state.total} · `+text('Cet aperçu ne crée aucun candidat et concerne cette page.','This preview creates no candidates and applies to this page.');
    $('head').innerHTML='<tr>'+[text('Acheteur','Buyer'),text('Historique / accord','History / permission'),text('Connexion / dernière action','Login / last action'),label('welcome'),label('inactive')].map(t=>'<th>'+esc(t)+'</th>').join('')+'</tr>';
    $('buyers').innerHTML=state.buyers.map(b=>`<tr><td>${esc(b.name||b.company||b.email)}<br><small>${esc(b.email)}</small></td><td>${esc(b.login_history_known?text('Connu depuis création','Known from creation'):text('Historique incomplet','Incomplete history'))}<br>${esc(({granted:text('Accord donné','Granted'),denied:text('Refus / retrait','Denied / withdrawn'),unknown:text('Accord inconnu','Unknown')})[b.email_status])}</td><td>${esc(date(b.last_login_at))}<br>${esc(date(b.last_meaningful_activity_at))}</td>${['welcome','inactive'].map(id=>`<td>${b.evaluations[id].eligible?text('Candidat · ','Candidate · '):''}${esc(reason(b.evaluations[id].reason))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="5">${text('Aucun acheteur sur cette page.','No buyers on this page.')}</td></tr>`;
    $('template-choice').innerHTML=state.templates.map(t=>`<option value="${esc(t.rule_id+':'+t.lang)}">${esc(label(t.rule_id))} · ${t.lang.toUpperCase()} · v${t.version}</option>`).join('');
    if([...$('template-choice').options].some(o=>o.value===choice))$('template-choice').value=choice;
    $('template-note').textContent=text('Brouillons en texte brut. Variables autorisées pour cet aperçu : {{buyer_name}}, {{portal_url}}. Aucun lien d’activation ni désabonnement n’est généré ici. Ces textes ne sont pas prêts pour un envoi.',
      'Plain-text drafts. Preview variables: {{buyer_name}}, {{portal_url}}. No activation or unsubscribe link is generated here. These texts are not ready for delivery.');
    $('template-title').textContent=text('Brouillons de modèles','Template drafts');
    $('subject-label').textContent=text('Objet','Subject');$('body-label').textContent=text('Texte','Body');$('template-save').textContent=text('Enregistrer le brouillon','Save draft');
    $('template-form').hidden=false;selectTemplate();
  }
  function renderLedger(data) {
    ledgerState=data;
    $('actions-title').textContent=text('Calculs enregistrés','Recorded calculations');
    $('actions-note').textContent=text('Le journal contient les calculs terminés et enregistrés ; aucune file d’envoi réel n’est créée. Suspendre les simulations ne suspend pas les anciens rappels ou emails du portail. Le recontrôle des candidats reste disponible pendant la suspension.',
      'The journal contains completed, recorded calculations; no real sending queue is created. Pausing simulations does not pause the portal’s existing reminders or emails. Candidate rechecks remain available while paused.');
    $('control-state').textContent=data.control.paused?text('Génération suspendue. Aucun candidat n’est éligible tant que cette suspension est active.','Generation paused. No candidate is eligible while this pause is active.'):text('Génération disponible. Aucun envoi n’est activé.','Generation available. No sending is enabled.');
    $('generate').textContent=pendingRun?.kind==='generate'?text('Réessayer le même calcul','Retry the same calculation'):text('Enregistrer un calcul','Record a calculation');
    $('recheck').textContent=pendingRun?.kind==='recheck'?text('Réessayer le même recontrôle','Retry the same recheck'):text('Recontrôler les candidats','Recheck candidates');
    $('pause').textContent=data.control.paused?text('Reprendre les simulations','Resume simulations'):text('Suspendre les simulations','Pause simulations');
    $('candidates-title').textContent=text('Candidats enregistrés','Recorded candidates');
    $('candidates-note').textContent=text('L’état et le motif sont ceux du dernier contrôle indiqué. « À examiner » signifie éligible dans la simulation, jamais prêt à envoyer. Recontrôlez après une modification des règles ou des données.',
      'Status and reason reflect the last check shown. “Review candidate” means eligible in the simulation, never ready to send. Recheck after changing rules or data.');
    $('candidate-count').textContent=pageCount(data.candidates);
    $('candidate-head').innerHTML='<tr>'+[text('Acheteur','Buyer'),text('Règle / épisode','Rule / episode'),text('État / motif','Status / reason'),text('Dernier contrôle','Last check'),text('Version règle / modèle','Rule / template version')].map(v=>'<th>'+esc(v)+'</th>').join('')+'</tr>';
    $('candidates').innerHTML=data.candidates.rows.map(c=>`<tr><td>${esc(c.buyer_name||c.buyer_email||c.buyer_id)}<br><small>${esc(c.buyer_email||'')}</small></td><td>${esc(label(c.rule_id))}<br><small>${esc(date(c.anchor_at))}</small></td><td>${esc(c.status==='eligible'?text('À examiner dans la simulation','Review candidate in simulation'):text('Exclu de la simulation','Excluded from simulation'))}<br>${esc(reason(c.reason))}</td><td>${esc(date(c.last_checked_at))}</td><td>v${esc(c.rule_version)} · ${esc(c.delay_hours)} h<br>${esc(c.template_lang?.toUpperCase()||'—')} · ${c.template_version?'v'+esc(c.template_version):'—'}</td></tr>`).join('')||`<tr><td colspan="5">${text('Aucun candidat enregistré.','No recorded candidates.')}</td></tr>`;
    $('runs-title').textContent=text('Journal des calculs','Calculation journal');$('run-count').textContent=pageCount(data.runs);
    $('run-head').innerHTML='<tr>'+[text('Calcul','Calculation'),text('Début / fin','Start / finish'),text('Examinés','Scanned'),text('Créés / réutilisés','Created / reused'),text('Exclus / éligibles','Excluded / eligible')].map(v=>'<th>'+esc(v)+'</th>').join('')+'</tr>';
    $('runs').innerHTML=data.runs.rows.map(r=>`<tr><td>${esc(r.kind==='recheck'?text('Recontrôle','Recheck'):text('Génération','Generation'))}<br><small>${esc(r.id)}</small></td><td>${esc(date(r.started_at))}<br>${esc(date(r.completed_at))}</td><td>${esc(r.scanned_count)}</td><td>${esc(r.created_count)} / ${esc(r.reused_count)}</td><td>${esc(r.excluded_count)} / ${esc(r.eligible_count)}</td></tr>`).join('')||`<tr><td colspan="5">${text('Aucun calcul enregistré.','No recorded calculations.')}</td></tr>`;
    for(const [prefix,nounFr,nounEn] of [['candidate','des candidats','candidates'],['run','du journal','journal']]) {
      $(prefix+'-prev').setAttribute('aria-label',text('Page précédente '+nounFr,'Previous '+nounEn+' page'));
      $(prefix+'-next').setAttribute('aria-label',text('Page suivante '+nounFr,'Next '+nounEn+' page'));
    }
    $('ledger-status').textContent=pendingRun?text('La réponse au dernier calcul n’est pas confirmée. Réessayez la même opération ; sa référence est conservée pour éviter un doublon.','The last calculation response is unconfirmed. Retry the same operation; its reference is retained to avoid duplicates.'):'';
  }
  async function readLedger() {
    const data=await api('/ledger?offset='+candidateOffset+'&run_offset='+runOffset);renderLedger(data);
  }
  async function load(internal=false) {
    if(loading||(mutationBusy&&!internal))return;
    const choice=$('template-choice').value;
    loading=true;clearPreview();clearLedger();syncControls();
    $('status').textContent=text('Chargement…','Loading…');$('ledger-status').textContent=text('Chargement du journal…','Loading journal…');
    const results=await Promise.allSettled([api('?offset='+offset),api('/ledger?offset='+candidateOffset+'&run_offset='+runOffset)]);
    if(results[0].status==='fulfilled')renderPreview(results[0].value,choice);else $('status').textContent=results[0].reason.message;
    if(results[1].status==='fulfilled')renderLedger(results[1].value);else $('ledger-status').textContent=results[1].reason.message;
    loading=false;syncControls();
    await window.BuyerEngagementPreparation?.load();
  }
  async function refreshLedger() {
    if(loading||mutationBusy)return;
    loading=true;clearLedger();syncControls();$('ledger-status').textContent=text('Chargement du journal…','Loading journal…');
    try {await readLedger();}catch(e){$('ledger-status').textContent=e.message;}
    finally {loading=false;syncControls();}
  }
  async function mutate(fn) {
    if(loading||mutationBusy)return;
    mutationBusy=true;syncControls();
    try {const message=await fn();await load(true);if(message)$('status').textContent=message;}
    catch(e){
      // Refresh control versions after a conflict, while retaining any run key.
      if(e.status===409){clearLedger();try{await readLedger();}catch(error){$('ledger-status').textContent=error.message;}}
      $('status').textContent=e.message;
      if(pendingRun)$('ledger-status').textContent=text('Calcul non confirmé. Réessayez la même opération ; sa référence a été conservée.','Calculation unconfirmed. Retry the same operation; its reference has been retained.');
    } finally {mutationBusy=false;syncControls();}
  }
  function run(kind) {
    mutate(async()=>{
      if(pendingRun&&pendingRun.kind!==kind)throw new Error(text('Terminez le calcul à réessayer avant de changer d’opération.','Resolve the pending calculation before changing operations.'));
      pendingRun=pendingRun||{kind,request_key:crypto.randomUUID()};
      let result;
      try {result=await api('/simulation-runs',request('POST',pendingRun));}
      catch(error){
        // Explicit validation/conflict/size errors confirm rollback. A lost
        // response, server failure or busy calculation may be ambiguous.
        if([400,409,422].includes(error.status)&&error.code!=='simulation_busy')pendingRun=null;
        throw error;
      }
      pendingRun=null;
      candidateOffset=0;runOffset=0;
      return result.replayed?text('Calcul déjà enregistré : le résultat existant a été récupéré. Aucun doublon créé.','Calculation already recorded: the existing result was recovered. No duplicate created.'):text('Calcul de simulation enregistré. Aucun email envoyé.','Simulation calculation recorded. No email sent.');
    });
  }
  $('refresh').onclick=()=>load();$('prev').onclick=()=>{offset=Math.max(0,offset-100);load();};$('next').onclick=()=>{offset+=100;load();};
  $('generate').onclick=()=>run('generate');$('recheck').onclick=()=>run('recheck');
  $('pause').onclick=()=>mutate(async()=>{await api('/simulation-control',request('PUT',{paused:!ledgerState.control.paused,version:ledgerState.control.version}));return text('État des simulations enregistré. Les anciens rappels et emails ne sont pas modifiés.','Simulation control saved. Existing reminders and emails are unchanged.');});
  $('candidate-prev').onclick=()=>{candidateOffset=Math.max(0,candidateOffset-(ledgerState?.candidates.limit||50));refreshLedger();};
  $('candidate-next').onclick=()=>{candidateOffset+=(ledgerState?.candidates.limit||50);refreshLedger();};
  $('run-prev').onclick=()=>{runOffset=Math.max(0,runOffset-(ledgerState?.runs.limit||10));refreshLedger();};
  $('run-next').onclick=()=>{runOffset+=(ledgerState?.runs.limit||10);refreshLedger();};
  $('rules').addEventListener('submit',event=>{
    event.preventDefault();const form=event.target,rule=state.rules.find(r=>r.id===form.dataset.rule);
    mutate(()=>api('/rules/'+rule.id,request('PUT',{mode:form.elements.mode.value,delay_hours:Number(form.elements.delay.value),version:rule.version})).then(()=>null));
  });
  $('template-choice').onchange=selectTemplate;$('subject').oninput=preview;$('body').oninput=preview;
  $('template-form').onsubmit=event=>{
    event.preventDefault();const [id,lang]=$('template-choice').value.split(':');
    mutate(()=>api('/templates/'+id+'/'+lang,request('PUT',{version:Number($('template-form').dataset.version),subject:$('subject').value,body:$('body').value})).then(()=>null));
  };
  syncControls();return {load};
})();
