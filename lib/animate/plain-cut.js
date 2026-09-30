'use strict';

// Fallback background removal for a result whose background is one plain colour
// that is NOT the job's key colour — e.g. a model kept the white background of an
// opaque character image instead of the prompted key colour. Colour keying
// (key.js) cannot help there: keying white would also remove pale skin.
//
// plainCutVideo(ffmpegPath, ffprobePath, src, dest, { signal })
//   -> { cut: true, color: '#RRGGBB', share } | { cut: false, reason }
//   reason: 'unreadable' | 'not_plain' (no dominant border colour) |
//           'no_background' / 'no_subject' (almost nothing / everything matched).
// The background colour is the dominant colour of the first frame's 1-px border
// ring (16-level bins per channel, >= MIN_RING_SHARE of the ring, averaged). In
// every frame, pixels within TOLERANCE of it that are 4-connected to the frame
// border become transparent; the 1-px rim next to them is feathered. Areas the
// character encloses (the gap between an arm and the body) stay, and so does any
// pale part of the character: measured on a real result, the background varied
// <= 20 from its mean while pale anime skin sat 30-48 away. Output: VP9 WebM with
// alpha, written to a tmp file and renamed.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const media = require('./media');

const TOLERANCE = 20;
const MIN_RING_SHARE = 0.3;
const MIN_SHARE = 0.02;
const MAX_SHARE = 0.98;
const CRF = 30;
const MIN_TIMEOUT_MS = 2 * 60 * 1000;

function abortError() {
  return Object.assign(new Error('Aborted.'), { name: 'AbortError' });
}

