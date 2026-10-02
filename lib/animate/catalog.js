'use strict';

const { isMargin } = require('./margin');

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
  'wan-animate-2': 'Wan 2.2 Animate 2',
  dreamactor: 'DreamActor M2.0',
  'kling-motion': 'Kling 모션 컨트롤',
  other: '기타',
};

// Orientation-to-duration coupling shared by every Kling motion-control route:
// character_orientation:image caps the reference at 10 s; :video allows 30 s.
const KLING_ORIENTATION = { field: 'character_orientation', image: 'image', video: 'video' };
const KLING_VIDEO_MAX_BY_ORIENTATION = { image: 10, video: 30 };

const ROUTES = [
  // ---- 0. Wan 2.2 Animate 2 (default) -----------------------------------------------
  {
    id: 'wavespeed/wan-2.2-animate-2',
    provider: 'wavespeed',
    family: 'wan-animate-2',
    label: 'Wan 2.2 Animate 2',
    endpoint: 'wavespeed-ai/wan-2.2/animate-2',
    // Animate 2 splits the prompt: `motion_prompt` carries the motion wording, `prompt`
    // describes the character's looks + the OUTPUT background (the image's and the driving
    // video's backgrounds are ignored). There is no `mode` field.
    fields: {
      image: 'image', video: 'video', prompt: 'prompt', motionPrompt: 'motion_prompt',
      orientation: null, sound: null,
    },
    // Fixed text sent at fields.prompt instead of the composed preset prompt; the configured
    // promptSuffix is ignored for this route. A plain key colour so the result can be keyed
    // later: {color} / {hex} are filled with the job's key colour (green #00FF00 by default).
    backgroundPrompt: 'Background description: plain solid pure {color} ({hex}) chroma-key background, '
      + 'flat even lighting, no shadows, no objects, no text.',
    params: {},
    options: [{ key: 'resolution', field: 'resolution', label: '해상도', values: ['480p', '720p'], default: '720p' }],
    limits: {
      // No input minimum; up to 120 s. Output is 30 fps and follows the driving video's
      // duration and aspect ratio.
      videoMinSec: null, videoMaxSec: 120, videoMaxSecByOrientation: null,
      imageMaxPx: null, imageMinPx: null, aspectMin: null, aspectMax: null,
    },
    // Billed duration is rounded UP to whole seconds, then clamped to 3-120 s.
    pricing: {
      usdPerSecond: 0.08, byOption: { resolution: { '480p': 0.04, '720p': 0.08 } },
      minSeconds: 3, roundUpSeconds: true,
    },
    keepsImageBackground: false,
    // Output follows the driving framing: pad the driving clip (margin.js) so the character
    // keeps a margin inside the frame. Other routes default to 'none' (effect unverified).
    defaultMargin: 'normal',
    verified: true,
    docs: 'https://wavespeed.ai/docs/docs-api/wavespeed-ai/wan-2.2-animate-2',
  },

  // ---- 1. DreamActor M2.0 --------------------------------------------------------------
  {
    id: 'wavespeed/dreamactor-v2',
    provider: 'wavespeed',
    family: 'dreamactor',
    label: 'DreamActor M2.0',
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
    label: 'DreamActor M2.0',
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

  // ---- 2. Kling Motion Control -------------------------------------------------------
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
    // $0.63 per 5 s, 3 s minimum, scaling with duration (WaveSpeed model page, 2026-10-02).
    pricing: { usdPerSecond: 0.126, byOption: null, minSeconds: 3 },
    keepsImageBackground: true,
    verified: true,
    docs: 'https://wavespeed.ai/kling-3-motion-control-api',
  },
  {
    id: 'wavespeed/kling-v3-motion-control-pro',
    provider: 'wavespeed',
    family: 'kling-motion',
    label: 'Kling v3 Motion Control (pro)',
    endpoint: 'kwaivgi/kling-v3.0-pro/motion-control',
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
    // $0.84 per 5 s, 3 s minimum, scaling with duration (WaveSpeed model page, 2026-10-02).
    pricing: { usdPerSecond: 0.168, byOption: null, minSeconds: 3 },
    keepsImageBackground: true,
    verified: true,
    docs: 'https://wavespeed.ai/docs/docs-api/kwaivgi/kwaivgi-kling-v3.0-pro-motion-control',
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
 * @param {{ imageUrl?: string, videoUrl?: string, prompt?: string|null, motionPrompt?: string|null,
 *           orientation?: 'image'|'video', options?: object }} args
 */
function buildRequest(route, args = {}) {
  const { imageUrl, videoUrl, prompt, motionPrompt, orientation, options = {} } = args;
  const body = {};
  const f = route.fields || {};

  if (f.image && imageUrl !== undefined) setPath(body, f.image, imageUrl);
  if (f.video && videoUrl !== undefined) setPath(body, f.video, videoUrl);

  // Prompt only when the route supports it AND a prompt was supplied.
  if (f.prompt && prompt !== undefined && prompt !== null && prompt !== '') {
    setPath(body, f.prompt, prompt);
  }
  // Separate motion prompt (Wan 2.2 Animate 2), same rule.
  if (f.motionPrompt && motionPrompt !== undefined && motionPrompt !== null && motionPrompt !== '') {
    setPath(body, f.motionPrompt, motionPrompt);
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
  if ('motionPrompt' in route.fields && route.fields.motionPrompt !== null && typeof route.fields.motionPrompt !== 'string') {
    fail(`${route.id}: fields.motionPrompt must be a string or null`);
  }
  if (route.backgroundPrompt !== undefined && route.backgroundPrompt !== null && typeof route.backgroundPrompt !== 'string') {
    fail(`${route.id}: backgroundPrompt must be a string or null`);
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
  if (route.defaultMargin !== undefined && !isMargin(route.defaultMargin)) {
    fail(`${route.id}: defaultMargin must be none, normal or wide`);
  }
  if (typeof route.verified !== 'boolean') fail(`${route.id}: verified must be a boolean`);
  if (route.docs !== undefined && typeof route.docs !== 'string') fail(`${route.id}: docs must be a string`);
  return true;
}

module.exports = { ROUTES, FAMILIES, buildRequest, validateRoute };
