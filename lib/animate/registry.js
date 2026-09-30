'use strict';

// The route registry. It merges three sources into one ordered list:
//   1. the built-in catalog (lib/animate/catalog.js exports ROUTES) — owned by W2
//   2. the mock route (mock/local-demo) when the mock provider is enabled
//   3. user-defined routes from data/animate/custom-routes.json, each validated
//      with catalog.validateRoute
// and computes each route's availability against the resolved config.
//
// This module is defensive about the W2 catalog: while catalog.js is still a
// stub (ROUTES: [], no validateRoute/FAMILIES/buildRequest) the registry must
// still load the mock route and drive the pipeline. It reads catalog exports
// lazily and tolerates missing ones.

const fsp = require('node:fs/promises');

const FAMILY_FALLBACK = {
  'wan-animate-2': 'Wan 2.2 Animate 2',
  'wan-animate': 'Wan 2.2 Animate (v1)',
  dreamactor: 'DreamActor V2',
  'kling-motion': 'Kling 모션 컨트롤',
  other: '기타',
};

// The mock route. Family 'other', provider 'mock'. Needs both image and video
// (the pipeline feeds it the composited character + trimmed reference) and
// carries a prompt field so composePrompt output is exercised.
const MOCK_ROUTE = {
  id: 'mock/local-demo',
  provider: 'mock',
  family: 'other',
  label: '로컬 테스트 (AI 아님)',
  endpoint: 'mock',
  fields: { image: 'image', video: 'video', prompt: 'prompt', orientation: null, sound: null },
  params: {},
  options: [
    // Hidden knob the resume test uses; harmless in normal use (default 0).
    { key: 'delayMs', field: 'delayMs', label: '지연(ms)', values: null, default: 0 },
  ],
  limits: {
    videoMinSec: 1, videoMaxSec: 30, videoMaxSecByOrientation: null,
    imageMaxPx: 1920, imageMinPx: 64, aspectMin: 0.2, aspectMax: 5,
  },
  pricing: null,
  keepsImageBackground: true,
  verified: true,
  docs: null,
};

function loadCatalog() {
  try {
    // eslint-disable-next-line global-require
    return require('./catalog');
  } catch {
    return {};
  }
}

class Registry {
  constructor(configStore, { customRoutesPath = null, mockEnabled = false } = {}) {
    this.configStore = configStore;
    this.customRoutesPath = customRoutesPath;
    this.mockEnabled = mockEnabled;
    this.routes = [];
    this.byId = new Map();
  }

  async load() {
    const catalog = loadCatalog();
    const builtin = Array.isArray(catalog.ROUTES) ? catalog.ROUTES.slice() : [];
    const custom = await this._loadCustomRoutes(catalog);
    const list = [...builtin];
    if (this.mockEnabled) list.push(MOCK_ROUTE);
    list.push(...custom);
    // De-dupe by id, first wins (built-in over custom).
    this.routes = [];
    this.byId = new Map();
    for (const route of list) {
      if (!route || !route.id || this.byId.has(route.id)) continue;
      this.byId.set(route.id, route);
      this.routes.push(route);
    }
    this._catalog = catalog;
    return this;
  }

