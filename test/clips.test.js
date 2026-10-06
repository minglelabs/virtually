'use strict';

// lib/clips.js: a clip repeated N times (copied, not re-encoded) and two clips joined into
// one (transparent clips aligned on their character), and the routes that use them: a photo's
// motions (POST /api/media/<id>/repeat | join) and the scene's video layers (repeat count,
// replay, join).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const clips = require('../lib/clips');
const scene = require('../lib/scene');
const { measureFit } = require('../lib/animate/fit');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
function ffmpegAvailable() {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const skip = ffmpegAvailable() ? false : 'ffmpeg is not installed';
const ffmpeg = args => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
const tools = { ffmpegPath: FFMPEG, ffprobePath: FFPROBE };

// A transparent VP9 WebM: an ellipse of `color` (radii rx, ry) centred at (cx, cy) on a w x h frame.
function alphaClip(file, { w, h, cx, cy, rx, ry, color = [40, 120, 255], seconds = 1, fps = 10 }) {
  ffmpeg(['-f', 'lavfi', '-i',
    `color=c=black:s=${w}x${h}:r=${fps}:d=${seconds},format=rgba,geq=r=${color[0]}:g=${color[1]}:b=${color[2]}:a='if(lt(hypot((X-${cx})/${rx},(Y-${cy})/${ry}),1),255,0)'`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '30', file]);
}

function opaqueClip(file, { w, h, seconds = 1, fps = 10, sound = false, color = 'blue' }) {
  ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:r=${fps}:d=${seconds}`,
    ...(sound ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(sound ? ['-c:a', 'aac', '-shortest'] : []), file]);
}

const frames = file => Number(execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
  '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim());

// The box of the pixels that are not transparent in the frame at `at` seconds: [x0, y0, x1, y1] (x1/y1 exclusive).
function solidBox(file, at, width, height) {
  const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-c:v', 'libvpx-vp9', '-ss', String(at), '-i', file,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (raw[(y * width + x) * 4 + 3] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

test('checkTimes and listLine', () => {
  assert.equal(clips.checkTimes(2), 2);
  assert.equal(clips.checkTimes(clips.MAX_TIMES), clips.MAX_TIMES);
  for (const bad of [1, 0, -3, 2.5, '3', null, undefined, clips.MAX_TIMES + 1]) {
    assert.throws(() => clips.checkTimes(bad), { status: 400, code: 'bad_times' }, String(bad));
  }
  assert.equal(clips.listLine('/data/a b.webm'), "file '/data/a b.webm'");
  assert.equal(clips.listLine("/data/it's.webm"), "file '/data/it'\\''s.webm'");
});

test('joinLayout: clips with a character box share its height, bottom and middle; the frame holds them whole', () => {
  // A: 300 x 500, its figure 60..240 x 110..490. B: 480 x 400, a smaller figure 260..380 x 150..390.
  const a = { width: 300, height: 500, fit: { first: [0.2, 0.22, 0.8, 0.98] } };
  const b = { width: 480, height: 400, fit: { first: [260 / 480, 0.375, 380 / 480, 0.975] } };
  const layout = clips.joinLayout([a, b], { anchor: 'bottom' });
  assert.equal(layout.aligned, true);
  // B is enlarged 380/240 so the figures are equally tall: 760 x 633, and it is the wider one on every side.
  assert.deepEqual([layout.width, layout.height], [760, 634]);
  assert.deepEqual(layout.places[1], { width: 760, height: 634, x: 0, y: 0 });
  // A keeps its size; its figure's middle (150) lands on B's (320 * 380/240 = 506.7), its feet (490) on B's (617.5).
  assert.deepEqual(layout.places[0], { width: 300, height: 500, x: 357, y: 128 });

  // The same clip twice: its own frame, nothing moved.
  assert.deepEqual(clips.joinLayout([a, a]), { width: 300, height: 500, aligned: true, places: [{ width: 300, height: 500, x: 0, y: 0 }, { width: 300, height: 500, x: 0, y: 0 }] });

  // A later clip is never scaled beyond 5x (a figure that is a speck in its first frame).
  const speck = { width: 300, height: 500, fit: { first: [0.5, 0.5, 0.51, 0.51] } };
  assert.equal(clips.joinLayout([a, speck], { maxEdge: 100000 }).places[1].width, 1500);
  // And the frame that takes is brought back under the limit.
  assert.equal(clips.joinLayout([a, speck]).height, clips.MAX_EDGE);

  // A frame longer than the limit is scaled down with everything on it; sizes stay even.
  const big = clips.joinLayout([{ width: 3840, height: 2160, fit: null }, { width: 1280, height: 720, fit: null }]);
  assert.deepEqual([big.width, big.height, big.aligned], [1920, 1080, false]);
  assert.deepEqual(big.places, [{ width: 1920, height: 1080, x: 0, y: 0 }, { width: 1920, height: 1080, x: 0, y: 0 }]);
});

test('joinLayout: without a box on every clip, the first frame is the frame and the others are fitted into it', () => {
  const wide = { width: 640, height: 360, fit: null };
  const tall = { width: 180, height: 320, fit: { first: [0.1, 0.1, 0.9, 0.9] } };
  const centred = clips.joinLayout([wide, tall]);
  assert.deepEqual([centred.width, centred.height, centred.aligned], [640, 360, false]);
  // 180 x 320 fitted into 640 x 360: 202.5 x 360 (even: 202), in the middle.
  assert.deepEqual(centred.places, [{ width: 640, height: 360, x: 0, y: 0 }, { width: 202, height: 360, x: 219, y: 0 }]);
  const standing = clips.joinLayout([tall, wide], { anchor: 'bottom' });
  // 640 x 360 fitted into 180 x 320: 180 x 101.25 (even: 102), on the bottom edge.
  assert.deepEqual(standing.places[1], { width: 180, height: 102, x: 0, y: 218 });
  // A malformed box counts as none.
  assert.equal(clips.joinLayout([{ ...tall, fit: { first: [0.5, 0.5, 0.5, 0.9] } }, tall]).aligned, false);
});

test('repeatClip: the same packets N times; alpha, sound and length are kept; limits', { skip }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-clips-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "it's alpha.webm");
  alphaClip(source, { w: 120, h: 200, cx: 60, cy: 120, rx: 30, ry: 70 });
  const before = await clips.probeClip(FFPROBE, source);
  assert.deepEqual([before.container, before.codec, before.alpha, before.width, before.height, Math.round(before.fps), before.audioCodec],
    ['webm', 'vp9', true, 120, 200, 10, null]);

  const dest = path.join(dir, 'x3.webm');
  const made = await clips.repeatClip({ ...tools, sourcePath: source, destPath: dest, workDir: dir, times: 3 });
  assert.ok(Math.abs(made.duration - 3) < 0.2, String(made.duration));
  assert.equal(frames(dest), 3 * frames(source));
  const after = await clips.probeClip(FFPROBE, dest);
  assert.deepEqual([after.alpha, after.width, after.height], [true, 120, 200]);
  // The figure is where it was, in the third round too (and the corners are still transparent).
  assert.deepEqual(solidBox(dest, 2.5, 120, 200), solidBox(source, 0.5, 120, 200));

  const mp4 = path.join(dir, 'sound.mp4');
  opaqueClip(mp4, { w: 160, h: 90, sound: true });
  const twice = path.join(dir, 'x2.mp4');
  await clips.repeatClip({ ...tools, sourcePath: mp4, destPath: twice, workDir: dir, times: 2 });
  const doubled = await clips.probeClip(FFPROBE, twice);
  assert.deepEqual([doubled.container, doubled.codec, doubled.audioCodec, doubled.alpha], ['mp4', 'h264', 'aac', false]);
  assert.ok(Math.abs(doubled.duration - 2) < 0.3, String(doubled.duration));

  await assert.rejects(clips.repeatClip({ ...tools, sourcePath: source, destPath: path.join(dir, 'no.webm'), workDir: dir, times: 1 }), { code: 'bad_times' });
  await assert.rejects(clips.repeatClip({ ...tools, sourcePath: path.join(dir, 'missing.webm'), destPath: path.join(dir, 'no.webm'), workDir: dir, times: 2 }), { code: 'unsupported_clip' });
  // 40 s x 20 would be more than the limit: refused before anything is written.
  const long = path.join(dir, 'long.mp4');
  opaqueClip(long, { w: 64, h: 36, seconds: 40, fps: 1 });
  await assert.rejects(clips.repeatClip({ ...tools, sourcePath: long, destPath: path.join(dir, 'no.mp4'), workDir: dir, times: 20 }), { status: 422, code: 'too_long' });
  assert.equal(fsSync.existsSync(path.join(dir, 'no.mp4')), false);
});

test('joinClips: transparent clips become one transparent clip with the figure where it was; opaque clips one MP4 with sound', { skip }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-clips-join-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.webm');
  const b = path.join(dir, 'b.webm');
  // The same figure filmed twice: B's frame is wider and its figure smaller and off to the right.
  alphaClip(a, { w: 150, h: 250, cx: 75, cy: 150, rx: 45, ry: 95 });
  alphaClip(b, { w: 240, h: 200, cx: 160, cy: 135, rx: 30, ry: 60, color: [255, 140, 0], fps: 15 });
  const fits = [await measureFit(FFMPEG, FFPROBE, a), await measureFit(FFMPEG, FFPROBE, b)];
  const work = path.join(dir, 'work');
  await fs.mkdir(work);
  const joined = await clips.joinClips({ ...tools, workDir: work, parts: [{ path: a, fit: fits[0] }, { path: b, fit: fits[1] }] });
  assert.deepEqual([joined.mime, joined.alpha, joined.audio, joined.aligned, path.dirname(joined.path)], ['video/webm', true, false, true, work]);
  assert.ok(Math.abs(joined.duration - 2) < 0.3, String(joined.duration));
  // The first clip's frame rate; both parts are there.
  assert.equal(Math.round((await clips.probeClip(FFPROBE, joined.path)).fps), 10);
  assert.ok(Math.abs(frames(joined.path) - 20) <= 1);
  // The figure of the second part stands where the first part's did, as tall and as wide.
  const first = solidBox(joined.path, 0.25, joined.width, joined.height);
  const second = solidBox(joined.path, 1.5, joined.width, joined.height);
  for (let i = 0; i < 4; i += 1) assert.ok(Math.abs(first[i] - second[i]) <= 4, `side ${i}: ${first} vs ${second}`);
  // And nothing of either frame is cut: the first figure is as tall as it was (190 px).
  assert.ok(Math.abs((first[3] - first[1]) - 190) <= 3, String(first));

  // Without the boxes the second clip is fitted into the first one's frame, standing on its bottom edge.
  const plain = await clips.joinClips({ ...tools, workDir: await fs.mkdtemp(path.join(dir, 'plain-')), parts: [{ path: a, fit: null }, { path: b, fit: null }] });
  assert.deepEqual([plain.width, plain.height, plain.aligned], [150, 250, false]);

  // Opaque: H.264 + AAC, the first clip's frame; the silent clip gets silence.
  const x = path.join(dir, 'x.mp4');
  const y = path.join(dir, 'y.mp4');
  opaqueClip(x, { w: 160, h: 90, sound: true });
  opaqueClip(y, { w: 90, h: 160, color: 'red' });
  const movie = await clips.joinClips({ ...tools, workDir: await fs.mkdtemp(path.join(dir, 'movie-')), parts: [{ path: x }, { path: y }] });
  assert.deepEqual([movie.mime, movie.alpha, movie.audio, movie.width, movie.height], ['video/mp4', false, true, 160, 90]);
  const probed = await clips.probeClip(FFPROBE, movie.path);
  assert.deepEqual([probed.codec, probed.pixFmt, probed.audioCodec], ['h264', 'yuv420p', 'aac']);
  assert.ok(Math.abs(probed.duration - 2) < 0.3, String(probed.duration));

  // A transparent and an opaque clip are not joined; nor are clips that would be too long together.
  await assert.rejects(clips.joinClips({ ...tools, workDir: dir, parts: [{ path: a, fit: fits[0] }, { path: x }] }), { status: 422, code: 'mixed_alpha' });
  const long = path.join(dir, 'long.mp4');
  opaqueClip(long, { w: 64, h: 36, seconds: 160, fps: 1 });
  await assert.rejects(clips.joinClips({ ...tools, workDir: dir, parts: [{ path: long }, { path: long }] }), { status: 422, code: 'too_long' });
  await assert.rejects(clips.joinClips({ ...tools, workDir: dir, parts: [{ path: a }] }), { code: 'unsupported_clip' });
});

async function openServer(t, prefix) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, pathname, body) => fetch(`${base}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { dataDir, base, send };
}

test('motions: POST /api/media/<id>/repeat and /join make new motions of the same photo', { skip }, async (t) => {
  const { dataDir, base, send } = await openServer(t, 'virtually-clips-motions-');
  const files = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-clips-files-'));
  t.after(() => fs.rm(files, { recursive: true, force: true }));
  const photo = path.join(files, 'photo.png');
  ffmpeg(['-f', 'lavfi', '-i', "color=c=black:s=150x250,format=rgba,geq=r=40:g=120:b=255:a='if(lt(hypot((X-75)/45,(Y-150)/95),1),255,0)'", '-frames:v', '1', photo]);
  const wave = path.join(files, 'wave.webm');
  const turn = path.join(files, 'turn.webm');
  const opaque = path.join(files, 'opaque.mp4');
  alphaClip(wave, { w: 150, h: 250, cx: 75, cy: 150, rx: 45, ry: 95 });
  alphaClip(turn, { w: 240, h: 200, cx: 160, cy: 135, rx: 30, ry: 60, color: [255, 140, 0] });
  // Not a plain background, so the upload keeps it as it is.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', opaque]);

  const created = await (await fetch(`${base}/api/characters?name=${encodeURIComponent('미나')}&filename=photo.png`, { method: 'POST', body: fsSync.readFileSync(photo) })).json();
  const characterId = created.character.id;
  const photoId = created.character.basePhotoId;
  const addMotion = async (file, name) => {
    const response = await fetch(`${base}/api/characters/${characterId}/photos/${photoId}/motions?name=${encodeURIComponent(name)}&filename=${path.basename(file)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fsSync.readFileSync(file),
    });
    assert.equal(response.status, 201, name);
    return (await response.json()).motion;
  };
  const a = await addMotion(wave, '손 인사');
  const b = await addMotion(turn, '턴');
  const c = await addMotion(opaque, '배경 있는 영상');
  assert.ok(a.fit && b.fit && !c.fit);
  const motionNames = body => body.characters[0].photos[0].motions.map(motion => motion.name);

  // Repeat: a new motion '이름 ×3' of the same photo, with the same character box; the original stays.
  let response = await send('POST', `/api/media/${a.id}/repeat`, { times: 3 });
  assert.equal(response.status, 201);
  let body = await response.json();
  const repeated = body.motion;
  assert.deepEqual({ ...repeated, id: null, url: null, createdAt: null }, {
    id: null, name: '손 인사 ×3', kind: 'motion', mime: 'video/webm', url: null, createdAt: null, photoId,
    source: { repeat: { motionId: a.id, times: 3 } }, fit: a.fit,
  });
  assert.equal(repeated.url, `/api/media/${repeated.id}`);
  assert.deepEqual(motionNames(body), ['손 인사', '턴', '배경 있는 영상', '손 인사 ×3']);
  const repeatedFile = path.join(dataDir, 'media', `${repeated.id}.webm`);
  assert.equal(frames(repeatedFile), 3 * frames(path.join(dataDir, 'media', `${a.id}.webm`)));
  assert.equal((await clips.probeClip(FFPROBE, repeatedFile)).alpha, true);
  // It is a motion like any other: the overlay can play it once the photo is on air.
  await send('PUT', '/api/active-photo', { photoId });
  assert.equal((await send('POST', '/api/trigger', { id: repeated.id })).status, 200);
  assert.equal((await fetch(`${base}${repeated.url}`)).status, 200);

  // An opaque motion is repeated as an MP4 and still counts as having its background.
  body = await (await send('POST', `/api/media/${c.id}/repeat`, { times: 2 })).json();
  assert.deepEqual([body.motion.name, body.motion.mime, body.motion.fit], ['배경 있는 영상 ×2', 'video/mp4', null]);
  assert.equal(body.characters[0].photos[0].motions.at(-1).hasBackground, true);

  // Join: this motion, then that one, as one transparent motion with its own measured box.
  response = await send('POST', `/api/media/${a.id}/join`, { with: b.id });
  assert.equal(response.status, 201);
  body = await response.json();
  const joined = body.motion;
  assert.deepEqual([joined.name, joined.mime, joined.photoId, joined.source], ['손 인사 + 턴', 'video/webm', photoId, { join: { motionIds: [a.id, b.id] } }]);
  assert.ok(joined.fit && joined.fit.first, 'the joined clip has a character box');
  assert.equal(body.characters[0].photos[0].motions.at(-1).hasBackground, false);
  const joinedInfo = await clips.probeClip(FFPROBE, path.join(dataDir, 'media', `${joined.id}.webm`));
  assert.equal(joinedInfo.alpha, true);
  assert.ok(Math.abs(joinedInfo.duration - 2) < 0.3);
  // A motion may be joined with itself, and a joined motion joined again.
  assert.equal((await send('POST', `/api/media/${joined.id}/join`, { with: joined.id })).status, 201);

  // Refusals: the count, unknown motions, a transparent with an opaque clip, a motion of another photo.
  for (const times of [1, 21, 2.5, '3', undefined]) {
    response = await send('POST', `/api/media/${a.id}/repeat`, { times });
    assert.deepEqual([response.status, (await response.json()).code], [400, 'bad_times'], String(times));
  }
  assert.equal((await send('POST', '/api/media/00000000-0000-4000-8000-000000000000/repeat', { times: 2 })).status, 404);
  response = await send('POST', `/api/media/${a.id}/join`, { with: '00000000-0000-4000-8000-000000000000' });
  assert.deepEqual([response.status, (await response.json()).code], [404, 'motion_missing']);
  assert.equal((await send('POST', `/api/media/${a.id}/join`, {})).status, 404);
  response = await send('POST', `/api/media/${a.id}/join`, { with: c.id });
  assert.deepEqual([response.status, (await response.json()).code], [422, 'mixed_alpha']);
  assert.equal((await fetch(`${base}/api/media/${a.id}/repeat`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"times":2}' })).status, 415);
  const other = await (await fetch(`${base}/api/characters/${characterId}/photos?filename=photo.png`, { method: 'POST', body: fsSync.readFileSync(photo) })).json();
  const elsewhere = await (await fetch(`${base}/api/characters/${characterId}/photos/${other.photo.id}/motions?name=x&filename=wave.webm`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fsSync.readFileSync(wave),
  })).json();
  response = await send('POST', `/api/media/${a.id}/join`, { with: elsewhere.motion.id });
  assert.deepEqual([response.status, (await response.json()).code], [409, 'different_photo']);
  // Nothing is left behind by the refusals, and no work folder by anything.
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'media'))).filter(name => name.includes('.tmp')), []);
  const library = JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8'));
  assert.equal(library.motions.length, 8);
});

test('scene: a repeat count for videos, replay, and two video layers joined into one', { skip }, async (t) => {
  const { dataDir, base, send } = await openServer(t, 'virtually-clips-scene-');
  const files = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-clips-files-'));
  t.after(() => fs.rm(files, { recursive: true, force: true }));
  const intro = path.join(files, 'intro.mp4');
  const loop = path.join(files, 'loop.webm');
  const logo = path.join(files, 'logo.png');
  opaqueClip(intro, { w: 160, h: 90, sound: true });
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=120x120:r=10:d=1', '-c:v', 'libvpx-vp9', '-b:v', '50k', loop]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', logo]);
  const upload = async file => (await (await fetch(`${base}/api/scene/layers?name=${path.basename(file)}`, { method: 'POST', body: fsSync.readFileSync(file) })).json()).layer;
  const a = await upload(intro);
  const b = await upload(loop);
  const image = await upload(logo);
  assert.deepEqual([a.repeat, b.repeat, image.repeat], [0, 0, 0]);

  // The repeat count: 0 (over and over) to MAX_REPEAT, videos only.
  let body = await (await send('PATCH', `/api/scene/layers/${a.id}`, { repeat: 3 })).json();
  assert.equal(body.scene.layers.find(layer => layer.id === a.id).repeat, 3);
  for (const bad of [-1, 1.5, '2', scene.MAX_REPEAT + 1]) {
    assert.equal((await send('PATCH', `/api/scene/layers/${a.id}`, { repeat: bad })).status, 400, String(bad));
  }
  assert.equal((await send('PATCH', `/api/scene/layers/${image.id}`, { repeat: 2 })).status, 400);
  assert.equal((await send('PATCH', '/api/scene/layers/character', { repeat: 2 })).status, 400);
  assert.equal(scene.parseScene({ layers: [{ id: a.id, kind: 'video', mime: 'video/mp4', repeat: 500 }] }).layers[0].repeat, scene.MAX_REPEAT);
  assert.equal(scene.parseScene({ layers: [{ id: a.id, kind: 'image', mime: 'image/png', repeat: 5 }] }).layers[0].repeat, 0);

  // Replay: told to the open pages, nothing stored.
  const stream = await fetch(`${base}/api/events`);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  let buffered = '';
  const nextOfType = async (type) => {
    for (;;) {
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop();
      for (const [index, block] of blocks.entries()) {
        if (!block.startsWith('data: ')) continue;
        const message = JSON.parse(block.slice(6));
        if (message.type !== type) continue;
        buffered = [...blocks.slice(index + 1), buffered].join('\n\n');
        return message;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffered += decoder.decode(value, { stream: true });
    }
  };
  const before = await (await send('GET', '/api/scene')).json();
  assert.deepEqual(await (await send('POST', `/api/scene/layers/${a.id}/replay`, {})).json(), { ok: true });
  assert.deepEqual(await nextOfType('scene-replay'), { type: 'scene-replay', id: a.id });
  assert.deepEqual(await (await send('GET', '/api/scene')).json(), before);
  assert.equal((await send('POST', `/api/scene/layers/${image.id}/replay`, {})).status, 404);
  assert.equal((await send('POST', '/api/scene/layers/character/replay', {})).status, 404);

  // Join: the first video, then the other, as one new layer right in front of the first, placed and set like it.
  await send('PATCH', `/api/scene/layers/${a.id}`, { fill: false, scale: 0.5, x: 0.2, muted: false });
  let response = await send('POST', `/api/scene/layers/${a.id}/join`, { with: b.id });
  assert.equal(response.status, 201);
  body = await response.json();
  const joined = body.layer;
  assert.deepEqual([joined.kind, joined.name, joined.mime, joined.width, joined.height, joined.audio, joined.alpha], ['video', 'intro + loop', 'video/mp4', 160, 90, true, false]);
  assert.deepEqual([joined.fill, joined.scale, joined.x, joined.muted, joined.repeat, joined.visible], [false, 0.5, 0.2, false, 3, true]);
  assert.ok(Math.abs(joined.duration - 2) < 0.3, String(joined.duration));
  assert.deepEqual(body.scene.layers.map(layer => (layer.kind === 'character' ? 'character' : layer.name)), ['intro', 'intro + loop', 'loop', 'logo', 'character']);
  assert.equal((await fetch(`${base}${joined.url}`)).status, 200);
  assert.ok(fsSync.existsSync(path.join(dataDir, 'media', `${joined.src}.mp4`)));
  const info = await clips.probeClip(FFPROBE, path.join(dataDir, 'media', `${joined.src}.mp4`));
  assert.deepEqual([info.codec, info.audioCodec], ['h264', 'aac']);

  // Only videos, and only layers that exist.
  response = await send('POST', `/api/scene/layers/${a.id}/join`, { with: image.id });
  assert.deepEqual([response.status, (await response.json()).code], [400, 'bad_request']);
  assert.equal((await send('POST', `/api/scene/layers/${a.id}/join`, { with: '00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.equal((await send('POST', `/api/scene/layers/${a.id}/join`, {})).status, 404);
  assert.equal((await send('POST', '/api/scene/layers/character/join', { with: a.id })).status, 400);
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'media'))).filter(name => name.includes('.tmp')), []);
});

test('pages: a video layer\'s play count and join choices, the overlay\'s play counter, and the 동작 관리 tools', () => {
  const card = require('../public/scene.js');
  const overlay = require('../public/overlay.js');
  const animate = require('../public/animate.js');
  const readPublic = name => fsSync.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

  // 화면 구성: 계속 반복 or N번만 재생; a count that is not one of the usual ones is offered too.
  assert.deepEqual(card.repeatChoices(0).map(choice => choice.value), [0, 1, 2, 3, 4, 5, 10, 20]);
  assert.deepEqual(card.repeatChoices(undefined)[0], { value: 0, label: '계속 반복' });
  assert.deepEqual(card.repeatChoices(3).find(choice => choice.value === 3), { value: 3, label: '3번만 재생' });
  assert.deepEqual(card.repeatChoices(7).map(choice => choice.value), [0, 1, 2, 3, 4, 5, 7, 10, 20]);
  const view = {
    layers: [
      { id: 'a', kind: 'video', name: '배경' }, { id: 'b', kind: 'image', name: '로고' },
      { id: 'character', kind: 'character' }, { id: 'c', kind: 'video', name: '인트로' },
    ],
  };
  assert.deepEqual(card.joinChoices(view, 'a'), [{ id: 'c', name: '인트로' }]);
  assert.deepEqual(card.joinChoices(view, 'b'), [{ id: 'c', name: '인트로' }, { id: 'a', name: '배경' }]);
  assert.deepEqual(card.joinChoices(null, 'a'), []);

  // The overlay: a clip with a count is started again until the count is reached.
  assert.deepEqual([overlay.repeatOf({ repeat: 3 }), overlay.repeatOf({ repeat: 0 }), overlay.repeatOf({ repeat: '3' }), overlay.repeatOf({}), overlay.repeatOf(null)], [3, 0, 0, 0, 0]);
  assert.deepEqual([overlay.playsAgain(1, 3), overlay.playsAgain(2, 3), overlay.playsAgain(3, 3), overlay.playsAgain(9, 0)], [true, true, false, true]);
  const overlayJs = readPublic('overlay.js');
  assert.match(overlayJs, /data\.type === 'scene-replay'/);
  assert.match(overlayJs, /el\.loop = repeat === 0;/);
  assert.match(overlayJs, /if \(el\.paused && el\.dataset\.done !== '1'\) playSceneVideo\(el\);/);

  // 동작 관리: the count field, and the panel's parts.
  assert.deepEqual([animate.clipTimes('2'), animate.clipTimes(' 20 '), animate.clipTimes(3)], [2, 20, 3]);
  for (const bad of ['1', '21', '2.5', '', 'x', null, '-3']) assert.equal(animate.clipTimes(bad), null, String(bad));
  const html = readPublic('animate.html');
  for (const id of ['clipTools', 'repeatMotion', 'repeatTimes', 'repeatBtn', 'joinFirst', 'joinSecond', 'joinBtn']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.ok(html.indexOf('id="motionTiles"') < html.indexOf('id="clipTools"') && html.indexOf('id="clipTools"') < html.indexOf('id="motionsStatus"'));
  const js = readPublic('animate.js');
  assert.match(js, /\/api\/media\/\$\{encodeURIComponent\(repeatMotion\.value\)\}\/repeat/);
  assert.match(js, /\/api\/media\/\$\{encodeURIComponent\(joinFirst\.value\)\}\/join/);
  const sceneJs = readPublic('scene.js');
  assert.match(sceneJs, /\/replay/);
  assert.match(sceneJs, /\/join/);
});
