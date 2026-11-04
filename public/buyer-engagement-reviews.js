'use strict';
window.BuyerEngagementReviews=(()=>{
  const $=name=>document.getElementById('engagement-review-'+name),text=(fr,en)=>currentLang==='en'?en:fr;
  const key='buyer_brand_review_pending_v1',links=['store','buyer','brand','season'];
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
  let crmState=null,crmPending=null;
  const crmKey='buyer_brand_crm_check_pending_v1';
  let list=null,detail=null,selected=null,pending=null,offset=0,busy=false,dirty=false,blocked=false,storageError=false;
  const label=v=>({review:text('À examiner','To review'),qualified:text('Qualifié localement','Locally qualified'),dismissed:text('Écarté','Dismissed'),stale:text('À revoir — données modifiées','Review again — data changed')})[v]||v;
  const date=v=>v?new Date(v).toLocaleString(currentLang==='en'?'en-GB':'fr-FR'):'—';
  function storage(value){try{if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key);pending=value;return true;}catch{storageError=true;return false;}}
  try{const raw=localStorage.getItem(key);if(raw){const v=JSON.parse(raw);if(!v||!uuid(v.candidate_id)||!uuid(v.request_key)||Object.keys(v).length!==2)throw Error();pending=v;}const probe=key+'_probe';localStorage.setItem(probe,'1');localStorage.removeItem(probe);}catch{storageError=true;}
  function crmStorage(value){try{if(value)localStorage.setItem(crmKey,JSON.stringify(value));else localStorage.removeItem(crmKey);crmPending=value;return true;}catch{storageError=true;return false;}}
  try{const raw=localStorage.getItem(crmKey);if(raw){const v=JSON.parse(raw);if(!v||!uuid(v.candidate_id)||!uuid(v.request_key)||Object.keys(v).length!==2)throw Error();crmPending=v;}}catch{storageError=true;}
  async function api(path='',method='GET',body){
    const response=await fetch('/api/admin/buyer-engagement/reviews'+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    let value;try{value=await response.json();}catch{throw Error('invalid_response');}
    if(!response.ok)throw Object.assign(Error(value.code||'review_unavailable'),{status:response.status,code:value.code});return value;
  }
  function validDetail(v){
    if(!v||v.mode!=='local_review'||v.sending_enabled!==false||v.crm_writes_enabled!==false||!uuid(v.source?.candidate_id)||!/^[a-f0-9]{64}$/.test(v.source.source_token)||!v.source.evidence||typeof v.source.live?.eligible!=='boolean'||!v.review_state||!Array.isArray(v.history)||!Array.isArray(v.previews)||v.previews.length!==2||v.previews.some(p=>p.ready_to_transfer!==false||p.hypothetical!==true))throw Error('invalid_response');return v;
  }
  function controls(){
    $('refresh').disabled=busy;$('prev').disabled=busy||!list||offset===0;$('next').disabled=busy||!list||offset+50>=list.total;
    $('form').querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=busy||!detail||blocked||!!pending||!!crmPending||storageError);
    $('discard').disabled=busy||!!pending||!!crmPending||!selected;$('verify').disabled=busy||!pending;$('cancel').disabled=busy||!pending||storageError;
    $('recovery').hidden=!pending;$('recovery-note').textContent=text('Réponse non confirmée. Vérifiez le reçu avant toute nouvelle saisie. Clore bloque une ancienne requête retardée ; cela n’annule pas une revue déjà enregistrée.','Unconfirmed response. Check the receipt before editing again. Closing blocks a delayed old request; it does not undo a saved review.');
    $('rows').querySelectorAll('button').forEach(el=>el.disabled=busy||!!pending||!!crmPending);
    $('crm-run').disabled=busy||storageError||!!pending||!!crmPending||!detail||dirty||blocked||!crmState?.reader_available||!detail.review_state.current||!detail.source.live.eligible||links.some(n=>!detail.review?.links?.[n]);
    $('crm-refresh').disabled=busy||!!pending||!!crmPending||!selected||dirty||blocked;
    $('crm-verify').disabled=busy||!crmPending;$('crm-cancel').disabled=busy||!crmPending||storageError;$('crm-recovery').hidden=!crmPending;
    if(storageError)$('status').textContent=text('Stockage de reprise indisponible ou invalide : enregistrement bloqué.','Recovery storage unavailable or invalid: saving blocked.');
  }
  function headings(){
    $('title').textContent=text('Qualification locale des signaux','Local signal qualification');
    $('note').textContent=text('Revue humaine des signaux enregistrés. Une consultation répétée ne prouve pas un projet d’achat. Cette revue reste locale : aucun email ni enregistrement Airtable.','Human review of recorded signals. Repeated browsing does not prove purchase intent. This review stays local: no email or Airtable record.');
    $('refresh').textContent=text('Actualiser les revues','Refresh reviews');$('decision-label').textContent=text('Décision locale','Local decision');
    for(const option of $('decision').options)option.textContent=label(option.value);
    $('note-label').textContent=text('Motif de la décision (2 000 caractères maximum)','Decision reason (2,000 characters maximum)');
    $('links-note').textContent=text('Références CRM proposées, non vérifiées. Le format rec… ne confirme ni l’identité ni la relation boutique / acheteur / marque / saison. Aucun rapprochement automatique.','Proposed CRM references, unverified. The rec… format confirms neither identity nor store / buyer / brand / season relationships. No automatic matching.');
    $('ack-label').textContent=text('J’ai examiné les observations affichées ; ma qualification locale ne confirme aucune intention d’achat ni aucun rapprochement CRM.','I reviewed the displayed observations; my local qualification confirms neither purchase intent nor CRM identity matching.');
    $('save').textContent=text('Enregistrer la revue locale','Save local review');$('discard').textContent=text('Recharger et abandonner la saisie','Reload and discard edits');
    $('history-title').textContent=text('Dix dernières versions enregistrées','Last ten saved versions');$('previews-title').textContent=text('Deux aperçus CRM hypothétiques','Two hypothetical CRM previews');
    $('preview-note').textContent=text('Aperçus de la dernière revue enregistrée. Destination non choisie, références non vérifiées, dédoublonnage et effets externes à auditer. Transfert bloqué. Schéma de référence daté du 3 novembre 2026.','Previews of the last saved review. Destination not chosen, references unverified, deduplication and external effects need auditing. Transfer blocked. Reference schema dated 3 November 2026.');
    $('crm-title').textContent=text('Contrôle technique des références CRM','Technical CRM reference check');
    $('crm-note').textContent=text('Lecture manuelle de quatre références enregistrées. L’existence, le lien boutique et les comparaisons de données sont contrôlés séparément. Une égalité d’email ne prouve pas l’identité ; la saison et les identités restent à confirmer. Aucun transfert.','Manual read of four saved references. Existence, store link and data comparisons are checked separately. Matching email does not prove identity; season and identities still need confirmation. No transfer.');
    $('crm-run').textContent=text('Contrôler les références CRM','Check CRM references');$('crm-refresh').textContent=text('Actualiser les contrôles','Refresh checks');$('crm-verify').textContent=text('Vérifier le résultat du contrôle','Check operation receipt');$('crm-cancel').textContent=text('Clore le contrôle non confirmé','Close unconfirmed check');
    $('crm-recovery-note').textContent=text('Contrôle non confirmé. Vérifiez son état ou clôturez-le avant une autre opération. Une clôture empêche d’enregistrer un résultat tardif ; elle ne peut pas annuler des lectures déjà effectuées.','Unconfirmed check. Verify its status or close it before another operation. Closing prevents a late result from being saved; it cannot undo reads already performed.');
    $('verify').textContent=text('Vérifier l’enregistrement','Check saved receipt');$('cancel').textContent=text('Clore la tentative non confirmée','Close unconfirmed attempt');
  }
  function clearEvidence(){crmState=null;$('crm-rows').replaceChildren();$('crm-status').textContent='';$('crm-panel').hidden=true;detail=null;$('evidence').textContent='';$('saved-state').textContent='';$('history').replaceChildren();$('previews').replaceChildren();}
  function clearSelected(){clearEvidence();selected=null;dirty=false;blocked=false;$('form').reset();for(const n of links)$(n).value='';$('detail').hidden=true;}
  async function renderDetail(value){
    detail=validDetail(value);selected=value.source.candidate_id;dirty=false;blocked=false;$('detail').hidden=false;
    $('source-title').textContent=(value.source.buyer_name||value.source.buyer_id)+' / '+(value.source.brand_name||value.source.brand_id);
    const e=value.source.evidence;
    $('evidence').textContent=`${e.distinct_days} ${text('jours UTC distincts sur','distinct UTC days within')} ${e.window_hours/24} ${text('jours','days')} · ${date(e.first_observed_at)} → ${date(e.last_observed_at)} · `+(value.source.live.eligible?text('Signal actuellement éligible à la revue','Signal currently eligible for review'):text('Signal actuellement exclu : ','Signal currently excluded: ')+value.source.live.reason);
    $('saved-state').textContent=label(value.review_state.label)+' · v'+(value.review?.version||0);
    $('decision').value=value.review?.decision||'review';$('reason').value=value.review?.note||'';$('ack').checked=false;
    for(const n of links)$(n).value=value.review?.links?.[n]||'';
    $('history').replaceChildren(...value.history.map(r=>{const li=document.createElement('li');li.textContent=`v${r.version} · ${label(r.decision)} · ${date(r.created_at)} · ${r.note}`;return li;}));
    $('previews').replaceChildren(...value.previews.map(p=>{const box=document.createElement('details'),title=document.createElement('summary'),pre=document.createElement('pre');title.textContent=(p.destination==='opportunities'?'OPPORTUNITIES':'SS27 Pipeline')+' · '+text('transfert bloqué','transfer blocked');pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';pre.textContent=JSON.stringify(p,null,2);box.append(title,pre);return box;}));
    await readCRM();
  }
  async function readList(){
    list=null;$('rows').replaceChildren();$('count').textContent='';const value=await api('?offset='+offset);
    if(!value||value.mode!=='local_review'||value.sending_enabled!==false||value.crm_writes_enabled!==false||!Number.isInteger(value.total)||!Array.isArray(value.rows)||!value.counts||value.rows.some(r=>!uuid(r.candidate_id)||!r.review_state))throw Error('invalid_response');
    list=value;$('count').textContent=`${value.total?offset+1:0}–${Math.min(offset+50,value.total)} / ${value.total} · ${value.counts.qualified} ${text('qualifiés localement','locally qualified')} · ${value.counts.stale} ${text('à revoir','need review')}`;
    for(const row of value.rows){const li=document.createElement('li'),span=document.createElement('span'),button=document.createElement('button');li.style.cssText='padding:12px 0;border-bottom:1px solid #ddd;display:flex;gap:8px;flex-wrap:wrap;align-items:center';span.style.flex='1 1 220px';span.textContent=(row.buyer_name||row.buyer_id)+' / '+(row.brand_name||row.brand_id)+' · '+label(row.review_state.label);button.type='button';button.className='btn btn-secondary';button.textContent=text('Examiner','Review');button.dataset.candidateId=row.candidate_id;button.onclick=()=>choose(row.candidate_id);li.append(span,button);$('rows').append(li);}
    if(!value.rows.length)$('rows').textContent=text('Aucun signal enregistré sur cette page.','No recorded signal on this page.');
  }
  function error(error){
    if(error.status===404&&selected){if(pending?.candidate_id===selected)storage(null);if(crmPending?.candidate_id===selected)crmStorage(null);clearSelected();$('status').textContent=text('Signal supprimé ou expiré : saisie effacée.','Signal deleted or expired: form cleared.');}
    else if(error.status===409){blocked=true;clearEvidence();$('status').textContent=text('La revue ou les observations ont changé. Saisie conservée, enregistrement bloqué. Rechargez pour examiner la version actuelle.','Review or observations changed. Edits retained, saving blocked. Reload to review the current version.');}
    else{clearEvidence();blocked=true;$('status').textContent=text('Données indisponibles. Aucun résultat confirmé. Rechargez pour reprendre.','Data unavailable. No result confirmed. Reload to continue.');}
  }
  async function choose(id,discard=false){
    if(busy||pending||crmPending)return;if(dirty&&!discard){$('status').textContent=text('Saisie non enregistrée. Enregistrez-la ou abandonnez-la explicitement avant de changer de signal.','Unsaved edits. Save or explicitly discard them before changing signals.');return;}
    busy=true;selected=id;clearEvidence();controls();try{await renderDetail(await api('/'+id));$('status').textContent='';}catch(e){error(e);}finally{busy=false;controls();}
  }
  async function resolve(cancel=false){
    if(!pending)return;selected=pending.candidate_id;
    const value=cancel?await api('/operations/'+pending.request_key+'/cancel','POST',{candidate_id:pending.candidate_id}):await api('/operations/'+pending.request_key);
    if(cancel||value.found){
      if(!value.operation||!['saved','cancelled'].includes(value.operation.status)||value.operation.candidate_id!==pending.candidate_id)throw Error('invalid_response');
      const id=pending.candidate_id;if(!storage(null))throw Error('storage_unavailable');
      await renderDetail(value.detail||await api('/'+id));await readList();$('status').textContent=value.operation.status==='saved'?text('Revue enregistrée confirmée par son reçu.','Saved review confirmed by its receipt.'):text('Tentative close. Une ancienne requête ne peut plus l’enregistrer.','Attempt closed. An old request can no longer save it.');
    }else{$('status').textContent=text('Aucun reçu trouvé. La tentative reste non confirmée ; vous pouvez la clore avant de recommencer.','No receipt found. Attempt remains unconfirmed; close it before starting again.');}
  }
  async function load(){
    if(busy)return;busy=true;headings();controls();
    try{await readList();if(pending)await resolve();else if(crmPending)await resolveCRM();else if(selected){if(dirty){const fresh=validDetail(await api('/'+selected));if(!detail||fresh.source.source_token!==detail.source.source_token||(fresh.review?.version||0)!==(detail.review?.version||0)){blocked=true;clearEvidence();$('status').textContent=text('Données modifiées. Saisie conservée : rechargez avant de poursuivre.','Data changed. Edits retained: reload before continuing.');}else $('status').textContent=text('Liste actualisée ; saisie non enregistrée conservée.','List refreshed; unsaved edits retained.');}else await renderDetail(await api('/'+selected));}else $('status').textContent='';}
    catch(e){error(e);}finally{busy=false;controls();}
  }
  $('form').oninput=()=>{dirty=true;crmState=null;$('crm-rows').replaceChildren();$('crm-status').textContent=text('Saisie modifiée : enregistrez puis relisez les contrôles.','Edits changed: save and reload the checks.');controls();$('status').textContent=text('Saisie non enregistrée. Les aperçus concernent la dernière version enregistrée.','Unsaved edits. Previews show the last saved version.');};
  $('form').onsubmit=async event=>{
    event.preventDefault();if(busy||pending||crmPending||blocked||!detail||storageError)return;
    const body={request_key:crypto.randomUUID(),version:detail.review?.version||0,source_token:detail.source.source_token,decision:$('decision').value,note:$('reason').value,ack_evidence:$('ack').checked,links:Object.fromEntries(links.map(n=>[n,$(n).value]))};
    if(body.decision!=='review'&&!body.note.trim()||body.decision==='qualified'&&!body.ack_evidence){$('status').textContent=text('Un motif est requis ; la qualification nécessite aussi la confirmation de lecture.','A reason is required; qualification also requires review acknowledgement.');return;}
    if(!storage({candidate_id:selected,request_key:body.request_key})){controls();return;}
    busy=true;controls();try{const value=await api('/'+selected,'PUT',body);validDetail(value.detail);if(!value.operation||value.operation.request_key!==pending.request_key||value.operation.status!=='saved')throw Error('invalid_response');if(!storage(null))throw Error('storage_unavailable');await renderDetail(value.detail);await readList();$('status').textContent=text('Revue locale enregistrée. Aucun transfert CRM.','Local review saved. No CRM transfer.');}
    catch(e){if([400,409,422].includes(e.status)){storage(null);error(e);}else{clearEvidence();blocked=true;$('status').textContent=text('Réponse non confirmée. Vérifiez le reçu ou clôturez la tentative.','Unconfirmed response. Check the receipt or close the attempt.');}}
    finally{busy=false;controls();}
  };
  function checkOperation(v){if(!v||!uuid(v.request_key)||!uuid(v.candidate_id)||!['running','completed','failed','cancelled'].includes(v.status)||v.identity_verified!==false||v.season_verified!==false||v.ready_to_transfer!==false||typeof v.current!=='boolean')throw Error('invalid_response');return v;}
  async function readCRM(){
    crmState=null;$('crm-rows').replaceChildren();$('crm-panel').hidden=false;
    try{const value=await api('/'+selected+'/crm-checks');if(value.mode!=='read_only_crm_checks'||typeof value.reader_available!=='boolean'||value.crm_writes_enabled!==false||value.identity_verified!==false||value.ready_to_transfer!==false||!Array.isArray(value.checks))throw Error('invalid_response');value.checks.forEach(checkOperation);crmState=value;
      $('crm-status').textContent=value.reader_available?text('Lecture disponible sur demande. Identités et saison non vérifiées.','Reading available on request. Identities and season unverified.'):text('La connexion de lecture CRM n’est pas activée sur cet environnement.','CRM reading connection is not enabled in this environment.');
      const labels={running:text('En cours — résultat non confirmé','Running — result unconfirmed'),completed:text('Contrôle terminé','Check completed'),failed:text('Contrôle échoué','Check failed'),cancelled:text('Contrôle clos','Check closed')};
      for(const check of value.checks){const item=document.createElement('li'),li=document.createElement('details'),summary=document.createElement('summary');li.open=check.current;summary.textContent=date(check.finished_at||check.created_at)+' · '+labels[check.status]+' · '+(check.current?text('photographie de moins d’une heure, liée à cette revue','snapshot under one hour, tied to this review'):text('historique, à recontrôler','historical, needs recheck'))+(check.error_code?' · '+check.error_code:'');li.append(summary);item.append(li);
        if(check.result){if(check.result.identity_verified!==false||check.result.season_verified!==false||check.result.ready_to_transfer!==false||check.result.crm_writes_enabled!==false||!check.result.entities)throw Error('invalid_response');
          const rows=document.createElement('ul');for(const [name,row] of Object.entries(check.result.entities)){const item=document.createElement('li');item.textContent=name.toUpperCase()+' · '+(row.found?text('référence retrouvée','reference found'):text('référence non retrouvée','reference not found'))+' · '+text('nom présent : ','name present: ')+(row.name_present?text('oui','yes'):text('non','no'));
            for(const [field,fr,en] of [['email_matches_local','email égal au B2B','email matches B2B'],['linked_store_matches','boutique liée conforme','linked store matches'],['name_matches_local','nom égal au B2B','name matches B2B']])if(typeof row[field]==='boolean')item.textContent+=' · '+text(fr,en)+' : '+(row[field]?text('oui','yes'):text('non','no'));rows.append(item);}
          li.append(rows);}
        $('crm-rows').append(item);}
    }catch(e){crmState=null;$('crm-rows').replaceChildren();$('crm-status').textContent=text('Contrôles indisponibles. Aucun résultat actuel confirmé.','Checks unavailable. No current result confirmed.');if(e.status===404)throw e;}
  }
  async function resolveCRM(cancel=false){
    if(!crmPending)return;selected=crmPending.candidate_id;
    const value=cancel?await api('/crm-operations/'+crmPending.request_key+'/cancel','POST',{candidate_id:selected}):await api('/crm-operations/'+crmPending.request_key);
    if(!cancel&&!value.found){$('status').textContent=text('Aucun reçu de contrôle trouvé. Clôturez la tentative avant de recommencer.','No check receipt found. Close the attempt before starting again.');return;}
    const operation=checkOperation(value.operation);if(operation.candidate_id!==selected||operation.request_key!==crmPending.request_key)throw Error('invalid_response');
    if(operation.status==='running'){await readCRM();$('status').textContent=text('Contrôle en cours ou interrompu. Vérifiez plus tard ou clôturez-le.','Check running or interrupted. Check later or close it.');return;}
    if(!crmStorage(null))throw Error('storage_unavailable');await renderDetail(await api('/'+selected));$('status').textContent=text('État du contrôle récupéré. Aucun transfert CRM.','Check status recovered. No CRM transfer.');
  }
  $('crm-run').onclick=async()=>{
    if($('crm-run').disabled)return;const body={request_key:crypto.randomUUID(),review_version:detail.review.version,source_token:detail.source.source_token};
    if(!crmStorage({candidate_id:selected,request_key:body.request_key})){controls();return;}busy=true;controls();
    try{const value=await api('/'+selected+'/crm-checks','POST',body);const operation=checkOperation(value.operation);if(operation.request_key!==crmPending.request_key||operation.candidate_id!==selected)throw Error('invalid_response');if(operation.status!=='running'){if(!crmStorage(null))throw Error('storage_unavailable');await renderDetail(await api('/'+selected));}else await readCRM();$('status').textContent=text('État du contrôle enregistré. Identités et saison à confirmer.','Check status recorded. Identities and season need confirmation.');}
    catch(e){if(e.status===404){error(e);}else if([400,409,422].includes(e.status)){crmStorage(null);error(e);}else{$('crm-rows').replaceChildren();crmState=null;$('status').textContent=text('Réponse du contrôle non confirmée. Vérifiez son reçu ou clôturez-le.','Unconfirmed check response. Check its receipt or close it.');}}
    finally{busy=false;controls();}
  };
  $('crm-refresh').onclick=async()=>{if($('crm-refresh').disabled)return;busy=true;controls();try{await readCRM();}catch(e){error(e);}finally{busy=false;controls();}};
  for(const [name,cancel] of [['crm-verify',false],['crm-cancel',true]])$(name).onclick=async()=>{if(busy||!crmPending)return;busy=true;controls();try{await resolveCRM(cancel);}catch(e){error(e);}finally{busy=false;controls();}};
  $('refresh').onclick=()=>load();$('prev').onclick=()=>{offset=Math.max(0,offset-50);load();};$('next').onclick=()=>{offset+=50;load();};$('discard').onclick=()=>choose(selected,true);
  for(const [name,cancel] of [['verify',false],['cancel',true]])$(name).onclick=async()=>{if(busy||!pending)return;busy=true;controls();try{await resolve(cancel);}catch(e){error(e);}finally{busy=false;controls();}};
  headings();controls();return {load};
})();
