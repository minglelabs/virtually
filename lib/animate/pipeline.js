'use strict';

// The persisted animate job engine. One job takes a driving video + the
// character image through:
//   queued -> preparing -> submitting -> running -> downloading -> keying
//   -> succeeded (or failed / canceled)
// preparing  composite the character onto a canvas of the job's key colour
//            (job.keyColor, chosen at creation from the character image by
//            key-color.js; green when absent) sized for the route
//            and trim/re-encode the driving video (reference.mp4)
// submitting upload both inputs (or relay the video) and submit ONCE; the
//            provider task is persisted before polling starts
// running    poll the provider until a terminal state
// downloading fetch the generated clip into result.mp4 and make a poster
// keying     detect the solid key-colour background and key it out into a
//            transparent result.webm (key.js). Never fails the job: when the
//            background is not one key colour, or ffmpeg fails, the MP4 is
//            kept and job.result.keyed = null records why. A keyed result's
//            character box is measured into job.result.fit (fit.js; null
//            when not keyed).
//
// job.margin ('none' | 'normal' | 'wide', margin.js) pads the reference clip
// on the left, right and top in `preparing`.
//
// Each job lives in <dataDir>/animate/jobs/<id>/job.json. After a restart,
// queued/preparing jobs start again, running/downloading jobs with a stored
// task resume polling (a poll never costs anything), and a job interrupted
// mid-submit becomes failed/interrupted so it is never submitted twice.
//
// '다시 받기' (refetch): a failed or canceled job whose task was saved goes
// back to `running` and polls that same task again -> download -> key, never
// uploading or submitting (nothing new at the provider). canRefetch() holds the
// rule. With credits on, the animate API first takes a refunded job's credits
// again (refetch's prepare hook): a delivered result is paid once.
//
// A job created while credit billing was on carries job.billing (the charge
// record from lib/billing); the animate API gives the credits back when the
// job ends failed, canceled by the provider, or canceled before a provider
// task could exist (see providerTaskStarted: a local cancel does not stop a
// submitted task, which keeps running and is billed), and records that with
// setBillingRefunded().

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { createFileDocs } = require('../docs');
const crypto = require('node:crypto');

const presetsModule = require('./presets');
const media = require('./media');
const key = require('./key');
const plainCut = require('./plain-cut');
const keyColors = require('./key-color');
const { measureFit } = require('./fit');
const margins = require('./margin');

const MAX_JOBS = 50;
const GENERATION_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_ERRORS = 10;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATES = ['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying', 'succeeded', 'failed', 'canceled'];
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const ACTIVE = new Set(['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying']);
// Fields that only live in memory.
const TRANSIENT = new Set(['_pending', '_started', '_uploaded']);

const ERROR_CODES = new Set([
  'no_credentials', 'no_media_relay', 'driving_missing', 'driving_too_short', 'character_missing',
  'upload_failed', 'submit_failed', 'generation_failed', 'moderation', 'timeout', 'download_failed',
  'result_expired', 'interrupted', 'canceled',
]);

// A download refused with one of these means the provider no longer has the file.
const EXPIRED_STATUSES = new Set([403, 404, 410]);

