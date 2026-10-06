'use strict';

// The scene (lib/scene.js): the video and image layers around the character. The record,
// the order and the placement rules, the routes with real uploads (ffmpeg), what the overlay
// draws from it (public/overlay.js) and the controller's card (public/scene.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const scene = require('../lib/scene');
const overlay = require('../public/overlay.js');
const card = require('../public/scene.js');

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
const CHARACTER = { id: 'character', kind: 'character', visible: true, scale: 1, x: 0, y: 0 };
const readPublic = name => fsSync.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('parseScene: the character is always there; malformed and repeated layers go; numbers are kept in range', () => {
  assert.deepEqual(scene.parseScene(null), { layers: [CHARACTER] });
  assert.deepEqual(scene.parseScene({ layers: 'no' }), { layers: [CHARACTER] });
  const parsed = scene.parseScene({
    layers: [
      { id: ID_A, kind: 'video', name: '  배경\n영상  ', mime: 'video/mp4', width: 1280, height: 720, duration: 4, audio: true, fill: false, scale: 99, x: -9, y: 'no', muted: false },
      { id: ID_A, kind: 'video', mime: 'video/mp4' }, // the same id again
      { id: 'not-an-id', kind: 'video', mime: 'video/mp4' },
      { id: ID_B, kind: 'video', mime: 'image/png' }, // the kind and the type disagree
      { id: 'character', scale: 0.5, x: 0.25, visible: false, extra: 1 },
      { id: 'character' },
      null,
    ],
  });
  assert.deepEqual(parsed.layers.map(layer => layer.id), [ID_A, 'character']);
  assert.deepEqual(parsed.layers[0], {
    id: ID_A, kind: 'video', name: '배경 영상', mime: 'video/mp4', createdAt: null, width: 1280, height: 720, duration: 4,
    alpha: false, audio: true, visible: true, fill: false, scale: scene.SCALE_MAX, x: -scene.OFFSET_MAX, y: 0, muted: false, repeat: 0, src: null,
  });
  assert.deepEqual(parsed.layers[1], { id: 'character', kind: 'character', visible: false, scale: 0.5, x: 0.25, y: 0 });
  // What the pages get: a url for each file, none for the character.
  assert.deepEqual(scene.sceneView(parsed).layers.map(layer => layer.url), [`/api/media/${ID_A}`, undefined]);
});

test('moveLayer: top, up, down, bottom; the same list when it is already there; unknown ids and moves are refused', () => {
  const layers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ids = (id, to) => scene.moveLayer(layers, id, to).map(layer => layer.id);
  assert.deepEqual(ids('a', 'top'), ['b', 'c', 'a']);
  assert.deepEqual(ids('a', 'up'), ['b', 'a', 'c']);
  assert.deepEqual(ids('c', 'down'), ['a', 'c', 'b']);
  assert.deepEqual(ids('c', 'bottom'), ['c', 'a', 'b']);
  assert.equal(scene.moveLayer(layers, 'c', 'top'), layers);
  assert.equal(scene.moveLayer(layers, 'c', 'up'), layers);
  assert.equal(scene.moveLayer(layers, 'a', 'down'), layers);
  assert.throws(() => scene.moveLayer(layers, 'x', 'top'), { status: 404, code: 'layer_missing' });
  assert.throws(() => scene.moveLayer(layers, 'a', 'sideways'), { status: 400, code: 'bad_request' });
});

test('patchLayer: only the fields a layer has, of the right type', () => {
  const video = scene.parseScene({ layers: [{ id: ID_A, kind: 'video', name: 'bg', mime: 'video/webm', audio: true }] }).layers[0];
  const image = { ...video, kind: 'image', mime: 'image/png' };
  assert.deepEqual(scene.patchLayer(video, { visible: false, fill: false, muted: false, scale: 0.5, x: 0.1, y: -0.2, name: ' 새 이름 ' }),
    { ...video, visible: false, fill: false, muted: false, scale: 0.5, x: 0.1, y: -0.2, name: '새 이름' });
  assert.equal(scene.patchLayer(video, { scale: 0.001 }).scale, scene.SCALE_MIN);
  // An image has no sound, the character no name, fill or sound: those alone change nothing.
  assert.throws(() => scene.patchLayer(image, { muted: false }), { status: 400 });
  assert.throws(() => scene.patchLayer(CHARACTER, { fill: false, name: 'x', muted: false }), { status: 400 });
  assert.deepEqual(scene.patchLayer(CHARACTER, { scale: 2, x: 0.5, fill: false }), { ...CHARACTER, scale: 2, x: 0.5 });
  for (const bad of [null, [], 'x', {}, { visible: 'yes' }, { scale: '2' }, { x: NaN }, { name: '  ' }, { fill: 1 }]) {
    assert.throws(() => scene.patchLayer(video, bad), { status: 400, code: 'bad_request' }, JSON.stringify(bad));
  }
});

