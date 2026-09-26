'use strict';

// The animate config store (animate/providers.json). Owns credential/setting
// resolution against each adapter's `meta`, env fallback with `source`, secret
// masking, the partial-PUT rules, and validation of mediaRelay/keying/
// concurrency. The file is written 0600 with atomic tmp+rename. Full secret
// values never leave the server — status responses carry only masked values.
//
// Shape (see .kiro/specs/animate-presets.md "Config"):
// { version, providers:{ [id]:{ [key]:value, baseUrl? } }, defaults:{ routeId, options },
//   mediaRelay, keying:{ color, similarity, blend, despill }, concurrency,
//   promptSuffix, replaceExisting, autoPublish }

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { normalizeColor, despillType } = require('../chroma-encode');
const { DEFAULT_PROMPT_SUFFIX } = require('./presets');

const MASK = '••••';
const MAX_VALUE_LEN = 4096;
// keying numbers share the chroma converter's ranges.
const KEYING_LIMITS = { similarity: [0.01, 1], blend: [0, 1] };
// mediaRelay "auto" resolves to the first configured of these, in order.
const RELAY_PREFERENCE = ['wavespeed', 'fal', 'higgsfield'];

function defaultConfig() {
  return {
    version: 1,
    providers: {},
    defaults: { routeId: null, options: {} },
    mediaRelay: 'auto',
    keying: { color: 'auto', similarity: 0.14, blend: 0.08, despill: true },
    concurrency: 2,
    promptSuffix: DEFAULT_PROMPT_SUFFIX,
    replaceExisting: true,
    autoPublish: true,
  };
}

// Mask a stored secret: "••••" + last 4 when length >= 8, else "••••".
function maskValue(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length >= 8 ? MASK + value.slice(-4) : MASK;
}

