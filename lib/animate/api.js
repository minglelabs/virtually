'use strict';

// HTTP routes for the "동작 만들기" page (/api/animate/*). server.js owns the
// library, SSE, the character store and shared request helpers and passes
// them in; this module owns the animate state: provider config, routes,
// driving videos and jobs. A job is made from one character photo (the
// request's photoId, resolved through getPhoto). See README.md "API" for the
// endpoint list.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { createFileDocs } = require('../docs');
const presetsModule = require('./presets');
const media = require('./media');
const { chooseKeyColor } = require('./key-color');
const { cutOutBackground } = require('./cutout');
const { measureFit } = require('./fit');
const margins = require('./margin');
const { ConfigStore, customRoutesFromEnv, legacyFilesNotice } = require('./config');
const { Registry, isFreeRoute } = require('./registry');
const { Pipeline, TERMINAL, referenceMaxSec, promptFor, motionPromptFor, jobPhotoId, providerTaskStarted } = require('./pipeline');
const { DrivingStore, EXAMPLE_ID_RE, UPLOAD_ID_RE } = require('./drivings');
const { characterError } = require('../characters');
const { IDLE_MOTION_NAME } = require('../idle');
const { createBackgroundAi } = require('./background-ai');
const realProviders = require('./providers');
const mockProvider = require('./providers/mock');

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

// What every account shares: the server's provider keys and settings (environment
// variables, see config.js), the model routes and which providers exist. Accounts
// never see or change these; their jobs and driving videos live in their own
// workspace (createAnimateApi below). `config` / `customRoutes` / `env` replace the
// environment (tests); nothing in the server passes them.
// `backgroundAi` replaces the paid AI background removers (tests).
async function createAnimateShared({ dataDir, mock = false, config, customRoutes, env = process.env, backgroundAi = null, log = message => console.warn(message) }) {
  const providers = { ...realProviders };
  if (mock) providers.mock = mockProvider;
  const notice = await legacyFilesNotice(path.join(dataDir, 'animate'), providers);
  if (notice) log(notice);
  const configStore = new ConfigStore(providers, { config, env });
  const registry = await new Registry(configStore, {
    customRoutes: customRoutes || customRoutesFromEnv(env, log),
    mockEnabled: mock,
  }).load();
  return { providers, configStore, registry, backgroundAi };
}

// How a step is wanted in a request: false (left out), 'ai' (the paid remover) or true (the free local method).
function stepChoice(value) {
  return value === false ? false : value === 'ai' ? 'ai' : true;
}

