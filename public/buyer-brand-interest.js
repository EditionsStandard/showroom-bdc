'use strict';
window.BuyerBrandInterest=(()=>{
  const container=document.getElementById('buyer-interest-preferences');
  const text=(fr,en)=>currentLang==='en'?en:fr;
  let navigation=0;
  async function api(body) {
    const response=await fetch('/api/portal/interest-preferences',body?{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
    const value=await response.json();
    if(!response.ok||!['unknown','granted','denied'].includes(value.status)||!Number.isInteger(value.version)||typeof value.notice_version!=='string'||typeof value.collecting_enabled!=='boolean')throw new Error('preference_unconfirmed');
    return value;
  }
  function visible(brandId,token) {
    return token===navigation&&document.visibilityState==='visible'&&currentBrand?.id===brandId&&!earlyAccessLocked&&
      document.getElementById('view-catalog').style.display!=='none'&&document.getElementById('brand-products').style.display!=='none';
  }
  async function record(brandId,token) {
    if(!visible(brandId,token))return;
    try {
      const pref=await api();
      if(!pref.collecting_enabled||!visible(brandId,token))return;
      await fetch('/api/portal/brand-interest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand_id:brandId,consent_version:pref.version})});
    } catch { /* Optional observations never interrupt product browsing. No queue or automatic retry. */ }
  }
  async function load() {
    container.replaceChildren();
    const title=document.createElement('h3'),status=document.createElement('p'),retry=document.createElement('button');
    title.textContent=text('Suivi facultatif des marques consultées','Optional tracking of viewed brands');status.setAttribute('role','status');
    status.textContent=text('Chargement…','Loading…');retry.className='btn-confirm';retry.textContent=text('Actualiser mon choix','Refresh my choice');retry.onclick=load;retry.hidden=true;
    container.append(title,status,retry);
    try {
      let pref=await api();
      const form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('input'),note=document.createElement('p'),button=document.createElement('button');
      input.type='checkbox';input.checked=pref.status==='granted';
      label.append(input,document.createTextNode(text(' J’autorise Éditions Standard à enregistrer les marques que je consulte pour préparer un accompagnement commercial personnalisé.',' I allow Éditions Standard to record brands I view to prepare personalised commercial assistance.')));
      note.textContent=text('Facultatif, sans effet sur votre accès. Une observation par marque et jour UTC. ','Optional, with no effect on your access. One observation per brand per UTC day. ')+
        (pref.retention_schedule_enabled?text('Les observations de plus de 30 jours et les signaux de plus de 90 jours font l’objet d’une purge automatique, avec un objectif de passage complet toutes les six heures. Une interruption ou un traitement incomplet peut retarder la suppression. ','Observations older than 30 days and signals older than 90 days are subject to automatic cleanup, targeting a complete run every six hours. An interruption or incomplete run can delay deletion. '):text('La purge automatique est actuellement désactivée. La suppression des observations de plus de 30 jours et des signaux de plus de 90 jours est traitée par lots lors des calculs ou du redémarrage du service ; leur stockage peut donc durer plus longtemps. ','Automatic cleanup is currently disabled. Cleanup of observations older than 30 days and signals older than 90 days runs in batches during calculations or service restart; storage may therefore last longer. '))+
        text('Aucun détail produit, URL, adresse IP ou appareil dans ce suivi. Votre choix email reste distinct. Un retrait supprime ces observations et signaux ; la preuve de votre choix reste liée au compte jusqu’à sa suppression.','No product details, URL, IP address or device in this tracking. Email permission remains separate. Withdrawal deletes these observations and signals; evidence of your choice stays linked to the account until its deletion.');
      button.className='btn-confirm';button.textContent=text('Enregistrer mon choix','Save my choice');form.append(label,note,button);container.insertBefore(form,status);
      status.textContent=pref.status==='granted'?text('Accord enregistré. Vous pouvez le retirer ici.','Permission recorded. You may withdraw it here.'):text('Ce suivi n’est pas autorisé pour votre compte.','This tracking is not authorised for your account.');
      form.onsubmit=async event=>{
        event.preventDefault();button.disabled=true;retry.hidden=true;
        try {
          pref=await api({interest_consent:input.checked,version:pref.version,notice_version:pref.notice_version});input.checked=pref.status==='granted';
          status.textContent=text('Votre choix a été enregistré.','Your choice has been saved.');
        } catch {status.textContent=text('Enregistrement non confirmé. Actualisez votre choix avant de réessayer.','Save unconfirmed. Refresh your choice before trying again.');retry.hidden=false;}
        finally {button.disabled=false;}
      };
    } catch {status.textContent=text('Choix indisponible. Aucun suivi facultatif ne sera engagé sans accord vérifié.','Preference unavailable. Optional tracking requires verified permission.');retry.hidden=false;}
  }
  return {load,begin:()=>++navigation,record};
})();
