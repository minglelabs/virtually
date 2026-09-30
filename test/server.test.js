'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createAppServer, listenWithPortRotation, extForMime } = require('../server');

async function start(dataDir) {
  const server = await createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function requestWithHost(base, host) {
  const url = new URL('/api/library', base);
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: host } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

test('media library, triggers, byte ranges, and persistence', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-test-'));
  const first = await start(dataDir);
  try {
    const initial = await (await fetch(`${first.base}/api/library`)).json();
    // No photo on air: the legacy view (no idle = demo avatar, the motions without a photo).
    assert.deepEqual(initial, { idle: null, motions: [], character: null, photo: null });

    const demo = await fetch(`${first.base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo' }),
    });
    assert.equal(demo.status, 200);
    assert.equal((await demo.json()).seq, 1);

    const crossOrigin = await fetch(`${first.base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: JSON.stringify({ id: 'demo' }),
    });
    assert.equal(crossOrigin.status, 403);

    const crossSite = await fetch(`${first.base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ id: 'demo' }),
    });
    assert.equal(crossSite.status, 403);

    const wrongType = await fetch(`${first.base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: 'demo' }),
    });
    assert.equal(wrongType.status, 415);

    assert.equal(await requestWithHost(first.base, 'evil.example'), 403);

    const rejected = await fetch(`${first.base}/api/upload?kind=motion&name=bad&filename=bad.webm`, {
      method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: Buffer.from('not a webm'),
    });
    assert.equal(rejected.status, 415);

    const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
    const uploaded = await fetch(`${first.base}/api/upload?kind=motion&name=${encodeURIComponent('손 흔들기')}&filename=wave.webm`, {
      method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: fakeWebm,
    });
    assert.equal(uploaded.status, 201);
    const motion = await uploaded.json();
    assert.equal(motion.name, '손 흔들기');

    const ranged = await fetch(`${first.base}${motion.url}`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-3/12');
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), fakeWebm.subarray(0, 4));

    const triggered = await fetch(`${first.base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: motion.id }),
    });
    assert.equal(triggered.status, 200);
    assert.equal((await triggered.json()).seq, 2);
    await stop(first.server);

    const second = await start(dataDir);
    try {
      const restored = await (await fetch(`${second.base}/api/library`)).json();
      assert.equal(restored.motions[0].id, motion.id);
      const removed = await fetch(`${second.base}${motion.url}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.equal((await fetch(`${second.base}${motion.url}`)).status, 404);
    } finally {
      await stop(second.server);
    }
  } finally {
    if (first.server.listening) await stop(first.server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('SSE delivers a live play event to the overlay', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-events-'));
  const { server, base } = await start(dataDir);
  const stream = await fetch(`${base}/api/events`);
  const reader = stream.body.getReader();
  try {
    assert.equal(stream.status, 200);
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"type":"library"/);
    await fetch(`${base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo' }),
    });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /"type":"play"/);
    assert.match(next, /"id":"demo"/);
    await reader.cancel();
    const afterDisconnect = await fetch(`${base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo' }),
    });
    assert.equal(afterDisconnect.status, 200);
  } finally {
    await reader.cancel().catch(() => {});
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('SSE delivers an idle event after POST /api/idle', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-idle-'));
  const { server, base } = await start(dataDir);
  const stream = await fetch(`${base}/api/events`);
  const reader = stream.body.getReader();
  try {
    assert.equal(stream.status, 200);
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"type":"library"/);

    const wrongType = await fetch(`${base}/api/idle`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.equal(wrongType.status, 415);

    const crossOrigin = await fetch(`${base}/api/idle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}',
    });
    assert.equal(crossOrigin.status, 403);

    const idle = await fetch(`${base}/api/idle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(idle.status, 200);
    const result = await idle.json();
    assert.equal(result.ok, true);
    assert.equal(result.seq, 1);

    const next = new TextDecoder().decode((await reader.read()).value);
    const event = JSON.parse(next.replace(/^data: /, '').trim());
    assert.deepEqual(event, { type: 'idle', seq: 1 });

    // Shares the play sequence counter.
    const play = await fetch(`${base}/api/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo' }),
    });
    assert.equal((await play.json()).seq, 2);
  } finally {
    await reader.cancel().catch(() => {});
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('rotates to the next free port when the starting port is occupied', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-ports-'));
  const blocker = http.createServer((request, response) => response.end('occupied'));
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const startPort = blocker.address().port;
  const server = await createAppServer({ dataDir });
  try {
    if (startPort > 65525) return t.skip('No room to test ten consecutive ports.');
    await assert.rejects(
      listenWithPortRotation(server, { startPort, maxAttempts: 1 }),
      /No available port/
    );
    const selectedPort = await listenWithPortRotation(server, { startPort, maxAttempts: 10 });
    assert.ok(selectedPort > startPort);
    assert.equal((await fetch(`http://127.0.0.1:${selectedPort}/api/library`)).status, 200);
  } finally {
    if (server.listening) await stop(server);
    await stop(blocker);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('library media extensions come from one helper', () => {
  assert.equal(extForMime('video/webm'), '.webm');
  assert.equal(extForMime('video/mp4'), '.mp4');
  assert.equal(extForMime('image/png'), '.png');
  assert.equal(extForMime('image/webp'), '.webp');
});

test('pages: / is the character list, /broadcast the controller', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-pages-'));
  const { server, base } = await start(dataDir);
  const publicFile = name => fs.readFile(path.join(__dirname, '..', 'public', name));
  try {
    for (const [pathname, file, type] of [
      ['/', 'characters.html', 'text/html'], ['/broadcast', 'index.html', 'text/html'],
      ['/characters.js', 'characters.js', 'text/javascript'], ['/characters.css', 'characters.css', 'text/css'],
    ]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get('content-type'), new RegExp(`^${type}`), pathname);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await publicFile(file), pathname);
      assert.equal((await fetch(`${base}${pathname}`, { method: 'HEAD' })).status, 200, `HEAD ${pathname}`);
    }
  } finally {
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('an mp4 library motion is served, and deleting it removes the .mp4 file', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-test-'));
  const id = '0f0e0d0c-0b0a-4900-8800-706050403020';
  const bytes = Buffer.from('0000ftypisom-fake-mp4-body');
  await fs.mkdir(path.join(dataDir, 'media'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'media', `${id}.mp4`), bytes);
  await fs.writeFile(path.join(dataDir, 'library.json'), JSON.stringify({
    idle: null,
    motions: [{ id, name: 'mp4 motion', kind: 'motion', mime: 'video/mp4', url: `/api/media/${id}`, createdAt: new Date().toISOString() }],
  }));
  const { server, base } = await start(dataDir);
  try {
    const response = await fetch(`${base}/api/media/${id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const removed = await fetch(`${base}/api/media/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    await assert.rejects(fs.stat(path.join(dataDir, 'media', `${id}.mp4`)), { code: 'ENOENT' });
  } finally {
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// Yields parsed `data:` messages from an SSE response, one at a time.
function sseMessages(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  let buffered = '';
  return {
    async next() {
      while (!queue.length) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended');
        buffered += decoder.decode(value, { stream: true });
        const events = buffered.split('\n\n');
        buffered = events.pop();
        for (const event of events) if (event.startsWith('data: ')) queue.push(JSON.parse(event.slice(6)));
      }
      return queue.shift();
    },
    async nextOfType(type) {
      for (;;) {
        const message = await this.next();
        if (message.type === type) return message;
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

test('OBS source size: validation, persistence, and live + on-connect SSE delivery', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-obs-source-'));
  const post = (base, body, contentType = 'application/json') => fetch(`${base}/api/obs-source`, {
    method: 'POST', headers: { 'Content-Type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const first = await start(dataDir);
  try {
    assert.equal(await (await fetch(`${first.base}/api/obs-source`)).json(), null);

    const events = sseMessages(await fetch(`${first.base}/api/events`));
    assert.equal((await events.next()).type, 'library');
    assert.deepEqual(await events.next(), { type: 'obs-source', width: null, height: null });

    assert.equal((await post(first.base, { width: 800, height: 600 }, 'text/plain')).status, 415);
    for (const bad of [
      { width: 800 }, { width: 800.5, height: 600 }, { width: '800', height: 600 },
      { width: 15, height: 600 }, { width: 800, height: 8193 }, [], null,
    ]) {
      assert.equal((await post(first.base, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(first.base, 'not json')).status, 400);
    const crossOrigin = await fetch(`${first.base}/api/obs-source`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{"width":800,"height":600}',
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(await (await fetch(`${first.base}/api/obs-source`)).json(), null);

    const accepted = await post(first.base, { width: 800, height: 600 });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { width: 800, height: 600 });
    assert.deepEqual(await events.next(), { type: 'obs-source', width: 800, height: 600 });

    // Bounds are inclusive; the latest value wins.
    assert.equal((await post(first.base, { width: 16, height: 8192 })).status, 200);
    assert.deepEqual(await events.next(), { type: 'obs-source', width: 16, height: 8192 });
    assert.equal((await post(first.base, { width: 1600, height: 1080 })).status, 200);
    assert.deepEqual(await events.next(), { type: 'obs-source', width: 1600, height: 1080 });
    assert.deepEqual(await (await fetch(`${first.base}/api/obs-source`)).json(), { width: 1600, height: 1080 });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'obs-source.json'), 'utf8')), { width: 1600, height: 1080 });
    assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
    await events.cancel();
    await stop(first.server);

    // A new server instance on the same dataDir restores the value and sends it on connect.
    const second = await start(dataDir);
    try {
      assert.deepEqual(await (await fetch(`${second.base}/api/obs-source`)).json(), { width: 1600, height: 1080 });
      const again = sseMessages(await fetch(`${second.base}/api/events`));
      assert.deepEqual(await again.nextOfType('obs-source'), { type: 'obs-source', width: 1600, height: 1080 });
      await again.cancel();
    } finally {
      await stop(second.server);
    }
  } finally {
    if (first.server.listening) await stop(first.server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
