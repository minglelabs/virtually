'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const providers = require('../lib/animate/providers');
const { ConfigStore, customRoutesFromEnv, legacyFilesNotice } = require('../lib/animate/config');
const { createAnimateShared } = require('../lib/animate/api');
const { DEFAULT_PROMPT_SUFFIX } = require('../lib/animate/presets');

test('settings come from the ANIMATE_* variables, defaults for what is unset or unusable', () => {
  const none = new ConfigStore(providers, { env: {} }).config;
  assert.equal(none.defaults.routeId, null);
  assert.equal(none.mediaRelay, 'auto');
  assert.equal(none.concurrency, 2);
  assert.equal(none.promptSuffix, DEFAULT_PROMPT_SUFFIX);

  const set = new ConfigStore(providers, {
    env: { ANIMATE_DEFAULT_ROUTE: ' wavespeed/wan-2.2-animate-2 ', ANIMATE_MEDIA_RELAY: 'fal', ANIMATE_CONCURRENCY: '3', ANIMATE_PROMPT_SUFFIX: 'No zoom.' },
  }).config;
  assert.equal(set.defaults.routeId, 'wavespeed/wan-2.2-animate-2');
  assert.equal(set.mediaRelay, 'fal');
  assert.equal(set.concurrency, 3);
  assert.equal(set.promptSuffix, 'No zoom.');

  for (const bad of ['0', '5', '2.5', 'many', '']) {
    assert.equal(new ConfigStore(providers, { env: { ANIMATE_CONCURRENCY: bad } }).config.concurrency, 2, `ANIMATE_CONCURRENCY=${bad}`);
  }
  // An empty suffix is a choice (no suffix); only an unset variable keeps the default.
  assert.equal(new ConfigStore(providers, { env: { ANIMATE_PROMPT_SUFFIX: '' } }).config.promptSuffix, '');
});

test('provider keys come from the adapters\' own variables; a key never shows in the views', () => {
  const store = new ConfigStore(providers, { env: { WAVESPEED_API_KEY: 'ws-key-not-real-1234' } });
  assert.equal(store.isConfigured('wavespeed'), true);
  assert.equal(store.isConfigured('fal'), false);
  assert.equal(store.resolveMediaRelay(), 'wavespeed');
  assert.equal(JSON.stringify([store.providerViews(), store.publicConfig()]).includes('ws-key-not-real'), false);
  assert.equal(new ConfigStore(providers, { env: {} }).isConfigured('wavespeed'), false);
});

test('ANIMATE_CUSTOM_ROUTES: a JSON array is taken, anything else is reported and ignored', () => {
  const logs = [];
  const log = line => logs.push(line);
  assert.deepEqual(customRoutesFromEnv({}, log), []);
  assert.deepEqual(customRoutesFromEnv({ ANIMATE_CUSTOM_ROUTES: '  ' }, log), []);
  assert.deepEqual(customRoutesFromEnv({ ANIMATE_CUSTOM_ROUTES: '[{"id":"a/b"}]' }, log), [{ id: 'a/b' }]);
  assert.equal(logs.length, 0);
  assert.deepEqual(customRoutesFromEnv({ ANIMATE_CUSTOM_ROUTES: '{"id":"a/b"}' }, log), []);
  assert.deepEqual(customRoutesFromEnv({ ANIMATE_CUSTOM_ROUTES: 'not json' }, log), []);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => line.includes('ANIMATE_CUSTOM_ROUTES')));
});

test('the old animate/config.json is not read, and the server says which variables replace it (names only)', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-config-'));
  try {
    const animateDir = path.join(dataDir, 'animate');
    assert.equal(await legacyFilesNotice(animateDir, providers), null);

    await fs.mkdir(animateDir, { recursive: true });
    await fs.writeFile(path.join(animateDir, 'config.json'), JSON.stringify({
      version: 1,
      providers: { wavespeed: { apiKey: 'ws-key-not-real-1234' }, kling: { accessKey: 'kl-access-not-real', region: 'cn' }, gone: { apiKey: 'x' } },
      defaults: { routeId: 'wavespeed/wan-2.2-animate-2', options: {} },
      mediaRelay: 'auto', concurrency: 3, promptSuffix: DEFAULT_PROMPT_SUFFIX,
    }));
    await fs.writeFile(path.join(animateDir, 'custom-routes.json'), '[]');

    const notice = await legacyFilesNotice(animateDir, providers);
    for (const name of ['WAVESPEED_API_KEY', 'KLING_ACCESS_KEY', 'KLING_REGION', 'ANIMATE_DEFAULT_ROUTE', 'ANIMATE_CONCURRENCY', 'ANIMATE_CUSTOM_ROUTES']) {
      assert.ok(notice.includes(name), `${name} in: ${notice}`);
    }
    // Defaults that need no variable, an unknown provider, and every value stay out of it.
    for (const absent of ['ANIMATE_MEDIA_RELAY', 'ANIMATE_PROMPT_SUFFIX', 'ws-key-not-real', 'kl-access-not-real', 'wavespeed/wan']) {
      assert.equal(notice.includes(absent), false, `${absent} in: ${notice}`);
    }

    // Reported at startup, and the key in the file does not configure anything.
    const logs = [];
    const shared = await createAnimateShared({ dataDir, env: {}, log: line => logs.push(line) });
    assert.deepEqual(logs, [notice]);
    assert.equal(shared.configStore.isConfigured('wavespeed'), false);
    assert.equal(shared.configStore.config.concurrency, 2);

    await fs.writeFile(path.join(animateDir, 'config.json'), '{ not json');
    assert.match(await legacyFilesNotice(animateDir, providers), /config\.json is no longer read \(set its values as environment variables\)/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('createAnimateShared takes custom routes from the environment, validated', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-config-'));
  try {
    const route = { id: 'mock/extra', provider: 'mock', family: 'other', label: 'Extra', endpoint: 'mock', fields: { image: 'image', video: 'video', prompt: null, orientation: null, sound: null }, params: {}, options: [], limits: { videoMinSec: 1, videoMaxSec: 30, imageMaxPx: 1920, imageMinPx: 64, aspectMin: 0.2, aspectMax: 5 }, pricing: null, verified: true };
    const shared = await createAnimateShared({ dataDir, mock: true, env: { ANIMATE_CUSTOM_ROUTES: JSON.stringify([route, { id: 'broken' }]) }, log: () => {} });
    assert.ok(shared.registry.get('mock/extra'));
    assert.equal(shared.registry.get('broken'), null);
    // Passing routes explicitly (tests) wins over the variable.
    const explicit = await createAnimateShared({ dataDir, mock: true, customRoutes: [], env: { ANIMATE_CUSTOM_ROUTES: JSON.stringify([route]) }, log: () => {} });
    assert.equal(explicit.registry.get('mock/extra'), null);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
