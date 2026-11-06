/*
 * ÉDITIONS STANDARD / V6 — opt-in preview bootstrap.
 * Enable: ?es_v6=1 | Disable: ?es_v6=0
 * State lives in sessionStorage so internal page navigation keeps preview on.
 * Does NOT intercept fetch, change form destinations, or write business records.
 */
(() => {
  'use strict';
  const HTML = document.documentElement;
  const url = new URL(window.location.href);
  const opt = url.searchParams.get('es_v6');
  const storageGet = (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } };
  const storageSet = (k,v) => { try { sessionStorage.setItem(k,v); } catch (_) {} };
  const storageRemove = (k) => { try { sessionStorage.removeItem(k); } catch (_) {} };
  if (opt === '0') {
    storageRemove('es-v6-preview');
    storageRemove('es-v6-preview-theme');
  } else if (opt === '1') {
    storageSet('es-v6-preview','on');
  }
  if (storageGet('es-v6-preview') !== 'on') return;
  const path = window.location.pathname;
  // Keep buyer landing/login and access request visually identical to original.
  const excluded = path === '/editions-showroom-b2b-portail' ||
    path === '/portal-login' || path === '/demande-acces' ||
    path === '/admin/login' || path === '/admin/reset-password';
  if (excluded) return;
  HTML.setAttribute('data-es-v6-preview','on');
  const sheet = document.createElement('link');
  sheet.rel='stylesheet';
  sheet.href='/es-v6-preview.css';
  sheet.setAttribute('data-es-v6-asset','');
  document.head.appendChild(sheet);

  const hourTheme = () => {
    const h = new Date().getHours();
    return h >= 7 && h < 20 ? 'light' : 'dark';
  };
  const getMode = () => storageGet('es-v6-preview-theme') || 'auto';
  const originalTheme = HTML.getAttribute('data-theme');
  let last = '';
  function applyPreviewTheme(){
    const mode = getMode();
    const next = mode === 'auto' ? hourTheme() : mode;
    if(next!==last || HTML.getAttribute('data-theme')!==next){
      HTML.setAttribute('data-theme',next);
      HTML.setAttribute('data-es-v6-active-theme',next);
      last=next;
    }
    if (document.getElementById('es-v6-toolbar')) updateButtons();
  }
  const css = `
    #es-v6-toolbar {position:fixed;right:14px;bottom:14px;z-index:2147483000;
      display:flex;gap:5px;align-items:center;flex-wrap:wrap;
      padding:8px 10px;border:1px solid #796157;border-radius:14px;
      background:#33251F;color:#fff;box-shadow:0 10px 35px rgba(0,0,0,.22);
      font:10px 'Plex Mono','Space Mono',monospace;max-width:calc(100vw - 28px)}
    #es-v6-toolbar .es-v6-title{color:#B8D3E7;font-size:9px;letter-spacing:.08em;margin:0 6px 0 2px}
    #es-v6-toolbar button {border:1px solid #6d554a;border-radius:8px;
      background:#433229;color:#fff;padding:8px 9px;font:inherit;cursor:pointer}
    #es-v6-toolbar button[aria-pressed="true"]{background:#B8D3E7;color:#33251F;border-color:#B8D3E7}
    #es-v6-toolbar button:focus-visible{outline:2px solid #B8D3E7;outline-offset:2px}
    #es-v6-toolbar [data-es-v6-off]{background:transparent}
    @media(max-width:700px){#es-v6-toolbar{bottom:calc(74px + env(safe-area-inset-bottom));right:7px;left:7px;justify-content:center;gap:4px;padding:7px}#es-v6-toolbar button{padding:7px 8px}}
    @media print {#es-v6-toolbar{display:none!important}}
  `;
  const toolbarStyle = document.createElement('style');
  toolbarStyle.textContent=css;
  document.head.appendChild(toolbarStyle);
  let toolbar;
  function updateButtons(){
    if (!toolbar) return;
    toolbar.querySelectorAll('[data-es-v6-mode]').forEach((btn) =>
      btn.setAttribute('aria-pressed', String(btn.dataset.esV6Mode === getMode())));
  }
  function mountToolbar(){
    if(!document.body || document.getElementById('es-v6-toolbar')) return;
    toolbar=document.createElement('div');
    toolbar.id='es-v6-toolbar';
    toolbar.setAttribute('role','group');
    toolbar.setAttribute('aria-label','Simulation V6, choix du thème');
    const label=document.createElement('span');
    label.className='es-v6-title';
    label.textContent='V6 · PREVIEW';
    toolbar.appendChild(label);
    for (const [v,title] of [['auto','Auto'],['light','Jour'],['dark','Nuit']]){
      const button=document.createElement('button');
      button.type='button';
      button.textContent=title;
      button.dataset.esV6Mode=v;
      button.addEventListener('click',()=>{
        storageSet('es-v6-preview-theme',v);
        applyPreviewTheme();
      });
      toolbar.appendChild(button);
    }
    const off=document.createElement('button');
    off.type='button';
    off.textContent='Quitter';
    off.setAttribute('data-es-v6-off','');
    off.addEventListener('click',()=>{
      storageRemove('es-v6-preview');
      storageRemove('es-v6-preview-theme');
      HTML.removeAttribute('data-es-v6-preview');
      HTML.removeAttribute('data-es-v6-active-theme');
      if(originalTheme!==null) HTML.setAttribute('data-theme',originalTheme);
      else HTML.removeAttribute('data-theme');
      sheet.remove();
      toolbar.remove();
      toolbarStyle.remove();
    });
    toolbar.appendChild(off);
    document.body.appendChild(toolbar);
    updateButtons();
  }
  applyPreviewTheme();
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mountToolbar,{once:true});
  else mountToolbar();
  // On long-lived buyer/admin tabs, automatic switching follows clock time.
  // The existing site refreshes themes too; this keeps preview consistent.
  window.setInterval(applyPreviewTheme,60*1000);
})();
