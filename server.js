'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const {
  CHROMA_DEFAULTS,
  CHROMA_LIMITS,
  CHROMA_EXTENSIONS,
  VP9_ARGS,
  normalizeChromaParams,
  chromaFilter,
  chromaCommand,
} = require('./lib/chroma-encode');
const { EncoderSlot } = require('./lib/encoder-slot');
const presetsModule = require('./lib/animate/presets');
const animateMedia = require('./lib/animate/media');
const { ConfigStore } = require('./lib/animate/config');
const { Registry } = require('./lib/animate/registry');
const { Pipeline } = require('./lib/animate/pipeline');
const realProviders = require('./lib/animate/providers');
const mockProvider = require('./lib/animate/providers/mock');

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const ANIMATE_REFERENCE_MAX = 500 * 1024 * 1024;
const ANIMATE_CHARACTER_MAX = 30 * 1024 * 1024;
const REFERENCE_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const CHARACTER_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg'];
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/overlay', ['overlay.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/chroma.js', ['chroma.js', 'text/javascript; charset=utf-8']],
  ['/animate.js', ['animate.js', 'text/javascript; charset=utf-8']],
  ['/overlay.css', ['overlay.css', 'text/css; charset=utf-8']],
  ['/overlay.js', ['overlay.js', 'text/javascript; charset=utf-8']],
]);

// --- Chroma key -> transparent WebM job API -----------------------------------
// The chroma defaults/limits/extensions, param normaliser and filter builder now
// live in lib/chroma-encode.js and are shared with the animate pipeline so both
// produce byte-identical keying. Only the server-local job constants stay here.

const CHROMA_MAX_JOBS = 6;
const CHROMA_FRAME_TIMEOUT_MS = 20000;
const CHROMA_STDOUT_CAP = 64 * 1024 * 1024;
const JOB_ID_RE = /^[0-9a-f-]{36}$/;

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function sanitizeName(value) {
  const cleaned = String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || 'Untitled motion';
}

function mediaType(kind, name, contentType) {
  const ext = path.extname(name).toLowerCase();
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  if (ext === '.webm' && (mime === 'video/webm' || mime === 'application/octet-stream' || !mime)) {
    return { ext: '.webm', mime: 'video/webm' };
  }
  if (kind === 'idle' && ext === '.png' && (mime === 'image/png' || mime === 'application/octet-stream' || !mime)) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (kind === 'idle' && ext === '.webp' && (mime === 'image/webp' || mime === 'application/octet-stream' || !mime)) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

async function hasExpectedSignature(filePath, ext) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (ext === '.webm') return bytesRead >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (ext === '.png') return bytesRead >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === '.webp') return bytesRead >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    return false;
  } finally {
    await handle.close();
  }
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function receiveFile(req, target) {
  const output = fs.createWriteStream(target, { flags: 'wx' });
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        break;
      }
      if (!output.write(chunk)) await once(output, 'drain');
    }
    if (tooLarge) throw Object.assign(new Error('File exceeds 500 MB'), { status: 413 });
    output.end();
    await once(output, 'finish');
    if (total === 0) throw Object.assign(new Error('Empty file'), { status: 400 });
  } catch (error) {
    output.destroy();
    await fsp.rm(target, { force: true });
    throw error;
  }
}

