'use strict';

// Upload security shared by staff product photos and buyer/staff messages.
// The MIME sent by a browser is NOT proof of the file type.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream');
const multer = require('multer');
const fileType = require('file-type');
const Jimp = require('jimp');

const IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_PIXELS = 30_000_000;
const MAX_IMAGE_EDGE = 12_000;
const MAX_BULK_BYTES = 80 * 1024 * 1024;

function readJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (segmentLength < 7) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes) {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const totalSize = bytes.readUInt32LE(4) + 8;
  if (totalSize !== bytes.length) return null;
  let offset = 12;
  let mainType = '';
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length || end <= offset) return null;
    if (!mainType && ['VP8 ', 'VP8L', 'VP8X'].includes(type)) mainType = type;
    offset = end;
  }
  if (offset !== bytes.length) return null;
  const type = bytes.toString('ascii', 12, 16);
  if (type !== mainType) return null;
  if (type === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3)
    };
  }
  if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
      height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10))
    };
  }
  if (type === 'VP8 ' && bytes.length >= 30 &&
      bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function hasCompletePngStructure(bytes) {
  // Do not accept a PNG with only IHDR or a truncated IDAT. Require the
  // complete PNG chunk chain, containing IDAT and a final zero-length IEND.
  if (bytes.length < 45 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') return false;
  let offset = 8;
  let seenIdat = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunk = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length || end <= offset) return false;
    if (offset === 8 && (chunk !== 'IHDR' || length !== 13)) return false;
    if (chunk === 'IDAT') seenIdat = true;
    if (chunk === 'IEND') return length === 0 && seenIdat && end === bytes.length;
    offset = end;
  }
  return false;
}

function imageDimensions(bytes, mime) {
  if (mime === 'image/png') {
    if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === 'image/gif') {
    if (bytes.length < 13 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return null;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mime === 'image/webp') return readWebpDimensions(bytes);
  if (mime === 'image/jpeg') return readJpegDimensions(bytes);
  return null;
}

async function isVerifiedImage(bytes, declaredMime) {
  if (!Buffer.isBuffer(bytes) || !IMAGE_MIMES.includes(declaredMime) || bytes.length < 16) return false;
  try {
    const detected = await fileType.fromBuffer(bytes);
    if (!detected || detected.mime !== declaredMime) return false;
    if (detected.mime === 'image/png' && !hasCompletePngStructure(bytes)) return false;
    if (detected.mime === 'image/jpeg' && (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)) return false;
    if (detected.mime === 'image/gif' && bytes[bytes.length - 1] !== 0x3b) return false;
    const dimensions = imageDimensions(bytes, detected.mime);
    if (!dimensions || !dimensions.width || !dimensions.height ||
        dimensions.width > MAX_IMAGE_EDGE || dimensions.height > MAX_IMAGE_EDGE ||
        dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) return false;
    // Decode JPEG/PNG/GIF, rather than trusting a magic-byte header alone.
    // Jimp does not support WebP. WebP's RIFF/chunk structure is checked above;
    // Cloudinary must successfully decode that image before its URL is stored.
    if (detected.mime !== 'image/webp') {
      const decoded = await Jimp.read(bytes);
      if (!decoded || decoded.bitmap.width !== dimensions.width ||
          decoded.bitmap.height !== dimensions.height) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function isVerifiedPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 ||
      !/^%PDF-[12]\.[0-9]/.test(bytes.toString('latin1', 0, 8))) return false;
  return bytes.lastIndexOf(Buffer.from('%%EOF')) >= Math.max(0, bytes.length - 4096);
}

// Disk-backed Multer storage: no 80 * 10MB request buffer in the Node heap.
// A shared counter caps the entire multipart upload, even if parts overlap.
function createBoundedDiskStorage({ maxTotalBytes = MAX_BULK_BYTES, tempDir = os.tmpdir() } = {}) {
  return {
    _handleFile(req, file, cb) {
      const destination = path.join(tempDir, 'showroom-photo-' + crypto.randomBytes(16).toString('hex'));
      const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      const onData = chunk => {
        req.__bulkUploadedBytes = (req.__bulkUploadedBytes || 0) + chunk.length;
        if (req.__bulkUploadedBytes > maxTotalBytes) {
          const error = new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname);
          error.message = 'Taille totale du lot de photos dépassée';
          file.stream.destroy(error);
        }
      };
      file.stream.on('data', onData);
      pipeline(file.stream, output, err => {
        file.stream.removeListener('data', onData);
        if (err) return fs.unlink(destination, () => cb(err));
        cb(null, { path: destination, size: output.bytesWritten });
      });
    },
    _removeFile(_req, file, cb) {
      if (!file.path) return cb(null);
      fs.unlink(file.path, err => cb(err && err.code !== 'ENOENT' ? err : null));
    }
  };
}

async function removeTemporaryFiles(files) {
  await Promise.allSettled((files || []).filter(file => file.path).map(file => fs.promises.unlink(file.path)));
}

module.exports = {
  IMAGE_MIMES, MAX_BULK_BYTES, isVerifiedImage, isVerifiedPdf,
  createBoundedDiskStorage, removeTemporaryFiles
};