test('overlay.js: the layers it draws, where a free layer goes, and the character transform', () => {
  assert.deepEqual(overlay.sceneLayers(null), [CHARACTER]);
  const layers = overlay.sceneLayers({
    layers: [
      { id: ID_A, kind: 'video', url: `/api/media/${ID_A}` },
      { id: ID_B, kind: 'image' }, // no url: not drawn
      { id: 'character', kind: 'character', scale: 0.5 },
      { id: ID_A, kind: 'video', url: '/again' },
      'junk',
    ],
  });
  assert.deepEqual(layers.map(layer => layer.id), [ID_A, 'character']);
  assert.deepEqual(layers[1], { ...CHARACTER, scale: 0.5 });
  assert.deepEqual(overlay.sceneLayers({ layers: [{ id: ID_A, kind: 'image', url: '/x' }] }).map(layer => layer.id), [ID_A, 'character']);

  const canvas = { width: 800, height: 600 };
  // A 16:9 clip fitted into 4:3 is 800 x 450; half of it, a quarter of the canvas to the right and up.
  assert.deepEqual(overlay.placeFree(canvas, { width: 1920, height: 1080, scale: 0.5, x: 0.25, y: -0.25 }), { left: 400, top: 37.5, width: 400, height: 225 });
  assert.deepEqual(overlay.placeFree(canvas, { width: 400, height: 300 }), { left: 0, top: 0, width: 800, height: 600 });
  // The element's real size wins over the record.
  assert.deepEqual(overlay.placeFree(canvas, { width: 1, height: 9, scale: 1 }, { width: 300, height: 600 }), { left: 250, top: 0, width: 300, height: 600 });
  assert.equal(overlay.placeFree(canvas, { scale: 1 }), null);
  assert.equal(overlay.placeFree(null, { width: 4, height: 3 }), null);

  assert.equal(overlay.characterTransform(canvas, CHARACTER), '');
  assert.equal(overlay.characterTransform(canvas, { scale: 0.5, x: 0.1, y: -0.5 }), 'translate(80px, -300px) scale(0.5)');
  assert.equal(overlay.characterTransform(canvas, { scale: -1, x: 'a' }), '');
});

test('overlay.html / overlay.css / overlay.js: the character is one box of the stage, the layers are added next to it', () => {
  const html = readPublic('overlay.html');
  assert.match(html, /<div id="stage" class="stage">[\s\S]*<div id="character" class="character">\s*<!--[\s\S]*?-->\s*<div id="demo-layer"/);
  // The three character layers are inside the box; the outline is outside it.
  const box = html.slice(html.indexOf('<div id="character"'), html.indexOf('<div id="scene-outline"'));
  for (const id of ['demo-layer', 'idle-layer', 'reaction-layer']) assert.ok(box.includes(`id="${id}"`), id);
  assert.match(html, /<div id="scene-outline" class="scene-outline" hidden><\/div>/);
  const css = readPublic('overlay.css');
  assert.match(css, /\.character \{[^}]*position: absolute;[^}]*inset: 0;[^}]*transform-origin: 50% 100%;/);
  assert.match(css, /\.scene-layer \{[^}]*object-fit: cover;/);
  assert.match(css, /\.scene-layer\.is-free \{\s*object-fit: contain;/);
  const js = readPublic('overlay.js');
  // The scene comes with the stream's 'scene' messages and GET /api/scene (the overlay key may read both).
  assert.match(js, /data\.type === 'scene'/);
  assert.match(js, /fetch\('\/api\/scene'/);
  // The preview never plays sound, and the demo avatar is measured inside the (scaled) character box.
  assert.match(js, /const sound = !IS_PREVIEW && layer\.muted === false/);
  assert.match(js, /const r = localRect\(demoAvatar\);/);
});

