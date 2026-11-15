'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform, pipeline } = require('node:stream');

// The combined cap applies while bytes are streaming, including chunked requests.
// No batch is held in RAM: individual files are kept on private, random temp paths.
const BULK_MAX_BYTES = 128 * 1024 * 1024;
const BULK_MAX_FILES = 80;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function sensibleDimensions(width, height) {
  return width > 0 && height > 0 && width <= 16000 && height <= 16000 && width * height <= 60000000;
}

function plausibleJpeg(buf) {
  if (buf.length < 24 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff ||
      buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return false;
  let offset = 2;
  let frame = false;
  while (offset + 4 <= buf.length) {
    if (buf[offset++] !== 0xff) return false;
    while (buf[offset] === 0xff) offset++;
    const marker = buf[offset++];
    if (marker === 0xda) return frame; // Start of entropy-coded scan
    if (marker === 0xd9) return frame;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return false;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buf.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 8 || !sensibleDimensions(buf.readUInt16BE(offset + 5), buf.readUInt16BE(offset + 3))) return false;
      frame = true;
    }
    offset += segmentLength;
  }
  return false;
}

// These are structural checks and type-matching, not an antivirus or a complete decoder.
// Cloudinary still decodes/transforms image content; no user bytes are executed by Node.
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.length > IMAGE_MAX_BYTES) return null;
  const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (buf.subarray(0, 8).equals(pngSignature)) {
    if (buf.length < 57 || buf.readUInt32BE(8) !== 13 || buf.toString('ascii', 12, 16) !== 'IHDR' ||
        !sensibleDimensions(buf.readUInt32BE(16), buf.readUInt32BE(20)) ||
        buf.readUInt32BE(buf.length - 12) !== 0 || buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') return null;
    return 'image/png';
  }
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    if (!sensibleDimensions(buf.readUInt16LE(6), buf.readUInt16LE(8)) || buf[buf.length - 1] !== 0x3b) return null;
    return 'image/gif';
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (buf.length < 24 || buf.readUInt32LE(4) + 8 !== buf.length ||
        !['VP8 ', 'VP8L', 'VP8X'].includes(kind)) return null;
    return 'image/webp';
  }
  if (plausibleJpeg(buf)) return 'image/jpeg';
  return null;
}

function validImage(buf, mime) {
  return IMAGE_MIMES.includes(mime) && sniffImageMime(buf) === mime;
}

function validPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 ||
      !/^%PDF-[12]\.[0-9]/.test(buf.toString('latin1', 0, 8))) return false;
  return /%%EOF\s*$/.test(buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1'));
}

function ensureState(req) {
  if (!req.bulkPhotoState) req.bulkPhotoState = { bytes: 0, paths: new Set() };
  return req.bulkPhotoState;
}

function createCappedDiskStorage(maxTotalBytes = BULK_MAX_BYTES) {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('Invalid bulk upload cap');
  return {
    _handleFile(req, file, callback) {
      const state = ensureState(req);
      const destination = path.join(os.tmpdir(), 'es-bulk-' + crypto.randomBytes(24).toString('hex'));
      state.paths.add(destination);
      let fileBytes = 0;
      const meter = new Transform({
        transform(chunk, encoding, next) {
          state.bytes += chunk.length;
          fileBytes += chunk.length;
          if (state.bytes > maxTotalBytes) {
            const error = new Error('Bulk photo upload exceeds combined file limit');
            error.code = 'LIMIT_BULK_TOTAL_SIZE';
            return next(error);
          }
          next(null, chunk);
        }
      });
      const destinationStream = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      pipeline(file.stream, meter, destinationStream, error => {
        if (error) return fs.rm(destination, { force: true }, () => callback(error));
        callback(null, { path: destination, size: fileBytes });
      });
    },
    _removeFile(req, file, callback) {
      if (!file.path) return callback(null);
      fs.rm(file.path, { force: true }, callback);
    }
  };
}

async function cleanupBulkFiles(req) {
  const paths = [...(req.bulkPhotoState?.paths || [])];
  await Promise.all(paths.map(p => fs.promises.rm(p, { force: true }).catch(() => {})));
  if (req.bulkPhotoState) req.bulkPhotoState.paths.clear();
}

module.exports = {
  BULK_MAX_BYTES, BULK_MAX_FILES, IMAGE_MAX_BYTES, IMAGE_MIMES,
  sniffImageMime, validImage, validPdf, createCappedDiskStorage, cleanupBulkFiles
};
