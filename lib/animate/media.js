'use strict';

// ffmpeg/ffprobe helpers for the animate pipeline: probe media, composite the
// character onto a solid #00FF00 canvas then fit it into a route's image
// limits (recording the geometry), preprocess a reference clip (trim, scale,
// H.264), and auto-detect the key colour from the generated clip's border.
//
// Every child process is spawned with an args array (never a shell) and wrapped
// with a timeout so nothing can hang the server.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const KEY_HEX = '0x00FF00';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;
const IMAGE_EXTS = ['.png', '.webp', '.jpg', '.jpeg'];

// Run a child to completion, capping stdout, with a hard timeout. Resolves
// { code, stdout, stderr, timedOut }; rejects only on spawn error (ENOENT).
function run(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, stdoutCap = 64 * 1024 * 1024, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outLen = 0;
    let stderr = '';
    let timedOut = false;
    let progressBuf = '';
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', chunk => {
      outLen += chunk.length;
      if (outLen > stdoutCap) { try { child.kill('SIGKILL'); } catch { /* gone */ } return; }
      out.push(chunk);
      if (onProgress) {
        progressBuf += chunk.toString();
        const lines = progressBuf.split('\n');
        progressBuf = lines.pop() || '';
        for (const line of lines) onProgress(line.trim());
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr, timedOut }); });
    if (child.__killable) child.__killable();
  });
}

// Spawn an ffmpeg encode and return the child so the pipeline can track/kill it
// for cancel. Resolves on close with { code, stderr, timedOut }.
function spawnEncode(ffmpegPath, args, { timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = null, register = null } = {}) {
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (register) register(child);
  let stderr = '';
  let progressBuf = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  child.stdout.on('data', chunk => {
    if (!onProgress) return;
    progressBuf += chunk.toString();
    const lines = progressBuf.split('\n');
    progressBuf = lines.pop() || '';
    for (const line of lines) onProgress(line.trim());
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const done = new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
  });
  return { child, done };
}

// Probe a media file's first video stream. Returns { width, height, duration,
// fps, codec, pixFmt, hasAlpha } or null when there is no video stream.
async function probeVideo(ffprobePath, filePath) {
  const probed = await run(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath,
  ], { timeoutMs: PROBE_TIMEOUT_MS });
  let json;
  try { json = JSON.parse(probed.stdout.toString() || '{}'); } catch { return null; }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  if (!video) return null;
  let width = Number(video.width) || null;
  let height = Number(video.height) || null;
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  const matrix = sideData.find(entry => entry.rotation != null);
  if (matrix && matrix.rotation != null) {
    const rotation = ((Number(matrix.rotation) % 360) + 360) % 360;
    if (rotation === 90 || rotation === 270) { const t = width; width = height; height = t; }
  }
  const duration = Number(video.duration) || (json.format && Number(json.format.duration)) || null;
  let fps = null;
  const rate = video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate;
  if (rate && rate.includes('/')) {
    const [num, den] = rate.split('/').map(Number);
    if (num && den) fps = Number((num / den).toFixed(2));
  }
  const pixFmt = video.pix_fmt || null;
  const hasAlpha = !!pixFmt && /a|argb|rgba|abgr|bgra|ya|yuva|pal8/i.test(pixFmt);
  return { width, height, duration: Number.isFinite(duration) ? duration : null, fps, codec: video.codec_name || null, pixFmt, hasAlpha };
}

function isImageExt(ext) {
  return IMAGE_EXTS.includes(String(ext).toLowerCase());
}

function evenDown(value) {
  const n = Math.max(2, Math.floor(value));
  return n % 2 === 0 ? n : n - 1;
}

