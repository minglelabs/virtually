'use strict';

// 영상 관리: the account's video library (lib/videos.js), the editor's timeline helpers
// (public/videos.js) and its render, pieces of clips in lib/clips.js, and the broadcast
// page's picks (a saved video as a layer, another character or photo on air).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const clips = require('../lib/clips');
const videos = require('../lib/videos');
const H = require('../public/videos.js');

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
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const readPublic = name => fsSync.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

// The average colour of the frame at `at` seconds: [r, g, b].
function colourAt(file, at) {
  const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [raw[0], raw[1], raw[2]];
}
const isRed = ([r, g, b]) => r > 150 && g < 90 && b < 90;
const isBlue = ([r, g, b]) => b > 150 && r < 90 && g < 90;
const isGreen = ([r, g, b]) => g > 90 && r < 90 && b < 90;

test('timeline helpers: lengths, the piece under the playhead, split, move, paste, drop', () => {
  const a = { key: 'a', video: ID_A, start: 0, end: 4 };
  const b = { key: 'b', video: ID_B, start: 1, end: 3 };
  const line = [a, b];
  assert.equal(H.totalOf(line), 6);
  assert.deepEqual(H.startsOf(line), [0, 4]);
  assert.deepEqual(H.pieceOf({ id: ID_A, duration: 2.3456 }, 'k'), { key: 'k', video: ID_A, start: 0, end: 2.346 });

  // A border belongs to the piece that begins there; the very end to the last piece; out of range is clamped.
  assert.deepEqual(H.locate(line, 1.5), { index: 0, at: 0, source: 1.5 });
  assert.deepEqual(H.locate(line, 4), { index: 1, at: 4, source: 1 });
  assert.deepEqual(H.locate(line, 5), { index: 1, at: 4, source: 2 });
  assert.deepEqual(H.locate(line, 99), { index: 1, at: 4, source: 3 });
  assert.deepEqual(H.locate(line, -1), { index: 0, at: 0, source: 0 });
  assert.equal(H.locate([], 1), null);

  // Split: the piece under the playhead becomes two; too close to an edge changes nothing.
  assert.deepEqual(H.split(line, 5, 'c'), [a, { key: 'b', video: ID_B, start: 1, end: 2 }, { key: 'c', video: ID_B, start: 2, end: 3 }]);
  assert.deepEqual(H.split(line, 1, 'c'), [{ ...a, end: 1 }, { ...a, key: 'c', start: 1 }, b]);
  assert.equal(H.split(line, 4, 'c'), line);
  assert.equal(H.split(line, 0.05, 'c'), line);
  assert.equal(H.split(line, 5.95, 'c'), line);
  assert.equal(H.split([], 1, 'c').length, 0);
  assert.equal(H.totalOf(H.split(line, 5, 'c')), 6, 'a split changes no length');

  // Move: before what was at `to`; the same list when nothing changes.
  const c = { key: 'c', video: ID_A, start: 0, end: 1 };
  const three = [a, b, c];
  assert.deepEqual(H.move(three, 0, 3).map(clip => clip.key), ['b', 'c', 'a']);
  assert.deepEqual(H.move(three, 2, 0).map(clip => clip.key), ['c', 'a', 'b']);
  assert.deepEqual(H.move(three, 0, 2).map(clip => clip.key), ['b', 'a', 'c']);
  assert.equal(H.move(three, 1, 1), three);
  assert.equal(H.move(three, 1, 2), three);
  assert.equal(H.move(three, 9, 0), three);
  assert.deepEqual(H.removeAt(three, 1).map(clip => clip.key), ['a', 'c']);
  assert.deepEqual(H.insertAt(three, 1, { key: 'x' }).map(clip => clip.key), ['a', 'x', 'b', 'c']);
  assert.deepEqual(H.insertAt(three, 99, { key: 'x' }).map(clip => clip.key), ['a', 'b', 'c', 'x']);

  // Paste: after the piece under the playhead; at the very start, before everything.
  assert.equal(H.pasteIndex(three, 0), 0);
  assert.equal(H.pasteIndex(three, 2), 1);
  assert.equal(H.pasteIndex(three, 4.5), 2);
  assert.equal(H.pasteIndex(three, 7), 3);
  assert.equal(H.pasteIndex([], 3), 0);

  // A drag: the border nearest to the pointer (10 px per second).
  assert.equal(H.dropIndex(three, 10, 5), 0);
  assert.equal(H.dropIndex(three, 10, 25), 1);
  assert.equal(H.dropIndex(three, 10, 55), 2);
  assert.equal(H.dropIndex(three, 10, 68), 3);

  assert.deepEqual(H.segmentsOf(line), [{ video: ID_A, start: 0, end: 4 }, { video: ID_B, start: 1, end: 3 }]);
});

