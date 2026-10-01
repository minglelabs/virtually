'use strict';

// The animate settings: the server's own provider keys and a few knobs. They come from
// environment variables only (there is no config file), and the store is read-only: nothing
// edits it through the API, and no secret (not even masked) leaves the server. Owns
// credential/setting resolution against each adapter's `meta`.
//
//   provider keys          the variables each adapter's meta names (WAVESPEED_API_KEY, FAL_KEY, ...)
//   ANIMATE_DEFAULT_ROUTE  route id offered first while it is available
//   ANIMATE_MEDIA_RELAY    "auto" (default) or the id of the provider that relays reference videos
//   ANIMATE_CONCURRENCY    jobs running at once, 1-4 (default 2)
//   ANIMATE_PROMPT_SUFFIX  appended to every prompt
//   ANIMATE_CUSTOM_ROUTES  JSON array of extra routes (see customRoutesFromEnv)
//
// Shape of `config` (what tests pass instead of the environment):
// { providers:{ [id]:{ [key]:value, baseUrl? } }, defaults:{ routeId, options },
//   mediaRelay, concurrency, promptSuffix }

const fsp = require('node:fs/promises');
const path = require('node:path');

const { DEFAULT_PROMPT_SUFFIX } = require('./presets');

// mediaRelay "auto" resolves to the first configured of these, in order.
const RELAY_PREFERENCE = ['wavespeed', 'fal', 'higgsfield'];

function defaultConfig() {
  return {
    providers: {},
    defaults: { routeId: null, options: {} },
    mediaRelay: 'auto',
    concurrency: 2,
    promptSuffix: DEFAULT_PROMPT_SUFFIX,
  };
}

function firstEnv(env, names) {
  // Adapter metas give credential env names as arrays and setting env names as a
  // single string; never iterate a string (that reads process.env['D'], ['_'], ...).
  const list = Array.isArray(names) ? names : (typeof names === 'string' && names ? [names] : []);
  for (const name of list) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

class ConfigStore {
  // `providers` is the id->adapter map (real adapters + the mock adapter when
  // enabled); each adapter exposes `meta`. Passing the mock here keeps its
  // (empty) credentials consistent with the real ones. `config` overrides what
  // `env` says (tests; nothing in the server passes it).
  constructor(providers, { config = {}, env = process.env } = {}) {
    this.providers = providers || {};
    this.env = env;
    this.config = normalizeConfig({ ...settingsFromEnv(env), ...config });
  }

  // Resolve a single field's value + source from `config` (non-empty string) or
  // the first non-empty env var. { value, source: 'config'|'env'|null }.
  // Settings with a `values` list only accept one of those values; anything else
  // (e.g. a stray env var) resolves to null so the default applies.
  _resolveField(providerId, spec) {
    const allowed = value => !Array.isArray(spec.values) || spec.values.includes(value);
    const stored = this.config.providers[providerId] && this.config.providers[providerId][spec.key];
    if (typeof stored === 'string' && stored !== '' && allowed(stored)) return { value: stored, source: 'config' };
    const envValue = firstEnv(this.env, spec.env);
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

// A partial config over the defaults, keeping only known shapes.
function normalizeConfig(raw) {
  const out = defaultConfig();
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
  if (typeof raw.mediaRelay === 'string' && raw.mediaRelay) out.mediaRelay = raw.mediaRelay;
  if (Number.isInteger(raw.concurrency) && raw.concurrency >= 1 && raw.concurrency <= 4) out.concurrency = raw.concurrency;
  if (typeof raw.promptSuffix === 'string') out.promptSuffix = raw.promptSuffix;
  return out;
}

// The ANIMATE_* variables as a (partial) config; a variable that is unset, empty or unusable is left out.
function settingsFromEnv(env) {
  const text = name => (typeof env[name] === 'string' && env[name].trim() !== '' ? env[name].trim() : undefined);
  const settings = {};
  if (text('ANIMATE_DEFAULT_ROUTE')) settings.defaults = { routeId: text('ANIMATE_DEFAULT_ROUTE'), options: {} };
  if (text('ANIMATE_MEDIA_RELAY')) settings.mediaRelay = text('ANIMATE_MEDIA_RELAY');
  if (text('ANIMATE_CONCURRENCY')) settings.concurrency = Number(text('ANIMATE_CONCURRENCY'));
  // The suffix is free text, so only unset means "keep the default"; an empty value means no suffix.
  if (typeof env.ANIMATE_PROMPT_SUFFIX === 'string') settings.promptSuffix = env.ANIMATE_PROMPT_SUFFIX;
  return settings;
}

// ANIMATE_CUSTOM_ROUTES: a JSON array of route objects (each is validated by the registry
// and skipped when invalid). Unset or empty -> []. Not JSON, or not an array -> [] and a message.
function customRoutesFromEnv(env, log = () => {}) {
  const text = env.ANIMATE_CUSTOM_ROUTES;
  if (typeof text !== 'string' || text.trim() === '') return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // reported below
  }
  log('[animate] ANIMATE_CUSTOM_ROUTES is not a JSON array; no custom routes are loaded.');
  return [];
}

// The pre-environment layout kept settings in <dataDir>/animate/config.json and custom-routes.json.
// They are not read any more; if a data directory still has them, say which variables replace
// them (names only: a key is never printed). -> a message, or null when there is nothing to move.
async function legacyFilesNotice(animateDir, providers) {
  const read = async name => {
    try {
      return { text: await fsp.readFile(path.join(animateDir, name), 'utf8') };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { text: '' };
    }
  };
  const notes = [];
  const config = await read('config.json');
  if (config) {
    const names = new Set();
    let stored = null;
    try {
      stored = JSON.parse(config.text);
    } catch {
      // unreadable: the generic hint below
    }
    if (stored && typeof stored === 'object') {
      for (const [id, fields] of Object.entries(stored.providers || {})) {
        const meta = providers[id] && providers[id].meta;
        if (!meta || !fields || typeof fields !== 'object') continue;
        for (const key of Object.keys(fields)) {
          const spec = [...(meta.credentials || []), ...(meta.settings || [])].find(item => item.key === key);
          const env = spec && (Array.isArray(spec.env) ? spec.env[0] : spec.env);
          if (env) names.add(env);
        }
      }
      const defaults = stored.defaults || {};
      if (defaults.routeId) names.add('ANIMATE_DEFAULT_ROUTE');
      if (stored.mediaRelay && stored.mediaRelay !== 'auto') names.add('ANIMATE_MEDIA_RELAY');
      if (Number.isInteger(stored.concurrency) && stored.concurrency !== defaultConfig().concurrency) names.add('ANIMATE_CONCURRENCY');
      if (typeof stored.promptSuffix === 'string' && stored.promptSuffix !== DEFAULT_PROMPT_SUFFIX) names.add('ANIMATE_PROMPT_SUFFIX');
    }
    notes.push(`data/animate/config.json is no longer read${names.size ? `; set ${[...names].join(', ')} instead` : ' (set its values as environment variables)'}`);
  }
  if (await read('custom-routes.json')) notes.push('data/animate/custom-routes.json is no longer read; put its JSON array in ANIMATE_CUSTOM_ROUTES');
  return notes.length ? `[animate] ${notes.join('. ')}. Delete the file(s) once that is done.` : null;
}

module.exports = { ConfigStore, defaultConfig, customRoutesFromEnv, legacyFilesNotice };
