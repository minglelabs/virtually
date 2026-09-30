'use strict';

// Opaque character images get their plain background cut out before the job
// composites them onto the key colour (lib/animate/cutout.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { cutOutBackground, cutOutRgba } = require('../lib/animate/cutout');
const { createAppServer } = require('../server');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const skip = spawnSync(FFMPEG, ['-version']).status === 0 ? false : 'ffmpeg not available';
const ffmpeg = args => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

function rgbaAt(file, x, y, { vp9 = false } = {}) {
  const size = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', file]).toString().trim();
  const w = Number(size);
  const buf = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...(vp9 ? ['-c:v', 'libvpx-vp9'] : []), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
  const o = (y * w + x) * 4;
  return [...buf.subarray(o, o + 4)];
}

// 40x60 opaque image: white background, a green "hoodie" block with a white
// "eye" inside it (enclosed, so it must stay).
function characterRgba() {
  const w = 40; const h = 60; const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const o = (y * w + x) * 4;
    const body = x >= 10 && x < 30 && y >= 10 && y < 50;
    const eye = x >= 18 && x < 22 && y >= 20 && y < 24;
    const rgb = eye ? [255, 255, 255] : body ? [40, 230, 40] : [251, 252, 252];
    px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
  }
  return { px, w, h };
}

test('cutOutRgba: clears the border-connected background, keeps enclosed white, skips transparent or busy images', () => {
  const { px, w, h } = characterRgba();
  const out = cutOutRgba(px, w, h);
  assert.equal(out.cut, true);
  assert.equal(out.color, '#FBFCFC');
  assert.equal(out.alpha[0], 0, 'corner is background');
  assert.equal(out.alpha[20 * w + 20], 255, 'white eye inside the body stays');
  assert.equal(out.alpha[30 * w + 20], 255, 'body stays');
  assert.equal(out.share, Number(((w * h - 20 * 40) / (w * h)).toFixed(4)));

  const transparent = Buffer.from(px); transparent[3] = 0;
  assert.deepEqual(cutOutRgba(transparent, w, h), { cut: false, reason: 'has_alpha' });

  const busy = Buffer.from(px);
  for (let i = 0; i < w * h; i += 1) { busy[i * 4] = (i * 37) % 256; busy[i * 4 + 1] = (i * 91) % 256; busy[i * 4 + 2] = (i * 53) % 256; }
  assert.equal(cutOutRgba(busy, w, h).reason, 'not_uniform');

  const blank = Buffer.alloc(w * h * 4, 255);
  assert.equal(cutOutRgba(blank, w, h).reason, 'no_subject');
});

test('an opaque white-background character is cut out, keyed on blue and comes back transparent', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-cutout-'));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'no-examples.json'), JSON.stringify({ version: 1, examples: [] }));
  const { px, w, h } = characterRgba();
  const character = path.join(dir, 'green-on-white.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0',
    '-vf', 'format=rgb24', '-frames:v', '1', character], { input: px });
  const clip = path.join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);

  // The helper alone: RGBA PNG with a transparent corner.
  const cutFile = path.join(dir, 'cut.png');
  const cut = await cutOutBackground(FFMPEG, FFPROBE, character, cutFile);
  assert.equal(cut.cut, true);
  assert.equal(rgbaAt(cutFile, 0, 0)[3], 0);
  assert.equal(rgbaAt(cutFile, 20, 30)[3], 255);

  const server = await createAppServer({ dataDir, animateMock: true, animatePollIntervalMs: 40, examplesManifestPath: path.join(dataDir, 'no-examples.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/animate/characters?name=c.png`, { method: 'POST', body: fsSync.readFileSync(character) });
    assert.equal(response.status, 201);
    response = await fetch(`${base}/api/animate/drivings?name=clip.mp4`, { method: 'POST', body: fsSync.readFileSync(clip) });
    const driving = await response.json();
    response = await fetch(`${base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drivingId: driving.id, routeId: 'mock/local-demo' }) });
    assert.equal(response.status, 202);
    const id = (await response.json()).job.id;
    let job;
    for (const deadline = Date.now() + 30000; ;) {
      job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
      if (['succeeded', 'failed', 'canceled'].includes(job.state)) break;
      if (Date.now() > deadline) throw new Error(`stuck in ${job.state}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    assert.deepEqual(job.keyColor, { name: 'blue', hex: '#0000FF' }, 'green body -> blue key');
    assert.equal(job.characterCutout.color, '#FBFCFC');
    const jobDir = path.join(dataDir, 'animate', 'jobs', id);
    const corner = rgbaAt(path.join(jobDir, 'character-key.png'), 0, 0);
    assert.ok(corner[2] > 200 && corner[0] < 40 && corner[1] < 40, `composite corner is blue, not white: ${corner}`);
    assert.ok(job.result.keyedUrl, `keyed: ${JSON.stringify(job.result)}`);
    assert.equal(rgbaAt(path.join(jobDir, 'result.webm'), 0, 0, { vp9: true })[3], 0, 'transparent background');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
