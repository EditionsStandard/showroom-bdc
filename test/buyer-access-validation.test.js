'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanWebsite, cleanInstagram, validateBuyerAccessRequest } = require('../lib/buyer-access-validation');

test('website: URL http(s) normalisee, les schemas dangereux sont rejetes', () => {
  assert.equal(cleanWebsite('boutique.fr'), 'https://boutique.fr/');
  assert.equal(cleanWebsite('https://store.co.uk/shop'), 'https://store.co.uk/shop');
  for (const bad of ['', 'localhost', 'javascript:alert(1)', 'https://admin:secret@store.fr', 'ftp://store.fr']) {
    assert.equal(cleanWebsite(bad), null, bad);
  }
});

test('instagram: compte, arobase ou URL du profil seulement', () => {
  assert.equal(cleanInstagram('@Store.Paris'), 'store.paris');
  assert.equal(cleanInstagram('https://www.instagram.com/STORE/'), 'store');
  for (const bad of ['', 'a..b', 'bad handle', 'https://badinstagram.com/store', 'https://instagram.com/store/reels', 'https://instagram.com/store?x=1']) {
    assert.equal(cleanInstagram(bad), null, bad);
  }
});

test('une demande publique exige une boutique, un website et un Instagram', () => {
  const good = { company:'Sample Boutique', website:'sample.fr', instagram:'@sampleboutique' };
  assert.equal(validateBuyerAccessRequest(good).ok, true);
  for (const key of ['company','website','instagram']) {
    assert.equal(validateBuyerAccessRequest({ ...good, [key]: '' }).ok, false, key);
  }
});
