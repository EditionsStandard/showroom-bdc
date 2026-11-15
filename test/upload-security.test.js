'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const Jimp = require('jimp');
const {
  isVerifiedImage, isVerifiedPdf, createBoundedDiskStorage, removeTemporaryFiles,
  MAX_BULK_BYTES
} = require('../lib/upload-security');

async function imageFixture(mime) {
  const image = new Jimp(3, 2, 0xff8844ff);
  return image.getBufferAsync(mime);
}

test('accepts decodable JPEG and PNG with their real MIME type', async () => {
  const png = await imageFixture(Jimp.MIME_PNG);
  const jpeg = await imageFixture(Jimp.MIME_JPEG);
  assert.equal(await isVerifiedImage(png, 'image/png'), true);
  assert.equal(await isVerifiedImage(jpeg, 'image/jpeg'), true);
});

test('rejects fake MIME and files that merely imitate a signature', async () => {
  const png = await imageFixture(Jimp.MIME_PNG);
  assert.equal(await isVerifiedImage(png, 'image/jpeg'), false);
  assert.equal(await isVerifiedImage(Buffer.from('<script>alert(1)</script>'), 'image/png'), false);
  assert.equal(await isVerifiedImage(png.subarray(0, 36), 'image/png'), false);
});

test('rejects oversized image dimensions before decoding', async () => {
  const png = Buffer.from(await imageFixture(Jimp.MIME_PNG));
  png.writeUInt32BE(12000, 16);
  png.writeUInt32BE(12000, 20);
  assert.equal(await isVerifiedImage(png, 'image/png'), false);
});

test('rejects PDFs without complete headers and end markers', () => {
  const good = Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n');
  assert.equal(isVerifiedPdf(good), true);
  assert.equal(isVerifiedPdf(Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n')), false);
  assert.equal(isVerifiedPdf(Buffer.from('GIF89a' + good.toString())), false);
});

function store(storage, request, data) {
  return new Promise((resolve, reject) => {
    storage._handleFile(request, {
      fieldname: 'photos',
      originalname: 'item.png',
      stream: Readable.from([data])
    }, (err, info) => err ? reject(err) : resolve(info));
  });
}

test('batch storage is private on disk, has an aggregate cap and cleans temporary files', async () => {
  assert.equal(MAX_BULK_BYTES, 80 * 1024 * 1024);
  const storage = createBoundedDiskStorage({ maxTotalBytes: 12 });
  const request = {};
  const first = await store(storage, request, Buffer.alloc(8));
  assert.equal(fs.statSync(first.path).size, 8);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  try {
    await assert.rejects(store(storage, request, Buffer.alloc(8)), error => error.code === 'LIMIT_FILE_SIZE');
    assert.equal(request.__bulkUploadedBytes, 16);
  } finally {
    await removeTemporaryFiles([first]);
  }
  assert.equal(fs.existsSync(first.path), false);
});