async function serveMedia(req, res, filePath, mime) {
  const stat = await fsp.stat(filePath);
  const range = req.headers.range;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    const end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const last = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${last}/${stat.size}`, 'Content-Length': last - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end: last }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

// Run ffprobe/ffmpeg to completion, buffering stdout (capped) and stderr.
// Resolves { code, stdout, stderr }. Rejects only on spawn error (ENOENT).
function runToBuffer(command, args, { stdoutCap = CHROMA_STDOUT_CAP } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outLen = 0;
    let stderr = '';
    let overflow = false;
    child.stdout.on('data', chunk => {
      outLen += chunk.length;
      if (outLen > stdoutCap) { overflow = true; child.kill('SIGKILL'); return; }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr, overflow, killed: child.killed }));
  });
}

// Trim ffmpeg stderr into a short, path-free error message (<= 300 chars).
function tidyFfmpegError(stderr) {
  const lines = String(stderr || '').split('\n').map(line => line.trim()).filter(Boolean);
  let message = lines.slice(-3).join(' ') || 'ffmpeg failed.';
  // Replace absolute paths with basenames to avoid leaking the work dir.
  message = message.replace(/(\/[^\s"']+)/g, match => path.basename(match));
  if (message.length > 300) message = message.slice(0, 300);
  return message;
}

// Parse ffprobe -show_streams JSON into the Job source shape. Applies rotation
// (displaymatrix) to width/height and normalizes fps to two decimals.
function parseVideoStream(probeJson) {
  const streams = (probeJson && probeJson.streams) || [];
  const video = streams.find(stream => stream.codec_type === 'video');
  if (!video) return null;
  let width = Number(video.width) || null;
  let height = Number(video.height) || null;
  // Rotation from side_data displaymatrix: swap when +-90/270.
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  const matrix = sideData.find(entry => entry.rotation != null || entry.side_data_type === 'Display Matrix');
  if (matrix && matrix.rotation != null) {
    const rotation = ((Number(matrix.rotation) % 360) + 360) % 360;
    if (rotation === 90 || rotation === 270) { const t = width; width = height; height = t; }
  }
  const duration = Number(video.duration) || (probeJson.format && Number(probeJson.format.duration)) || null;
  let fps = null;
  const rate = video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate;
  if (rate && rate.includes('/')) {
    const [num, den] = rate.split('/').map(Number);
    if (num && den) fps = Number((num / den).toFixed(2));
  }
  return {
    width,
    height,
    duration: Number.isFinite(duration) ? duration : null,
    fps,
    codec: video.codec_name || null,
  };
}

async function createAppServer({ dataDir = path.join(__dirname, 'data'), ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', animateMock = process.env.VIRTUALLY_ANIMATE_MOCK === '1', animatePollIntervalMs = null } = {}) {
  const mediaDir = path.join(dataDir, 'media');
  const manifestPath = path.join(dataDir, 'library.json');
  await fsp.mkdir(mediaDir, { recursive: true });
  let library = { idle: null, motions: [] };
  try {
    const stored = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (stored && Array.isArray(stored.motions)) library = { idle: stored.idle || null, motions: stored.motions };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const clients = new Set();
  let sequence = 0;
  let mutation = Promise.resolve();

  // One encode at a time across the chroma converter AND the animate pipeline.
  const encoderSlot = new EncoderSlot();

  // --- Chroma key job state ---------------------------------------------------
  const workDir = path.join(dataDir, 'work');
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });
  const jobs = new Map(); // id -> job object
  const jobChildren = new Map(); // id -> currently running ffmpeg child
  let ffmpegProbe = null; // cached { available, ffmpegVersion, reason }

  async function probeFfmpeg() {
    if (ffmpegProbe) return ffmpegProbe;
    try {
      const version = await runToBuffer(ffmpegPath, ['-hide_banner', '-version']);
      if (version.code !== 0) throw new Error('ffmpeg did not run.');
      const probe = await runToBuffer(ffprobePath, ['-hide_banner', '-version']);
      if (probe.code !== 0) throw new Error('ffprobe did not run.');
      const encoders = await runToBuffer(ffmpegPath, ['-hide_banner', '-encoders']);
      if (!/\blibvpx-vp9\b/.test(encoders.stdout.toString())) throw new Error('ffmpeg lacks the libvpx-vp9 encoder.');
      const filters = await runToBuffer(ffmpegPath, ['-hide_banner', '-filters']);
      if (!/\bchromakey\b/.test(filters.stdout.toString())) throw new Error('ffmpeg lacks the chromakey filter.');
      const firstLine = version.stdout.toString().split('\n')[0] || '';
      const match = /ffmpeg version (\S+)/.exec(firstLine);
      ffmpegProbe = { available: true, ffmpegVersion: match ? match[1] : firstLine.trim() || 'unknown', reason: null };
    } catch (error) {
      ffmpegProbe = { available: false, ffmpegVersion: null, reason: error.code === 'ENOENT' ? 'ffmpeg or ffprobe was not found.' : (error.message || 'ffmpeg is unavailable.') };
    }
    return ffmpegProbe;
  }

  function jobDir(id) { return path.join(workDir, id); }

  function jobView(job) {
    return {
      id: job.id,
      name: job.name,
      createdAt: job.createdAt,
      source: job.source,
      state: job.state,
      progress: job.progress,
      params: job.params,
      command: job.command,
      error: job.error,
      result: job.result,
      frameUrl: `/api/chroma/jobs/${job.id}/frame`,
      previewUrl: `/api/chroma/jobs/${job.id}/preview`,
    };
  }

  async function evictOldJobs() {
    while (jobs.size > CHROMA_MAX_JOBS) {
      // Oldest non-converting job first.
      const victim = [...jobs.values()]
        .filter(job => job.state !== 'converting')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!victim) break;
      jobs.delete(victim.id);
      await fsp.rm(jobDir(victim.id), { recursive: true, force: true }).catch(() => {});
    }
  }

  function killJobChild(id) {
    const child = jobChildren.get(id);
    if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    jobChildren.delete(id);
  }

  // Release the shared encoder slot a chroma convert holds. Idempotent: the
  // convert's release fn resets to null so cancel + close never double-release.
  function releaseChromaSlot(job) {
    if (job && typeof job.slotRelease === 'function') {
      const release = job.slotRelease;
      job.slotRelease = null;
      release();
    }
  }

  function enqueue(callback) {
    const next = mutation.then(callback);
    mutation = next.catch(() => {});
    return next;
  }
  function broadcast(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) {
      if (client.destroyed || client.writableEnded) {
        clients.delete(client);
        continue;
      }
      try {
        client.write(line);
      } catch {
        clients.delete(client);
      }
    }
  }
  async function save(next) {
    const temporary = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(next, null, 2) + '\n');
      await fsp.rename(temporary, manifestPath);
      library = next;
    } finally {
      await fsp.rm(temporary, { force: true });
    }
    broadcast({ type: 'library', library });
  }

  // Commit a fully-formed library item (its media file already at its final
  // path). Shared by /api/upload and chroma publish so their semantics match:
  // motions append; an idle replaces and deletes the previous idle's file.
  async function commitLibraryItem(item) {
    let priorIdle;
    await enqueue(async () => {
      priorIdle = library.idle;
      const next = item.kind === 'idle'
        ? { ...library, idle: item }
        : { ...library, motions: [...library.motions, item] };
      await save(next);
    });
    if (item.kind === 'idle' && priorIdle) {
      const previousExt = priorIdle.mime === 'image/png' ? '.png' : priorIdle.mime === 'image/webp' ? '.webp' : '.webm';
      await fsp.rm(path.join(mediaDir, `${priorIdle.id}${previousExt}`), { force: true }).catch(() => {});
    }
    return item;
  }

  // Remove a library item by id with the SAME semantics as DELETE /api/media/:id
  // (used by the animate pipeline's replaceExisting publish path).
  async function removeMediaItem(id) {
    let removed;
    await enqueue(async () => {
      removed = [library.idle, ...library.motions].find(item => item && item.id === id);
      if (!removed) return;
      const next = { idle: library.idle?.id === id ? null : library.idle, motions: library.motions.filter(item => item.id !== id) };
      await save(next);
    });
    if (!removed) return false;
    const ext = removed.mime === 'image/png' ? '.png' : removed.mime === 'image/webp' ? '.webp' : '.webm';
    await fsp.rm(path.join(mediaDir, `${id}${ext}`), { force: true });
    return true;
  }

  function findMediaItem(id) {
    return [library.idle, ...library.motions].find(item => item && item.id === id) || null;
  }

  function mediaPathForItem(item) {
    const ext = item.mime === 'image/png' ? '.png' : item.mime === 'image/webp' ? '.webp' : '.webm';
    return path.join(mediaDir, `${item.id}${ext}`);
  }

  // --- Animate motion presets -------------------------------------------------
  const animateDir = path.join(dataDir, 'animate');
  const referencesDir = path.join(animateDir, 'references');
  await fsp.mkdir(referencesDir, { recursive: true });
  // Providers map: the real adapters always; the mock only when enabled.
  const animateProviders = { ...realProviders };
  if (animateMock) animateProviders.mock = mockProvider;

  const configStore = await new ConfigStore(path.join(animateDir, 'providers.json'), animateProviders).load();
  const presetStore = await new presetsModule.PresetStore(path.join(animateDir, 'presets.json')).load();
  const registry = await new Registry(configStore, {
    customRoutesPath: path.join(animateDir, 'custom-routes.json'),
    mockEnabled: animateMock,
  }).load();

  // Resolve the character source: uploaded character image > library idle image
  // (png/webp) > library idle webm (first frame). Returns { path, ext, isImage }
  // or null.
  async function resolveCharacterSource() {
    // Uploaded character animate/character.<ext> wins.
    for (const ext of CHARACTER_EXTENSIONS) {
      const candidate = path.join(animateDir, `character${ext}`);
      if (fs.existsSync(candidate)) return { path: candidate, ext, isImage: true };
    }
    const idle = library.idle;
    if (idle) {
      const idlePath = mediaPathForItem(idle);
      if (fs.existsSync(idlePath)) {
        if (idle.mime === 'image/png') return { path: idlePath, ext: '.png', isImage: true };
        if (idle.mime === 'image/webp') return { path: idlePath, ext: '.webp', isImage: true };
        return { path: idlePath, ext: '.webm', isImage: false };
      }
    }
    return null;
  }

  const pipeline = new Pipeline({
    dataDir,
    ffmpegPath,
    ffprobePath,
    registry,
    configStore,
    presetStore,
    encoderSlot,
    probeFfmpeg,
    commitLibraryItem,
    removeMediaItem,
    findMediaItem,
    characterSource: () => null,
    mediaPathFor: (id) => path.join(mediaDir, `${id}.webm`),
    pollIntervalMs: animatePollIntervalMs,
  });
  await pipeline.init();

  function requireJson(req) {
    if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
      throw Object.assign(new Error('Expected application/json.'), { status: 415 });
    }
  }

  function safeErr(message) {
    return String(message || '').replace(/(\/[^\s"']+)/g, m => path.basename(m)).slice(0, 240) || null;
  }

  function mimeForExt(ext) {
    return { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }[ext] || 'application/octet-stream';
  }

  // Larger receiveFile with a caller-set byte cap (character uploads are 30 MB).
  async function receiveFileWithLimit(req, target, limit) {
    const output = fs.createWriteStream(target, { flags: 'wx' });
    let total = 0;
    let tooLarge = false;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > limit) { tooLarge = true; break; }
        if (!output.write(chunk)) await once(output, 'drain');
      }
      if (tooLarge) throw Object.assign(new Error('File too large.'), { status: 413 });
      output.end();
      await once(output, 'finish');
      if (total === 0) throw Object.assign(new Error('Empty file'), { status: 400 });
    } catch (error) {
      output.destroy();
      await fsp.rm(target, { force: true }).catch(() => {});
      throw error;
    }
  }

  // The newest reference file for a preset (by mtime), or null.
  async function findReference(presetId) {
    let entries = [];
    try { entries = await fsp.readdir(referencesDir); } catch { return null; }
    const candidates = [];
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      if (path.basename(name, ext) !== presetId || !REFERENCE_EXTENSIONS.includes(ext)) continue;
      const full = path.join(referencesDir, name);
      try { const stat = await fsp.stat(full); candidates.push({ path: full, ext, name, size: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() }); } catch { /* gone */ }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0] || null;
  }

  async function removePresetReferences(presetId) {
    let entries = [];
    try { entries = await fsp.readdir(referencesDir); } catch { return; }
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      const base = path.basename(name, ext);
      // Remove `<presetId>.<ext>` (a real reference). Leave in-flight upload
      // tmp files alone — their own handler renames or removes them.
      if (base === presetId) {
        await fsp.rm(path.join(referencesDir, name), { force: true }).catch(() => {});
      }
    }
  }

  async function removeCharacterFiles() {
    let entries = [];
    try { entries = await fsp.readdir(animateDir); } catch { return; }
    for (const name of entries) {
      if (/^character(\.[0-9a-f-]+\.tmp)?\.(png|webp|jpg|jpeg)$/i.test(name)) {
        await fsp.rm(path.join(animateDir, name), { force: true }).catch(() => {});
      }
    }
  }

  async function presetView(presetId) {
    const preset = presetsModule.getPreset(presetId);
    const settings = presetStore.get(presetId);
    const ref = await findReference(presetId);
    let reference = null;
    if (ref) {
      const info = await animateMedia.probeVideo(ffprobePath, ref.path);
      reference = {
        filename: ref.name,
        size: ref.size,
        duration: info ? info.duration : null,
        width: info ? info.width : null,
        height: info ? info.height : null,
        fps: info ? info.fps : null,
        url: `/api/animate/references/${presetId}`,
        mtime: ref.mtime,
      };
    }
    // The most recent job for this preset -> lastJob.
    const jobsForPreset = pipeline.list().filter(job => job.presetId === presetId);
    const lastJob = jobsForPreset.length ? pipeline.view(jobsForPreset[0]) : null;
    return {
      id: preset.id,
      name: preset.name,
      orientation: preset.orientation,
      fullBody: preset.fullBody,
      prompt: presetsModule.composePrompt(preset, settings.prompt, configStore.config.promptSuffix),
      promptOverride: settings.prompt || null,
      reference,
      trim: { start: settings.trimStart, end: settings.trimEnd },
      lastJob,
    };
  }

  async function characterView() {
    const source = await resolveCharacterSource();
    if (!source) return { source: null, filename: null, width: null, height: null, hasAlpha: null, previewUrl: null };
    const uploaded = source.path.startsWith(animateDir) && path.basename(source.path).startsWith('character');
    const info = await animateMedia.probeVideo(ffprobePath, source.path);
    return {
      source: uploaded ? 'upload' : 'idle',
      filename: path.basename(source.path),
      width: info ? info.width : null,
      height: info ? info.height : null,
      hasAlpha: info ? !!info.hasAlpha : null,
      previewUrl: '/api/animate/character/preview',
    };
  }

  async function buildAnimateStatus() {
    const probe = await probeFfmpeg();
    const presets = [];
    for (const preset of presetsModule.listPresets()) presets.push(await presetView(preset.id));
    return {
      ffmpeg: { available: probe.available, reason: probe.reason },
      presets,
      character: await characterView(),
      routes: registry.routeViews(),
      providers: configStore.providerViews(),
      config: configStore.publicConfig(),
      referencesDir,
    };
  }

  // Create one chroma job from an existing local file (used by open-in-converter).
  async function createChromaJobFromFile(sourcePath, filename, label) {
    const ext = path.extname(filename).toLowerCase();
    const id = crypto.randomUUID();
    const dir = jobDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `input${ext}`);
    await fsp.copyFile(sourcePath, dest);
    const probed = await runToBuffer(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', dest]);
    let source = null;
    try { source = parseVideoStream(JSON.parse(probed.stdout.toString() || '{}')); } catch { source = null; }
    if (!source) { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); throw Object.assign(new Error('No video stream.'), { status: 409 }); }
    const stat = await fsp.stat(dest);
    const job = {
      id, name: sanitizeName(label || path.basename(filename, ext)), createdAt: new Date().toISOString(),
      ext, sourcePath: dest,
      source: { filename, size: stat.size, width: source.width, height: source.height, duration: source.duration, fps: source.fps, codec: source.codec },
      state: 'ready', progress: null, params: null, command: null, error: null, result: null,
    };
    jobs.set(id, job);
    await evictOldJobs();
    return jobView(job);
  }

  // POST /api/animate/jobs -> [status, body].
  async function createAnimateJobs(body) {
    const presetIds = body && Array.isArray(body.presetIds) ? body.presetIds : null;
    if (!presetIds || presetIds.length < 1 || presetIds.length > 9) {
      return [400, { error: 'presetIds must list 1..9 presets.' }];
    }
    const unknownPresets = presetIds.filter(id => !presetsModule.isPreset(id));
    if (unknownPresets.length) return [400, { error: 'Unknown preset.', code: 'unknown_preset', detail: { presetIds: unknownPresets } }];
    const routeId = body.routeId;
    const route = registry.get(routeId);
    if (!route) return [400, { error: 'Unknown route.', code: 'unknown_route' }];
    const avail = registry.availability(route);
    if (!avail.available) return [400, { error: 'Route unavailable.', code: avail.unavailableCode }];

    const probe = await probeFfmpeg();
    if (!probe.available) return [400, { error: 'ffmpeg unavailable.', code: 'ffmpeg_unavailable' }];

    const characterSource = await resolveCharacterSource();
    if (!characterSource) return [400, { error: 'No character image.', code: 'character_missing' }];

    // Every preset needs a reference and no active job.
    const missingRef = [];
    const busy = [];
    const refByPreset = new Map();
    for (const presetId of presetIds) {
      const ref = await findReference(presetId);
      if (!ref) { missingRef.push(presetId); continue; }
      refByPreset.set(presetId, ref);
      if (pipeline.activeJobForPreset(presetId)) busy.push(presetId);
    }
    if (missingRef.length) return [400, { error: 'Reference missing.', code: 'reference_missing', detail: { presetIds: missingRef } }];
    if (busy.length) return [409, { error: 'A preset already has an active job.', code: 'preset_busy', detail: { presetIds: busy } }];

    const options = body.options && typeof body.options === 'object' ? body.options : {};
    const created = [];
    for (const presetId of presetIds) {
      const preset = presetsModule.getPreset(presetId);
      const ref = refByPreset.get(presetId);
      const info = await animateMedia.probeVideo(ffprobePath, ref.path);
      const settings = presetStore.get(presetId);
      const prompt = route.fields && route.fields.prompt
        ? presetsModule.composePrompt(preset, settings.prompt, configStore.config.promptSuffix)
        : null;
      const job = await pipeline.create({
        presetId,
        routeId,
        options,
        referencePath: ref.path,
        referenceDuration: info ? info.duration : null,
        trim: { start: settings.trimStart, end: settings.trimEnd },
        characterSource,
        prompt,
        orientation: preset.orientation,
      });
      created.push(pipeline.view(job));
    }
    return [202, { jobs: created }];
  }

  const server = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const listeningAddress = server.address();
      if (listeningAddress && ['127.0.0.1', '::1'].includes(listeningAddress.address)) {
        const allowedHosts = new Set([`127.0.0.1:${listeningAddress.port}`, `localhost:${listeningAddress.port}`, `[::1]:${listeningAddress.port}`]);
        if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
          return sendJson(res, 403, { error: 'Invalid host.' });
        }
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        return sendJson(res, 403, { error: 'Cross-origin changes are not allowed.' });
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
        return sendJson(res, 403, { error: 'Cross-site changes are not allowed.' });
      }
      if (req.method === 'GET' && pathname === '/api/library') return sendJson(res, 200, library);
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const cleanup = () => { clearInterval(keepAlive); clients.delete(res); };
        const keepAlive = setInterval(() => {
          if (res.destroyed || res.writableEnded) return cleanup();
          try { res.write(': ping\n\n'); } catch { cleanup(); }
        }, 15000);
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
        clients.add(res);
        res.write(`data: ${JSON.stringify({ type: 'library', library })}\n\n`);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/upload') {
        const kind = url.searchParams.get('kind');
        const originalName = url.searchParams.get('name') || '';
        const filename = url.searchParams.get('filename') || originalName;
        const type = mediaType(kind, filename, req.headers['content-type']);
        if (!['idle', 'motion'].includes(kind) || !type) return sendJson(res, 415, { error: 'Upload a WebM motion, or a WebM/PNG/WebP idle asset.' });
        const declared = Number(req.headers['content-length']);
        if (declared > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: 'File exceeds 500 MB.' });
        const id = crypto.randomUUID();
        const filePath = path.join(mediaDir, `${id}${type.ext}`);
        await receiveFile(req, filePath);
        let committed = false;
        try {
          if (!(await hasExpectedSignature(filePath, type.ext))) throw Object.assign(new Error('File format does not match its extension.'), { status: 415 });
          const item = { id, name: sanitizeName(path.basename(originalName, type.ext)), kind, mime: type.mime, url: `/api/media/${id}`, createdAt: new Date().toISOString() };
          await commitLibraryItem(item);
          committed = true;
          return sendJson(res, 201, item);
        } catch (error) {
          if (!committed) await fsp.rm(filePath, { force: true });
          throw error;
        }
      }
      if (req.method === 'POST' && pathname === '/api/trigger') {
        if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
          return sendJson(res, 415, { error: 'Expected application/json.' });
        }
        const body = await readBody(req);
        if (!body || typeof body.id !== 'string') return sendJson(res, 400, { error: 'Motion id is required.' });
        if (body.id !== 'demo' && !library.motions.some(item => item.id === body.id)) return sendJson(res, 404, { error: 'Motion not found.' });
        const seq = ++sequence;
        broadcast({ type: 'play', id: body.id, seq });
        return sendJson(res, 200, { ok: true, seq });
      }
      if (req.method === 'DELETE' && pathname.startsWith('/api/media/')) {
        const id = pathname.slice('/api/media/'.length);
        if (!/^[0-9a-f-]{36}$/.test(id)) return sendJson(res, 404, { error: 'Media not found.' });
        let removed;
        await enqueue(async () => {
          removed = [library.idle, ...library.motions].find(item => item && item.id === id);
          if (!removed) return;
          const next = { idle: library.idle?.id === id ? null : library.idle, motions: library.motions.filter(item => item.id !== id) };
          await save(next);
        });
        if (!removed) return sendJson(res, 404, { error: 'Media not found.' });
        const ext = removed.mime === 'image/png' ? '.png' : removed.mime === 'image/webp' ? '.webp' : '.webm';
        await fsp.rm(path.join(mediaDir, `${id}${ext}`), { force: true });
        return sendJson(res, 200, { ok: true });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/media/')) {
        const id = pathname.slice('/api/media/'.length);
        const item = [library.idle, ...library.motions].find(value => value && value.id === id);
        if (!item) return sendJson(res, 404, { error: 'Media not found.' });
        const ext = item.mime === 'image/png' ? '.png' : item.mime === 'image/webp' ? '.webp' : '.webm';
        return serveMedia(req, res, path.join(mediaDir, `${id}${ext}`), item.mime);
      }
      // --- Chroma key routes -------------------------------------------------
      if (pathname === '/api/chroma/status' && req.method === 'GET') {
        const probe = await probeFfmpeg();
        return sendJson(res, 200, {
          available: probe.available,
          ffmpegVersion: probe.ffmpegVersion,
          reason: probe.reason,
          defaults: CHROMA_DEFAULTS,
          limits: CHROMA_LIMITS,
          acceptedExtensions: CHROMA_EXTENSIONS,
        });
      }

      if (pathname === '/api/chroma/jobs' && req.method === 'GET') {
        const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(jobView);
        return sendJson(res, 200, { jobs: list });
      }

      if (pathname === '/api/chroma/jobs' && req.method === 'POST') {
        const probe = await probeFfmpeg();
        if (!probe.available) return sendJson(res, 503, { error: 'ffmpeg is not available on this server.' });
        const filename = url.searchParams.get('filename') || '';
        const label = url.searchParams.get('name') || '';
        const ext = path.extname(filename).toLowerCase();
        if (!CHROMA_EXTENSIONS.includes(ext)) return sendJson(res, 415, { error: `Unsupported source type; use one of ${CHROMA_EXTENSIONS.join(', ')}.` });
        const declared = Number(req.headers['content-length']);
        if (declared > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: 'File exceeds 500 MB.' });

        const id = crypto.randomUUID();
        const dir = jobDir(id);
        await fsp.mkdir(dir, { recursive: true });
        const sourcePath = path.join(dir, `input${ext}`);
        try {
          await receiveFile(req, sourcePath);
          const probed = await runToBuffer(ffprobePath, [
            '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', sourcePath,
          ]);
          let source = null;
          try { source = parseVideoStream(JSON.parse(probed.stdout.toString() || '{}')); } catch { source = null; }
          if (!source) throw Object.assign(new Error('No video stream found in the uploaded file.'), { status: 415 });
          const stat = await fsp.stat(sourcePath);
          const job = {
            id,
            name: sanitizeName(path.basename(label || filename, ext)),
            createdAt: new Date().toISOString(),
            ext,
            sourcePath,
            source: { filename, size: stat.size, width: source.width, height: source.height, duration: source.duration, fps: source.fps, codec: source.codec },
            state: 'ready',
            progress: null,
            params: null,
            command: null,
            error: null,
            result: null,
          };
          jobs.set(id, job);
          await evictOldJobs();
          return sendJson(res, 201, jobView(job));
        } catch (error) {
          await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      }

      // Routes on a single job: /api/chroma/jobs/:id[/sub]
      const jobMatch = /^\/api\/chroma\/jobs\/([^/]+)(?:\/(frame|preview|convert|cancel|result|publish))?$/.exec(pathname);
      if (jobMatch) {
        const id = jobMatch[1];
        const sub = jobMatch[2];
        if (!JOB_ID_RE.test(id)) return sendJson(res, 404, { error: 'Job not found.' });
        const job = jobs.get(id);

        // GET /api/chroma/jobs/:id
        if (!sub && req.method === 'GET') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          return sendJson(res, 200, jobView(job));
        }

        // DELETE /api/chroma/jobs/:id
        if (!sub && req.method === 'DELETE') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          killJobChild(id);
          jobs.delete(id);
          await fsp.rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
          return sendJson(res, 200, { ok: true });
        }

        // GET /api/chroma/jobs/:id/frame?t= and /preview?...
        if ((sub === 'frame' || sub === 'preview') && req.method === 'GET') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          const probe = await probeFfmpeg();
          if (!probe.available) return sendJson(res, 503, { error: 'ffmpeg is not available on this server.' });

          let params = null;
          if (sub === 'preview') {
            // color may arrive as RRGGBB or URL-encoded #RRGGBB.
            const raw = {
              color: url.searchParams.has('color') ? url.searchParams.get('color') : undefined,
              similarity: url.searchParams.has('similarity') ? url.searchParams.get('similarity') : undefined,
              blend: url.searchParams.has('blend') ? url.searchParams.get('blend') : undefined,
              despill: url.searchParams.has('despill') ? url.searchParams.get('despill') : undefined,
            };
            params = normalizeChromaParams(raw); // throws 400 on bad params
          }

          let t = Number(url.searchParams.get('t'));
          if (!Number.isFinite(t)) t = 0;
          if (job.source.duration != null) t = Math.max(0, Math.min(t, Math.max(0, job.source.duration - 0.1)));
          else t = Math.max(0, t);

          const filter = sub === 'frame' ? 'format=rgba' : chromaFilter(params, 'rgba');
          const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(t), '-i', job.sourcePath,
            '-frames:v', '1', '-vf', filter, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'];
          const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          const chunks = [];
          let outLen = 0;
          let stderr = '';
          let settled = false;
          const finish = (fn) => { if (settled) return; settled = true; fn(); };
          const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(() => sendJson(res, 504, { error: 'Frame render timed out.' })); }, CHROMA_FRAME_TIMEOUT_MS);
          // res 'close' fires on a client abort (and harmlessly after a normal
          // finish); req 'close' can fire early once a request body is consumed.
          const onClientClose = () => { try { child.kill('SIGKILL'); } catch {} };
          res.on('close', onClientClose);
          child.stdout.on('data', chunk => {
            outLen += chunk.length;
            if (outLen > CHROMA_STDOUT_CAP) { try { child.kill('SIGKILL'); } catch {} return; }
            chunks.push(chunk);
          });
          child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.on('error', () => { clearTimeout(timer); res.off('close', onClientClose); finish(() => sendJson(res, 500, { error: 'Failed to run ffmpeg.' })); });
          child.on('close', code => {
            clearTimeout(timer);
            res.off('close', onClientClose);
            if (res.writableEnded || res.destroyed) { settled = true; return; }
            const body = Buffer.concat(chunks);
            if (code === 0 && body.length > 0) {
              finish(() => {
                res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                res.end(body);
              });
            } else {
              finish(() => sendJson(res, 500, { error: tidyFfmpegError(stderr) || 'Frame render failed.' }));
            }
          });
          return;
        }

        // POST /api/chroma/jobs/:id/convert
        if (sub === 'convert' && req.method === 'POST') {
          if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
            return sendJson(res, 415, { error: 'Expected application/json.' });
          }
          const body = await readBody(req);
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          const probe = await probeFfmpeg();
          if (!probe.available) return sendJson(res, 503, { error: 'ffmpeg is not available on this server.' });
          const params = normalizeChromaParams(body || {}); // throws 400

          // Take the shared encoder slot synchronously so two concurrent
          // requests (a double click) can never start two encodes, AND the
          // animate pipeline's keying cannot run at the same time. 409 while
          // the slot is held by anyone (chroma or pipeline).
          const slotRelease = encoderSlot.tryAcquire(`chroma:${id}`);
          if (!slotRelease) {
            return sendJson(res, 409, { error: 'Another conversion is already running.' });
          }
          const filter = chromaFilter(params, 'yuva420p');
          job.state = 'converting';
          job.progress = job.source.duration != null ? 0 : null;
          job.params = params;
          job.error = null;
          job.result = null;
          // Human-readable command with a stable input name.
          job.command = chromaCommand(filter, `input${job.ext}`);

          // A new conversion discards the previous result.
          const dir = jobDir(id);
          const resultPath = path.join(dir, 'result.webm');
          await fsp.rm(resultPath, { force: true }).catch(() => {});
          // A cancel or delete may have landed during the await above.
          if (job.state !== 'converting' || jobs.get(id) !== job) {
            slotRelease();
            return sendJson(res, 409, { error: 'The conversion was canceled before it started.' });
          }
          job.slotRelease = slotRelease;
          const tmpPath = path.join(dir, `result.${crypto.randomUUID()}.tmp.webm`);
          const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', job.sourcePath,
            '-vf', filter, ...VP9_ARGS, '-progress', 'pipe:1', '-nostats', tmpPath];

          const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          jobChildren.set(id, child);
          let stderr = '';
          let stdoutBuf = '';
          child.stdout.on('data', chunk => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop() || '';
            for (const line of lines) {
              const m = /^out_time_(us|ms)=(-?\d+)/.exec(line.trim());
              if (m && job.source.duration != null && job.source.duration > 0) {
                const microseconds = Number(m[2]);
                if (Number.isFinite(microseconds) && microseconds >= 0) {
                  job.progress = Math.min(0.99, (microseconds / 1e6) / job.source.duration);
                }
              }
            }
          });
          child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.on('error', () => {
            jobChildren.delete(id);
            releaseChromaSlot(job);
            if (job.state === 'converting') { job.state = 'failed'; job.progress = null; job.error = 'Failed to run ffmpeg.'; }
          });
          child.on('close', async code => {
            jobChildren.delete(id);
            releaseChromaSlot(job);
            // A cancel/delete already moved the job out of converting.
            if (job.state !== 'converting') { await fsp.rm(tmpPath, { force: true }).catch(() => {}); return; }
            if (code === 0) {
              try {
                await fsp.rename(tmpPath, resultPath);
                const alphaProbe = await runToBuffer(ffprobePath, [
                  '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_tags=alpha_mode', '-of', 'default=nw=1', resultPath,
                ]);
                const alpha = /alpha_mode=1/.test(alphaProbe.stdout.toString());
                const stat = await fsp.stat(resultPath);
                job.state = 'done';
                job.progress = 1;
                job.result = {
                  url: `/api/chroma/jobs/${id}/result`,
                  downloadUrl: `/api/chroma/jobs/${id}/result?download=1`,
                  size: stat.size,
                  alpha,
                };
              } catch (error) {
                job.state = 'failed';
                job.progress = null;
                job.error = tidyFfmpegError(String(error && error.message));
                await fsp.rm(tmpPath, { force: true }).catch(() => {});
              }
            } else {
              job.state = 'failed';
              job.progress = null;
              job.error = tidyFfmpegError(stderr);
              await fsp.rm(tmpPath, { force: true }).catch(() => {});
            }
          });
          return sendJson(res, 202, jobView(job));
        }

        // POST /api/chroma/jobs/:id/cancel
        if (sub === 'cancel' && req.method === 'POST') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          if (job.state !== 'converting') return sendJson(res, 409, { error: 'No conversion to cancel.' });
          job.state = 'canceled';
          job.progress = null;
          killJobChild(id);
          releaseChromaSlot(job);
          // Remove any temp encode files left in the job dir.
          try {
            const entries = await fsp.readdir(jobDir(id));
            await Promise.all(entries.filter(name => name.endsWith('.tmp.webm')).map(name => fsp.rm(path.join(jobDir(id), name), { force: true }).catch(() => {})));
          } catch { /* dir may be gone */ }
          return sendJson(res, 200, jobView(job));
        }

        // GET|HEAD /api/chroma/jobs/:id/result
        if (sub === 'result' && (req.method === 'GET' || req.method === 'HEAD')) {
          if (!job || job.state !== 'done' || !job.result) return sendJson(res, 404, { error: 'Result not ready.' });
          const resultPath = path.join(jobDir(id), 'result.webm');
          if (url.searchParams.get('download') === '1') {
            const downloadName = `${job.name}-transparent.webm`;
            // RFC 5987: encodeURIComponent leaves ' ( ) * unescaped, and ' is the
            // charset delimiter, so escape those too.
            const encodedName = encodeURIComponent(downloadName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
            res.setHeader('Content-Disposition', `attachment; filename="transparent.webm"; filename*=UTF-8''${encodedName}`);
          }
          return serveMedia(req, res, resultPath, 'video/webm');
        }

        // POST /api/chroma/jobs/:id/publish
        if (sub === 'publish' && req.method === 'POST') {
          if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
            return sendJson(res, 415, { error: 'Expected application/json.' });
          }
          const body = await readBody(req);
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          const kind = body && body.kind;
          if (kind !== 'motion' && kind !== 'idle') return sendJson(res, 400, { error: "kind must be 'motion' or 'idle'." });
          if (job.state !== 'done' || !job.result) return sendJson(res, 409, { error: 'Job is not done.' });
          const newId = crypto.randomUUID();
          const targetPath = path.join(mediaDir, `${newId}.webm`);
          await fsp.copyFile(path.join(jobDir(id), 'result.webm'), targetPath);
          try {
            const item = {
              id: newId,
              name: sanitizeName(body.name || job.name),
              kind,
              mime: 'video/webm',
              url: `/api/media/${newId}`,
              createdAt: new Date().toISOString(),
            };
            await commitLibraryItem(item);
            return sendJson(res, 201, item);
          } catch (error) {
            await fsp.rm(targetPath, { force: true }).catch(() => {});
            throw error;
          }
        }
      }

      // --- Animate motion preset routes --------------------------------------
      if (pathname === '/api/animate/status' && req.method === 'GET') {
        return sendJson(res, 200, await buildAnimateStatus());
      }

      if (pathname === '/api/animate/config' && req.method === 'PUT') {
        requireJson(req);
        const body = await readBody(req);
        await configStore.applyPatch(body); // throws {status:400}
        await registry.load(); // custom routes/availability may change with credentials
        return sendJson(res, 200, await buildAnimateStatus());
      }

      const providerTest = /^\/api\/animate\/providers\/([^/]+)\/test$/.exec(pathname);
      if (providerTest && req.method === 'POST') {
        const id = providerTest[1];
        const adapter = animateProviders[id];
        if (!adapter) return sendJson(res, 404, { error: 'Unknown provider.' });
        if (typeof adapter.test !== 'function') return sendJson(res, 501, { error: 'This provider has no test.', code: 'not_testable' });
        if (!configStore.isConfigured(id)) return sendJson(res, 400, { error: 'Provider is not configured.', code: 'not_configured' });
        try {
          const result = await adapter.test({ credentials: configStore.resolvedCredentials(id), settings: configStore.resolvedSettings(id), fetch: (...a) => fetch(...a), baseUrl: configStore.baseUrl(id), signal: undefined, log: () => {}, allowInsecure: configStore.allowInsecure(id) });
          return sendJson(res, 200, { ok: !!(result && result.ok), detail: (result && result.detail) || null });
        } catch (error) {
          return sendJson(res, 200, { ok: false, detail: safeErr(error.message) });
        }
      }

      // References: POST (upload) / GET|HEAD (serve) / DELETE
      const refMatch = /^\/api\/animate\/references\/([^/]+)$/.exec(pathname);
      if (refMatch) {
        const presetId = refMatch[1];
        if (!presetsModule.isPreset(presetId)) return sendJson(res, 404, { error: 'Unknown preset.' });
        if (req.method === 'POST') {
          const probe = await probeFfmpeg();
          if (!probe.available) return sendJson(res, 503, { error: 'ffmpeg is not available on this server.', code: 'ffmpeg_unavailable' });
          const filename = url.searchParams.get('filename') || '';
          const ext = path.extname(filename).toLowerCase();
          if (!REFERENCE_EXTENSIONS.includes(ext)) return sendJson(res, 415, { error: `Unsupported reference type; use one of ${REFERENCE_EXTENSIONS.join(', ')}.` });
          const declared = Number(req.headers['content-length']);
          if (declared > ANIMATE_REFERENCE_MAX) return sendJson(res, 413, { error: 'File exceeds 500 MB.' });
          const tmpPath = path.join(referencesDir, `upload-${crypto.randomUUID()}.tmp${ext}`);
          try {
            await receiveFile(req, tmpPath);
            const info = await animateMedia.probeVideo(ffprobePath, tmpPath);
            if (!info || !info.duration) throw Object.assign(new Error('No video stream found in the reference.'), { status: 415 });
            // Remove the preset's other reference files, then place this one.
            await removePresetReferences(presetId);
            const finalPath = path.join(referencesDir, `${presetId}${ext}`);
            await fsp.rename(tmpPath, finalPath);
            return sendJson(res, 201, await presetView(presetId));
          } catch (error) {
            await fsp.rm(tmpPath, { force: true }).catch(() => {});
            throw error;
          }
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          const ref = await findReference(presetId);
          if (!ref) return sendJson(res, 404, { error: 'No reference for this preset.' });
          return serveMedia(req, res, ref.path, mimeForExt(ref.ext));
        }
        if (req.method === 'DELETE') {
          await removePresetReferences(presetId);
          return sendJson(res, 200, { ok: true });
        }
      }

      // PUT /api/animate/presets/:presetId
      const presetMatch = /^\/api\/animate\/presets\/([^/]+)$/.exec(pathname);
      if (presetMatch && req.method === 'PUT') {
        requireJson(req);
        const body = await readBody(req);
        const presetId = presetMatch[1];
        await presetStore.update(presetId, body || {}); // throws {status:400|404}
        return sendJson(res, 200, await presetView(presetId));
      }

      // Character: POST (upload) / DELETE / GET preview
      if (pathname === '/api/animate/character' && req.method === 'POST') {
        const probe = await probeFfmpeg();
        if (!probe.available) return sendJson(res, 503, { error: 'ffmpeg is not available on this server.', code: 'ffmpeg_unavailable' });
        const filename = url.searchParams.get('filename') || '';
        const ext = path.extname(filename).toLowerCase();
        if (!CHARACTER_EXTENSIONS.includes(ext)) return sendJson(res, 415, { error: 'Upload a PNG, WebP or JPEG image.' });
        const declared = Number(req.headers['content-length']);
        if (declared > ANIMATE_CHARACTER_MAX) return sendJson(res, 413, { error: 'Image exceeds 30 MB.' });
        const tmpPath = path.join(animateDir, `charupload.${crypto.randomUUID()}.tmp${ext}`);
        try {
          await receiveFileWithLimit(req, tmpPath, ANIMATE_CHARACTER_MAX);
          const info = await animateMedia.probeVideo(ffprobePath, tmpPath);
          if (!info || !info.width) throw Object.assign(new Error('Could not read the image.'), { status: 415 });
          await removeCharacterFiles();
          await fsp.rename(tmpPath, path.join(animateDir, `character${ext === '.jpeg' ? '.jpg' : ext}`));
          return sendJson(res, 201, await characterView());
        } catch (error) {
          await fsp.rm(tmpPath, { force: true }).catch(() => {});
          throw error;
        }
      }
      if (pathname === '/api/animate/character' && req.method === 'DELETE') {
        await removeCharacterFiles();
        return sendJson(res, 200, await characterView());
      }
      if (pathname === '/api/animate/character/preview' && (req.method === 'GET' || req.method === 'HEAD')) {
        const probe = await probeFfmpeg();
        if (!probe.available) return sendJson(res, 503, { error: 'ffmpeg is not available on this server.' });
        const source = await resolveCharacterSource();
        if (!source) return sendJson(res, 404, { error: 'No character image.' });
        // Canvas-size composite onto #00FF00 for the preview (no route limits).
        const tmpOut = path.join(animateDir, `preview.${crypto.randomUUID()}.tmp.png`);
        try {
          await animateMedia.compositeCharacter(ffmpegPath, ffprobePath, source, {}, tmpOut, { timeoutMs: 60000 });
          const content = await fsp.readFile(tmpOut);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(req.method === 'HEAD' ? undefined : content);
        } finally {
          await fsp.rm(tmpOut, { force: true }).catch(() => {});
        }
      }

      // Jobs collection
      if (pathname === '/api/animate/jobs' && req.method === 'GET') {
        return sendJson(res, 200, { jobs: pipeline.list().map(job => pipeline.view(job)) });
      }
      if (pathname === '/api/animate/jobs' && req.method === 'POST') {
        requireJson(req);
        const body = await readBody(req);
        return sendJson(res, ...(await createAnimateJobs(body)));
      }

      // Single job routes
      const animateJobMatch = /^\/api\/animate\/jobs\/([^/]+)(?:\/(cancel|retry|open-in-converter|generated|result))?$/.exec(pathname);
      if (animateJobMatch) {
        const id = animateJobMatch[1];
        const sub = animateJobMatch[2];
        if (!JOB_ID_RE.test(id)) return sendJson(res, 404, { error: 'Job not found.' });
        const job = pipeline.get(id);
        if (!sub && req.method === 'GET') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          return sendJson(res, 200, pipeline.view(job));
        }
        if (!sub && req.method === 'DELETE') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          await pipeline.cancel(id);
          await fsp.rm(pipeline.jobDir(id), { recursive: true, force: true }).catch(() => {});
          pipeline.jobs.delete(id);
          return sendJson(res, 200, { ok: true });
        }
        if (sub === 'cancel' && req.method === 'POST') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          const result = await pipeline.cancel(id);
          if (result && result.conflict) return sendJson(res, 409, { error: 'Job is already finished.' });
          return sendJson(res, 200, pipeline.view(pipeline.get(id)));
        }
        if (sub === 'retry' && req.method === 'POST') {
          requireJson(req);
          const body = await readBody(req);
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          const result = await pipeline.retry(id, { regenerate: !!(body && body.regenerate) });
          if (result && result.conflict) return sendJson(res, 409, { error: 'Job is active.' });
          return sendJson(res, 202, pipeline.view(pipeline.get(id)));
        }
        if (sub === 'open-in-converter' && req.method === 'POST') {
          if (!job) return sendJson(res, 404, { error: 'Job not found.' });
          if (!pipeline.hasGenerated(id)) return sendJson(res, 409, { error: 'No generated video yet.' });
          const chromaJob = await createChromaJobFromFile(pipeline.generatedPath(id), `${job.presetName}.mp4`, job.presetName);
          return sendJson(res, 201, { chromaJob });
        }
        if (sub === 'generated' && (req.method === 'GET' || req.method === 'HEAD')) {
          if (!job || !pipeline.hasGenerated(id)) return sendJson(res, 404, { error: 'No generated video.' });
          return serveMedia(req, res, pipeline.generatedPath(id), 'video/mp4');
        }
        if (sub === 'result' && (req.method === 'GET' || req.method === 'HEAD')) {
          if (!job || !fs.existsSync(pipeline.resultPath(id))) return sendJson(res, 404, { error: 'No result.' });
          return serveMedia(req, res, pipeline.resultPath(id), 'video/webm');
        }
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC_FILES.has(pathname)) {
        const [filename, mime] = STATIC_FILES.get(pathname);
        const content = await fsp.readFile(path.join(PUBLIC_DIR, filename));
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      sendJson(res, 404, { error: 'Not found.' });
    })().catch(error => {
      if (res.headersSent) return res.destroy(error);
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
      if (!error.status) console.error(error);
    });
  });
  // Kill any running ffmpeg encodes when the server closes (tests must not leak).
  server.on('close', () => {
    pipeline.close().catch(() => {});
    for (const child of jobChildren.values()) {
      if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
    jobChildren.clear();
  });

  return server;
}

function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

async function listenWithPortRotation(server, { host = '127.0.0.1', startPort = 8787, maxAttempts = 100 } = {}) {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer.');
  }
  const lastPort = Math.min(65535, startPort + maxAttempts - 1);
  for (let port = startPort; port <= lastPort; port += 1) {
    try {
      return await listenOnce(server, host, port);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No available port from ${startPort} to ${lastPort}.`);
}

if (require.main === module) {
  createAppServer().then(async server => {
    const host = process.env.HOST || '127.0.0.1';
    const startPort = Number(process.env.PORT ?? 8787);
    const port = await listenWithPortRotation(server, { host, startPort });
    const displayHost = host.includes(':') ? `[${host}]` : host;
    if (port !== startPort) console.log(`Port ${startPort} is in use; using ${port}.`);
    console.log(`Virtually controller: http://${displayHost}:${port}/`);
    console.log(`OBS Browser Source: http://${displayHost}:${port}/overlay`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { createAppServer, listenWithPortRotation };