// Compute the "sent" geometry: given a canvas WxH, fit it into a route's image
// limits by scaling down to imageMaxPx (long edge), then padding up to
// imageMinPx (short edge) and into the aspect bounds. Returns
// { canvas:{w,h}, sent:{w,h}, content:{x,y,w,h} } with even dimensions.
function computeGeometry(canvasW, canvasH, limits = {}) {
  const canvas = { w: evenDown(canvasW), h: evenDown(canvasH) };
  let w = canvas.w;
  let h = canvas.h;
  const imageMaxPx = Number(limits.imageMaxPx) || null;
  const imageMinPx = Number(limits.imageMinPx) || null;
  const aspectMin = Number(limits.aspectMin) || null;
  const aspectMax = Number(limits.aspectMax) || null;

  // 1. scale down so the long edge <= imageMaxPx (never scale up).
  if (imageMaxPx) {
    const longEdge = Math.max(w, h);
    if (longEdge > imageMaxPx) {
      const scale = imageMaxPx / longEdge;
      w = Math.max(2, Math.round(w * scale));
      h = Math.max(2, Math.round(h * scale));
    }
  }
  const contentW = evenDown(w);
  const contentH = evenDown(h);

  // The padded "sent" frame starts at the (possibly downscaled) content size.
  let sentW = contentW;
  let sentH = contentH;

  // 2. pad the short edge up to imageMinPx.
  if (imageMinPx) {
    if (Math.min(sentW, sentH) < imageMinPx) {
      if (sentW <= sentH) sentW = imageMinPx;
      else sentH = imageMinPx;
    }
  }

  // 3. pad into the aspect bounds (aspect = w/h).
  if (aspectMin && sentW / sentH < aspectMin) sentW = Math.round(sentH * aspectMin);
  if (aspectMax && sentW / sentH > aspectMax) sentH = Math.round(sentW / aspectMax);

  sentW = evenDown(Math.max(sentW, contentW));
  sentH = evenDown(Math.max(sentH, contentH));

  const content = {
    x: Math.max(0, Math.round((sentW - contentW) / 2)),
    y: Math.max(0, Math.round((sentH - contentH) / 2)),
    w: contentW,
    h: contentH,
  };
  return { canvas, sent: { w: sentW, h: sentH }, content };
}

// Composite a character source (image or the first frame of an idle WebM) onto
// a solid #00FF00 canvas at the SOURCE size, then scale+pad into the route
// limits, writing a PNG at `destPath`. Returns the geometry plus canvas dims.
// `source` = { path, ext, isImage, hasAlpha }.
async function compositeCharacter(ffmpegPath, ffprobePath, source, limits, destPath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Probe the source for its native size.
  const probe = await probeVideo(ffprobePath, source.path);
  if (!probe || !probe.width || !probe.height) {
    throw Object.assign(new Error('Could not read the character image dimensions.'), { code: 'character_missing' });
  }
  const geometry = computeGeometry(probe.width, probe.height, limits || {});
  const { canvas, sent, content } = geometry;

  // Build the frame: green canvas -> overlay the (contain-scaled) source ->
  // that IS the canvas (source size). Then scale the canvas to `content`, pad
  // with green to `sent`. One filtergraph does both.
  const inputArgs = source.isImage
    ? ['-i', source.path]
    // Decode the first frame keeping alpha; libvpx-vp9 for WebM idle sources.
    : ['-c:v', 'libvpx-vp9', '-i', source.path, '-frames:v', '1'];
  const filter = [
    `color=c=${KEY_HEX}:s=${canvas.w}x${canvas.h}[bg]`,
    `[0:v]scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2[canvas]`,
    `[canvas]scale=${content.w}:${content.h},` +
      `pad=${sent.w}:${sent.h}:${content.x}:${content.y}:color=${KEY_HEX}[out]`,
  ].join(';');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...inputArgs, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', destPath];
  const result = await run(ffmpegPath, args, { timeoutMs });
  if (result.timedOut) throw Object.assign(new Error('Character composite timed out.'), { code: 'character_missing' });
  if (result.code !== 0) {
    throw Object.assign(new Error(tidy(result.stderr) || 'Character composite failed.'), { code: 'character_missing' });
  }
  return { geometry, canvas, sent, content, sourceHasAlpha: !!probe.hasAlpha };
}

