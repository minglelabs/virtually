'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createAppServer } = require('../server');

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
    assert.deepEqual(initial, { idle: null, motions: [] });

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
