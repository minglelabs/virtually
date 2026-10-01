'use strict';

// Request helpers shared by server.js and the per-account workspaces
// (lib/workspace.js): JSON replies and bodies, upload streaming, range-aware
// media serving, and the media-file checks.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const { PHOTO_ID_RE } = require('./characters');

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// The one place a library item's file extension comes from (serve, delete and
// idle replacement all use it).
const EXT_BY_MIME = {
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'image/png': '.png',
  'image/webp': '.webp',
};

function extForMime(mime) {
  return EXT_BY_MIME[mime] || '.webm';
}

// Library item ids (motions, idles) are UUIDs; photo ids have their own pattern.
const MEDIA_ID_RE = /^[0-9a-f-]{36}$/;

// library.json `idles`: { <photoId>: idle item } uploaded for one photo.
// Anything malformed is dropped.
function parseIdles(value) {
  const idles = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return idles;
  for (const [photoId, item] of Object.entries(value)) {
    if (PHOTO_ID_RE.test(photoId) && item && typeof item === 'object' && typeof item.id === 'string' && MEDIA_ID_RE.test(item.id)) {
      idles[photoId] = item;
    }
  }
  return idles;
}

function requireJson(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('Expected application/json.'), { status: 415, code: 'expected_json' });
  }
}

// Bounds for the OBS browser-source size the overlay reports.
const OBS_SOURCE_MIN = 16;
const OBS_SOURCE_MAX = 8192;

function parseObsSource(value) {
  if (!value || typeof value !== 'object') return null;
  const valid = n => Number.isInteger(n) && n >= OBS_SOURCE_MIN && n <= OBS_SOURCE_MAX;
  if (!valid(value.width) || !valid(value.height)) return null;
  return { width: value.width, height: value.height };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function sanitizeName(value) {
  const cleaned = String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || 'Untitled motion';
}

function mediaType(kind, name, contentType) {
  const ext = path.extname(name).toLowerCase();
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  if (ext === '.webm' && (mime === 'video/webm' || mime === 'application/octet-stream' || !mime)) {
    return { ext: '.webm', mime: 'video/webm' };
  }
  if (kind === 'idle' && ext === '.png' && (mime === 'image/png' || mime === 'application/octet-stream' || !mime)) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (kind === 'idle' && ext === '.webp' && (mime === 'image/webp' || mime === 'application/octet-stream' || !mime)) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

async function hasExpectedSignature(filePath, ext) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (ext === '.webm') return bytesRead >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (ext === '.png') return bytesRead >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === '.webp') return bytesRead >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    return false;
  } finally {
    await handle.close();
  }
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function receiveFile(req, target, limit = MAX_UPLOAD_BYTES, tooLargeMessage = 'File exceeds 500 MB') {
  const output = fs.createWriteStream(target, { flags: 'wx' });
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        break;
      }
      if (!output.write(chunk)) await once(output, 'drain');
    }
    if (tooLarge) throw Object.assign(new Error(tooLargeMessage), { status: 413, code: 'too_large' });
    output.end();
    await once(output, 'finish');
    if (total === 0) throw Object.assign(new Error('Empty file'), { status: 400 });
  } catch (error) {
    output.destroy();
    await fsp.rm(target, { force: true });
    throw error;
  }
}

async function serveMedia(req, res, filePath, mime) {
  const stat = await fsp.stat(filePath);
  const range = req.headers.range;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    const end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const last = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${last}/${stat.size}`, 'Content-Length': last - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end: last }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

// serveMedia, answering 404 when the file itself is gone.
async function serveFile(req, res, filePath, mime) {
  try {
    await serveMedia(req, res, filePath, mime);
  } catch (error) {
    if (error.code !== 'ENOENT' || res.headersSent) throw error;
    sendJson(res, 404, { error: 'Media not found.' });
  }
}

module.exports = {
  MAX_UPLOAD_BYTES,
  EXT_BY_MIME,
  OBS_SOURCE_MIN,
  OBS_SOURCE_MAX,
  MEDIA_ID_RE,
  extForMime,
  parseIdles,
  requireJson,
  parseObsSource,
  sendJson,
  sanitizeName,
  mediaType,
  hasExpectedSignature,
  readBody,
  receiveFile,
  serveMedia,
  serveFile,
};