// Preprocess a reference clip: trim [trimStart, trimEnd], cap to route max
// (by orientation), scale long edge <= 1280 (even), fps <= 30, H.264 yuv420p,
// CRF 18, -an, +faststart. Returns { sentSeconds, warnings:[...], duration }.
async function prepareReference(ffmpegPath, ffprobePath, sourcePath, destPath, opts) {
  const { trimStart = null, trimEnd = null, minSec = null, maxSec = null, timeoutMs = DEFAULT_TIMEOUT_MS } = opts || {};
  const probe = await probeVideo(ffprobePath, sourcePath);
  if (!probe || !probe.duration) {
    throw Object.assign(new Error('Could not read the reference video.'), { code: 'reference_missing' });
  }
  const warnings = [];
  const start = Number.isFinite(trimStart) && trimStart > 0 ? trimStart : 0;
  let end = Number.isFinite(trimEnd) && trimEnd > start ? trimEnd : probe.duration;
  end = Math.min(end, probe.duration);
  let seconds = Math.max(0, end - start);

  if (minSec != null && seconds < minSec - 0.05) {
    throw Object.assign(new Error(`Reference is shorter than ${minSec}s.`), { code: 'reference_too_short', detail: { minSec } });
  }
  if (maxSec != null && seconds > maxSec + 0.05) {
    seconds = maxSec;
    end = start + maxSec;
    warnings.push({ code: 'reference_trimmed', message: `Reference trimmed to ${maxSec}s.`, detail: { seconds: maxSec } });
  }

  // Long edge <= 1280, even dims.
  let scaleFilter = 'scale=\'if(gt(iw,ih),min(1280,iw),-2)\':\'if(gt(iw,ih),-2,min(1280,ih))\'';
  scaleFilter += ',scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const fpsFilter = probe.fps && probe.fps > 30 ? ',fps=30' : '';
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', String(start), '-t', String(seconds), '-i', sourcePath,
    '-vf', `${scaleFilter}${fpsFilter}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-an',
    '-movflags', '+faststart', destPath];
  const result = await run(ffmpegPath, args, { timeoutMs });
  if (result.timedOut) throw Object.assign(new Error('Reference preprocessing timed out.'), { code: 'reference_missing' });
  if (result.code !== 0) {
    throw Object.assign(new Error(tidy(result.stderr) || 'Reference preprocessing failed.'), { code: 'reference_missing' });
  }
  return { sentSeconds: Number(seconds.toFixed(3)), warnings, duration: probe.duration };
}

// Auto-detect the key colour from a frame: sample a 2px-inset border of a small
// rgb24 frame at min(1s, duration/2) and take the median. When not greenish
// (g<100 || g<r+30 || g<b+30) fall back to #00FF00 with a warning.
// Returns { color: '#RRGGBB', warning: {...}|null }.
async function detectKeyColor(ffmpegPath, sourcePath, duration, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const fallback = { color: '#00FF00', warning: { code: 'key_color_fallback', message: 'Key colour auto-detect failed; used #00FF00.' } };
  const at = Math.max(0, Math.min(1, (Number(duration) || 2) / 2));
  const size = 64; // small frame for a cheap median
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(at), '-i', sourcePath,
    '-frames:v', '1', '-vf', `scale=${size}:${size}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
  let result;
  try { result = await run(ffmpegPath, args, { timeoutMs }); } catch { return fallback; }
  if (result.code !== 0 || result.stdout.length < size * size * 3) return fallback;
  const buf = result.stdout;
  const rs = []; const gs = []; const bs = [];
  const inset = 2;
  const at2 = (x, y) => (y * size + x) * 3;
  for (let x = inset; x < size - inset; x += 1) {
    for (const y of [inset, size - 1 - inset]) {
      const i = at2(x, y); rs.push(buf[i]); gs.push(buf[i + 1]); bs.push(buf[i + 2]);
    }
  }
  for (let y = inset; y < size - inset; y += 1) {
    for (const x of [inset, size - 1 - inset]) {
      const i = at2(x, y); rs.push(buf[i]); gs.push(buf[i + 1]); bs.push(buf[i + 2]);
    }
  }
  const r = median(rs); const g = median(gs); const b = median(bs);
  if (g < 100 || g < r + 30 || g < b + 30) return fallback;
  const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { color: hex, warning: null };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Trim ffmpeg stderr into a short, path-free message.
function tidy(stderr) {
  const lines = String(stderr || '').split('\n').map(line => line.trim()).filter(Boolean);
  let message = lines.slice(-2).join(' ') || '';
  message = message.replace(/(\/[^\s"']+)/g, match => path.basename(match));
  if (message.length > 240) message = message.slice(0, 240);
  return message;
}

module.exports = {
  KEY_HEX,
  IMAGE_EXTS,
  run,
  spawnEncode,
  probeVideo,
  isImageExt,
  computeGeometry,
  compositeCharacter,
  prepareReference,
  detectKeyColor,
  tidy,
  tmpName: (dir, base) => path.join(dir, `${base}.${crypto.randomUUID()}.tmp`),
};
