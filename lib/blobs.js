'use strict';

// Durable copy of the media files in an S3-compatible bucket (Cloudflare R2).
//
// The server keeps working on local files (ffmpeg, streaming with ranges), so the
// local data directory stays the working copy and the bucket is its replica:
//   hydrate()  at start, downloads every object the disk does not have yet, so a new
//              container (a redeploy, an empty disk) comes back with all the media;
//   start()    then every few seconds uploads files that are new or changed and
//              removes objects whose file is gone;
//   flush()    does one such pass now (job results, shutdown).
// The object key is the file's path relative to the data directory.
//
// Not mirrored: auth/ and billing/ (secrets; their state lives in the database),
// the activity log, and anything still being written (*.tmp*). JSON records that the
// database holds are not on disk at all in that mode.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const EXCLUDED_DIRS = new Set(['auth', 'billing', 'activity']);
const SETTLE_MS = 1500; // a file modified more recently may still be written

// `rel` is a '/' path relative to the data directory.
function mirrored(rel) {
  const parts = rel.split('/');
  if (EXCLUDED_DIRS.has(parts[0])) return false;
  if (parts[0] === 'users' && parts.length > 2 && EXCLUDED_DIRS.has(parts[2])) return false;
  return !parts.some(part => part.includes('.tmp') || part.startsWith('.'));
}

function safeKey(key) {
  const parts = key.split('/');
  return Boolean(key) && !key.startsWith('/') && !parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\\'));
}

// --- stores: list() -> [{ key, size }], download(key, file), upload(key, file, size), remove(key) ---

function createMemoryStore() {
  const objects = new Map();
  return {
    kind: 'memory',
    objects,
    async list() { return [...objects].map(([key, buffer]) => ({ key, size: buffer.length })); },
    async download(key, file) {
      if (!objects.has(key)) throw new Error(`No such object: ${key}`);
      await fsp.writeFile(file, objects.get(key));
    },
    async upload(key, file) { objects.set(key, await fsp.readFile(file)); },
    async remove(key) { objects.delete(key); },
  };
}

function createS3Store({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    forcePathStyle: true,
    endpoint: endpoint || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // R2 does not take the SDK's default extra checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    kind: 's3',
    async list() {
      const out = [];
      let token;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const item of page.Contents || []) out.push({ key: item.Key, size: item.Size });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async download(key, file) {
      const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(Body, fs.createWriteStream(file));
    },
    async upload(key, file, size) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.createReadStream(file), ContentLength: size }));
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

// R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET all set -> R2; none -> null.
function storeFromEnv(env = process.env) {
  const names = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const present = names.filter(name => env[name]);
  if (!present.length) return null;
  if (present.length < names.length) throw new Error(`R2 needs all of ${names.join(', ')}; missing ${names.filter(name => !env[name]).join(', ')}.`);
  return createS3Store({
    accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT || undefined,
  });
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

async function* walk(dir, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (!mirrored(childRel)) continue;
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), childRel);
    else if (entry.isFile()) yield childRel;
  }
}

function createMirror({ root, store, log = () => {}, intervalMs = 5000, concurrency = 4, now = Date.now }) {
  const base = path.resolve(root);
  const known = new Map(); // key -> { size, mtimeMs } of the file as last made identical in the bucket
  let timer = null;
  let running = null;
  let closed = false;
  let hydrated = false;
  let lastProblem = null;

  async function hydrate() {
    const remote = (await store.list()).filter(item => mirrored(item.key) && safeKey(item.key));
    let downloaded = 0;
    await mapLimit(remote, concurrency, async ({ key, size }) => {
      const file = path.join(base, ...key.split('/'));
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat || stat.size !== size) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          await store.download(key, tmp);
          await fsp.rename(tmp, file);
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => {});
        }
        downloaded++;
      }
      const local = await fsp.stat(file);
      known.set(key, { size: local.size, mtimeMs: local.mtimeMs });
    });
    hydrated = true;
    if (remote.length) log(`[storage] ${remote.length} file(s) in the bucket, ${downloaded} restored to disk`);
  }

  // hydrate() that never throws: a bucket that cannot be read (wrong token, no access to the
  // bucket, R2 down) must not keep the server from starting. It works from the disk and tries
  // again on every pass. Nothing is uploaded or deleted until the bucket has been read once,
  // so a bucket that was only unreachable is never emptied or overwritten from a bare disk.
  async function tryHydrate() {
    try {
      await hydrate();
      if (lastProblem) log('[storage] the bucket is reachable again');
      lastProblem = null;
      return true;
    } catch (error) {
      const problem = `${error.name || 'Error'}: ${error.message}`;
      if (problem !== lastProblem) log(`[storage] CANNOT READ THE BUCKET (${problem}); running on the local disk only and retrying. Files are NOT being saved to R2 until this is fixed.`);
      lastProblem = problem;
      return false;
    }
  }

  async function pass({ force }) {
    if (!hydrated && !(await tryHydrate())) return;
    const seen = new Set();
    const uploads = [];
    for await (const rel of walk(base)) {
      seen.add(rel);
      const file = path.join(base, ...rel.split('/'));
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      if (!force && now() - stat.mtimeMs < SETTLE_MS) continue;
      const before = known.get(rel);
      if (before && before.size === stat.size && before.mtimeMs === stat.mtimeMs) continue;
      uploads.push({ rel, file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    // Objects whose file is gone (the app deleted it). The listing happened first, so
    // a file created meanwhile is simply not in `seen` and is never in `known` either.
    const gone = [...known.keys()].filter(key => !seen.has(key));
    // A data directory that looks empty is a problem with the disk, not a decision to delete everything.
    if (gone.length && !seen.size) {
      log(`[storage] the data directory looks empty; not removing ${gone.length} object(s) from the bucket`);
      gone.length = 0;
    }
    await mapLimit(uploads, concurrency, async item => {
      try {
        await store.upload(item.rel, item.file, item.size);
        known.set(item.rel, { size: item.size, mtimeMs: item.mtimeMs });
      } catch (error) {
        log(`[storage] upload of ${item.rel} failed (retried next pass): ${error.message}`);
      }
    });
    await mapLimit(gone, concurrency, async key => {
      try {
        await store.remove(key);
        known.delete(key);
      } catch (error) {
        log(`[storage] removing ${key} failed (retried next pass): ${error.message}`);
      }
    });
  }

  // One pass now; a pass already running is followed by another one, so the changes made
  // since it started are included when this resolves.
  function flush({ force = false } = {}) {
    if (running) {
      again = true;
      return running.then(() => flush({ force }));
    }
    running = pass({ force }).finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer || closed) return;
    timer = setInterval(() => { flush().catch(error => log(`[storage] sync failed: ${error.message}`)); }, intervalMs);
    timer.unref();
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    await flush({ force: true });
  }

  return { hydrate, tryHydrate, start, flush, close, known };
}

module.exports = { createMirror, createMemoryStore, createS3Store, storeFromEnv, mirrored, safeKey };