function aborted() {
  return Object.assign(new Error('Canceled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

class Pipeline {
  // deps: { dataDir, ffmpegPath, ffprobePath, registry, configStore,
  //         pollIntervalMs?, onChange?(job) }
  constructor(deps) {
    this.deps = deps;
    this.docs = deps.docs || createFileDocs();
    this.jobsDir = path.join(deps.dataDir, 'animate', 'jobs');
    this.jobs = new Map();
    this.controllers = new Map();
    this.runs = new Map(); // job id -> promise of its latest _run
    this.refetching = new Map(); // job id -> in-flight refetch()
    this.running = 0;
    this.pollIntervalMs = deps.pollIntervalMs || null;
    this.keying = new Map(); // job id -> in-flight on-demand key promise
    this._closed = false;
  }

  concurrency() {
    return this.deps.configStore.config.concurrency || 2;
  }

  jobDir(id) { return path.join(this.jobsDir, id); }
  jobDocPath(id) { return path.join(this.jobDir(id), 'job.json'); }
  resultPath(id) { return path.join(this.jobDir(id), 'result.mp4'); }
  keyedPath(id) { return path.join(this.jobDir(id), 'result.webm'); }
  posterPath(id) { return path.join(this.jobDir(id), 'poster.jpg'); }

  async init() {
    await fsp.mkdir(this.jobsDir, { recursive: true });
    await this._resumeFromDisk();
    // Keyed jobs from before fit measurement: measured in the background,
    // never blocking startup.
    this.fitBackfill = this._backfillFits();
    return this;
  }

  async _backfillFits() {
    await new Promise(resolve => setImmediate(resolve));
    for (const job of [...this.jobs.values()]) {
      if (this._closed) return;
      if (job.state !== 'succeeded' || !job.result || !job.result.keyed || 'fit' in job.result) continue;
      await this.ensureFit(job.id).catch(() => {});
    }
  }

  // --- persistence -----------------------------------------------------------

  async _writeJob(job) {
    // The job's files (result.mp4 ...) live in its directory; the record itself in the doc store.
    await fsp.mkdir(this.jobDir(job.id), { recursive: true });
    const persisted = {};
    for (const [key, value] of Object.entries(job)) if (!TRANSIENT.has(key)) persisted[key] = value;
    await this.docs.write(this.jobDocPath(job.id), persisted);
  }

  async _touch(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    // First arrival in a terminal state = when the job finished (the page shows
    // finishedAt - createdAt as the job's working time). Later touches keep it.
    if (TERMINAL.has(job.state) && !job.finishedAt) job.finishedAt = job.updatedAt;
    if (!this.jobs.has(job.id)) return; // evicted or deleted meanwhile
    await this._writeJob(job);
    if (this.deps.onChange) {
      try { this.deps.onChange(job); } catch { /* a listener must not break the job */ }
    }
  }

  async _resumeFromDisk() {
    // A database that cannot be listed must stop the start: continuing would drop running jobs.
    const entries = await this.docs.children(this.jobsDir);
    const loaded = [];
    for (const id of entries) {
      try {
        const raw = await this.docs.read(this.jobDocPath(id));
        if (raw && raw.id === id) loaded.push(raw);
      } catch (error) {
        if (this.docs.kind !== 'file' && !(error instanceof SyntaxError)) throw error;
        /* skip unreadable */
      }
    }
    loaded.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const job of loaded) {
      // Jobs that succeeded before finishedAt was recorded: result.mp4 is written
      // when the clip is downloaded and never rewritten, so its mtime is the finish
      // time within the few seconds keying takes. updatedAt is no use (later edits).
      if (job.state === 'succeeded' && !job.finishedAt) {
        try { job.finishedAt = fs.statSync(this.resultPath(job.id)).mtime.toISOString(); } catch { /* no result file */ }
      }
    }
    for (const job of loaded) this.jobs.set(job.id, job);
    for (const job of loaded) {
      if (TERMINAL.has(job.state)) continue;
      if (job.state === 'queued' || job.state === 'preparing') {
        this._enterQueue(job, { fromStart: true });
      } else if (job.state === 'keying' && job.result && fs.existsSync(this.resultPath(job.id))) {
        this._enterQueue(job, { resumeKeying: true });
      } else if ((job.state === 'running' || job.state === 'downloading' || job.state === 'submitting') && job.task) {
        this._enterQueue(job, { resumePolling: true });
      } else {
        await this._fail(job, 'interrupted', 'Interrupted by a server restart.');
      }
    }
  }

  // --- public API ------------------------------------------------------------

  list() {
    return [...this.jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) { return this.jobs.get(id) || null; }

  // `input` is validated by the caller: { route, driving, characterPath (the
  // photo file, or its cut-out copy), photoId, characterId (the photo's
  // character), characterLabel (its name), options, presetKey, orientation,
  // prompt, motionPrompt, estimateUsd, keyColor, characterCutout }. keyColor
  // ({ name, hex }) comes from chooseKeyColor on the source character; missing means green.
  // margin ('none' | 'normal' | 'wide') is validated by the caller; missing -> 'none'.
  // id: a fresh UUID the caller already used (a billing charge names the job); missing -> new.
  // billing: the charge record from lib/billing ({ sub, email, credits, free, chargeId,
  // refunded }), stored on the job; missing -> billing was off for this job.
  async create({ id: givenId = null, route, driving, characterPath, photoId = null, characterId = null, characterLabel = null, idle = false, options = {}, orientation = null, prompt = null, motionPrompt = null, estimateUsd = null, keyColor = null, margin = 'none', characterCutout = null, steps = null, extraUsd = 0, billing = null }) {
    const id = typeof givenId === 'string' && JOB_ID_RE.test(givenId) && !this.jobs.has(givenId) ? givenId : crypto.randomUUID();
    const now = new Date().toISOString();
    const dir = this.jobDir(id);
    await fsp.mkdir(dir, { recursive: true });
    // Snapshot the character so replacing it later does not change this job.
    const characterExt = path.extname(characterPath).toLowerCase() || '.png';
    const characterCopy = path.join(dir, `character-source${characterExt}`);
    await fsp.copyFile(characterPath, characterCopy);
    const adapter = this.deps.configStore.providers[route.provider];
    const job = {
      id,
      state: 'queued',
      routeId: route.id,
      routeLabel: route.label,
      familyLabel: this.deps.registry.familyLabel(route.family),
      providerLabel: adapter ? adapter.meta.label : route.provider,
      providerId: route.provider,
      drivingId: driving.id,
      drivingLabel: driving.label,
      presetKey: driving.presetKey || null,
      // Made from an idle loop: added as a motion, it becomes the photo's default idle.
      idle: idle === true,
      photoId,
      characterId,
      characterLabel,
      keyColor: keyColorRecord(keyColor),
      margin: margins.marginRecord(margin),
      // { color, share } when the opaque character image had its plain background cut out (cutout.js).
      characterCutout: characterCutout || null,
      // { cut: 'done' | 'own' | 'skipped' | 'not_plain', key: boolean } (animate/api.js createJob); null on older jobs.
      steps: steps || null,
      createdAt: now,
      updatedAt: now,
      providerStatus: null,
      progress: null,
      error: null,
      estimate: { usd: estimateUsd, seconds: null },
      // What the paid AI steps (steps.cutMethod / keyMethod 'ai') add to the route's price.
      extraUsd: Number(extraUsd) > 0 ? Number(extraUsd) : 0,
      result: null,
      motionId: null,
      motionName: null,
      options: options || {},
      orientation,
      prompt,
      motionPrompt,
      drivingPath: driving.videoPath,
      drivingDuration: driving.duration,
      characterPath: characterCopy,
      geometry: null,
      sentSeconds: null,
      task: null,
      outputUrl: null,
    };
    if (billing) job.billing = { ...billing };
    this.jobs.set(id, job);
    await this._writeJob(job);
    await this._evictOldJobs();
    // Announce 'queued' before the run synchronously moves the job on.
    if (this.deps.onChange) this.deps.onChange(job);
    this._enterQueue(job, { fromStart: true });
    return job;
  }

  // Delete a finished job and its files. null: unknown id; false: it is still
  // working (cancel it first) or a re-fetch or keying of it is running.
  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!TERMINAL.has(job.state) || this.refetching.has(id) || this.keying.has(id)) return false;
    this.jobs.delete(id);
    this.runs.delete(id);
    await fsp.rm(this.jobDir(id), { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL.has(job.state)) return job;
    const controller = this.controllers.get(id);
    if (controller) controller.abort();
    // Best effort remote cancel when the adapter supports it.
    const route = this.deps.registry.get(job.routeId);
    const adapter = route ? this.deps.configStore.providers[route.provider] : null;
    if (adapter && typeof adapter.cancel === 'function' && job.task) {
      adapter.cancel(this._ctxFor(route.provider, undefined, job), route, job.task).catch(() => {});
    }
    await this._touch(job, { state: 'canceled', progress: null, error: { code: 'canceled', message: 'Canceled.' } });
    this._pump();
    return job;
  }

  // Whether '다시 받기' may fetch this job's result again from its saved provider
  // task. The only place this rule lives. Not when nothing was submitted, when the
  // provider itself reported the task failed or canceled, after moderation, after
  // the provider deleted the result, when the route or its adapter is gone, or for
  // a local cancel that also canceled the task remotely (the adapter has cancel).
  canRefetch(job) {
    if (!job || (job.state !== 'failed' && job.state !== 'canceled')) return false;
    if (!job.task) return false;
    if (job.error?.provider === true) return false;
    const code = job.error ? job.error.code : null;
    if (code === 'moderation' || code === 'result_expired') return false;
    const route = this.deps.registry.get(job.routeId);
    const adapter = route ? this.deps.configStore.providers[route.provider] : null;
    if (!adapter || typeof adapter.poll !== 'function') return false;
    if (job.state === 'canceled' && typeof adapter.cancel === 'function') return false;
    return true;
  }

  // '다시 받기': poll the saved task again -> download -> key. Never uploads or
  // submits, so it costs nothing at the provider. The job goes to `running`, never
  // `queued`: after a restart a queued job is submitted again, a running one with a
  // task resumes polling. An active job is returned unchanged. Resolves the job, or
  // null when there is none; throws code not_refetchable when canRefetch is false.
  // prepare(job), when given, runs once the job is known to be refetchable and
  // before it moves (the animate API takes credits there); it resolves a patch
  // for the job (or null), and a throw leaves the job as it was. Concurrent
  // calls for one job share the first one (a double click prepares once).
  refetch(id, { prepare = null } = {}) {
    const inflight = this.refetching.get(id);
    if (inflight) return inflight;
    const run = this._refetch(id, prepare);
    this.refetching.set(id, run);
    const clear = () => { if (this.refetching.get(id) === run) this.refetching.delete(id); };
    run.then(clear, clear);
    return run;
  }

  async _refetch(id, prepare) {
    let job = this.jobs.get(id);
    if (!job) return null;
    if (ACTIVE.has(job.state)) return job;
    // A cancel returns before the aborted run has unwound (an ffmpeg step or a
    // download may still be finishing); a second run for the same job would race it.
    const previous = this.runs.get(id);
    if (previous) await previous.catch(() => {});
    job = this.jobs.get(id);
    if (!job) return null;
    if (ACTIVE.has(job.state)) return job;
    if (!this.canRefetch(job)) {
      throw Object.assign(new Error('This job cannot be fetched again.'), { code: 'not_refetchable' });
    }
    const patch = prepare ? await prepare(job) : null;
    // Removed meanwhile (the oldest finished jobs make room for new ones).
    if (this.jobs.get(id) !== job) throw Object.assign(new Error('Job not found.'), { code: 'job_missing' });
    await this._touch(job, { ...(patch || {}), state: 'running', progress: null, providerStatus: null, error: null, result: null, finishedAt: null });
    this._enterQueue(job, { resumePolling: true });
    return job;
  }

  // Record the library motion made from this job's result.
  async setMotion(id, motionId, motionName) {
    const job = this.jobs.get(id);
    if (!job) return null;
    await this._touch(job, { motionId, motionName });
    return job;
  }

  // Record that this job's credit charge `chargeId` was given back (persisted,
  // announced); a later charge of the job (a re-fetch) is left alone. After
  // close() the flag stays unset on disk; the startup reconcile sets it.
  async setBillingRefunded(id, chargeId) {
    const job = this.jobs.get(id);
    if (this._closed || !job || !job.billing || job.billing.refunded) return job || null;
    if (chargeId !== undefined && job.billing.chargeId !== chargeId) return job;
    await this._touch(job, { billing: { ...job.billing, refunded: true } });
    return job;
  }

  // --- queue + slots ---------------------------------------------------------

  _enterQueue(job, phase) {
    job._pending = phase;
    job._started = false;
    this._pump();
  }

  _pump() {
    if (this._closed) return;
    while (this.running < this.concurrency()) {
      const next = [...this.jobs.values()]
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .find(job => ACTIVE.has(job.state) && job._pending && !job._started);
      if (!next) break;
      next._started = true;
      this.running += 1;
      const phase = next._pending;
      next._pending = null;
      this.runs.set(next.id, this._run(next, phase));
    }
  }

  async _run(job, phase) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const { signal } = controller;
    try {
      if (phase.fromStart) {
        await this._prepare(job, signal);
        await this._submit(job, signal);
      }
      if (!phase.resumeKeying) {
        await this._poll(job, signal);
        await this._download(job, signal);
      }
      // Step 3 left out: the result stays the MP4 with its background.
      if (job.steps && job.steps.key === false) job.result = { ...job.result, keyed: null, keySkipped: 'not_requested', keyError: null, fit: null };
      else await this._key(job, signal);
      this._check(signal, job); // a cancel during the download or keying wins
      await this._touch(job, { state: 'succeeded', progress: null });
    } catch (error) {
      if (this._closed) {
        // Server shutdown: leave job.json at its last state so a restart resumes it.
      } else if (signal.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        // provider: the provider reported the task canceled (not a local cancel).
        const canceled = { code: 'canceled', message: 'Canceled.', ...(error.provider === true ? { provider: true } : {}) };
        if (!TERMINAL.has(job.state)) await this._touch(job, { state: 'canceled', error: canceled });
      } else if (!TERMINAL.has(job.state)) {
        const code = error.code && ERROR_CODES.has(error.code) ? error.code : 'generation_failed';
        await this._fail(job, code, error.message || 'Generation failed.', { provider: error.provider === true });
      }
    } finally {
      this.controllers.delete(job.id);
      job._started = false;
      if (this.running > 0) this.running -= 1;
      if (!this._closed) this._pump();
    }
  }

  // provider: true when the provider itself reported the task failed (job.error.provider).
  async _fail(job, code, message, { provider = false } = {}) {
    const error = { code, message: safeMessage(message), ...(provider ? { provider: true } : {}) };
    await this._touch(job, { state: 'failed', progress: null, error });
  }

  _check(signal, job) {
    if (signal.aborted || TERMINAL.has(job.state)) throw aborted();
  }

  async _prepare(job, signal) {
    this._check(signal, job);
    await this._touch(job, { state: 'preparing', providerStatus: null });
    const route = this._route(job);
    const dir = this.jobDir(job.id);
    if (!fs.existsSync(job.characterPath)) throw Object.assign(new Error('No character image.'), { code: 'character_missing' });
    const ext = path.extname(job.characterPath).toLowerCase();
    const composite = await media.compositeCharacter(
      this.deps.ffmpegPath, this.deps.ffprobePath,
      { path: job.characterPath, ext, isImage: true }, route.limits || {},
      path.join(dir, 'character-key.png'), { timeoutMs: 5 * 60 * 1000, keyHex: keyColors.ffmpegHex(job.keyColor) });
    this._check(signal, job);
    if (!fs.existsSync(job.drivingPath)) throw Object.assign(new Error('The driving video is gone.'), { code: 'driving_missing' });
    let prep;
    let marginPx = 0;
    if (margins.marginRecord(job.margin) !== 'none') {
      const probed = await media.probeVideo(this.deps.ffprobePath, job.drivingPath).catch(() => null);
      if (probed) marginPx = margins.marginPx(job.margin, probed.width, probed.height);
    }
    try {
      prep = await media.prepareReference(
        this.deps.ffmpegPath, this.deps.ffprobePath, job.drivingPath, path.join(dir, 'reference.mp4'),
        { minSec: route.limits ? route.limits.videoMinSec : null, maxSec: referenceMaxSec(route, job.orientation), marginPx, timeoutMs: 5 * 60 * 1000 });
    } catch (error) {
      if (error.code === 'reference_too_short') throw Object.assign(new Error(error.message), { code: 'driving_too_short' });
      throw Object.assign(new Error(error.message || 'Could not read the driving video.'), { code: 'driving_missing' });
    }
    const routeUsd = this.deps.registry.estimateUsd(route, prep.sentSeconds, job.options);
    const extraUsd = Number(job.extraUsd) > 0 ? Number(job.extraUsd) : 0;
    const estimateUsd = routeUsd == null ? (extraUsd || null) : Number((routeUsd + extraUsd).toFixed(4));
    await this._touch(job, { geometry: composite.geometry, sentSeconds: prep.sentSeconds, estimate: { ...job.estimate, usd: estimateUsd } });
  }

  async _submit(job, signal) {
    this._check(signal, job);
    await this._touch(job, { state: 'submitting' });
    const route = this._route(job);
    const adapter = this._adapter(job);
    const dir = this.jobDir(job.id);
    const ctx = this._ctx(job, signal);
    let imageUrl;
    let videoUrl;
    try {
      imageUrl = await adapter.upload(ctx, fileDesc(path.join(dir, 'character-key.png'), 'character-key.png', 'image/png'));
      const referenceFile = fileDesc(path.join(dir, 'reference.mp4'), 'reference.mp4', 'video/mp4');
      if (adapter.meta.needsPublicVideoUrl) {
        const relayId = this.deps.configStore.resolveMediaRelay();
        if (!relayId) throw Object.assign(new Error('No media relay configured.'), { code: 'no_media_relay' });
        videoUrl = await this.deps.configStore.providers[relayId].upload(this._ctxFor(relayId, signal), referenceFile);
      } else {
        videoUrl = await adapter.upload(ctx, referenceFile);
      }
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (error.code === 'no_media_relay') throw error;
      throw Object.assign(new Error(error.message || 'Upload failed.'), { code: 'upload_failed' });
    }
    this._check(signal, job);
    const input = { imageUrl, videoUrl, prompt: job.prompt, motionPrompt: job.motionPrompt || null, orientation: job.orientation, options: job.options };
    let task;
    try {
      // Set synchronously right before the request leaves: from here on a
      // provider task may exist (and be billed) even if the call is cut short,
      // so a cancel no longer gives credits back (persisted with the next write).
      job.submitStartedAt = new Date().toISOString();
      task = await adapter.submit(ctx, route, input);
    } catch (error) {
      if (signal.aborted) throw aborted();
      throw Object.assign(new Error(error.message || 'Submit failed.'), { code: 'submit_failed' });
    }
    if (TERMINAL.has(job.state)) {
      // Canceled while the submit was in flight: keep the task on record
      // (it exists) without reviving the job, and ask the provider to stop it.
      // (A shutdown abort leaves the state alone: the task is stored below and
      // a restart resumes polling it.)
      if (typeof adapter.cancel === 'function') adapter.cancel(this._ctxFor(route.provider, undefined, job), route, task).catch(() => {});
      await this._touch(job, { task });
      throw aborted();
    }
    await this._touch(job, { task, state: 'running' });
  }

  async _poll(job, signal) {
    this._check(signal, job);
    if (job.state !== 'running') await this._touch(job, { state: 'running' });
    const route = this._route(job);
    const adapter = this._adapter(job);
    const ctx = this._ctx(job, signal);
    const interval = this.pollIntervalMs || adapter.meta.pollIntervalMs || 5000;
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let consecutiveErrors = 0;
    for (;;) {
      this._check(signal, job);
      if (Date.now() > deadline) throw Object.assign(new Error('Generation timed out.'), { code: 'timeout' });
      let result;
      try {
        result = await adapter.poll(ctx, route, job.task);
        consecutiveErrors = 0;
      } catch (error) {
        if (signal.aborted) throw aborted();
        if (error && error.retryable) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            throw Object.assign(new Error('Generation failed after repeated poll errors.'), { code: 'generation_failed' });
          }
          await sleep(Math.min(interval * consecutiveErrors, 30000), signal);
          continue;
        }
        throw Object.assign(new Error(error.message || 'Generation failed.'), { code: 'generation_failed' });
      }
      const patch = {};
      if (result.providerStatus && result.providerStatus !== job.providerStatus) patch.providerStatus = String(result.providerStatus).slice(0, 60);
      const progress = Number.isFinite(result.progress) ? Math.max(0, Math.min(1, result.progress)) : null;
      if (progress !== null && progress !== job.progress) patch.progress = progress;
      if (Object.keys(patch).length) await this._touch(job, patch);
      if (result.moderated) throw Object.assign(new Error('Content was moderated.'), { code: 'moderation' });
      if (result.state === 'succeeded') {
        await this._touch(job, { outputUrl: result.outputUrl || null });
        return;
      }
      // The provider's own verdict (provider: true): fetching this task again cannot help.
      if (result.state === 'failed') throw Object.assign(new Error(result.error || 'Generation failed.'), { code: 'generation_failed', provider: true });
      if (result.state === 'canceled') throw Object.assign(aborted(), { provider: true });
      await sleep(interval, signal);
    }
  }

  async _download(job, signal) {
    this._check(signal, job);
    await this._touch(job, { state: 'downloading', progress: null });
    const adapter = this._adapter(job);
    const ctx = this._ctx(job, signal);
    const dest = this.resultPath(job.id);
    const tmp = `${dest}.${crypto.randomUUID()}.tmp.mp4`;
    try {
      await adapter.download(ctx, job.outputUrl, tmp);
      const probed = await media.probeVideo(this.deps.ffprobePath, tmp);
      if (!probed || !probed.width) throw new Error('The generated file has no video stream.');
      await fsp.rename(tmp, dest);
      await media.makePoster(this.deps.ffmpegPath, dest, this.posterPath(job.id)).catch(() => {});
      this._check(signal, job);
      job.result = {
        duration: Number.isFinite(probed.duration) ? Number(probed.duration.toFixed(3)) : null,
        width: probed.width,
        height: probed.height,
        mime: 'video/mp4',
      };
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') throw aborted();
      if (EXPIRED_STATUSES.has(error.status)) {
        throw Object.assign(new Error('The result has expired at the provider.'), { code: 'result_expired' });
      }
      throw Object.assign(new Error(error.message || 'Download failed.'), { code: 'download_failed' });
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // Key result.mp4 into result.webm. Only a cancel escapes; every other
  // problem is recorded on job.result and the job still succeeds.
  async _key(job, signal) {
    this._check(signal, job);
    await this._touch(job, { state: 'keying', progress: null });
    const outcome = await this._keyResult(job, signal);
    this._check(signal, job);
    job.result = { ...job.result, ...outcome };
  }

  // -> { keyed: { color }, fit } or { keyed: null, keySkipped?, keyError?, fit: null }.
  // method 'ai' (the job's steps.keyMethod, or a re-key that asks for it): the paid AI
  // remover; when it fails the free colour key runs instead and keyAiError says so.
  async _keyResult(job, signal, method = null) {
    await fsp.rm(this.keyedPath(job.id), { force: true }).catch(() => {});
    const ai = this.deps.backgroundAi;
    let keyAiError = null;
    if ((method || (job.steps && job.steps.keyMethod)) === 'ai' && ai && ai.available()) {
      try {
        await ai.video(this.resultPath(job.id), this.keyedPath(job.id), { signal, keyColor: job.keyColor });
        const fit = await measureFit(this.deps.ffmpegPath, this.deps.ffprobePath, this.keyedPath(job.id));
        return { keyed: { color: null, method: 'ai' }, keySkipped: null, keyError: null, keyAiError: null, fit };
      } catch (error) {
        if (signal && (signal.aborted || error.name === 'AbortError')) throw aborted();
        keyAiError = safeMessage(error.message) || 'AI background removal failed.';
        console.warn(`[animate] AI background removal of job ${job.id} failed: ${keyAiError}`);
        await fsp.rm(this.keyedPath(job.id), { force: true }).catch(() => {});
      }
    }
    return { ...(await this._colorKey(job, signal)), keyAiError };
  }

  async _colorKey(job, signal) {
    let outcome;
    try {
      outcome = await key.autoKey(this.deps.ffmpegPath, this.deps.ffprobePath, this.resultPath(job.id), this.keyedPath(job.id),
        { signal, expected: keyColors.resolveKeyColor(job.keyColor) });
    } catch (error) {
      if (signal && (signal.aborted || error.name === 'AbortError')) throw aborted();
      outcome = { keyed: false, error: error.message || 'Background keying failed.' };
    }
    if (outcome.keyed) {
      const fit = await measureFit(this.deps.ffmpegPath, this.deps.ffprobePath, this.keyedPath(job.id));
      return { keyed: { color: outcome.color }, keySkipped: null, keyError: null, fit };
    }
    // The background is not the key colour (e.g. the model kept a white image
    // background): remove a plain background connected to the frame edges instead.
    if (outcome.reason === 'not_uniform' || outcome.reason === 'not_key_color') {
      let plain = null;
      try {
        plain = await plainCut.plainCutVideo(this.deps.ffmpegPath, this.deps.ffprobePath, this.resultPath(job.id), this.keyedPath(job.id), { signal });
      } catch (error) {
        if (signal && (signal.aborted || error.name === 'AbortError')) throw aborted();
      }
      if (plain && plain.cut) {
        const fit = await measureFit(this.deps.ffmpegPath, this.deps.ffprobePath, this.keyedPath(job.id));
        return { keyed: { color: plain.color, method: 'plain' }, keySkipped: null, keyError: null, fit };
      }
    }
    if (outcome.reason) return { keyed: null, keySkipped: outcome.reason, keyError: null, fit: null };
    return { keyed: null, keySkipped: null, keyError: safeMessage(outcome.error), fit: null };
  }

  // job.result.fit for a succeeded keyed job stored before fit measurement.
  // Concurrent callers share one run. Resolves the job.
  async ensureFit(id) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'succeeded' || !job.result || 'fit' in job.result) return job || null;
    const key = `fit:${id}`;
    if (!this.keying.has(key)) {
      const run = (async () => {
        const keyed = !!job.result.keyed && fs.existsSync(this.keyedPath(id));
        const fit = keyed ? await measureFit(this.deps.ffmpegPath, this.deps.ffprobePath, this.keyedPath(id)) : null;
        if (this._closed || 'fit' in job.result) return;
        job.result = { ...job.result, fit };
        await this._touch(job, {});
      })().finally(() => this.keying.delete(key));
      this.keying.set(key, run);
    }
    await this.keying.get(key);
    return job;
  }

  // On demand for a succeeded job without result.webm (older jobs, or the
  // file was removed). Concurrent callers share one run. Resolves the job.
  async ensureKeyed(id) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'succeeded' || !job.result) return job || null;
    if (fs.existsSync(this.keyedPath(id)) && job.result.keyed) return job;
    if (!this.keying.has(id)) {
      const run = (async () => {
        // Never the paid remover here: nobody asked for it at this moment.
        const outcome = await this._keyResult(job, null, 'color');
        job.result = { ...job.result, ...outcome };
        await this._touch(job, {});
      })().finally(() => this.keying.delete(id));
      this.keying.set(id, run);
    }
    await this.keying.get(id);
    return job;
  }

  // Run background removal again for a succeeded job (the '배경 제거하기' button),
  // even when it was keyed before. Concurrent callers share one run. Resolves the job.
  async rekey(id, { method = 'color' } = {}) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'succeeded' || !job.result || !fs.existsSync(this.resultPath(id))) return job || null;
    if (!this.keying.has(id)) {
      const run = (async () => {
        const outcome = await this._keyResult(job, null, method);
        job.result = { ...job.result, ...outcome };
        await this._touch(job, {});
      })().finally(() => this.keying.delete(id));
      this.keying.set(id, run);
    }
    await this.keying.get(id);
    return job;
  }

  // --- helpers ---------------------------------------------------------------

  _route(job) {
    const route = this.deps.registry.get(job.routeId);
    if (!route) throw Object.assign(new Error('The model route is no longer available.'), { code: 'submit_failed' });
    return route;
  }

  _adapter(job) {
    const adapter = this.deps.configStore.providers[this._route(job).provider];
    if (!adapter) throw Object.assign(new Error('The provider is unavailable.'), { code: 'submit_failed' });
    return adapter;
  }

  _ctx(job, signal) {
    return this._ctxFor(this._route(job).provider, signal, job);
  }

  _ctxFor(providerId, signal, job = null) {
    const configStore = this.deps.configStore;
    const ctx = {
      credentials: configStore.resolvedCredentials(providerId),
      settings: configStore.resolvedSettings(providerId),
      fetch: (...args) => fetch(...args),
      baseUrl: configStore.baseUrl(providerId),
      signal,
      log: () => {},
      allowInsecure: configStore.allowInsecure(providerId),
    };
    // The mock renders on download() and needs the local inputs.
    if (providerId === 'mock' && job) {
      ctx.mock = {
        imagePath: path.join(this.jobDir(job.id), 'character-key.png'),
        width: job.geometry ? job.geometry.sent.w : null,
        height: job.geometry ? job.geometry.sent.h : null,
        duration: job.sentSeconds,
        ffmpegPath: this.deps.ffmpegPath,
        keyColor: keyColors.ffmpegHex(job.keyColor),
      };
    }
    return ctx;
  }

  async _evictOldJobs() {
    const removable = [...this.jobs.values()]
      .filter(job => TERMINAL.has(job.state))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    while (this.jobs.size > MAX_JOBS && removable.length) {
      const victim = removable.shift();
      this.jobs.delete(victim.id);
      this.runs.delete(victim.id);
      await this.docs.remove(this.jobDocPath(victim.id)).catch(() => {});
      await fsp.rm(this.jobDir(victim.id), { recursive: true, force: true }).catch(() => {});
    }
  }

  view(job) {
    const hasResult = job.state === 'succeeded' && !!job.result;
    const view = {
      id: job.id,
      state: job.state,
      routeId: job.routeId,
      routeLabel: job.routeLabel,
      familyLabel: job.familyLabel,
      providerLabel: job.providerLabel,
      drivingId: job.drivingId,
      drivingLabel: job.drivingLabel,
      presetKey: job.presetKey || null,
      idle: job.idle === true,
      photoId: jobPhotoId(job),
      characterId: job.characterId || null,
      characterLabel: job.characterLabel || null,
      keyColor: keyColorRecord(job.keyColor),
      characterCutout: job.characterCutout || null,
      steps: job.steps ? {
        cut: job.steps.cut, key: job.steps.key !== false,
        ...(job.steps.cutMethod === 'ai' ? { cutMethod: 'ai' } : {}), ...(job.steps.keyMethod === 'ai' ? { keyMethod: 'ai' } : {}),
      } : null,
      margin: margins.marginRecord(job.margin),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt || null,
      providerStatus: job.providerStatus || null,
      progress: Number.isFinite(job.progress) ? job.progress : null,
      error: job.error ? { code: job.error.code, message: job.error.message } : null,
      canRefetch: this.canRefetch(job),
      estimate: { usd: job.estimate ? job.estimate.usd ?? null : null, seconds: job.estimate ? job.estimate.seconds ?? null : null },
      result: hasResult ? {
        url: `/api/animate/jobs/${job.id}/result`,
        posterUrl: fs.existsSync(this.posterPath(job.id)) ? `/api/animate/jobs/${job.id}/poster` : null,
        duration: job.result.duration,
        width: job.result.width,
        height: job.result.height,
        mime: job.result.mime,
        keyedUrl: job.result.keyed && fs.existsSync(this.keyedPath(job.id))
          ? `/api/animate/jobs/${job.id}/result?variant=keyed&v=${Math.floor(fs.statSync(this.keyedPath(job.id)).mtimeMs)}` : null,
        keyColor: job.result.keyed ? job.result.keyed.color : null,
        // 'color' = chroma key on the key colour; 'plain' = plain background cut from the frame edges.
        keyMethod: job.result.keyed ? job.result.keyed.method || 'color' : null,
        keySkipped: job.result.keySkipped || null,
        keyFailed: !!job.result.keyError,
        // The paid AI remover was asked for and failed (the free colour key ran instead).
        keyAiFailed: !!job.result.keyAiError,
        fit: job.result.keyed ? job.result.fit ?? null : null,
      } : null,
      motionId: job.motionId || null,
      motionName: job.motionName || null,
    };
    // Only for jobs created while billing was on; never the account or ledger ids.
    // cancelRefund: whether canceling now gives the credits back (charged, not
    // free, not yet refunded, and no provider task yet). refetchCredits: what a
    // 다시 받기 would take now (0 = nothing, or not offered); the animate API
    // decides it (deps.refetchCredits), free accounts are never charged.
    if (job.billing && typeof job.billing === 'object') {
      const refetchCredits = this.canRefetch(job) && typeof this.deps.refetchCredits === 'function'
        ? this.deps.refetchCredits(job) : 0;
      view.billing = {
        credits: Number.isSafeInteger(job.billing.credits) ? job.billing.credits : null,
        free: !!job.billing.free,
        refunded: !!job.billing.refunded,
        cancelRefund: !!job.billing.chargeId && !job.billing.free && !job.billing.refunded && !providerTaskStarted(job),
        refetchCredits: Number.isSafeInteger(refetchCredits) && refetchCredits > 0 ? refetchCredits : 0,
      };
    }
    return view;
  }

  async close() {
    this._closed = true;
    for (const controller of this.controllers.values()) { try { controller.abort(); } catch { /* gone */ } }
  }
}

