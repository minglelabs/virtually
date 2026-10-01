'use strict';

// What the one-off scripts that move local files into the bucket share
// (scripts/archive-to-r2.js, scripts/import-to-account.js): walking a folder, content
// types, and an upload that is read back before it counts as stored.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CONTENT_TYPES = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function contentTypeOf(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function md5Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// Every file under a file or folder, sorted by name, without dot files (.DS_Store and friends).
async function* filesUnder(target) {
  const stat = await fsp.stat(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  const entries = await fsp.readdir(target, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) yield* filesUnder(child);
    else if (entry.isFile()) yield child;
  }
}

// What the bucket holds under `key` against a file of `size` bytes and MD5 `md5`:
// 'missing' | 'same' | 'differs'. A multipart ETag (it has a dash) is not an MD5; the size has to do then.
async function compareRemote(store, key, size, md5) {
  const remote = await store.head(key);
  if (!remote) return { state: 'missing', remote: null };
  const same = remote.size === size && (remote.etag.includes('-') || remote.etag === md5);
  return { state: same ? 'same' : 'differs', remote };
}

// Uploads, then reads the object back (size and MD5); throws when it does not match.
async function uploadVerified(store, key, file, size, md5) {
  await store.upload(key, file, size, contentTypeOf(file));
  const stored = await store.head(key);
  if (!stored || stored.size !== size || (!stored.etag.includes('-') && stored.etag !== md5)) {
    throw new Error('read back from the bucket, it differs from the file');
  }
}

module.exports = { contentTypeOf, md5Of, filesUnder, compareRemote, uploadVerified };
