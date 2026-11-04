'use strict';
(() => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const pathToken = location.pathname.match(/^\/api\/public\/buyer-engagement\/unsubscribe\/([a-f0-9]{64})$/)?.[1];
  const activation = location.pathname === '/buyer-engagement/activate';
  let token = fragment.get('token') || pathToken || '';
  let lang = fragment.get('lang') === 'en' ? 'en' : 'fr', done = false, busy = false, outcome = '';
  // Keep the bearer in this closure only, removing it before any interaction.
  history.replaceState(null, '', activation ? '/buyer-engagement/activate' : '/buyer-engagement/unsubscribe');
  const $ = id => document.getElementById(id);
  const copy = {
    fr: {activate:'Activer votre accès',unsubscribe:'Gérer vos communications',activation:'Choisissez votre mot de passe pour accéder à votre compte acheteur déjà approuvé. Ce lien est valable une heure.',description:'Confirmez pour ne plus recevoir les communications commerciales du showroom. Votre accès acheteur reste disponible.',password:'Nouveau mot de passe',confirmation:'Confirmer le mot de passe',help:'Entre 12 et 128 caractères.',activateButton:'Enregistrer mon mot de passe',unsubscribeButton:'Me désabonner',portal:'Accéder au showroom',invalid:'Lien invalide ou expiré. Utilisez un lien récent ou contactez le showroom.',mismatch:'Les mots de passe doivent être identiques et comporter entre 12 et 128 caractères.',network:'La confirmation n’a pas pu être vérifiée. Réessayez.',activated:'Votre mot de passe est enregistré. Connectez-vous au showroom.',unsubscribed:'Votre désabonnement est enregistré.',working:'Enregistrement…'},
    en: {activate:'Activate your access',unsubscribe:'Manage your emails',activation:'Choose a password for your already approved buyer account. This link is valid for one hour.',description:'Confirm to stop receiving commercial emails from the showroom. Your buyer access remains available.',password:'New password',confirmation:'Confirm password',help:'Between 12 and 128 characters.',activateButton:'Save my password',unsubscribeButton:'Unsubscribe',portal:'Go to the showroom',invalid:'Invalid or expired link. Use a recent link or contact the showroom.',mismatch:'Passwords must match and contain between 12 and 128 characters.',network:'The confirmation could not be verified. Please try again.',activated:'Your password has been saved. Sign in to the showroom.',unsubscribed:'Your unsubscribe request has been saved.',working:'Saving…'}
  };
  function render() {
    const c = copy[lang];document.documentElement.lang=lang;document.title=(activation?c.activate:c.unsubscribe)+' — Éditions Standard';
    $('language').textContent=lang==='fr'?'EN':'FR';$('language').setAttribute('aria-label',lang==='fr'?'Read in English':'Lire en français');
    $('title').textContent=activation?c.activate:c.unsubscribe;$('description').textContent=activation?c.activation:c.description;
    $('password-label').textContent=c.password;$('confirmation-label').textContent=c.confirmation;$('password-help').textContent=c.help;
    $('submit').textContent=busy?c.working:activation?c.activateButton:c.unsubscribeButton;$('submit').disabled=busy;
    $('portal').textContent=c.portal;$('password-fields').hidden=!activation;
    $('password').required=activation;$('confirmation').required=activation;
    $('action').hidden=done||!/^[a-f0-9]{64}$/.test(token);
    $('status').textContent=outcome?c[outcome]:$('action').hidden&&!done?c.invalid:'';
  }
  $('language').addEventListener('click',()=>{lang=lang==='fr'?'en':'fr';render();});
  $('action').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||done)return;
    const password=$('password').value;
    if(activation&&(password.length<12||password.length>128||password!==$('confirmation').value)){outcome='mismatch';render();return;}
    busy=true;outcome='';render();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch(activation?'/api/portal/reset-password':'/api/public/buyer-engagement/unsubscribe',{
        method:'POST',credentials:'omit',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(activation?{token,password}:{token})
      });
      const result=await response.json();
      if(!response.ok||!result.ok){outcome=result.code==='email_link_invalid'||result.error?'invalid':'network';}
      else {done=true;token='';$('password').value='';$('confirmation').value='';outcome=activation?'activated':'unsubscribed';}
    } catch {outcome='network';}
    finally {clearTimeout(timer);busy=false;render();}
  });
  render();
})();