function referenceMaxSec(route, orientation) {
  const limits = route.limits || {};
  if (limits.videoMaxSecByOrientation && orientation && limits.videoMaxSecByOrientation[orientation] != null) {
    return limits.videoMaxSecByOrientation[orientation];
  }
  return limits.videoMaxSec != null ? limits.videoMaxSec : null;
}

// Whether a provider task may exist for this job: one is stored, or the
// submit request already went out (the provider may have created it).
function providerTaskStarted(job) {
  return !!job.task || !!job.submitStartedAt;
}

function fileDesc(filePath, filename, contentType) {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { /* not yet */ }
  return { path: filePath, filename, contentType, size };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(aborted()); };
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Strip absolute paths and URLs from an error message.
function safeMessage(message) {
  let text = String(message || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/(\/[^\s"']+)/g, m => path.basename(m));
  if (text.length > 300) text = text.slice(0, 300);
  return text;
}

// The character photo a job was made from. Jobs made before characters had
// several photos stored the photo id as characterId (null for the old idle
// image fallback).
function jobPhotoId(job) {
  if (!job || typeof job !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(job, 'photoId')) return typeof job.photoId === 'string' ? job.photoId : null;
  return typeof job.characterId === 'string' ? job.characterId : null;
}

// { name, hex } of a stored/requested key colour; unknown or missing -> green.
function keyColorRecord(value) {
  const resolved = keyColors.resolveKeyColor(value);
  return { name: resolved.name, hex: resolved.hex };
}

// The prompt for a job: the route's fixed backgroundPrompt when it has one
// (the suffix is ignored; {color} / {hex} become the job's key colour), else
// the preset's prompt for the driving's presetKey, a generic one otherwise,
// plus the configured suffix. While the configured suffix is still the default
// (green) wording it names the job's key colour instead. `keyColor` missing
// means green, which reproduces the pre-key-colour prompts exactly.
function promptFor(route, presetKey, promptSuffix, keyColor = null) {
  if (!route.fields || !route.fields.prompt) return null;
  const color = keyColors.resolveKeyColor(keyColor);
  if (typeof route.backgroundPrompt === 'string' && route.backgroundPrompt) {
    return route.backgroundPrompt.replace(/\{color\}/g, color.name).replace(/\{hex\}/g, color.hex);
  }
  const suffix = promptSuffix == null || promptSuffix === presetsModule.DEFAULT_PROMPT_SUFFIX
    ? presetsModule.defaultPromptSuffix(color.name)
    : promptSuffix;
  return presetsModule.composePrompt(presetsModule.getPreset(presetKey), null, suffix);
}

// The separate motion prompt for routes with fields.motionPrompt, else null.
function motionPromptFor(route, presetKey) {
  if (!route.fields || !route.fields.motionPrompt) return null;
  return presetsModule.composeMotionPrompt(presetsModule.getPreset(presetKey));
}

module.exports = { Pipeline, STATES, TERMINAL, ACTIVE, ERROR_CODES, referenceMaxSec, promptFor, motionPromptFor, jobPhotoId, providerTaskStarted };
