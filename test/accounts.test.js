'use strict';

// Every Google account has its own data: characters, photos, motions, the on-air
// photo, driving videos, jobs, the OBS source size and the OBS overlay key. One
// account can neither see nor change another's, by id or any other way. Also:
// open sign-up ("*" in allowedEmails) and the folder an account's data lives in.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const H = require('./helpers/billing-server');
const { isEmailAllowed } = require('../lib/auth/config');

const skip = H.ffmpegSkip;

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const CAROL = Object.freeze({ sub: '200000000000000000004', email: 'carol@elsewhere.net', name: 'Carol' });

async function makeCharacter(ctx, cookie, name) {
  const response = await H.request(ctx, `/api/characters?name=${encodeURIComponent(name)}&filename=a.png`, { method: 'POST', cookie, body: PNG });
  assert.equal(response.status, 201, response.text);
  return response.json.character;
}

const asOverlay = key => `virtually_overlay=${key}`;

async function overlayKey(ctx, cookie) {
  const me = await H.get(ctx, '/api/auth/me', cookie);
  assert.equal(me.status, 200, me.text);
  assert.match(me.json.overlayKey, /^[A-Za-z0-9_-]{32}$/);
  return me.json.overlayKey;
}

// An open SSE response; text() is everything received so far.
function openStream(ctx, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.port, path: '/api/events', headers: { Cookie: cookie }, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', () => {});
      resolve({ status: res.statusCode, text: () => text, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('characters, photos, on-air and the library are per account', { skip }, async t => {
  const ctx = await H.startApp(t);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  const mint = await makeCharacter(ctx, alice, '민트');
  const photoId = mint.basePhotoId;
  assert.equal((await H.request(ctx, '/api/active-photo', { method: 'PUT', cookie: alice, body: { photoId } })).status, 200);

  // Bob starts empty and cannot reach Alice's character or photo by any route.
  assert.deepEqual((await H.get(ctx, '/api/characters', bob)).json, { characters: [], activePhotoId: null, activeCharacterId: null });
  assert.equal((await H.get(ctx, '/api/library', bob)).json.photo, null, 'Alice\'s on-air photo is not Bob\'s');
  assert.equal((await H.get(ctx, `/api/media/${photoId}`, bob)).status, 404);
  assert.equal((await H.get(ctx, `/api/media/${photoId}?variant=cutout`, bob)).status, 404);
  assert.equal((await H.request(ctx, '/api/active-photo', { method: 'PUT', cookie: bob, body: { photoId } })).status, 404);
  for (const [method, pathname, body] of [
    ['PATCH', `/api/characters/${mint.id}`, { name: '내 것' }],
    ['DELETE', `/api/characters/${mint.id}`, undefined],
    ['PUT', `/api/characters/${mint.id}/base`, { photoId }],
    ['DELETE', `/api/characters/${mint.id}/photos/${photoId}`, undefined],
    ['POST', `/api/characters/${mint.id}/photos?filename=b.png`, PNG],
  ]) {
    const response = await H.request(ctx, pathname, { method, cookie: bob, body });
    assert.ok([404, 409].includes(response.status), `${method} ${pathname} -> ${response.status}`);
    assert.notEqual(response.status, 200, `${method} ${pathname}`);
  }

  // Nothing of Alice's changed.
  const after = (await H.get(ctx, '/api/characters', alice)).json;
  assert.deepEqual(after.characters.map(item => [item.id, item.name, item.photos.length]), [[mint.id, '민트', 1]]);
  assert.equal(after.activePhotoId, photoId);
  assert.equal((await H.get(ctx, `/api/media/${photoId}`, alice)).status, 200);

  // Each account's limit counts its own characters only.
  const own = await makeCharacter(ctx, bob, '바나나');
  assert.deepEqual((await H.get(ctx, '/api/characters', bob)).json.characters.map(item => item.id), [own.id]);

  // Motions and idles: uploaded to the account's on-air photo, visible to it alone.
  const idle = await H.request(ctx, '/api/upload?kind=idle&name=idle.png&filename=idle.png', { method: 'POST', cookie: alice, body: PNG, contentType: 'image/png' });
  assert.equal(idle.status, 201, idle.text);
  assert.equal((await H.get(ctx, `/api/media/${idle.json.id}`, alice)).status, 200);
  assert.equal((await H.get(ctx, `/api/media/${idle.json.id}`, bob)).status, 404);
  assert.equal((await H.request(ctx, `/api/media/${idle.json.id}`, { method: 'DELETE', cookie: bob })).status, 404);
  assert.equal((await H.request(ctx, `/api/media/${idle.json.id}`, { method: 'DELETE', cookie: alice })).status, 200);

  // The data is on disk under each account's own folder.
  const home = sub => path.join(ctx.dataDir, 'users', sub);
  assert.ok(await fs.stat(path.join(home(H.ALICE.sub), 'characters', 'index.json')));
  assert.ok(await fs.stat(path.join(home(H.BOB.sub), 'characters', 'index.json')));
  const index = sub => fs.readFile(path.join(home(sub), 'characters', 'index.json'), 'utf8').then(JSON.parse);
  assert.deepEqual((await index(H.ALICE.sub)).characters.map(item => item.name), ['민트']);
  assert.deepEqual((await index(H.BOB.sub)).characters.map(item => item.name), ['바나나']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home(H.ALICE.sub), 'owner.json'), 'utf8')), { sub: H.ALICE.sub, email: H.ALICE.email, name: H.ALICE.name });
  // Nothing of theirs is in the shared root.
  await assert.rejects(fs.stat(path.join(ctx.dataDir, 'characters', 'photos', `${photoId}.png`)));

  // A restart reopens every account's workspace with its data.
  await H.restartApp(ctx);
  assert.deepEqual((await H.get(ctx, '/api/characters', alice)).json.characters.map(item => item.name), ['민트']);
  assert.deepEqual((await H.get(ctx, '/api/characters', bob)).json.characters.map(item => item.name), ['바나나']);
  assert.equal((await H.get(ctx, '/api/library', alice)).json.photo.id, photoId);
});