async function createAnimateApi(deps) {
  const {
    dataDir, docs = createFileDocs(), mediaDir, ffmpegPath, ffprobePath, mock = false, pollIntervalMs = null,
    examplesManifestPath, allowHttpExamples = false, bundledDrivingsDir = null,
    // The downloaded examples every account shares (drivings.js); null: this workspace's own.
    sharedExamplesDir = null,
    getLibrary, mediaPathForItem, enqueue, save, broadcast, getPhoto,
    // async (characterId, photoId) => { path, called }: the photo's AI cutout (workspace.js).
    aiCutout = null,
    sendJson, readBody, receiveFile, serveMedia, sanitizeName,
    // lib/billing (optional): charges paid jobs and refunds failed/canceled ones.
    billing = null,
    // createAnimateShared(): given, the provider keys and routes are shared with
    // other workspaces; without it this API makes its own from dataDir.
    shared = null,
  } = deps;

  const animateDir = path.join(dataDir, 'animate');
  await fsp.mkdir(animateDir, { recursive: true });

  const { providers, configStore, registry } = shared || await createAnimateShared({ dataDir, mock });
  const drivings = await new DrivingStore({
    dataDir, docs, manifestPath: examplesManifestPath, ffmpegPath, ffprobePath, allowHttpExamples,
    bundledDir: bundledDrivingsDir, examplesDir: sharedExamplesDir,
  }).init();

  // --- credit refunds ----------------------------------------------------------
  // On any problem the credits come back; a delivered result is paid once. A
  // charged job gets its credits back once per charge (the ledger is idempotent
  // by charge) when it ends failed, canceled by the provider itself (nothing was
  // delivered), or canceled before any provider task could exist. A user's own
  // cancel after that stays paid: the local cancel does not stop the submitted
  // task, which keeps running and is billed. A succeeded job never gets them
  // back. Runs in the background from the pipeline's change hook: errors are
  // logged and never touch the job itself.
  const refunds = new Map(); // charge id -> in-flight refund
  function refundable(job) {
    if (!job.billing || !job.billing.chargeId || job.billing.refunded) return false;
    if (job.state === 'failed') return true;
    if (job.state !== 'canceled') return false;
    return (job.error && job.error.provider === true) || !providerTaskStarted(job);
  }
  function refundIfEnded(job) {
    if (!billing || !refundable(job)) return null;
    const { chargeId } = job.billing;
    if (!refunds.has(chargeId)) {
      const run = (async () => {
        const refunded = await billing.refundJob({ jobId: job.id, chargeId });
        if (refunded) await pipeline.setBillingRefunded(job.id, chargeId);
      })().catch(error => {
        console.warn(`[billing] refund job ${job.id} failed: ${error.message}`);
      }).finally(() => refunds.delete(chargeId));
      refunds.set(chargeId, run);
    }
    return refunds.get(chargeId);
  }

  // --- 다시 받기 charges ---------------------------------------------------------
  // A re-fetch delivers the result the job was charged for. When that charge
  // was given back (the job failed), the credits are taken again before the
  // re-fetch starts, so the result is paid once; a job whose charge was kept
  // (canceled after its task existed) and billing off
  // take nothing.

  // The credits of a job's charge that was given back, or is on its way back
  // (a failed job's refund lands a moment after the failure); 0 for none.
  function givenBackCredits(job) {
    const record = job.billing;
    if (!record || !record.chargeId) return 0;
    if (record.refunded !== true && !refundable(job)) return 0;
    return Number.isSafeInteger(record.credits) && record.credits > 0 ? record.credits : 0;
  }

  // view.billing.refetchCredits (the pipeline only asks for refetchable jobs):
  // what a 다시 받기 would take now, whoever asks.
  function refetchCredits(job) {
    return billing && billing.mode() === 'enabled' ? givenBackCredits(job) : 0;
  }

  // The pipeline's prepare hook for 다시 받기, run once the job is known to be
  // refetchable: takes the credits again when its charge was given back.
  // -> the job's new billing record + the charge, or null when nothing is taken.
  async function rechargeForRefetch(job, access) {
    if (!billing || !job.billing) return null;
    // A refund of this charge may still be landing: decide once it has.
    const pending = job.billing.chargeId ? refunds.get(job.billing.chargeId) : null;
    if (pending) await pending;
    const record = job.billing;
    if (record.refunded !== true) return null;
    const credits = givenBackCredits(job);
    if (!credits) return null;
    const charge = await billing.rechargeJob({
      access, jobId: job.id, credits, label: `${job.routeLabel} · ${job.drivingLabel} · 다시 받기`,
    });
    if (!charge) return null;
    return {
      charge,
      billing: { ...record, sub: charge.sub, email: charge.email, chargeId: charge.chargeId, refunded: false },
    };
  }

  // The paid AI background removers; `shared.backgroundAi` replaces them in tests.
  const backgroundAi = (shared && shared.backgroundAi) || createBackgroundAi({ providers, configStore, ffmpegPath, ffprobePath });

  // Step 3's own charge (job.keyCharge): kept once the AI removal succeeded, given back when
  // the job ends any other way (the generation failed or was canceled, or the AI removal
  // failed and the free key ran instead). Decided once.
  const keySettling = new Set();
  function settleKeyCharge(job) {
    const taken = job.keyCharge;
    if (!billing || !taken || !taken.chargeId || taken.refunded || taken.settled || !TERMINAL.has(job.state) || keySettling.has(job.id)) return null;
    keySettling.add(job.id);
    const delivered = job.state === 'succeeded' && job.result && job.result.keyed && job.result.keyed.method === 'ai';
    return (async () => {
      if (delivered) return pipeline.setKeyCharge(job.id, { settled: true });
      const refunded = await billing.refundJob({ jobId: job.id, chargeId: taken.chargeId });
      return pipeline.setKeyCharge(job.id, { settled: true, refunded: refunded === true });
    })().catch(error => console.warn(`[billing] AI key charge of job ${job.id}: ${error.message}`)).finally(() => keySettling.delete(job.id));
  }

  const pipeline = new Pipeline({
    dataDir, docs, ffmpegPath, ffprobePath, registry, configStore, pollIntervalMs, backgroundAi,
    instanceId: shared && shared.instanceId, restoreFile: shared && shared.restoreFile,
    onChange: (job, info) => {
      broadcast({ type: 'animate-job', job: pipeline.view(job) });
      // Another server runs it (a redeploy's overlap): its credits are that server's business.
      if (info && info.foreign) return;
      refundIfEnded(job);
      settleKeyCharge(job);
    },
    refetchCredits,
  });
  await pipeline.init();
  // Jobs that ended while the server was down (or whose refund was cut short).
  await Promise.all(pipeline.list().map(job => refundIfEnded(job)));
  await Promise.all(pipeline.list().map(job => settleKeyCharge(job)));

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

  // --- status ----------------------------------------------------------------
  async function status() {
    const probe = await probeFfmpeg();
    return {
      ffmpeg: { available: probe.available, reason: probe.reason },
      routes: registry.routeViews(),
      margins: margins.marginViews(),
      providers: configStore.providerViews(),
      config: configStore.publicConfig(),
      // { available, imageUsd, videoUsdPerSecond, videoMinSeconds }: the paid AI background removers.
      backgroundAi: backgroundAi.view(),
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

  async function createJob(body, access = null) {
    if (!body || typeof body !== 'object') throw apiError(400, 'bad_request', 'Body must be a JSON object.');
    const route = typeof body.routeId === 'string' ? registry.get(body.routeId) : null;
    if (!route) throw apiError(400, 'unknown_route', 'Unknown model route.');
    if (body.margin != null && !margins.isMargin(body.margin)) {
      throw apiError(400, 'bad_margin', 'margin must be none, normal or wide.');
    }
    const margin = body.margin != null ? body.margin : margins.defaultMarginFor(route);
    const availability = registry.availability(route);
    if (!availability.available) {
      throw apiError(400, 'route_unavailable', 'This model route is not available.', { unavailableCode: availability.unavailableCode });
    }
    await requireFfmpeg();
    // The character photo; the pipeline copies its file, so deleting the photo later does not change the job.
    const photo = typeof body.photoId === 'string' ? getPhoto(body.photoId) : null;
    if (!photo || !fs.existsSync(photo.path)) throw characterError('photo_missing', 400);
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
    // Every route but the free one (registry.isFreeRoute, shown as the route view's `free`) is paid.
    const free = isFreeRoute(route);
    if (!free && body.confirmed !== true) {
      throw apiError(400, 'not_confirmed', 'Confirm the paid generation first.');
    }
    const options = cleanOptions(route, body.options);
    // Steps 1 and 3 by the paid AI remover, only when asked for (`cutPhoto` / `keyResult`: 'ai').
    const wantCut = stepChoice(body.cutPhoto);
    const wantKey = stepChoice(body.keyResult);
    if ((wantCut === 'ai' || wantKey === 'ai') && !backgroundAi.available()) {
      throw apiError(400, 'background_ai_unavailable', 'AI 배경 제거 설정이 서버에 없습니다.');
    }
    // Each step is its own charge, so a step that fails gives back its own credits:
    //   1 the photo's AI cutout: charged where it is made (workspace.js), once per photo;
    //   2 the generation: the job's charge (job.billing), as before;
    //   3 the result's AI background removal: job.keyCharge, given back unless it succeeds.
    const aiCut = wantCut === 'ai' && photo.photo.hasAlpha !== true && aiCutout
      ? await aiCutout(photo.character.id, photo.photo.id, access) : null;
    const estimateUsd = registry.estimateUsd(route, duration, options);
    // Paid routes cost credits while billing is on: the balance check and the
    // debit happen here, after every other check and before the job exists.
    // null = billing off (the job then carries no billing record).
    const jobId = crypto.randomUUID();
    const charge = billing && !free
      ? await billing.chargeJob({ access, jobId, estimateUsd, label: `${route.label} · ${driving.label}` })
      : null;
    let keyCharge = null;
    if (wantKey === 'ai' && billing) {
      try {
        const taken = await billing.chargeJob({ access, jobId: `key-${jobId}`, estimateUsd: backgroundAi.videoUsd(duration), label: `AI 영상 배경 제거 · ${driving.label}` });
        if (taken && taken.chargeId) keyCharge = { chargeId: taken.chargeId, credits: taken.credits, refunded: false, settled: false };
      } catch (error) {
        // Not enough for step 3: the generation's credits go back and nothing starts.
        if (charge && charge.chargeId) await billing.refundJob({ jobId, chargeId: charge.chargeId }).catch(() => {});
        throw error;
      }
    }
    // An opaque character photo (no alpha, e.g. generated art on white) gets its
    // plain background cut out first, so the key colour surrounds the character
    // instead of the image's own background (cutout.js). Photos/scenes stay as-is.
    let characterPath = photo.path;
    let characterCutout = null;
    const cutPath = path.join(animateDir, `character-cutout.${crypto.randomUUID()}.png`);
    let job;
    // The job's three steps, as the page shows them: 1 photo -> transparent, 2 the AI
    // generation, 3 result video -> transparent. 1 and 3 run here on the server (no
    // outside service) and can be left out with cutPhoto: false / keyResult: false.
    // steps.cut: 'done' | 'own' (the photo is transparent already) | 'skipped' (left
    // out) | 'not_plain' (its background is not one colour, so it is sent as it is).
    // cutMethod / keyMethod: 'ai' when the paid remover does the step.
    const steps = { cut: 'skipped', key: wantKey !== false, ...(wantKey === 'ai' ? { keyMethod: 'ai' } : {}) };
    try {
      const cut = wantCut === false || aiCut ? null : await cutOutBackground(ffmpegPath, ffprobePath, photo.path, cutPath).catch(() => null);
      if (aiCut) {
        characterPath = aiCut.path;
        characterCutout = { color: null, method: 'ai' };
        steps.cut = 'done';
        steps.cutMethod = 'ai';
      } else if (cut && cut.cut) {
        characterPath = cutPath;
        characterCutout = { color: cut.color, share: cut.share };
        steps.cut = 'done';
      } else if (wantCut !== false) {
        steps.cut = cut && cut.reason === 'has_alpha' ? 'own' : 'not_plain';
      }
      // The chroma-key colour for this job, from the (cut-out) character photo; an
      // unreadable image falls back to green (the composite then reports it).
      const chosen = await chooseKeyColor(ffmpegPath, characterPath).catch(() => null);
      const keyColor = chosen ? { name: chosen.name, hex: chosen.hex } : null;
      job = await pipeline.create({
        id: jobId,
        route,
        driving,
        characterPath,
        photoId: photo.photo.id,
        characterId: photo.character.id,
        characterLabel: photo.character.name,
        idle: driving.idle === true,
        options,
        orientation,
        prompt: promptFor(route, driving.presetKey, configStore.config.promptSuffix, keyColor),
        motionPrompt: motionPromptFor(route, driving.presetKey),
        estimateUsd,
        keyColor,
        margin,
        characterCutout,
        steps,
        keyCharge,
        billing: charge,
      });
    } catch (error) {
      // No job came of it: the credits go straight back.
      for (const taken of [charge, keyCharge]) {
        if (!taken || !taken.chargeId) continue;
        await billing.refundJob({ jobId, chargeId: taken.chargeId })
          .catch(refundError => console.warn(`[billing] refund job ${jobId} failed: ${refundError.message}`));
      }
      throw error;
    } finally {
      await fsp.rm(cutPath, { force: true }).catch(() => {});
    }
    return pipeline.view(job);
  }

  function findLibraryMotion(id) {
    return id ? getLibrary().motions.find(item => item.id === id) || null : null;
  }

  // Copy a succeeded job's result into the library as a motion of the job's
  // photo: the keyed transparent WebM when there is one (keyed on demand for
  // older jobs), else the MP4 as is, with keyed:false + keyReason saying why.
  async function addAsMotion(job, body) {
    if (job.state !== 'succeeded' || !fs.existsSync(pipeline.resultPath(job.id))) {
      throw apiError(409, 'not_ready', 'The result is not ready.');
    }
    if (findLibraryMotion(job.motionId)) {
      throw apiError(409, 'already_added', 'This result is already in the motion list.', { motionId: job.motionId });
    }
    // Older jobs name their photo in characterId (null: made from the old idle image).
    // A motion always belongs to one photo.
    const photoId = jobPhotoId(job);
    if (!photoId || !getPhoto(photoId)) throw characterError('photo_missing', 409);
    // A job made without step 3 is added as it is (배경 제거하기 keys it later on request).
    const wantsKey = !(job.steps && job.steps.key === false);
    if (wantsKey && (!fs.existsSync(pipeline.keyedPath(job.id)) || !(job.result && job.result.keyed))) {
      await pipeline.ensureKeyed(job.id);
    }
    const keyed = !!(job.result && job.result.keyed) && fs.existsSync(pipeline.keyedPath(job.id));
    // The character box of the keyed WebM (jobs keyed before fit existed are measured now).
    if (keyed && !('fit' in job.result)) await pipeline.ensureFit(job.id);
    const fit = keyed ? (job.result.fit !== undefined ? job.result.fit : await measureFit(ffmpegPath, ffprobePath, pipeline.keyedPath(job.id))) : null;
    const keyReason = keyed ? null : (job.result && job.result.keySkipped) || 'key_failed';
    const sourcePath = keyed ? pipeline.keyedPath(job.id) : pipeline.resultPath(job.id);
    const preset = presetsModule.getPreset(job.presetKey);
    const requested = body && typeof body.name === 'string' && body.name.trim() ? body.name : null;
    // A result made from an idle loop is the photo's default idle (lib/idle.js).
    const name = sanitizeName(requested || (job.idle ? IDLE_MOTION_NAME : preset ? preset.label : job.drivingLabel));
    const id = crypto.randomUUID();
    const item = {
      id, name, kind: 'motion', mime: keyed ? 'video/webm' : 'video/mp4', url: `/api/media/${id}`,
      createdAt: new Date().toISOString(), photoId, source: { jobId: job.id, ...(job.idle ? { idle: true } : {}) }, fit,
    };
    const target = mediaPathForItem(item);
    let committed = false;
    try {
      await enqueue(async () => {
        const existing = findLibraryMotion(job.motionId);
        if (existing) throw apiError(409, 'already_added', 'This result is already in the motion list.', { motionId: existing.id });
        // Photo deletions run in this queue too, so this check cannot go stale.
        if (!getPhoto(photoId)) throw characterError('photo_missing', 409);
        await fsp.copyFile(sourcePath, target);
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
    return { motion: item, job: pipeline.view(job), keyed, keyReason };
  }

  // POST .../key: run background removal again for a finished result. When the
  // result is already in the motion list, that motion gets the new transparent clip
  // (same id and name, so its buttons keep working).
  async function rekeyJob(job, { method = null, access = null } = {}) {
    if (job.state !== 'succeeded' || !fs.existsSync(pipeline.resultPath(job.id))) {
      throw apiError(409, 'not_ready', 'The result is not ready.');
    }
    if (method === 'ai' && !backgroundAi.available()) throw apiError(400, 'background_ai_unavailable', 'AI 배경 제거 설정이 서버에 없습니다.');
    // The AI remover on its own is paid by the result's length; a failure gives the credits back.
    const paid = method === 'ai' && billing
      ? await billing.chargeJob({ access, jobId: `ai-${crypto.randomUUID()}`, estimateUsd: backgroundAi.videoUsd(job.result && job.result.duration), label: `AI 영상 배경 제거 · ${job.drivingLabel}` })
      : null;
    await pipeline.rekey(job.id, { method: method === 'ai' ? 'ai' : 'color' });
    if (paid && paid.chargeId && !(job.result && job.result.keyed && job.result.keyed.method === 'ai')) {
      await billing.refundJob({ jobId: job.id, chargeId: paid.chargeId }).catch(error => console.warn(`[billing] refund failed: ${error.message}`));
    }
    const keyed = !!(job.result && job.result.keyed) && fs.existsSync(pipeline.keyedPath(job.id));
    let motion = null;
    if (keyed && findLibraryMotion(job.motionId)) {
      await enqueue(async () => {
        const existing = findLibraryMotion(job.motionId);
        if (!existing) return;
        const next = { ...existing, mime: 'video/webm', fit: job.result.fit ?? null };
        const oldPath = mediaPathForItem(existing);
        const newPath = mediaPathForItem(next);
        const tmp = `${newPath}.${crypto.randomUUID()}.tmp`;
        try {
          await fsp.copyFile(pipeline.keyedPath(job.id), tmp);
          await fsp.rename(tmp, newPath);
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => {});
        }
        const library = getLibrary();
        await save({ ...library, motions: library.motions.map(item => (item.id === existing.id ? next : item)) });
        if (oldPath !== newPath) await fsp.rm(oldPath, { force: true }).catch(() => {});
        motion = next;
      });
    }
    const keyReason = keyed ? null : (job.result && job.result.keySkipped) || 'key_failed';
    return { job: pipeline.view(job), keyed, keyReason, motion };
  }

  // POST .../refetch ('다시 받기'): fetch a failed or canceled job's result again
  // from its saved provider task, without submitting again (nothing new at the
  // provider). A job whose charge was given back is charged again first, from
  // the asking account (402 insufficient_credits / 503 billing_misconfigured
  // leave the job as it was).
  async function refetchJob(job, access) {
    let taken = null; // the charge made for this re-fetch, while it may still need undoing
    let refetched;
    try {
      refetched = await pipeline.refetch(job.id, {
        prepare: async current => {
          const recharge = await rechargeForRefetch(current, access);
          if (!recharge) return null;
          taken = recharge.charge;
          return { billing: recharge.billing };
        },
      });
    } catch (error) {
      if (taken) await giveBackRecharge(job.id, taken);
      if (error.code === 'not_refetchable') throw apiError(409, 'not_refetchable', error.message);
      if (error.code === 'job_missing') throw apiError(404, 'job_missing', 'Job not found.');
      throw error;
    }
    if (!refetched) {
      if (taken) await giveBackRecharge(job.id, taken);
      throw apiError(404, 'job_missing', 'Job not found.');
    }
    return pipeline.view(refetched);
  }

  // The re-fetch that a charge was taken for did not start: the credits go straight back.
  async function giveBackRecharge(jobId, charge) {
    await billing.refundJob({ jobId, chargeId: charge.chargeId })
      .catch(error => console.warn(`[billing] refund job ${jobId} failed: ${error.message}`));
  }

  // --- request handler -------------------------------------------------------
  // Returns true when the request was handled. `access` is the auth gate's
  // verdict ({ mode, via, session }); paid job creation charges its session.
  async function handle(req, res, url, access = null) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/animate/')) return false;
    const method = req.method;
    const isRead = method === 'GET' || method === 'HEAD';

    if (pathname === '/api/animate/status' && method === 'GET') {
      sendJson(res, 200, await status());
      return true;
    }

    // The server's provider keys are not editable here (no bring-your-own-key):
    // they come from the provider env vars.

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
      sendJson(res, 202, { job: await createJob(body, access) });
      return true;
    }
    const jobMatch = /^\/api\/animate\/jobs\/([^/]+)(?:\/(cancel|result|poster|motion|key|refetch))?$/.exec(pathname);
    if (jobMatch) {
      const id = jobMatch[1];
      const sub = jobMatch[2];
      const job = JOB_ID_RE.test(id) ? pipeline.get(id) : null;
      if (!job) throw apiError(404, 'job_missing', 'Job not found.');
      if (!sub && method === 'GET') {
        sendJson(res, 200, pipeline.view(job));
        return true;
      }
      if (!sub && method === 'DELETE') {
        // Once the credits of a failed job are on their way back, they are not lost with the record.
        if (refundable(job) || (job.billing && refunds.has(job.billing.chargeId))) throw apiError(409, 'job_busy', '크레딧 환불이 끝난 뒤에 지울 수 있습니다. 잠시 후 다시 시도해 주세요.');
        if (!(await pipeline.remove(id))) throw apiError(409, 'job_active', '진행 중인 작업입니다. 먼저 취소해 주세요.');
        broadcast({ type: 'animate-job-removed', id });
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (sub === 'cancel' && method === 'POST') {
        if (!TERMINAL.has(job.state)) await pipeline.cancel(id);
        sendJson(res, 200, pipeline.view(job));
        return true;
      }
      if (sub === 'result' && isRead) {
        if (url.searchParams.get('variant') === 'keyed') {
          if (job.state !== 'succeeded' || !fs.existsSync(pipeline.keyedPath(id))) throw apiError(404, 'not_ready', 'No keyed result.');
          await serveMedia(req, res, pipeline.keyedPath(id), 'video/webm');
          return true;
        }
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
      if (sub === 'key' && method === 'POST') {
        // { "method": "ai" }: the paid AI remover instead of the free colour key.
        const body = await readBody(req).catch(error => { if (error.status !== 400) throw error; });
        sendJson(res, 200, await rekeyJob(job, { method: body && body.method === 'ai' ? 'ai' : null, access }));
        return true;
      }
      if (sub === 'refetch' && method === 'POST') {
        sendJson(res, 200, await refetchJob(job, access));
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

  return { handle, close, requireFfmpeg, pipeline, drivings, registry, configStore, backgroundAi };
}

module.exports = { createAnimateApi, createAnimateShared, DRIVING_MAX_BYTES };
