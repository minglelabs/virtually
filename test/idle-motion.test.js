'use strict';

// The photo's idle (lib/idle.js): the still photo until the photo has a
// 기본 대기 동작 video, which then loops instead; the user may pick any other
// motion of the photo (PUT /api/characters/<id>/photos/<photoId>/idle).
// Also GET /healthz, which Railway polls before a new deploy takes over.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const { isIdleMotion, resolveIdle, parseIdleChoice, IDLE_MOTION_NAME } = require('../lib/idle');
const motions = require('../public/motions.js');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let skip = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { skip = 'ffmpeg is not installed'; }

// A WebM with a valid signature: enough for /api/upload.
const FAKE_WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);

test('resolveIdle: the choice, then an uploaded idle, then the newest idle motion, then the photo', () => {
  const motion = (id, name, createdAt, extra = {}) => ({ id, name, photoId: 'ph-1', createdAt, ...extra });
  const wave = motion('m-wave', 'wave', '2026-10-01T00:00:00.000Z');
  const oldIdle = motion('m-old', '사람 대기 (idle · 무표정)', '2026-10-01T00:00:01.000Z');
  const newIdle = motion('m-new', '숨쉬기', '2026-10-01T00:00:02.000Z', { source: { jobId: 'j', idle: true } });
  const other = { id: 'm-other', name: IDLE_MOTION_NAME, photoId: 'ph-2', createdAt: '2026-10-02T00:00:00.000Z' };
  assert.equal(motions.IDLE_MOTION_NAME, IDLE_MOTION_NAME, 'the page and the server name the default idle alike');
  assert.deepEqual([wave, oldIdle, newIdle, other, null].map(isIdleMotion), [false, true, true, true, false]);

  const library = { motions: [wave, oldIdle, newIdle, other], idles: {}, idleChoice: {} };
  assert.deepEqual(resolveIdle({ ...library, motions: [wave, other] }, 'ph-1'), { kind: 'photo' });
  assert.deepEqual(resolveIdle(library, 'ph-1'), { kind: 'motion', motion: newIdle, by: 'default' });
  const uploaded = { id: 'i-1' };
  assert.deepEqual(resolveIdle({ ...library, idles: { 'ph-1': uploaded } }, 'ph-1'), { kind: 'upload', item: uploaded });
  assert.deepEqual(resolveIdle({ ...library, idles: { 'ph-1': uploaded }, idleChoice: { 'ph-1': 'm-wave' } }, 'ph-1'),
    { kind: 'motion', motion: wave, by: 'choice' });
  assert.deepEqual(resolveIdle({ ...library, idleChoice: { 'ph-1': 'm-other' } }, 'ph-1').by, 'default', 'a motion of another photo is no choice');
  assert.deepEqual(parseIdleChoice({ a: 'm', b: 7, c: '' }), { a: 'm' });
  assert.deepEqual(parseIdleChoice([1]), {});
});

test('idle: 기본 대기 동작 replaces the photo, any motion can be chosen, and the choice follows deletions', { skip }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-idle-'));
  const png = path.join(dataDir, 'character.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x96', '-frames:v', '1', png]);
  const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const json = (method, pathname, body) => fetch(`${base}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const view = async () => (await fetch(`${base}/api/library`)).json();
  const upload = async name => {
    const response = await fetch(`${base}/api/upload?kind=motion&name=${encodeURIComponent(`${name}.webm`)}`, {
      method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: FAKE_WEBM,
    });
    assert.equal(response.status, 201);
    return response.json();
  };

  // Railway's health check needs no session and answers as soon as the server listens.
  let response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');

  response = await fetch(`${base}/api/characters?name=${encodeURIComponent('앨리스')}&filename=character.png`, { method: 'POST', body: fsSync.readFileSync(png) });
  assert.equal(response.status, 201);
  const { character } = await response.json();
  const photoId = character.basePhotoId;
  const idlePath = `/api/characters/${character.id}/photos/${photoId}/idle`;
  assert.equal((await json('PUT', '/api/active-photo', { photoId })).status, 200);
  const photoOf = async () => (await (await fetch(`${base}/api/characters`)).json()).characters[0].photos[0];

  // No idle video yet: the photo.
  assert.equal((await view()).idle.id, photoId);
  const wave = await upload('wave');
  let now = await view();
  assert.equal(now.idle.id, photoId);
  assert.deepEqual(now.motions.map(item => item.id), [wave.id]);
  assert.deepEqual([(await photoOf()).idle, (await photoOf()).idleMotionId], ['photo', null]);
  // With no idle video the default is the photo, also while another motion is chosen.
  assert.equal((await json('PUT', idlePath, { motionId: wave.id })).status, 200);
  assert.deepEqual([(await photoOf()).idle, (await photoOf()).idleDefault, (await photoOf()).defaultIdleMotionId], ['motion', 'photo', null]);
  assert.equal((await json('PUT', idlePath, { motionId: null })).status, 200);

  // The default idle video: it loops instead of the photo and is not a motion button.
  const idle = await upload(IDLE_MOTION_NAME);
  now = await view();
  assert.equal(now.idle.id, idle.id);
  assert.equal(now.idle.kind, 'idle');
  assert.equal(now.idle.mime, 'video/webm');
  assert.deepEqual(now.motions.map(item => item.id), [wave.id]);
  let photo = await photoOf();
  assert.deepEqual([photo.idle, photo.idleMotionId, photo.idleBy], ['motion', idle.id, 'default']);
  assert.deepEqual(photo.motions.map(item => [item.name, item.isIdle]), [['wave', false], [IDLE_MOTION_NAME, true]]);
  assert.equal((await json('POST', '/api/trigger', { id: idle.id })).status, 404, 'the idle is not played as a motion');

  // The user picks another motion.
  response = await json('PUT', idlePath, { motionId: wave.id });
  assert.equal(response.status, 200);
  photo = (await response.json()).character.photos[0];
  assert.deepEqual([photo.idle, photo.idleMotionId, photo.idleBy], ['motion', wave.id, 'choice']);
  assert.deepEqual([photo.idleDefault, photo.defaultIdleMotionId], ['motion', idle.id], 'what it goes back to without the choice');
  now = await view();
  assert.equal(now.idle.id, wave.id);
  assert.deepEqual(now.motions.map(item => item.id), [idle.id]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8')).idleChoice, { [photoId]: wave.id });

  // Refusals change nothing.
  assert.equal((await json('PUT', idlePath, { motionId: 'no-such-motion' })).status, 404);
  assert.equal((await json('PUT', idlePath, {})).status, 400);
  assert.equal((await json('PUT', `/api/characters/${character.id}/photos/ph-00000000-0000-4000-8000-000000000000/idle`, { motionId: wave.id })).status, 404);
  assert.equal((await view()).idle.id, wave.id);

  // null: back to the default; a deleted choice goes with its motion.
  assert.equal((await json('PUT', idlePath, { motionId: null })).status, 200);
  assert.equal((await view()).idle.id, idle.id);
  assert.equal((await json('PUT', idlePath, { motionId: wave.id })).status, 200);
  assert.equal((await json('DELETE', `/api/media/${wave.id}`)).status, 200);
  assert.equal((await view()).idle.id, idle.id);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8')).idleChoice, {});
  assert.equal((await json('DELETE', `/api/media/${idle.id}`)).status, 200);
  assert.equal((await view()).idle.id, photoId, 'no idle video left: the photo again');
});
