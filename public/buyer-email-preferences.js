'use strict';
window.BuyerEmailPreferences = (() => {
  const container=document.getElementById('buyer-email-preferences');
  const t=(fr,en)=>typeof currentLang!=='undefined' && currentLang==='fr'?fr:en;
  async function load() {
    container.replaceChildren();
    const title=document.createElement('h3');title.textContent=t('Préférences email','Email preferences');
    const status=document.createElement('p');status.setAttribute('role','status');status.textContent=t('Chargement…','Loading…');container.append(title,status);
    try {
      const response=await fetch('/api/portal/email-preferences');if(!response.ok)throw new Error(t('Chargement impossible. Réessayez.','Unable to load. Please retry.'));
      const preference=await response.json();
      const form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=preference.status==='granted';
      label.append(input,document.createTextNode(t(' Je souhaite recevoir les nouveautés et invitations commerciales d’Éditions Standard par email.',' I would like to receive Éditions Standard news and commercial invitations by email.')));
      const note=document.createElement('p');note.textContent=t('Facultatif. Vous pouvez retirer votre accord ici à tout moment. Les messages nécessaires à votre compte et à vos commandes restent distincts.','Optional. You may withdraw permission here at any time. Messages required for your account and orders remain separate.');
      const button=document.createElement('button');button.className='btn-confirm';button.textContent=t('Enregistrer mon choix','Save my choice');
      form.append(label,note,button);container.insertBefore(form,status);
      status.textContent=preference.status==='unknown'?t('Aucun accord marketing confirmé.','No marketing permission confirmed.'):preference.status==='granted'?t('Accord enregistré.','Permission recorded.'):t('Vous ne recevez pas de relances marketing soumises à cet accord.','You are excluded from marketing follow-ups governed by this permission.');
      form.onsubmit=async event=>{
        event.preventDefault();button.disabled=true;
        try {
          const saved=await fetch('/api/portal/email-preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketing_consent:input.checked})});
          if(!saved.ok)throw new Error(t('Enregistrement impossible. Réessayez.','Unable to save. Please retry.'));
          status.textContent=t('Votre choix a été enregistré.','Your choice has been saved.');
        }catch(e){status.textContent=e.message;}finally{button.disabled=false;}
      };
    } catch(e) {
      status.textContent=e.message;const retry=document.createElement('button');retry.className='btn-confirm';retry.textContent=t('Réessayer','Retry');retry.onclick=load;container.append(retry);
    }
  }
  return {load};
})();
