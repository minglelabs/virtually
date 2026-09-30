'use strict';

// The chroma-key background colour of an animate job, chosen per job from the
// character image so a character wearing green is not keyed out.
//
// chooseKeyColor: decode the character to raw RGBA at most 128 px (ffmpeg),
//   keep the pixels with alpha >= 128 (all pixels when none are that opaque),
//   and count per candidate the pixels whose HSV colour would be keyed with it
//   (S >= 0.35, V >= 0.25 and hue in the candidate's band: green 75-165,
//   blue 195-265, magenta 275-335 degrees). The first candidate, in the order
//   green -> blue -> magenta, whose share is < 0.5 % wins; otherwise the one
//   with the smallest share (ties go to the earlier candidate).
//
// Jobs stored before this existed have no keyColor and mean green.

const media = require('./media');

const KEY_COLORS = Object.freeze({
  green: Object.freeze({ name: 'green', hex: '#00FF00', rgb: Object.freeze([0, 255, 0]), despill: 'green', hue: [75, 165] }),
  blue: Object.freeze({ name: 'blue', hex: '#0000FF', rgb: Object.freeze([0, 0, 255]), despill: 'blue', hue: [195, 265] }),
  magenta: Object.freeze({ name: 'magenta', hex: '#FF00FF', rgb: Object.freeze([255, 0, 255]), despill: null, hue: [275, 335] }),
});
const CANDIDATES = ['green', 'blue', 'magenta'];
const DEFAULT_KEY_COLOR = KEY_COLORS.green;

const MAX_PX = 128;
const MIN_ALPHA = 128;
const MIN_SATURATION = 0.35;
const MIN_VALUE = 0.25;
const MAX_CONFLICT_SHARE = 0.005;
const DECODE_TIMEOUT_MS = 30 * 1000;

// The full key colour record for a stored { name, hex } (or anything else:
// unknown / missing means green).
function resolveKeyColor(value) {
  const name = value && typeof value === 'object' ? value.name : value;
  return (typeof name === 'string' && Object.prototype.hasOwnProperty.call(KEY_COLORS, name)) ? KEY_COLORS[name] : DEFAULT_KEY_COLOR;
}

// '#00FF00' -> '0x00FF00' for ffmpeg colour arguments.
function ffmpegHex(keyColor) {
  return resolveKeyColor(keyColor).hex.replace(/^#/, '0x');
}

// Hue in degrees [0, 360), saturation and value in [0, 1].
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max / 255;
  const s = max === 0 ? 0 : delta / max;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

// Pure decision over an RGBA buffer -> { name, hex, shares }.
function decideFromRgba(rgba) {
  const counts = { green: 0, blue: 0, magenta: 0 };
  const pixels = Math.floor(rgba.length / 4);
  let opaque = 0;
  for (let i = 0; i < pixels; i += 1) if (rgba[i * 4 + 3] >= MIN_ALPHA) opaque += 1;
  const useAll = opaque === 0; // no opaque pixel: judge the whole image
  const total = useAll ? pixels : opaque;
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    if (!useAll && rgba[o + 3] < MIN_ALPHA) continue;
    const { h, s, v } = rgbToHsv(rgba[o], rgba[o + 1], rgba[o + 2]);
    if (s < MIN_SATURATION || v < MIN_VALUE) continue;
    for (const name of CANDIDATES) {
      const [lo, hi] = KEY_COLORS[name].hue;
      if (h >= lo && h <= hi) counts[name] += 1;
    }
  }
  const shares = {};
  for (const name of CANDIDATES) shares[name] = total ? counts[name] / total : 0;
  let pick = CANDIDATES.find(name => shares[name] < MAX_CONFLICT_SHARE);
  if (!pick) pick = CANDIDATES.reduce((best, name) => (shares[name] < shares[best] ? name : best), CANDIDATES[0]);
  return { name: pick, hex: KEY_COLORS[pick].hex, shares };
}

// Decode `imagePath` (first frame) to RGBA at most MAX_PX on the long edge and
// decide. Rejects when ffmpeg cannot read the image.
async function chooseKeyColor(ffmpegPath, imagePath) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', imagePath, '-frames:v', '1',
    '-vf', `scale=w='min(${MAX_PX},iw)':h='min(${MAX_PX},ih)':force_original_aspect_ratio=decrease:flags=area,format=rgba`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
  const result = await media.run(ffmpegPath, args, { timeoutMs: DECODE_TIMEOUT_MS, stdoutCap: MAX_PX * MAX_PX * 4 * 2 });
  if (result.timedOut || result.code !== 0 || result.stdout.length < 4) {
    throw new Error(media.tidy(result.stderr) || 'Could not read the character image.');
  }
  return decideFromRgba(result.stdout);
}

module.exports = {
  KEY_COLORS,
  CANDIDATES,
  DEFAULT_KEY_COLOR,
  MAX_CONFLICT_SHARE,
  resolveKeyColor,
  ffmpegHex,
  rgbToHsv,
  decideFromRgba,
  chooseKeyColor,
};
