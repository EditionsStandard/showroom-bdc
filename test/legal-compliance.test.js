'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('FR and EN privacy notices use the same 30-day access request retention period', () => {
  const html = read('confidentialite.html');
  const fr = html.split('<!-- ============ EN ============ -->')[0];
  const en = html.split('<!-- ============ EN ============ -->')[1];
  assert.match(fr, /30 jours/);
  assert.match(en, /30 days/);
  assert.doesNotMatch(en, /3 years after the last contact/);
  assert.doesNotMatch(fr, /Aucun autre sous-traitant n'est sollicité/);
  assert.doesNotMatch(en, /No other processor currently handles data outside/);
  assert.match(fr, /Airtable/);
  assert.match(en, /Cloudinary/);
});

test('legal notices include the host company phone and current dates', () => {
  const html = read('mentions-legales.html');
  assert.match(html, /\+1 415 707 7675/);
  assert.match(html, /21 novembre 2026/);
  assert.match(html, /November 21, 2026/);
});

test('access form separates acknowledgement from optional marketing agreement', () => {
  const html = read('demande-acces.html');
  assert.match(html, /J'ai pris connaissance/);
  assert.match(html, /I have read the/);
  assert.match(html, /id="f-marketing"/);
  assert.doesNotMatch(html, /J'ai lu et j'accepte la/);
});

test('legal links are reachable from the principal B2B screens', () => {
  for (const file of ['index.html', 'portal.html', 'commande.html', 'selection.html', 'portal-login.html']) {
    const html = read(file);
    assert.match(html, /href="\/mentions-legales"/, file);
    assert.match(html, /href="\/confidentialite"/, file);
    assert.match(html, /href="\/cgu"/, file);
  }
});

test('terms of use do not assert unverified immutable archiving of signed PDFs', () => {
  const html = read('cgu.html');
  assert.doesNotMatch(html, /associée de façon indissociable au document PDF/);
  assert.doesNotMatch(html, /inseparably linked to the PDF/);
  assert.match(html, /21 novembre 2026/);
});
