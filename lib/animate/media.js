'use strict';

// ffmpeg/ffprobe helpers for the animate pipeline: probe media, composite the
// character onto a solid key-colour canvas (#00FF00 unless the job chose
// another colour, see key-color.js) then fit it into a route's image
// limits (recording the geometry), preprocess a reference clip (trim, scale,
// H.264), normalize example driving videos and extract poster frames.
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
// a solid key-colour canvas (`keyHex`, default #00FF00) at the SOURCE size,
// then scale+pad into the route limits, writing a PNG at `destPath`. Returns
// the geometry plus canvas dims. `source` = { path, ext, isImage, hasAlpha }.
async function compositeCharacter(ffmpegPath, ffprobePath, source, limits, destPath, { timeoutMs = DEFAULT_TIMEOUT_MS, keyHex = KEY_HEX } = {}) {
  // Probe the source for its native size.
  const probe = await probeVideo(ffprobePath, source.path);
  if (!probe || !probe.width || !probe.height) {
    throw Object.assign(new Error('Could not read the character image dimensions.'), { code: 'character_missing' });
  }
  const geometry = computeGeometry(probe.width, probe.height, limits || {});
  const { canvas, sent, content } = geometry;

  // Build the frame: key-colour canvas -> overlay the (contain-scaled) source ->
  // that IS the canvas (source size). Then scale the canvas to `content`, pad
  // with the key colour to `sent`. One filtergraph does both.
  const inputArgs = source.isImage
    ? ['-i', source.path]
    // Decode the first frame keeping alpha; libvpx-vp9 for WebM idle sources.
    : ['-c:v', 'libvpx-vp9', '-i', source.path, '-frames:v', '1'];
  const filter = [
    `color=c=${keyHex}:s=${canvas.w}x${canvas.h}[bg]`,
    `[0:v]scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2[canvas]`,
    `[canvas]scale=${content.w}:${content.h},` +
      `pad=${sent.w}:${sent.h}:${content.x}:${content.y}:color=${keyHex}[out]`,
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
// (by orientation), pad `marginPx` px of black on the left, right and top
// (margin.js), scale long edge <= 1280 (even), fps <= 30, H.264 yuv420p,
// CRF 18, -an, +faststart. Returns { sentSeconds, warnings:[...], duration,
// padPx, padded:{w,h} } (padded = the frame size after padding, before scaling).
async function prepareReference(ffmpegPath, ffprobePath, sourcePath, destPath, opts) {
  const { trimStart = null, trimEnd = null, minSec = null, maxSec = null, marginPx = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = opts || {};
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

  // Margin: pad from the probed (rotation-corrected) size, before the scale.
  const padPx = Math.max(0, Math.round(Number(marginPx) || 0));
  const padFilter = padPx > 0 ? `pad=iw+${2 * padPx}:ih+${padPx}:${padPx}:${padPx}:color=black,` : '';
  // Long edge <= 1280, even dims.
  let scaleFilter = 'scale=\'if(gt(iw,ih),min(1280,iw),-2)\':\'if(gt(iw,ih),-2,min(1280,ih))\'';
  scaleFilter += ',scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const fpsFilter = probe.fps && probe.fps > 30 ? ',fps=30' : '';
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', String(start), '-t', String(seconds), '-i', sourcePath,
    '-vf', `${padFilter}${scaleFilter}${fpsFilter}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-an',
    '-movflags', '+faststart', destPath];
  const result = await run(ffmpegPath, args, { timeoutMs });
  if (result.timedOut) throw Object.assign(new Error('Reference preprocessing timed out.'), { code: 'reference_missing' });
  if (result.code !== 0) {
    throw Object.assign(new Error(tidy(result.stderr) || 'Reference preprocessing failed.'), { code: 'reference_missing' });
  }
  const padded = probe.width && probe.height ? { w: probe.width + 2 * padPx, h: probe.height + padPx } : null;
  return { sentSeconds: Number(seconds.toFixed(3)), warnings, duration: probe.duration, padPx, padded };
}

// Normalize a driving video: trim [start, start+duration], scale so the height
// is <= 720 (aspect kept, even dimensions), H.264 yuv420p, no audio,
// +faststart. Writes to a tmp file and renames onto `destPath`.
async function normalizeDriving(ffmpegPath, sourcePath, destPath, { start = 0, duration = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const tmpPath = `${destPath}.${crypto.randomUUID()}.tmp.mp4`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (Number(start) > 0) args.push('-ss', String(start));
  if (duration != null) args.push('-t', String(duration));
  args.push('-i', sourcePath,
    '-vf', "scale=-2:'min(720,trunc(ih/2)*2)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'veryfast', '-an',
    '-movflags', '+faststart', tmpPath);
  try {
    const result = await run(ffmpegPath, args, { timeoutMs });
    if (result.timedOut) throw new Error('Video conversion timed out.');
    if (result.code !== 0) throw new Error(tidy(result.stderr) || 'Video conversion failed.');
    await fsp.rename(tmpPath, destPath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// Write a poster JPEG (height 360, aspect kept) from the frame at `at` seconds,
// falling back to the first frame when the clip is shorter than that.
async function makePoster(ffmpegPath, sourcePath, destPath, { at = 0.5, height = 360, timeoutMs = 60 * 1000 } = {}) {
  const tmpPath = `${destPath}.${crypto.randomUUID()}.tmp.jpg`;
  const attempt = async (seek) => {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    if (seek > 0) args.push('-ss', String(seek));
    args.push('-i', sourcePath, '-frames:v', '1', '-vf', `scale=-2:${height}`, '-q:v', '4', '-f', 'image2', tmpPath);
    const result = await run(ffmpegPath, args, { timeoutMs });
    if (result.code !== 0 || result.timedOut) return false;
    try { return (await fsp.stat(tmpPath)).size > 0; } catch { return false; }
  };
  try {
    if (!(await attempt(at)) && !(await attempt(0))) throw new Error('Could not extract a poster frame.');
    await fsp.rename(tmpPath, destPath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
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
  normalizeDriving,
  makePoster,
  tidy,
  tmpName: (dir, base) => path.join(dir, `${base}.${crypto.randomUUID()}.tmp`),
};
