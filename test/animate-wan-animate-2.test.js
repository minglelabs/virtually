'use strict';

// Wan 2.2 Animate 2 (WaveSpeed): split prompt body, default-route placement and
// whole-second billing. No network: bodies are built and priced locally.

const assert = require('node:assert/strict');
const test = require('node:test');

const { ROUTES, FAMILIES, buildRequest } = require('../lib/animate/catalog');
const { Registry } = require('../lib/animate/registry');
const { promptFor, motionPromptFor } = require('../lib/animate/pipeline');
const presets = require('../lib/animate/presets');

const A2_ID = 'wavespeed/wan-2.2-animate-2';
const BACKGROUND = 'Background description: plain solid pure green (#00FF00) chroma-key background, '
  + 'flat even lighting, no shadows, no objects, no text.';
const CAMERA = ' Static camera, no zoom, no camera movement.';

const route = id => ROUTES.find(r => r.id === id);

// Build the body the way api.createJob + pipeline._submit do.
function bodyFor(r, presetKey, promptSuffix, options = {}) {
  return buildRequest(r, {
    imageUrl: 'https://cdn.example/char.png',
    videoUrl: 'https://cdn.example/ref.mp4',
    prompt: promptFor(r, presetKey, promptSuffix),
    motionPrompt: motionPromptFor(r, presetKey),
    orientation: 'image',
    options,
  });
}

// A config-store stand-in where only WaveSpeed has a key.
function waveSpeedOnlyStore() {
  const providers = require('../lib/animate/providers');
  return {
    providers,
    config: { defaults: { routeId: null } },
    isConfigured: id => id === 'wavespeed',
    resolveMediaRelay: () => null,
  };
}

test('Animate 2 body for a preset driving is exact', () => {
  const body = bodyFor(route(A2_ID), 'hi', 'CUSTOM SUFFIX MUST BE IGNORED');
  assert.deepEqual(body, {
    image: 'https://cdn.example/char.png',
    video: 'https://cdn.example/ref.mp4',
    prompt: BACKGROUND,
    motion_prompt: `The character waves hello with one hand and smiles warmly.${CAMERA}`,
    resolution: '720p',
  });
  assert.equal('mode' in body, false);
  assert.equal(JSON.stringify(Object.keys(body).sort()),
    JSON.stringify(['image', 'motion_prompt', 'prompt', 'resolution', 'video']));
  console.log(`Animate 2 body (preset hi): ${JSON.stringify(body)}`);
});

test('Animate 2 body for a preset-less upload uses the generic motion prompt', () => {
  const body = bodyFor(route(A2_ID), null, undefined, { resolution: '480p' });
  assert.deepEqual(body, {
    image: 'https://cdn.example/char.png',
    video: 'https://cdn.example/ref.mp4',
    prompt: BACKGROUND,
    motion_prompt: `${presets.GENERIC_PROMPT}${CAMERA}`,
    resolution: '480p',
  });
  assert.equal(body.motion_prompt.includes(presets.DEFAULT_PROMPT_SUFFIX), false);
  console.log(`Animate 2 body (upload, 480p): ${JSON.stringify(body)}`);
});

test('Animate 2 is the first route/family and the default with only a WaveSpeed key', async () => {
  assert.equal(ROUTES[0].id, A2_ID);
  assert.equal(Object.keys(FAMILIES)[0], 'wan-animate-2');
  assert.equal(FAMILIES['wan-animate-2'], 'Wan 2.2 Animate 2');

  const registry = await new Registry(waveSpeedOnlyStore()).load();
  assert.equal(registry.list()[0].id, A2_ID);
  assert.equal(registry.defaultRouteId(), A2_ID);
  const view = registry.routeViews()[0];
  assert.equal(view.familyLabel, 'Wan 2.2 Animate 2');
  assert.equal(view.keepsImageBackground, false);
});

test('Wan 2.2 Animate v1 is gone: no wan-animate family, route or DashScope provider', async () => {
  const { FAMILY_FALLBACK } = require('../lib/animate/registry');
  assert.equal('wan-animate' in FAMILIES, false);
  assert.equal('wan-animate' in FAMILY_FALLBACK, false);
  assert.deepEqual(ROUTES.filter(r => r.family === 'wan-animate').map(r => r.id), []);
  for (const id of ['wavespeed/wan-2.2-animate', 'fal/wan-2.2-animate-move',
    'replicate/wan-2.2-animate-animation', 'dashscope/wan2.2-animate-move']) {
    assert.equal(route(id), undefined, id);
  }
  const providers = require('../lib/animate/providers');
  assert.equal('dashscope' in providers, false);
  assert.equal(ROUTES.some(r => r.provider === 'dashscope'), false);
  // Every remaining route's provider still has an adapter.
  for (const r of ROUTES) assert.ok(providers[r.provider], `${r.id} has an adapter`);
  const registry = await new Registry(waveSpeedOnlyStore()).load();
  assert.equal(registry.routeViews().some(v => v.family === 'wan-animate'), false);
});

