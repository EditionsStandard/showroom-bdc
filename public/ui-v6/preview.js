/* Editions Standard UI V6 — explicit visual preview, no production-side effects.
 * Enable on authenticated pages with ?ui=v6. Disable with ?ui=classic.
 * This script does not call APIs, modify orders, or replace application event handlers.
 */
(function () {
  'use strict';
  var key = 'es-b2b-v6-preview';
  var mode = new URLSearchParams(window.location.search).get('ui');
  try {
    if (mode === 'v6') window.sessionStorage.setItem(key, '1');
    if (mode === 'classic') window.sessionStorage.removeItem(key);
  } catch (_) { /* previews still work for the current URL without storage */ }
  var enabled = mode === 'v6';
  if (mode !== 'classic' && !enabled) {
    try { enabled = window.sessionStorage.getItem(key) === '1'; } catch (_) { }
  }
  if (!enabled) return;

  var page = window.location.pathname;
  // The login page is deliberately excluded: it keeps its original layout,
  // visual identity, security screens and form submissions.
  if (page === '/editions-showroom-b2b-portail' ||
      page === '/admin/login') return;

  var root = document.documentElement;
  root.classList.add('es-v6-preview');
  root.setAttribute('data-es-ui-surface',
    page.indexOf('/admin') === 0 ? 'admin' :
    page.indexOf('/agent') === 0 ? 'agent' : 'buyer');

  function addExit() {
    if (!document.body || document.querySelector('.es-v6-preview-exit')) return;
    var link = document.createElement('a');
    link.className = 'es-v6-preview-exit';
    link.textContent = 'V6 PREVIEW · Exit';
    link.href = page + '?ui=classic';
    link.setAttribute('aria-label', 'Quitter la prévisualisation V6');
    document.body.appendChild(link);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addExit, { once:true });
  } else {
    addExit();
  }
})();