test('scene.js helpers: rows front first, what can be placed, the slider, a drag, the card title', () => {
  const view = {
    layers: [
      { id: ID_A, kind: 'video', name: '배경', visible: true, fill: true },
      { id: 'character', kind: 'character', visible: true, scale: 1, x: 0, y: 0 },
      { id: ID_B, kind: 'image', name: '로고', visible: false, fill: false, scale: 0.3, x: 0.4, y: -0.4 },
    ],
  };
  assert.deepEqual(card.rows(view, ' 미나 '), [
    { id: ID_B, kind: 'image', tag: '이미지', name: '로고', visible: false, front: true, back: false },
    { id: 'character', kind: 'character', tag: '캐릭터', name: '미나', visible: true, front: false, back: false },
    { id: ID_A, kind: 'video', tag: '영상', name: '배경', visible: true, front: false, back: true },
  ]);
  assert.equal(card.rows(view)[1].name, '데모 캐릭터');
  assert.deepEqual(card.rows(null), []);
  assert.equal(card.countText(view), '영상 1 · 이미지 1');
  assert.equal(card.countText({ layers: [view.layers[1]] }), '');
  assert.equal(card.mediaCount(view), 2);

  assert.equal(card.canPlace(view.layers[0]), false, 'a layer that fills the canvas has no size or place');
  assert.equal(card.canPlace(view.layers[1]), true);
  assert.equal(card.canPlace(view.layers[2]), true);
  assert.equal(card.canPlace(null), false);

  assert.deepEqual([card.percentOf(0.3), card.percentOf(1), card.percentOf(9), card.percentOf(0), card.percentOf('x')], [30, 100, 300, 100, 100]);
  assert.deepEqual([card.scaleOf(30), card.scaleOf('250'), card.scaleOf(1), card.scaleOf(999), card.scaleOf('x')], [0.3, 2.5, 0.05, 3, 1]);

  assert.deepEqual(card.dragged({ x: 0.4, y: -0.4 }, 0.1, 0.25), { x: 0.5, y: -0.15 });
  assert.deepEqual(card.dragged({ x: 1.4, y: 0 }, 5, -5), { x: 1.5, y: -1.5 });
  assert.deepEqual(card.dragged(null, 0.1, 'x'), { x: 0.1, y: 0 });

  const moved = card.withLayer(view, ID_B, { x: 0, scale: 1 });
  assert.deepEqual(moved.layers[2], { ...view.layers[2], x: 0, scale: 1 });
  assert.equal(view.layers[2].x, 0.4, 'the scene itself is not changed');

  assert.equal(card.uploadPath('내 배경 #1.mp4'), '/api/scene/layers?name=%EB%82%B4%20%EB%B0%B0%EA%B2%BD%20%231.mp4');
  assert.equal(card.contentType({ type: '' }), 'application/octet-stream');
  assert.equal(card.contentType({ type: 'video/mp4' }), 'video/mp4');
  assert.equal(card.uploadText(0, 1, 40), '올리는 중… 40%');
  assert.equal(card.uploadText(1, 3, 40), '올리는 중… (2/3) 40%');
  assert.equal(card.uploadText(1, 3, null), '영상을 확인하는 중… (2/3)');
});

test('the 방송 화면 page: every element scene.js looks up exists once; the canvas takes the pointer only while placing', () => {
  const html = readPublic('index.html');
  const js = readPublic('scene.js');
  const ids = [...js.matchAll(/\$\('([A-Za-z]+)'\)/g)].map(match => match[1]);
  assert.ok(ids.includes('sceneCard') && ids.includes('canvasBox') && ids.includes('overlayPreviewFrame'));
  for (const id of ids) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  assert.match(html, /<script src="\.\/director\.js"><\/script>\s*<script src="\.\/scene\.js"><\/script>/);
  const css = readPublic('app.css');
  assert.match(css, /\.canvas\.is-placing iframe \{ pointer-events: none; \}/);
  // scene.js has no event stream of its own: app.js hands its messages on.
  assert.doesNotMatch(js, /EventSource|liveEvents/);
  const app = readPublic('app.js');
  assert.match(app, /new CustomEvent\('virtually:live', \{ detail: data \}\)/);
  assert.match(app, /new CustomEvent\('virtually:live-open'\)/);
});

