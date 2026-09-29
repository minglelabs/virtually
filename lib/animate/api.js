'use strict';

// HTTP routes for the "동작 만들기" page (/api/animate/*). server.js owns the
// library, SSE and shared request helpers and passes them in; this module owns
// the animate state: provider config, routes, the character library, driving
// videos and jobs. See README.md "API" for the endpoint list.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const presetsModule = require('./presets');
const media = require('./media');
const { ConfigStore } = require('./config');
const { Registry, MOCK_ROUTE } = require('./registry');
const { Pipeline, TERMINAL, referenceMaxSec, promptFor } = require('./pipeline');
const { DrivingStore, EXAMPLE_ID_RE, UPLOAD_ID_RE } = require('./drivings');
const { CharacterStore, sniffImage, CHARACTER_ID_RE } = require('./characters');
const realProviders = require('./providers');
const mockProvider = require('./providers/mock');

const CHARACTER_MAX_BYTES = 20 * 1024 * 1024;
const DRIVING_MAX_BYTES = 200 * 1024 * 1024;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function apiError(status, code, message, detail) {
  return Object.assign(new Error(message), { status, code, detail });
}

function requireJson(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw apiError(415, 'expected_json', 'Expected application/json.');
  }
}

async function createAnimateApi(deps) {
  const {
    dataDir, mediaDir, ffmpegPath, ffprobePath, mock = false, pollIntervalMs = null,
    examplesManifestPath, allowHttpExamples = false,
    getLibrary, mediaPathForItem, enqueue, save, broadcast,
    sendJson, readBody, receiveFile, serveMedia, sanitizeName,
  } = deps;

  const animateDir = path.join(dataDir, 'animate');
  await fsp.mkdir(animateDir, { recursive: true });

  const providers = { ...realProviders };
  if (mock) providers.mock = mockProvider;
  const configStore = await new ConfigStore(path.join(animateDir, 'config.json'), providers).load();
  const registry = await new Registry(configStore, {
    customRoutesPath: path.join(animateDir, 'custom-routes.json'),
    mockEnabled: mock,
  }).load();
  const drivings = await new DrivingStore({
    dataDir, manifestPath: examplesManifestPath, ffmpegPath, ffprobePath, allowHttpExamples,
  }).init();
  const pipeline = new Pipeline({
    dataDir, ffmpegPath, ffprobePath, registry, configStore, pollIntervalMs,
    onChange: job => broadcast({ type: 'animate-job', job: pipeline.view(job) }),
  });
  await pipeline.init();

  // --- ffmpeg availability ---------------------------------------------------
  let ffmpegProbe = null;
  async function probeFfmpeg() {
    if (ffmpegProbe) return ffmpegProbe;
    try {
      const version = await media.run(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 15000 });
      if (version.code !== 0) throw new Error('ffmpeg did not run.');
      const probe = await media.run(ffprobePath, ['-hide_banner', '-version'], { timeoutMs: 15000 });
      if (probe.code !== 0) throw new Error('ffprobe did not run.');
      const encoders = await media.run(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
      if (!/\blibx264\b/.test(encoders.stdout.toString())) throw new Error('ffmpeg lacks the libx264 encoder.');
      ffmpegProbe = { available: true, reason: null };
    } catch (error) {
      ffmpegProbe = { available: false, reason: error.code === 'ENOENT' ? 'ffmpeg or ffprobe was not found.' : (error.message || 'ffmpeg is unavailable.') };
    }
    return ffmpegProbe;
  }
  async function requireFfmpeg() {
    if (!(await probeFfmpeg()).available) throw apiError(400, 'ffmpeg_unavailable', 'ffmpeg is not available on this server.');
  }

  // --- character ------------------------------------------------------------
  const characters = await new CharacterStore({ animateDir, ffprobePath }).init();
  const idleInfoCache = new Map(); // idle id -> { width, height, hasAlpha }

  // The library's PNG/WebP idle image, used while no character is uploaded.
  async function idleCharacter() {
    const idle = getLibrary().idle;
    if (!idle || !['image/png', 'image/webp'].includes(idle.mime)) return null;
    const filePath = mediaPathForItem(idle);
    if (!fs.existsSync(filePath)) return null;
    let info = idleInfoCache.get(idle.id);
    if (!info) {
      const probed = await media.probeVideo(ffprobePath, filePath).catch(() => null);
      info = { width: probed ? probed.width : null, height: probed ? probed.height : null, hasAlpha: probed ? !!probed.hasAlpha : null };
      if (probed) idleInfoCache.set(idle.id, info);
    }
    const ext = idle.mime === 'image/png' ? '.png' : '.webp';
    return { source: 'idle', id: null, path: filePath, mime: idle.mime, filename: `${idle.name}${ext}`, ...info };
  }

  // { source, id, path, mime, filename, width, height, hasAlpha } or null. The
  // selected library character wins; otherwise the idle image.
  async function resolveCharacter() {
    const selected = characters.selected();
    if (selected) return { source: 'upload', ...selected };
    return idleCharacter();
  }

  // The status/legacy shape of the character in use.
  function characterView(character) {
    if (!character) return null;
    return {
      source: character.source,
      id: character.id || null,
      filename: character.filename || null,
      width: character.width ?? null,
      height: character.height ?? null,
      hasAlpha: character.hasAlpha ?? null,
      url: character.source === 'upload' ? `/api/animate/characters/${character.id}/image` : '/api/animate/character/image',
    };
  }

  // Stream a raw image body to a temp file and add it to the library.
  async function receiveCharacter(req, url) {
    const declared = Number(req.headers['content-length']);
    if (declared > CHARACTER_MAX_BYTES) throw apiError(413, 'too_large', 'Image exceeds 20 MB.');
    const tmpPath = path.join(animateDir, `character-upload.${crypto.randomUUID()}.tmp`);
    try {
      await receiveFile(req, tmpPath, CHARACTER_MAX_BYTES, 'Image exceeds 20 MB.');
      return await characters.add(tmpPath, url.searchParams.get('name') || '');
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  // --- status ----------------------------------------------------------------
  async function status() {
    const probe = await probeFfmpeg();
    return {
      ffmpeg: { available: probe.available, reason: probe.reason },
      routes: registry.routeViews(),
      providers: configStore.providerViews(),
      config: configStore.publicConfig(),
      character: characterView(await resolveCharacter()),
    };
  }

  // --- jobs ------------------------------------------------------------------
  function cleanOptions(route, raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const option of route.options || []) {
      const value = raw[option.key];
      if (value == null) continue;
      if (Array.isArray(option.values)) {
        if (option.values.includes(value)) out[option.key] = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        out[option.key] = value;
      }
    }
    return out;
  }

  async function createJob(body) {
    if (!body || typeof body !== 'object') throw apiError(400, 'bad_request', 'Body must be a JSON object.');
    const route = typeof body.routeId === 'string' ? registry.get(body.routeId) : null;
    if (!route) throw apiError(400, 'unknown_route', 'Unknown model route.');
    const availability = registry.availability(route);
    if (!availability.available) {
      throw apiError(400, 'route_unavailable', 'This model route is not available.', { unavailableCode: availability.unavailableCode });
    }
    await requireFfmpeg();
    const character = await resolveCharacter();
    if (!character) throw apiError(400, 'character_missing', 'Upload a character image first.');
    const driving = typeof body.drivingId === 'string' ? await drivings.get(body.drivingId) : null;
    if (!driving) throw apiError(400, 'driving_missing', 'Unknown driving video.');
    if (!driving.available) throw apiError(400, 'driving_unavailable', 'The example video has not been downloaded yet.');
    const preset = presetsModule.getPreset(driving.presetKey);
    const orientation = preset ? preset.orientation : 'image';
    const maxSec = referenceMaxSec(route, orientation);
    const duration = Number(driving.duration) || 0;
    if (maxSec != null && duration > maxSec + 0.05) {
      throw apiError(400, 'driving_too_long', `This model accepts driving videos up to ${maxSec} s.`, { maxSec, duration });
    }
    const minSec = route.limits ? route.limits.videoMinSec : null;
    if (minSec != null && duration < minSec - 0.05) {
      throw apiError(400, 'driving_too_short', `This model needs a driving video of at least ${minSec} s.`, { minSec, duration });
    }
    if (route.id !== MOCK_ROUTE.id && body.confirmed !== true) {
      throw apiError(400, 'not_confirmed', 'Confirm the paid generation first.');
    }
    const options = cleanOptions(route, body.options);
    const job = await pipeline.create({
      route,
      driving,
      characterPath: character.path,
      characterId: character.id || null,
      characterLabel: character.filename || null,
      options,
      orientation,
      prompt: promptFor(route, driving.presetKey, configStore.config.promptSuffix),
      estimateUsd: registry.estimateUsd(route, duration, options),
    });
    return pipeline.view(job);
  }

  function findLibraryMotion(id) {
    return id ? getLibrary().motions.find(item => item.id === id) || null : null;
  }

  // Copy a succeeded job's result into the library as an MP4 motion.
  async function addAsMotion(job, body) {
    if (job.state !== 'succeeded' || !fs.existsSync(pipeline.resultPath(job.id))) {
      throw apiError(409, 'not_ready', 'The result is not ready.');
    }
    const preset = presetsModule.getPreset(job.presetKey);
    const requested = body && typeof body.name === 'string' && body.name.trim() ? body.name : null;
    const name = sanitizeName(requested || (preset ? preset.label : job.drivingLabel));
    const id = crypto.randomUUID();
    const item = {
      id, name, kind: 'motion', mime: 'video/mp4', url: `/api/media/${id}`,
      createdAt: new Date().toISOString(), source: { jobId: job.id },
    };
    const target = mediaPathForItem(item);
    let committed = false;
    try {
      await enqueue(async () => {
        const existing = findLibraryMotion(job.motionId);
        if (existing) throw apiError(409, 'already_added', 'This result is already in the motion list.', { motionId: existing.id });
        await fsp.copyFile(pipeline.resultPath(job.id), target);
        const library = getLibrary();
        await save({ ...library, motions: [...library.motions, item] });
        committed = true;
        job.motionId = id; // claimed before the queue moves on; persisted below
      });
    } catch (error) {
      if (!committed) await fsp.rm(target, { force: true }).catch(() => {});
      throw error;
    }
    await pipeline.setMotion(job.id, id, name);
    return { motion: item, job: pipeline.view(job) };
  }

  // --- request handler -------------------------------------------------------
  // Returns true when the request was handled.
  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/animate/')) return false;
    const method = req.method;
    const isRead = method === 'GET' || method === 'HEAD';

    if (pathname === '/api/animate/status' && method === 'GET') {
      sendJson(res, 200, await status());
      return true;
    }

    if (pathname === '/api/animate/config' && method === 'PUT') {
      requireJson(req);
      const body = await readBody(req);
      await configStore.applyPatch(body);
      await registry.load();
      sendJson(res, 200, { providers: configStore.providerViews(), config: configStore.publicConfig(), routes: registry.routeViews() });
      return true;
    }

    const providerTest = /^\/api\/animate\/providers\/([^/]+)\/test$/.exec(pathname);
    if (providerTest && method === 'POST') {
      const id = providerTest[1];
      const adapter = providers[id];
      if (!adapter) throw apiError(404, 'unknown_provider', 'Unknown provider.');
      if (typeof adapter.test !== 'function') throw apiError(501, 'not_testable', 'This provider has no key test.');
      if (!configStore.isConfigured(id)) throw apiError(400, 'no_credentials', 'Provider is not configured.');
      try {
        const result = await adapter.test({
          credentials: configStore.resolvedCredentials(id), settings: configStore.resolvedSettings(id),
          fetch: (...args) => fetch(...args), baseUrl: configStore.baseUrl(id), signal: undefined, log: () => {},
          allowInsecure: configStore.allowInsecure(id),
        });
        sendJson(res, 200, { ok: !!(result && result.ok), detail: (result && result.detail) || null });
      } catch (error) {
        sendJson(res, 200, { ok: false, detail: String(error.message || 'Test failed.').slice(0, 240) });
      }
      return true;
    }

    // Character library
    if (pathname === '/api/animate/characters' && method === 'GET') {
      sendJson(res, 200, characters.listView());
      return true;
    }
    if (pathname === '/api/animate/characters' && method === 'POST') {
      const character = await receiveCharacter(req, url);
      sendJson(res, 201, { character, ...characters.listView() });
      return true;
    }
    const characterMatch = /^\/api\/animate\/characters\/([^/]+)(?:\/(select|image))?$/.exec(pathname);
    if (characterMatch) {
      const id = characterMatch[1];
      const sub = characterMatch[2];
      // Malformed ids are refused before any lookup or path use.
      if (!CHARACTER_ID_RE.test(id)) throw apiError(404, 'character_missing', 'Character not found.');
      if (sub === 'select' && method === 'POST') {
        requireJson(req);
        await readBody(req);
        sendJson(res, 200, await characters.select(id));
        return true;
      }
      if (!sub && method === 'DELETE') {
        sendJson(res, 200, await characters.remove(id));
        return true;
      }
      if (sub === 'image' && isRead) {
        const record = characters.get(id);
        if (!record || !fs.existsSync(record.path)) throw apiError(404, 'character_missing', 'Character not found.');
        await serveMedia(req, res, record.path, record.mime);
        return true;
      }
    }

    // Legacy single-character aliases (kept for older clients).
    if (pathname === '/api/animate/character' && method === 'POST') {
      await receiveCharacter(req, url);
      sendJson(res, 201, characterView(await resolveCharacter()));
      return true;
    }
    if (pathname === '/api/animate/character' && method === 'DELETE') {
      const selected = characters.selected();
      if (selected) await characters.remove(selected.id).catch(error => { if (error.code !== 'character_missing') throw error; });
      sendJson(res, 200, { character: characterView(await resolveCharacter()) });
      return true;
    }
    if (pathname === '/api/animate/character/image' && isRead) {
      const character = await resolveCharacter();
      if (!character || !fs.existsSync(character.path)) throw apiError(404, 'character_missing', 'No character image.');
      await serveMedia(req, res, character.path, character.mime);
      return true;
    }

    // Driving videos
    if (pathname === '/api/animate/drivings' && method === 'GET') {
      sendJson(res, 200, { drivings: await drivings.list(), hiddenExamples: drivings.hiddenCount() });
      return true;
    }
    if (pathname === '/api/animate/drivings' && method === 'POST') {
      await requireFfmpeg();
      const declared = Number(req.headers['content-length']);
      if (declared > DRIVING_MAX_BYTES) throw apiError(413, 'too_large', 'Video exceeds 200 MB.');
      const tmpPath = path.join(drivings.uploadsDir, `upload.${crypto.randomUUID()}.tmp`);
      try {
        await receiveFile(req, tmpPath, DRIVING_MAX_BYTES, 'Video exceeds 200 MB.');
        sendJson(res, 201, await drivings.addUpload(tmpPath, url.searchParams.get('name') || ''));
      } finally {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
      return true;
    }
    if (pathname === '/api/animate/examples/fetch' && method === 'POST') {
      requireJson(req);
      await readBody(req).catch(error => { if (error.status !== 400) throw error; });
      await requireFfmpeg();
      const results = await drivings.fetchExamples();
      sendJson(res, 200, { drivings: await drivings.list(), hiddenExamples: drivings.hiddenCount(), results });
      return true;
    }
    if (pathname === '/api/animate/examples/restore' && method === 'POST') {
      requireJson(req);
      await readBody(req).catch(error => { if (error.status !== 400) throw error; });
      await drivings.restoreExamples();
      sendJson(res, 200, { drivings: await drivings.list(), hidden: [] });
      return true;
    }
    const drivingMatch = /^\/api\/animate\/drivings\/([^/]+)(?:\/(video|poster))?$/.exec(pathname);
    if (drivingMatch) {
      const id = drivingMatch[1];
      const sub = drivingMatch[2];
      if (!EXAMPLE_ID_RE.test(id) && !UPLOAD_ID_RE.test(id)) throw apiError(404, 'driving_missing', 'Driving video not found.');
      if (!sub && method === 'DELETE') {
        // An upload is deleted; an example is hidden for this install.
        const removed = await drivings.remove(id);
        if (!removed) throw apiError(404, 'driving_missing', 'Driving video not found.');
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (sub && isRead) {
        const record = await drivings.get(id);
        if (!record || !record.available) throw apiError(404, 'driving_missing', 'Driving video not found.');
        if (sub === 'video') await serveMedia(req, res, record.videoPath, record.mime);
        else await serveMedia(req, res, record.posterPath, 'image/jpeg');
        return true;
      }
    }

    // Jobs
    if (pathname === '/api/animate/jobs' && method === 'GET') {
      sendJson(res, 200, { jobs: pipeline.list().map(job => pipeline.view(job)) });
      return true;
    }
    if (pathname === '/api/animate/jobs' && method === 'POST') {
      requireJson(req);
      const body = await readBody(req);
      sendJson(res, 202, { job: await createJob(body) });
      return true;
    }
    const jobMatch = /^\/api\/animate\/jobs\/([^/]+)(?:\/(cancel|result|poster|motion))?$/.exec(pathname);
    if (jobMatch) {
      const id = jobMatch[1];
      const sub = jobMatch[2];
      const job = JOB_ID_RE.test(id) ? pipeline.get(id) : null;
      if (!job) throw apiError(404, 'job_missing', 'Job not found.');
      if (!sub && method === 'GET') {
        sendJson(res, 200, pipeline.view(job));
        return true;
      }
      if (sub === 'cancel' && method === 'POST') {
        if (!TERMINAL.has(job.state)) await pipeline.cancel(id);
        sendJson(res, 200, pipeline.view(job));
        return true;
      }
      if (sub === 'result' && isRead) {
        if (job.state !== 'succeeded' || !fs.existsSync(pipeline.resultPath(id))) throw apiError(404, 'not_ready', 'No result yet.');
        await serveMedia(req, res, pipeline.resultPath(id), 'video/mp4');
        return true;
      }
      if (sub === 'poster' && isRead) {
        if (job.state !== 'succeeded' || !fs.existsSync(pipeline.posterPath(id))) throw apiError(404, 'not_ready', 'No poster yet.');
        await serveMedia(req, res, pipeline.posterPath(id), 'image/jpeg');
        return true;
      }
      if (sub === 'motion' && method === 'POST') {
        requireJson(req);
        const body = await readBody(req);
        sendJson(res, 201, await addAsMotion(job, body));
        return true;
      }
    }

    sendJson(res, 404, { error: 'Not found.' });
    return true;
  }

  async function close() {
    drivings.close();
    await pipeline.close();
  }

  return { handle, close, pipeline, drivings, characters, registry, configStore };
}

module.exports = { createAnimateApi, sniffImage, CHARACTER_MAX_BYTES, DRIVING_MAX_BYTES };
