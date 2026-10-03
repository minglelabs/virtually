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

test('video: a clip on a key colour gets its rim cleaned; any other clip keeps the answer as it came', async (t) => {
  const { edgeCleanFilter } = require('../lib/animate/background-ai');
  assert.match(edgeCleanFilter('green'), /\[o\]despill=type=green:mix=1:expand=0\.6\[ds\];\[m\]alphaextract,erosion\[al\]/);
  assert.match(edgeCleanFilter('blue'), /despill=type=blue:mix=1:expand=0\.6:green=0:blue=-1\[ds\]/);
  assert.match(edgeCleanFilter('green', { choke: false }), /\[m\]alphaextract\[al\]/);
  assert.match(edgeCleanFilter('magenta'), /geq=r='r\(X,Y\)-max\(0,min\(r\(X,Y\),b\(X,Y\)\)-g\(X,Y\)\)'/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'virtually-bgai-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = name => path.join(dir, name);
  const box = 'drawbox=x=16:y=24:w=32:h=48:color=red:t=fill';
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x00FF00:s=64x96:r=8:d=1,${box}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('green.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', `color=c=white:s=64x96:r=8:d=1,${box}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('white.mp4')]);
  // The remover's answer: the box, with a ring of the background kept around it.
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x00FF00:s=64x96:r=8:d=1,${box},format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(between(X,13,51)*between(Y,21,75),255,0)'`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', file('answer.webm')]);
  const ai = createBackgroundAi({
    providers: { wavespeed: { removeBackground: async (ctx, source, destPath) => fsp.copyFile(file('answer.webm'), destPath) } },
    configStore: { resolvedCredentials: () => ({ apiKey: 'k' }), baseUrl: () => null, allowInsecure: () => false },
  });
  const answer = fs.readFileSync(file('answer.webm'));
  await ai.video(file('white.mp4'), file('plain.webm'));
  assert.deepEqual(fs.readFileSync(file('plain.webm')), answer, 'not a key colour: untouched');
  await ai.video(file('green.mp4'), file('clean.webm'), { keyColor: { name: 'green' } });
  assert.notDeepEqual(fs.readFileSync(file('clean.webm')), answer, 'a key colour: cleaned');
  await ai.video(file('green.mp4'), file('found.webm'));
  assert.notDeepEqual(fs.readFileSync(file('found.webm')), answer, 'the key colour is found without being told');
  // Magenta (the key colour of a character that wears green and blue): the same, by the expression.
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0xFF00FF:s=64x96:r=8:d=1,${box.replace('red', 'yellow')}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('magenta.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0xFF00FF:s=64x96:r=8:d=1,${box.replace('red', 'yellow')},format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(between(X,13,51)*between(Y,21,75),255,0)'`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', file('answer-magenta.webm')]);
  const magentaAi = createBackgroundAi({
    providers: { wavespeed: { removeBackground: async (ctx, source, destPath) => fsp.copyFile(file('answer-magenta.webm'), destPath) } },
    configStore: { resolvedCredentials: () => ({ apiKey: 'k' }), baseUrl: () => null, allowInsecure: () => false },
  });
  await magentaAi.video(file('magenta.mp4'), file('clean-magenta.webm'), { keyColor: { name: 'magenta' } });
  const rim = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', file('clean-magenta.webm'), '-frames:v', '1',
    '-vf', 'format=rgba,crop=1:1:14:40', '-f', 'rawvideo', '-']).stdout;
  assert.ok(Math.min(rim[0], rim[2]) <= rim[1] + 40, `red and blue are not both above green at the rim: ${[...rim]}`);
  // Still a transparent clip, and the green ring is gone from its rim: the pixel just outside the box.
  const { measureFit } = require('../lib/animate/fit');
  assert.ok(await measureFit('ffmpeg', 'ffprobe', file('clean.webm')));
  const pixel = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', file('clean.webm'), '-frames:v', '1',
    '-vf', 'format=rgba,crop=1:1:14:40', '-f', 'rawvideo', '-']).stdout;
  assert.ok(pixel[1] <= Math.max(pixel[0], pixel[2]) + 40, `green is not above the other channels at the rim: ${[...pixel]}`);
});