test('routes: upload, list, serve, patch, move, delete; the stream tells every change; the record survives a restart', { skip }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-scene-'));
  const files = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-scene-files-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(files, { recursive: true, force: true });
  });
  const mp4 = path.join(files, 'bg.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
  const webm = path.join(files, 'loop.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=10:d=1', '-c:v', 'libvpx-vp9', '-b:v', '50k', webm]);
  const mov = path.join(files, 'phone.mov');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=10:d=1', '-c:v', 'mpeg4', '-q:v', '5', mov]);
  const h264mov = path.join(files, 'camera.mov');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', '-f', 'mov', h264mov]);
  const png = path.join(files, 'logo.png');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', png]);
  const jpg = path.join(files, 'photo.jpg');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=64x48', '-frames:v', '1', jpg]);

  const open = async () => {
    const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const shut = async (server) => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  let { server, base } = await open();
  t.after(() => shut(server).catch(() => {}));
  const send = (method, pathname, body) => fetch(`${base}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const upload = (file, name = path.basename(file)) => fetch(`${base}/api/scene/layers?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fsSync.readFileSync(file),
  });
  const names = view => view.layers.map(layer => (layer.kind === 'character' ? 'character' : layer.name));

  assert.deepEqual(await (await send('GET', '/api/scene')).json(), { layers: [CHARACTER] });

  // The page's event stream: nothing about the scene at connect (GET /api/scene is asked), then every change.
  const stream = await fetch(`${base}/api/events`);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  let buffered = '';
  const heard = [];
  const nextScene = async () => {
    for (;;) {
      const at = heard.findIndex(message => message.type === 'scene');
      if (at >= 0) return heard.splice(0, at + 1).pop();
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffered += decoder.decode(value, { stream: true });
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop();
      for (const block of blocks) if (block.startsWith('data: ')) heard.push(JSON.parse(block.slice(6)));
    }
  };

  // The scene of the next messages until it is `expected` (earlier changes may still be on their way).
  const untilScene = async (expected) => {
    for (let i = 0; i < 20; i += 1) {
      const message = await nextScene();
      if (JSON.stringify(message.scene) === JSON.stringify(expected)) return message;
    }
    throw new Error('the scene never arrived');
  };

  // An MP4 a browser plays is kept as it is; it goes right behind the character and fills the canvas.
  let response = await upload(mp4, '내 배경.mp4');
  assert.equal(response.status, 201);
  let body = await response.json();
  const bg = body.layer;
  assert.deepEqual({ ...bg, id: null, createdAt: null, url: null, src: null }, {
    id: null, kind: 'video', name: '내 배경', mime: 'video/mp4', createdAt: null, width: 320, height: 180, duration: bg.duration,
    alpha: false, audio: true, visible: true, fill: true, scale: 1, x: 0, y: 0, muted: true, repeat: 0, src: null, url: null,
  });
  assert.ok(bg.duration > 0.8 && bg.duration < 1.3);
  // The video is kept in the library (영상 관리); the layer shows it.
  assert.notEqual(bg.src, bg.id);
  assert.equal(bg.url, `/api/media/${bg.src}`);
  assert.deepEqual((await (await send('GET', '/api/videos')).json()).videos.map(video => [video.id, video.name]), [[bg.src, '내 배경']]);
  assert.deepEqual(names(body.scene), ['내 배경', 'character']);
  assert.deepEqual((await nextScene()).scene, body.scene);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'media', `${bg.src}.mp4`)), await fs.readFile(mp4), 'the file as uploaded');

  // Served to the page (and to OBS) with byte ranges; the browser may keep it.
  response = await fetch(`${base}${bg.url}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal((await response.arrayBuffer()).byteLength, 10);

  // WebM as it is; an image; a clip no browser plays (MPEG-4 in a MOV) becomes an H.264 MP4, upright.
  body = await (await upload(webm)).json();
  assert.deepEqual([body.layer.mime, body.layer.width, body.layer.height, body.layer.audio], ['video/webm', 160, 120, false]);
  body = await (await upload(png)).json();
  const logo = body.layer;
  assert.deepEqual([logo.kind, logo.mime, logo.name, logo.width, logo.height], ['image', 'image/png', 'logo', 64, 48]);
  body = await (await upload(jpg)).json();
  assert.deepEqual([body.layer.kind, body.layer.mime], ['image', 'image/jpeg']);
  assert.ok(fsSync.existsSync(path.join(dataDir, 'media', `${body.layer.id}.jpg`)));
  response = await upload(mov);
  assert.equal(response.status, 201);
  body = await response.json();
  const phone = body.layer;
  assert.deepEqual([phone.mime, phone.width, phone.height, phone.audio], ['video/mp4', 180, 320, false]);
  const probed = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', path.join(dataDir, 'media', `${phone.src}.mp4`)]).toString());
  assert.deepEqual(probed.streams.map(item => [item.codec_name, item.pix_fmt]), [['h264', 'yuv420p']]);
  // An H.264 MOV is rewrapped: the picture untouched, the sound made one a browser plays.
  body = await (await upload(h264mov)).json();
  const camera = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path.join(dataDir, 'media', `${body.layer.src}.mp4`)]).toString());
  assert.deepEqual(camera.streams.map(item => item.codec_name).sort(), ['aac', 'h264']);
  assert.deepEqual([body.layer.mime, body.layer.audio], ['video/mp4', true]);
  assert.deepEqual(names(body.scene), ['내 배경', 'loop', 'logo', 'photo', 'phone', 'camera', 'character']);
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'media'))).filter(name => name.includes('.tmp')), [], 'no work folder is left');

  // Not media at all, an empty body, an unknown layer.
  response = await fetch(`${base}/api/scene/layers?name=notes.txt`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello there, this is text' });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'unsupported_media');
  assert.equal((await fetch(`${base}/api/scene/layers`, { method: 'POST', body: '' })).status, 415);
  assert.equal((await send('PATCH', `/api/scene/layers/${ID_A}`, { visible: false })).status, 404);
  assert.equal((await send('PATCH', '/api/scene/layers/nope', { visible: false })).status, 404);
  assert.equal((await send('DELETE', `/api/scene/layers/${ID_A}`)).status, 404);
  response = await send('DELETE', '/api/scene/layers/character');
  assert.deepEqual([response.status, (await response.json()).code], [400, 'character_fixed']);
  assert.equal((await fetch(`${base}/api/scene/layers/${bg.id}`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await send('PATCH', `/api/scene/layers/${bg.id}`, { scale: 'big' })).status, 400);
  assert.equal((await send('POST', `/api/scene/layers/${bg.id}/move`, { to: 'left' })).status, 400);

  // Patch: the logo no longer fills the canvas, half size, to the upper right; the sound of the background.
  body = await (await send('PATCH', `/api/scene/layers/${logo.id}`, { fill: false, scale: 0.5, x: 0.3, y: -0.3 })).json();
  assert.deepEqual(body.scene.layers.find(layer => layer.id === logo.id), { ...logo, fill: false, scale: 0.5, x: 0.3, y: -0.3 });
  await untilScene(body.scene);
  body = await (await send('PATCH', `/api/scene/layers/${bg.id}`, { muted: false, name: '바다' })).json();
  assert.deepEqual(body.scene.layers[0], { ...bg, muted: false, name: '바다' });
  assert.deepEqual((await nextScene()).scene, body.scene);
  // The same values again: nothing is written, nothing is sent.
  await send('PATCH', `/api/scene/layers/${bg.id}`, { muted: false });
  // The character: smaller, lower left, hidden.
  body = await (await send('PATCH', '/api/scene/layers/character', { scale: 0.5, x: -0.25, y: 0.1, visible: false })).json();
  assert.deepEqual(body.scene.layers.at(-1), { ...CHARACTER, scale: 0.5, x: -0.25, y: 0.1, visible: false });
  assert.deepEqual((await nextScene()).scene, body.scene, 'the unchanged patch before it sent nothing');

  // Order: the logo to the very front, the character to the very back, the background one step up.
  body = await (await send('POST', `/api/scene/layers/${logo.id}/move`, { to: 'top' })).json();
  assert.deepEqual(names(body.scene), ['바다', 'loop', 'photo', 'phone', 'camera', 'character', 'logo']);
  body = await (await send('POST', '/api/scene/layers/character/move', { to: 'bottom' })).json();
  assert.deepEqual(names(body.scene), ['character', '바다', 'loop', 'photo', 'phone', 'camera', 'logo']);
  body = await (await send('POST', `/api/scene/layers/${bg.id}/move`, { to: 'up' })).json();
  assert.deepEqual(names(body.scene), ['character', 'loop', '바다', 'photo', 'phone', 'camera', 'logo']);

  // Delete: a video layer leaves the scene and its video stays in the library; an image's
  // file goes with its layer. The motion routes do not touch these files.
  assert.equal((await send('DELETE', `/api/media/${phone.src}`)).status, 404);
  body = await (await send('DELETE', `/api/scene/layers/${phone.id}`)).json();
  assert.deepEqual(names(body.scene), ['character', 'loop', '바다', 'photo', 'camera', 'logo']);
  assert.ok(fsSync.existsSync(path.join(dataDir, 'media', `${phone.src}.mp4`)));
  assert.equal((await fetch(`${base}${phone.url}`)).status, 200);
  // The video put back on the scene from the library, twice: two layers of one file.
  response = await fetch(`${base}/api/scene/layers?video=${phone.src}`, { method: 'POST' });
  assert.equal(response.status, 201);
  body = await response.json();
  assert.deepEqual([body.layer.src, body.layer.name, body.layer.fill, body.layer.url], [phone.src, 'phone', true, phone.url]);
  body = await (await fetch(`${base}/api/scene/layers?video=${phone.src}`, { method: 'POST' })).json();
  assert.deepEqual(names(body.scene), ['phone', 'phone', 'character', 'loop', '바다', 'photo', 'camera', 'logo']);
  assert.equal((await fetch(`${base}/api/scene/layers?video=${ID_A}`, { method: 'POST' })).status, 404);
  // Deleted in the library: its layers leave the scene, and the file goes.
  response = await send('DELETE', `/api/videos/${phone.src}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).videos.some(video => video.id === phone.src), false);
  body = { scene: await (await send('GET', '/api/scene')).json() };
  assert.deepEqual(names(body.scene), ['character', 'loop', '바다', 'photo', 'camera', 'logo']);
  assert.equal(fsSync.existsSync(path.join(dataDir, 'media', `${phone.src}.mp4`)), false);
  assert.equal((await fetch(`${base}${phone.url}`)).status, 404);
  const photo = body.scene.layers.find(layer => layer.name === 'photo');
  await send('DELETE', `/api/scene/layers/${photo.id}`);
  assert.equal(fsSync.existsSync(path.join(dataDir, 'media', `${photo.id}.jpg`)), false);
  assert.equal((await fetch(`${base}${photo.url}`)).status, 404);
  await upload(jpg);
  await send('POST', '/api/scene/layers/character/move', { to: 'bottom' });

  // The library the overlay reads is as it was (the scene travels on its own).
  assert.deepEqual(await (await send('GET', '/api/library')).json(), { idle: null, motions: [], character: null, photo: null });

  // A restart keeps the scene.
  const before = await (await send('GET', '/api/scene')).json();
  await reader.cancel().catch(() => {});
  await shut(server);
  ({ server, base } = await open());
  assert.deepEqual(await (await fetch(`${base}/api/scene`)).json(), before);
  assert.equal((await fetch(`${base}${bg.url}`)).status, 200);
});