test('timeline helpers: the texts, the zoom, the ruler, mixed backgrounds', () => {
  assert.equal(H.timeText(0), '0:00.0');
  assert.equal(H.timeText(65.34), '1:05.3');
  assert.equal(H.timeText(-3), '0:00.0');
  assert.equal(H.lengthText(12.4), '12초');
  assert.equal(H.lengthText(65), '1분 5초');
  assert.equal(H.lengthText(120), '2분');
  assert.equal(H.metaText({ width: 1920, height: 1080, duration: 12, alpha: false, audio: true }), '1920×1080 · 12초 · 소리 있음');
  assert.equal(H.metaText({ width: 500, height: 800, duration: 3, alpha: true, audio: false }), '500×800 · 3초 · 투명 배경');
  assert.equal(H.pxPerSecond(0), 4);
  assert.equal(H.pxPerSecond(100), 240);
  assert.ok(H.pxPerSecond(40) > 4 && H.pxPerSecond(40) < H.pxPerSecond(60));
  // Ten seconds on 800 px: the slider lands where they just fit.
  const fit = H.zoomToFit(10, 800);
  assert.ok(Math.abs(H.pxPerSecond(fit) * 10 - 800) < 40, String(H.pxPerSecond(fit)));
  assert.equal(H.zoomToFit(0, 800), 40);
  assert.equal(H.zoomToFit(100000, 800), 0);
  assert.equal(H.tickStep(240), 0.5);
  assert.equal(H.tickStep(40), 2);
  assert.equal(H.tickStep(4), 30);
  const kinds = { [ID_A]: { alpha: true }, [ID_B]: { alpha: false } };
  const of = id => kinds[id];
  assert.equal(H.mixedAlpha([{ video: ID_A }, { video: ID_B }], of), true);
  assert.equal(H.mixedAlpha([{ video: ID_A }, { video: ID_A }], of), false);
  assert.equal(H.mixedAlpha([], of), false);
  assert.equal(H.hueOf(ID_A), H.hueOf(ID_A));
  assert.ok(H.hueOf(ID_A) >= 0 && H.hueOf(ID_A) < 360);
  assert.equal(H.saveNameOf({ name: '바다' }), '바다 편집');
});

test('parseVideos and checkSegments: malformed records go; a piece runs inside its video', () => {
  const list = videos.parseVideos({
    videos: [
      { id: ID_A, name: ' 바다\n영상 ', mime: 'video/mp4', width: 320, height: 180, duration: 4, audio: true },
      { id: ID_A, mime: 'video/mp4' },
      { id: ID_B, mime: 'image/png' },
      { id: 'nope', mime: 'video/webm' },
      null,
    ],
  });
  assert.deepEqual(list, [{ id: ID_A, name: '바다 영상', mime: 'video/mp4', createdAt: null, width: 320, height: 180, duration: 4, alpha: false, audio: true, source: null }]);
  assert.deepEqual(videos.parseVideos(null), []);
  assert.deepEqual(videos.videosView(list)[0].url, `/api/media/${ID_A}`);

  const find = id => list.find(video => video.id === id) || null;
  assert.deepEqual(videos.checkSegments([{ video: ID_A, start: 1, end: 2.5 }, { video: ID_A }], find).map(item => [item.video.id, item.start, item.end]), [[ID_A, 1, 2.5], [ID_A, 0, 4]]);
  // Past the end is cut to the end.
  assert.equal(videos.checkSegments([{ video: ID_A, start: 3, end: 99 }], find)[0].end, 4);
  const refused = (value, code) => assert.throws(() => videos.checkSegments(value, find), error => error.code === code, JSON.stringify(value));
  refused([], 'bad_segments');
  refused('x', 'bad_segments');
  refused([{ video: ID_A, start: 2, end: 2 }], 'bad_segments');
  refused([{ video: ID_A, start: -1, end: 2 }], 'bad_segments');
  refused([{ video: ID_A, start: '1', end: 2 }], 'bad_segments');
  refused([{ video: ID_A, start: 5, end: 9 }], 'bad_segments');
  refused([{ video: 'nope' }], 'bad_segments');
  refused([{ video: ID_B }], 'video_missing');
  refused(Array.from({ length: videos.MAX_SEGMENTS + 1 }, () => ({ video: ID_A })), 'too_many_segments');
});