function toHex(rgb) {
  return `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// Dominant colour of the border ring of an RGBA frame, or null.
function ringColor(px, w, h) {
  const bins = new Map();
  let total = 0;
  const add = i => {
    const o = i * 4;
    const k = ((px[o] >> 4) << 8) | ((px[o + 1] >> 4) << 4) | (px[o + 2] >> 4);
    let bin = bins.get(k);
    if (!bin) { bin = [0, 0, 0, 0]; bins.set(k, bin); }
    bin[0] += px[o]; bin[1] += px[o + 1]; bin[2] += px[o + 2]; bin[3] += 1;
    total += 1;
  };
  for (let x = 0; x < w; x += 1) { add(x); if (h > 1) add((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y += 1) { add(y * w); if (w > 1) add(y * w + w - 1); }
  let best = null;
  for (const bin of bins.values()) if (!best || bin[3] > best[3]) best = bin;
  if (!best || best[3] < MIN_RING_SHARE * total) return null;
  return [best[0] / best[3], best[1] / best[3], best[2] / best[3]];
}

// Alpha (Uint8Array) for one RGBA frame: 0 for border-connected pixels within
// TOLERANCE of `bg`, feathered on their 1-px rim, 255 elsewhere. Also returns the
// background share. `work` holds reusable buffers for a w x h frame.
function frameAlpha(px, w, h, bg, work = newWork(w, h)) {
  const { near, seen, queue, alpha } = work;
  const n = w * h;
  const tol2 = TOLERANCE * TOLERANCE;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const dr = px[o] - bg[0]; const dg = px[o + 1] - bg[1]; const db = px[o + 2] - bg[2];
    near[i] = dr * dr + dg * dg + db * db <= tol2 ? 1 : 0;
  }
  seen.fill(0);
  let tail = 0;
  const seed = i => { if (near[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x += 1) { seed(x); seed((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y += 1) { seed(y * w); seed(y * w + w - 1); }
  for (let head = 0; head < tail; head += 1) {
    const i = queue[head];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  for (let i = 0; i < n; i += 1) {
    if (seen[i]) { alpha[i] = 0; continue; }
    const x = i % w;
    const rim = (x > 0 && seen[i - 1]) || (x < w - 1 && seen[i + 1]) || (i >= w && seen[i - w]) || (i < n - w && seen[i + w]);
    if (!rim) { alpha[i] = 255; continue; }
    const o = i * 4;
    const d = Math.hypot(px[o] - bg[0], px[o + 1] - bg[1], px[o + 2] - bg[2]);
    alpha[i] = Math.max(0, Math.min(255, Math.round(255 * (d - TOLERANCE / 2) / (TOLERANCE * 1.5))));
  }
  return { alpha, share: tail / n };
}

function newWork(w, h) {
  const n = w * h;
  return { near: new Uint8Array(n), seen: new Uint8Array(n), queue: new Int32Array(n), alpha: new Uint8Array(n) };
}

async function plainCutVideo(ffmpegPath, ffprobePath, sourcePath, destPath, { signal = null } = {}) {
  if (signal && signal.aborted) throw abortError();
  const probe = await media.probeVideo(ffprobePath, sourcePath).catch(() => null);
  if (!probe || !probe.width || !probe.height) return { cut: false, reason: 'unreadable' };
  const w = probe.width;
  const h = probe.height;
  const fps = probe.fps || 30;
  const frameBytes = w * h * 4;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, 20 * 1000 * (Number(probe.duration) || 0));
  const tmpPath = `${destPath}.${crypto.randomUUID()}.tmp.webm`;

  const decoder = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', sourcePath,
    '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let encoder = null;
  let bg = null;
  let verdict = null; // { cut: false, reason } decided on the first frame
  let shareSum = 0;
  let frames = 0;
  let pending = Buffer.alloc(0);
  const work = newWork(w, h);
  const stderr = [];
  let timedOut = false;
  const killAll = () => {
    for (const child of [decoder, encoder]) if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  const timer = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
  const onAbort = () => killAll();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const startEncoder = () => {
    encoder = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', String(fps), '-i', 'pipe:0',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', String(CRF),
      '-row-mt', '1', '-an', '-f', 'webm', tmpPath], { stdio: ['pipe', 'ignore', 'pipe'] });
    encoder.stderr.on('data', chunk => { if (stderr.length < 20) stderr.push(chunk.toString()); });
    encoder.stdin.on('error', () => { /* reported by close */ });
  };

  const handleFrame = frame => {
    if (!bg) {
      bg = ringColor(frame, w, h);
      if (!bg) { verdict = { cut: false, reason: 'not_plain' }; return false; }
      startEncoder();
    }
    const { alpha, share } = frameAlpha(frame, w, h, bg, work);
    shareSum += share;
    frames += 1;
    const out = Buffer.from(frame);
    for (let i = 0; i < w * h; i += 1) out[i * 4 + 3] = alpha[i];
    return encoder.stdin.write(out);
  };

  try {
    await new Promise((resolve, reject) => {
      decoder.stderr.on('data', chunk => { if (stderr.length < 20) stderr.push(chunk.toString()); });
      decoder.on('error', reject);
      decoder.stdout.on('data', chunk => {
        if (verdict) return;
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= frameBytes && !verdict) {
          const frame = pending.subarray(0, frameBytes);
          pending = pending.subarray(frameBytes);
          if (handleFrame(frame) === false && !verdict) {
            decoder.stdout.pause();
            encoder.stdin.once('drain', () => decoder.stdout.resume());
          }
        }
        if (verdict) { try { decoder.kill('SIGKILL'); } catch { /* gone */ } }
      });
      decoder.on('close', code => {
        if (verdict) return resolve();
        if (signal && signal.aborted) return reject(abortError());
        if (timedOut) return reject(new Error('Background removal timed out.'));
        if (code !== 0 || !frames) return reject(new Error(media.tidy(stderr.join('')) || `ffmpeg exited with ${code}`));
        resolve();
      });
    });
    if (verdict) return verdict;
    const share = shareSum / frames;
    encoder.stdin.end();
    await new Promise((resolve, reject) => {
      encoder.on('error', reject);
      encoder.on('close', code => {
        if (signal && signal.aborted) return reject(abortError());
        if (timedOut) return reject(new Error('Background removal timed out.'));
        if (code !== 0) return reject(new Error(media.tidy(stderr.join('')) || `ffmpeg exited with ${code}`));
        resolve();
      });
    });
    if (share < MIN_SHARE) return { cut: false, reason: 'no_background' };
    if (share > MAX_SHARE) return { cut: false, reason: 'no_subject' };
    await fsp.rename(tmpPath, destPath);
    return { cut: true, color: toHex(bg), share: Number(share.toFixed(4)) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (encoder && encoder.exitCode === null) { try { encoder.kill('SIGKILL'); } catch { /* gone */ } }
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

module.exports = { plainCutVideo, frameAlpha, ringColor, TOLERANCE };
