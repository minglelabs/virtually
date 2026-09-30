'use strict';

// Character box ("fit", v1) of a transparent motion or idle asset, measured
// from its alpha channel so the overlay can scale and place a motion to match
// the idle character. See .kiro/tmp/spec-shared.md / README "fit":
//
//   { v: 1, width, height,            // SOURCE frame size (ffprobe)
//     first: [x0, y0, x1, y1],        // normalized, x1/y1 exclusive, alpha >= 128, first frame
//     union: [x0, y0, x1, y1],        // union over frames sampled every 0.25 s
//     touches: { left, right, top, bottom } }
//
// null = measured and not applicable: no alpha (MP4, JPEG, opaque WebM) or no
// pixel reaching alpha 128. Videos are read twice, both scaled so the long edge
// is <= 256 px (never upscaled) and streamed as raw RGBA one frame at a time
// (a long clip never has to fit in memory): frame 0 alone for `first`, and
// fps=4 for `union` (fps=N keeps the last frame of each bucket, not frame 0).

const path = require('node:path');
const { spawn } = require('node:child_process');

const media = require('./media');

const ALPHA_THRESHOLD = 128;
const MAX_EDGE = 256;
const SAMPLE_FPS = 4;
const TIMEOUT_MS = 60 * 1000;
const VIDEO_EXTS = new Set(['.webm']);
const IMAGE_EXTS = new Set(['.png', '.webp']);

let loggedFailure = false;
function logOnce(message) {
  if (loggedFailure) return;
  loggedFailure = true;
  console.warn(`[fit] ${message}`);
}

function round4(value) {
  return Number(value.toFixed(4));
}

// The scaled frame size: long edge <= MAX_EDGE, never upscaled.
function scaledSize(width, height) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

// Scan one RGBA frame. Returns { box:[x0,y0,x1,y1] | null (px, exclusive),
// translucent: whether any pixel is below the threshold }.
function scanFrame(frame, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  let translucent = false;
  for (let y = 0; y < h; y += 1) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      if (frame[row + x * 4 + 3] >= ALPHA_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      } else {
        translucent = true;
      }
    }
  }
  return { box: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1], translucent };
}

// Build the fit from per-frame pixel boxes on a w x h scaled frame.
function buildFit(source, w, h, first, union) {
  const norm = box => [round4(box[0] / w), round4(box[1] / h), round4(box[2] / w), round4(box[3] / h)];
  const tolX = Math.max(2, 0.01 * w);
  const tolY = Math.max(2, 0.01 * h);
  return {
    v: 1,
    width: source.width,
    height: source.height,
    first: norm(first),
    union: norm(union),
    touches: {
      left: union[0] <= tolX,
      right: w - union[2] <= tolX,
      top: union[1] <= tolY,
      bottom: h - union[3] <= tolY,
    },
  };
}

// Decode and scan every sampled frame. Resolves { first, union, translucent }
// or rejects on ffmpeg failure / timeout.
function scanMedia(ffmpegPath, inputArgs, filter, w, h, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs,
      '-vf', filter, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const frameBytes = w * h * 4;
    let pending = Buffer.alloc(0);
    let first = null;
    let union = null;
    let frames = 0;
    let translucent = false;
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const consume = frame => {
      const scanned = scanFrame(frame, w, h);
      if (scanned.translucent) translucent = true;
      if (frames === 0) first = scanned.box;
      frames += 1;
      if (scanned.box) {
        union = union
          ? [Math.min(union[0], scanned.box[0]), Math.min(union[1], scanned.box[1]),
            Math.max(union[2], scanned.box[2]), Math.max(union[3], scanned.box[3])]
          : scanned.box.slice();
      }
    };
    child.stdout.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        consume(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
      }
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('fit measurement timed out'));
      if (code !== 0 || frames === 0) return reject(new Error(media.tidy(stderr) || `ffmpeg exited with ${code}`));
      resolve({ first, union, translucent });
    });
  });
}

// fit | null for a media file. Never throws.
async function measureFit(ffmpegPath, ffprobePath, filePath, { timeoutMs = TIMEOUT_MS } = {}) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  if (!isVideo && !IMAGE_EXTS.has(ext)) return null; // .mp4/.mov/.jpg/... have no alpha
  try {
    const probe = await media.probeVideo(ffprobePath, filePath);
    if (!probe || !probe.width || !probe.height) return null;
    const { w, h } = scaledSize(probe.width, probe.height);
    const still = `scale=${w}:${h}:flags=area,format=rgba`;
    let scanned;
    if (isVideo) {
      // ffmpeg's native VP8/VP9 decoders drop the alpha side channel; libvpx keeps it.
      const decoder = probe.codec === 'vp8' ? ['-c:v', 'libvpx'] : probe.codec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : [];
      const input = [...decoder, '-i', filePath];
      // fps=N emits the LAST frame of each 1/N s bucket, so its first output is not
      // frame 0 (frame 2-3 at 24-30 fps). The overlay places a motion by the frame it
      // shows first, so frame 0 is read on its own; the sampled pass gives the union.
      const head = await scanMedia(ffmpegPath, [...input, '-frames:v', '1'], still, w, h, timeoutMs);
      const sampled = await scanMedia(ffmpegPath, input, `fps=${SAMPLE_FPS},${still}`, w, h, timeoutMs);
      const boxes = [head.union, sampled.union].filter(Boolean);
      scanned = {
        first: head.first,
        union: boxes.length ? boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
          Math.max(a[2], b[2]), Math.max(a[3], b[3])]) : null,
        translucent: head.translucent || sampled.translucent,
      };
    } else {
      scanned = await scanMedia(ffmpegPath, ['-i', filePath, '-frames:v', '1'], still, w, h, timeoutMs);
    }
    // Opaque everywhere (no alpha channel in practice) or nothing solid at all.
    if (!scanned.translucent || !scanned.union) return null;
    // A first frame with nothing solid falls back to the union box.
    return buildFit(probe, w, h, scanned.first || scanned.union, scanned.union);
  } catch (error) {
    logOnce(`could not measure ${path.basename(String(filePath))}: ${error.message || error}`);
    return null;
  }
}

module.exports = { measureFit, scaledSize, scanFrame, buildFit, ALPHA_THRESHOLD, MAX_EDGE };
