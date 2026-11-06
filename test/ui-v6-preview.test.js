'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('public/ui-v6/preview.css');
const js = read('public/ui-v6/preview.js');

test('Preview assets are wired only into authenticated screens', () => {
  for (const screen of ['portal.html','admin.html','agent.html']) {
    const html = read('public/' + screen);
    assert.match(html, /\/ui-v6\/preview\.css/);
    assert.match(html, /\/ui-v6\/preview\.js/);
  }
  assert.doesNotMatch(read('public/portal-login.html'), /\/ui-v6\//);
});

test('Preview stylesheet has desktop and responsive rules and is scoped', () => {
  assert.match(css, /html\.es-v6-preview/);
  assert.match(css, /data-es-ui-surface="buyer"/);
  assert.match(css, /data-es-ui-surface="admin"/);
  assert.match(css, /data-es-ui-surface="agent"/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /#33251f/i);
  assert.match(css, /#b8d3e7/i);
});

function runPreview(search, saved, pathname = '/portal') {
  const state = Object.assign({}, saved ? {'es-b2b-v6-preview':'1'} : {});
  const attrs = {};
  const classes = [];
  const fakeBody = { appendChild() {} };
  const fakeDocument = {
    documentElement: {
      classList: { add(value) {classes.push(value);} },
      setAttribute(k,v) {attrs[k]=v;}
    },
    readyState:'loading',
    addEventListener(){},
    querySelector(){return null},
    body:fakeBody
  };
  const fakeWindow = {
    location:{pathname,search},
    sessionStorage:{
      getItem(k){return state[k]||null;},
      setItem(k,v){state[k]=v;},
      removeItem(k){delete state[k];}
    }
  };
  vm.runInNewContext(js, { window:fakeWindow, document:fakeDocument, URLSearchParams });
  return {state,attrs,classes};
}

test('V6 is opt-in and restores classic mode', () => {
  assert.equal(runPreview('',false).classes.length,0);
  assert.ok(runPreview('?ui=v6',false).classes.includes('es-v6-preview'));
  assert.ok(runPreview('',true).classes.includes('es-v6-preview'));
  assert.equal(runPreview('?ui=classic',true).classes.length,0);
});

test('Original login remains untouched even if preview is requested', () => {
  assert.equal(runPreview('?ui=v6',false,'/editions-showroom-b2b-portail').classes.length,0);
});

test('Preview picks correct authenticated surface', () => {
  assert.equal(runPreview('?ui=v6',false,'/portal').attrs['data-es-ui-surface'],'buyer');
  assert.equal(runPreview('?ui=v6',false,'/admin').attrs['data-es-ui-surface'],'admin');
  assert.equal(runPreview('?ui=v6',false,'/agent').attrs['data-es-ui-surface'],'agent');
});
