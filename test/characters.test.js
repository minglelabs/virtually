'use strict';

// The character layer: the store and its API (/api/characters*,
// /api/active-photo), the on-air library view (GET /api/library, SSE,
// /api/trigger, /api/upload targeting, /api/media photos), cascade deletes,
// the migration from the old character library, jobs made from a photo and
// the finished-motion upload. All media is generated locally with ffmpeg;
// nothing touches the network.

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const media = require('../lib/animate/media');

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

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: 'ignore' });
}

// codec_name,pix_fmt of a file's first video stream.
function probeStream(filePath) {
  return execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt',
    '-of', 'csv=p=0', filePath]).toString().trim();
}

// A 32x48 red box on a transparent 64x96 canvas (the fit is [0.25, 0.25, 0.75, 0.75]).
const BOX = "geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'";
const BOX_FIT = [0.25, 0.25, 0.75, 0.75];
const TEXT = {
  name_missing: '캐릭터 이름을 입력해 주세요.',
  name_too_long: '캐릭터 이름은 40자까지 쓸 수 있습니다.',
  photo_missing: '사진을 찾을 수 없습니다.',
  character_missing: '캐릭터를 찾을 수 없습니다.',
  unsupported_image: 'PNG, JPEG, WebP 사진만 올릴 수 있습니다.',
  too_large: '사진은 20MB까지 올릴 수 있습니다.',
  last_photo: '사진이 하나뿐인 캐릭터는 캐릭터를 삭제해 주세요.',
  too_many_characters: '캐릭터는 50개까지 만들 수 있습니다.',
  too_many_photos: '사진은 캐릭터마다 30장까지 올릴 수 있습니다.',
  unsupported_video: 'WebM, MP4, MOV 영상만 올릴 수 있습니다.',
  too_long: '영상은 60초까지 올릴 수 있습니다.',
  too_large_video: '영상은 500MB까지 올릴 수 있습니다.',
};
const refusal = code => ({ error: TEXT[code], code });

// Generated once for the whole file.
let fixturesPromise = null;
function fixtures() {
  if (!fixturesPromise) fixturesPromise = makeFixtures();
  return fixturesPromise;
}
after(async () => {
  if (fixturesPromise) await fs.rm((await fixturesPromise).dir, { recursive: true, force: true });
});

// A 1-component (grayscale) baseline JPEG, 8x8, every pixel 128. ffmpeg's
// MJPEG encoder only writes colour JPEGs, and a grayscale one probes as
// pix_fmt 'gray': the name the old alpha test mistook for an alpha format.
// One-code Huffman tables: DC category 0 = '0', AC end-of-block = '0'.
function grayJpeg() {
  const hex = value => Buffer.from(value.replace(/\s+/g, ''), 'hex');
  const oneCode = '01' + '00'.repeat(15);
  return Buffer.concat([
    hex('ffd8'),
    hex('ffdb 0043 00'), Buffer.alloc(64, 1), // quantization table, all 1
    hex('ffc0 000b 08 0008 0008 01 01 11 00'), // 8x8, one component
    hex(`ffc4 0014 00 ${oneCode} 00`), // DC table
    hex(`ffc4 0014 10 ${oneCode} 00`), // AC table
    hex('ffda 0008 01 01 00 00 3f 00'), // scan header
    hex('3f'), // one block: DC diff 0, end of block, padding
    hex('ffd9'),
  ]);
}