test('joinClips: pieces of clips, in the order asked, as one video', { skip }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-videos-clips-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Two seconds of red then two of blue, with sound; and two seconds of green without.
  const redBlue = path.join(dir, 'redblue.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', redBlue]);
  const green = path.join(dir, 'green.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', green]);
  const tools = { ffmpegPath: FFMPEG, ffprobePath: FFPROBE };

  // The blue second half first, a second of green, then the first second of red.
  const made = await clips.joinClips({
    ...tools, workDir: dir,
    parts: [{ path: redBlue, start: 2.5, end: 3.5 }, { path: green, start: 0.5, end: 1.5 }, { path: redBlue, start: 0, end: 1 }],
  });
  assert.deepEqual([made.mime, made.alpha, made.audio, made.width, made.height], ['video/mp4', false, true, 160, 90]);
  assert.ok(Math.abs(made.duration - 3) < 0.3, String(made.duration));
  assert.ok(isBlue(colourAt(made.path, 0.5)), 'blue first');
  assert.ok(isGreen(colourAt(made.path, 1.5)), 'then green');
  assert.ok(isRed(colourAt(made.path, 2.5)), 'then red');

  // One piece of one clip is a trim; the whole of one clip is nothing to do.
  const trimmed = await clips.joinClips({ ...tools, workDir: dir, parts: [{ path: redBlue, start: 1.5, end: 2.5 }] });
  assert.ok(Math.abs(trimmed.duration - 1) < 0.25, String(trimmed.duration));
  assert.ok(isRed(colourAt(trimmed.path, 0.2)) && isBlue(colourAt(trimmed.path, 0.8)));
  await assert.rejects(clips.joinClips({ ...tools, workDir: dir, parts: [{ path: redBlue }] }), error => error.code === 'unsupported_clip');
  await assert.rejects(clips.joinClips({ ...tools, workDir: dir, parts: [{ path: redBlue, start: 3, end: 3.01 }] }), error => error.code === 'bad_piece');
  await assert.rejects(clips.joinClips({ ...tools, workDir: dir, maxSeconds: 2, parts: [{ path: redBlue }, { path: green }] }), error => error.code === 'too_long');
});