test('no route other than Animate 2 gets a motion prompt or a fixed background prompt', () => {
  for (const r of ROUTES) {
    if (r.id === A2_ID) continue;
    assert.equal(motionPromptFor(r, 'hi'), null, r.id);
    assert.equal(r.backgroundPrompt, undefined, r.id);
    if (r.pricing) assert.equal(r.pricing.roundUpSeconds, undefined, r.id);
  }
});

test('Animate 2 estimates round up to whole seconds with a 3 s floor', async () => {
  const registry = await new Registry(waveSpeedOnlyStore()).load();
  const r = route(A2_ID);
  assert.equal(registry.estimateUsd(r, 2.5, { resolution: '720p' }), 0.24);
  assert.equal(registry.estimateUsd(r, 3.0, { resolution: '720p' }), 0.24);
  assert.equal(registry.estimateUsd(r, 3.4, { resolution: '720p' }), 0.32);
  assert.equal(registry.estimateUsd(r, 2.5, { resolution: '480p' }), 0.12);
  // Routes without roundUpSeconds keep fractional billing.
  assert.equal(registry.estimateUsd({ pricing: { usdPerSecond: 0.08, minSeconds: 3 } }, 3.4), 0.272);
});

test('the page estimate mirrors the Animate 2 round-up', () => {
  const page = require('../public/animate.js');
  const r = route(A2_ID);
  assert.equal(page.estimateUsd(r, 2.5, { resolution: '720p' }), 0.24);
  assert.equal(page.estimateUsd(r, 3.0, { resolution: '720p' }), 0.24);
  assert.equal(page.estimateUsd(r, 3.4, { resolution: '720p' }), 0.32);
  assert.equal(page.estimateUsd(r, 2.5, { resolution: '480p' }), 0.12);
  assert.equal(page.estimateUsd({ pricing: { usdPerSecond: 0.08, minSeconds: 3 } }, 3.4), 0.272);
});

test('settings saved before the v1 removal load and fall back to the first available route', async () => {
  const { ConfigStore } = require('../lib/animate/config');
  const providers = require('../lib/animate/providers');
  const store = new ConfigStore(providers, {
    env: {},
    config: {
      providers: { dashscope: { apiKey: 'old-dashscope-key-5678' }, wavespeed: { apiKey: 'ws-key-not-real-1234' } },
      defaults: { routeId: 'wavespeed/wan-2.2-animate', options: {} },
    },
  });
  assert.equal(store.isConfigured('dashscope'), false);
  assert.equal(store.providerViews().some(v => v.id === 'dashscope'), false);
  const registry = await new Registry(store).load();
  assert.equal(registry.get('wavespeed/wan-2.2-animate'), null);
  assert.equal(registry.defaultRouteId(), A2_ID);
});

test('Animate 2 crops the image to the driving shape, so the photo is sent in that shape with the same margin', () => {
  const { computeGeometry } = require('../lib/animate/media');
  const { marginFactor } = require('../lib/animate/margin');
  assert.equal(route(A2_ID).imageFollowsDriving, true);
  for (const r of ROUTES) if (r.id !== A2_ID) assert.equal(r.imageFollowsDriving, undefined, r.id);
  assert.deepEqual([marginFactor('none'), marginFactor('normal'), marginFactor('wide'), marginFactor('?')], [0, 0.12, 0.25, 0]);
  // A tall 302x706 photo and a 396x900 driving clip padded by 'normal' (612x1008): the
  // photo gets the top margin too (0.12 x 706), is widened to the clip's shape and stands on the bottom edge.
  const normal = computeGeometry(302, 706, {}, { aspect: 612 / 1008, marginFactor: 0.12 });
  assert.deepEqual(normal, { canvas: { w: 302, h: 706 }, sent: { w: 480, h: 790 }, content: { x: 89, y: 84, w: 302, h: 706 } });
  assert.ok(Math.abs(normal.sent.w / normal.sent.h - 612 / 1008) < 0.01);
  // A wide photo for a tall clip: the room goes above it.
  const wide = computeGeometry(1000, 600, {}, { aspect: 0.5, marginFactor: 0 });
  assert.deepEqual([wide.sent, wide.content], [{ w: 1000, h: 2000 }, { x: 0, y: 1400, w: 1000, h: 600 }]);
  // Without a frame nothing changes.
  assert.deepEqual(computeGeometry(302, 706, {}), { canvas: { w: 302, h: 706 }, sent: { w: 302, h: 706 }, content: { x: 0, y: 0, w: 302, h: 706 } });
});
