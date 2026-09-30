'use strict';

/**
 * Model routes: one entry per (model family, provider) pair.
 * The Route object shape is defined in .kiro/specs/animate-presets.md ("Route object").
 * Order matters: the UI lists routes in this order and the first available one is the default.
 *
 * `verified` is true only when EVERY field name + the endpoint were confirmed against a
 * primary vendor/aggregator doc. Routes whose exact path or field names the research could
 * not confirm from a primary source are marked verified:false (see docs/animate-providers.md).
 */

const FAMILIES = {
  'wan-animate': 'Wan 2.2 Animate',
  dreamactor: 'DreamActor V2',
  'kling-motion': 'Kling 모션 컨트롤',
  other: '기타',
};

// Orientation-to-duration coupling shared by every Kling motion-control route:
// character_orientation:image caps the reference at 10 s; :video allows 30 s.
const KLING_ORIENTATION = { field: 'character_orientation', image: 'image', video: 'video' };
const KLING_VIDEO_MAX_BY_ORIENTATION = { image: 10, video: 30 };

const ROUTES = [
  // ---- 1. Wan 2.2 Animate ------------------------------------------------------------
  {
    id: 'wavespeed/wan-2.2-animate',
    provider: 'wavespeed',
    family: 'wan-animate',
    label: 'Wan 2.2 Animate',
    endpoint: 'wavespeed-ai/wan-2.2/animate',
    fields: { image: 'image', video: 'video', prompt: 'prompt', orientation: null, sound: null },
    params: { mode: 'animate' },
    options: [{ key: 'resolution', field: 'resolution', label: '해상도', values: ['480p', '720p'], default: '720p' }],
    limits: {
      // No input minimum: "The minimum billed duration is 3 seconds; shorter inputs are billed as
      // 3 seconds" (WaveSpeed docs). The 3 s floor lives in pricing.minSeconds only.
      videoMinSec: null, videoMaxSec: 120, videoMaxSecByOrientation: null,
      imageMaxPx: null, imageMinPx: null, aspectMin: null, aspectMax: null,
    },
    pricing: { usdPerSecond: 0.08, byOption: { resolution: { '480p': 0.04, '720p': 0.08 } }, minSeconds: 3 },
    keepsImageBackground: true,
    verified: true,
    docs: 'https://wavespeed.ai/docs/docs-api/wavespeed-ai/wan-2.2-animate',
  },
  {
    id: 'fal/wan-2.2-animate-move',
    provider: 'fal',
    family: 'wan-animate',
    label: 'Wan 2.2 Animate (move)',
    endpoint: 'fal-ai/wan/v2.2-14b/animate/move',
    fields: { image: 'image_url', video: 'video_url', prompt: null, orientation: null, sound: null },
    params: {},
    options: [{ key: 'resolution', field: 'resolution', label: '해상도', values: ['480p', '580p', '720p'], default: '480p' }],
    limits: {
      videoMinSec: 2, videoMaxSec: 30, videoMaxSecByOrientation: null,
      imageMaxPx: null, imageMinPx: null, aspectMin: null, aspectMax: null,
    },
    pricing: null,
    keepsImageBackground: null, // fal's move page does not promise background preservation
    verified: true,
    docs: 'https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/move/api',
  },
  {
    id: 'replicate/wan-2.2-animate-animation',
    provider: 'replicate',
    family: 'wan-animate',
    label: 'Wan 2.2 Animate (animation)',
    // Community model owner/name; the version id is resolved at submit time from the model page.
    endpoint: 'wan-video/wan-2.2-animate-animation',
    fields: { image: 'image', video: 'video', prompt: 'prompt', orientation: null, sound: null },
    params: {},
    options: [],
    limits: {
      videoMinSec: 2, videoMaxSec: 30, videoMaxSecByOrientation: null,
      imageMaxPx: null, imageMinPx: null, aspectMin: null, aspectMax: null,
    },
    pricing: null,
    keepsImageBackground: null,
    verified: false, // exact input field names not confirmed from a primary schema (research flagged this)
    docs: 'https://replicate.com/wan-video/wan-2.2-animate-animation',
  },
  {
    id: 'dashscope/wan2.2-animate-move',
    provider: 'dashscope',
    family: 'wan-animate',
    label: 'Wan 2.2 Animate (move)',
    endpoint: 'wan2.2-animate-move',
    fields: { image: 'input.image_url', video: 'input.video_url', prompt: null, orientation: null, sound: null },
    // watermark defaults false; mode option maps to parameters.mode.
    params: { 'input.watermark': false },
    options: [{ key: 'mode', field: 'parameters.mode', label: '모드', values: ['wan-std', 'wan-pro'], default: 'wan-std' }],
    limits: {
      videoMinSec: 2, videoMaxSec: 30, videoMaxSecByOrientation: null,
      imageMaxPx: 4096, imageMinPx: 200, aspectMin: 0.3333, aspectMax: 3,
    },
    pricing: { usdPerSecond: 0.12, byOption: { mode: { 'wan-std': 0.12, 'wan-pro': 0.18 } }, minSeconds: 2 },
    keepsImageBackground: true, // docs: keeps the image's framing (pixel-exact green UNVERIFIED)
    verified: true,
    docs: 'https://help.aliyun.com/en/model-studio/wan-animate-move-api',
  },

  // ---- 2. DreamActor V2 --------------------------------------------------------------
  {
    id: 'wavespeed/dreamactor-v2',
    provider: 'wavespeed',
    family: 'dreamactor',
    label: 'DreamActor V2',
    endpoint: 'bytedance/dreamactor-v2',
    fields: { image: 'image', video: 'video', prompt: null, orientation: null, sound: null },
    params: {},
    options: [],
    limits: {
      videoMinSec: null, videoMaxSec: 30, videoMaxSecByOrientation: null,
      imageMaxPx: 1920, imageMinPx: 480, aspectMin: null, aspectMax: null,
    },
    pricing: { usdPerSecond: 0.05, byOption: null, minSeconds: 1 },
    keepsImageBackground: true,
    verified: true,
    docs: 'https://wavespeed.ai/docs/docs-api/bytedance/bytedance-dreamactor-v2',
  },
  {
    id: 'fal/dreamactor-v2',
    provider: 'fal',
    family: 'dreamactor',
    label: 'DreamActor V2',
    endpoint: 'fal-ai/bytedance/dreamactor/v2',
    fields: { image: 'image_url', video: 'video_url', prompt: null, orientation: null, sound: null },
    // trim_first_second defaults true upstream; keep it as a sent param.
    params: { trim_first_second: true },
    options: [],
    limits: {
      videoMinSec: null, videoMaxSec: 30, videoMaxSecByOrientation: null,
      imageMaxPx: 1920, imageMinPx: 480, aspectMin: null, aspectMax: null,
    },
    pricing: null,
    keepsImageBackground: true, // fal docs: "preserving subject and background of input image"
    verified: true,
    docs: 'https://fal.ai/models/fal-ai/bytedance/dreamactor/v2/api',
  },
  {
    id: 'replicate/dreamactor-m2.0',
    provider: 'replicate',
    family: 'dreamactor',
    label: 'DreamActor M2.0',
    endpoint: 'bytedance/dreamactor-m2.0',
    fields: { image: 'image', video: 'video', prompt: null, orientation: null, sound: null },
    params: { cut_first_second: true },
    options: [],
    limits: {
      videoMinSec: null, videoMaxSec: 30, videoMaxSecByOrientation: null,
      imageMaxPx: 1920, imageMinPx: 480, aspectMin: null, aspectMax: null,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: true, // input schema confirmed from Replicate's model API page
    docs: 'https://replicate.com/bytedance/dreamactor-m2.0',
  },

  // ---- 3. Kling Motion Control -------------------------------------------------------
  {
    id: 'wavespeed/kling-v3-motion-control-std',
    provider: 'wavespeed',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control (std)',
    endpoint: 'kwaivgi/kling-v3.0-std/motion-control',
    fields: {
      image: 'image', video: 'video', prompt: null,
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: false },
    },
    params: {},
    options: [],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 3850, imageMinPx: 340, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null, // "from $0.63/run", scales with duration+resolution; no clean per-second table
    keepsImageBackground: true,
    verified: true, // std path confirmed; pro path is NOT confirmed so it is omitted
    docs: 'https://wavespeed.ai/kling-3-motion-control-api',
  },
  {
    id: 'fal/kling-v3-standard-motion-control',
    provider: 'fal',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control (standard)',
    endpoint: 'fal-ai/kling-video/v3/standard/motion-control',
    fields: {
      image: 'image_url', video: 'video_url', prompt: null,
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: false },
    },
    params: {},
    options: [],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 3850, imageMinPx: 340, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: true,
    docs: 'https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control/api',
  },
  {
    id: 'fal/kling-v3-pro-motion-control',
    provider: 'fal',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control (pro)',
    endpoint: 'fal-ai/kling-video/v3/pro/motion-control',
    fields: {
      image: 'image_url', video: 'video_url', prompt: null,
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: false },
    },
    params: {},
    options: [],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 3850, imageMinPx: 340, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: true,
    docs: 'https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control/api',
  },
  {
    id: 'fal/kling-v2.6-pro-motion-control',
    provider: 'fal',
    family: 'kling-motion',
    label: 'Kling v2.6 Motion Control (pro)',
    endpoint: 'fal-ai/kling-video/v2.6/pro/motion-control',
    fields: {
      image: 'image_url', video: 'video_url', prompt: null,
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: false },
    },
    params: {},
    options: [],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 3850, imageMinPx: 340, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: true,
    docs: 'https://fal.ai/docs/model-api-reference/video-generation-api/kling-video-v2.6-standard',
  },
  {
    id: 'replicate/kling-v3-motion-control',
    provider: 'replicate',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control',
    endpoint: 'kwaivgi/kling-v3-motion-control',
    fields: {
      image: 'image', video: 'video', prompt: null,
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: false },
    },
    params: {},
    options: [{ key: 'mode', field: 'mode', label: '품질', values: ['std', 'pro'], default: 'std' }],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 3850, imageMinPx: 340, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: true, // input schema confirmed from Replicate's model API page
    docs: 'https://replicate.com/kwaivgi/kling-v3-motion-control',
  },
  {
    id: 'higgsfield/kling-v3-motion-control-std',
    provider: 'higgsfield',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control (std)',
    endpoint: 'kling-video/v3/motion-control/std',
    fields: {
      image: 'image_url', video: 'video_url', prompt: null,
      orientation: KLING_ORIENTATION,
      // Higgsfield uses "yes"/"no" strings for keep_original_sound.
      sound: { field: 'keep_original_sound', off: 'no' },
    },
    params: {},
    options: [],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 65536, imageMinPx: 300, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null, // Higgsfield exposes /estimate rather than a fixed table
    keepsImageBackground: true,
    verified: true,
    docs: 'https://docs.higgsfield.ai/docs/models/kling-3-motion-control/std',
  },
  {
    id: 'higgsfield/kling-v3-motion-control-pro',
    provider: 'higgsfield',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control (pro)',
    endpoint: 'kling-video/v3/motion-control/pro',
    fields: {
      image: 'image_url', video: 'video_url', prompt: null,
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: 'no' },
    },
    params: {},
    options: [],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 65536, imageMinPx: 300, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: true,
    docs: 'https://docs.higgsfield.ai/docs/models/kling-3-motion-control/pro',
  },
  {
    id: 'kling/v3-motion-control',
    provider: 'kling',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control (직접)',
    // Direct Kling developer API. Exact create path segment + auth regime UNVERIFIED.
    endpoint: 'kling-v3',
    fields: {
      image: 'image', video: 'video', prompt: 'prompt',
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: false },
    },
    params: {},
    options: [{ key: 'mode', field: 'mode', label: '품질', values: ['std', 'pro'], default: 'std' }],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 3850, imageMinPx: 300, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: false, // exact motion-control path + auth regime not confirmed from vendor console
    docs: 'https://app.klingai.com/global/dev/document-api',
  },
  {
    id: 'kling/v2.6-motion-control',
    provider: 'kling',
    family: 'kling-motion',
    label: 'Kling v2.6 Motion Control (직접)',
    endpoint: 'kling-v2-6',
    fields: {
      image: 'image', video: 'video', prompt: 'prompt',
      orientation: KLING_ORIENTATION, sound: { field: 'keep_original_sound', off: false },
    },
    params: {},
    options: [{ key: 'mode', field: 'mode', label: '품질', values: ['std', 'pro'], default: 'std' }],
    limits: {
      videoMinSec: 3, videoMaxSec: 30, videoMaxSecByOrientation: KLING_VIDEO_MAX_BY_ORIENTATION,
      imageMaxPx: 3850, imageMinPx: 300, aspectMin: 0.4, aspectMax: 2.5,
    },
    pricing: null,
    keepsImageBackground: true,
    verified: false,
    docs: 'https://app.klingai.com/global/dev/document-api',
  },
];