async function makeFixtures() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-fixture-'));
  const file = name => path.join(dir, name);
  const box = (size = '64x96', extra = '') => `nullsrc=s=${size}${extra},format=rgba,${BOX}`;
  ffmpeg(['-f', 'lavfi', '-i', box(), '-frames:v', '1', file('box.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=48x48', '-frames:v', '1', file('blue.jpg')]);
  ffmpeg(['-f', 'lavfi', '-i', box(), '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '1', file('box.webp')]);
  // Driving video for mock jobs.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', file('clip.mp4')]);
  // Finished motions: own alpha, green screen, busy background, other codecs.
  const alphaSource = box('64x96', ':r=8:d=1');
  ffmpeg(['-f', 'lavfi', '-i', alphaSource, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-auto-alt-ref', '0', file('alpha.webm')]);
  ffmpeg(['-f', 'lavfi', '-i', alphaSource, '-c:v', 'qtrle', file('alpha.mov')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00FF00:s=64x96:r=8:d=1', '-vf', 'drawbox=x=16:y=24:w=32:h=48:color=red:t=fill',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file('green.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=8', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file('busy.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=8', '-t', '1', '-c:v', 'mpeg4', file('busy-mpeg4.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=2', '-t', '61', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file('long.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=4', '-t', '1', file('anim.gif')]);
  // Opaque photos: the same red box on a white background (PNG, JPEG, and an
  // RGBA PNG with nothing transparent), a busy picture, grayscale images.
  const onWhite = ['-f', 'lavfi', '-i', 'color=c=white:s=64x96', '-vf', 'drawbox=x=16:y=24:w=32:h=48:color=red:t=fill', '-frames:v', '1'];
  ffmpeg([...onWhite, file('white.png')]);
  ffmpeg([...onWhite, '-q:v', '2', file('white.jpg')]);
  ffmpeg([...onWhite.slice(0, 5), 'drawbox=x=16:y=24:w=32:h=48:color=red:t=fill,format=rgba', '-frames:v', '1', file('opaque-rgba.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', file('busy.png')]);
  await fs.writeFile(file('gray.jpg'), grayJpeg());
  ffmpeg(['-f', 'lavfi', '-i', box(), '-frames:v', '1', '-pix_fmt', 'ya8', file('gray-alpha.png')]);
  return {
    dir,
    png: file('box.png'), jpg: file('blue.jpg'), webp: file('box.webp'), clip: file('clip.mp4'),
    alphaWebm: file('alpha.webm'), alphaMov: file('alpha.mov'), greenMp4: file('green.mp4'),
    busyMp4: file('busy.mp4'), busyMpeg4: file('busy-mpeg4.mp4'), longMp4: file('long.mp4'), gif: file('anim.gif'),
    whitePng: file('white.png'), whiteJpg: file('white.jpg'), opaqueRgba: file('opaque-rgba.png'), busyPng: file('busy.png'),
    grayJpg: file('gray.jpg'), grayAlphaPng: file('gray-alpha.png'),
  };
}

async function tmpDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'virtually-characters-'));
}

async function start(dataDir, extra = {}) {
  const server = await createAppServer({
    dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true, animatePollIntervalMs: 40, ...extra,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

async function stop(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

// A running app on a fresh data dir, stopped and removed after the test.
async function setup(t, { seed = null, extra = {} } = {}) {
  const dataDir = await tmpDataDir();
  if (seed) await seed(dataDir);
  const app = await start(dataDir, extra);
  app.dataDir = dataDir;
  t.after(async () => {
    await stop(app.server);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return app;
}

// JSON request (a string body is sent as is, with the given content type).
function send(base, method, pathname, body, contentType = 'application/json') {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = contentType;
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(`${base}${pathname}`, init);
}

function postFile(base, pathname, filePath) {
  return fetch(`${base}${pathname}`, { method: 'POST', body: fsSync.readFileSync(filePath) });
}

async function createCharacter(base, name, filePath, filename = path.basename(filePath)) {
  const response = await postFile(base, `/api/characters?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(filename)}`, filePath);
  assert.equal(response.status, 201, `create ${name}`);
  return response.json();
}

async function addPhoto(base, characterId, filePath) {
  const response = await postFile(base, `/api/characters/${characterId}/photos?filename=${encodeURIComponent(path.basename(filePath))}`, filePath);
  assert.equal(response.status, 201, 'add photo');
  return response.json();
}

async function setActive(base, photoId) {
  const response = await send(base, 'PUT', '/api/active-photo', { photoId });
  assert.equal(response.status, 200, `on air ${photoId}`);
  return response.json();
}

async function library(base) {
  return (await fetch(`${base}/api/library`)).json();
}

// A WebM with a valid signature (measureFit gives null for it): enough for /api/upload.
const FAKE_WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);

async function uploadLegacy(base, kind, name, bytes = FAKE_WEBM, ext = '.webm') {
  const response = await fetch(`${base}/api/upload?kind=${kind}&name=${encodeURIComponent(name + ext)}`, {
    method: 'POST', headers: { 'Content-Type': ext === '.png' ? 'image/png' : 'video/webm' }, body: bytes,
  });
  assert.equal(response.status, 201, `${kind} upload`);
  return response.json();
}

// Parsed `data:` messages from /api/events, one at a time.
async function events(base) {
  const response = await fetch(`${base}/api/events`);
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
        const parts = buffered.split('\n\n');
        buffered = parts.pop();
        for (const part of parts) if (part.startsWith('data: ')) queue.push(JSON.parse(part.slice(6)));
      }
      return queue.shift();
    },
    async nextOfType(type) {
      for (;;) {
        const message = await this.next();
        if (message.type === type) return message;
      }
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

// A POST that only declares `bytes` of body: the server must refuse from the header alone.
function declaredUpload(port, pathname, bytes) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.on('error', () => {}); // the socket is dropped with the body unsent
    req.flushHeaders();
  });
}

const uuid = () => crypto.randomUUID();

// A photo record as the store keeps it (for seeding index.json).
function photoRecord(id, createdAt, extra = {}) {
  return { id, filename: 'p.png', mime: 'image/png', width: 64, height: 96, hasAlpha: true, createdAt, fit: null, ...extra };
}

async function seedIndex(dataDir, value) {
  await fs.mkdir(path.join(dataDir, 'characters', 'photos'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'characters', 'index.json'), JSON.stringify(value));
}

async function tmpFiles(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  return names.filter(name => name.includes('.tmp'));
}

async function photoFiles(dataDir) {
  return (await fs.readdir(path.join(dataDir, 'characters', 'photos'))).sort();
}

function near(actual, expected, tolerance = 0.04) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${actual} vs ${expected}`));
}

test('create: name and photo validation, sniffing, views and the files on disk', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { base, dataDir } = app;
  assert.deepEqual(await (await fetch(`${base}/api/characters`)).json(), { characters: [], activePhotoId: null, activeCharacterId: null });

  // Names: required, trimmed, control characters dropped, at most 40 characters.
  for (const [name, code] of [['', 'name_missing'], ['   ', 'name_missing'], ['\n\t\u0085', 'name_missing'], ['가'.repeat(41), 'name_too_long']]) {
    const response = await postFile(base, `/api/characters?name=${encodeURIComponent(name)}`, fx.png);
    assert.equal(response.status, 400, JSON.stringify(name));
    assert.deepEqual(await response.json(), refusal(code), JSON.stringify(name));
  }
  assert.deepEqual(await (await postFile(base, '/api/characters', fx.png)).json(), refusal('name_missing'));

  // Photos: PNG, JPEG or WebP by their bytes (not their names), at most 20 MB.
  for (const body of [Buffer.from('not an image at all'), Buffer.alloc(0), fsSync.readFileSync(fx.clip)]) {
    const response = await fetch(`${base}/api/characters?name=x&filename=x.png`, { method: 'POST', body });
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), refusal('unsupported_image'));
  }
  const tooLarge = await declaredUpload(app.port, '/api/characters?name=x', 20 * 1024 * 1024 + 1);
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.json, refusal('too_large'));
  assert.deepEqual((await (await fetch(`${base}/api/characters`)).json()).characters, []);

  // A PNG named .jpg is a PNG.
  const first = await createCharacter(base, '  하루\n 캐릭터  ', fx.png, 'looks-like.jpg');
  assert.deepEqual(Object.keys(first).sort(), ['activeCharacterId', 'activePhotoId', 'character', 'characters']);
  const character = first.character;
  assert.deepEqual(Object.keys(character).sort(), ['basePhotoId', 'createdAt', 'id', 'name', 'onAir', 'photos']);
  assert.match(character.id, /^c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(character.name, '하루 캐릭터');
  assert.equal(character.onAir, false);
  const [photo] = character.photos;
  assert.match(photo.id, /^ph-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(character.basePhotoId, photo.id);
  assert.deepEqual(photo, {
    id: photo.id, url: `/api/media/${photo.id}`, displayUrl: `/api/media/${photo.id}`, cutout: false, transparent: 'own', cutoutReason: null, cutoutMethod: null, aiCutReady: false,
    width: 64, height: 96, hasAlpha: true, createdAt: character.createdAt,
    isBase: true, onAir: false, idle: 'photo', idleMotionId: null, idleBy: null, idleDefault: 'photo', defaultIdleMotionId: null, motionCount: 0, motions: [],
  });
  assert.equal(first.activePhotoId, null, 'a new character does not go on air');
  let response = await fetch(`${base}${photo.url}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fsSync.readFileSync(fx.png));

  const jpeg = (await createCharacter(base, '가'.repeat(40), fx.jpg)).character;
  assert.equal(jpeg.photos[0].hasAlpha, false);
  const webp = await createCharacter(base, '하루 캐릭터', fx.webp);
  assert.equal(webp.character.name, '하루 캐릭터', 'names may repeat');
  assert.equal((await fetch(`${base}${jpeg.photos[0].url}`, { method: 'HEAD' })).headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}${webp.character.photos[0].url}`, { method: 'HEAD' })).headers.get('content-type'), 'image/webp');
  assert.deepEqual(webp.characters.map(item => item.id), [character.id, jpeg.id, webp.character.id], 'oldest first');

  // On disk: the index (with each photo's fit) and one file per photo.
  const index = JSON.parse(await fs.readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
  assert.equal(index.v, 1);
  assert.equal(index.activePhotoId, null);
  const stored = index.characters[0].photos[0];
  assert.equal(stored.filename, 'looks-like.jpg');
  assert.equal(stored.mime, 'image/png');
  assert.deepEqual(stored.fit.first, BOX_FIT);
  assert.equal(index.characters[1].photos[0].fit, null, 'a JPEG has no alpha box');
  near(index.characters[2].photos[0].fit.first, BOX_FIT);
  // Transparent photos are not cut; a single-colour image has nothing to cut out.
  assert.deepEqual(index.characters.map(item => item.photos[0].cutout),
    [{ cut: false, reason: 'has_alpha' }, { cut: false, reason: 'no_subject' }, { cut: false, reason: 'has_alpha' }]);
  assert.deepEqual(await photoFiles(dataDir),
    [`${photo.id}.png`, `${jpeg.photos[0].id}.jpg`, `${webp.character.photos[0].id}.webp`].sort());
  assert.deepEqual(await tmpFiles(path.join(dataDir, 'characters')), []);
});

test('limits: 50 characters, 30 photos per character', { skip }, async t => {
  const fx = await fixtures();
  const stamp = i => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const seeded = (name, createdAt, count) => {
    const photos = Array.from({ length: count }, (_, i) => photoRecord(`ph-${uuid()}`, stamp(i)));
    return { id: `c-${uuid()}`, name, createdAt, basePhotoId: photos[0].id, photos };
  };
  const full = seeded('사진 많은 캐릭터', stamp(0), 30);
  const others = Array.from({ length: 49 }, (_, i) => seeded(`캐릭터 ${i + 1}`, stamp(100 + i), 1));
  const app = await setup(t, { seed: dataDir => seedIndex(dataDir, { v: 1, activePhotoId: null, characters: [full, ...others] }) });

  let response = await postFile(app.base, '/api/characters?name=one-too-many', fx.png);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), refusal('too_many_characters'));
  response = await postFile(app.base, `/api/characters/${full.id}/photos`, fx.png);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), refusal('too_many_photos'));

  // One below each limit works again.
  assert.equal((await fetch(`${app.base}/api/characters/${others[0].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await createCharacter(app.base, '마지막 자리', fx.png)).characters.length, 50);
  assert.equal((await fetch(`${app.base}/api/characters/${full.id}/photos/${full.photos[29].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await addPhoto(app.base, full.id, fx.png)).character.photos.length, 30);
  assert.deepEqual(await tmpFiles(path.join(app.dataDir, 'characters')), []);
});

test('rename, add and delete photos, base photo handover, delete a character', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { base, dataDir } = app;
  const alice = (await createCharacter(base, '앨리스', fx.png)).character;
  const id = alice.id;
  const first = alice.basePhotoId;
  const bob = (await createCharacter(base, '밥', fx.jpg)).character;

  // Rename: JSON, a valid name, duplicates allowed.
  let response = await send(base, 'PATCH', `/api/characters/${id}`, '{"name":"x"}', 'text/plain');
  assert.equal(response.status, 415);
  for (const [body, code] of [[{}, 'name_missing'], [{ name: 42 }, 'name_missing'], [{ name: ' \n ' }, 'name_missing'], [{ name: 'x'.repeat(41) }, 'name_too_long']]) {
    response = await send(base, 'PATCH', `/api/characters/${id}`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), refusal(code), JSON.stringify(body));
  }
  response = await send(base, 'PATCH', `/api/characters/${id}`, { name: '  앨리스   2 ' });
  assert.equal(response.status, 200);
  let data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['activeCharacterId', 'activePhotoId', 'character', 'characters']);
  assert.equal(data.character.name, '앨리스 2');
  assert.equal((await send(base, 'PATCH', `/api/characters/${bob.id}`, { name: '앨리스 2' })).status, 200);

  // Unknown and malformed character ids are 404 on every route.
  for (const bad of [`c-${uuid()}`, 'c-..%2F..%2Findex.json', 'x', `${id}x`, `ch-${id.slice(2)}`]) {
    for (const [method, sub, body] of [['PATCH', '', { name: 'x' }], ['DELETE', ''], ['PUT', '/base', { photoId: first }], ['DELETE', `/photos/${first}`]]) {
      response = await send(base, method, `/api/characters/${bad}${sub}`, body);
      assert.equal(response.status, 404, `${method} ${bad}${sub}`);
      assert.deepEqual(await response.json(), refusal('character_missing'), `${method} ${bad}${sub}`);
    }
    response = await postFile(base, `/api/characters/${bad}/photos`, fx.png);
    assert.deepEqual(await response.json(), refusal('character_missing'), `POST ${bad}/photos`);
  }

  // More photos: listed base first, then oldest first.
  const second = await addPhoto(base, id, fx.webp);
  assert.deepEqual(Object.keys(second).sort(), ['activeCharacterId', 'activePhotoId', 'character', 'characters', 'photo']);
  assert.equal(second.photo.isBase, false);
  assert.equal(second.photo.url, `/api/media/${second.photo.id}`);
  const third = await addPhoto(base, id, fx.jpg);
  assert.deepEqual(third.character.photos.map(photo => photo.id), [first, second.photo.id, third.photo.id]);
  response = await postFile(base, `/api/characters/${id}/photos`, fx.clip);
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), refusal('unsupported_image'));

  // The base photo: one of the character's own photos.
  response = await send(base, 'PUT', `/api/characters/${id}/base`, { photoId: third.photo.id });
  assert.equal(response.status, 200);
  data = await response.json();
  assert.equal(data.character.basePhotoId, third.photo.id);
  assert.deepEqual(data.character.photos.map(photo => [photo.id, photo.isBase]),
    [[third.photo.id, true], [first, false], [second.photo.id, false]]);
  for (const photoId of [bob.basePhotoId, `ph-${uuid()}`, 42, undefined]) {
    response = await send(base, 'PUT', `/api/characters/${id}/base`, { photoId });
    assert.equal(response.status, 404, String(photoId));
    assert.deepEqual(await response.json(), refusal('photo_missing'));
  }
  assert.equal((await send(base, 'PUT', `/api/characters/${id}/base`, '{}', 'text/plain')).status, 415);

  // Deleting photos: a deleted base passes to the oldest remaining photo; the last photo stays.
  for (const photoId of [bob.basePhotoId, `ph-${uuid()}`, 'ph-x', '..%2F..%2Fcharacters%2Findex.json']) {
    response = await fetch(`${base}/api/characters/${id}/photos/${photoId}`, { method: 'DELETE' });
    assert.equal(response.status, 404, photoId);
    assert.deepEqual(await response.json(), refusal('photo_missing'), photoId);
  }
  response = await fetch(`${base}/api/characters/${id}/photos/${third.photo.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['activeCharacterId', 'activePhotoId', 'character', 'characters']);
  assert.equal(data.character.basePhotoId, first, 'the oldest remaining photo is the base');
  assert.deepEqual(data.character.photos.map(photo => photo.id), [first, second.photo.id]);
  assert.ok(!(await photoFiles(dataDir)).some(name => name.startsWith(third.photo.id)), 'its file is gone');
  assert.equal((await fetch(`${base}/api/media/${third.photo.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/characters/${id}/photos/${second.photo.id}`, { method: 'DELETE' })).status, 200);
  response = await fetch(`${base}/api/characters/${id}/photos/${first}`, { method: 'DELETE' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), refusal('last_photo'));

  // Deleting the character removes its photo files.
  response = await fetch(`${base}/api/characters/${id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['activeCharacterId', 'activePhotoId', 'characters']);
  assert.deepEqual(data.characters.map(item => item.id), [bob.id]);
  assert.deepEqual(await photoFiles(dataDir), [`${bob.basePhotoId}.jpg`]);
  assert.equal((await fetch(`${base}/api/characters/${id}`, { method: 'DELETE' })).status, 404);

  // Everything survives a restart.
  const before = await (await fetch(`${base}/api/characters`)).json();
  await stop(app.server);
  const again = await start(dataDir);
  try {
    assert.deepEqual(await (await fetch(`${again.base}/api/characters`)).json(), before);
  } finally {
    await stop(again.server);
  }
});

test('on air: the library view, SSE broadcasts, trigger, /api/upload targeting and photo media', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { base, dataDir } = app;
  const png = fsSync.readFileSync(fx.png);
  const alice = (await createCharacter(base, '앨리스', fx.png)).character;
  const a1 = alice.basePhotoId;
  const a2 = (await addPhoto(base, alice.id, fx.jpg)).photo.id;

  // Nothing on air: today's library (the legacy idle, the motions without a photo).
  const m0 = await uploadLegacy(base, 'motion', 'wave');
  assert.equal(m0.photoId, null);
  const legacyIdle = await uploadLegacy(base, 'idle', 'legacy', png, '.png');
  const offAir = { idle: legacyIdle, motions: [m0], character: null, photo: null };
  assert.deepEqual(await library(base), offAir);
  const stream = await events(base);
  t.after(() => stream.close());
  assert.deepEqual((await stream.next()).library, offAir);

  // a1 on air: its own image is the idle (with its fit); the motions are a1's (none yet).
  let data = await setActive(base, a1);
  assert.deepEqual(Object.keys(data).sort(), ['activeCharacterId', 'activePhotoId', 'library']);
  assert.equal(data.activePhotoId, a1);
  assert.equal(data.activeCharacterId, alice.id);
  const { fit, ...idle } = data.library.idle;
  assert.deepEqual(idle, {
    id: a1, name: '앨리스', kind: 'idle', mime: 'image/png', url: `/api/media/${a1}`, createdAt: alice.photos[0].createdAt, source: { photoId: a1 },
  });
  assert.deepEqual(fit.first, BOX_FIT);
  assert.deepEqual(data.library.motions, []);
  assert.deepEqual(data.library.character, { id: alice.id, name: '앨리스' });
  assert.deepEqual(data.library.photo, { id: a1, url: `/api/media/${a1}`, width: 64, height: 96, hasAlpha: true });
  assert.deepEqual((await stream.nextOfType('library')).library, data.library);
  assert.deepEqual(await library(base), data.library);
  let list = await (await fetch(`${base}/api/characters`)).json();
  assert.equal(list.activePhotoId, a1);
  assert.equal(list.activeCharacterId, alice.id);
  assert.equal(list.characters[0].onAir, true);
  assert.deepEqual(list.characters[0].photos.map(photo => [photo.id, photo.onAir]), [[a1, true], [a2, false]]);

  // Uploads go to the photo on air; only its motions can be triggered.
  const m1 = await uploadLegacy(base, 'motion', 'jump');
  assert.equal(m1.photoId, a1);
  assert.deepEqual((await stream.nextOfType('library')).library.motions, [m1]);
  let response = await send(base, 'POST', '/api/trigger', { id: m0.id });
  assert.equal(response.status, 404, 'a motion of no photo is not in this view');
  response = await send(base, 'POST', '/api/trigger', { id: m1.id });
  assert.equal(response.status, 200);
  assert.equal((await stream.nextOfType('play')).id, m1.id);

  // An idle uploaded now is a1's; a second one replaces it and its file. The legacy idle stays.
  const i1 = await uploadLegacy(base, 'idle', 'pose one', png, '.png');
  assert.deepEqual((await stream.nextOfType('library')).library.idle, i1);
  const i2 = await uploadLegacy(base, 'idle', 'pose two', png, '.png');
  assert.deepEqual((await stream.nextOfType('library')).library.idle, i2);
  assert.equal(fsSync.existsSync(path.join(dataDir, 'media', `${i1.id}.png`)), false);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8'));
  assert.deepEqual(stored.idle, legacyIdle);
  assert.deepEqual(stored.idles, { [a1]: i2 });
  assert.deepEqual(stored.motions.map(item => [item.id, item.photoId]), [[m0.id, null], [m1.id, a1]]);
  list = await (await fetch(`${base}/api/characters`)).json();
  const card = list.characters[0].photos[0];
  assert.equal(card.idle, 'upload');
  assert.equal(card.motionCount, 1);
  assert.deepEqual(card.motions, [{ id: m1.id, name: 'jump', mime: 'video/webm', createdAt: m1.createdAt, isIdle: false, hasBackground: true, hasOriginal: false }]);
  assert.equal(list.characters[0].photos[1].idle, 'photo');

  // Deleting the uploaded idle shows the photo again.
  assert.equal((await fetch(`${base}/api/media/${i2.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await stream.nextOfType('library')).library.idle.id, a1);
  assert.equal(fsSync.existsSync(path.join(dataDir, 'media', `${i2.id}.png`)), false);

  // Another photo of the same character has its own motions; a JPEG has no fit.
  await setActive(base, a2);
  let view = (await stream.nextOfType('library')).library;
  assert.equal(view.idle.id, a2);
  assert.equal(view.idle.mime, 'image/jpeg');
  assert.equal(view.idle.fit, null);
  assert.deepEqual(view.motions, []);
  assert.equal((await send(base, 'POST', '/api/trigger', { id: m1.id })).status, 404);

  // Renaming the on-air character is broadcast (its name is the idle's name too).
  await send(base, 'PATCH', `/api/characters/${alice.id}`, { name: '앨리스 2' });
  view = (await stream.nextOfType('library')).library;
  assert.deepEqual(view.character, { id: alice.id, name: '앨리스 2' });
  assert.equal(view.idle.name, '앨리스 2');

  // Off air: back to the legacy view.
  data = await setActive(base, null);
  assert.equal(data.activePhotoId, null);
  assert.equal(data.activeCharacterId, null);
  assert.deepEqual(data.library, offAir);
  assert.deepEqual((await stream.nextOfType('library')).library, offAir);
  for (const [body, status] of [[{ photoId: `ph-${uuid()}` }, 404], [{ photoId: 'nope' }, 404], [{ photoId: 42 }, 400], [{}, 400]]) {
    response = await send(base, 'PUT', '/api/active-photo', body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.deepEqual(await response.json(), refusal('photo_missing'));
  }
  assert.equal((await send(base, 'PUT', '/api/active-photo', '{"photoId":null}', 'text/plain')).status, 415);

  // Photos are served by id (byte ranges, HEAD); /api/media cannot delete them.
  response = await fetch(`${base}/api/media/${a1}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png.subarray(0, 8));
  response = await fetch(`${base}/api/media/${a2}`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}/api/media/${a1}`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/api/media/ph-${uuid()}`)).status, 404);
  assert.ok(fsSync.existsSync(path.join(dataDir, 'characters', 'photos', `${a1}.png`)));
});

test('cascade: deleting a photo or a character removes its motions, idles and files and takes it off air', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { base, dataDir } = app;
  const png = fsSync.readFileSync(fx.png);
  const mediaFile = item => path.join(dataDir, 'media', `${item.id}${item.mime === 'image/png' ? '.png' : '.webm'}`);
  const storedLibrary = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8'));
  const alice = (await createCharacter(base, '앨리스', fx.png)).character;
  const a1 = alice.basePhotoId;
  const a2 = (await addPhoto(base, alice.id, fx.webp)).photo.id;
  const bob = (await createCharacter(base, '밥', fx.jpg)).character;
  const b1 = bob.basePhotoId;
  const m0 = await uploadLegacy(base, 'motion', 'no photo');
  await setActive(base, a1);
  const ma1 = await uploadLegacy(base, 'motion', 'a1 motion');
  const ia1 = await uploadLegacy(base, 'idle', 'a1 idle', png, '.png');
  await setActive(base, a2);
  const ma2 = await uploadLegacy(base, 'motion', 'a2 motion');
  await setActive(base, b1);
  const mb1 = await uploadLegacy(base, 'motion', 'b1 motion');
  const ib1 = await uploadLegacy(base, 'idle', 'b1 idle', png, '.png');
  for (const item of [m0, ma1, ia1, ma2, mb1, ib1]) assert.ok(fsSync.existsSync(mediaFile(item)), item.name);
  const offAir = { idle: null, motions: [m0], character: null, photo: null };

  const stream = await events(base);
  t.after(() => stream.close());
  await stream.nextOfType('obs-source'); // the connect messages (library, then the OBS size)

  // The on-air photo: its motion and idle go (records first, then files), nothing is on air, the base passes on.
  await setActive(base, a1);
  assert.equal((await stream.nextOfType('library')).library.photo.id, a1);
  let response = await fetch(`${base}/api/characters/${alice.id}/photos/${a1}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  let data = await response.json();
  assert.equal(data.activePhotoId, null);
  assert.equal(data.activeCharacterId, null);
  assert.equal(data.character.basePhotoId, a2);
  assert.deepEqual((await stream.nextOfType('library')).library, offAir);
  let stored = await storedLibrary();
  assert.deepEqual(stored.motions.map(item => item.id), [m0.id, ma2.id, mb1.id]);
  assert.deepEqual(stored.idles, { [b1]: ib1 });
  for (const item of [ma1, ia1]) assert.equal(fsSync.existsSync(mediaFile(item)), false, `${item.name} removed`);
  for (const item of [m0, ma2, mb1, ib1]) assert.ok(fsSync.existsSync(mediaFile(item)), `${item.name} kept`);
  for (const id of [ma1.id, ia1.id, a1]) assert.equal((await fetch(`${base}/api/media/${id}`)).status, 404, id);

  // A character that is not on air: its records and files go, the on-air view stays (no library message).
  await setActive(base, b1);
  assert.equal((await stream.nextOfType('library')).library.photo.id, b1);
  response = await fetch(`${base}/api/characters/${alice.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  data = await response.json();
  assert.equal(data.activePhotoId, b1);
  assert.deepEqual(data.characters.map(item => [item.id, item.onAir]), [[bob.id, true]]);
  assert.equal(fsSync.existsSync(mediaFile(ma2)), false);
  assert.equal((await send(base, 'POST', '/api/idle', {})).status, 200);
  assert.equal((await stream.next()).type, 'idle', 'the view did not change, so no library message came first');

  // The on-air character: off air, broadcast, everything of it gone.
  response = await fetch(`${base}/api/characters/${bob.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { characters: [], activePhotoId: null, activeCharacterId: null });
  assert.deepEqual((await stream.nextOfType('library')).library, offAir);
  // Nothing on air again: the demo avatar may react.
  assert.equal((await send(base, 'POST', '/api/trigger', { id: 'demo' })).status, 200);
  const played = await stream.next();
  assert.deepEqual([played.type, played.id], ['play', 'demo']);
  stored = await storedLibrary();
  assert.deepEqual(stored.motions.map(item => item.id), [m0.id]);
  assert.deepEqual(stored.idles, {});
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'media')), [`${m0.id}.webm`]);
  assert.deepEqual(await photoFiles(dataDir), []);
  const index = JSON.parse(await fs.readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
  assert.deepEqual(index, { v: 1, activePhotoId: null, characters: [] });
});

// A request with a Cookie header (fetch cannot send one) and no body.
function rawRequest(port, pathname, { method = 'GET', cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, agent: false, headers: cookie ? { Cookie: cookie } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('login on: the on-air photo reaches OBS with the overlay key alone; the character routes need a session', { skip }, async t => {
  const fx = await fixtures();
  const photoId = `ph-${uuid()}`;
  const characterId = `c-${uuid()}`;
  const createdAt = '2026-09-01T00:00:00.000Z';
  // The account's own workspace and OBS key (login on keeps every account's data apart).
  const sub = '109876543210987654321';
  const overlayKey = 'k'.repeat(32);
  const home = dataDir => path.join(dataDir, 'users', sub);
  const app = await setup(t, {
    seed: async dataDir => {
      // An opaque photo whose background was cut out: OBS shows the cutout.
      const cutout = { cut: true, color: '#FFFFFF', fit: null, v: 2 };
      await seedIndex(home(dataDir), {
        v: 1, activePhotoId: photoId,
        characters: [{ id: characterId, name: '방송 캐릭터', createdAt, basePhotoId: photoId, photos: [photoRecord(photoId, createdAt, { hasAlpha: false, cutout })] }],
      });
      await fs.copyFile(fx.whitePng, path.join(home(dataDir), 'characters', 'photos', `${photoId}.png`));
      await fs.copyFile(fx.png, path.join(home(dataDir), 'characters', 'photos', `${photoId}.cutout.png`));
      await fs.mkdir(path.join(dataDir, 'auth'), { recursive: true });
      await fs.writeFile(path.join(dataDir, 'auth', 'state.json'), JSON.stringify({ sessionSecret: 's'.repeat(43), overlayKeys: { [sub]: overlayKey } }));
      await fs.writeFile(path.join(dataDir, 'auth', 'config.json'), JSON.stringify({
        google: { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-client-secret' },
        allowedEmails: ['streamer@example.com'],
      }));
    },
    // Nothing may reach Google: every endpoint is a closed local port.
    extra: { auth: { endpoints: { authorize: 'http://127.0.0.1:9/a', token: 'http://127.0.0.1:9/t', jwks: 'http://127.0.0.1:9/j' }, log: () => {} } },
  });
  const cookie = `virtually_overlay=${overlayKey}`;
  const cutUrl = `/api/media/${photoId}?variant=cutout`;

  let response = await rawRequest(app.port, `/api/media/${photoId}`);
  assert.equal(response.status, 401, 'signed out, no key');
  response = await rawRequest(app.port, `/api/media/${photoId}`, { cookie: 'virtually_overlay=wrong' });
  assert.equal(response.status, 401, 'a wrong key');
  assert.equal((await rawRequest(app.port, cutUrl)).status, 401, 'the cutout needs the key too');
  response = await rawRequest(app.port, `/api/media/${photoId}`, { cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.deepEqual(response.body, fsSync.readFileSync(fx.whitePng));
  assert.equal((await rawRequest(app.port, `/api/media/${photoId}`, { method: 'HEAD', cookie })).status, 200);
  response = await rawRequest(app.port, cutUrl, { cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.deepEqual(response.body, fsSync.readFileSync(fx.png));
  response = await rawRequest(app.port, '/api/library', { cookie });
  assert.equal(response.status, 200);
  const view = JSON.parse(response.body.toString('utf8'));
  assert.equal(view.idle.url, cutUrl);
  assert.deepEqual(view.character, { id: characterId, name: '방송 캐릭터' });

  // Everything else of the character layer is session class.
  for (const [method, pathname] of [
    ['GET', '/api/characters'], ['POST', '/api/characters?name=x'], ['PATCH', `/api/characters/${characterId}`],
    ['DELETE', `/api/characters/${characterId}`], ['POST', `/api/characters/${characterId}/photos`],
    ['PUT', `/api/characters/${characterId}/base`], ['DELETE', `/api/characters/${characterId}/photos/${photoId}`],
    ['POST', `/api/characters/${characterId}/photos/${photoId}/motions?filename=x.webm`], ['PUT', '/api/active-photo'],
  ]) {
    response = await rawRequest(app.port, pathname, { method, cookie });
    assert.equal(response.status, 401, `${method} ${pathname}`);
    assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: '로그인이 필요합니다.', code: 'auth_required' }, `${method} ${pathname}`);
  }
  for (const pathname of ['/', '/broadcast', '/animate']) {
    response = await rawRequest(app.port, pathname, { cookie });
    assert.equal(response.status, 302, pathname);
    assert.equal(response.headers.location, `/login?next=${encodeURIComponent(pathname)}`, pathname);
  }
  for (const pathname of ['/characters.js', '/characters.css']) {
    assert.equal((await rawRequest(app.port, pathname)).status, 200, `${pathname} is a public asset`);
  }
  // The refused DELETEs changed nothing.
  assert.ok(fsSync.existsSync(path.join(home(app.dataDir), 'characters', 'photos', `${photoId}.png`)));
  assert.equal(JSON.parse(await fs.readFile(path.join(home(app.dataDir), 'characters', 'index.json'), 'utf8')).activePhotoId, photoId);
});

// name -> base64 bytes of every file in `dir`.
async function snapshot(dir) {
  const out = {};
  for (const name of (await fs.readdir(dir)).sort()) out[name] = (await fs.readFile(path.join(dir, name))).toString('base64');
  return out;
}

// Seeds the old character library, jobs and library.json. Returns what was seeded.
async function seedLegacy(dataDir, { photos, selectedId, jobs = {}, motions = [], idle = null }) {
  const legacyDir = path.join(dataDir, 'animate', 'characters');
  await fs.mkdir(legacyDir, { recursive: true });
  const items = [];
  for (const photo of photos) {
    items.push(photo.record);
    if (photo.file) await fs.copyFile(photo.file, path.join(legacyDir, `${photo.record.id}${photo.record.mime === 'image/jpeg' ? '.jpg' : '.png'}`));
  }
  await fs.writeFile(path.join(legacyDir, 'index.json'), JSON.stringify({ selectedId, items }, null, 2));
  for (const [jobId, characterId] of Object.entries(jobs)) {
    const dir = path.join(dataDir, 'animate', 'jobs', jobId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({
      id: jobId, state: 'failed', characterId, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      error: { code: 'canceled', message: 'Canceled.' },
    }));
  }
  await fs.mkdir(path.join(dataDir, 'media'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'library.json'), JSON.stringify({ idle, motions }, null, 2));
  return legacyDir;
}

function legacyRecord(id, mime, createdAt, extra = {}) {
  return { id, filename: `${id.slice(0, 7)}${mime === 'image/jpeg' ? '.jpg' : '.png'}`, mime, width: 64, height: 96, hasAlpha: true, createdAt, lastSelectedAt: null, ...extra };
}

function libraryMotion(name, source) {
  const id = uuid();
  return { id, name, kind: 'motion', mime: 'video/webm', url: `/api/media/${id}`, createdAt: '2026-09-05T00:00:00.000Z', fit: null, ...(source ? { source } : {}) };
}

// Starts the app with console.log captured; resolves { app, logs }.
async function startLogged(t, dataDir) {
  const log = t.mock.method(console, 'log', () => {});
  try {
    const app = await start(dataDir);
    return { app, logs: log.mock.calls.map(call => call.arguments.join(' ')) };
  } finally {
    log.mock.restore();
  }
}

test('migration: every old photo becomes a character with the same id; motions follow their job; rerun is a no-op', { skip }, async t => {
  const fx = await fixtures();
  const dataDir = await tmpDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const older = `ch-${uuid()}`;
  const selected = `ch-${uuid()}`;
  const gone = `ch-${uuid()}`; // listed, but its file is missing: not migrated
  const jobs = { [uuid()]: older, [uuid()]: selected, [uuid()]: gone, [uuid()]: null };
  const [jobOlder, jobSelected, jobGone, jobIdle] = Object.keys(jobs);
  const motions = [
    libraryMotion('from the older photo', { jobId: jobOlder }),
    libraryMotion('from the selected photo', { jobId: jobSelected }),
    libraryMotion('from a photo that is gone', { jobId: jobGone }),
    libraryMotion('from the old idle image', { jobId: jobIdle }),
    libraryMotion('from a deleted job', { jobId: uuid() }),
    libraryMotion('uploaded'),
  ];
  const idleId = uuid();
  const idle = { id: idleId, name: 'idle', kind: 'idle', mime: 'image/png', url: `/api/media/${idleId}`, createdAt: '2026-09-04T00:00:00.000Z', fit: null };
  const legacyDir = await seedLegacy(dataDir, {
    selectedId: selected,
    photos: [
      { record: legacyRecord(selected, 'image/png', '2026-09-02T00:00:00.000Z', { filename: 'hero.png', lastSelectedAt: '2026-09-03T00:00:00.000Z' }), file: fx.png },
      { record: legacyRecord(older, 'image/jpeg', '2026-09-01T00:00:00.000Z', { width: 48, height: 48, hasAlpha: false }), file: fx.jpg },
      { record: legacyRecord(gone, 'image/png', '2026-08-01T00:00:00.000Z') },
      { record: { id: 'not-an-id', mime: 'image/png' } },
    ],
    jobs, motions, idle,
  });
  const legacyBefore = await snapshot(legacyDir);

  let { app, logs } = await startLogged(t, dataDir);
  let list;
  try {
    assert.ok(logs.includes('[characters] migrated 2 photo(s)'), logs.join('\n'));
    list = await (await fetch(`${app.base}/api/characters`)).json();
    assert.deepEqual(list.characters.map(item => [item.name, item.basePhotoId, item.photos.map(photo => photo.id)]),
      [['캐릭터 1', older, [older]], ['캐릭터 2', selected, [selected]]], 'numbered by createdAt, ids kept');
    assert.equal(list.activePhotoId, selected, 'the old selection is on air');
    assert.equal(list.activeCharacterId, list.characters[1].id);
    assert.deepEqual(list.characters[0].photos[0], {
      id: older, url: `/api/media/${older}`, displayUrl: `/api/media/${older}`, cutout: false, transparent: 'no', cutoutReason: 'no_subject', cutoutMethod: null, aiCutReady: false,
      width: 48, height: 48, hasAlpha: false, createdAt: '2026-09-01T00:00:00.000Z',
      isBase: true, onAir: false, idle: 'photo', idleMotionId: null, idleBy: null, idleDefault: 'photo', defaultIdleMotionId: null, motionCount: 1,
      motions: [{ id: motions[0].id, name: motions[0].name, mime: 'video/webm', createdAt: motions[0].createdAt, isIdle: false, hasBackground: true, hasOriginal: false }],
    });
    assert.equal(list.characters[1].photos[0].idle, 'upload', 'the legacy idle belongs to the on-air photo now');
    assert.equal(list.characters[1].photos[0].motionCount, 5);

    // Files are copied, the old library is left as it was.
    assert.deepEqual(await photoFiles(dataDir), [`${older}.jpg`, `${selected}.png`].sort());
    assert.deepEqual(fsSync.readFileSync(path.join(dataDir, 'characters', 'photos', `${selected}.png`)), fsSync.readFileSync(fx.png));
    assert.deepEqual(await snapshot(legacyDir), legacyBefore);
    const index = JSON.parse(await fs.readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
    assert.equal(index.characters[1].photos[0].filename, 'hero.png');
    assert.deepEqual(index.characters[1].photos[0].fit.first, BOX_FIT, 'measured while migrating');
    assert.equal(index.characters[0].photos[0].fit, null);
    assert.deepEqual(index.characters.map(item => item.photos[0].cutout),
      [{ cut: false, reason: 'no_subject' }, { cut: false, reason: 'has_alpha' }], 'decided while migrating');

    // Motions: their job's photo, else the on-air photo; the legacy idle is the on-air photo's idle.
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8'));
    assert.deepEqual(stored.motions.map(item => item.photoId), [older, selected, selected, selected, selected, selected]);
    assert.deepEqual(stored.motions.map(({ photoId, ...rest }) => rest), motions, 'nothing else changed');
    assert.equal(stored.idle, null);
    assert.deepEqual(stored.idles, { [selected]: idle });
    const view = await library(app.base);
    assert.deepEqual(view.idle, idle);
    assert.deepEqual(view.motions.map(item => item.id), motions.slice(1).map(item => item.id));
    assert.deepEqual(view.character, { id: list.characters[1].id, name: '캐릭터 2' });
  } finally {
    await stop(app.server);
  }

  // Interrupted before index.json was written: the next start migrates again, to the same result.
  const libraryBytes = await fs.readFile(path.join(dataDir, 'library.json'));
  await fs.rm(path.join(dataDir, 'characters', 'index.json'));
  ({ app, logs } = await startLogged(t, dataDir));
  try {
    assert.ok(logs.includes('[characters] migrated 2 photo(s)'), logs.join('\n'));
    const again = await (await fetch(`${app.base}/api/characters`)).json();
    assert.deepEqual(again.characters.map(item => [item.name, item.basePhotoId]), list.characters.map(item => [item.name, item.basePhotoId]));
    assert.equal(again.activePhotoId, selected);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), libraryBytes, 'library.json is already migrated');
    list = again;
  } finally {
    await stop(app.server);
  }

  // Once index.json exists the old library is never read again.
  const newer = `ch-${uuid()}`;
  const legacyIndex = JSON.parse(await fs.readFile(path.join(legacyDir, 'index.json'), 'utf8'));
  legacyIndex.items.push(legacyRecord(newer, 'image/png', '2026-09-10T00:00:00.000Z'));
  await fs.writeFile(path.join(legacyDir, 'index.json'), JSON.stringify(legacyIndex));
  await fs.copyFile(fx.png, path.join(legacyDir, `${newer}.png`));
  const indexBytes = await fs.readFile(path.join(dataDir, 'characters', 'index.json'));
  ({ app, logs } = await startLogged(t, dataDir));
  try {
    assert.ok(!logs.some(line => line.startsWith('[characters]')), logs.join('\n'));
    assert.deepEqual(await (await fetch(`${app.base}/api/characters`)).json(), list);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'characters', 'index.json')), indexBytes);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), libraryBytes);
  } finally {
    await stop(app.server);
  }
});

test('migration fallbacks: a missing selection puts the oldest photo on air; no photos leaves the library as it was', { skip }, async t => {
  const fx = await fixtures();
  const first = await tmpDataDir();
  const second = await tmpDataDir();
  t.after(async () => {
    await fs.rm(first, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  });
  const idleId = uuid();
  const idle = { id: idleId, name: 'idle', kind: 'idle', mime: 'image/png', url: `/api/media/${idleId}`, createdAt: '2026-09-04T00:00:00.000Z', fit: null };

  // The selected photo's file is gone: the oldest migrated photo goes on air and takes the idle and the motions.
  const a = `ch-${uuid()}`;
  const b = `ch-${uuid()}`;
  const motion = libraryMotion('uploaded');
  await seedLegacy(first, {
    selectedId: `ch-${uuid()}`,
    photos: [
      { record: legacyRecord(b, 'image/png', '2026-09-03T00:00:00.000Z'), file: fx.png },
      // Opaque art on white: its cutout is made while migrating.
      { record: legacyRecord(a, 'image/png', '2026-09-02T00:00:00.000Z', { hasAlpha: true }), file: fx.whitePng },
    ],
    motions: [motion], idle,
  });
  let { app } = await startLogged(t, first);
  try {
    const list = await (await fetch(`${app.base}/api/characters`)).json();
    assert.deepEqual(list.characters.map(item => item.basePhotoId), [a, b]);
    assert.equal(list.activePhotoId, a);
    const migrated = list.characters[0].photos[0];
    assert.deepEqual([migrated.cutout, migrated.displayUrl, migrated.hasAlpha], [true, `/api/media/${a}?variant=cutout`, false]);
    assert.ok(fsSync.existsSync(path.join(first, 'characters', 'photos', `${a}.cutout.png`)));
    const stored = JSON.parse(await fs.readFile(path.join(first, 'library.json'), 'utf8'));
    assert.deepEqual(stored.motions.map(item => item.photoId), [a]);
    assert.deepEqual(stored.idles, { [a]: idle });
    assert.equal(stored.idle, null);
  } finally {
    await stop(app.server);
  }

  // No usable photo: nothing on air, motions keep no photo, the legacy idle stays; library.json is not rewritten.
  await seedLegacy(second, {
    selectedId: null,
    photos: [{ record: legacyRecord(`ch-${uuid()}`, 'image/png', '2026-09-02T00:00:00.000Z') }],
    motions: [motion], idle,
  });
  const libraryBytes = await fs.readFile(path.join(second, 'library.json'));
  let logs;
  ({ app, logs } = await startLogged(t, second));
  try {
    assert.ok(!logs.some(line => line.startsWith('[characters]')), logs.join('\n'));
    assert.deepEqual(await (await fetch(`${app.base}/api/characters`)).json(), { characters: [], activePhotoId: null, activeCharacterId: null });
    assert.deepEqual(await library(app.base), { idle, motions: [motion], character: null, photo: null });
    assert.deepEqual(await fs.readFile(path.join(second, 'library.json')), libraryBytes);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(second, 'characters', 'index.json'), 'utf8')),
      { v: 1, activePhotoId: null, characters: [] });
  } finally {
    await stop(app.server);
  }
});

async function waitForJob(base, id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (['succeeded', 'failed', 'canceled'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('animate: a job is made from one photo; its motion goes to that photo, 409 once it is deleted; older jobs use characterId', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { dataDir } = app;
  let base = app.base;
  const hero = (await createCharacter(base, '히어로', fx.png)).character;
  const p1 = hero.basePhotoId;
  const p2 = (await addPhoto(base, hero.id, fx.png)).photo.id;
  const driving = await (await postFile(base, '/api/animate/drivings?name=clip.mp4', fx.clip)).json();
  const createJob = body => send(base, 'POST', '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', ...body });
  const runJob = async body => {
    const response = await createJob(body);
    assert.equal(response.status, 202);
    const done = await waitForJob(base, (await response.json()).job.id);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    return done;
  };

  // A photo is required, and it must be a photo (not a character).
  for (const photoId of [undefined, null, `ph-${uuid()}`, hero.id]) {
    const response = await createJob({ photoId });
    assert.equal(response.status, 400, String(photoId));
    assert.deepEqual(await response.json(), refusal('photo_missing'), String(photoId));
  }

  // The job copies p2, so deleting p2 mid-run does not stop it; its result can no longer become p2's motion.
  let response = await createJob({ photoId: p2, options: { delayMs: 600 } });
  assert.equal(response.status, 202);
  const running = (await response.json()).job;
  assert.equal(running.photoId, p2);
  assert.equal(running.characterId, hero.id);
  assert.equal(running.characterLabel, '히어로');
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'animate', 'jobs', running.id, 'job.json'), 'utf8'));
  assert.deepEqual([stored.photoId, stored.characterId, stored.characterLabel], [p2, hero.id, '히어로']);
  assert.equal((await fetch(`${base}/api/characters/${hero.id}/photos/${p2}`, { method: 'DELETE' })).status, 200);
  const orphan = await waitForJob(base, running.id);
  assert.equal(orphan.state, 'succeeded', JSON.stringify(orphan.error));
  response = await send(base, 'POST', `/api/animate/jobs/${orphan.id}/motion`, {});
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), refusal('photo_missing'));
  assert.equal((await (await fetch(`${base}/api/animate/jobs/${orphan.id}`)).json()).motionId, null);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'media')), [], 'no motion file was copied');

  // p1 on air: its job's result becomes its motion, and the overlay hears about it.
  await setActive(base, p1);
  const stream = await events(base);
  t.after(() => stream.close());
  await stream.nextOfType('obs-source');
  const done = await runJob({ photoId: p1 });
  response = await send(base, 'POST', `/api/animate/jobs/${done.id}/motion`, { name: '인사' });
  assert.equal(response.status, 201);
  const added = await response.json();
  assert.equal(added.motion.photoId, p1);
  assert.equal(added.motion.name, '인사');
  assert.deepEqual((await stream.nextOfType('library')).library.motions, [added.motion]);
  stream.close();
  const list = await (await fetch(`${base}/api/characters`)).json();
  assert.deepEqual(list.characters[0].photos[0].motions.map(item => item.id), [added.motion.id]);

  // Jobs stored before photos named the photo in characterId (null: made from the old idle image).
  const legacyPhotoJob = await runJob({ photoId: p1 });
  const legacyIdleJob = await runJob({ photoId: p1 });
  await stop(app.server);
  for (const [id, characterId] of [[legacyPhotoJob.id, p1], [legacyIdleJob.id, null]]) {
    const file = path.join(dataDir, 'animate', 'jobs', id, 'job.json');
    const job = JSON.parse(await fs.readFile(file, 'utf8'));
    delete job.photoId;
    job.characterId = characterId;
    await fs.writeFile(file, JSON.stringify(job));
  }
  const again = await start(dataDir);
  base = again.base;
  try {
    assert.equal((await (await fetch(`${base}/api/animate/jobs/${legacyPhotoJob.id}`)).json()).photoId, p1);
    response = await send(base, 'POST', `/api/animate/jobs/${legacyPhotoJob.id}/motion`, {});
    assert.equal(response.status, 201);
    assert.equal((await response.json()).motion.photoId, p1);
    response = await send(base, 'POST', `/api/animate/jobs/${legacyIdleJob.id}/motion`, {});
    // A motion always belongs to one photo: a job without one cannot become a motion.
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'photo_missing');
  } finally {
    await stop(again.server);
  }
});

