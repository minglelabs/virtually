'use strict';

// The persisted animate pipeline job engine. One job takes a preset's reference
// video + the character image through:
//   queued -> preparing -> uploading -> generating -> downloading -> keying ->
//   publishing -> done   (or failed / canceled)
// Each job's state lives on disk (animate/jobs/<id>/job.json) so a server
// restart resumes it. See .kiro/specs/animate-presets.md "Pipeline".
//
// Injected dependencies keep this testable and decoupled from server.js:
//   { dataDir, ffmpegPath, ffprobePath, registry, configStore, presetStore,
//     encoderSlot, probeFfmpeg, commitLibraryItem, removeMediaItem,
//     findMediaItem, characterSource, pollIntervalMs }

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const presetsModule = require('./presets');
const media = require('./media');
const { normalizeChromaParams, chromaFilter, VP9_ARGS } = require('../chroma-encode');

const MAX_JOBS = 30;
const GENERATION_TIMEOUT_MS = 60 * 60 * 1000; // 60 min without a terminal state
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

const STATES = ['queued', 'preparing', 'uploading', 'generating', 'downloading', 'keying', 'publishing', 'done', 'failed', 'canceled'];
const TERMINAL = new Set(['done', 'failed', 'canceled']);
const ACTIVE = new Set(['queued', 'preparing', 'uploading', 'generating', 'downloading', 'keying', 'publishing']);

class Pipeline {
  constructor(deps) {
    this.deps = deps;
    this.dataDir = deps.dataDir;
    this.jobsDir = path.join(deps.dataDir, 'animate', 'jobs');
    this.jobs = new Map(); // id -> job record (in memory, mirrors job.json)
    this.controllers = new Map(); // id -> AbortController for the active run
    this.children = new Map(); // id -> running ffmpeg child (for cancel/kill)
    this.running = 0; // generation slots in use (preparing..downloading)
    this.pollIntervalMs = deps.pollIntervalMs || null;
    this._closed = false;
  }

  concurrency() {
    return this.deps.configStore.config.concurrency || 2;
  }

  jobDir(id) { return path.join(this.jobsDir, id); }

  async init() {
    await fsp.mkdir(this.jobsDir, { recursive: true });
    await this._resumeFromDisk();
    return this;
  }

  // --- persistence -----------------------------------------------------------

