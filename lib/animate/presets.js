'use strict';

// The nine built-in motion presets and the per-preset settings store
// (animate/presets.json: { [presetId]: { trimStart, trimEnd, prompt } }).
// The catalog is the single source of truth for preset ids/names/prompts; the
// store holds only the user's per-preset overrides.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Appended to every sent prompt (after the per-preset prompt), unless the config
// overrides it. Kept here so presets.js owns the default.
const DEFAULT_PROMPT_SUFFIX =
  'Keep the plain solid green background unchanged and empty. Static camera, no zoom, no camera movement.';

// orientation: 'image' keeps the reference framing (Kling caps the reference at
// 10 s); 'video' follows the performer (turns/dances, up to 30 s).
// fullBody: the UI warns that a full-body character image is needed.
const PRESETS = [
  { id: 'hi', name: '인사', orientation: 'image', fullBody: false,
    prompt: 'The character waves hello with one hand and smiles warmly.' },
  { id: 'wink', name: '윙크', orientation: 'image', fullBody: false,
    prompt: 'The character gives a playful wink with one eye and a bright smile.' },
  { id: 'cheek-heart', name: '볼하트', orientation: 'image', fullBody: false,
    prompt: 'The character makes a cute cheek heart, both hands forming half-hearts against the cheeks.' },
  { id: 'finger-heart', name: '손하트', orientation: 'image', fullBody: false,
    prompt: 'The character makes a Korean finger heart by crossing thumb and index finger, smiling.' },
  { id: 'kpop-heart', name: 'K-pop 하트', orientation: 'image', fullBody: false,
    prompt: 'The character raises both arms over the head to form a big heart shape, K-pop idol style.' },
  { id: 'clap-laugh', name: '박수치며 웃음', orientation: 'image', fullBody: false,
    prompt: 'The character claps both hands while laughing happily.' },
  { id: 'dont-know', name: "I don't know", orientation: 'image', fullBody: false,
    prompt: 'The character shrugs with palms up and a puzzled "I don\'t know" expression.' },
  { id: 'wonyoung-turn', name: '원영턴', orientation: 'video', fullBody: true,
    prompt: 'The character does a graceful full spin turn and finishes with a cute pose, K-pop idol style.' },
  { id: 'bad-challenge', name: 'BAD 챌린지', orientation: 'video', fullBody: true,
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

// Compose the prompt actually sent to a route:
//   (per-preset override || default prompt) + ' ' + promptSuffix
function composePrompt(preset, override, promptSuffix) {
  const base = (override && override.trim()) || preset.prompt;
  const suffix = promptSuffix == null ? DEFAULT_PROMPT_SUFFIX : promptSuffix;
  return suffix ? `${base} ${suffix}` : base;
}

// --- presets.json store -------------------------------------------------------

class PresetStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.settings = {}; // { [presetId]: { trimStart, trimEnd, prompt } }
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [id, value] of Object.entries(raw)) {
          if (isPreset(id) && value && typeof value === 'object') {
            this.settings[id] = {
              trimStart: numOrNull(value.trimStart),
              trimEnd: numOrNull(value.trimEnd),
              prompt: typeof value.prompt === 'string' ? value.prompt : null,
            };
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  get(id) {
    return this.settings[id] || { trimStart: null, trimEnd: null, prompt: null };
  }

  // Apply a partial PUT. Rules: numbers >= 0, end > start (when both present),
  // null clears a field, prompt <= 500 chars. Throws {status:400} on bad input.
  async update(id, patch) {
    if (!isPreset(id)) throw Object.assign(new Error('Unknown preset.'), { status: 404 });
    const current = this.get(id);
    const next = { trimStart: current.trimStart, trimEnd: current.trimEnd, prompt: current.prompt };

    if ('trimStart' in patch) next.trimStart = validateTrim(patch.trimStart, 'trimStart');
    if ('trimEnd' in patch) next.trimEnd = validateTrim(patch.trimEnd, 'trimEnd');
    if (next.trimStart != null && next.trimEnd != null && next.trimEnd <= next.trimStart) {
      throw Object.assign(new Error('trimEnd must be greater than trimStart.'), { status: 400 });
    }
    if ('prompt' in patch) {
      if (patch.prompt == null || patch.prompt === '') {
        next.prompt = null;
      } else if (typeof patch.prompt === 'string') {
        const trimmed = patch.prompt.trim();
        if (trimmed.length > 500) throw Object.assign(new Error('prompt must be 500 characters or fewer.'), { status: 400 });
        next.prompt = trimmed || null;
      } else {
        throw Object.assign(new Error('prompt must be a string or null.'), { status: 400 });
      }
    }

    this.settings[id] = next;
    await this._persist();
    return next;
  }

  async _persist() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(this.settings, null, 2) + '\n');
      await fsp.rename(tmp, this.filePath);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }
}

function numOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

function validateTrim(value, field) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw Object.assign(new Error(`${field} must be a number >= 0 or null.`), { status: 400 });
  }
  return num;
}

module.exports = {
  DEFAULT_PROMPT_SUFFIX,
  PRESETS,
  isPreset,
  getPreset,
  listPresets,
  composePrompt,
  PresetStore,
};
