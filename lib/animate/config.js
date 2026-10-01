'use strict';

// The animate config store (data/animate/config.json), read-only: the server's
// own provider keys. Owns credential/setting resolution against each adapter's
// `meta` with env fallback. There is no bring-your-own-key: nothing edits the
// file through the API, and no secret (not even masked) leaves the server.
//
// Shape:
// { version, providers:{ [id]:{ [key]:value, baseUrl? } }, defaults:{ routeId, options },
//   mediaRelay, concurrency, promptSuffix }

const fsp = require('node:fs/promises');

const { DEFAULT_PROMPT_SUFFIX } = require('./presets');

// mediaRelay "auto" resolves to the first configured of these, in order.
const RELAY_PREFERENCE = ['wavespeed', 'fal', 'higgsfield'];

function defaultConfig() {
  return {
    version: 1,
    providers: {},
    defaults: { routeId: null, options: {} },
    mediaRelay: 'auto',
    concurrency: 2,
    promptSuffix: DEFAULT_PROMPT_SUFFIX,
  };
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

  // The provider view for GET /api/animate/status: whether the server can use
  // it, never a key.
  providerViews() {
    return Object.entries(this.providers).map(([id, adapter]) => {
      const meta = adapter.meta;
      return {
        id,
        label: meta.label,
        configured: this.isConfigured(id),
        publicUploads: !!meta.publicUploads,
        needsPublicVideoUrl: !!meta.needsPublicVideoUrl,
      };
    });
  }

  // The `config` block for GET /api/animate/status (no secrets in here).
  publicConfig() {
    return {
      defaults: { routeId: this.config.defaults.routeId, options: this.config.defaults.options },
      mediaRelay: this.config.mediaRelay,
      concurrency: this.config.concurrency,
      promptSuffix: this.config.promptSuffix,
    };
  }
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
  if (Number.isInteger(raw.concurrency) && raw.concurrency >= 1 && raw.concurrency <= 4) out.concurrency = raw.concurrency;
  if (typeof raw.promptSuffix === 'string') out.promptSuffix = raw.promptSuffix;
  return out;
}

module.exports = { ConfigStore, defaultConfig };