  async _loadCustomRoutes(catalog) {
    if (!this.customRoutesPath) return [];
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(this.customRoutesPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      // A malformed custom-routes file must not take the server down.
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const validate = typeof catalog.validateRoute === 'function' ? catalog.validateRoute : null;
    const out = [];
    for (const route of raw) {
      try {
        if (validate) validate(route);
        if (route && route.id && route.provider) out.push(route);
      } catch {
        // Skip an invalid custom route rather than failing the whole load.
      }
    }
    return out;
  }

  get(routeId) {
    return this.byId.get(routeId) || null;
  }

  list() {
    return this.routes.slice();
  }

  familyLabel(family) {
    const fromCatalog = this._catalog && this._catalog.FAMILIES && this._catalog.FAMILIES[family];
    return fromCatalog || FAMILY_FALLBACK[family] || family;
  }

  adapter(route) {
    return this.configStore.providers[route.provider] || null;
  }

  // Availability of a route: needs its provider configured, and — when the
  // provider needs a public video URL — a configured media relay too.
  availability(route) {
    const adapter = this.adapter(route);
    if (!adapter) return { available: false, unavailableCode: 'no_credentials', needsRelay: false };
    const configured = this.configStore.isConfigured(route.provider);
    const needsRelay = !!adapter.meta.needsPublicVideoUrl;
    if (!configured) return { available: false, unavailableCode: 'no_credentials', needsRelay };
    if (needsRelay && !this.configStore.resolveMediaRelay()) {
      return { available: false, unavailableCode: 'no_media_relay', needsRelay };
    }
    return { available: true, unavailableCode: null, needsRelay };
  }

  // The default route id: config.defaults.routeId if it is available, else the
  // first available route in UI order, else null.
  defaultRouteId() {
    const preferred = this.configStore.config.defaults.routeId;
    if (preferred && this.byId.has(preferred) && this.availability(this.byId.get(preferred)).available) {
      return preferred;
    }
    for (const route of this.routes) {
      if (this.availability(route).available) return route.id;
    }
    return null;
  }

  // Route views for GET /api/animate/status.
  routeViews() {
    return this.routes.map(route => {
      const adapter = this.adapter(route);
      const providerLabel = adapter ? adapter.meta.label : route.provider;
      const { available, unavailableCode, needsRelay } = this.availability(route);
      return {
        id: route.id,
        provider: route.provider,
        providerLabel,
        family: route.family,
        familyLabel: this.familyLabel(route.family),
        label: route.label,
        options: route.options || [],
        limits: route.limits || null,
        pricing: route.pricing || null,
        keepsImageBackground: route.keepsImageBackground ?? null,
        verified: route.verified !== false,
        docs: route.docs || null,
        needsRelay,
        available,
        unavailableCode,
      };
    });
  }

  // Build the provider request body for a route using catalog.buildRequest when
  // available; otherwise a minimal fallback so the mock route works before W2
  // lands buildRequest. Adapters wrap this as their protocol needs.
  buildRequest(route, input) {
    if (this._catalog && typeof this._catalog.buildRequest === 'function') {
      return this._catalog.buildRequest(route, input);
    }
    return fallbackBuildRequest(route, input);
  }

  // The USD estimate for a route at a given sent length + options, or null.
  estimateUsd(route, sentSeconds, options = {}) {
    const pricing = route.pricing;
    if (!pricing) return null;
    let rate = pricing.usdPerSecond;
    if (pricing.byOption) {
      for (const [optKey, table] of Object.entries(pricing.byOption)) {
        const chosen = options[optKey];
        if (chosen != null && table[chosen] != null) rate = table[chosen];
      }
    }
    if (!Number.isFinite(rate)) return null;
    let seconds = Number(sentSeconds) || 0;
    // Routes billed per started second (Wan 2.2 Animate 2) round up before the floor.
    if (pricing.roundUpSeconds) seconds = Math.ceil(seconds - 1e-9);
    seconds = Math.max(pricing.minSeconds || 0, seconds);
    return Number((rate * seconds).toFixed(4));
  }
}

// Minimal buildRequest used only until W2's catalog.buildRequest exists. Sets
// image/video/prompt/orientation/sound/options at their dotted field paths,
// then params. Mirrors the spec's contract closely enough for the mock route.
function fallbackBuildRequest(route, input) {
  const body = {};
  const fields = route.fields || {};
  if (fields.image) setPath(body, fields.image, input.imageUrl);
  if (fields.video) setPath(body, fields.video, input.videoUrl);
  if (fields.prompt && input.prompt != null) setPath(body, fields.prompt, input.prompt);
  if (fields.motionPrompt && input.motionPrompt != null) setPath(body, fields.motionPrompt, input.motionPrompt);
  if (fields.orientation && input.orientation) {
    const map = fields.orientation;
    if (map.field) setPath(body, map.field, input.orientation);
  }
  if (fields.sound && 'off' in fields.sound) setPath(body, fields.sound.field, fields.sound.off);
  for (const option of route.options || []) {
    const chosen = input.options && input.options[option.key];
    const value = (option.values && Array.isArray(option.values) && option.values.includes(chosen))
      ? chosen
      : (chosen != null && option.values == null ? chosen : option.default);
    if (value != null && option.field) setPath(body, option.field, value);
  }
  for (const [key, value] of Object.entries(route.params || {})) setPath(body, key, value);
  return body;
}

function setPath(target, dottedPath, value) {
  const parts = String(dottedPath).split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] == null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

module.exports = { Registry, MOCK_ROUTE };
