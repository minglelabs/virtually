'use strict';

// scripts/import-to-account.js: a local workspace moved into a signed-in account, then
// seen through that account's own API.

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const H = require('./helpers/billing-server');
const { createFileDocs } = require('../lib/docs');
const { createMemoryStore } = require('../lib/blobs');
const { importToAccount, findAccount, parseArgs } = require('../scripts/import-to-account');

const dirs = [];
after(async () => { for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JOB = '0ab6d3c8-2858-47d2-b913-af034dea727a';
const DRIVING = 'up-2f83a0ea-6dc9-42fa-9c6c-c3208930808e';
const MOTION = '35e3fab3-8313-4f20-a1e9-d28355893794';
const PHOTO = 'ch-5fd97138-5d5e-4dd0-b04b-5ecc6525e413';

// A login-off data directory with one of everything.
async function localWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-import-src-'));
  dirs.push(root);
  const put = async (rel, content) => {
    const file = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  };
  await put('characters/index.json', {
    v: 1, activePhotoId: PHOTO,
    characters: [{ id: 'c-70437674-a955-496c-8a39-d5c9f52c2fe5', name: '캐릭터 1', createdAt: '2026-09-30T00:00:00.000Z', basePhotoId: PHOTO, photos: [{ id: PHOTO, filename: 'a.png', mime: 'image/png', width: 1, height: 1, hasAlpha: false, createdAt: '2026-09-30T00:00:00.000Z', fit: null }] }],
  });
  await put(`characters/photos/${PHOTO}.png`, PNG);
  await put('library.json', { idle: null, idles: {}, motions: [{ id: MOTION, name: '원영턴 (장원영)', kind: 'motion', mime: 'video/webm', url: `/api/media/${MOTION}`, createdAt: '2026-09-30T00:00:00.000Z', source: { jobId: JOB }, fit: null, photoId: PHOTO }] });
  await put(`media/${MOTION}.webm`, 'motion bytes');
  await put(`animate/drivings/uploads/${DRIVING}/meta.json`, { id: DRIVING, label: '원영턴 (장원영)', filename: 'wy.mp4', ext: '.mp4', mime: 'video/mp4', createdAt: '2026-09-30T00:00:00.000Z', duration: 3, width: 508, height: 720 });
  await put(`animate/drivings/uploads/${DRIVING}/video.mp4`, 'driving bytes');
  await put(`animate/drivings/uploads/${DRIVING}/poster.jpg`, 'poster bytes');
  await put(`animate/jobs/${JOB}/job.json`, {
    id: JOB, state: 'succeeded', routeId: 'wavespeed/wan-2.2-animate-2', routeLabel: 'Wan 2.2 Animate 2', familyLabel: 'Wan 2.2 Animate 2', providerLabel: 'WaveSpeed', providerId: 'wavespeed',
    drivingId: DRIVING, drivingLabel: '원영턴 (장원영)', characterLabel: 'a.png', createdAt: '2026-09-30T06:07:11.261Z', updatedAt: '2026-09-30T06:08:23.358Z',
    options: { resolution: '720p' }, result: { duration: 2.967, width: 880, height: 1040, mime: 'video/mp4', keyed: null, keySkipped: null, keyError: null, fit: null },
    drivingPath: '/Users/someone/data/animate/drivings/uploads/x/video.mp4', characterPath: '/Users/someone/data/animate/jobs/x/character-source.png',
  });
  await put(`animate/jobs/${JOB}/result.mp4`, 'result bytes');
  await put(`animate/jobs/${JOB}/result.webm`, 'result webm bytes');
  await put(`animate/jobs/${JOB}/poster.jpg`, 'job poster bytes');
  await put('obs-source.json', { key: 'local-dev-overlay-key' });
  await put('auth/state.json', { secret: 'local' });
  await put('animate/config.json', { providers: { wavespeed: { apiKey: 'must-never-travel' } } });
  return root;
}

// A running app with Alice signed in once (so her account folder and owner.json exist), then stopped.
async function aliceApp(t) {
  const ctx = await H.startApp(t);
  const cookie = await H.signIn(ctx, H.ALICE);
  assert.equal((await H.get(ctx, '/api/library', cookie)).status, 200);
  await H.stopApp(ctx);
  return ctx;
}

test('finds the account by the address it signed in with, and says so when there is none', async t => {
  const ctx = await aliceApp(t);
  const docs = createFileDocs();
  const found = await findAccount({ docs, virtualRoot: ctx.dataDir, email: ' Alice@Example.com ' });
  assert.equal(found.dir, H.ALICE.sub);
  await assert.rejects(findAccount({ docs, virtualRoot: ctx.dataDir, email: 'nobody@example.com' }), /sign in to the site once/);
});

test('a dry run writes nothing; --apply puts files in the bucket and records in the account, and the account sees them', async t => {
  const ctx = await aliceApp(t);
  const src = await localWorkspace();
  const docs = createFileDocs();
  const store = createMemoryStore();
  const lines = [];
  const base = { docs, store, virtualRoot: ctx.dataDir, from: src, accountDir: H.ALICE.sub, log: line => lines.push(line) };

  const dry = await importToAccount(base);
  assert.equal(store.objects.size, 0);
  assert.equal(await fs.stat(path.join(ctx.dataDir, 'users', H.ALICE.sub, 'library.json')).catch(() => null), null);
  assert.equal(dry.media.added.length, 7);
  assert.equal(dry.records.added.length, 4);

  const done = await importToAccount({ ...base, apply: true });
  assert.deepEqual(done.media.failed, []);
  const keys = [
    `characters/photos/${PHOTO}.png`, `media/${MOTION}.webm`,
    `animate/drivings/uploads/${DRIVING}/poster.jpg`, `animate/drivings/uploads/${DRIVING}/video.mp4`,
    `animate/jobs/${JOB}/poster.jpg`, `animate/jobs/${JOB}/result.mp4`, `animate/jobs/${JOB}/result.webm`,
  ].map(rel => `users/${H.ALICE.sub}/${rel}`);
  assert.deepEqual([...store.objects.keys()].sort(), keys.sort());

  // The restarted service hydrates the files from the bucket and opens the account on the records.
  await H.restartApp(ctx, { blobs: store });
  const cookie = await H.signIn(ctx, H.ALICE);

  const jobs = await H.get(ctx, '/api/animate/jobs', cookie);
  assert.equal(jobs.status, 200, jobs.text);
  const job = jobs.json.jobs.find(item => item.id === JOB);
  assert.ok(job, 'the job is listed');
  assert.equal(job.state, 'succeeded');
  assert.equal(job.drivingLabel, '원영턴 (장원영)');
  const result = await H.get(ctx, job.result.url, cookie);
  assert.equal(result.status, 200);
  assert.equal(result.text, 'result bytes');

  const drivings = await H.get(ctx, '/api/animate/drivings', cookie);
  assert.ok(drivings.json.drivings.some(item => item.id === DRIVING && item.label === '원영턴 (장원영)'));

  const characters = await H.get(ctx, '/api/characters', cookie);
  assert.deepEqual(characters.json.characters.map(item => item.name), ['캐릭터 1']);
  assert.equal(characters.json.activePhotoId, PHOTO);

  const library = await H.get(ctx, '/api/library', cookie);
  const motion = library.json.motions.find(item => item.id === MOTION);
  assert.ok(motion, 'the motion is in the library');
  assert.equal((await H.get(ctx, motion.url, cookie)).text, 'motion bytes');
});

test('naming the whole data directory still leaves out secrets, the OBS key and the server config', async t => {
  const ctx = await aliceApp(t);
  const src = await localWorkspace();
  const docs = createFileDocs();
  const store = createMemoryStore();
  const lines = [];
  const report = await importToAccount({ docs, store, virtualRoot: ctx.dataDir, from: src, accountDir: H.ALICE.sub, paths: ['.'], apply: true, log: line => lines.push(line) });
  assert.deepEqual(report.records.skipped.sort(), ['animate/config.json', 'auth/state.json', 'obs-source.json']);
  assert.equal(store.objects.size, 7);
  assert.equal([...store.objects.values()].some(buffer => /must-never-travel|local-dev-overlay-key/.test(buffer.toString())), false);
  assert.equal(await fs.stat(path.join(ctx.dataDir, 'users', H.ALICE.sub, 'obs-source.json')).catch(() => null), null);
  assert.ok(lines.includes('skipped   obs-source.json (never imported)'));
});

test('a record the account already has is kept; a blank new-account index is replaced; --overwrite replaces the rest', async t => {
  const ctx = await aliceApp(t);
  const src = await localWorkspace();
  const docs = createFileDocs();
  const store = createMemoryStore();
  const dir = path.join(ctx.dataDir, 'users', H.ALICE.sub);
  await docs.write(path.join(dir, 'characters', 'index.json'), { v: 1, activePhotoId: null, characters: [] });
  await docs.write(path.join(dir, 'library.json'), { idle: null, idles: {}, motions: [{ id: 'mine', name: 'my own motion', kind: 'motion', mime: 'video/webm' }] });
  const base = { docs, store, virtualRoot: ctx.dataDir, from: src, accountDir: H.ALICE.sub, apply: true };

  const first = await importToAccount(base);
  assert.deepEqual(first.records.kept, ['library.json']);
  assert.ok(first.records.added.includes('characters/index.json'));
  assert.equal((await docs.read(path.join(dir, 'library.json'))).motions[0].id, 'mine');
  assert.equal((await docs.read(path.join(dir, 'characters', 'index.json'))).characters.length, 1);

  const again = await importToAccount(base);
  assert.deepEqual(again.records.kept.sort(), ['animate/drivings/uploads/' + DRIVING + '/meta.json', 'animate/jobs/' + JOB + '/job.json', 'characters/index.json', 'library.json']);
  assert.equal(again.media.same.length, 7);

  const forced = await importToAccount({ ...base, overwrite: true });
  assert.ok(forced.records.replaced.includes('library.json'));
  assert.equal((await docs.read(path.join(dir, 'library.json'))).motions[0].id, MOTION);
});

test('a file that does not arrive keeps every record back; a path outside --from is refused', async t => {
  const ctx = await aliceApp(t);
  const src = await localWorkspace();
  const docs = createFileDocs();
  const store = createMemoryStore();
  const realUpload = store.upload;
  store.upload = async (key, file, size, type) => { if (key.endsWith('result.mp4')) return; await realUpload(key, file, size, type); };
  const report = await importToAccount({ docs, store, virtualRoot: ctx.dataDir, from: src, accountDir: H.ALICE.sub, apply: true });
  assert.deepEqual(report.media.failed, [`animate/jobs/${JOB}/result.mp4`]);
  assert.deepEqual(report.records.added, []);
  assert.equal(await docs.read(path.join(ctx.dataDir, 'users', H.ALICE.sub, 'library.json')), null);

  await assert.rejects(importToAccount({ docs, store, virtualRoot: ctx.dataDir, from: src, accountDir: H.ALICE.sub, paths: ['../elsewhere'] }), /not inside --from/);
  await assert.rejects(importToAccount({ docs, store, virtualRoot: ctx.dataDir, from: src, accountDir: H.ALICE.sub, paths: ['nothing-here'] }), /does not exist/);
});

test('command line: options and paths', () => {
  const options = parseArgs(['--email', 'a@b.c', '--apply', '--from', '/d', 'animate/jobs']);
  assert.deepEqual([options.email, options.apply, options.from, options.paths], ['a@b.c', true, '/d', ['animate/jobs']]);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});
