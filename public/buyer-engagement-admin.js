'use strict';
window.BuyerEngagement = (() => {
  let state, offset=0;
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
    no_recorded_action_since_threshold:['Aucune action enregistrée depuis le seuil','No recorded action since threshold']
  };
  const label=id=>text(...labels[id]);
  const reason=id=>reasons[id]?text(...reasons[id]):id;
  const date=value=>value?new Date(value).toLocaleString(currentLang==='en'?'en-GB':'fr-FR'):'—';
  async function api(url,options) {
    const response=await fetch('/api/admin/buyer-engagement'+url,options);
    const data=await response.json();if(!response.ok)throw new Error(data.error||text('Erreur de chargement','Loading error'));return data;
  }
  const put=body=>({method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  function preview() {
    const sample=$('body').value.replaceAll('{{buyer_name}}',text('Acheteur exemple','Example buyer')).replaceAll('{{portal_url}}','[URL du portail — exemple]');
    $('preview').textContent=$('subject').value+'\n\n'+sample;
  }
  function selectTemplate() {
    const selected=state.templates.find(t=>t.rule_id+':'+t.lang===$('template-choice').value);
    if(!selected)return;
    $('subject').value=selected.subject;$('body').value=selected.body;
    $('template-form').dataset.version=selected.version;preview();
  }
  async function load() {
    $('status').textContent=text('Chargement…','Loading…');
    $('refresh').disabled=true;
    // Failed refresh must not leave old data presented as a current simulation.
    $('rules').replaceChildren();$('buyers').replaceChildren();$('template-form').hidden=true;
    try {
      state=await api('?offset='+offset);
      $('intro').textContent=text('Simulation uniquement. Aucun envoi, aucune tâche créée, aucune opportunité CRM. Les dates couvrent les connexions, modifications de panier et commandes ; elles ne prouvent pas toutes les visites. Les comptes historiques incomplets sont exclus. Les performances d’envoi et de conversion ne sont pas encore disponibles.',
        'Simulation only. No sending, jobs or CRM opportunities. Dates cover logins, cart changes and orders; they do not prove every visit. Incomplete historic accounts are excluded. Delivery and conversion metrics are not available yet.');
      $('refresh').textContent=text('Actualiser la simulation','Refresh simulation');
      $('status').textContent=text('Calculé le ','Calculated at ')+date(state.now);
      $('rules').innerHTML=state.rules.map(r=>`<form class="card" data-rule="${esc(r.id)}"><h3>${esc(label(r.id))}</h3><p>${esc(['cart','brand_interest'].includes(r.id)?reason(r.id==='cart'?'cart_conversion_not_reliable':'brand_events_not_collected'):text('Candidats indicatifs, à contrôler avant toute relance.','Indicative candidates; review before any follow-up.'))}</p><div class="form-row"><div class="form-group"><label for="engagement-mode-${r.id}">${text('Mode','Mode')}</label><select id="engagement-mode-${r.id}" name="mode"><option value="disabled" ${r.mode==='disabled'?'selected':''}>${text('Désactivée','Disabled')}</option><option value="simulation" ${r.mode==='simulation'?'selected':''}>Simulation</option></select></div><div class="form-group"><label for="engagement-delay-${r.id}">${text('Délai en heures','Delay in hours')}</label><input id="engagement-delay-${r.id}" name="delay" type="number" min="1" max="8760" step="1" value="${r.delay_hours}" required></div></div><button class="btn btn-secondary">${text('Enregistrer','Save')}</button> <small>v${r.version}</small></form>`).join('');
      $('buyers-title').textContent=text('Acheteurs — simulation','Buyers — simulation');
      $('count').textContent=`${state.total?offset+1:0}–${Math.min(offset+state.limit,state.total)} / ${state.total} · `+text('Les résultats concernent cette page, pas un total de campagne.','Results apply to this page, not a campaign total.');
      $('head').innerHTML='<tr>'+[text('Acheteur','Buyer'),text('Historique / accord','History / permission'),text('Connexion / dernière action','Login / last action'),label('welcome'),label('inactive')].map(t=>'<th>'+esc(t)+'</th>').join('')+'</tr>';
      $('buyers').innerHTML=state.buyers.map(b=>`<tr><td>${esc(b.name||b.company||b.email)}<br><small>${esc(b.email)}</small></td><td>${esc(b.login_history_known?text('Connu depuis création','Known from creation'):text('Historique incomplet','Incomplete history'))}<br>${esc(({granted:text('Accord donné','Granted'),denied:text('Refus / retrait','Denied / withdrawn'),unknown:text('Accord inconnu','Unknown')})[b.email_status])}</td><td>${esc(date(b.last_login_at))}<br>${esc(date(b.last_meaningful_activity_at))}</td>${['welcome','inactive'].map(id=>`<td>${b.evaluations[id].eligible?text('Candidat · ','Candidate · '):''}${esc(reason(b.evaluations[id].reason))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="5">${text('Aucun acheteur sur cette page.','No buyers on this page.')}</td></tr>`;
      $('prev').disabled=offset===0;$('next').disabled=offset+state.limit>=state.total;
      const choice=$('template-choice').value;
      $('template-choice').innerHTML=state.templates.map(t=>`<option value="${esc(t.rule_id+':'+t.lang)}">${esc(label(t.rule_id))} · ${t.lang.toUpperCase()} · v${t.version}</option>`).join('');
      if([...$('template-choice').options].some(o=>o.value===choice))$('template-choice').value=choice;
      $('template-note').textContent=text('Brouillons en texte brut. Variables autorisées pour cet aperçu : {{buyer_name}}, {{portal_url}}. Aucun lien d’activation ni désabonnement n’est généré ici. Ces textes ne sont pas prêts pour un envoi.',
        'Plain-text drafts. Preview variables: {{buyer_name}}, {{portal_url}}. No activation or unsubscribe link is generated here. These texts are not ready for delivery.');
      $('template-title').textContent=text('Brouillons de modèles','Template drafts');
      $('subject-label').textContent=text('Objet','Subject');$('body-label').textContent=text('Texte','Body');$('template-save').textContent=text('Enregistrer le brouillon','Save draft');
      $('template-form').hidden=false;selectTemplate();
    } catch(e) { $('status').textContent=e.message;$('count').textContent='';$('prev').disabled=true;$('next').disabled=true; }
    finally {$('refresh').disabled=false;}
  }
  $('refresh').onclick=()=>load();$('prev').onclick=()=>{offset=Math.max(0,offset-100);load();};$('next').onclick=()=>{offset+=100;load();};
  $('rules').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target,rule=state.rules.find(r=>r.id===form.dataset.rule),button=form.querySelector('button');button.disabled=true;
    try {await api('/rules/'+rule.id,put({mode:form.elements.mode.value,delay_hours:Number(form.elements.delay.value),version:rule.version}));await load();}
    catch(e){$('status').textContent=e.message;}finally {button.disabled=false;}
  });
  $('template-choice').onchange=selectTemplate;$('subject').oninput=preview;$('body').oninput=preview;
  $('template-form').onsubmit=async event=>{
    event.preventDefault();const [id,lang]=$('template-choice').value.split(':');$('template-save').disabled=true;
    try {await api('/templates/'+id+'/'+lang,put({version:Number($('template-form').dataset.version),subject:$('subject').value,body:$('body').value}));await load();}
    catch(e){$('status').textContent=e.message;}finally {$('template-save').disabled=false;}
  };
  return {load};
})();
