'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const {
  BULK_MAX_BYTES, BULK_MAX_FILES, IMAGE_MAX_BYTES,
  sniffImageMime, validImage, validPdf, createCappedDiskStorage, cleanupBulkFiles
} = require('../lib/upload-security');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACAUwAOw==', 'base64');

test('accepted image types must match the actual content, not the client MIME', () => {
  assert.equal(sniffImageMime(png), 'image/png');
  assert.equal(validImage(png, 'image/png'), true);
  assert.equal(validImage(png, 'image/jpeg'), false);
  assert.equal(validImage(gif, 'image/gif'), true);
  assert.equal(validImage(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png'), false);
  assert.equal(validImage(Buffer.concat([png, Buffer.from('<script>test</script>')]), 'image/png'), false);
  assert.equal(validImage(png.subarray(0, 20), 'image/png'), false);
  assert.equal(validImage(Buffer.concat([png, Buffer.alloc(IMAGE_MAX_BYTES)]), 'image/png'), false);
});

test('PDF checks reject a spoofed MIME, truncated file and HTML', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n', 'latin1');
  assert.equal(validPdf(pdf), true);
  assert.equal(validPdf(Buffer.from('%PDF-', 'latin1')), false);
  assert.equal(validPdf(Buffer.from('%PDF-1.7\n<script>bad</script>')), false);
  assert.equal(validPdf(Buffer.from('<!doctype html><title>fake</title>')), false);
});

function store(storage, req, content) {
  return new Promise((resolve, reject) => {
    storage._handleFile(req, {
      stream: Readable.from([content]),
      originalname: 'picture.png',
      mimetype: 'image/png'
    }, (error, file) => error ? reject(error) : resolve(file));
  });
}

test('bulk uploads enforce the combined streaming cap and remove temporary files', async () => {
  assert.equal(BULK_MAX_FILES, 80);
  assert.equal(BULK_MAX_BYTES, 128 * 1024 * 1024);
  const storage = createCappedDiskStorage(12);
  const req = {};
  try {
    const first = await store(storage, req, Buffer.alloc(8, 1));
    assert.equal(fs.existsSync(first.path), true);
    await assert.rejects(store(storage, req, Buffer.alloc(5, 2)), error => error.code === 'LIMIT_BULK_TOTAL_SIZE');
    assert.equal(req.bulkPhotoState.bytes, 13);
  } finally {
    await cleanupBulkFiles(req);
  }
  for (const name of req.bulkPhotoState.paths) assert.equal(fs.existsSync(name), false);
});
