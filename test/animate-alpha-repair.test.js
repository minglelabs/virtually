'use strict';

// The AI remover's flicker: a thin part dropped for a frame or two comes back, with the
// source's colour; a part that really leaves stays gone.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');

const { repairFlicker, repairFrame } = require('../lib/animate/alpha-repair');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
let skip = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { skip = 'ffmpeg is not installed'; }

const W = 64;
const H = 64;
const FRAMES = 12;
const inBox = (x, y, [x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1;
const BODY = [16, 24, 48, 64];
const EAR = [20, 8, 28, 20]; // dropped by "the AI" in frames 5 and 6
const ARM = [48, 30, 60, 40]; // there until frame 6, then really gone

function frames(kind) {
  const all = [];
  for (let f = 0; f < FRAMES; f += 1) {
    const buf = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const o = (y * W + x) * 4;
        const body = inBox(x, y, BODY);
        const ear = inBox(x, y, EAR);
        const arm = inBox(x, y, ARM) && f < 6;
        let rgb = [0, 255, 0]; // the source's green background
        if (body) rgb = [220, 40, 40];
        if (ear) rgb = [40, 40, 220];
        if (arm) rgb = [220, 40, 40];
        let alpha = 255;
        if (kind === 'keyed') {
          const shown = body || arm || (ear && f !== 5 && f !== 6);
          alpha = shown ? 255 : 0;
          if (!shown) rgb = [0, 255, 0];
        }
        buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = alpha;
      }
    }
    all.push(buf);
  }
  return Buffer.concat(all);
}

function encode(raw, file, alpha) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', '10', '-i', 'pipe:0',
    ...(alpha ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '10'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '5']), file], { input: raw, stdio: ['pipe', 'ignore', 'ignore'] });
}

function decode(file) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
}

const px = (raw, f, x, y) => { const o = f * W * H * 4 + (y * W + x) * 4; return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]; };

test('repairFrame: a hole with opacity on both sides is filled from the source; one side only is left', () => {
  const frame = (a) => Buffer.from([0, 255, 0, a]);
  const source = Buffer.from([40, 40, 220, 255]);
  const window = [frame(255), frame(255), frame(0), frame(255), frame(0)];
  const { out, fixed } = repairFrame(window, 2, source, 1, [0, 255, 0]);
  assert.equal(fixed, 1);
  assert.deepEqual([...out], [40, 40, 220, 255]);
  const gone = repairFrame([frame(255), frame(255), frame(0), frame(0), frame(0)], 2, source, 1, null);
  assert.equal(gone.fixed, 0, 'opaque before only: it left');
  const green = repairFrame(window, 2, Buffer.from([0, 250, 5, 255]), 1, [0, 255, 0]);
  assert.equal(green.fixed, 0, "the source's key-colour background never comes back");
});

test('repairFlicker: the dropped ear blinks no more, the arm that left stays gone', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-repair-'));
  try {
    const keyed = path.join(dir, 'keyed.webm');
    const source = path.join(dir, 'source.mp4');
    const dest = path.join(dir, 'repaired.webm');
    encode(frames('keyed'), keyed, true);
    encode(frames('source'), source, false);
    const result = await repairFlicker(FFMPEG, FFPROBE, keyed, source, dest, { keyHex: '#00FF00' });
    assert.equal(result.repaired, true, JSON.stringify(result));
    assert.equal(result.frames, FRAMES);
    const raw = decode(dest);
    for (const f of [5, 6]) {
      const [r, g, b, a] = px(raw, f, 24, 14);
      assert.ok(a > 200, `ear alpha in frame ${f}: ${a}`);
      assert.ok(b > 150 && r < 100 && g < 100, `ear colour from the source in frame ${f}: ${[r, g, b]}`);
    }
    assert.ok(px(raw, 8, 54, 35)[3] < 50, 'the arm that left is not brought back');
    assert.ok(px(raw, 5, 4, 4)[3] < 50, 'the background stays transparent');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
