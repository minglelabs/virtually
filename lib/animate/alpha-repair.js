'use strict';

// Flicker repair for the AI background remover's videos. The model decides frame by
// frame, so a thin part of the character (an ear, a small heart above the head, a
// strand of hair) can be taken for background in one or two frames and come back in
// the next: on air it blinks. Here, a pixel that is (nearly) transparent in a frame but
// opaque both within FILL_WINDOW frames before and within FILL_WINDOW frames after gets
// its opacity back, and its colour from the original video at that frame (the AI's
// answer has the key colour there). A part that really moves away is opaque on one side
// only and stays as it is.
//
// repairFlicker(ffmpegPath, ffprobePath, keyedPath, sourcePath, destPath, { signal, keyHex })
//   -> { repaired: true, frames, pixels } | { repaired: false, reason }
//   keyedPath: the keyed AI answer (VP9 WebM with alpha); sourcePath: the video that was
//   sent (same timing). keyHex: the colour of the source's own background when it is a
//   key colour (a generated clip): such pixels are never brought back.
//   reason: 'unreadable' | 'mismatch' (not the same length) | 'nothing' (no flicker).

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const media = require('./media');

const FILL_WINDOW = 2; // frames looked at on each side
const LOW = 64; // at most this alpha counts as "gone" in a frame
const HIGH = 160; // at least this alpha on both sides brings it back
const KEY_DISTANCE = 90; // source pixels this close to keyHex are background
const CRF = 30;
const MIN_TIMEOUT_MS = 2 * 60 * 1000;

function abortError() {
  return Object.assign(new Error('Aborted.'), { name: 'AbortError' });
}

function hexRgb(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : null;
}

// Exact-size frames from a child's stdout: next() -> Buffer, or null at the end.
// Chunks are kept as they come and joined once per frame (a frame is many chunks).
function frameReader(stream, frameBytes) {
  const iterator = stream[Symbol.asyncIterator]();
  const chunks = [];
  let length = 0;
  let ended = false;
  return {
    async next() {
      while (length < frameBytes && !ended) {
        const { value, done } = await iterator.next().catch(() => ({ done: true }));
        if (done) ended = true;
        else { chunks.push(value); length += value.length; }
      }
      if (length < frameBytes) return null;
      const frame = Buffer.allocUnsafe(frameBytes);
      let filled = 0;
      while (filled < frameBytes) {
        const chunk = chunks[0];
        const take = Math.min(chunk.length, frameBytes - filled);
        chunk.copy(frame, filled, 0, take);
        filled += take;
        if (take === chunk.length) chunks.shift();
        else chunks[0] = chunk.subarray(take);
      }
      length -= frameBytes;
      return frame;
    },
  };
}

// One output frame from the window (frames[c] is the current one) and the source frame.
// Returns how many pixels were brought back.
function repairFrame(frames, c, source, pixels, key) {
  const frame = frames[c];
  const out = Buffer.from(frame);
  let fixed = 0;
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4 + 3;
    const a = frame[o];
    if (a > LOW) continue;
    let before = 0;
    let after = 0;
    for (let k = 1; k <= FILL_WINDOW; k += 1) {
      if (frames[c - k]) before = Math.max(before, frames[c - k][o]);
      if (frames[c + k]) after = Math.max(after, frames[c + k][o]);
    }
    const fill = Math.min(before, after);
    if (fill < HIGH) continue;
    const p = i * 4;
    if (key) {
      const dr = source[p] - key[0];
      const dg = source[p + 1] - key[1];
      const db = source[p + 2] - key[2];
      if (dr * dr + dg * dg + db * db < KEY_DISTANCE * KEY_DISTANCE) continue;
    }
    out[p] = source[p];
    out[p + 1] = source[p + 1];
    out[p + 2] = source[p + 2];
    out[o] = fill;
    fixed += 1;
  }
  return { out, fixed };
}

