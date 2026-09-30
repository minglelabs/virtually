'use strict';

// The chroma-key background colour of an animate job, chosen per job from the
// character image so a character wearing green is not keyed out.
//
// chooseKeyColor: decode the character to raw RGBA at most 128 px (ffmpeg),
//   keep the pixels with alpha >= 128 (all pixels when none are that opaque),
//   and count per candidate the pixels keying on it would damage:
//   (a) RGB distance to the pure candidate < 200: colorkey (similarity 0.30,
//       blend 0.12) is only fully opaque from (0.30 + 0.12) * sqrt(3) * 255 =
//       185.5 (measured: alpha 0 up to ~132, 42 at 141, 178 at 170, 253 at
//       185), plus a margin because the rendered key is not exactly pure; or
//   (b) the candidate's despill (mix 0.5) would change it by > 40: green
//       lowers G by g - (r + b) / 2, blue lowers B by b - (r + g) / 2 (clamped
//       >= 0; magenta has no despill). This catches e.g. bright yellow, which
//       green despill turns orange although it is far from green.
//   The first candidate, in the order green -> blue -> magenta, whose share is
//   < 0.5 % wins; otherwise the one with the smallest share (ties go to the
//   earlier candidate).
//
// Jobs stored before this existed have no keyColor and mean green.

const media = require('./media');

const KEY_COLORS = Object.freeze({
  green: Object.freeze({ name: 'green', hex: '#00FF00', rgb: Object.freeze([0, 255, 0]), despill: 'green' }),
  blue: Object.freeze({ name: 'blue', hex: '#0000FF', rgb: Object.freeze([0, 0, 255]), despill: 'blue' }),
  magenta: Object.freeze({ name: 'magenta', hex: '#FF00FF', rgb: Object.freeze([255, 0, 255]), despill: null }),
});
const CANDIDATES = ['green', 'blue', 'magenta'];
const DEFAULT_KEY_COLOR = KEY_COLORS.green;

// Keying parameters, shared with key.js (which requires this module).
const SIMILARITY = 0.30;
const BLEND = 0.12;
const DESPILL_MIX = 0.5;

const MAX_PX = 128;
const MIN_ALPHA = 128;
// colorkey is fully opaque only from this RGB distance (185.5).
const OPAQUE_DISTANCE = (SIMILARITY + BLEND) * Math.sqrt(3) * 255;
// Plus a margin for a rendered key colour that is near, not exactly, the pure one.
const DISTANCE_MARGIN = 14;
const MIN_SAFE_DISTANCE = Math.ceil(OPAQUE_DISTANCE) + DISTANCE_MARGIN; // 200
const MAX_DESPILL_CHANGE = 40;
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

// How much the candidate's despill (mix 0.5) would lower a pixel's
// key channel: key channel - mean of the other two, clamped >= 0.
function despillChange(despill, r, g, b) {
  if (despill === 'green') return Math.max(0, g - (r + b) / 2);
  if (despill === 'blue') return Math.max(0, b - (r + g) / 2);
  return 0;
}

// Whether keying on `keyColor` would damage the pixel (see the header).
function conflicts(keyColor, r, g, b) {
  const [kr, kg, kb] = keyColor.rgb;
  if (Math.hypot(r - kr, g - kg, b - kb) < MIN_SAFE_DISTANCE) return true;
  return despillChange(keyColor.despill, r, g, b) > MAX_DESPILL_CHANGE;
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
    for (const name of CANDIDATES) {
      if (conflicts(KEY_COLORS[name], rgba[o], rgba[o + 1], rgba[o + 2])) counts[name] += 1;
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
  SIMILARITY,
  BLEND,
  DESPILL_MIX,
  MIN_SAFE_DISTANCE,
  MAX_DESPILL_CHANGE,
  resolveKeyColor,
  ffmpegHex,
  despillChange,
  conflicts,
  decideFromRgba,
  chooseKeyColor,
};
