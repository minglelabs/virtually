'use strict';

// HTTP routes for the "동작 만들기" page (/api/animate/*). server.js owns the
// library, SSE and shared request helpers and passes them in; this module owns
// the animate state: provider config, routes, the character image, driving
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
const realProviders = require('./providers');
const mockProvider = require('./providers/mock');

const CHARACTER_MAX_BYTES = 20 * 1024 * 1024;
const DRIVING_MAX_BYTES = 200 * 1024 * 1024;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHARACTER_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

function apiError(status, code, message, detail) {
  return Object.assign(new Error(message), { status, code, detail });
}

function requireJson(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw apiError(415, 'expected_json', 'Expected application/json.');
  }
}

// The image type from its first bytes: '.png' | '.jpg' | '.webp' | null.
async function sniffImage(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, 12, 0);
    if (bytesRead >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (bytesRead >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
    if (bytesRead >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    return null;
  } finally {
    await handle.close();
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

  // --- character -------------------------------------------------------------
  const characterMetaPath = path.join(animateDir, 'character.json');
  const idleInfoCache = new Map(); // idle id -> { width, height, hasAlpha }

  async function uploadedCharacter() {
    let meta;
    try { meta = JSON.parse(await fsp.readFile(characterMetaPath, 'utf8')); } catch { return null; }
    if (!meta || !CHARACTER_TYPES[meta.ext]) return null;
    const filePath = path.join(animateDir, `character${meta.ext}`);
    if (!fs.existsSync(filePath)) return null;
    return { ...meta, path: filePath, mime: CHARACTER_TYPES[meta.ext] };
  }

  // { source, path, mime, filename, width, height, hasAlpha } or null. An
  // uploaded image wins; otherwise the library's PNG/WebP idle image.
  async function resolveCharacter() {
    const uploaded = await uploadedCharacter();
    if (uploaded) return { source: 'upload', ...uploaded };
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
    return { source: 'idle', path: filePath, mime: idle.mime, filename: `${idle.name}${ext}`, ...info };
  }

  function characterView(character) {
    if (!character) return null;
    return {
      source: character.source,
      filename: character.filename || null,
      width: character.width ?? null,
      height: character.height ?? null,
      hasAlpha: character.hasAlpha ?? null,
      url: '/api/animate/character/image',
    };
  }

  async function removeCharacterFiles() {
    await fsp.rm(characterMetaPath, { force: true }).catch(() => {});
    for (const ext of Object.keys(CHARACTER_TYPES)) {
      await fsp.rm(path.join(animateDir, `character${ext}`), { force: true }).catch(() => {});
    }
  }

  let characterMutation = Promise.resolve();
  function characterLock(callback) {
    const next = characterMutation.then(callback);
    characterMutation = next.catch(() => {});
    return next;
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

    // Character
    if (pathname === '/api/animate/character' && method === 'POST') {
      const declared = Number(req.headers['content-length']);
      if (declared > CHARACTER_MAX_BYTES) throw apiError(413, 'too_large', 'Image exceeds 20 MB.');
      const tmpPath = path.join(animateDir, `character-upload.${crypto.randomUUID()}.tmp`);
      try {
        await receiveFile(req, tmpPath, CHARACTER_MAX_BYTES, 'Image exceeds 20 MB.');
        const ext = await sniffImage(tmpPath);
        if (!ext) throw apiError(415, 'unsupported_type', 'Upload a PNG, JPEG or WebP image.');
        const probed = await media.probeVideo(ffprobePath, tmpPath).catch(() => null);
        const originalName = url.searchParams.get('name') || '';
        const meta = {
          ext,
          filename: String(path.basename(originalName)).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) || `character${ext}`,
          width: probed ? probed.width : null,
          height: probed ? probed.height : null,
          hasAlpha: probed ? !!probed.hasAlpha : null,
          uploadedAt: new Date().toISOString(),
        };
        await characterLock(async () => {
          await removeCharacterFiles();
          await fsp.rename(tmpPath, path.join(animateDir, `character${ext}`));
          await fsp.writeFile(characterMetaPath, JSON.stringify(meta, null, 2) + '\n');
        });
        sendJson(res, 201, characterView(await resolveCharacter()));
      } finally {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
      return true;
    }
    if (pathname === '/api/animate/character' && method === 'DELETE') {
      await characterLock(removeCharacterFiles);
      sendJson(res, 200, { character: characterView(await resolveCharacter()) });
      return true;
    }
    if (pathname === '/api/animate/character/image' && isRead) {
      const character = await resolveCharacter();
      if (!character) throw apiError(404, 'character_missing', 'No character image.');
      await serveMedia(req, res, character.path, character.mime);
      return true;
    }

    // Driving videos
    if (pathname === '/api/animate/drivings' && method === 'GET') {
      sendJson(res, 200, { drivings: await drivings.list() });
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
      sendJson(res, 200, { drivings: await drivings.list(), results });
      return true;
    }
    const drivingMatch = /^\/api\/animate\/drivings\/([^/]+)(?:\/(video|poster))?$/.exec(pathname);
    if (drivingMatch) {
      const id = drivingMatch[1];
      const sub = drivingMatch[2];
      if (!EXAMPLE_ID_RE.test(id) && !UPLOAD_ID_RE.test(id)) throw apiError(404, 'driving_missing', 'Driving video not found.');
      if (!sub && method === 'DELETE') {
        const removed = await drivings.removeUpload(id);
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

  return { handle, close, pipeline, drivings, registry, configStore };
}

module.exports = { createAnimateApi, sniffImage, CHARACTER_MAX_BYTES, DRIVING_MAX_BYTES };