test('each OBS overlay key shows its own account\'s overlay, and only the overlay', { skip }, async t => {
  const ctx = await H.startApp(t);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  const mint = await makeCharacter(ctx, alice, '민트');
  await H.request(ctx, '/api/active-photo', { method: 'PUT', cookie: alice, body: { photoId: mint.basePhotoId } });
  const banana = await makeCharacter(ctx, bob, '바나나');
  await H.request(ctx, '/api/active-photo', { method: 'PUT', cookie: bob, body: { photoId: banana.basePhotoId } });

  const aliceKey = await overlayKey(ctx, alice);
  const bobKey = await overlayKey(ctx, bob);
  assert.notEqual(aliceKey, bobKey);
  assert.equal(await overlayKey(ctx, alice), aliceKey, 'the key is kept');

  // Alice's key opens Alice's overlay: her library and photo, not Bob's.
  const aliceLibrary = await H.get(ctx, '/api/library', asOverlay(aliceKey));
  assert.equal(aliceLibrary.status, 200);
  assert.equal(aliceLibrary.json.character.name, '민트');
  assert.equal((await H.get(ctx, `/api/media/${mint.basePhotoId}`, asOverlay(aliceKey))).status, 200);
  assert.equal((await H.get(ctx, `/api/media/${banana.basePhotoId}`, asOverlay(aliceKey))).status, 404);
  const bobLibrary = await H.get(ctx, '/api/library', asOverlay(bobKey));
  assert.equal(bobLibrary.json.character.name, '바나나');
  assert.equal((await H.get(ctx, `/api/media/${mint.basePhotoId}`, asOverlay(bobKey))).status, 404);

  // The OBS source size each overlay reports stays with its account.
  assert.equal((await H.request(ctx, '/api/obs-source', { method: 'POST', cookie: asOverlay(aliceKey), body: { width: 800, height: 600 } })).status, 200);
  assert.deepEqual((await H.get(ctx, '/api/obs-source', alice)).json, { width: 800, height: 600 });
  assert.equal((await H.get(ctx, '/api/obs-source', bob)).json, null);

  // A key is only the overlay: the character routes still need a session.
  assert.equal((await H.get(ctx, '/api/characters', asOverlay(aliceKey))).status, 401);
  // A session beats a cookie from another account's key.
  assert.equal((await H.get(ctx, '/api/library', `${bob}; ${asOverlay(aliceKey)}`)).json.character.name, '바나나');

  // Rotating Alice's key leaves Bob's overlay alone.
  const rotated = await H.post(ctx, '/api/auth/overlay-key', {}, alice);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.json.overlayKey, aliceKey);
  assert.equal((await H.get(ctx, '/api/library', asOverlay(aliceKey))).status, 401);
  assert.equal((await H.get(ctx, '/api/library', asOverlay(rotated.json.overlayKey))).json.character.name, '민트');
  assert.equal((await H.get(ctx, '/api/library', asOverlay(bobKey))).json.character.name, '바나나');
});

