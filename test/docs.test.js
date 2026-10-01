'use strict';

// The JSON record store (lib/docs.js): one contract, two backends. The file
// backend always runs; the Postgres one runs when TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/vtest node --test test/docs.test.js

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { openDocs, createFileDocs } = require('../lib/docs');
const { createAppServer } = require('../server');

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-docs-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function clearDatabase() {
  const prepared = await openDocs({ databaseUrl: DATABASE_URL, root: os.tmpdir() }); // creates the schema
  await prepared.close();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query('truncate virtually.documents');
  await pool.end();
}

const backends = [['file', async () => { const root = await tempDir(); return { root, docs: createFileDocs() }; }]];
if (DATABASE_URL) {
  backends.push(['postgres', async () => {
    await clearDatabase();
    const root = await tempDir();
    const docs = await openDocs({ databaseUrl: DATABASE_URL, root });
    cleanups.push(() => docs.close());
    return { root, docs };
  }]);
}

for (const [name, make] of backends) {
  test(`${name}: write, read, replace and remove a record`, async () => {
    const { root, docs } = await make();
    const file = path.join(root, 'users', 'a', 'library.json');
    assert.equal(await docs.read(file), null);
    await docs.write(file, { motions: [1, 2], idle: null });
    assert.deepEqual(await docs.read(file), { motions: [1, 2], idle: null });
    await docs.write(file, { motions: [], idle: 'x' });
    assert.deepEqual(await docs.read(file), { motions: [], idle: 'x' });
    await docs.remove(file);
    assert.equal(await docs.read(file), null);
    await docs.remove(file); // a missing record is fine
  });

  test(`${name}: children lists the names directly under a path`, async () => {
    const { root, docs } = await make();
    await docs.write(path.join(root, 'users', 'u1', 'owner.json'), { sub: '1' });
    await docs.write(path.join(root, 'users', 'u1', 'library.json'), {});
    await docs.write(path.join(root, 'users', 'u2', 'owner.json'), { sub: '2' });
    await docs.write(path.join(root, 'users2', 'zzz', 'owner.json'), { sub: '3' });
    assert.deepEqual((await docs.children(path.join(root, 'users'))).sort(), ['u1', 'u2']);
    assert.deepEqual(await docs.children(path.join(root, 'none')), []);
  });

  test(`${name}: concurrent writes to different records do not mix`, async () => {
    const { root, docs } = await make();
    await Promise.all(Array.from({ length: 20 }, (_, i) => docs.write(path.join(root, `r${i}.json`), { i })));
    for (let i = 0; i < 20; i++) assert.deepEqual(await docs.read(path.join(root, `r${i}.json`)), { i });
  });
}

test('file: a private record is 0600 in a 0700 directory, and bad JSON throws', async () => {
  const root = await tempDir();
  const docs = createFileDocs();
  const file = path.join(root, 'auth', 'state.json');
  await docs.write(file, { a: 1 }, { private: true });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  await fs.writeFile(file, '{not json');
  await assert.rejects(() => docs.read(file), SyntaxError);
});

test('without DATABASE_URL the store is files', async () => {
  const docs = await openDocs({ databaseUrl: '', root: os.tmpdir() });
  assert.equal(docs.kind, 'file');
});

if (DATABASE_URL) {
  test('postgres: a record outside the data directory is refused', async () => {
    const { root, docs } = await backends[1][1]();
    await assert.rejects(() => docs.read(path.join(root, '..', 'escape.json')), /Not under the data directory/);
  });

  test('postgres: accounts, characters and OBS size survive a restart on a different, empty disk', async () => {
    await clearDatabase();
    const dir1 = await tempDir();
    const server1 = await createAppServer({ dataDir: dir1, docs: await openDocs({ databaseUrl: DATABASE_URL, root: dir1 }) });
    await new Promise(resolve => server1.listen(0, '127.0.0.1', resolve));
    const post = (server, body) => fetch(`http://127.0.0.1:${server.address().port}/api/obs-source`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post(server1, { width: 1280, height: 720 })).status, 200);
    await new Promise(resolve => server1.close(resolve));

    // New process, new empty data directory: the OBS size comes back from the database.
    const dir2 = await tempDir();
    const server2 = await createAppServer({ dataDir: dir2, docs: await openDocs({ databaseUrl: DATABASE_URL, root: dir2 }) });
    await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${server2.address().port}/api/obs-source`);
    assert.deepEqual(await res.json(), { width: 1280, height: 720 });
    await new Promise(resolve => server2.close(resolve));
  });
}

test('media written under a data directory comes back on an empty one (R2 mirror, in memory)', async () => {
  const { createMemoryStore } = require('../lib/blobs');
  const store = createMemoryStore();
  const dir1 = await tempDir();
  const server1 = await createAppServer({ dataDir: dir1, blobs: store });
  await fs.mkdir(path.join(dir1, 'media'), { recursive: true });
  await fs.writeFile(path.join(dir1, 'media', 'clip.mp4'), 'video bytes');
  await new Promise(resolve => server1.close(resolve)); // closing makes the final upload
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(store.objects.has('media/clip.mp4'));

  const dir2 = await tempDir();
  const server2 = await createAppServer({ dataDir: dir2, blobs: store });
  assert.equal(await fs.readFile(path.join(dir2, 'media', 'clip.mp4'), 'utf8'), 'video bytes');
  await new Promise(resolve => server2.close(resolve));
});
