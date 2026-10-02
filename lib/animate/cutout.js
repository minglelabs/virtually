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
// such as eyes, stays). The two pixel rings next to the cleared area are edge
// pixels: anti-aliasing mixed the background colour into them, which shows as a
// light fringe on any other background. Each gets the colour of the character just
// inside it and an alpha that says how much of that colour the pixel held (the
// background is un-mixed); where the character is too thin to have an inside, the
// pixel is faded by its distance to the background colour. The result is
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

  // ring[i]: 1 for a kept pixel that touches the cleared area (8 neighbours), 2 for one that touches ring 1.
  const ring2 = new Uint8Array(w * h);
  const touches = (i, test) => {
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && test(ny * w + nx)) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < w * h; i += 1) if (!background[i] && touches(i, n => background[n] === 1)) ring2[i] = 1;
  for (let i = 0; i < w * h; i += 1) if (!background[i] && !ring2[i] && touches(i, n => ring2[n] === 1)) ring2[i] = 2;

  const alpha = new Uint8Array(w * h).fill(255);
  const recolor = new Map(); // pixel index -> [r, g, b] of the character just inside it
  for (let i = 0; i < w * h; i += 1) {
    if (background[i]) { alpha[i] = 0; continue; }
    if (!ring2[i]) continue;
    // pixel = a * own + (1 - a) * background. The own colour is not known, so every
    // nearby pixel further inside (ring 2 for ring 1, the inside for both) is tried as
    // it: one explains the pixel when the pixel lies on the line from the background
    // colour to it. Of those the one furthest from the background (the purest) wins.
    const x = i % w;
    const y = (i - x) / w;
    let best = null; // { a, color }
    let bestSpan = 0;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (background[n] || (ring2[n] && ring2[n] <= ring2[i])) continue;
        const f0 = px[n * 4] - median[0];
        const f1 = px[n * 4 + 1] - median[1];
        const f2 = px[n * 4 + 2] - median[2];
        const span = Math.hypot(f0, f1, f2);
        if (span <= TOLERANCE || span <= bestSpan) continue;
        const a = ((px[i * 4] - median[0]) * f0 + (px[i * 4 + 1] - median[1]) * f1 + (px[i * 4 + 2] - median[2]) * f2) / (span * span);
        const t = Math.max(0, Math.min(1, a));
        const off = Math.hypot(px[i * 4] - (median[0] + t * f0), px[i * 4 + 1] - (median[1] + t * f1), px[i * 4 + 2] - (median[2] + t * f2));
        if (off > TOLERANCE) continue;
        best = { a: t, color: [px[n * 4], px[n * 4 + 1], px[n * 4 + 2]] };
        bestSpan = span;
      }
    }
    if (best) {
      // A pixel that is (almost) all character keeps its own colour: only mixed ones are replaced.
      if (best.a >= 0.9) continue;
      alpha[i] = Math.round(255 * best.a);
      recolor.set(i, best.color);
    } else if (ring2[i] === 1) {
      // Nothing explains it as a mix (a thin line, a part as light as the background): fade by the distance to the background colour.
      alpha[i] = Math.max(0, Math.min(255, Math.round(255 * (dist(i) - TOLERANCE / 2) / (TOLERANCE * 1.5))));
    }
  }
  return { cut: true, color: toHex(median), share: Number(share.toFixed(4)), alpha, recolor };
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
  for (const [i, [r, g, b]] of outcome.recolor) { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; }
  await writePng(ffmpegPath, rgba, w, h, destPath);
  return { cut: true, color: outcome.color, share: outcome.share, width: w, height: h };
}

module.exports = { cutOutBackground, cutOutRgba, MAX_EDGE, TOLERANCE };