async function openServer(t, prefix) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const open = async () => {
    const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const state = { server: await open() };
  const shut = async () => {
    state.server.closeAllConnections();
    await new Promise(resolve => state.server.close(resolve));
  };
  t.after(async () => {
    await shut().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const base = () => `http://127.0.0.1:${state.server.address().port}`;
  const send = (method, pathname, body) => fetch(`${base()}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const restart = async () => {
    await shut();
    state.server = await open();
  };
  return { dataDir, base, send, restart };
}

test('routes: upload, list, rename, render a timeline, put on the scene, delete; the record survives a restart', { skip }, async (t) => {
  const { dataDir, base, send, restart } = await openServer(t, 'virtually-videos-');
  const files = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-videos-files-'));
  t.after(() => fs.rm(files, { recursive: true, force: true }));
  const red = path.join(files, 'red.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=2', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', red]);
  const blue = path.join(files, 'blue.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=120x120:r=10:d=2', '-c:v', 'libvpx-vp9', '-b:v', '50k', blue]);
  const png = path.join(files, 'logo.png');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', png]);
  const upload = (file, name = path.basename(file)) => fetch(`${base()}/api/videos?name=${encodeURIComponent(name)}`, { method: 'POST', body: fsSync.readFileSync(file) });

  assert.deepEqual(await (await send('GET', '/api/videos')).json(), { videos: [] });
  assert.equal((await fetch(`${base()}/videos`)).status, 200);

  let response = await upload(red, '빨강 배경.mp4');
  assert.equal(response.status, 201);
  let body = await response.json();
  const a = body.video;
  assert.deepEqual({ ...a, id: null, createdAt: null, duration: null }, {
    id: null, name: '빨강 배경', mime: 'video/mp4', createdAt: null, width: 160, height: 90, duration: null, alpha: false, audio: false, source: null, url: `/api/media/${a.id}`,
  });
  assert.ok(Math.abs(a.duration - 2) < 0.2);
  const b = (await (await upload(blue)).json()).video;
  // The newest first.
  assert.deepEqual((await (await send('GET', '/api/videos')).json()).videos.map(video => video.name), ['blue', '빨강 배경']);
  // Only videos are kept here.
  response = await upload(png);
  assert.deepEqual([response.status, (await response.json()).code], [415, 'not_a_video']);
  assert.equal((await fetch(`${base()}/api/videos`, { method: 'POST', body: 'hello, this is text' })).status, 415);
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'media'))).filter(name => name.includes('.tmp')), [], 'no work folder is left');

  // Served with ranges; ?download=1 as a file to save, under its name.
  response = await fetch(`${base()}${a.url}`, { headers: { Range: 'bytes=0-9' } });
  assert.deepEqual([response.status, response.headers.get('content-type')], [206, 'video/mp4']);
  await response.arrayBuffer();
  response = await fetch(`${base()}${a.url}?download=1`);
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="video\.mp4"; filename\*=UTF-8''%EB%B9%A8%EA%B0%95%20%EB%B0%B0%EA%B2%BD\.mp4$/);
  await response.arrayBuffer();

  // Rename.
  body = await (await send('PATCH', `/api/videos/${a.id}`, { name: '  빨강  ' })).json();
  assert.equal(body.videos.find(video => video.id === a.id).name, '빨강');
  assert.equal((await send('PATCH', `/api/videos/${a.id}`, { name: '   ' })).status, 400);
  assert.equal((await send('PATCH', `/api/videos/${ID_A}`, { name: 'x' })).status, 404);

  // Render: the second half of red, the whole of blue, then red's first half second -> one new video.
  response = await send('POST', '/api/videos/render', {
    name: '합친 영상',
    segments: [{ video: a.id, start: 1, end: 2 }, { video: b.id, start: 0, end: 2 }, { video: a.id, start: 0, end: 0.5 }],
  });
  assert.equal(response.status, 201);
  body = await response.json();
  const made = body.video;
  assert.deepEqual([made.name, made.mime, made.width, made.height, made.alpha], ['합친 영상', 'video/mp4', 160, 90, false]);
  assert.ok(Math.abs(made.duration - 3.5) < 0.3, String(made.duration));
  assert.deepEqual(made.source, { segments: [{ video: a.id, start: 1, end: 2 }, { video: b.id, start: 0, end: 2 }, { video: a.id, start: 0, end: 0.5 }] });
  assert.deepEqual(body.videos.map(video => video.name), ['합친 영상', 'blue', '빨강']);
  const file = path.join(dataDir, 'media', `${made.id}.mp4`);
  assert.ok(isRed(colourAt(file, 0.5)) && isBlue(colourAt(file, 2)) && isRed(colourAt(file, 3.3)));
  // The videos it was cut from are as they were.
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'media', `${a.id}.mp4`)), await fs.readFile(red));
  // Without a name it is named after its first piece.
  body = await (await send('POST', '/api/videos/render', { segments: [{ video: b.id, start: 0.5, end: 1.5 }] })).json();
  assert.deepEqual([body.video.name, body.video.mime], ['blue 편집', 'video/mp4']);
  assert.equal((await send('POST', '/api/videos/render', { segments: [] })).status, 400);
  assert.equal((await send('POST', '/api/videos/render', { segments: [{ video: ID_A }] })).status, 404);
  assert.equal((await send('POST', '/api/videos/render', { segments: [{ video: a.id, start: 1, end: 1 }] })).status, 400);
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'media'))).filter(name => name.includes('.tmp')), []);

  // On the scene: the saved video as a layer; a restart keeps the library and the layer.
  body = await (await fetch(`${base()}/api/scene/layers?video=${made.id}`, { method: 'POST' })).json();
  assert.deepEqual([body.layer.src, body.layer.name, body.layer.url], [made.id, '합친 영상', `/api/media/${made.id}`]);
  await restart();
  assert.deepEqual((await (await send('GET', '/api/videos')).json()).videos.map(video => video.name), ['blue 편집', '합친 영상', 'blue', '빨강']);
  assert.deepEqual((await (await send('GET', '/api/scene')).json()).layers.map(layer => layer.src || layer.id), [made.id, 'character']);
  assert.equal((await fetch(`${base()}${made.url}`)).status, 200);

  // Delete: the file goes, and the scene's layer with it.
  body = await (await send('DELETE', `/api/videos/${made.id}`)).json();
  assert.deepEqual(body.videos.map(video => video.name), ['blue 편집', 'blue', '빨강']);
  assert.equal(fsSync.existsSync(file), false);
  assert.deepEqual((await (await send('GET', '/api/scene')).json()).layers.map(layer => layer.id), ['character']);
  assert.equal((await send('DELETE', `/api/videos/${made.id}`)).status, 404);
  assert.equal((await fetch(`${base()}${made.url}`)).status, 404);
});

test('a scene from before the library: its video layers become videos of the library, the files where they were', { skip }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-videos-old-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, 'media'), { recursive: true });
  const file = path.join(dataDir, 'media', `${ID_A}.mp4`);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  const old = { id: ID_A, kind: 'video', name: '예전 배경', mime: 'video/mp4', createdAt: '2026-10-05T00:00:00.000Z', width: 160, height: 90, duration: 1, fill: false, scale: 0.5, repeat: 2 };
  await fs.writeFile(path.join(dataDir, 'scene.json'), JSON.stringify({ layers: [old, { id: 'character', kind: 'character' }] }));

  const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scene = await (await fetch(`${base}/api/scene`)).json();
  assert.deepEqual([scene.layers[0].id, scene.layers[0].src, scene.layers[0].url, scene.layers[0].scale, scene.layers[0].repeat], [ID_A, ID_A, `/api/media/${ID_A}`, 0.5, 2]);
  const list = (await (await fetch(`${base}/api/videos`)).json()).videos;
  assert.deepEqual(list.map(video => [video.id, video.name, video.createdAt]), [[ID_A, '예전 배경', '2026-10-05T00:00:00.000Z']]);
  assert.equal((await fetch(`${base}/api/media/${ID_A}`)).status, 200);
  // Off the scene, it stays in the library.
  await fetch(`${base}/api/scene/layers/${ID_A}`, { method: 'DELETE' });
  assert.ok(fsSync.existsSync(file));
  assert.equal((await (await fetch(`${base}/api/videos`)).json()).videos.length, 1);
});

test('pages: the 영상 관리 tab everywhere, the editor page, and the broadcast page\'s picks', () => {
  const tab = '<a href="/videos" class="topnav-tab">영상 관리</a>';
  for (const page of ['index.html', 'animate.html', 'characters.html', 'billing.html']) {
    assert.ok(readPublic(page).includes(tab), page);
  }
  const html = readPublic('videos.html');
  assert.ok(html.includes('<a href="/videos" class="topnav-tab" aria-current="page">영상 관리</a>'));
  const js = readPublic('videos.js');
  // Every element the script looks up exists once.
  const ids = [...js.matchAll(/\$\('([A-Za-z]+)'\)/g)].map(match => match[1]);
  assert.ok(ids.length > 25);
  for (const id of ids) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /call\('POST', '\/api\/videos\/render', \{ name: saveName\.value\.trim\(\), segments: H\.segmentsOf\(clips\) \}\)/);
  assert.match(html, /<script src="\.\/auth\.js"><\/script>\s*<script src="\.\/videos\.js"><\/script>/);

  // 방송 화면: a saved video as a layer, and the character picker.
  const index = readPublic('index.html');
  for (const id of ['sceneVideoPick', 'sceneVideoAdd', 'onAirPicker', 'onAirPickerList', 'onAirPickerStatus', 'onAirChange']) {
    assert.equal(index.split(`id="${id}"`).length - 1, 1, id);
  }
  const card = require('../public/scene.js');
  assert.deepEqual(card.savedChoices([{ id: ID_A, name: '바다' }, null, { name: 'no id' }]), [{ id: ID_A, name: '바다' }]);
  assert.deepEqual(card.savedChoices(null), []);
  assert.match(card.deleteText({ kind: 'video', name: '바다' }), /영상 관리에 남습니다/);
  assert.match(card.deleteText({ kind: 'image', name: '로고' }), /올린 파일도 지워집니다/);
  assert.equal(card.editHref({ kind: 'video', src: ID_A }), `/videos?edit=${ID_A}`);
  assert.equal(card.editHref({ kind: 'image', id: ID_A }), '');
  assert.match(readPublic('scene.js'), /call\('POST', `\/api\/scene\/layers\?video=\$\{encodeURIComponent\(videoPick\.value\)\}`\)/);

  const app = require('../public/app.js');
  assert.deepEqual(app.pickerRows({
    characters: [
      { id: 'c1', name: '미나', photos: [{ id: 'p1', url: '/api/media/p1', displayUrl: '/api/media/p1?variant=cutout', onAir: true }, { id: 'p2', url: '/api/media/p2' }] },
      { id: 'c2', name: '빈 캐릭터', photos: [] },
    ],
  }), [{
    id: 'c1', name: '미나', photos: [
      { id: 'p1', url: '/api/media/p1?variant=cutout', label: '사진 1', onAir: true },
      { id: 'p2', url: '/api/media/p2', label: '사진 2', onAir: false },
    ],
  }]);
  assert.deepEqual(app.pickerRows(null), []);
  assert.match(readPublic('app.js'), /fetch\('\/api\/active-photo', \{\s*method: 'PUT'/);
});
