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
// Two servers at once (a redeploy: the new one starts before the old one stops,
// both on the same database): every active job carries job.lease { owner, until },
// renewed by the server running it. A server never runs a job another live server
// holds; it watches it (progress reaches its pages) and takes it over when the lease
// is released (handoff(), on SIGTERM) or runs out (the old server died). Jobs another
// server creates meanwhile are picked up the same way. Only with a database (or
// deps.leases): with plain files there is one server.
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

// The colour clean-up a keyed AI result has had (job.result.keyed.rim): true = the rim only
// (the first version), 2 = the whole character.
const RIM_VERSION = 2;

// The kinds of transparent version a result can have, and the kind of a keyed record.
const VERSION_KINDS = ['free', 'ai'];
const versionKind = keyed => (keyed && keyed.method === 'ai' ? 'ai' : 'free');
const margins = require('./margin');

const MAX_JOBS = 50;
const GENERATION_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_ERRORS = 10;
const LEASE_MS = 60 * 1000;
const WATCH_MS = 10 * 1000;
const HANDOFF_SUBMIT_WAIT_MS = 20 * 1000;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATES = ['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying', 'succeeded', 'failed', 'canceled'];
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const ACTIVE = new Set(['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying']);
// Fields that only live in memory.
const TRANSIENT = new Set(['_pending', '_started', '_uploaded', '_rekeyed']);

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
    this.instanceId = deps.instanceId || crypto.randomUUID();
    this.leasing = deps.leases != null ? !!deps.leases : this.docs.kind !== 'file';
    this.leaseMs = deps.leaseMs || LEASE_MS;
    this.watchMs = deps.watchMs || WATCH_MS;
    this.foreign = new Set(); // active jobs another server holds
    this._timers = [];
    this._watching = null;
  }

  concurrency() {
    return this.deps.configStore.config.concurrency || 2;
  }

  jobDir(id) { return path.join(this.jobsDir, id); }
  jobDocPath(id) { return path.join(this.jobDir(id), 'job.json'); }
  resultPath(id) { return path.join(this.jobDir(id), 'result.mp4'); }
  keyedPath(id) { return path.join(this.jobDir(id), 'result.webm'); }
  // Every transparent version made of a result is kept: keyed.free.webm (the colour key or
  // the plain-background cut) and keyed.ai.webm (the AI remover). result.webm is a copy of
  // the one in use (job.result.keyed), so everything that reads it keeps working.
  versionPath(id, kind) { return path.join(this.jobDir(id), `keyed.${kind}.webm`); }
  posterPath(id) { return path.join(this.jobDir(id), 'poster.jpg'); }

  async init() {
    await fsp.mkdir(this.jobsDir, { recursive: true });
    await this._resumeFromDisk();
    if (this.leasing) {
      const every = (ms, fn) => { const timer = setInterval(fn, ms); timer.unref?.(); this._timers.push(timer); };
      every(Math.max(1000, Math.floor(this.leaseMs / 3)), () => { this._renewLeases().catch(() => {}); });
      every(this.watchMs, () => { this.watch().catch(error => console.warn(`[animate] watching other servers' jobs failed: ${error.message}`)); });
    }
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
    delete persisted.lease;
    if (this.leasing && ACTIVE.has(job.state) && !this.foreign.has(job.id)) {
      persisted.lease = { owner: this.instanceId, until: this._released ? 0 : Date.now() + this.leaseMs };
    }
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
      try { this.deps.onChange(job, {}); } catch { /* a listener must not break the job */ }
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
      if (this._heldElsewhere(job)) this.foreign.add(job.id);
      else await this._adopt(job);
    }
  }

  // --- several servers (job.lease) ---------------------------------------------

  // Another live server runs this job.
  _heldElsewhere(job) {
    const lease = job && job.lease;
    return !!(this.leasing && lease && lease.owner !== this.instanceId && Number(lease.until) > Date.now());
  }

  // Run an active job found in the store: the restart rules below. Its input files
  // may have been written by the other server after this one filled its disk.
  async _adopt(job) {
    this.foreign.delete(job.id);
    // Claim it before anything else, so the other server sees it is taken.
    if (this.leasing && this.jobs.get(job.id) === job) await this._writeJob(job).catch(() => {});
    if (this.deps.restoreFile) {
      const files = job.state === 'keying' ? [this.resultPath(job.id)] : [job.characterPath, job.drivingPath];
      for (const file of files) if (file) await this.deps.restoreFile(file).catch(() => {});
    }
    {
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

  async _renewLeases() {
    if (this._closed) return;
    for (const job of [...this.jobs.values()]) {
      if (this._closed) return;
      if (ACTIVE.has(job.state) && !this.foreign.has(job.id) && this.jobs.get(job.id) === job) await this._writeJob(job).catch(() => {});
    }
  }

  // One look at the store: the jobs other servers hold (progress, the end, a released
  // or expired lease -> taken over here) and jobs they created that this one has not seen.
  watch() {
    if (!this.leasing || this._closed) return Promise.resolve();
    if (!this._watching) this._watching = this._watchOnce().finally(() => { this._watching = null; });
    return this._watching;
  }

  async _watchOnce() {
    const seen = async (id) => {
      const raw = await this.docs.read(this.jobDocPath(id)).catch(() => null);
      return raw && raw.id === id ? raw : null;
    };
    for (const id of [...this.foreign]) {
      if (this._closed) return;
      const raw = await seen(id);
      if (!this.foreign.has(id)) continue; // deleted or taken over meanwhile
      if (!raw) { this.foreign.delete(id); this.jobs.delete(id); continue; }
      const before = this.jobs.get(id);
      this.jobs.set(id, raw);
      if (TERMINAL.has(raw.state)) this.foreign.delete(id);
      if (!before || before.updatedAt !== raw.updatedAt || TERMINAL.has(raw.state)) this._notify(raw, { foreign: true });
      if (ACTIVE.has(raw.state) && !this._heldElsewhere(raw)) {
        await this._adopt(raw);
        this._notify(raw);
      }
    }
    const ids = await this.docs.children(this.jobsDir).catch(() => []);
    for (const id of ids) {
      if (this._closed) return;
      if (this.jobs.has(id) || !JOB_ID_RE.test(id)) continue;
      const raw = await seen(id);
      if (!raw || this.jobs.has(id)) continue;
      this.jobs.set(id, raw);
      if (ACTIVE.has(raw.state)) {
        if (this._heldElsewhere(raw)) this.foreign.add(id);
        else await this._adopt(raw);
      }
      this._notify(raw, { foreign: this.foreign.has(id) });
    }
  }

  _notify(job, info) {
    if (!this.deps.onChange) return;
    try { this.deps.onChange(job, info || {}); } catch { /* a listener must not break the job */ }
  }

  // The server is going away (SIGTERM) and another one takes over: start nothing new,
  // let an upload/submit that is under way store its task (so it is never submitted
  // twice), stop the rest where it is and release every lease at once.
  // stopForHandoff() and releaseLeases() are its two halves: the server uploads the
  // files the jobs left (a result waiting to be keyed) in between.
  async handoff(options) {
    await this.stopForHandoff(options);
    await this.releaseLeases();
  }

  async stopForHandoff({ waitMs = HANDOFF_SUBMIT_WAIT_MS } = {}) {
    if (this._closed) return;
    this._handingOff = true;
    const deadline = Date.now() + waitMs;
    const submitting = () => [...this.controllers.keys()].some(id => this.jobs.get(id)?.state === 'submitting');
    while (submitting() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    await this.close();
    await Promise.all([...this.runs.values()].map(run => run.catch(() => {})));
  }

  async releaseLeases() {
    if (!this.leasing || this._released) return;
    this._released = true;
    for (const job of [...this.jobs.values()]) {
      if (ACTIVE.has(job.state) && !this.foreign.has(job.id)) await this._writeJob(job).catch(() => {});
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
  // billing: the charge record from lib/billing ({ sub, email, credits, chargeId,
  // refunded }), stored on the job; missing -> billing was off for this job.
  async create({ id: givenId = null, route, driving, characterPath, photoId = null, characterId = null, characterLabel = null, idle = false, options = {}, orientation = null, prompt = null, motionPrompt = null, estimateUsd = null, keyColor = null, margin = 'none', characterCutout = null, steps = null, extraUsd = 0, keyCharge = null, billing = null }) {
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
    // Step 3 by the AI remover is its own charge: { chargeId, credits, refunded, settled } (animate/api.js settleKeyCharge).
    if (keyCharge) job.keyCharge = { ...keyCharge };
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
  async setKeyCharge(id, patch) {
    const job = this.jobs.get(id);
    if (this._closed || !job || !job.keyCharge) return job || null;
    await this._touch(job, { keyCharge: { ...job.keyCharge, ...patch } });
    return job;
  }

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
    if (this._closed || this._handingOff) return;
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
    this._check(signal, job);
    // A route that crops the image to the driving video's shape gets the photo in that shape.
    const frame = route.imageFollowsDriving && prep.padded && prep.padded.w > 0 && prep.padded.h > 0
      ? { aspect: prep.padded.w / prep.padded.h, marginFactor: margins.marginFactor(job.margin) } : null;
    const composite = await media.compositeCharacter(
      this.deps.ffmpegPath, this.deps.ffprobePath,
      { path: job.characterPath, ext, isImage: true }, route.limits || {},
      path.join(dir, 'character-key.png'), { timeoutMs: 5 * 60 * 1000, keyHex: keyColors.ffmpegHex(job.keyColor), frame });
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
    await this._keepVersion(job);
  }

  // Keep the transparent clip in use as its kind's version (file + record).
  async _keepVersion(job) {
    const keyed = job.result && job.result.keyed;
    if (!keyed || !fs.existsSync(this.keyedPath(job.id))) return;
    const kind = versionKind(keyed);
    await fsp.copyFile(this.keyedPath(job.id), this.versionPath(job.id, kind));
    job.result = { ...job.result, original: false, versions: { ...(job.result.versions || {}), [kind]: { keyed, fit: job.result.fit ?? null } } };
  }

  // The transparent versions of a result: { free?, ai? } -> { keyed, fit }. A job from
  // before versions were kept has only the one in use.
  versions(job) {
    const result = job && job.result;
    if (!result) return {};
    const out = {};
    for (const kind of VERSION_KINDS) {
      const kept = result.versions && result.versions[kind];
      if (kept && fs.existsSync(this.versionPath(job.id, kind))) out[kind] = kept;
    }
    if (result.keyed && fs.existsSync(this.keyedPath(job.id))) {
      const kind = versionKind(result.keyed);
      if (!out[kind]) out[kind] = { keyed: result.keyed, fit: result.fit ?? null };
    }
    return out;
  }

  // The file of a version: its own, else result.webm when that is the version in use.
  versionFile(job, kind) {
    if (!VERSION_KINDS.includes(kind) || !this.versions(job)[kind]) return null;
    const own = this.versionPath(job.id, kind);
    return fs.existsSync(own) ? own : this.keyedPath(job.id);
  }

  // 'original' | 'free' | 'ai': the version in use (what 동작으로 추가하기 takes).
  activeVersion(job) {
    const keyed = job && job.result && job.result.keyed;
    return keyed && fs.existsSync(this.keyedPath(job.id)) ? versionKind(keyed) : 'original';
  }

  // Put a version in use. -> false when the job has no such version.
  async useVersion(id, kind) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'succeeded' || !job.result) return false;
    if (this.keying.has(id)) await this.keying.get(id).catch(() => {});
    if (kind === 'original') {
      // Keep the clip in use as a version before it goes.
      await this._keepVersion(job);
      await fsp.rm(this.keyedPath(id), { force: true }).catch(() => {});
      job.result = { ...job.result, keyed: null, fit: null, original: true };
      await this._touch(job, {});
      return true;
    }
    const version = this.versions(job)[kind];
    if (!version) return false;
    if (this.activeVersion(job) !== kind) {
      await this._keepVersion(job);
      await fsp.copyFile(this.versionPath(id, kind), this.keyedPath(id));
      job.result = { ...job.result, keyed: version.keyed, fit: version.fit ?? null, original: false };
      await this._touch(job, {});
    }
    return true;
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
        const done = await ai.video(this.resultPath(job.id), this.keyedPath(job.id), { signal, keyColor: job.keyColor });
        const fit = await measureFit(this.deps.ffmpegPath, this.deps.ffprobePath, this.keyedPath(job.id));
        // rim: the key colour was taken out of the clip (RIM_VERSION; 'none': nothing to clean).
        return { keyed: { color: null, method: 'ai', rim: done && done.rimCleaned ? RIM_VERSION : 'none' }, keySkipped: null, keyError: null, keyAiError: null, fit };
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
        await this._keepVersion(job);
        await this._touch(job, {});
      })().finally(() => this.keying.delete(id));
      this.keying.set(id, run);
    }
    await this.keying.get(id);
    return job;
  }

  _versionViews(job) {
    const stamp = file => { try { return Math.floor(fs.statSync(file).mtimeMs); } catch { return 0; } };
    const views = [{ kind: 'original', url: `/api/animate/jobs/${job.id}/result`, mime: 'video/mp4', keyMethod: null }];
    const versions = this.versions(job);
    for (const kind of VERSION_KINDS) {
      if (!versions[kind]) continue;
      views.push({
        kind, url: `/api/animate/jobs/${job.id}/result?variant=${kind}&v=${stamp(this.versionFile(job, kind))}`,
        mime: 'video/webm', keyMethod: versions[kind].keyed.method || 'color',
      });
    }
    return views;
  }

  // Whether the '배경색 번짐 지우기' button has something to work on: any transparent version.
  rimCleanable(job) {
    return Boolean(job && job.state === 'succeeded' && job.result && Object.keys(this.versions(job)).length && fs.existsSync(this.resultPath(job.id)));
  }

  // The '배경색 번짐 지우기' button: take the key colour out of one transparent version
  // (`kind`; default the one in use), whichever method made it. Free and local (no AI call).
  // The alpha is pulled in by one pixel only the first time a version is cleaned, so the
  // button can be pressed again without eating into the character.
  // -> { cleaned } (false: the clip's background is not a key colour), or null without such a version.
  async cleanRim(id, kind = null) {
    const job = this.jobs.get(id);
    const ai = this.deps.backgroundAi;
    if (!job || !ai || typeof ai.cleanRim !== 'function' || !this.rimCleanable(job)) return null;
    if (this.keying.has(id)) await this.keying.get(id).catch(() => {});
    const active = this.activeVersion(job);
    const wanted = VERSION_KINDS.includes(kind) ? kind : active;
    if (!this.versions(job)[wanted]) return null;
    let cleaned = false;
    const run = (async () => {
      // Every version as its own file first (an older job has only the clip in use).
      await this._keepVersion(job);
      const version = this.versions(job)[wanted];
      const file = this.versionPath(id, wanted);
      if (!fs.existsSync(file)) await fsp.copyFile(this.keyedPath(id), file);
      const before = version.keyed.rim;
      cleaned = await ai.cleanRim(this.resultPath(id), file, { keyColor: job.keyColor, choke: before !== true && before !== RIM_VERSION });
      const keyed = { ...version.keyed, rim: cleaned ? RIM_VERSION : before || 'none' };
      const fit = cleaned ? await measureFit(this.deps.ffmpegPath, this.deps.ffprobePath, file) : version.fit ?? null;
      job.result = { ...job.result, versions: { ...(job.result.versions || {}), [wanted]: { keyed, fit: fit ?? version.fit ?? null } } };
      if (active === wanted) {
        if (cleaned) await fsp.copyFile(file, this.keyedPath(id));
        job.result = { ...job.result, keyed, fit: fit ?? job.result.fit ?? null };
      }
      await this._touch(job, {});
    })().finally(() => this.keying.delete(id));
    this.keying.set(id, run);
    await run;
    return { cleaned };
  }

  // Run background removal again for a succeeded job (the '배경 제거하기' button),
  // even when it was keyed before. Concurrent callers share one run. Resolves the job.
  async rekey(id, { method = 'color' } = {}) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'succeeded' || !job.result || !fs.existsSync(this.resultPath(id))) return job || null;
    if (!this.keying.has(id)) {
      const run = (async () => {
        // The clip in use is kept as a version first: a run that fails puts it back.
        await this._keepVersion(job);
        const before = this.activeVersion(job);
        const outcome = await this._keyResult(job, null, method);
        job.result = { ...job.result, ...outcome };
        job._rekeyed = Boolean(outcome.keyed);
        if (outcome.keyed) await this._keepVersion(job);
        else if (before !== 'original' && this.versions(job)[before]) {
          const version = this.versions(job)[before];
          await fsp.copyFile(this.versionPath(id, before), this.keyedPath(id));
          job.result = { ...job.result, keyed: version.keyed, fit: version.fit ?? null };
        }
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
        // Every version of the result, the original first: [{ kind, url, mime, keyMethod }].
        versions: this._versionViews(job),
        activeVersion: this.activeVersion(job),
        // '배경색 번짐 지우기' has a transparent version to work on.
        rimCleanable: this.rimCleanable(job),
        keySkipped: job.result.keySkipped || null,
        keyFailed: !!job.result.keyError,
        // The paid AI remover was asked for and failed (the free colour key ran instead).
        keyAiFailed: !!job.result.keyAiError,
        fit: job.result.keyed ? job.result.fit ?? null : null,
      } : null,
      motionId: job.motionId || null,
      motionName: job.motionName || null,
      // Step 3's own charge when the AI remover was asked for: { credits, refunded } (null: none).
      keyCharge: job.keyCharge ? { credits: job.keyCharge.credits ?? null, refunded: job.keyCharge.refunded === true } : null,
    };
    // Only for jobs created while billing was on; never the account or ledger ids.
    // cancelRefund: whether canceling now gives the credits back (charged, not
    // yet refunded, and no provider task yet). refetchCredits: what a
    // 다시 받기 would take now (0 = nothing, or not offered); the animate API
    // decides it (deps.refetchCredits).
    if (job.billing && typeof job.billing === 'object') {
      const refetchCredits = this.canRefetch(job) && typeof this.deps.refetchCredits === 'function'
        ? this.deps.refetchCredits(job) : 0;
      view.billing = {
        credits: Number.isSafeInteger(job.billing.credits) ? job.billing.credits : null,
        refunded: !!job.billing.refunded,
        cancelRefund: !!job.billing.chargeId && !job.billing.refunded && !providerTaskStarted(job),
        refetchCredits: Number.isSafeInteger(refetchCredits) && refetchCredits > 0 ? refetchCredits : 0,
      };
    }
    return view;
  }

  async close() {
    this._closed = true;
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
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
