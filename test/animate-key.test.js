'use strict';

// Background keying helper (lib/animate/key.js): colour detection on lavfi
// clips, the pure decision rule, keying into a VP9 WebM with alpha, and abort.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { execFileSync } = require('node:child_process');

const key = require('../lib/animate/key');

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

// A uniform key-colour clip with a non-green box in the middle.
function greenClip(filePath, { color = '0x00FA02', size = '320x480', seconds = 3 } = {}) {
  ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=24:d=${seconds}`,
    '-vf', 'drawbox=x=iw/4:y=ih/4:w=iw/2:h=ih/2:color=0xC04020:t=fill',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', filePath]);
}

function alphaFrame(filePath) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-c:v', 'libvpx-vp9', '-i', filePath,
    '-vf', 'alphaextract,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'virtually-key-'));
}

test('decideKeyColor: median, green dominance and uniformity', () => {
  const green = Array.from({ length: 40 }, (_, i) => [0, 250 + (i % 3) - 1, 2]);
  assert.deepEqual(key.decideKeyColor(green), { color: '#00FA02', rgb: [0, 250, 2] });
  // 25 % outliers is still uniform; more is not.
  const mixed = [...green.slice(0, 30), ...Array.from({ length: 10 }, () => [200, 30, 40])];
  assert.equal(key.decideKeyColor(mixed).color, '#00FA02');
  const tooMixed = [...green.slice(0, 29), ...Array.from({ length: 11 }, () => [200, 30, 40])];
  assert.equal(key.decideKeyColor(tooMixed).reason, 'not_uniform');
  // Uniform but not green enough.
  assert.equal(key.decideKeyColor(Array.from({ length: 40 }, () => [0, 0, 255])).reason, 'not_green');
  assert.equal(key.decideKeyColor(Array.from({ length: 40 }, () => [90, 180, 90])).reason, 'not_green'); // margin 90
  assert.equal(key.decideKeyColor(Array.from({ length: 40 }, () => [0, 140, 0])).reason, 'not_green'); // G < 150
  assert.equal(key.decideKeyColor([]).reason, 'not_uniform');
});

test('patchRects: 4 corners + 4 edge midpoints, up to 16 px', () => {
  const rects = key.patchRects(800, 1136);
  assert.equal(rects.length, 8);
  assert.ok(rects.every(rect => rect.w === 16 && rect.h === 16));
  assert.deepEqual(rects.map(rect => [rect.x, rect.y]).sort(),
    [[0, 0], [0, 560], [0, 1120], [392, 0], [392, 1120], [784, 0], [784, 560], [784, 1120]].sort());
  assert.ok(key.patchRects(40, 30).every(rect => rect.w === 7));
});

test('keyFilter uses the detected colour, not a hardcoded one', () => {
  assert.equal(key.keyFilter('#10E020'),
    'format=rgba,colorkey=0x10E020:0.3:0.12,despill=type=green:mix=0.5:expand=0,format=yuva420p');
});

test('detectKeyColor: uniform green -> the source colour; testsrc -> null', { skip }, async () => {
  const dir = await tmpDir();
  try {
    const clip = path.join(dir, 'green.mp4');
    greenClip(clip);
    const found = await key.detectKeyColor(FFMPEG, FFPROBE, clip);
    assert.equal(found.samples, 40);
    assert.ok(found.color, JSON.stringify(found));
    const [r, g, b] = found.rgb;
    assert.ok(Math.abs(r - 0x00) <= 3 && Math.abs(g - 0xFA) <= 3 && Math.abs(b - 0x02) <= 3, `detected ${found.color}`);

    const other = path.join(dir, 'other.mp4');
    greenClip(other, { color: '0x20D040', size: '256x256', seconds: 2 });
    const second = await key.detectKeyColor(FFMPEG, FFPROBE, other);
    assert.ok(second.rgb.every((value, i) => Math.abs(value - [0x20, 0xD0, 0x40][i]) <= 3), `detected ${second.color}`);

    const testsrc = path.join(dir, 'testsrc.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', testsrc]);
    const none = await key.detectKeyColor(FFMPEG, FFPROBE, testsrc);
    assert.equal(none.color, null);
    assert.ok(['not_uniform', 'not_green'].includes(none.reason), none.reason);

    const blue = path.join(dir, 'blue.mp4');
    greenClip(blue, { color: '0x0020F0', size: '128x128', seconds: 1 });
    assert.equal((await key.detectKeyColor(FFMPEG, FFPROBE, blue)).reason, 'not_green');

    const missing = await key.detectKeyColor(FFMPEG, FFPROBE, path.join(dir, 'nope.mp4'));
    assert.deepEqual(missing, { color: null, reason: 'unreadable', samples: 0 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('autoKey writes a VP9 WebM with alpha; a skip writes nothing', { skip }, async () => {
  const dir = await tmpDir();
  try {
    const clip = path.join(dir, 'green.mp4');
    greenClip(clip, { size: '320x480', seconds: 2 });
    const dest = path.join(dir, 'out.webm');
    const outcome = await key.autoKey(FFMPEG, FFPROBE, clip, dest);
    assert.equal(outcome.keyed, true);
    const probe = execFileSync(FFPROBE, ['-v', 'error', '-show_streams', dest]).toString();
    assert.match(probe, /codec_name=vp9/);
    assert.match(probe, /TAG:alpha_mode=1/);
    const alpha = alphaFrame(dest);
    assert.equal(alpha.length, 320 * 480);
    assert.ok(alpha[0] < 10, `corner ${alpha[0]}`);
    assert.ok(alpha[240 * 320 + 160] > 245, `centre ${alpha[240 * 320 + 160]}`);
    assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.tmp')), []);

    const testsrc = path.join(dir, 'testsrc.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', testsrc]);
    const skipped = await key.autoKey(FFMPEG, FFPROBE, testsrc, path.join(dir, 'skip.webm'));
    assert.equal(skipped.keyed, false);
    assert.ok(skipped.reason);
    assert.equal(fsSync.existsSync(path.join(dir, 'skip.webm')), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('keyVideo: an abort kills ffmpeg and leaves no file', { skip }, async () => {
  const dir = await tmpDir();
  try {
    const clip = path.join(dir, 'long.mp4');
    greenClip(clip, { size: '1280x720', seconds: 20 });
    const dest = path.join(dir, 'out.webm');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await assert.rejects(key.keyVideo(FFMPEG, clip, dest, { color: '#00FA02', duration: 20, signal: controller.signal }), { name: 'AbortError' });
    assert.ok(Date.now() - started < 10000, 'aborted promptly');
    assert.deepEqual(await fs.readdir(dir), ['long.mp4']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
