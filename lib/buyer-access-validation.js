'use strict';

// Qualification de demandes d'acces B2B. Verifie les formats, pas l'existence du commerce.
function cleanWebsite(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  const supplied = value.trim();
  const asUrl = /^https?:\/\//i.test(supplied) ? supplied : 'https://' + supplied;
  try {
    const url = new URL(asUrl);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.includes('.')) return null;
    if (url.username || url.password || /\s/.test(supplied)) return null;
    return url.href;
  } catch (_) { return null; }
}

function cleanInstagram(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) return null;
  let handle = value.trim();
  if (/^https?:\/\//i.test(handle)) {
    try {
      const url = new URL(handle);
      if (!['instagram.com','www.instagram.com'].includes(url.hostname.toLowerCase())) return null;
      if (url.username || url.password || url.search || url.hash) return null;
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length !== 1) return null;
      handle = segments[0];
    } catch (_) { return null; }
  } else {
    handle = handle.replace(/^@/, '');
  }
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle) || handle.includes('..') || handle.endsWith('.')) return null;
  return handle.toLowerCase();
}

function validateBuyerAccessRequest(data) {
  if (typeof data.company !== 'string' || !data.company.trim()) {
    return { ok: false, error: 'Le nom de la boutique / societe est requis.' };
  }
  const website = cleanWebsite(data.website);
  if (!website) return { ok: false, error: 'Site internet requis : indiquez une URL valide (ex. https://boutique.fr).' };
  const instagram = cleanInstagram(data.instagram);
  if (!instagram) return { ok: false, error: 'Instagram requis : indiquez @compte ou instagram.com/compte.' };
  return { ok: true, company: data.company.trim(), website, instagram };
}

module.exports = { cleanWebsite, cleanInstagram, validateBuyerAccessRequest };
