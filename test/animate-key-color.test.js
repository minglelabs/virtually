'use strict';

// Per-job chroma-key colour: chooseKeyColor on generated character images, the
// prompts / bodies each colour produces (green must match the pre-key-colour
// output byte for byte), and a mock-route E2E with a green-shirted character.
// No network: bodies are built locally and the mock route renders with ffmpeg.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { execFileSync } = require('node:child_process');

const keyColors = require('../lib/animate/key-color');
const { ROUTES, buildRequest } = require('../lib/animate/catalog');
const { MOCK_ROUTE } = require('../lib/animate/registry');
const { promptFor, motionPromptFor } = require('../lib/animate/pipeline');
const presets = require('../lib/animate/presets');
const { createAppServer } = require('../server');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const A2_ID = 'wavespeed/wan-2.2-animate-2';

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

// An RGBA PNG: transparent canvas with filled rectangles [x0, y0, x1, y1, [r, g, b]].
function makeRgbaImage(filePath, { w = 64, h = 96, boxes }) {
  const channel = i => boxes.reduceRight((acc, [x0, y0, x1, y1, rgb]) =>
    `if(between(X\\,${x0}\\,${x1})*between(Y\\,${y0}\\,${y1})\\,${rgb[i]}\\,${acc})`, '0');
  const alpha = boxes.reduceRight((acc, [x0, y0, x1, y1]) =>
    `if(between(X\\,${x0}\\,${x1})*between(Y\\,${y0}\\,${y1})\\,255\\,${acc})`, '0');
  ffmpeg(['-f', 'lavfi', '-i', `nullsrc=s=${w}x${h},format=rgba,geq=r='${channel(0)}':g='${channel(1)}':b='${channel(2)}':a='${alpha}'`,
    '-frames:v', '1', filePath]);
}

// An opaque RGB PNG (no alpha channel): white with one filled rectangle.
function makeRgbImage(filePath, { w = 200, h = 300, box: [x0, y0, x1, y1, rgb] }) {
  ffmpeg(['-f', 'lavfi', '-i', `color=c=white:s=${w}x${h}`, '-vf',
    `drawbox=x=${x0}:y=${y0}:w=${x1 - x0}:h=${y1 - y0}:color=0x${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}:t=fill,format=rgb24`,
    '-frames:v', '1', filePath]);
}

// A character with a red face and a green shirt on a transparent canvas.
function makeGreenShirt(filePath) {
  makeRgbaImage(filePath, { boxes: [[16, 24, 47, 40, [230, 40, 40]], [16, 41, 47, 71, [30, 170, 50]]] });
}

function firstPixel(filePath) {
  return [...execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).subarray(0, 3)];
}

function alphaFrame(filePath) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-c:v', 'libvpx-vp9', '-i', filePath,
    '-vf', 'alphaextract,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
}

// --- the pure decision ----------------------------------------------------------

test('rgbToHsv and decideFromRgba thresholds', () => {
  assert.deepEqual(keyColors.rgbToHsv(0, 255, 0), { h: 120, s: 1, v: 1 });
  assert.equal(Math.round(keyColors.rgbToHsv(255, 0, 255).h), 300);
  const px = (rgb, a = 255, n = 1) => Array.from({ length: n }, () => [...rgb, a]).flat();
  // 1000 red pixels + 4 green (0.4 %) -> still green; 5 green (0.5 %) -> blue.
  assert.equal(keyColors.decideFromRgba(Buffer.from([...px([255, 0, 0], 255, 996), ...px([0, 255, 0], 255, 4)])).name, 'green');
  assert.equal(keyColors.decideFromRgba(Buffer.from([...px([255, 0, 0], 255, 995), ...px([0, 255, 0], 255, 5)])).name, 'blue');
  // Transparent green does not count; dark (V < 0.25) or grey (S < 0.35) green does not either.
  assert.equal(keyColors.decideFromRgba(Buffer.from([...px([255, 0, 0], 255, 10), ...px([0, 255, 0], 127, 10)])).name, 'green');
  assert.equal(keyColors.decideFromRgba(Buffer.from([...px([255, 0, 0], 255, 10), ...px([0, 60, 0], 255, 10)])).name, 'green');
  assert.equal(keyColors.decideFromRgba(Buffer.from([...px([255, 0, 0], 255, 10), ...px([150, 200, 150], 255, 10)])).name, 'green');
  // Every candidate conflicts -> the smallest share wins.
  const all = keyColors.decideFromRgba(Buffer.from([...px([0, 255, 0], 255, 5), ...px([0, 0, 255], 255, 3), ...px([255, 0, 255], 255, 4)]));
  assert.equal(all.name, 'blue');
  assert.deepEqual(all.shares, { green: 5 / 12, blue: 3 / 12, magenta: 4 / 12 });
  // No opaque pixel at all: judge every pixel.
  assert.equal(keyColors.decideFromRgba(Buffer.from(px([0, 255, 0], 0, 10))).name, 'blue');
});

