// Tests unitaires purs (pas de serveur, pas de DB) pour lib/csv.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csvSafe, splitCSVLines, parseCSVRow, parsePrice } = require('../lib/csv');

test('csvSafe neutralise les déclencheurs de formule (OWASP CSV Injection)', () => {
  assert.equal(csvSafe('=cmd|/c calc'), "'=cmd|/c calc");
  assert.equal(csvSafe('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvSafe('\tformule'), "'\tformule");
});

test('csvSafe laisse intact un numéro de téléphone international (+ non piégé)', () => {
  assert.equal(csvSafe('+33 6 12 34 56 78'), '+33 6 12 34 56 78');
  assert.equal(csvSafe('-5'), '-5');
});

test('csvSafe gère null/undefined', () => {
  assert.equal(csvSafe(null), '');
  assert.equal(csvSafe(undefined), '');
});

test('splitCSVLines ignore les retours à la ligne à l\'intérieur d\'un champ quoté', () => {
  const text = 'a,b,c\n"multi\nligne",d,e\nf,g,h';
  const lines = splitCSVLines(text);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '"multi\nligne",d,e');
});

test('parseCSVRow gère les guillemets échappés ("")', () => {
  const fields = parseCSVRow('"Guillemet ""interne""",simple,"avec, virgule"');
  assert.deepEqual(fields, ['Guillemet "interne"', 'simple', 'avec, virgule']);
});

test('parseCSVRow gère une ligne simple sans guillemets', () => {
  assert.deepEqual(parseCSVRow('a,b,c'), ['a', 'b', 'c']);
});

test('parsePrice accepte le séparateur décimal virgule (format FR)', () => {
  assert.equal(parsePrice('12,50'), 12.5);
  assert.equal(parsePrice('1.234,56'), 1234.56);
});

test('parsePrice accepte le point et nettoie les symboles monétaires', () => {
  assert.equal(parsePrice('€ 32.00'), 32);
  assert.equal(parsePrice('$45.99'), 45.99);
});

test('parsePrice renvoie 0 pour une valeur invalide, vide ou négative', () => {
  assert.equal(parsePrice(''), 0);
  assert.equal(parsePrice(null), 0);
  assert.equal(parsePrice(undefined), 0);
  assert.equal(parsePrice('abc'), 0);
  assert.equal(parsePrice('-10'), 0);
});