  async _writeJob(job) {
    const dir = this.jobDir(job.id);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `job.${crypto.randomUUID()}.tmp.json`);
    const persisted = { ...job };
    try {
      await fsp.writeFile(tmp, JSON.stringify(persisted, null, 2) + '\n');
      await fsp.rename(tmp, path.join(dir, 'job.json'));
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async _touch(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this._writeJob(job);
  }

  async _resumeFromDisk() {
    let entries = [];
    try { entries = await fsp.readdir(this.jobsDir); } catch { return; }
    const loaded = [];
    for (const id of entries) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(this.jobDir(id), 'job.json'), 'utf8'));
        if (raw && raw.id) loaded.push(raw);
      } catch { /* skip unreadable */ }
    }
    loaded.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const job of loaded) this.jobs.set(job.id, job);
    // Resume each non-terminal job according to its stored state.
    for (const job of loaded) {
      if (TERMINAL.has(job.state)) continue;
      if (['queued', 'preparing', 'uploading'].includes(job.state)) {
        this._enterQueue(job, { fromPreparing: true });
      } else if (['generating', 'downloading'].includes(job.state) && job.task) {
        this._run(job, { resumePolling: true });
      } else if (['keying', 'publishing'].includes(job.state)) {
        this._run(job, { resumeKeying: true });
      } else {
        // A state with no way to resume (e.g. generating without a task).
        this._fail(job, 'server_restarted', 'Interrupted by a server restart.');
      }
    }
  }

  // --- public API ------------------------------------------------------------

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 50);
  }

  get(id) { return this.jobs.get(id) || null; }

  activeJobForPreset(presetId) {
    return [...this.jobs.values()].find(job => job.presetId === presetId && ACTIVE.has(job.state)) || null;
  }

  // Create a job for a preset+route. `context` carries the resolved reference
  // path, character source, prompt, orientation, options and sent geometry
  // inputs the caller has already validated.
  async create({ presetId, routeId, options = {}, referencePath, referenceDuration, trim, characterSource, prompt, orientation }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const route = this.deps.registry.get(routeId);
    const job = {
      id,
      presetId,
      presetName: presetsModule.getPreset(presetId) ? presetsModule.getPreset(presetId).name : presetId,
      routeId,
      routeLabel: route ? route.label : routeId,
      providerId: route ? route.provider : null,
      state: 'queued',
      providerStatus: null,
      progress: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      options: options || {},
      orientation: orientation || null,
      prompt: prompt || null,
      reference: {
        duration: referenceDuration ?? null,
        trimStart: trim ? trim.start : null,
        trimEnd: trim ? trim.end : null,
        sentSeconds: null,
      },
      // Inputs the pipeline needs but that are not part of JobView:
      _sourceReferencePath: referencePath,
      _characterSource: characterSource,
      estimateUsd: null,
      error: null,
      warnings: [],
      task: null,
      geometry: null,
      keyColor: null,
      media: null,
    };
    this.jobs.set(id, job);
    await this._writeJob(job);
    await this._evictOldJobs();
    this._enterQueue(job, { fromPreparing: true });
    return job;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL.has(job.state)) return { conflict: true, job };
    const controller = this.controllers.get(id);
    if (controller) controller.abort();
    this._killChild(id);
    const wasRunningSlot = ['preparing', 'uploading', 'generating', 'downloading'].includes(job.state);
    await this._touch(job, { state: 'canceled', progress: null, finishedAt: new Date().toISOString(), error: { code: 'canceled', message: 'Canceled.' } });
    if (wasRunningSlot) this._releaseSlot();
    // A cancel may have freed a slot; let a queued job start.
    this._pump();
    return { job };
  }

  // Retry a failed/canceled job. Rules:
  //   generated.mp4 present && !regenerate -> restart at keying
  //   task present && !regenerate          -> resume polling
  //   else full restart (new submission)
  async retry(id, { regenerate = false } = {}) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (ACTIVE.has(job.state)) return { conflict: true, job };
    const generatedPath = path.join(this.jobDir(id), 'generated.mp4');
    const hasGenerated = fs.existsSync(generatedPath);
    await this._touch(job, { error: null, finishedAt: null, progress: null });
    if (hasGenerated && !regenerate) {
      // Re-key the existing generation. A new keying result is published again
      // and replaces this job's own previous motion (see _publish).
      await this._touch(job, { state: 'keying', _replacePreviousId: job.media ? job.media.id : null, media: null });
      this._run(job, { resumeKeying: true });
    } else if (job.task && !regenerate) {
      await this._touch(job, { state: 'generating' });
      this._run(job, { resumePolling: true });
    } else {
      // Full restart: drop the old task + generated file.
      await fsp.rm(generatedPath, { force: true }).catch(() => {});
      await this._touch(job, { state: 'queued', task: null, warnings: [] });
      this._enterQueue(job, { fromPreparing: true });
    }
    return { job };
  }

  // --- queue + slots ---------------------------------------------------------

  _enterQueue(job, opts) {
    job._pending = opts || {};
    if (job.state !== 'queued') { this._touch(job, { state: 'queued' }).catch(() => {}); }
    this._pump();
  }

  _pump() {
    if (this._closed) return;
    while (this.running < this.concurrency()) {
      const next = [...this.jobs.values()].find(job => job.state === 'queued' && job._pending && !job._started);
      if (!next) break;
      next._started = true;
      this.running += 1;
      this._run(next, next._pending);
    }
  }

  _releaseSlot() {
    if (this.running > 0) this.running -= 1;
  }

  _killChild(id) {
    const child = this.children.get(id);
    if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    this.children.delete(id);
  }

  // --- the run state machine -------------------------------------------------

  // Drives a job forward. `phase` selects the entry point for resume:
  //   { fromPreparing } | { resumePolling } | { resumeKeying }
  async _run(job, phase = {}) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const signal = controller.signal;
    let holdsSlot = phase.fromPreparing || phase.resumePolling; // preparing..downloading
    if (phase.resumePolling && !job._started) { job._started = true; this.running += 1; }
    if (phase.resumeKeying && !job._started) { job._started = false; }

    try {
      if (!job.startedAt) await this._touch(job, { startedAt: new Date().toISOString() });

      if (phase.fromPreparing) {
        await this._prepare(job, signal);
        await this._upload(job, signal);
        await this._generate(job, signal, { resume: false });
        await this._download(job, signal);
        this._releaseSlot(); holdsSlot = false;
        await this._keyAndPublish(job, signal);
      } else if (phase.resumePolling) {
        await this._generate(job, signal, { resume: true });
        await this._download(job, signal);
        this._releaseSlot(); holdsSlot = false;
        await this._keyAndPublish(job, signal);
      } else if (phase.resumeKeying) {
        await this._keyAndPublish(job, signal);
      }
    } catch (error) {
      if (holdsSlot) this._releaseSlot();
      if (this._closed) {
        // Server shutdown aborted us; leave job.json at its last persisted
        // (non-terminal) state so a restart resumes it. Do not mark canceled.
      } else if (signal.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        // Cancel already recorded the canceled state.
        if (!TERMINAL.has(job.state)) await this._touch(job, { state: 'canceled', error: { code: 'canceled', message: 'Canceled.' }, finishedAt: new Date().toISOString() });
      } else {
        const code = error.code && ERROR_CODES.has(error.code) ? error.code : 'generation_failed';
        await this._fail(job, code, error.message || 'Pipeline failed.', error.detail);
      }
    } finally {
      this.controllers.delete(job.id);
      this._killChild(job.id);
      if (!this._closed) this._pump();
    }
  }

  async _fail(job, code, message, detail) {
    await this._touch(job, { state: 'failed', progress: null, finishedAt: new Date().toISOString(), error: { code, message: safeMessage(message), detail: detail || undefined } });
  }

  _throwIfAborted(signal) {
    if (signal.aborted) throw Object.assign(new Error('Canceled.'), { name: 'AbortError', code: 'ABORT_ERR' });
  }

  async _addWarning(job, warning) {
    if (!warning) return;
    const warnings = [...(job.warnings || [])];
    if (!warnings.some(w => w.code === warning.code)) warnings.push(warning);
    await this._touch(job, { warnings });
  }

  // preparing: composite the character + preprocess the reference.
  async _prepare(job, signal) {
    this._throwIfAborted(signal);
    await this._touch(job, { state: 'preparing', providerStatus: null });
    const route = this._route(job);
    const dir = this.jobDir(job.id);
    await fsp.mkdir(dir, { recursive: true });

    // Character composite -> character-key.png.
    const charSource = job._characterSource || this.deps.characterSource();
    if (!charSource) throw Object.assign(new Error('No character image.'), { code: 'character_missing' });
    const characterKeyPath = path.join(dir, 'character-key.png');
    const composite = await media.compositeCharacter(
      this.deps.ffmpegPath, this.deps.ffprobePath, charSource, route.limits || {}, characterKeyPath, { timeoutMs: 5 * 60 * 1000 });
    await this._touch(job, { geometry: composite.geometry });
    if (!composite.sourceHasAlpha) {
      await this._addWarning(job, { code: 'character_no_alpha', message: 'Character image has no transparency.' });
    }

    // Reference preprocess -> reference.mp4.
    this._throwIfAborted(signal);
    const referencePath = path.join(dir, 'reference.mp4');
    const maxSec = referenceMaxSec(route, job.orientation);
    const prep = await media.prepareReference(
      this.deps.ffmpegPath, this.deps.ffprobePath, job._sourceReferencePath, referencePath,
      { trimStart: job.reference.trimStart, trimEnd: job.reference.trimEnd, minSec: route.limits ? route.limits.videoMinSec : null, maxSec, timeoutMs: 5 * 60 * 1000 });
    for (const warning of prep.warnings) await this._addWarning(job, warning);
    const reference = { ...job.reference, sentSeconds: prep.sentSeconds };
    const estimateUsd = this.deps.registry.estimateUsd(route, prep.sentSeconds, job.options);
    await this._touch(job, { reference, estimateUsd });
  }

  // uploading: image via provider upload(); video via provider upload() or the
  // media relay for needsPublicVideoUrl adapters. The mock returns local paths.
  async _upload(job, signal) {
    this._throwIfAborted(signal);
    await this._touch(job, { state: 'uploading' });
    const route = this._route(job);
    const adapter = this._adapter(job);
    const dir = this.jobDir(job.id);
    const ctx = this._ctx(job, signal);
    try {
      const imageFile = fileDesc(path.join(dir, 'character-key.png'), 'character-key.png', 'image/png');
      const imageUrl = await adapter.upload(ctx, imageFile);
      const referenceFile = fileDesc(path.join(dir, 'reference.mp4'), 'reference.mp4', 'video/mp4');
      let videoUrl;
      if (adapter.meta.needsPublicVideoUrl) {
        const relayId = this.deps.configStore.resolveMediaRelay();
        if (!relayId) throw Object.assign(new Error('No media relay configured.'), { code: 'no_media_relay' });
        const relay = this.deps.configStore.providers[relayId];
        const relayCtx = this._ctxFor(relayId, signal);
        videoUrl = await relay.upload(relayCtx, referenceFile);
      } else {
        videoUrl = await adapter.upload(ctx, referenceFile);
      }
      job._uploaded = { imageUrl, videoUrl };
    } catch (error) {
      if (error.code === 'no_media_relay') throw error;
      throw Object.assign(new Error(error.message || 'Upload failed.'), { code: 'upload_failed' });
    }
  }

  // generating: submit ONCE, persist the task, then poll to a terminal state.
  async _generate(job, signal, { resume }) {
    this._throwIfAborted(signal);
    await this._touch(job, { state: 'generating' });
    const route = this._route(job);
    const adapter = this._adapter(job);
    const ctx = this._ctx(job, signal);

    if (!resume || !job.task) {
      // Build the request and submit exactly once.
      const preset = presetsModule.getPreset(job.presetId);
      const promptSuffix = this.deps.configStore.config.promptSuffix;
      const prompt = route.fields && route.fields.prompt
        ? presetsModule.composePrompt(preset, this._promptOverride(job), promptSuffix)
        : null;
      const input = {
        imageUrl: job._uploaded.imageUrl,
        videoUrl: job._uploaded.videoUrl,
        prompt,
        orientation: job.orientation,
        options: job.options,
      };
      // buildRequest is exercised for real routes; the mock reads input directly.
      try { this.deps.registry.buildRequest(route, input); } catch { /* mock/no-op */ }
      let task;
      try {
        task = await adapter.submit(ctx, route, input);
      } catch (error) {
        throw Object.assign(new Error(error.message || 'Submit failed.'), { code: error.code && ERROR_CODES.has(error.code) ? error.code : 'submit_failed' });
      }
      await this._touch(job, { task, prompt: prompt ?? job.prompt });
    }

    // Poll loop.
    const interval = this.pollIntervalMs || adapter.meta.pollIntervalMs || 5000;
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let consecutiveErrors = 0;
    while (true) {
      this._throwIfAborted(signal);
      if (Date.now() > deadline) throw Object.assign(new Error('Generation timed out.'), { code: 'timeout' });
      let result;
      try {
        result = await adapter.poll(ctx, route, job.task);
        consecutiveErrors = 0;
      } catch (error) {
        if (error && error.retryable) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            throw Object.assign(new Error('Generation failed after repeated poll errors.'), { code: 'generation_failed' });
          }
          await this._sleep(Math.min(interval * consecutiveErrors, 30000), signal);
          continue;
        }
        throw Object.assign(new Error(error.message || 'Generation failed.'), { code: 'generation_failed' });
      }
      if (result.providerStatus && result.providerStatus !== job.providerStatus) {
        await this._touch(job, { providerStatus: result.providerStatus });
      }
      if (result.moderated || result.state === 'failed' && result.moderated) {
        throw Object.assign(new Error('Content was moderated.'), { code: 'moderation' });
      }
      if (result.state === 'succeeded') { job._outputUrl = result.outputUrl; return; }
      if (result.state === 'failed') throw Object.assign(new Error(result.error || 'Generation failed.'), { code: result.moderated ? 'moderation' : 'generation_failed' });
      if (result.state === 'canceled') throw Object.assign(new Error('Canceled remotely.'), { name: 'AbortError', code: 'ABORT_ERR' });
      await this._sleep(interval, signal);
    }
  }

  // downloading: fetch the generated video into generated.mp4.
  async _download(job, signal) {
    this._throwIfAborted(signal);
    await this._touch(job, { state: 'downloading' });
    const route = this._route(job);
    const adapter = this._adapter(job);
    const ctx = this._ctx(job, signal);
    const dest = path.join(this.jobDir(job.id), 'generated.mp4');
    try {
      await adapter.download(ctx, job._outputUrl, dest);
    } catch (error) {
      throw Object.assign(new Error(error.message || 'Download failed.'), { code: 'download_failed' });
    }
  }

  // keying + publishing (no generation slot held; uses the shared encoder slot).
  async _keyAndPublish(job, signal) {
    this._throwIfAborted(signal);
    await this._key(job, signal);
    await this._publish(job, signal);
    await this._touch(job, { state: 'done', progress: null, finishedAt: new Date().toISOString() });
  }

  async _key(job, signal) {
    this._throwIfAborted(signal);
    await this._touch(job, { state: 'keying', progress: 0 });
    const dir = this.jobDir(job.id);
    const generatedPath = path.join(dir, 'generated.mp4');
    const geometry = job.geometry;
    if (!geometry) throw Object.assign(new Error('Missing geometry for keying.'), { code: 'keying_failed' });

    // Determine key colour: config colour, or auto-detect from the frame.
    const configColor = this.deps.configStore.config.keying.color;
    let color = configColor;
    if (configColor === 'auto') {
      const probe = await media.probeVideo(this.deps.ffprobePath, generatedPath);
      const detected = await media.detectKeyColor(this.deps.ffmpegPath, generatedPath, probe ? probe.duration : 2);
      color = detected.color;
      if (detected.warning) await this._addWarning(job, detected.warning);
    }
    const keying = this.deps.configStore.config.keying;
    const params = normalizeChromaParams({ color, similarity: keying.similarity, blend: keying.blend, despill: keying.despill });

    // Filter: scale to sent (contain) + pad to sent, crop the content rect,
    // scale to canvas, then the shared chroma filter (yuva420p).
    const { sent, content, canvas } = geometry;
    const prefix =
      `scale=${sent.w}:${sent.h}:force_original_aspect_ratio=decrease,` +
      `pad=${sent.w}:${sent.h}:(ow-iw)/2:(oh-ih)/2:color=0x${params.color.slice(1)},` +
      `crop=${content.w}:${content.h}:${content.x}:${content.y},` +
      `scale=${canvas.w}:${canvas.h}`;
    const filter = chromaFilter(params, 'yuva420p', prefix);

    // Wait for the shared encoder slot (canceling aborts the wait).
    const release = await this.deps.encoderSlot.acquire(`animate:${job.id}`, signal);
    try {
      this._throwIfAborted(signal);
      const probe = await media.probeVideo(this.deps.ffprobePath, generatedPath);
      const duration = probe && probe.duration ? probe.duration : null;
      const outPath = path.join(dir, 'motion.webm');
      const tmpPath = path.join(dir, `motion.${crypto.randomUUID()}.tmp.webm`);
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', generatedPath,
        '-vf', filter, ...VP9_ARGS, '-progress', 'pipe:1', '-nostats', tmpPath];
      const onProgress = (line) => {
        const m = /^out_time_us=(-?\d+)/.exec(line);
        if (m && duration && duration > 0) {
          const us = Number(m[1]);
          if (Number.isFinite(us) && us >= 0) {
            job.progress = Math.min(0.99, (us / 1e6) / duration);
          }
        }
      };
      const { child, done } = media.spawnEncode(this.deps.ffmpegPath, args, {
        timeoutMs: 30 * 60 * 1000,
        onProgress,
        register: (c) => this.children.set(job.id, c),
      });
      const result = await done;
      this.children.delete(job.id);
      if (signal.aborted) { await fsp.rm(tmpPath, { force: true }).catch(() => {}); throw Object.assign(new Error('Canceled.'), { name: 'AbortError', code: 'ABORT_ERR' }); }
      if (result.timedOut || result.code !== 0) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
        throw Object.assign(new Error(media.tidy(result.stderr) || 'Keying failed.'), { code: 'keying_failed' });
      }
      // Verify alpha survived.
      const alphaProbe = await media.run(this.deps.ffprobePath, [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_tags=alpha_mode', '-of', 'default=nw=1', tmpPath,
      ], { timeoutMs: 30000 });
      if (!/alpha_mode=1/.test(alphaProbe.stdout.toString())) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
        throw Object.assign(new Error('Keying produced no alpha channel.'), { code: 'keying_failed' });
      }
      await fsp.rename(tmpPath, outPath);
      await this._touch(job, { progress: 1, keyColor: params.color });
    } finally {
      release();
    }
  }

  async _publish(job, signal) {
    this._throwIfAborted(signal);
    if (!this.deps.configStore.config.autoPublish) return;
    // Skip if already published (restart resume in publishing with job.media).
    if (job.media) return;
    await this._touch(job, { state: 'publishing' });
    const preset = presetsModule.getPreset(job.presetId);
    const name = preset ? preset.name : job.presetName;
    const newId = crypto.randomUUID();
    const targetPath = this.deps.mediaPathFor(newId);
    try {
      await fsp.copyFile(path.join(this.jobDir(job.id), 'motion.webm'), targetPath);
      const item = {
        id: newId,
        name,
        kind: 'motion',
        mime: 'video/webm',
        url: `/api/media/${newId}`,
        createdAt: new Date().toISOString(),
      };
      await this.deps.commitLibraryItem(item);
      // A re-key replaces this job's own previous motion; replaceExisting also
      // removes the preset's motion from an earlier job.
      const ownPrevious = job._replacePreviousId || null;
      const previous = ownPrevious || this._lastPublishedIdForPreset(job.presetId, job.id);
      if (previous && (ownPrevious || this.deps.configStore.config.replaceExisting) && this.deps.findMediaItem(previous)) {
        await this.deps.removeMediaItem(previous).catch(() => {});
      }
      await this._touch(job, { media: { id: item.id, name: item.name, url: item.url }, _replacePreviousId: null });
    } catch (error) {
      await fsp.rm(targetPath, { force: true }).catch(() => {});
      throw Object.assign(new Error(error.message || 'Publish failed.'), { code: 'publish_failed' });
    }
  }

  // The most recently published media id for this preset from an EARLIER job.
  _lastPublishedIdForPreset(presetId, exceptJobId) {
    const prior = [...this.jobs.values()]
      .filter(job => job.presetId === presetId && job.id !== exceptJobId && job.media)
      .sort((a, b) => String(b.finishedAt || b.updatedAt).localeCompare(String(a.finishedAt || a.updatedAt)));
    return prior.length ? prior[0].media.id : null;
  }

  // --- helpers ---------------------------------------------------------------

  _route(job) {
    const route = this.deps.registry.get(job.routeId);
    if (!route) throw Object.assign(new Error('Route is no longer available.'), { code: 'submit_failed' });
    return route;
  }

  _adapter(job) {
    const route = this._route(job);
    const adapter = this.deps.configStore.providers[route.provider];
    if (!adapter) throw Object.assign(new Error('Provider is unavailable.'), { code: 'submit_failed' });
    return adapter;
  }

  _promptOverride(job) {
    const settings = this.deps.presetStore.get(job.presetId);
    return settings ? settings.prompt : null;
  }

  _ctx(job, signal) {
    const route = this.deps.registry.get(job.routeId);
    return this._ctxFor(route.provider, signal, job);
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
    // The mock provider renders on download() and needs the local inputs.
    if (providerId === 'mock' && job) {
      const dir = this.jobDir(job.id);
      ctx.mock = {
        imagePath: path.join(dir, 'character-key.png'),
        width: job.geometry ? job.geometry.sent.w : null,
        height: job.geometry ? job.geometry.sent.h : null,
        duration: job.reference ? job.reference.sentSeconds : null,
        ffmpegPath: this.deps.ffmpegPath,
      };
    }
    return ctx;
  }

  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { cleanup(); reject(Object.assign(new Error('Canceled.'), { name: 'AbortError', code: 'ABORT_ERR' })); };
      const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async _evictOldJobs() {
    const all = [...this.jobs.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let removable = all.filter(job => TERMINAL.has(job.state));
    while (this.jobs.size > MAX_JOBS && removable.length) {
      const victim = removable.shift();
      this.jobs.delete(victim.id);
      await fsp.rm(this.jobDir(victim.id), { recursive: true, force: true }).catch(() => {});
    }
  }

  // JobView for the API.
  view(job) {
    return {
      id: job.id,
      presetId: job.presetId,
      presetName: job.presetName,
      routeId: job.routeId,
      routeLabel: job.routeLabel,
      providerId: job.providerId,
      state: job.state,
      providerStatus: job.providerStatus || null,
      progress: job.state === 'keying' ? job.progress : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      options: job.options || {},
      orientation: job.orientation || null,
      prompt: job.prompt || null,
      reference: {
        duration: job.reference ? job.reference.duration : null,
        trimStart: job.reference ? job.reference.trimStart : null,
        trimEnd: job.reference ? job.reference.trimEnd : null,
        sentSeconds: job.reference ? job.reference.sentSeconds : null,
      },
      estimateUsd: job.estimateUsd ?? null,
      error: job.error || null,
      warnings: job.warnings || [],
      canRetry: TERMINAL.has(job.state) && job.state !== 'done',
      canResume: TERMINAL.has(job.state) && (fs.existsSync(path.join(this.jobDir(job.id), 'generated.mp4')) || (job.state !== 'done' && !!job.task)),
      generatedUrl: fs.existsSync(path.join(this.jobDir(job.id), 'generated.mp4')) ? `/api/animate/jobs/${job.id}/generated` : null,
      resultUrl: fs.existsSync(path.join(this.jobDir(job.id), 'motion.webm')) ? `/api/animate/jobs/${job.id}/result` : null,
      media: job.media || null,
    };
  }

  hasGenerated(id) { return fs.existsSync(path.join(this.jobDir(id), 'generated.mp4')); }
  generatedPath(id) { return path.join(this.jobDir(id), 'generated.mp4'); }
  resultPath(id) { return path.join(this.jobDir(id), 'motion.webm'); }

  async close() {
    this._closed = true;
    for (const controller of this.controllers.values()) { try { controller.abort(); } catch { /* gone */ } }
    for (const child of this.children.values()) { if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
    this.children.clear();
  }
}

const ERROR_CODES = new Set([
  'no_credentials', 'no_media_relay', 'reference_missing', 'reference_too_short', 'character_missing',
  'upload_failed', 'submit_failed', 'generation_failed', 'moderation', 'timeout', 'download_failed',
  'keying_failed', 'publish_failed', 'server_restarted', 'canceled',
]);

function referenceMaxSec(route, orientation) {
  const limits = route.limits || {};
  if (limits.videoMaxSecByOrientation && orientation && limits.videoMaxSecByOrientation[orientation] != null) {
    return limits.videoMaxSecByOrientation[orientation];
  }
  return limits.videoMaxSec != null ? limits.videoMaxSec : null;
}

function fileDesc(filePath, filename, contentType) {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { /* not yet */ }
  return { path: filePath, filename, contentType, size };
}

// Strip anything that looks like a secret / absolute path from an error message.
function safeMessage(message) {
  let text = String(message || '').replace(/(\/[^\s"']+)/g, m => path.basename(m));
  if (text.length > 300) text = text.slice(0, 300);
  return text;
}

module.exports = { Pipeline, STATES, TERMINAL, ACTIVE, ERROR_CODES };
