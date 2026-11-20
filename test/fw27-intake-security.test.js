'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'infra', 'fw27-cargo-intake.ts'), 'utf8');

test('FW27 intake does not commit an Airtable webhook secret', () => {
  assert.doesNotMatch(source, /https:\/\/hooks\.airtable\.com\//i);
  assert.match(source, /Bun\.env\.FW27_AIRTABLE_WEBHOOK/);
});

test('FW27 intake restricts CORS origins to the official domain or explicitly configured preview', () => {
  assert.doesNotMatch(source, /\.endsWith\(["']\.cargo\.site["']\)/);
  assert.match(source, /editionsstandard\.com/);
  assert.match(source, /FW27_CARGO_PREVIEW_ORIGIN/);
});

test('FW27 intake has an upstream timeout and fails closed without a webhook', () => {
  assert.match(source, /AbortSignal\.timeout\(10000\)/);
  assert.match(source, /if \(!AIRTABLE_WEBHOOK\)/);
});
