const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../public/ordering-rules');

test('minimum steps use buyer overrides, including one and two', () => {
  for (const min of [1, 2, 3]) {
    assert.equal(rules.minimum({ min_per_reference: 3, min_per_reference_override: min }), min);
    assert.equal(rules.step(0, 1, min), min);
    assert.equal(rules.step(min, 1, min), min + 1);
    assert.equal(rules.step(min, -1, min), 0);
  }
});
test('identity preserves colors, inch sizes and delimiter characters', () => {
  assert.notEqual(rules.key('b', 'p', 'Gold', '7"'), rules.key('b', 'p', 'Silver', '7"'));
  assert.notEqual(rules.key('b', 'p', 'a|b', 'c'), rules.key('b', 'p', 'a', 'b|c'));
});
test('legacy cart migration preserves split references and adds only missing minimum', () => {
  const base = { brand_id: 'b', product_id: 'p', reference: 'R', color: 'Gold' };
  const brands = [{ id: 'b', min_per_reference: 3 }];
  const cart = rules.normalize({ old1: { ...base, size: '7"', qty: 2 }, old2: { ...base, size: '16-18"', qty: 1 } }, brands);
  assert.equal(Object.keys(cart).length, 2);
  assert.deepEqual(Object.values(cart).map(l => l.qty), [2, 1]);
  const stale = rules.normalize({ old: { ...base, size: '7"', qty: 1 }, invalid: null }, brands);
  assert.equal(Object.values(stale)[0].qty, 3);
  assert.deepEqual(rules.normalize(stale, brands), stale);
});
