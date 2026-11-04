'use strict';
window.BuyerEngagementProvider=(()=>{
  const $=name=>document.getElementById('engagement-provider-'+name),text=(fr,en)=>currentLang==='en'?en:fr;
  const sources={local_fixture:['Essai isolé','Isolated rehearsal'],resend:['Resend','Resend']};
  const reasons={bounced:['Rebond définitif','Permanent bounce'],bounce_unclassified:['Rebond à qualifier','Bounce needs review'],complained:['Plainte pour spam','Spam complaint'],suppressed:['Envoi bloqué par le fournisseur','Sending suppressed by provider'],suppression_added:['Adresse bloquée par le fournisseur','Address suppressed by provider']};
  let state=null,busy=false,offset=0;
  const date=value=>value?new Date(value).toLocaleString(currentLang==='en'?'en-GB':'fr-FR'):'—';
  const source=value=>sources[value]?text(...sources[value]):text('Source à vérifier','Source needs review');
  function headings(){
    $('title').textContent=text('Retours fournisseur et blocages','Provider feedback and blocks');
    $('note').textContent=text('Ces chiffres décrivent la remise au serveur destinataire. Lecture et clics ne sont pas suivis ici. Les blocages restent à vérifier avant leur levée. Aucun envoi depuis ce volet.','These figures track delivery to the recipient server. Reading and clicks are not measured here. Blocks require review before removal. This panel cannot send.');
    $('refresh').textContent=text('Actualiser les retours','Refresh feedback');$('messages-title').textContent=text('Messages suivis — historique conservé','Tracked messages — retained history');$('blocks-title').textContent=text('Blocages conservés — 50 derniers','Retained blocks — latest 50');
    $('prev').setAttribute('aria-label',text('Page précédente des messages','Previous message page'));$('next').setAttribute('aria-label',text('Page suivante des messages','Next message page'));
  }
  function controls(){$('refresh').disabled=busy;$('prev').disabled=busy||!state||offset===0;$('next').disabled=busy||!state||offset+50>=state.total;}
  function clear(){state=null;for(const name of ['health','summary','receipts','count'])$(name).textContent='';$('messages').replaceChildren();$('blocks').replaceChildren();}
  function validate(value){
    if(!value||value.sending_enabled!==false||typeof value.receiver?.enabled!=='boolean'||typeof value.receiver?.configured!=='boolean'||!Array.isArray(value.messages)||!Array.isArray(value.blocks)||!Array.isArray(value.counts)||!Array.isArray(value.stats)||!Number.isInteger(value.total)||value.total<0||!Number.isInteger(value.blocks_total)||value.blocks_total<0)throw Error('invalid_provider_overview');
    for(const row of [...value.messages,...value.blocks,...value.stats,...value.counts])if(!sources[row.provider_kind])throw Error('invalid_provider_source');
    if(value.blocks.some(row=>!reasons[row.reason]||typeof row.current_address!=='boolean'))throw Error('invalid_provider_block');
    if(value.stats.some(row=>['messages','delivered','bounced','complained','failed','suppressed'].some(key=>!Number.isInteger(row[key])||row[key]<0)))throw Error('invalid_provider_stats');
    if(value.counts.some(row=>!['applied','unmatched','mismatch'].includes(row.status)||!Number.isInteger(row.count)||row.count<0))throw Error('invalid_provider_receipts');
  }
  function render(value){validate(value);state=value;
    $('health').textContent=!value.receiver.enabled?text('Réception externe désactivée.','External receiver disabled.'):!value.receiver.configured?text('Réception bloquée : configuration de signature manquante ou invalide.','Receiver blocked: signature configuration missing or invalid.'):text('Réception activée sur ce serveur ; cela ne prouve aucun trafic réel.','Receiver enabled on this server; this does not prove real traffic.');
    $('summary').textContent=value.stats.length?value.stats.map(s=>`${source(s.provider_kind)} : ${s.messages} ${text('messages','messages')} · ${s.delivered} ${text('remis au serveur','delivered to server')} · ${s.bounced} ${text('rebonds signalés','reported bounces')} · ${s.complained} ${text('plaintes','complaints')} · ${s.failed} ${text('échecs','failures')} · ${s.suppressed} ${text('envois bloqués','suppressed sends')}`).join(' / '):text('0 message suivi.','0 tracked messages.');
    $('summary').textContent+=' '+text('Un message peut figurer dans plusieurs catégories.','One message can appear in multiple categories.');
    const statuses={applied:['traités','applied'],unmatched:['sans rattachement — à vérifier auprès du fournisseur','unmatched — provider review required'],mismatch:['identité ou date à vérifier','identity or date needs review']};
    $('receipts').textContent=value.counts.length?value.counts.map(r=>`${source(r.provider_kind)} · ${r.count} ${text(...statuses[r.status])}`).join(' / '):text('0 retour fournisseur conservé.','0 retained provider events.');
    $('count').textContent=`${value.total?offset+1:0}–${Math.min(offset+50,value.total)} / ${value.total} · ${value.blocks_total} ${text('blocage(s) conservé(s)','retained block(s)')}`;
    for(const m of value.messages){const li=document.createElement('li');li.textContent=(m.buyer_name||'—')+' · '+source(m.provider_kind)+' · '+date(m.created_at);
      const facts=[['sent_at','Acceptation fournisseur','Provider acceptance'],['delivered_at','Remis au serveur','Delivered to server'],['delayed_at','Retard signalé','Delay reported'],['bounced_at','Rebond signalé','Bounce reported'],['complained_at','Plainte','Complaint'],['failed_at','Échec','Failure'],['suppressed_at','Envoi bloqué','Sending suppressed']].filter(([key])=>m[key]).map(([key,fr,en])=>text(fr,en)+' : '+date(m[key]));
      li.textContent+=' · '+(facts.join(' · ')||text('Aucun retour de livraison enregistré','No delivery feedback recorded'));$('messages').append(li);}
    if(!value.messages.length)$('messages').textContent=text('Aucun message sur cette page.','No messages on this page.');
    for(const block of value.blocks){const li=document.createElement('li');li.textContent=(block.buyer_name||'—')+' · '+source(block.provider_kind)+' · '+text(...reasons[block.reason])+' · '+date(block.last_event_at)+' · '+(block.current_address?text('Adresse actuelle','Current address'):text('Ancienne adresse','Previous address'));if(block.removal_notice_at)li.textContent+=' · '+text('Retrait signalé par le fournisseur ; blocage conservé pour vérification','Provider removal reported; block retained for review');$('blocks').append(li);}
    if(!value.blocks.length)$('blocks').textContent=text('Aucun blocage conservé.','No retained blocks.');$('status').textContent='';
  }
  async function load(){if(busy)return;busy=true;headings();clear();controls();try{const r=await fetch('/api/admin/buyer-engagement/provider-events?offset='+offset),value=await r.json();if(!r.ok)throw Error('provider_overview_unavailable');render(value);}catch{clear();$('status').textContent=text('Retours indisponibles. Aucun état actuel ne peut être confirmé ici.','Feedback unavailable. No current state can be confirmed here.');}finally{busy=false;controls();}}
  $('refresh').onclick=load;$('prev').onclick=()=>{offset=Math.max(0,offset-50);load();};$('next').onclick=()=>{offset+=50;load();};headings();controls();return {load};
})();
