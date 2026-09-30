'use strict';

// Cut the plain background out of an OPAQUE character image before it is placed
// on the key-colour canvas. Generated character art usually has no alpha: its
// white background then covers the key colour, and Wan 2.2 Animate 2 keeps that
// white instead of the prompted key colour (seen on a real job), so the result
// cannot be keyed.
//
// cutOutBackground(ffmpegPath, ffprobePath, srcPath, destPath)
//   -> { cut: true, color: '#RRGGBB', share, width, height }
//    | { cut: false, reason }  reason: 'has_alpha' (already transparent),
//      'not_uniform' (the border is not one colour: a photo or a scene),
//      'no_subject' (almost everything matched the border colour).
// The image is decoded at most MAX_EDGE px on the long edge. The border colour is
// the per-channel median of the 2-px border ring, accepted when >= 75 % of the
// ring lies within TOLERANCE (RGB distance) of it. Pixels within TOLERANCE of it
// that are 4-connected to the border are cleared (so white inside the character,
// such as eyes, stays), and the 1-px rim next to them is feathered. The result is
// an RGBA PNG at `destPath`. Limit: a light part of the character that touches the
// image edge and matches the background colour is removed with it.

const { spawn } = require('node:child_process');

const media = require('./media');

const MAX_EDGE = 2048;
const TOLERANCE = 30;
const UNIFORM_SHARE = 0.75;
const MAX_BACKGROUND_SHARE = 0.97;
const OPAQUE_ALPHA = 250;
const TIMEOUT_MS = 60 * 1000;

function toHex(rgb) {
  return `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// Pure decision + mask over an RGBA buffer (w x h). Mutates nothing; returns
// { cut: false, reason } or { cut: true, color, share, alpha } (alpha = Uint8Array).
function cutOutRgba(px, w, h) {
  let translucent = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < OPAQUE_ALPHA) { translucent = true; break; }
  if (translucent) return { cut: false, reason: 'has_alpha' };

  const ring = [];
  for (let x = 0; x < w; x += 1) for (const y of [0, 1, h - 2, h - 1]) if (y >= 0 && y < h) ring.push(y * w + x);
  for (let y = 2; y < h - 2; y += 1) for (const x of [0, 1, w - 2, w - 1]) if (x >= 0 && x < w) ring.push(y * w + x);
  const median = [0, 1, 2].map(c => {
    const values = ring.map(i => px[i * 4 + c]).sort((a, b) => a - b);
    return values[values.length >> 1];
  });
  const dist = i => Math.hypot(px[i * 4] - median[0], px[i * 4 + 1] - median[1], px[i * 4 + 2] - median[2]);
  const near = ring.filter(i => dist(i) <= TOLERANCE).length;
  if (!ring.length || near < UNIFORM_SHARE * ring.length) return { cut: false, reason: 'not_uniform' };

  const background = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const i of ring) {
    if (!background[i] && dist(i) <= TOLERANCE) { background[i] = 1; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0 && !background[i - 1] && dist(i - 1) <= TOLERANCE) { background[i - 1] = 1; queue[tail++] = i - 1; }
    if (x < w - 1 && !background[i + 1] && dist(i + 1) <= TOLERANCE) { background[i + 1] = 1; queue[tail++] = i + 1; }
    if (i >= w && !background[i - w] && dist(i - w) <= TOLERANCE) { background[i - w] = 1; queue[tail++] = i - w; }
    if (i < w * (h - 1) && !background[i + w] && dist(i + w) <= TOLERANCE) { background[i + w] = 1; queue[tail++] = i + w; }
  }
  const share = tail / (w * h);
  if (share > MAX_BACKGROUND_SHARE) return { cut: false, reason: 'no_subject' };

  const alpha = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < w * h; i += 1) {
    if (background[i]) { alpha[i] = 0; continue; }
    const x = i % w;
    const rim = (x > 0 && background[i - 1]) || (x < w - 1 && background[i + 1])
      || (i >= w && background[i - w]) || (i < w * (h - 1) && background[i + w]);
    // Anti-aliased rim pixels are part background: fade them by their distance to it.
    if (rim) alpha[i] = Math.max(0, Math.min(255, Math.round(255 * (dist(i) - TOLERANCE / 2) / (TOLERANCE * 1.5))));
  }
  return { cut: true, color: toHex(median), share: Number(share.toFixed(4)), alpha };
}

function writePng(ffmpegPath, rgba, w, h, destPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', destPath],
    { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS);
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(media.tidy(stderr) || `ffmpeg exited with ${code}`));
    });
    child.stdin.on('error', () => { /* reported by close */ });
    child.stdin.end(rgba);
  });
}

async function cutOutBackground(ffmpegPath, ffprobePath, srcPath, destPath) {
  const probe = await media.probeVideo(ffprobePath, srcPath);
  if (!probe || !probe.width || !probe.height) throw new Error('Could not read the character image.');
  const scale = Math.min(1, MAX_EDGE / Math.max(probe.width, probe.height));
  const w = Math.max(1, Math.round(probe.width * scale));
  const h = Math.max(1, Math.round(probe.height * scale));
  const decoded = await media.run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', srcPath,
    '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=rgba`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
  { timeoutMs: TIMEOUT_MS, stdoutCap: w * h * 4 + 1024 });
  if (decoded.timedOut || decoded.code !== 0 || decoded.stdout.length < w * h * 4) {
    throw new Error(media.tidy(decoded.stderr) || 'Could not decode the character image.');
  }
  const px = decoded.stdout.subarray(0, w * h * 4);
  const outcome = cutOutRgba(px, w, h);
  if (!outcome.cut) return outcome;
  const rgba = Buffer.from(px);
  for (let i = 0; i < w * h; i += 1) rgba[i * 4 + 3] = outcome.alpha[i];
  await writePng(ffmpegPath, rgba, w, h, destPath);
  return { cut: true, color: outcome.color, share: outcome.share, width: w, height: h };
}

module.exports = { cutOutBackground, cutOutRgba, MAX_EDGE, TOLERANCE };
