'use strict';

// The paid AI removers' own module: the price of a video and what counts as an answer.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createBackgroundAi, videoUsd, PRICES } = require('../lib/animate/background-ai');

const ffmpeg = args => {
  const done = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  assert.equal(done.status, 0, String(done.stderr));
};

test('video price: $0.05 a second, whole seconds rounded up', () => {
  assert.deepEqual([PRICES.videoUsdPerSecond, PRICES.videoMinSeconds], [0.05, 1]);
  assert.deepEqual([videoUsd(2.97), videoUsd(3), videoUsd(3.1), videoUsd(0.2), videoUsd(null)], [0.15, 0.15, 0.2, 0.05, 0.05]);
});

test('video: the answer is kept as it comes when it has transparent pixels, refused when it has none', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'virtually-bgai-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = name => path.join(dir, name);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=64x96:r=8:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('source.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', "color=c=red:s=64x96:r=8:d=1,format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(between(X,16,48)*between(Y,24,72),255,0)'",
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', file('alpha.webm')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=64x96:r=8:d=1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', file('opaque.webm')]);
  const calls = [];
  let answer = file('alpha.webm');
  const ai = createBackgroundAi({
    providers: { wavespeed: { removeBackground: async (ctx, source, destPath, kind) => { calls.push([kind, source.filename]); await fsp.copyFile(answer, destPath); } } },
    configStore: { resolvedCredentials: () => ({ apiKey: 'k' }), baseUrl: () => null, allowInsecure: () => false },
  });
  await ai.video(file('source.mp4'), file('out.webm'));
  assert.deepEqual(calls, [['video', 'source.mp4']]);
  assert.deepEqual(fs.readFileSync(file('out.webm')), fs.readFileSync(file('alpha.webm')));
  answer = file('opaque.webm');
  await assert.rejects(ai.video(file('source.mp4'), file('out2.webm')), /no transparent background/);
  assert.equal(fs.existsSync(file('out2.webm')), false);
});