test('broadcast switches and plays reach only the account\'s own streams', { skip }, async t => {
  const ctx = await H.startApp(t);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  const aliceStream = await openStream(ctx, alice);
  const bobStream = await openStream(ctx, bob);
  t.after(() => { aliceStream.close(); bobStream.close(); });
  await sleep(100);
  assert.equal((await H.post(ctx, '/api/trigger', { id: 'demo' }, alice)).status, 200);
  const mint = await makeCharacter(ctx, alice, '민트');
  await H.request(ctx, '/api/active-photo', { method: 'PUT', cookie: alice, body: { photoId: mint.basePhotoId } });
  await sleep(150);
  assert.match(aliceStream.text(), /"type":"play"/);
  assert.match(aliceStream.text(), /"type":"library"[^\n]*민트/);
  assert.doesNotMatch(bobStream.text(), /"type":"play"/);
  assert.doesNotMatch(bobStream.text(), /민트/);
});

test('driving videos and jobs are per account', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  const driving = await H.prepareInputs(ctx, alice);
  const photoId = ctx.photoId;
  await H.billingOf(ctx, alice);
  assert.equal((await H.adjust(ctx, admin, H.ALICE.email, 2 * H.JOB_CREDITS)).status, 200);
  const created = await H.createJob(ctx, alice, driving.id, { options: H.LONG });
  assert.equal(created.status, 202, created.text);
  const jobId = created.json.job.id;

  // Bob sees none of it.
  const drivings = (await H.get(ctx, '/api/animate/drivings', bob)).json.drivings;
  assert.deepEqual(drivings.filter(item => item.kind === 'upload'), []);
  assert.equal((await H.get(ctx, `/api/animate/drivings/${driving.id}/video`, bob)).status, 404);
  assert.equal((await H.request(ctx, `/api/animate/drivings/${driving.id}`, { method: 'DELETE', cookie: bob })).status, 404);
  assert.deepEqual((await H.get(ctx, '/api/animate/jobs', bob)).json.jobs, []);
  for (const [method, suffix] of [['GET', ''], ['POST', '/cancel'], ['GET', '/result'], ['POST', '/motion'], ['POST', '/key'], ['POST', '/refetch']]) {
    const response = await H.request(ctx, `/api/animate/jobs/${jobId}${suffix}`, { method, cookie: bob, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 404, `${method} ${suffix}`);
  }
  // Bob cannot make a job from Alice's photo or driving video, even on a free route.
  const own = await makeCharacter(ctx, bob, '바나나');
  for (const body of [
    { drivingId: driving.id, photoId: own.basePhotoId, routeId: 'mock/local-demo' },
    { drivingId: 'up-00000000-0000-0000-0000-000000000000', photoId, routeId: 'mock/local-demo' },
    { drivingId: driving.id, photoId, routeId: 'mock/local-demo' },
  ]) {
    const response = await H.post(ctx, '/api/animate/jobs', body, bob);
    assert.equal(response.status, 400, response.text);
    assert.match(response.json.code, /^(driving_missing|photo_missing)$/);
  }

  // Alice's job is intact and still hers; cancelling it ends it and refunds her.
  assert.equal((await H.get(ctx, `/api/animate/jobs/${jobId}`, alice)).status, 200);
  assert.equal((await H.post(ctx, `/api/animate/jobs/${jobId}/cancel`, {}, alice)).status, 200);
  // The admin page lists every account's jobs and driving videos, with their owners.
  const library = (await H.get(ctx, '/api/admin/library', admin)).json;
  assert.equal(library.jobs.find(job => job.id === jobId).owner, H.ALICE.email);
  assert.equal(library.drivings.find(item => item.id === driving.id).owner, H.ALICE.email);
});