function firstEnv(names) {
  // Adapter metas give credential env names as arrays and setting env names as a
  // single string; never iterate a string (that reads process.env['D'], ['_'], ...).
  const list = Array.isArray(names) ? names : (typeof names === 'string' && names ? [names] : []);
  for (const name of list) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

class ConfigStore {
  // `providers` is the id->adapter map (real adapters + the mock adapter when
  // enabled); each adapter exposes `meta`. Passing the mock here keeps its
  // (empty) credentials consistent with the real ones.
  constructor(filePath, providers) {
    this.filePath = filePath;
    this.providers = providers || {};
    this.config = defaultConfig();
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object') this.config = mergeConfig(defaultConfig(), raw);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async _persist() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(this.config, null, 2) + '\n', { mode: 0o600 });
      // writeFile with an existing tmp keeps its old mode; enforce 0600 either way.
      await fsp.chmod(tmp, 0o600).catch(() => {});
      await fsp.rename(tmp, this.filePath);
      await fsp.chmod(this.filePath, 0o600).catch(() => {});
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // Resolve a single field's value + source from the file (non-empty string) or
  // the first non-empty env var. { value, source: 'config'|'env'|null }.
  // Settings with a `values` list only accept one of those values; anything else
  // (e.g. a stray env var) resolves to null so the default applies.
  _resolveField(providerId, spec) {
    const allowed = value => !Array.isArray(spec.values) || spec.values.includes(value);
    const stored = this.config.providers[providerId] && this.config.providers[providerId][spec.key];
    if (typeof stored === 'string' && stored !== '' && allowed(stored)) return { value: stored, source: 'config' };
    const envValue = firstEnv(spec.env);
    if (envValue != null && allowed(envValue)) return { value: envValue, source: 'env' };
    return { value: null, source: null };
  }

  // Resolved credentials for an adapter ctx: { [key]: value } (only non-null).
  resolvedCredentials(providerId) {
    const adapter = this.providers[providerId];
    if (!adapter) return {};
    const out = {};
    for (const spec of adapter.meta.credentials || []) {
      const { value } = this._resolveField(providerId, spec);
      if (value != null) out[spec.key] = value;
    }
    return out;
  }

  // Resolved settings for an adapter ctx: { [key]: value } (default applied).
  resolvedSettings(providerId) {
    const adapter = this.providers[providerId];
    if (!adapter) return {};
    const out = {};
    for (const spec of adapter.meta.settings || []) {
      const { value } = this._resolveField(providerId, spec);
      out[spec.key] = value != null ? value : spec.default;
    }
    return out;
  }

  // Hidden test-only base URL (never surfaced in the UI). When it is http://,
  // the adapter ctx is told insecure downloads/uploads are allowed.
  baseUrl(providerId) {
    const stored = this.config.providers[providerId] && this.config.providers[providerId].baseUrl;
    return typeof stored === 'string' && stored ? stored : null;
  }

  allowInsecure(providerId) {
    const url = this.baseUrl(providerId);
    return !!url && url.startsWith('http://');
  }

  // A provider is configured when every key of at least one credentialSets entry
  // resolves to a non-null value.
  isConfigured(providerId) {
    const adapter = this.providers[providerId];
    if (!adapter) return false;
    const resolved = this.resolvedCredentials(providerId);
    const sets = adapter.meta.credentialSets || [];
    if (sets.length === 0) return true; // no credentials required (e.g. mock)
    return sets.some(set => set.every(key => resolved[key] != null));
  }

  // The provider id used to relay reference videos to a public URL, or null.
  resolveMediaRelay() {
    const value = this.config.mediaRelay;
    if (value && value !== 'auto') {
      return this.isConfigured(value) ? value : null;
    }
    for (const id of RELAY_PREFERENCE) {
      if (this.providers[id] && this.providers[id].meta.publicUploads && this.isConfigured(id)) return id;
    }
    return null;
  }

  // The provider view for GET /api/animate/status (masked, never raw secrets).
  providerViews() {
    return Object.entries(this.providers).map(([id, adapter]) => {
      const meta = adapter.meta;
      return {
        id,
        label: meta.label,
        docs: meta.docs || null,
        configured: this.isConfigured(id),
        publicUploads: !!meta.publicUploads,
        needsPublicVideoUrl: !!meta.needsPublicVideoUrl,
        testable: typeof adapter.test === 'function',
        credentials: (meta.credentials || []).map(spec => {
          const { value, source } = this._resolveField(id, spec);
          return {
            key: spec.key,
            label: spec.label,
            optional: !!spec.optional,
            configured: value != null,
            source,
            masked: source === 'config' ? maskValue(value) : null,
          };
        }),
        settings: (meta.settings || []).map(spec => {
          const { value, source } = this._resolveField(id, spec);
          return {
            key: spec.key,
            label: spec.label,
            values: spec.values,
            value: value != null ? value : spec.default,
            source: source || null,
          };
        }),
      };
    });
  }

  // The `config` block for GET /api/animate/status (no secrets in here).
  publicConfig() {
    return {
      defaults: { routeId: this.config.defaults.routeId, options: this.config.defaults.options },
      mediaRelay: this.config.mediaRelay,
      keying: { ...this.config.keying },
      concurrency: this.config.concurrency,
      promptSuffix: this.config.promptSuffix,
      replaceExisting: this.config.replaceExisting,
      autoPublish: this.config.autoPublish,
    };
  }

  // Apply a partial PUT (JSON body). Throws {status:400} on any bad field, and
  // nothing is persisted when it throws. Returns after a successful save.
  async applyPatch(patch) {
    if (!patch || typeof patch !== 'object') throw bad('Body must be a JSON object.');
    // Work on a deep-ish copy so a mid-validation throw leaves state untouched.
    const draft = mergeConfig(defaultConfig(), this.config);

    if ('providers' in patch) {
      if (!patch.providers || typeof patch.providers !== 'object') throw bad('providers must be an object.');
      for (const [providerId, fields] of Object.entries(patch.providers)) {
        const adapter = this.providers[providerId];
        if (!adapter) throw bad(`Unknown provider: ${providerId}.`, 'unknown_provider');
        if (!fields || typeof fields !== 'object') throw bad(`providers.${providerId} must be an object.`);
        const credByKey = new Map((adapter.meta.credentials || []).map(spec => [spec.key, spec]));
        const setByKey = new Map((adapter.meta.settings || []).map(spec => [spec.key, spec]));
        const target = draft.providers[providerId] || (draft.providers[providerId] = {});
        for (const [key, rawValue] of Object.entries(fields)) {
          // The test-only base URL is read from the file but can never be set over
          // the API: pointing a provider at another host would send it the API key.
          if (key === 'baseUrl') throw bad(`${providerId}.baseUrl cannot be changed through the API.`);
          const credSpec = credByKey.get(key);
          const setSpec = setByKey.get(key);
          if (!credSpec && !setSpec) throw bad(`Unknown field ${providerId}.${key}.`);
          // "" or null removes the stored value (env fallback then applies).
          if (rawValue == null || rawValue === '') { delete target[key]; continue; }
          if (typeof rawValue !== 'string') throw bad(`${providerId}.${key} must be a string.`);
          // A value that starts with the mask is the unchanged masked display: ignore it.
          if (rawValue.startsWith(MASK)) continue;
          const trimmed = rawValue.trim();
          if (trimmed.length > MAX_VALUE_LEN) throw bad(`${providerId}.${key} is too long.`);
          if (setSpec && Array.isArray(setSpec.values) && !setSpec.values.includes(trimmed)) {
            throw bad(`${providerId}.${key} must be one of: ${setSpec.values.join(', ')}.`);
          }
          target[key] = trimmed;
        }
        if (Object.keys(target).length === 0) delete draft.providers[providerId];
      }
    }

    if ('defaults' in patch) {
      const d = patch.defaults;
      if (!d || typeof d !== 'object') throw bad('defaults must be an object.');
      if ('routeId' in d) {
        if (d.routeId != null && typeof d.routeId !== 'string') throw bad('defaults.routeId must be a string or null.');
        draft.defaults.routeId = d.routeId || null;
      }
      if ('options' in d) {
        if (d.options != null && typeof d.options !== 'object') throw bad('defaults.options must be an object.');
        draft.defaults.options = d.options || {};
      }
    }

    if ('mediaRelay' in patch) {
      const value = patch.mediaRelay;
      if (value !== 'auto') {
        const adapter = this.providers[value];
        if (!adapter || !adapter.meta.publicUploads) {
          throw bad('mediaRelay must be "auto" or a provider that supports public uploads.');
        }
      }
      draft.mediaRelay = value;
    }

    if ('keying' in patch) {
      const k = patch.keying;
      if (!k || typeof k !== 'object') throw bad('keying must be an object.');
      if ('color' in k) {
        if (k.color === 'auto') draft.keying.color = 'auto';
        else {
          const color = normalizeColor(k.color);
          if (!color) throw bad('keying.color must be "auto" or a #RRGGBB colour.');
          draft.keying.color = color;
        }
      }
      for (const field of ['similarity', 'blend']) {
        if (field in k) {
          const num = Number(k[field]);
          const [lo, hi] = KEYING_LIMITS[field];
          if (!Number.isFinite(num) || num < lo || num > hi) {
            throw bad(`keying.${field} must be within [${lo}, ${hi}].`);
          }
          draft.keying[field] = num;
        }
      }
      if ('despill' in k) draft.keying.despill = !!k.despill;
    }

    if ('concurrency' in patch) {
      const num = Number(patch.concurrency);
      if (!Number.isInteger(num) || num < 1 || num > 4) throw bad('concurrency must be an integer from 1 to 4.');
      draft.concurrency = num;
    }

    if ('promptSuffix' in patch) {
      if (patch.promptSuffix != null && typeof patch.promptSuffix !== 'string') throw bad('promptSuffix must be a string.');
      const suffix = patch.promptSuffix == null ? '' : String(patch.promptSuffix).trim();
      if (suffix.length > MAX_VALUE_LEN) throw bad('promptSuffix is too long.');
      draft.promptSuffix = suffix;
    }

    if ('replaceExisting' in patch) draft.replaceExisting = !!patch.replaceExisting;
    if ('autoPublish' in patch) draft.autoPublish = !!patch.autoPublish;

    this.config = draft;
    await this._persist();
  }
}

function bad(message, code) {
  const error = new Error(message);
  error.status = 400;
  if (code) error.code = code;
  return error;
}

// Merge a stored/partial config over defaults, keeping only known shapes.
function mergeConfig(base, raw) {
  const out = defaultConfig();
  out.version = 1;
  if (raw.providers && typeof raw.providers === 'object') {
    out.providers = {};
    for (const [id, fields] of Object.entries(raw.providers)) {
      if (fields && typeof fields === 'object') {
        const clean = {};
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value === 'string') clean[key] = value;
        }
        if (Object.keys(clean).length) out.providers[id] = clean;
      }
    }
  }
  if (raw.defaults && typeof raw.defaults === 'object') {
    out.defaults = {
      routeId: typeof raw.defaults.routeId === 'string' ? raw.defaults.routeId : null,
      options: raw.defaults.options && typeof raw.defaults.options === 'object' ? raw.defaults.options : {},
    };
  }
  if (raw.mediaRelay === 'auto' || typeof raw.mediaRelay === 'string') out.mediaRelay = raw.mediaRelay;
  if (raw.keying && typeof raw.keying === 'object') {
    out.keying = {
      color: raw.keying.color === 'auto' || typeof raw.keying.color === 'string' ? raw.keying.color : base.keying.color,
      similarity: Number.isFinite(raw.keying.similarity) ? raw.keying.similarity : base.keying.similarity,
      blend: Number.isFinite(raw.keying.blend) ? raw.keying.blend : base.keying.blend,
      despill: typeof raw.keying.despill === 'boolean' ? raw.keying.despill : base.keying.despill,
    };
  }
  if (Number.isInteger(raw.concurrency) && raw.concurrency >= 1 && raw.concurrency <= 4) out.concurrency = raw.concurrency;
  if (typeof raw.promptSuffix === 'string') out.promptSuffix = raw.promptSuffix;
  if (typeof raw.replaceExisting === 'boolean') out.replaceExisting = raw.replaceExisting;
  if (typeof raw.autoPublish === 'boolean') out.autoPublish = raw.autoPublish;
  return out;
}

module.exports = { ConfigStore, defaultConfig, maskValue, KEYING_LIMITS };
