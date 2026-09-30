'use strict';

// Local background keying for animate results. The routes return an MP4 whose
// background is the solid key-colour canvas the character was composited onto
// (the job's keyColor: green by default, else blue or magenta, see
// key-color.js); here we detect that colour from the clip's border and key it
// out with ffmpeg into a transparent VP9 WebM (yuva420p). Free, local, no upload.
//
// detectKeyColor: 8 border patches (4 corners + 4 edge midpoints, up to 16x16
//   px, averaged to one RGB value) at 5 timestamps -> 40 samples. The
//   per-channel median is accepted only when >= 75 % of the samples lie within
//   RGB distance 40 of it and it lies within RGB distance 100 of the job's
//   expected key colour; otherwise null + 'not_uniform' / 'not_key_color'.
// keyVideo: colorkey (similarity 0.30, blend 0.12) + despill (mix 0.5) of the
//   key colour's type (green / blue; none for magenta) -> libvpx-vp9
//   yuva420p, CRF 30, written to a tmp file and renamed.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const media = require('./media');
const keyColors = require('./key-color');

const SAMPLE_TIMES = 5;
const PATCH_PX = 16;
const MAX_EXPECTED_DISTANCE = 100;
const UNIFORM_DISTANCE = 40;
const UNIFORM_SHARE = 0.75;
const SIMILARITY = 0.30;
const BLEND = 0.12;
const DESPILL_MIX = 0.5;
const CRF = 30;
const MIN_TIMEOUT_MS = 120 * 1000;
const SAMPLE_TIMEOUT_MS = 30 * 1000;