function uploadMotion(base, characterId, photoId, filePath, query = {}) {
  const params = new URLSearchParams({ filename: path.basename(filePath), ...query });
  return fetch(`${base}/api/characters/${characterId}/photos/${photoId}/motions?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fsSync.readFileSync(filePath),
  });
}

test('finished motions: own alpha kept, green screen keyed, busy background kept opaque, other formats converted', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { base, dataDir } = app;
  const hero = (await createCharacter(base, '히어로', fx.png)).character;
  const photoId = hero.basePhotoId;
  const storedPath = motion => path.join(dataDir, 'media', `${motion.id}${motion.mime === 'video/mp4' ? '.mp4' : '.webm'}`);
  const upload = async (filePath, query) => {
    const response = await uploadMotion(base, hero.id, photoId, filePath, query);
    assert.equal(response.status, 201, path.basename(filePath));
    return response.json();
  };

  // 1. A WebM with its own alpha is stored byte for byte.
  let data = await upload(fx.alphaWebm, { name: '원영턴' });
  assert.deepEqual(Object.keys(data).sort(), ['activeCharacterId', 'activePhotoId', 'character', 'characters', 'keyReason', 'keyed', 'motion']);
  assert.equal(data.keyed, false);
  assert.equal(data.keyReason, null);
  const { id, createdAt, fit, ...alpha } = data.motion;
  assert.deepEqual(alpha, {
    name: '원영턴', kind: 'motion', mime: 'video/webm', url: `/api/media/${id}`, photoId,
    source: { upload: { filename: 'alpha.webm', alpha: true, keyed: false, keyColor: null, keyReason: null } },
  });
  assert.ok(Date.parse(createdAt));
  near(fit.first, BOX_FIT);
  assert.deepEqual(fsSync.readFileSync(storedPath(data.motion)), fsSync.readFileSync(fx.alphaWebm));
  assert.equal(data.character.id, hero.id);
  assert.deepEqual(data.character.photos[0].motions.map(item => item.id), [id]);

  // 2. A green-screen MP4 is keyed into a transparent VP9 WebM, like a job result; no name -> the file name.
  data = await upload(fx.greenMp4);
  assert.equal(data.keyed, true);
  assert.equal(data.keyReason, null);
  const keyed = data.motion;
  assert.equal(keyed.name, 'green');
  assert.equal(keyed.mime, 'video/webm');
  assert.equal(keyed.source.upload.keyed, true);
  assert.equal(keyed.source.upload.alpha, false);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(keyed.source.upload.keyColor.slice(i, i + 2), 16));
  assert.ok(g > 200 && r < 60 && b < 60, `detected ${keyed.source.upload.keyColor}`);
  assert.match(probeStream(storedPath(keyed)), /^vp9,/);
  near(keyed.fit.first, BOX_FIT, 0.05); // measured from the keyed alpha

  // 3. A busy background stays opaque: an H.264 MP4 is stored as is, with the detector's reason.
  data = await upload(fx.busyMp4, { name: '  내\n춤  ' });
  assert.equal(data.keyed, false);
  assert.equal(data.keyReason, 'not_uniform');
  assert.equal(data.motion.name, '내 춤');
  assert.equal(data.motion.mime, 'video/mp4');
  assert.equal(data.motion.fit, null);
  assert.deepEqual(data.motion.source.upload, { filename: 'busy.mp4', alpha: false, keyed: false, keyColor: null, keyReason: 'not_uniform' });
  assert.deepEqual(fsSync.readFileSync(storedPath(data.motion)), fsSync.readFileSync(fx.busyMp4));

  // 4. Anything else is converted: a MOV with alpha to a VP9 alpha WebM, MPEG-4 Part 2 to H.264.
  data = await upload(fx.alphaMov);
  assert.equal(data.motion.mime, 'video/webm');
  assert.equal(data.keyed, false);
  assert.equal(data.motion.source.upload.alpha, true);
  assert.match(probeStream(storedPath(data.motion)), /^vp9,/);
  near(data.motion.fit.first, BOX_FIT);
  data = await upload(fx.busyMpeg4);
  assert.equal(data.motion.mime, 'video/mp4');
  assert.equal(data.keyReason, 'not_uniform');
  assert.equal(probeStream(storedPath(data.motion)), 'h264,yuv420p');

  // All five belong to the photo, in upload order; only the stored files are left.
  const list = await (await fetch(`${base}/api/characters`)).json();
  const photo = list.characters[0].photos[0];
  assert.equal(photo.motionCount, 5);
  assert.deepEqual(photo.motions.map(item => item.name), ['원영턴', 'green', '내 춤', 'alpha', 'busy-mpeg4']);
  const storedLibrary = JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8'));
  assert.ok(storedLibrary.motions.every(item => item.photoId === photoId));
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'media'))).sort(), storedLibrary.motions.map(item => path.basename(storedPath(item))).sort());
});

test('finished motions: refusals leave no record or file; only the on-air photo is broadcast', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { base, dataDir } = app;
  const mediaDir = path.join(dataDir, 'media');
  const hero = (await createCharacter(base, '히어로', fx.png)).character;
  const p1 = hero.basePhotoId;
  const p2 = (await addPhoto(base, hero.id, fx.png)).photo.id;
  const other = (await createCharacter(base, '다른 캐릭터', fx.jpg)).character;
  const read = filePath => fsSync.readFileSync(filePath);
  const refused = async (characterId, photoId, body, code, status) => {
    const response = await fetch(`${base}/api/characters/${characterId}/photos/${photoId}/motions?filename=x.mp4`, { method: 'POST', body });
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), refusal(code), code);
  };

  // Not a WebM, MP4 or MOV video (an animated GIF, a PNG, junk, nothing), or longer than 60 s.
  for (const body of [read(fx.gif), read(fx.png), Buffer.from('not a video at all'), Buffer.alloc(0)]) {
    await refused(hero.id, p1, body, 'unsupported_video', 415);
  }
  await refused(hero.id, p1, read(fx.longMp4), 'too_long', 400);
  // The photo must be one of this character's; the character must exist.
  await refused(hero.id, `ph-${uuid()}`, read(fx.busyMp4), 'photo_missing', 404);
  await refused(hero.id, other.basePhotoId, read(fx.busyMp4), 'photo_missing', 404);
  await refused(hero.id, 'ph-..%2F..%2Fphotos', read(fx.busyMp4), 'photo_missing', 404);
  await refused(`c-${uuid()}`, p1, read(fx.busyMp4), 'character_missing', 404);
  await refused('nope', p1, read(fx.busyMp4), 'character_missing', 404);
  const tooLarge = await declaredUpload(app.port, `/api/characters/${hero.id}/photos/${p1}/motions?filename=x.mp4`, 500 * 1024 * 1024 + 1);
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.json, refusal('too_large_video'));
  // No record, no stored file, no temp directory.
  assert.deepEqual(await fs.readdir(mediaDir), []);
  let list = await (await fetch(`${base}/api/characters`)).json();
  assert.ok(list.characters.every(character => character.photos.every(photo => photo.motionCount === 0)));

  // A motion for a photo that is not on air changes nothing the overlay sees.
  await setActive(base, p1);
  const stream = await events(base);
  t.after(() => stream.close());
  await stream.nextOfType('obs-source');
  let response = await uploadMotion(base, hero.id, p2, fx.alphaWebm);
  assert.equal(response.status, 201);
  const forP2 = (await response.json()).motion;
  assert.equal(forP2.photoId, p2);
  assert.equal((await send(base, 'POST', '/api/trigger', { id: forP2.id })).status, 404);
  // The demo avatar never replaces the photo on air: refused, and nothing is broadcast.
  const demo = await send(base, 'POST', '/api/trigger', { id: 'demo' });
  assert.equal(demo.status, 409);
  assert.deepEqual(await demo.json(), { error: '캐릭터 사진이 방송 중일 때는 데모 동작을 재생할 수 없습니다.', code: 'demo_on_air' });
  assert.equal((await send(base, 'POST', '/api/idle', {})).status, 200);
  assert.equal((await stream.next()).type, 'idle', 'no library message for a photo off air, no play for the refused demo');

  // One for the on-air photo is broadcast and can be triggered.
  response = await uploadMotion(base, hero.id, p1, fx.alphaWebm, { name: '손 흔들기' });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.activePhotoId, p1);
  assert.equal(data.activeCharacterId, hero.id);
  const forP1 = data.motion;
  assert.deepEqual((await stream.nextOfType('library')).library.motions, [forP1]);
  assert.equal((await send(base, 'POST', '/api/trigger', { id: forP1.id })).status, 200);
  assert.equal((await stream.nextOfType('play')).id, forP1.id);

  // Deleting the on-air photo takes its uploaded motion, its file and the overlay's view with it.
  assert.equal((await fetch(`${base}/api/characters/${hero.id}/photos/${p1}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await stream.nextOfType('library')).library, { idle: null, motions: [], character: null, photo: null });
  assert.deepEqual(await fs.readdir(mediaDir), [`${forP2.id}.webm`]);
  list = await (await fetch(`${base}/api/characters`)).json();
  assert.deepEqual(list.characters[0].photos.map(photo => [photo.id, photo.motionCount]), [[p2, 1]]);
});

