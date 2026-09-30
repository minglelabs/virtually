'use strict';

// The nine preset motions. `id` and `label` match the controller's
// PRESET_MOTIONS (public/motions.js): a library motion named like a preset's
// id or label is shown on that preset's button on the main page. `prompt` is
// the English motion description sent to routes that take a prompt;
// `orientation` feeds Kling's character_orientation ('image' keeps the image
// framing and caps the driving video at 10 s, 'video' follows the performer).

// Appended to every sent prompt unless the config overrides it. The pipeline
// places the character on a plain key-colour canvas before sending it: green
// by default, blue or magenta when the character itself has green in it
// (key-color.js). The stored config default is the green wording; the
// pipeline swaps in the job's colour name only while the config still holds it.
function defaultPromptSuffix(colorName = 'green') {
  return `Keep the plain solid ${colorName} background unchanged and empty. Static camera, no zoom, no camera movement.`;
}
const DEFAULT_PROMPT_SUFFIX = defaultPromptSuffix('green');

// Appended to the separate motion prompt of routes that take one (Wan 2.2 Animate 2).
// Camera wording only: the background is described by the route's backgroundPrompt.
const MOTION_PROMPT_SUFFIX = 'Static camera, no zoom, no camera movement.';

// Used for driving videos that are not linked to a preset (user uploads).
const GENERIC_PROMPT = 'The character performs the same motion as the person in the reference video.';

const PRESETS = [
  { id: 'hi', label: '인사 (Hi)', orientation: 'image',
    prompt: 'The character waves hello with one hand and smiles warmly.' },
  { id: 'wink', label: '윙크', orientation: 'image',
    prompt: 'The character gives a playful wink with one eye and a bright smile.' },
  { id: 'cheek-heart', label: '볼하트', orientation: 'image',
    prompt: 'The character makes a cute cheek heart, both hands forming half-hearts against the cheeks.' },
  { id: 'finger-heart', label: '손하트', orientation: 'image',
    prompt: 'The character makes a Korean finger heart by crossing thumb and index finger, smiling.' },
  { id: 'kpop-heart', label: 'K-pop 하트', orientation: 'image',
    prompt: 'The character raises both arms over the head to form a big heart shape, K-pop idol style.' },
  { id: 'clap-laugh', label: '박수치며 웃음', orientation: 'image',
    prompt: 'The character claps both hands while laughing happily.' },
  { id: 'dont-know', label: "I don't know 포즈", orientation: 'image',
    prompt: 'The character shrugs with palms up and a puzzled "I don\'t know" expression.' },
  { id: 'wonyoung-turn', label: '원영턴', orientation: 'video',
    prompt: 'The character does a graceful full spin turn and finishes with a cute pose, K-pop idol style.' },
  { id: 'bad-challenge', label: 'BAD 챌린지 춤', orientation: 'video',
    prompt: 'The character performs an energetic K-pop dance challenge routine.' },
];

const PRESET_BY_ID = new Map(PRESETS.map(preset => [preset.id, preset]));

function isPreset(id) {
  return PRESET_BY_ID.has(id);
}

function getPreset(id) {
  return PRESET_BY_ID.get(id) || null;
}

function listPresets() {
  return PRESETS.slice();
}

// The prompt actually sent to a route: (override || preset prompt || generic)
// + ' ' + promptSuffix. `preset` may be null (a driving video with no preset).
function composePrompt(preset, override, promptSuffix) {
  const base = (override && override.trim()) || (preset && preset.prompt) || GENERIC_PROMPT;
  const suffix = promptSuffix == null ? DEFAULT_PROMPT_SUFFIX : promptSuffix;
  return suffix ? `${base} ${suffix}` : base;
}

// The separate motion prompt: (preset prompt || generic) + ' ' + MOTION_PROMPT_SUFFIX.
function composeMotionPrompt(preset) {
  const base = (preset && preset.prompt) || GENERIC_PROMPT;
  return `${base} ${MOTION_PROMPT_SUFFIX}`;
}

module.exports = {
  DEFAULT_PROMPT_SUFFIX,
  defaultPromptSuffix,
  MOTION_PROMPT_SUFFIX,
  GENERIC_PROMPT,
  PRESETS,
  isPreset,
  getPreset,
  listPresets,
  composePrompt,
  composeMotionPrompt,
};