test('resolveKeyColor: missing / unknown -> green', () => {
  assert.equal(keyColors.resolveKeyColor(undefined).name, 'green');
  assert.equal(keyColors.resolveKeyColor({ name: 'toString' }).name, 'green');
  assert.equal(keyColors.resolveKeyColor({ name: 'blue', hex: '#0000FF' }).hex, '#0000FF');
  assert.equal(keyColors.ffmpegHex(null), '0x00FF00');
  assert.equal(keyColors.ffmpegHex({ name: 'magenta' }), '0xFF00FF');
});

// --- chooseKeyColor on generated PNGs ---------------------------------------------

test('chooseKeyColor on generated characters', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-keycolor-'));
  try {
    const purple = path.join(dir, 'purple.png');
    makeRgbaImage(purple, { boxes: [[16, 24, 47, 47, [150, 60, 220]], [16, 48, 47, 71, [255, 105, 180]]] });
    const purpleResult = await keyColors.chooseKeyColor(FFMPEG, purple);
    assert.equal(purpleResult.name, 'green', JSON.stringify(purpleResult));
    assert.equal(purpleResult.hex, '#00FF00');
    assert.equal(purpleResult.shares.green, 0);

    const shirt = path.join(dir, 'shirt.png');
    makeGreenShirt(shirt);
    const shirtResult = await keyColors.chooseKeyColor(FFMPEG, shirt);
    assert.deepEqual([shirtResult.name, shirtResult.hex], ['blue', '#0000FF'], JSON.stringify(shirtResult));
    assert.ok(shirtResult.shares.green > 0.4, JSON.stringify(shirtResult.shares));

    const both = path.join(dir, 'both.png');
    makeRgbaImage(both, { boxes: [[16, 24, 47, 47, [30, 170, 50]], [16, 48, 47, 71, [30, 60, 200]]] });
    const bothResult = await keyColors.chooseKeyColor(FFMPEG, both);
    assert.deepEqual([bothResult.name, bothResult.hex], ['magenta', '#FF00FF'], JSON.stringify(bothResult));

    // No alpha channel: every pixel counts (white background is not a conflict).
    const opaque = path.join(dir, 'opaque.png');
    makeRgbImage(opaque, { box: [50, 50, 150, 250, [20, 180, 60]] });
    const opaqueResult = await keyColors.chooseKeyColor(FFMPEG, opaque);
    assert.equal(opaqueResult.name, 'blue', JSON.stringify(opaqueResult));
    const opaqueRed = path.join(dir, 'opaque-red.png');
    makeRgbImage(opaqueRed, { box: [50, 50, 150, 250, [220, 30, 30]] });
    assert.equal((await keyColors.chooseKeyColor(FFMPEG, opaqueRed)).name, 'green');

    await assert.rejects(keyColors.chooseKeyColor(FFMPEG, path.join(dir, 'missing.png')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- prompts and bodies -------------------------------------------------------------

// The prompt exactly as it was built before the key colour existed.
const LEGACY_BACKGROUND = 'Background description: plain solid pure green (#00FF00) chroma-key background, '
  + 'flat even lighting, no shadows, no objects, no text.';
const LEGACY_SUFFIX = 'Keep the plain solid green background unchanged and empty. Static camera, no zoom, no camera movement.';
function legacyPrompt(route, presetKey, promptSuffix) {
  if (!route.fields || !route.fields.prompt) return null;
  if (route.id === A2_ID) return LEGACY_BACKGROUND;
  const preset = presets.getPreset(presetKey);
  const base = (preset && preset.prompt) || presets.GENERIC_PROMPT;
  const suffix = promptSuffix == null ? LEGACY_SUFFIX : promptSuffix;
  return suffix ? `${base} ${suffix}` : base;
}

function body(route, prompt, presetKey) {
  return buildRequest(route, {
    imageUrl: 'https://cdn.example/char.png', videoUrl: 'https://cdn.example/ref.mp4',
    prompt, motionPrompt: motionPromptFor(route, presetKey), orientation: 'image', options: {},
  });
}

test('green: every route body is identical to the pre-key-colour body', () => {
  assert.equal(presets.DEFAULT_PROMPT_SUFFIX, LEGACY_SUFFIX);
  const green = { name: 'green', hex: '#00FF00' };
  let compared = 0;
  for (const route of [...ROUTES, MOCK_ROUTE]) {
    for (const presetKey of ['hi', null]) {
      for (const suffix of [presets.DEFAULT_PROMPT_SUFFIX, undefined, '', 'MY OWN SUFFIX']) {
        const expected = body(route, legacyPrompt(route, presetKey, suffix), presetKey);
        for (const keyColor of [green, null, undefined]) {
          assert.deepEqual(body(route, promptFor(route, presetKey, suffix, keyColor), presetKey), expected,
            `${route.id} ${presetKey} ${suffix} ${JSON.stringify(keyColor)}`);
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared > 100, `compared ${compared}`);
});

test('blue / magenta: Animate 2 background and the default suffix name the colour', () => {
  const a2 = ROUTES.find(route => route.id === A2_ID);
  assert.equal(promptFor(a2, 'hi', presets.DEFAULT_PROMPT_SUFFIX, { name: 'blue', hex: '#0000FF' }),
    'Background description: plain solid pure blue (#0000FF) chroma-key background, flat even lighting, no shadows, no objects, no text.');
  assert.equal(promptFor(a2, 'hi', 'ignored', { name: 'magenta', hex: '#FF00FF' }),
    'Background description: plain solid pure magenta (#FF00FF) chroma-key background, flat even lighting, no shadows, no objects, no text.');
  const hi = presets.getPreset('hi').prompt;
  assert.equal(promptFor(MOCK_ROUTE, 'hi', presets.DEFAULT_PROMPT_SUFFIX, { name: 'blue' }),
    `${hi} Keep the plain solid blue background unchanged and empty. Static camera, no zoom, no camera movement.`);
  assert.equal(promptFor(MOCK_ROUTE, 'hi', null, { name: 'magenta' }),
    `${hi} Keep the plain solid magenta background unchanged and empty. Static camera, no zoom, no camera movement.`);
  // A custom suffix is the user's own wording and is kept as is.
  assert.equal(promptFor(MOCK_ROUTE, 'hi', 'MY OWN SUFFIX', { name: 'blue' }), `${hi} MY OWN SUFFIX`);
  assert.equal(promptFor(MOCK_ROUTE, 'hi', '', { name: 'blue' }), hi);
});

test('a job stored without keyColor (older) views as green', () => {
  const { Pipeline } = require('../lib/animate/pipeline');
  const pipeline = new Pipeline({ dataDir: os.tmpdir() });
  assert.deepEqual(pipeline.view({ id: 'old', state: 'failed', estimate: null }).keyColor, { name: 'green', hex: '#00FF00' });
  assert.deepEqual(pipeline.view({ id: 'b', state: 'failed', estimate: null, keyColor: { name: 'blue', hex: '#0000FF' } }).keyColor,
    { name: 'blue', hex: '#0000FF' });
});

test('page note: only for a non-green key colour', () => {
  const H = require('../public/animate.js');
  assert.equal(H.keyColorNote({ keyColor: { name: 'green', hex: '#00FF00' } }), '');
  assert.equal(H.keyColorNote({}), '');
  assert.equal(H.keyColorNote({ keyColor: { name: 'blue', hex: '#0000FF' } }), '캐릭터에 초록색이 있어 파란 배경으로 만들었습니다');
  assert.match(H.keyColorNote({ keyColor: { name: 'magenta', hex: '#FF00FF' } }), /분홍 배경/);
});

// --- E2E with the mock route --------------------------------------------------------

async function waitForJob(base, id, states, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (states.includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}: ${JSON.stringify(job.error)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function post(base, pathname, bodyValue, contentType = 'application/json') {
  return fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': contentType },
    body: contentType === 'application/json' ? JSON.stringify(bodyValue) : bodyValue,
  });
}

test('E2E: a green-shirted character is keyed on blue; a green-free one stays green', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-keycolor-e2e-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-'));
  const shirt = path.join(dir, 'shirt.png');
  makeGreenShirt(shirt);
  const red = path.join(dir, 'red.png');
  makeRgbaImage(red, { boxes: [[16, 24, 47, 71, [255, 0, 0]]] });
  const clip = path.join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
  const manifestPath = path.join(dir, 'driving.json');
  await fs.writeFile(manifestPath, JSON.stringify({ version: 1, examples: [] }));
  const server = await createAppServer({ dataDir, examplesManifestPath: manifestPath, allowHttpExamples: true, animateMock: true, animatePollIntervalMs: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobDir = id => path.join(dataDir, 'animate', 'jobs', id);
  const a2 = ROUTES.find(route => route.id === A2_ID);
  try {
    const driving = await (await post(base, '/api/animate/drivings?name=clip.mp4', fsSync.readFileSync(clip), 'application/octet-stream')).json();
    const runJob = async characterPath => {
      const uploaded = await post(base, '/api/animate/character?name=c.png', fsSync.readFileSync(characterPath), 'image/png');
      assert.equal(uploaded.status, 201);
      await uploaded.arrayBuffer();
      const response = await post(base, '/api/animate/jobs', { drivingId: driving.id, routeId: MOCK_ROUTE.id });
      assert.equal(response.status, 202);
      const done = await waitForJob(base, (await response.json()).job.id, ['succeeded', 'failed']);
      assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
      const stored = JSON.parse(await fs.readFile(path.join(jobDir(done.id), 'job.json'), 'utf8'));
      return { done, stored };
    };

    // Green shirt -> blue.
    const { done, stored } = await runJob(shirt);
    assert.deepEqual(done.keyColor, { name: 'blue', hex: '#0000FF' });
    assert.deepEqual(stored.keyColor, { name: 'blue', hex: '#0000FF' });
    const corner = firstPixel(path.join(jobDir(done.id), 'character-key.png'));
    assert.ok(corner[0] < 10 && corner[1] < 10 && corner[2] > 245, `composite corner ${corner}`);
    const resultCorner = firstPixel(path.join(jobDir(done.id), 'result.mp4'));
    assert.ok(resultCorner[2] > 200 && resultCorner[1] < 60, `mock result corner ${resultCorner}`);
    assert.match(stored.prompt, /Keep the plain solid blue background unchanged and empty\./);
    const a2Body = body(a2, promptFor(a2, stored.presetKey, presets.DEFAULT_PROMPT_SUFFIX, stored.keyColor), stored.presetKey);
    assert.equal(a2Body.prompt,
      'Background description: plain solid pure blue (#0000FF) chroma-key background, flat even lighting, no shadows, no objects, no text.');
    assert.ok(done.result.keyedUrl, JSON.stringify(done.result));
    const [r, g, b] = [1, 3, 5].map(i => parseInt(done.result.keyColor.slice(i, i + 2), 16));
    assert.ok(b > 200 && r < 60 && g < 60, `detected ${done.result.keyColor}`);
    const alpha = alphaFrame(path.join(jobDir(done.id), 'result.webm'));
    assert.equal(alpha.length, 64 * 96);
    assert.ok(alpha[0] < 10, `corner alpha ${alpha[0]}`);
    assert.ok(alpha[48 * 64 + 32] > 245, `centre (green shirt) alpha ${alpha[48 * 64 + 32]}`);
    assert.ok(alpha[30 * 64 + 32] > 245, `face alpha ${alpha[30 * 64 + 32]}`);
    const added = await (await post(base, `/api/animate/jobs/${done.id}/motion`, {})).json();
    assert.equal(added.keyed, true);
    assert.equal(added.motion.mime, 'video/webm');
    assert.ok(fsSync.existsSync(path.join(dataDir, 'media', `${added.motion.id}.webm`)));

    // Green-free character -> green, and the bodies are the legacy ones.
    const plain = await runJob(red);
    assert.deepEqual(plain.done.keyColor, { name: 'green', hex: '#00FF00' });
    const plainCorner = firstPixel(path.join(jobDir(plain.done.id), 'character-key.png'));
    assert.ok(plainCorner[0] < 10 && plainCorner[1] > 245 && plainCorner[2] < 10, `composite corner ${plainCorner}`);
    assert.equal(plain.stored.prompt, legacyPrompt(MOCK_ROUTE, plain.stored.presetKey, presets.DEFAULT_PROMPT_SUFFIX));
    for (const route of [...ROUTES, MOCK_ROUTE]) {
      assert.deepEqual(body(route, promptFor(route, plain.stored.presetKey, presets.DEFAULT_PROMPT_SUFFIX, plain.stored.keyColor), plain.stored.presetKey),
        body(route, legacyPrompt(route, plain.stored.presetKey, presets.DEFAULT_PROMPT_SUFFIX), plain.stored.presetKey), route.id);
    }
    assert.ok(plain.done.result.keyedUrl);
    const plainAlpha = alphaFrame(path.join(jobDir(plain.done.id), 'result.webm'));
    assert.ok(plainAlpha[0] < 10 && plainAlpha[48 * 64 + 32] > 245);

  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
