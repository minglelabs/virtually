'use strict';

// The media mirror (lib/blobs.js) against an in-memory bucket.

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createMirror, createMemoryStore, mirrored, safeKey, storeFromEnv } = require('../lib/blobs');

const dirs = [];
after(async () => { for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }); });
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-blobs-'));
  dirs.push(dir);
  return dir;
}
async function put(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
const get = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8').catch(() => null);

test('mirrored: media yes; secrets, the activity log and unfinished files no', () => {
  for (const rel of ['media/a.mp4', 'characters/photos/p.png', 'users/u1/animate/jobs/j/result.mp4', 'users/u1/media/m.webm']) assert.equal(mirrored(rel), true, rel);
  for (const rel of ['auth/config.json', 'billing/ledger.json', 'activity/events.jsonl', 'users/u1/auth/state.json', 'media/a.mp4.1234.tmp',
    'users/u1/media/motion-upload.x.tmp/upload', '.DS_Store']) assert.equal(mirrored(rel), false, rel);
});

test('safeKey refuses keys that could leave the data directory', () => {
  assert.equal(safeKey('media/a.mp4'), true);
  for (const key of ['../x', 'a/../../x', '/etc/passwd', 'a//b', '']) assert.equal(safeKey(key), false, key);
});

test('new and changed files are uploaded, deleted ones removed', async () => {
  const root = await tempDir();
  const store = createMemoryStore();
  const mirror = createMirror({ root, store });
  await put(root, 'media/a.mp4', 'one');
  await put(root, 'auth/config.json', 'secret');
  await mirror.flush({ force: true });
  assert.deepEqual([...store.objects.keys()], ['media/a.mp4']);

  await put(root, 'media/a.mp4', 'one-changed');
  await put(root, 'media/b.mp4', 'two');
  await mirror.flush({ force: true });
  assert.equal(store.objects.get('media/a.mp4').toString(), 'one-changed');
  assert.equal(store.objects.size, 2);

  await fs.rm(path.join(root, 'media', 'a.mp4'));
  await mirror.flush({ force: true });
  assert.deepEqual([...store.objects.keys()], ['media/b.mp4']);
});

test('a file that is still being written waits for the next pass', async () => {
  const root = await tempDir();
  const store = createMemoryStore();
  let clock = Date.now();
  const mirror = createMirror({ root, store, now: () => clock });
  await put(root, 'media/new.mp4', 'x');
  await mirror.flush();
  assert.equal(store.objects.size, 0);
  clock += 5000;
  await mirror.flush();
  assert.equal(store.objects.size, 1);
});

test('a new empty disk gets every file back, and then does not delete them', async () => {
  const store = createMemoryStore();
  const first = await tempDir();
  const one = createMirror({ root: first, store });
  await put(first, 'media/a.mp4', 'video');
  await put(first, 'users/u1/characters/photos/p.png', 'png');
  await one.flush({ force: true });

  const second = await tempDir(); // the container was replaced
  const logs = [];
  const two = createMirror({ root: second, store, log: message => logs.push(message) });
  await two.hydrate();
  assert.equal(await get(second, 'media/a.mp4'), 'video');
  assert.equal(await get(second, 'users/u1/characters/photos/p.png'), 'png');
  await two.flush({ force: true });
  assert.equal(store.objects.size, 2);

  // The disk losing its files is not a decision to delete the bucket's.
  await fs.rm(second, { recursive: true, force: true });
  await two.flush({ force: true });
  assert.equal(store.objects.size, 2);
  assert.ok(logs.some(line => line.includes('looks empty')));
});

test('hydrate ignores keys outside the data directory and keeps a file that already matches', async () => {
  const store = createMemoryStore();
  store.objects.set('../escape.txt', Buffer.from('x'));
  store.objects.set('media/keep.mp4', Buffer.from('abc'));
  const root = await tempDir();
  await put(root, 'media/keep.mp4', 'xyz'); // same size: not downloaded again
  await createMirror({ root, store }).hydrate();
  assert.equal(await get(root, 'media/keep.mp4'), 'xyz');
  assert.equal(await get(path.dirname(root), 'escape.txt'), null);
});

test('storeFromEnv: nothing set is off, a partial set is an error', () => {
  assert.equal(storeFromEnv({}), null);
  assert.throws(() => storeFromEnv({ R2_BUCKET: 'b' }), /missing R2_ACCOUNT_ID/);
  assert.equal(storeFromEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' }).kind, 's3');
});

test('the S3 store talks to an S3-style endpoint: list, upload, download, remove', async () => {
  const http = require('node:http');
  const objects = new Map();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    seen.push(`${req.method} ${url.pathname}`);
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const body = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${[...objects].map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join('')}</ListBucketResult>`;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(body);
    }
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      // aws-chunked framing is not used: the store sends the body as is with a content-length.
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"x"' });
      return res.end();
    }
    if (req.method === 'GET') {
      if (!objects.has(key)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-length': objects.get(key).length });
      return res.end(objects.get(key));
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(400);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { createS3Store } = require('../lib/blobs');
    const store = createS3Store({
      accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'bkt', endpoint: `http://127.0.0.1:${server.address().port}`,
    });
    const root = await tempDir();
    await put(root, 'media/a.mp4', 'hello bucket');
    await store.upload('media/a.mp4', path.join(root, 'media', 'a.mp4'), 12);
    assert.equal(objects.get('media/a.mp4').toString(), 'hello bucket');
    assert.deepEqual(await store.list(), [{ key: 'media/a.mp4', size: 12 }]);
    await store.download('media/a.mp4', path.join(root, 'copy'));
    assert.equal(await get(root, 'copy'), 'hello bucket');
    await store.remove('media/a.mp4');
    assert.equal(objects.size, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
