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
const V1_ID = 'wavespeed/wan-2.2-animate';
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
  assert.equal(FAMILIES['wan-animate'], 'Wan 2.2 Animate (v1)');

  const registry = await new Registry(waveSpeedOnlyStore()).load();
  assert.equal(registry.list()[0].id, A2_ID);
  assert.equal(registry.defaultRouteId(), A2_ID);
  const view = registry.routeViews()[0];
  assert.equal(view.familyLabel, 'Wan 2.2 Animate 2');
  assert.equal(view.keepsImageBackground, false);
  assert.equal(registry.routeViews().find(v => v.id === V1_ID).familyLabel, 'Wan 2.2 Animate (v1)');
});

test('v1 WaveSpeed Animate body is unchanged (mode + composed prompt, no motion_prompt)', () => {
  const body = bodyFor(route(V1_ID), 'hi', undefined);
  assert.deepEqual(body, {
    image: 'https://cdn.example/char.png',
    video: 'https://cdn.example/ref.mp4',
    prompt: `The character waves hello with one hand and smiles warmly. ${presets.DEFAULT_PROMPT_SUFFIX}`,
    resolution: '720p',
    mode: 'animate',
  });
  // Byte-identical key order to the pre-Animate-2 builder.
  assert.equal(JSON.stringify(body), JSON.stringify({
    image: 'https://cdn.example/char.png',
    video: 'https://cdn.example/ref.mp4',
    prompt: `The character waves hello with one hand and smiles warmly. ${presets.DEFAULT_PROMPT_SUFFIX}`,
    resolution: '720p',
    mode: 'animate',
  }));
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
  // v1 keeps fractional billing.
  assert.equal(registry.estimateUsd(route(V1_ID), 3.4, { resolution: '720p' }), 0.272);
});

test('the page estimate mirrors the Animate 2 round-up', () => {
  const page = require('../public/animate.js');
  const r = route(A2_ID);
  assert.equal(page.estimateUsd(r, 2.5, { resolution: '720p' }), 0.24);
  assert.equal(page.estimateUsd(r, 3.0, { resolution: '720p' }), 0.24);
  assert.equal(page.estimateUsd(r, 3.4, { resolution: '720p' }), 0.32);
  assert.equal(page.estimateUsd(r, 2.5, { resolution: '480p' }), 0.12);
  assert.equal(page.estimateUsd(route(V1_ID), 3.4, { resolution: '720p' }), 0.272);
});
