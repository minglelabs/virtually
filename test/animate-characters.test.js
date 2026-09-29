'use strict';

// /api/animate/characters: the character library (upload, order, select,
// delete, legacy migration, legacy aliases) and its use by mock jobs.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const { compareRecords } = require('../lib/animate/characters');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function ffmpegAvailable() {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const skip = ffmpegAvailable() ? false : 'ffmpeg is not installed';

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: 'ignore' });
}

function makeImage(filePath, size) {
  ffmpeg(['-f', 'lavfi', '-i', `color=c=blue@0.5:s=${size}`, '-frames:v', '1', '-vf', 'format=rgba', filePath]);
}

async function makeFixtures() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-fixture-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  const c = path.join(dir, 'c.png');
  makeImage(a, '64x96');
  makeImage(b, '48x48');
  makeImage(c, '96x64');
  const clip = path.join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
  return { dir, a, b, c, clip };
}

async function start(dataDir) {
  const server = await createAppServer({
    dataDir, examplesManifestPath: path.join(dataDir, 'no-manifest.json'), animateMock: true, animatePollIntervalMs: 40,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function upload(base, name, filePath, pathname = '/api/animate/characters') {
  return fetch(`${base}${pathname}?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: fsSync.readFileSync(filePath),
  });
}

function post(base, pathname, body = {}) {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function list(base) {
  return (await fetch(`${base}/api/animate/characters`)).json();
}

async function waitForJob(base, id, states, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (states.includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('records order by lastSelectedAt desc, never-selected after them by createdAt desc', () => {
  const rows = [
    { id: 'n-old', createdAt: '2026-01-01T00:00:00.000Z', lastSelectedAt: null },
    { id: 's-old', createdAt: '2026-01-05T00:00:00.000Z', lastSelectedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'n-new', createdAt: '2026-01-03T00:00:00.000Z', lastSelectedAt: null },
    { id: 's-new', createdAt: '2026-01-02T00:00:00.000Z', lastSelectedAt: '2026-03-01T00:00:00.000Z' },
  ];
  assert.deepEqual(rows.sort(compareRecords).map(row => row.id), ['s-new', 's-old', 'n-new', 'n-old']);
});

test('character library: upload, order, select, delete, bad ids and image serving', { skip }, async () => {
  const fixtures = await makeFixtures();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-'));
  const app = await start(dataDir);
  try {
    assert.deepEqual(await list(app.base), { characters: [], selectedId: null });

    // Each upload becomes the selected one and moves to the front.
    let response = await upload(app.base, 'a.png', fixtures.a);
    assert.equal(response.status, 201);
    const first = await response.json();
    assert.match(first.character.id, /^ch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(first.selectedId, first.character.id);
    assert.deepEqual(Object.keys(first.character).sort(),
      ['createdAt', 'filename', 'hasAlpha', 'height', 'id', 'lastSelectedAt', 'selected', 'url', 'width']);
    assert.equal(first.character.url, `/api/animate/characters/${first.character.id}/image`);
    assert.equal(first.character.width, 64);
    assert.equal(first.character.height, 96);
    assert.equal(first.character.hasAlpha, true);
    assert.equal(first.character.selected, true);
    const a = first.character.id;
    const b = (await (await upload(app.base, 'b.png', fixtures.b)).json()).character.id;
    const third = await (await upload(app.base, 'c.png', fixtures.c)).json();
    const c = third.character.id;
    assert.deepEqual(third.characters.map(item => item.id), [c, b, a]);
    assert.equal(third.selectedId, c);
    assert.deepEqual(third.characters.map(item => item.selected), [true, false, false]);

    // Files and the index are on disk.
    const dir = path.join(dataDir, 'animate', 'characters');
    const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(index.selectedId, c);
    assert.equal(index.items.length, 3);
    assert.ok(fsSync.existsSync(path.join(dir, `${a}.png`)));

    // Select moves an item to the front.
    response = await fetch(`${app.base}/api/animate/characters/${a}/select`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(response.status, 415);
    response = await post(app.base, `/api/animate/characters/${a}/select`);
    assert.equal(response.status, 200);
    let data = await response.json();
    assert.equal(data.selectedId, a);
    assert.deepEqual(data.characters.map(item => item.id), [a, c, b]);
    assert.ok(Date.parse(data.characters[0].lastSelectedAt) > Date.parse(data.characters[1].lastSelectedAt));
    assert.deepEqual((await list(app.base)).characters.map(item => item.id), [a, c, b]);

    // Status reports the selected character.
    let status = await (await fetch(`${app.base}/api/animate/status`)).json();
    assert.deepEqual(status.character, {
      source: 'upload', id: a, filename: 'a.png', width: 64, height: 96, hasAlpha: true, url: `/api/animate/characters/${a}/image`,
    });

    // Image serving.
    response = await fetch(`${app.base}/api/animate/characters/${b}/image`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fsSync.readFileSync(fixtures.b));
    response = await fetch(`${app.base}/api/animate/characters/${b}/image`, { method: 'HEAD' });
    assert.equal(response.status, 200);

    // Unknown and malformed ids are 404 and never touch the file system.
    const decoy = path.join(dataDir, 'animate', 'decoy.png');
    await fs.writeFile(decoy, 'keep me');
    const unknown = 'ch-00000000-0000-0000-0000-000000000000';
    for (const bad of [unknown, 'ch-..%2Fdecoy', '..%2Fdecoy', 'decoy', `${a}x`, 'CH-' + a.slice(3)]) {
      for (const [method, sub] of [['POST', '/select'], ['DELETE', ''], ['GET', '/image']]) {
        response = method === 'POST'
          ? await post(app.base, `/api/animate/characters/${bad}${sub}`)
          : await fetch(`${app.base}/api/animate/characters/${bad}${sub}`, { method });
        assert.equal(response.status, 404, `${method} ${bad}${sub}`);
        assert.equal((await response.json()).code, 'character_missing', `${method} ${bad}${sub}`);
      }
    }
    assert.equal(await fs.readFile(decoy, 'utf8'), 'keep me');
    assert.equal((await list(app.base)).characters.length, 3);

    // Non-images are refused by signature.
    response = await fetch(`${app.base}/api/animate/characters?name=x.png`, { method: 'POST', body: Buffer.from('not an image at all') });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'unsupported_type');
    assert.equal((await list(app.base)).characters.length, 3);

    // Deleting the selected one selects the next most recently selected.
    response = await fetch(`${app.base}/api/animate/characters/${a}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    data = await response.json();
    assert.equal(data.selectedId, c);
    assert.deepEqual(data.characters.map(item => item.id), [c, b]);
    assert.equal(data.characters[0].selected, true);
    assert.equal(fsSync.existsSync(path.join(dir, `${a}.png`)), false);

    // Deleting a non-selected one keeps the selection.
    data = await (await fetch(`${app.base}/api/animate/characters/${b}`, { method: 'DELETE' })).json();
    assert.equal(data.selectedId, c);
    data = await (await fetch(`${app.base}/api/animate/characters/${c}`, { method: 'DELETE' })).json();
    assert.deepEqual(data, { characters: [], selectedId: null });
    status = await (await fetch(`${app.base}/api/animate/status`)).json();
    assert.equal(status.character, null);
  } finally {
    await stop(app.server);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(fixtures.dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the selection survives a restart', { skip }, async () => {
  const fixtures = await makeFixtures();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-'));
  let app = await start(dataDir);
  let a;
  let b;
  try {
    a = (await (await upload(app.base, 'a.png', fixtures.a)).json()).character.id;
    b = (await (await upload(app.base, 'b.png', fixtures.b)).json()).character.id;
    await post(app.base, `/api/animate/characters/${a}/select`);
  } finally {
    await stop(app.server);
  }
  app = await start(dataDir);
  try {
    const data = await list(app.base);
    assert.equal(data.selectedId, a);
    assert.deepEqual(data.characters.map(item => item.id), [a, b]);
  } finally {
    await stop(app.server);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(fixtures.dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a legacy single character is migrated into the library', { skip }, async () => {
  const fixtures = await makeFixtures();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-'));
  const animateDir = path.join(dataDir, 'animate');
  await fs.mkdir(animateDir, { recursive: true });
  await fs.copyFile(fixtures.a, path.join(animateDir, 'character.png'));
  await fs.writeFile(path.join(animateDir, 'character.json'), JSON.stringify({
    ext: '.png', filename: 'old hero.png', width: 64, height: 96, hasAlpha: true, uploadedAt: '2026-09-01T00:00:00.000Z',
  }));
  const app = await start(dataDir);
  try {
    const data = await list(app.base);
    assert.equal(data.characters.length, 1);
    const item = data.characters[0];
    assert.equal(data.selectedId, item.id);
    assert.equal(item.selected, true);
    assert.equal(item.filename, 'old hero.png');
    assert.equal(item.width, 64);
    assert.equal(item.createdAt, '2026-09-01T00:00:00.000Z');
    assert.ok(item.lastSelectedAt);
    assert.equal(fsSync.existsSync(path.join(animateDir, 'character.json')), false);
    assert.equal(fsSync.existsSync(path.join(animateDir, 'character.png')), false);
    assert.ok(fsSync.existsSync(path.join(animateDir, 'characters', `${item.id}.png`)));
    const response = await fetch(`${app.base}${item.url}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fsSync.readFileSync(fixtures.a));
  } finally {
    await stop(app.server);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(fixtures.dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('legacy aliases act on the selected character', { skip }, async () => {
  const fixtures = await makeFixtures();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-'));
  const app = await start(dataDir);
  try {
    let response = await upload(app.base, 'a.png', fixtures.a, '/api/animate/character');
    assert.equal(response.status, 201);
    const legacy = await response.json();
    assert.equal(legacy.source, 'upload');
    assert.equal(legacy.filename, 'a.png');
    const b = (await (await upload(app.base, 'b.png', fixtures.b)).json()).character.id;

    response = await fetch(`${app.base}/api/animate/character/image`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fsSync.readFileSync(fixtures.b));

    // DELETE /api/animate/character removes the selected one only.
    response = await fetch(`${app.base}/api/animate/character`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    const after = await response.json();
    assert.equal(after.character.id, legacy.id);
    const data = await list(app.base);
    assert.deepEqual(data.characters.map(item => item.id), [legacy.id]);
    assert.ok(!data.characters.some(item => item.id === b));

    response = await fetch(`${app.base}/api/animate/character`, { method: 'DELETE' });
    assert.deepEqual(await response.json(), { character: null });
    response = await fetch(`${app.base}/api/animate/character/image`);
    assert.equal(response.status, 404);
  } finally {
    await stop(app.server);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(fixtures.dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a mock job uses the selected character and survives its deletion', { skip }, async () => {
  const fixtures = await makeFixtures();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-'));
  const app = await start(dataDir);
  try {
    const a = (await (await upload(app.base, 'a.png', fixtures.a)).json()).character.id;
    const c = (await (await upload(app.base, 'c.png', fixtures.c)).json()).character.id;
    await post(app.base, `/api/animate/characters/${a}/select`);
    const driving = await (await fetch(`${app.base}/api/animate/drivings?name=clip.mp4`, {
      method: 'POST', body: fsSync.readFileSync(fixtures.clip),
    })).json();

    let response = await post(app.base, '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', options: { delayMs: 600 } });
    assert.equal(response.status, 202);
    const created = (await response.json()).job;
    assert.equal(created.characterId, a);
    assert.equal(created.characterLabel, 'a.png');

    // Delete the character while the job runs; the job keeps its snapshot.
    response = await fetch(`${app.base}/api/animate/characters/${a}`, { method: 'DELETE' });
    assert.equal((await response.json()).selectedId, c);
    const done = await waitForJob(app.base, created.id, ['succeeded', 'failed']);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.characterId, a);
    assert.equal(done.result.width, 64);
    assert.equal(done.result.height, 96);

    // The next job uses the newly selected character.
    response = await post(app.base, '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo' });
    const next = await waitForJob(app.base, (await response.json()).job.id, ['succeeded', 'failed']);
    assert.equal(next.state, 'succeeded', JSON.stringify(next.error));
    assert.equal(next.characterId, c);
    assert.equal(next.result.width, 96);
    assert.equal(next.result.height, 64);
  } finally {
    await stop(app.server);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(fixtures.dir, { recursive: true, force: true }).catch(() => {});
  }
});
