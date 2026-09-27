'use strict';

// Shared chroma-key helpers, extracted from server.js so the chroma converter
// route AND the animate pipeline's keying stage build byte-identical filters
// and VP9 encode args. Chroma behaviour is unchanged: the defaults, limits,
// colour normaliser, despill rule, filter string and encoder flags here are the
// same ones the converter shipped with.

const CHROMA_DEFAULTS = { color: '#00FF00', similarity: 0.12, blend: 0.06, despill: false };
const CHROMA_LIMITS = { similarity: [0.01, 1], blend: [0, 1] };
const CHROMA_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

// Format a number the way ffmpeg filter args expect: 0.12 -> "0.12", 1 -> "1".
function chromaNum(value) {
  return String(Number(Number(value).toFixed(4)));
}

// Normalize a raw color into canonical `#RRGGBB` (uppercase). Accepts
// `#RRGGBB`, `RRGGBB`, `0xRRGGBB` (case-insensitive). Returns null otherwise.
function normalizeColor(raw) {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (value.startsWith('#')) value = value.slice(1);
  else if (/^0x/i.test(value)) value = value.slice(2);
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return `#${value.toUpperCase()}`;
}

// Decide the despill type for a color, or null when neither green nor blue
// dominates. green if G>R && G>B; blue if B>R && B>G.
function despillType(canonicalColor) {
  const r = parseInt(canonicalColor.slice(1, 3), 16);
  const g = parseInt(canonicalColor.slice(3, 5), 16);
  const b = parseInt(canonicalColor.slice(5, 7), 16);
  if (g > r && g > b) return 'green';
  if (b > r && b > g) return 'blue';
  return null;
}

// Normalize chroma params from a plain object (missing -> DEFAULTS). Throws a
// {status:400} error on invalid color / out-of-range numbers.
function normalizeChromaParams(raw = {}) {
  const source = raw || {};
  const color = source.color == null ? CHROMA_DEFAULTS.color : normalizeColor(source.color);
  if (!color) throw Object.assign(new Error('Invalid key color; use #RRGGBB.'), { status: 400 });

  const similarity = source.similarity == null ? CHROMA_DEFAULTS.similarity : Number(source.similarity);
  if (!Number.isFinite(similarity) || similarity < CHROMA_LIMITS.similarity[0] || similarity > CHROMA_LIMITS.similarity[1]) {
    throw Object.assign(new Error('similarity must be a number within [0.01, 1].'), { status: 400 });
  }
  const blend = source.blend == null ? CHROMA_DEFAULTS.blend : Number(source.blend);
  if (!Number.isFinite(blend) || blend < CHROMA_LIMITS.blend[0] || blend > CHROMA_LIMITS.blend[1]) {
    throw Object.assign(new Error('blend must be a number within [0, 1].'), { status: 400 });
  }

  let despill = source.despill === true || source.despill === 1 || source.despill === '1' || source.despill === 'true';
  // despill only applies to green/blue keys; otherwise silently disable it.
  const type = despillType(color);
  if (despill && !type) despill = false;

  return { color, similarity, blend, despill };
}

// Build the ffmpeg chroma filter string. `pixel` is 'yuva420p' for the WebM
// encode or 'rgba' for a still PNG. `prefix`, when set, is prepended (used by
// the pipeline to fit/crop/scale before keying); it must end without a trailing
// comma — this joins with one.
function chromaFilter(params, pixel, prefix) {
  const hex = `0x${params.color.slice(1)}`;
  let filter = `chromakey=${hex}:${chromaNum(params.similarity)}:${chromaNum(params.blend)}`;
  if (params.despill) filter += `,despill=type=${despillType(params.color)}`;
  filter += `,format=${pixel}`;
  if (prefix) filter = `${prefix},${filter}`;
  return filter;
}

// The VP9 transparent-WebM encoder args (everything after the filter). Shared so
// the converter and the pipeline produce the same alpha-carrying output.
// Callers supply their own -i, -vf and -progress handling.
const VP9_ARGS = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
  '-b:v', '0', '-crf', '30', '-row-mt', '1', '-an'];

// The human-readable command string the chroma converter shows in its job view.
function chromaCommand(filter, inputName = 'input.mp4') {
  return `ffmpeg -i ${inputName} -vf "${filter}" -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -row-mt 1 -an output.webm`;
}

module.exports = {
  CHROMA_DEFAULTS,
  CHROMA_LIMITS,
  CHROMA_EXTENSIONS,
  VP9_ARGS,
  chromaNum,
  normalizeColor,
  despillType,
  normalizeChromaParams,
  chromaFilter,
  chromaCommand,
};