test('anyone can sign in with "*", each into a workspace of their own; a sub never escapes its folder', { skip }, async t => {
  const ctx = await H.startApp(t, { auth: H.authConfig({ allowedEmails: ['*'] }) });
  const carol = await H.signIn(ctx, CAROL);
  const mint = await makeCharacter(ctx, carol, '캐롤');
  assert.equal((await H.get(ctx, '/api/characters', carol)).json.characters[0].id, mint.id);
  assert.equal((await H.get(ctx, '/api/billing', carol)).status, 200, 'a stranger gets an account with its own credits');
  // A Google sub is data from outside: odd ones are hashed, never used as a path.
  const odd = await H.signIn(ctx, { sub: '../../escape', email: 'odd@elsewhere.net', name: 'Odd' });
  await makeCharacter(ctx, odd, '이상한');
  const names = await fs.readdir(path.join(ctx.dataDir, 'users'));
  assert.ok(names.includes(CAROL.sub));
  assert.ok(names.some(name => /^x~[0-9a-f]{32}$/.test(name)), names.join(', '));
  assert.ok(!names.some(name => name.includes('..')));
  await assert.rejects(fs.stat(path.join(ctx.root, 'escape')));
  // Stranger and the first account do not share anything.
  assert.deepEqual((await H.get(ctx, '/api/characters', odd)).json.characters.map(item => item.name), ['이상한']);

  // Narrowing the list again locks the others out at once (their data stays).
  await H.setAuthConfig(ctx, H.authConfig({ allowedEmails: ['@example.com'] }));
  assert.equal((await H.get(ctx, '/api/characters', carol)).status, 401);
});

test('"*" means every account in the allow list, and nothing else changes', () => {
  assert.equal(isEmailAllowed(['*'], 'anyone@gmail.com'), true);
  assert.equal(isEmailAllowed(['a@b.c', '*'], 'anyone@gmail.com'), true);
  assert.equal(isEmailAllowed(['*'], ''), false);
  assert.equal(isEmailAllowed(['*'], undefined), false);
  assert.equal(isEmailAllowed(['a@b.c'], 'anyone@gmail.com'), false);
});

test('an account whose storage is full cannot add files, and others are not affected', { skip }, async t => {
  const ctx = await H.startApp(t);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  await makeCharacter(ctx, alice, '민트');
  await H.restartApp(ctx, { accountQuotaBytes: 1000 });
  const full = await H.request(ctx, '/api/characters?name=x&filename=a.png', { method: 'POST', cookie: alice, body: Buffer.alloc(2000, 1) });
  assert.equal(full.status, 413, full.text);
  assert.equal(full.json.code, 'quota_exceeded');
  assert.equal((await H.get(ctx, '/api/characters', alice)).status, 200, 'reads and deletes still work');
  const room = await H.request(ctx, '/api/characters?name=x&filename=a.png', { method: 'POST', cookie: bob, body: PNG });
  assert.equal(room.status, 201, 'Bob has his own space');
});

test('a finished job can be deleted, with its files; a running one cannot, nor can another account', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  assert.equal((await H.adjust(ctx, admin, H.ALICE.email, H.JOB_CREDITS)).status, 200);
  const jobId = (await H.createJob(ctx, alice, driving.id, { options: H.LONG })).json.job.id;
  const del = (cookie) => H.request(ctx, `/api/animate/jobs/${jobId}`, { method: 'DELETE', cookie });

  assert.equal((await del(bob)).status, 404);
  const running = await del(alice);
  assert.equal(running.status, 409);
  assert.equal(running.json.code, 'job_active');
  await H.post(ctx, `/api/animate/jobs/${jobId}/cancel`, {}, alice);
  await H.waitFor(async () => (await H.get(ctx, `/api/animate/jobs/${jobId}`, alice)).json.billing.refunded === true, { message: 'the refund' });
  const dir = path.join(ctx.dataDir, 'users', H.ALICE.sub, 'animate', 'jobs', jobId);
  assert.ok(await fs.stat(dir));
  assert.equal((await del(alice)).status, 200);
  assert.equal((await H.get(ctx, `/api/animate/jobs/${jobId}`, alice)).status, 404);
  assert.deepEqual((await H.get(ctx, '/api/animate/jobs', alice)).json.jobs, []);
  await assert.rejects(fs.stat(dir));
  assert.equal((await del(alice)).status, 404);
});