function abortError() {
  return Object.assign(new Error('Canceled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function hex2(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }
function toHex(rgb) { return `#${rgb.map(hex2).join('').toUpperCase()}`; }

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The 8 border patch rectangles for a WxH frame.
function patchRects(width, height) {
  const p = Math.max(1, Math.min(PATCH_PX, Math.floor(width / 4), Math.floor(height / 4)));
  const xs = [0, Math.floor((width - p) / 2), width - p];
  const ys = [0, Math.floor((height - p) / 2), height - p];
  const rects = [];
  for (const y of ys) {
    for (const x of xs) {
      if (x === xs[1] && y === ys[1]) continue; // the centre is the character
      rects.push({ x, y, w: p, h: p });
    }
  }
  return rects;
}

// Pure decision over RGB samples: { color, rgb } or { color: null, reason }.
// `expected` is the job's key colour (a key-color.js record or { name }).
function decideKeyColor(samples, expected = keyColors.DEFAULT_KEY_COLOR) {
  if (!samples.length) return { color: null, reason: 'not_uniform' };
  const rgb = [0, 1, 2].map(channel => median(samples.map(sample => sample[channel])));
  const near = samples.filter(sample => Math.hypot(sample[0] - rgb[0], sample[1] - rgb[1], sample[2] - rgb[2]) <= UNIFORM_DISTANCE).length;
  if (near < UNIFORM_SHARE * samples.length) return { color: null, rgb, reason: 'not_uniform' };
  const target = keyColors.resolveKeyColor(expected).rgb;
  if (Math.hypot(rgb[0] - target[0], rgb[1] - target[1], rgb[2] - target[2]) > MAX_EXPECTED_DISTANCE) {
    return { color: null, rgb, reason: 'not_key_color' };
  }
  const rounded = rgb.map(Math.round);
  return { color: toHex(rounded), rgb: rounded };
}

// Average RGB of each patch in one frame at `at` seconds. One ffmpeg call
// crops the 8 patches, stacks them side by side and dumps raw rgb24.
async function samplePatches(ffmpegPath, filePath, at, rects) {
  const n = rects.length;
  const p = rects[0].w;
  const splits = rects.map((_, i) => `[s${i}]`).join('');
  const crops = rects.map((rect, i) => `[s${i}]crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}[c${i}]`).join(';');
  const stack = `${rects.map((_, i) => `[c${i}]`).join('')}hstack=inputs=${n}[out]`;
  const filter = `[0:v]format=rgb24,split=${n}${splits};${crops};${stack}`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (at > 0) args.push('-ss', at.toFixed(3));
  args.push('-i', filePath, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const result = await media.run(ffmpegPath, args, { timeoutMs: SAMPLE_TIMEOUT_MS, stdoutCap: 4 * 1024 * 1024 });
  const rowBytes = n * p * 3;
  if (result.code !== 0 || result.timedOut || result.stdout.length < rowBytes * p) return [];
  const buf = result.stdout;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const sum = [0, 0, 0];
    for (let y = 0; y < p; y += 1) {
      for (let x = 0; x < p; x += 1) {
        const offset = y * rowBytes + (i * p + x) * 3;
        sum[0] += buf[offset]; sum[1] += buf[offset + 1]; sum[2] += buf[offset + 2];
      }
    }
    out.push(sum.map(value => value / (p * p)));
  }
  return out;
}

// Detect the uniform key-colour background of a clip. Resolves
// { color: '#RRGGBB', rgb, samples } or { color: null, reason, rgb?, samples }.
// Never rejects for a bad clip: an unreadable one is { color: null, reason: 'unreadable' }.
async function detectKeyColor(ffmpegPath, ffprobePath, filePath, { probe = null, expected = keyColors.DEFAULT_KEY_COLOR } = {}) {
  const probed = probe || await media.probeVideo(ffprobePath, filePath).catch(() => null);
  if (!probed || !probed.width || !probed.height) return { color: null, reason: 'unreadable', samples: 0 };
  const rects = patchRects(probed.width, probed.height);
  const duration = Number(probed.duration) || 0;
  const times = Array.from({ length: SAMPLE_TIMES }, (_, i) => (duration > 0 ? duration * (i + 0.5) / SAMPLE_TIMES : 0));
  const perFrame = await Promise.all(times.map(at => samplePatches(ffmpegPath, filePath, at, rects).catch(() => [])));
  const samples = perFrame.flat();
  if (!samples.length) return { color: null, reason: 'unreadable', samples: 0 };
  return { ...decideKeyColor(samples, expected), samples: samples.length };
}

// `despill` = 'green' | 'blue' | null (none, e.g. magenta).
function keyFilter(color, despill = 'green') {
  const hex = String(color).replace(/^#/, '0x');
  const spill = despill ? `despill=type=${despill}:mix=${DESPILL_MIX}:expand=0,` : '';
  return `format=rgba,colorkey=${hex}:${SIMILARITY}:${BLEND},${spill}format=yuva420p`;
}

// Key `sourcePath` with `color` into a transparent WebM at `destPath`
// (tmp + rename). Honours `signal` (kills ffmpeg, rejects with AbortError).
async function keyVideo(ffmpegPath, sourcePath, destPath, { color, despill = 'green', duration = null, signal = null } = {}) {
  if (signal && signal.aborted) throw abortError();
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, 10 * 1000 * (Number(duration) || 0));
  const tmpPath = `${destPath}.${crypto.randomUUID()}.tmp.webm`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', sourcePath,
    '-vf', keyFilter(color, despill),
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', String(CRF),
    '-row-mt', '1', '-an', '-f', 'webm', tmpPath];
  let child = null;
  const onAbort = () => { if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  try {
    const encode = media.spawnEncode(ffmpegPath, args, { timeoutMs, register: c => { child = c; } });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const result = await encode.done;
    if (signal && signal.aborted) throw abortError();
    if (result.timedOut) throw new Error('Background keying timed out.');
    if (result.code !== 0) throw new Error(media.tidy(result.stderr) || 'Background keying failed.');
    await fsp.rename(tmpPath, destPath);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// Detect + key against the job's expected key colour (default green).
// Resolves { keyed: true, color } or { keyed: false, reason }
// (reason 'not_key_color' | 'not_uniform' | 'unreadable') or
// { keyed: false, error } for an ffmpeg failure. Only an abort rejects.
async function autoKey(ffmpegPath, ffprobePath, sourcePath, destPath, { signal = null, expected = keyColors.DEFAULT_KEY_COLOR } = {}) {
  const keyColor = keyColors.resolveKeyColor(expected);
  const probe = await media.probeVideo(ffprobePath, sourcePath).catch(() => null);
  if (signal && signal.aborted) throw abortError();
  const detected = await detectKeyColor(ffmpegPath, ffprobePath, sourcePath, { probe, expected: keyColor });
  if (signal && signal.aborted) throw abortError();
  if (!detected.color) return { keyed: false, reason: detected.reason };
  try {
    await keyVideo(ffmpegPath, sourcePath, destPath, { color: detected.color, despill: keyColor.despill, duration: probe && probe.duration, signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { keyed: false, error: error.message || 'Background keying failed.' };
  }
  return { keyed: true, color: detected.color };
}

module.exports = { detectKeyColor, decideKeyColor, keyVideo, autoKey, keyFilter, patchRects };
