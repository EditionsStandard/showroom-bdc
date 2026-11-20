'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const pkg = require('../package.json');

test('uploads depend on patched Multer and exports on publisher-patched SheetJS', () => {
  assert.equal(require('multer/package.json').version, '2.5.0');
  assert.equal(XLSX.version, '0.20.3');
  assert.equal(pkg.dependencies.xlsx, 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
});

test('Multer 2.5 memory upload accepts a valid file and rejects oversized data', async () => {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5, files: 1 } });
  app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ name: req.file?.originalname, size: req.file?.size, content: req.file?.buffer.toString('utf8') });
  });
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: error.code });
    }
    return res.status(500).json({ error: 'upload_failure' });
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/upload';
    const send = (content) => {
      const body = new FormData();
      body.append('file', new Blob([content]), 'collection.txt');
      return fetch(endpoint, { method: 'POST', body });
    };
    const ok = await send('OK');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { name: 'collection.txt', size: 2, content: 'OK' });
    const large = await send('123456789');
    assert.equal(large.status, 413);
    assert.equal((await large.json()).error, 'LIMIT_FILE_SIZE');
  } finally {
    await new Promise((resolve,reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('SheetJS 0.20.3 still generates parseable order and product Excel exports', () => {
  for (const [name, rows] of [
    ['Commandes', [{ Numero: 'AW27-001', Acheteur: 'Test buyer', Total_HT: 1250.50 }]],
    ['Produits', [{ Reference: 'VD-001', Description: 'Cotton trousers', Prix_wholesale: 120 }]]
  ]) {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name);
    const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    assert.equal(bytes.subarray(0,2).toString(), 'PK', 'Excel workbook is a ZIP archive');
    const decoded = XLSX.read(bytes, { type: 'buffer' });
    assert.deepEqual(XLSX.utils.sheet_to_json(decoded.Sheets[name]), rows);
  }
});