// ---- Dotted-path setter -------------------------------------------------------------
function setPath(target, dottedPath, value) {
  const parts = String(dottedPath).split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Build the canonical request body from a route + inputs.
 * Returns a plain object; adapters wrap it as their protocol needs (e.g. Replicate {input}).
 *
 * @param {object} route
 * @param {{ imageUrl?: string, videoUrl?: string, prompt?: string|null,
 *           orientation?: 'image'|'video', options?: object }} args
 */
function buildRequest(route, args = {}) {
  const { imageUrl, videoUrl, prompt, orientation, options = {} } = args;
  const body = {};
  const f = route.fields || {};

  if (f.image && imageUrl !== undefined) setPath(body, f.image, imageUrl);
  if (f.video && videoUrl !== undefined) setPath(body, f.video, videoUrl);

  // Prompt only when the route supports it AND a prompt was supplied.
  if (f.prompt && prompt !== undefined && prompt !== null && prompt !== '') {
    setPath(body, f.prompt, prompt);
  }

  // Orientation mapping (Kling): value is 'image' or 'video'.
  if (f.orientation && typeof f.orientation === 'object' && orientation) {
    const mapped = f.orientation[orientation];
    if (mapped !== undefined) setPath(body, f.orientation.field, mapped);
  }

  // Sound: these presets are silent overlays, so whenever the route exposes a sound field we
  // send the value that DROPS audio (`sound.off`).
  if (f.sound && typeof f.sound === 'object' && typeof f.sound.field === 'string') {
    setPath(body, f.sound.field, f.sound.off);
  }

  // Options: each option's value (user value if in `values`, else default) at option.field.
  for (const opt of route.options || []) {
    const supplied = options[opt.key];
    const value = (opt.values && opt.values.includes(supplied)) ? supplied : opt.default;
    if (value !== undefined) setPath(body, opt.field, value);
  }

  // Static params, sent as-is (dotted paths allowed). Applied last, so they win.
  for (const [key, value] of Object.entries(route.params || {})) {
    setPath(body, key, value);
  }

  return body;
}

// ---- validateRoute ------------------------------------------------------------------
const VALID_FAMILIES = new Set(Object.keys(FAMILIES));

function validateRoute(route) {
  const fail = msg => { throw new Error(`Invalid route: ${msg}`); };
  if (!route || typeof route !== 'object') fail('not an object');
  if (typeof route.id !== 'string' || !route.id) fail('id must be a non-empty string');
  if (typeof route.provider !== 'string' || !route.provider) fail(`${route.id}: provider must be a non-empty string`);
  if (!VALID_FAMILIES.has(route.family)) fail(`${route.id}: family must be one of ${[...VALID_FAMILIES].join(', ')}`);
  if (typeof route.label !== 'string' || !route.label) fail(`${route.id}: label must be a non-empty string`);
  if (typeof route.endpoint !== 'string' || !route.endpoint) fail(`${route.id}: endpoint must be a non-empty string`);
  if (!route.fields || typeof route.fields !== 'object') fail(`${route.id}: fields must be an object`);
  if (typeof route.fields.image !== 'string' || !route.fields.image) fail(`${route.id}: fields.image is required`);
  if (typeof route.fields.video !== 'string' || !route.fields.video) fail(`${route.id}: fields.video is required`);
  if ('prompt' in route.fields && route.fields.prompt !== null && typeof route.fields.prompt !== 'string') {
    fail(`${route.id}: fields.prompt must be a string or null`);
  }
  if (route.fields.orientation && typeof route.fields.orientation === 'object') {
    const o = route.fields.orientation;
    if (typeof o.field !== 'string') fail(`${route.id}: fields.orientation.field must be a string`);
  }
  if (route.fields.sound && typeof route.fields.sound === 'object') {
    if (typeof route.fields.sound.field !== 'string') fail(`${route.id}: fields.sound.field must be a string`);
    if (!('off' in route.fields.sound)) fail(`${route.id}: fields.sound.off is required`);
  }
  if (route.params && typeof route.params !== 'object') fail(`${route.id}: params must be an object`);
  if (route.options) {
    if (!Array.isArray(route.options)) fail(`${route.id}: options must be an array`);
    for (const opt of route.options) {
      if (typeof opt.key !== 'string' || !opt.key) fail(`${route.id}: option.key must be a non-empty string`);
      if (typeof opt.field !== 'string' || !opt.field) fail(`${route.id}: option.field must be a non-empty string`);
      if (!Array.isArray(opt.values) || opt.values.length === 0) fail(`${route.id}: option.values must be a non-empty array`);
      if (opt.default !== undefined && !opt.values.includes(opt.default)) {
        fail(`${route.id}: option.default must be one of its values`);
      }
    }
  }
  if (route.limits && typeof route.limits !== 'object') fail(`${route.id}: limits must be an object`);
  if (typeof route.verified !== 'boolean') fail(`${route.id}: verified must be a boolean`);
  if (route.docs !== undefined && typeof route.docs !== 'string') fail(`${route.id}: docs must be a string`);
  return true;
}

module.exports = { ROUTES, FAMILIES, buildRequest, validateRoute };