test('routes: at most MAX_LAYERS videos and images', { skip }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-scene-max-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const layers = Array.from({ length: scene.MAX_LAYERS }, (_, index) => ({
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`, kind: 'image', name: `n${index}`, mime: 'image/png',
  }));
  await fs.writeFile(path.join(dataDir, 'scene.json'), JSON.stringify({ layers }));
  const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/scene`)).json()).layers.length, scene.MAX_LAYERS + 1);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const response = await fetch(`${base}/api/scene/layers?name=more.png`, { method: 'POST', body: png });
  assert.deepEqual([response.status, (await response.json()).code], [409, 'too_many_layers']);
});

test('imageMime: PNG, JPEG, WebP and GIF by their first bytes', () => {
  assert.equal(scene.imageMime(Buffer.from('89504e470d0a1a0a00', 'hex')), 'image/png');
  assert.equal(scene.imageMime(Buffer.from('ffd8ffe000104a464946', 'hex')), 'image/jpeg');
  assert.equal(scene.imageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(scene.imageMime(Buffer.from('GIF89a\x01\0\x01\0', 'latin1')), 'image/gif');
  assert.equal(scene.imageMime(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')), null);
  assert.equal(scene.imageMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), null);
  assert.equal(scene.imageMime(Buffer.alloc(0)), null);
});
