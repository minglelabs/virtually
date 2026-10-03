'use strict';

// New names: an uploaded reference video (PATCH /api/animate/drivings/<id>) and a motion (PATCH /api/media/<id>).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAppServer } = require('../server');
const { DrivingStore } = require('../lib/animate/drivings');

test('a motion gets a new name; an empty name and an unknown id are refused', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-rename-'));
  const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dataDir, 'none.json'), animateMock: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
  const motion = await (await fetch(`${base}/api/upload?kind=motion&name=${encodeURIComponent('원영턴 (장원영).webm')}`, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: webm })).json();
  const patch = (id, body) => fetch(`${base}/api/media/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await patch(motion.id, { name: '  원영턴 ' })).status, 200);
  const library = await (await fetch(`${base}/api/library`)).json();
  assert.equal(library.motions.find(item => item.id === motion.id).name, '원영턴');
  assert.equal((await patch(motion.id, { name: ' ' })).status, 400);
  assert.equal((await patch('00000000-0000-4000-8000-000000000000', { name: 'x' })).status, 404);
});

test('DrivingStore.rename: an upload gets a new label that is kept; other ids are null', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-rename-d-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = 'up-00000000-0000-4000-8000-000000000001';
  const store = Object.create(DrivingStore.prototype);
  const written = [];
  Object.assign(store, { uploadsDir: dir, uploads: new Map([[id, { id, label: '춤선 (에스파 윈터)', ext: '.mp4' }]]), docs: { write: async (file, value) => { written.push([path.basename(file), value.label]); } } });
  assert.equal((await store.rename(id, ' 골반춤 ')).label, '골반춤');
  assert.deepEqual([store.uploads.get(id).label, written], ['골반춤', [['meta.json', '골반춤']]]);
  assert.equal(await store.rename('ex-nothing', 'x'), null);
  await assert.rejects(store.rename(id, '  '), { status: 400 });
});
