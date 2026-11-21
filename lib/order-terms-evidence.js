'use strict';
// Records the sales terms in force when the order is committed.
// This is a dated business record, NOT qualified electronic signature or third-party timestamp.
const crypto = require('node:crypto');

function buildTermsEvidence({ brandText, globalText, capturedAt = new Date().toISOString() }) {
  const useBrand = typeof brandText === 'string' && brandText.trim().length > 0;
  const text = useBrand ? brandText : (typeof globalText === 'string' ? globalText : '');
  return {
    cgv_text_snapshot: text,
    cgv_source: useBrand ? 'brand' : (text ? 'showroom' : 'none'),
    cgv_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    cgv_captured_at: capturedAt,
  };
}

function resolveOrderTerms(snapshot, currentBrandText, currentGlobalText) {
  // Existing legacy orders have no snapshot and keep their previous rendering.
  // A snapshot containing an empty string must remain empty, even if the current
  // brand terms subsequently become non-empty.
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'cgv_text_snapshot')) {
    return String(snapshot.cgv_text_snapshot ?? '');
  }
  return currentBrandText || currentGlobalText || '';
}

module.exports = { buildTermsEvidence, resolveOrderTerms };
