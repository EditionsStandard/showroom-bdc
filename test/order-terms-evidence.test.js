'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildTermsEvidence, resolveOrderTerms } = require('../lib/order-terms-evidence');

test('brand terms are captured verbatim with a SHA-256 digest and source', () => {
 const capturedAt = '2026-11-21T15:00:00.000Z';
 const item = buildTermsEvidence({brandText:'Payment: 30 days\nShipping: DAP',globalText:'Agency default',capturedAt});
 assert.equal(item.cgv_text_snapshot,'Payment: 30 days\nShipping: DAP');
 assert.equal(item.cgv_source,'brand');
 assert.equal(item.cgv_captured_at,capturedAt);
 assert.equal(item.cgv_sha256,crypto.createHash('sha256').update(item.cgv_text_snapshot).digest('hex'));
});

test('showroom fallback and empty terms are explicitly snapshotted', () => {
 assert.equal(buildTermsEvidence({brandText:'  ',globalText:'Global terms'}).cgv_text_snapshot,'Global terms');
 assert.equal(buildTermsEvidence({brandText:'',globalText:''}).cgv_source,'none');
});

test('a signed order retains its original terms despite brand edits', () => {
 const evidence=buildTermsEvidence({brandText:'Original 2026 terms',globalText:'Fallback'});
 assert.equal(resolveOrderTerms(evidence,'Altered 2027 terms','New fallback'),'Original 2026 terms');
 assert.equal(resolveOrderTerms({cgv_text_snapshot:''},'Terms added later','New fallback'),'');
 assert.equal(resolveOrderTerms(null,'Current brand terms','Current agency terms'),'Current brand terms');
});