async function repairFlicker(ffmpegPath, ffprobePath, keyedPath, sourcePath, destPath, { signal = null, keyHex = null } = {}) {
  if (signal && signal.aborted) throw abortError();
  const [keyed, source] = await Promise.all([
    media.probeVideo(ffprobePath, keyedPath).catch(() => null),
    media.probeVideo(ffprobePath, sourcePath).catch(() => null),
  ]);
  if (!keyed || !keyed.width || !keyed.height || !source || !source.width) return { repaired: false, reason: 'unreadable' };
  if (keyed.duration && source.duration && Math.abs(keyed.duration - source.duration) > 0.25) return { repaired: false, reason: 'mismatch' };
  const w = keyed.width;
  const h = keyed.height;
  const fps = keyed.fps || 30;
  const pixels = w * h;
  const frameBytes = pixels * 4;
  const key = hexRgb(keyHex);
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, 30 * 1000 * (Number(keyed.duration) || 0));
  const tmpPath = `${destPath}.${crypto.randomUUID()}.tmp.webm`;

  const quiet = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  // One stream: the keyed frame on the left, the source frame (at its size and rate) on the
  // right, both renumbered frame by frame so they pair up by index.
  const decoder = spawn(ffmpegPath, [...quiet, '-c:v', 'libvpx-vp9', '-i', keyedPath, '-i', sourcePath,
    '-filter_complex', `[0:v]settb=1/${fps},setpts=N,format=rgba[k];[1:v]scale=${w}:${h},fps=${fps},settb=1/${fps},setpts=N,format=rgba[s];[k][s]hstack=inputs=2:shortest=1[out]`,
    '-map', '[out]', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const encoder = spawn(ffmpegPath, [...quiet, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', String(CRF), '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-an', '-f', 'webm', tmpPath],
  { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderr = [];
  encoder.stderr.on('data', chunk => { if (stderr.length < 20) stderr.push(chunk.toString()); });
  encoder.stdin.on('error', () => { /* reported by close */ });
  const encoderDone = new Promise(resolve => encoder.on('close', code => resolve(code)));
  let timedOut = false;
  const killAll = () => { for (const child of [decoder, encoder]) { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  const timer = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
  const onAbort = () => killAll();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const write = buffer => (encoder.stdin.write(buffer) ? null : new Promise(resolve => encoder.stdin.once('drain', resolve)));
  try {
    const pairs = frameReader(decoder.stdout, frameBytes * 2);
    const rowBytes = w * 4;
    // A side-by-side frame -> [keyed, source].
    const split = (pair) => {
      if (!pair) return [null, null];
      const left = Buffer.allocUnsafe(frameBytes);
      const right = Buffer.allocUnsafe(frameBytes);
      for (let y = 0; y < h; y += 1) {
        pair.copy(left, y * rowBytes, y * rowBytes * 2, y * rowBytes * 2 + rowBytes);
        pair.copy(right, y * rowBytes, y * rowBytes * 2 + rowBytes, (y + 1) * rowBytes * 2);
      }
      return [left, right];
    };
    // window[FILL_WINDOW] is the frame being written; sources[] holds the matching source frames.
    const window = [];
    const sources = [];
    for (let k = 0; k < FILL_WINDOW; k += 1) { window.push(null); sources.push(null); }
    for (let k = 0; k <= FILL_WINDOW; k += 1) {
      const [keyedFrame, sourceFrame] = split(await pairs.next());
      window.push(keyedFrame);
      sources.push(sourceFrame);
    }
    let frames = 0;
    let total = 0;
    while (window[FILL_WINDOW]) {
      if (signal && signal.aborted) throw abortError();
      const { out, fixed } = repairFrame(window, FILL_WINDOW, sources[FILL_WINDOW], pixels, key);
      total += fixed;
      frames += 1;
      const waiting = write(out);
      if (waiting) await waiting;
      const [keyedFrame, sourceFrame] = split(await pairs.next());
      window.shift();
      sources.shift();
      window.push(keyedFrame);
      sources.push(sourceFrame);
    }
    encoder.stdin.end();
    const code = await encoderDone;
    if (signal && signal.aborted) throw abortError();
    if (timedOut) throw new Error('Flicker repair timed out.');
    if (code !== 0) throw new Error(media.tidy(stderr.join('')) || `ffmpeg exited with ${code}`);
    if (!frames) return { repaired: false, reason: 'unreadable' };
    if (!total) return { repaired: false, reason: 'nothing' };
    await fsp.rename(tmpPath, destPath);
    return { repaired: true, frames, pixels: total };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    killAll();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

module.exports = { repairFlicker, repairFrame, FILL_WINDOW, LOW, HIGH };