// [r, g, b, a] of one pixel of an image's first frame.
function rgbaAt(filePath, x, y) {
  const width = Number(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width',
    '-of', 'csv=p=0', filePath]).toString().trim());
  const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  const at = (y * width + x) * 4;
  return [...raw.subarray(at, at + 4)];
}

async function fetchToFile(base, pathname, filePath) {
  const response = await fetch(`${base}${pathname}`);
  assert.equal(response.status, 200, pathname);
  const type = response.headers.get('content-type');
  await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return type;
}

test('opaque photos: a plain background is cut out for the list and the overlay; other photos are shown as they are', { skip }, async t => {
  const fx = await fixtures();
  const app = await setup(t);
  const { base, dataDir } = app;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-cutout-check-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const hero = (await createCharacter(base, '흰 배경', fx.whitePng)).character;
  const [white] = hero.photos;
  const cutUrl = `/api/media/${white.id}?variant=cutout`;

  // The PhotoView points at the cutout; `url` stays the original file.
  assert.equal(white.cutout, true);
  assert.equal(white.url, `/api/media/${white.id}`);
  assert.equal(white.displayUrl, cutUrl);
  assert.equal(white.hasAlpha, false);
  const original = path.join(scratch, 'original.png');
  assert.equal(await fetchToFile(base, white.url, original), 'image/png');
  assert.deepEqual(fsSync.readFileSync(original), fsSync.readFileSync(fx.whitePng));
  const cut = path.join(scratch, 'cut.png');
  assert.equal(await fetchToFile(base, cutUrl, cut), 'image/png');
  assert.equal(rgbaAt(cut, 0, 0)[3], 0, 'the white corner is transparent');
  const [r, g, b, a] = rgbaAt(cut, 32, 48);
  assert.ok(a === 255 && r > 240 && g < 16 && b < 16, `the character stays: ${[r, g, b, a]}`);
  assert.equal((await fetch(`${base}${cutUrl}`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${base}${cutUrl}`, { headers: { Range: 'bytes=0-7' } })).status, 206);

  // Stored: the decision (with the cutout's box) and photos/<id>.cutout.png.
  let index = JSON.parse(await fs.readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
  const stored = index.characters[0].photos[0];
  assert.equal(stored.cutout.cut, true);
  assert.match(stored.cutout.color, /^#F[0-9A-F]F[0-9A-F]F[0-9A-F]$/, 'near white');
  assert.deepEqual(stored.cutout.fit.first, BOX_FIT);
  assert.equal(stored.fit, null, 'the photo file itself has no alpha box');
  assert.equal(stored.hasAlpha, false);
  assert.deepEqual(await photoFiles(dataDir), [`${white.id}.cutout.png`, `${white.id}.png`]);

  // On air: the overlay's idle is the cutout, with its box; `photo` is still the original.
  const stream = await events(base);
  t.after(() => stream.close());
  await stream.nextOfType('obs-source');
  let data = await setActive(base, white.id);
  assert.deepEqual(data.library.idle, {
    id: white.id, name: '흰 배경', kind: 'idle', mime: 'image/png', url: cutUrl, createdAt: white.createdAt,
    fit: stored.cutout.fit, source: { photoId: white.id },
  });
  assert.deepEqual(data.library.photo, { id: white.id, url: white.url, width: 64, height: 96, hasAlpha: false });
  assert.deepEqual((await stream.nextOfType('library')).library, data.library);

  // A JPEG on white: the photo stays a JPEG, its cutout is a PNG.
  const jpeg = (await addPhoto(base, hero.id, fx.whiteJpg)).photo;
  assert.equal(jpeg.cutout, true);
  assert.equal(jpeg.displayUrl, `/api/media/${jpeg.id}?variant=cutout`);
  assert.equal(await fetchToFile(base, jpeg.url, path.join(scratch, 'jpeg.jpg')), 'image/jpeg');
  const jpegCut = path.join(scratch, 'jpeg-cut.png');
  assert.equal(await fetchToFile(base, jpeg.displayUrl, jpegCut), 'image/png');
  assert.equal(rgbaAt(jpegCut, 1, 1)[3], 0);
  data = await setActive(base, jpeg.id);
  assert.equal(data.library.idle.mime, 'image/png');
  assert.equal(data.library.idle.url, jpeg.displayUrl);
  near(data.library.idle.fit.first, BOX_FIT);

  // An RGBA PNG with nothing transparent is opaque too: cut, and hasAlpha false.
  const rgba = (await addPhoto(base, hero.id, fx.opaqueRgba)).photo;
  assert.equal(rgba.cutout, true);
  assert.equal(rgba.hasAlpha, false);

  // Not cut: a transparent photo, a busy picture, a single colour. They are shown as they are.
  const cases = [[fx.png, 'has_alpha', true], [fx.busyPng, 'not_uniform', false], [fx.jpg, 'no_subject', false]];
  const others = [];
  for (const [file] of cases) others.push((await addPhoto(base, hero.id, file)).photo);
  index = JSON.parse(await fs.readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
  for (const [i, [file, reason, hasAlpha]] of cases.entries()) {
    const photo = others[i];
    const label = path.basename(file);
    assert.equal(photo.cutout, false, label);
    assert.equal(photo.displayUrl, photo.url, label);
    assert.equal(photo.hasAlpha, hasAlpha, label);
    assert.deepEqual(index.characters[0].photos.find(item => item.id === photo.id).cutout, { cut: false, reason }, label);
    assert.equal((await fetch(`${base}/api/media/${photo.id}?variant=cutout`)).status, 404, label);
  }
  data = await setActive(base, others[1].id);
  assert.equal(data.library.idle.url, others[1].url);
  assert.equal(data.library.idle.fit, null);

  // Only ?variant=cutout exists, and only for photos.
  assert.equal((await fetch(`${base}/api/media/${white.id}?variant=original`)).status, 404);
  const motion = await uploadLegacy(base, 'motion', 'wave');
  assert.equal((await fetch(`${base}/api/media/${motion.id}?variant=cutout`)).status, 404);
  assert.equal((await fetch(`${base}/api/media/${motion.id}`)).status, 200);

  // An idle uploaded for a cut photo wins over the cutout; deleting it brings the cutout back.
  await setActive(base, white.id);
  const uploadedIdle = await uploadLegacy(base, 'idle', 'pose', fsSync.readFileSync(fx.png), '.png');
  assert.equal((await library(base)).idle.id, uploadedIdle.id);
  assert.equal((await fetch(`${base}/api/media/${uploadedIdle.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await library(base)).idle.url, cutUrl);

  // Deleting a cut photo removes its cutout too.
  assert.equal((await fetch(`${base}/api/characters/${hero.id}/photos/${jpeg.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await photoFiles(dataDir)).some(name => name.startsWith(jpeg.id)));
  assert.equal((await fetch(`${base}${jpeg.displayUrl}`)).status, 404);
  assert.equal((await fetch(`${base}/api/characters/${hero.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await photoFiles(dataDir), []);
});

function within(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

test('opaque photos: the startup backfill decides stored photos, corrects hasAlpha, and the overlay gets the cutout live', { skip }, async t => {
  const fx = await fixtures();
  const createdAt = i => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
  const ids = { white: `ph-${uuid()}`, alpha: `ph-${uuid()}`, gray: `ph-${uuid()}`, lostCutout: `ph-${uuid()}`, noFile: `ph-${uuid()}` };
  const characterId = `c-${uuid()}`;
  // Stored before cutouts existed, with the old (wrong) hasAlpha of a grayscale JPEG.
  const photos = [
    photoRecord(ids.white, createdAt(0), { hasAlpha: true }),
    photoRecord(ids.alpha, createdAt(1)),
    photoRecord(ids.gray, createdAt(2), { mime: 'image/jpeg', width: 8, height: 8, hasAlpha: true }),
    // Decided as cut, but its cutout file is gone: decided again.
    photoRecord(ids.lostCutout, createdAt(3), { mime: 'image/jpeg', hasAlpha: false, cutout: { cut: true, color: '#FFFFFF', fit: null } }),
    // No photo file at all: left undecided.
    photoRecord(ids.noFile, createdAt(4)),
  ];
  const app = await setup(t, {
    seed: async dataDir => {
      await seedIndex(dataDir, { v: 1, activePhotoId: ids.white, characters: [{ id: characterId, name: '예전 캐릭터', createdAt: createdAt(0), basePhotoId: ids.white, photos }] });
      const dir = path.join(dataDir, 'characters', 'photos');
      await fs.copyFile(fx.whitePng, path.join(dir, `${ids.white}.png`));
      await fs.copyFile(fx.png, path.join(dir, `${ids.alpha}.png`));
      await fs.copyFile(fx.grayJpg, path.join(dir, `${ids.gray}.jpg`));
      await fs.copyFile(fx.whiteJpg, path.join(dir, `${ids.lostCutout}.jpg`));
    },
  });
  const { base, dataDir } = app;
  const cutUrl = `/api/media/${ids.white}?variant=cutout`;

  // Connected right away: whether the backfill finishes before or after this,
  // the overlay ends up with the cutout without reconnecting.
  const stream = await events(base);
  t.after(() => stream.close());
  await within((async () => {
    for (;;) if ((await stream.nextOfType('library')).library.idle.url === cutUrl) return;
  })(), 20000, 'the overlay never got the cutout');
  await app.server.cutoutBackfill;

  const index = JSON.parse(await fs.readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
  const byId = Object.fromEntries(index.characters[0].photos.map(photo => [photo.id, photo]));
  assert.equal(byId[ids.white].cutout.cut, true);
  assert.deepEqual(byId[ids.white].cutout.fit.first, BOX_FIT);
  assert.equal(byId[ids.white].hasAlpha, false, 'corrected from the decoded image');
  assert.deepEqual(byId[ids.alpha].cutout, { cut: false, reason: 'has_alpha' });
  assert.equal(byId[ids.alpha].hasAlpha, true);
  assert.deepEqual(byId[ids.gray].cutout, { cut: false, reason: 'no_subject' });
  assert.equal(byId[ids.gray].hasAlpha, false, 'a grayscale JPEG is not transparent');
  assert.equal(byId[ids.lostCutout].cutout.cut, true, 'decided again');
  assert.ok(!('cutout' in byId[ids.noFile]), 'no file, no decision');
  const files = await photoFiles(dataDir);
  assert.ok(files.includes(`${ids.white}.cutout.png`) && files.includes(`${ids.lostCutout}.cutout.png`), files.join(' '));
  assert.deepEqual(files.filter(name => name.includes('.tmp')), [], 'no temp files left');

  const list = await (await fetch(`${base}/api/characters`)).json();
  assert.deepEqual(list.characters[0].photos.map(photo => [photo.id, photo.cutout, photo.hasAlpha]), [
    [ids.white, true, false], [ids.alpha, false, true], [ids.gray, false, false], [ids.lostCutout, true, false], [ids.noFile, false, true],
  ]);
  const view = await library(base);
  assert.equal(view.idle.url, cutUrl);
  assert.equal(view.photo.hasAlpha, false);

  // A restart has nothing left to decide (the photo without a file stays as it is).
  const before = await fs.readFile(path.join(dataDir, 'characters', 'index.json'));
  await stop(app.server);
  const again = await start(dataDir);
  try {
    await again.server.cutoutBackfill;
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'characters', 'index.json')), before);
  } finally {
    await stop(again.server);
  }
});

test('hasAlpha: only pixel formats with an alpha channel count; a grayscale JPEG is not transparent', { skip }, async t => {
  const fx = await fixtures();
  for (const pixFmt of ['rgba', 'argb', 'bgra', 'abgr', 'ya8', 'ya16be', 'yuva420p', 'yuva444p10le', 'gbrap', 'rgba64be', 'pal8']) {
    assert.equal(media.pixFmtHasAlpha(pixFmt), true, pixFmt);
  }
  for (const pixFmt of ['gray', 'gray16be', 'grayf32le', 'yuvj420p', 'yuv420p', 'rgb24', 'rgb0', '0rgb', 'bayer_rggb8', 'nv12', '', null, undefined]) {
    assert.equal(media.pixFmtHasAlpha(pixFmt), false, String(pixFmt));
  }
  // The probe: a grayscale JPEG reads as pix_fmt 'gray', which the old /a/ test counted as alpha.
  const gray = await media.probeVideo(FFPROBE, fx.grayJpg);
  assert.equal(gray.pixFmt, 'gray');
  assert.equal(gray.hasAlpha, false);
  assert.equal((await media.probeVideo(FFPROBE, fx.grayAlphaPng)).hasAlpha, true);

  // Photos: the flag says whether the image really has transparent pixels.
  const app = await setup(t);
  const view = async file => (await createCharacter(app.base, path.basename(file), file)).character.photos[0];
  assert.equal((await view(fx.grayJpg)).hasAlpha, false, 'grayscale JPEG');
  assert.equal((await view(fx.grayAlphaPng)).hasAlpha, true, 'grayscale with alpha');
  assert.equal((await view(fx.opaqueRgba)).hasAlpha, false, 'RGBA with nothing transparent');
  assert.equal((await view(fx.png)).hasAlpha, true, 'transparent PNG');
});
