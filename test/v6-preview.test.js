'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const uiPages=[
  'portal.html','admin.html','agent.html','commande.html','selection.html',
  'buyer.html','rdv.html','portal-login.html','demande-acces.html',
  'admin-login.html','index.html'
];
test('V6 preview bootstrap is linked in all targeted real pages',()=>{
  for(const page of uiPages){
    const html=fs.readFileSync(path.join(root,'public',page),'utf8');
    assert.ok(html.includes('<script src="/es-v6-preview.js" defer></script>'),page);
    assert.equal(html.split('src="/es-v6-preview.js"').length-1,1,page);
  }
});
test('V6 CSS opt-in styles and visual tokens exist',()=>{
  const css=fs.readFileSync(path.join(root,'public/es-v6-preview.css'),'utf8');
  for(const token of ['data-es-v6-preview="on"','#33251F','#B8D3E7',
    '@media(max-width:900px)','@media(max-width:640px)',
    '@media(prefers-reduced-motion:reduce)'])assert.ok(css.includes(token),token);
});
test('V6 preview avoids changing landing styling and routes',()=>{
  const js=fs.readFileSync(path.join(root,'public/es-v6-preview.js'),'utf8');
  assert.ok(js.includes("path === '/editions-showroom-b2b-portail'"));
  assert.ok(js.includes("path === '/demande-acces'"));
  assert.ok(js.includes("if (excluded) return;"));
  assert.ok(js.includes("storageGet('es-v6-preview') !== 'on'"));
  assert.ok(js.includes("const h = new Date().getHours()"));
  assert.ok(js.includes("h >= 7 && h < 20"));
  assert.ok(!js.includes("fetch("),'JS must not call commerce APIs');
  assert.ok(!js.includes("XMLHttpRequest("),'JS must not call commerce APIs');
});
test('V6 bootstrap parses as valid JS',()=>{
  const js=fs.readFileSync(path.join(root,'public/es-v6-preview.js'),'utf8');
  assert.doesNotThrow(()=>new Function(js));
});
