'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/overlay', ['overlay.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/chroma.js', ['chroma.js', 'text/javascript; charset=utf-8']],
  ['/overlay.css', ['overlay.css', 'text/css; charset=utf-8']],
  ['/overlay.js', ['overlay.js', 'text/javascript; charset=utf-8']],
]);

// --- Chroma key -> transparent WebM job API -----------------------------------

const CHROMA_DEFAULTS = { color: '#00FF00', similarity: 0.12, blend: 0.06, despill: false };
const CHROMA_LIMITS = { similarity: [0.01, 1], blend: [0, 1] };
const CHROMA_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const CHROMA_MAX_JOBS = 6;
const CHROMA_FRAME_TIMEOUT_MS = 20000;
const CHROMA_STDOUT_CAP = 64 * 1024 * 1024;
const JOB_ID_RE = /^[0-9a-f-]{36}$/;

// Format a number the way ffmpeg filter args expect: 0.12 -> "0.12", 1 -> "1".
function chromaNum(value) {
  return String(Number(Number(value).toFixed(4)));
}

// Normalize a raw color into canonical `#RRGGBB` (uppercase). Accepts
// `#RRGGBB`, `RRGGBB`, `0xRRGGBB` (case-insensitive). Returns null otherwise.
function normalizeColor(raw) {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (value.startsWith('#')) value = value.slice(1);
  else if (/^0x/i.test(value)) value = value.slice(2);
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return `#${value.toUpperCase()}`;
}

// Decide the despill type for a color, or null when neither green nor blue
// dominates. green if G>R && G>B; blue if B>R && B>G.
function despillType(canonicalColor) {
  const r = parseInt(canonicalColor.slice(1, 3), 16);
  const g = parseInt(canonicalColor.slice(3, 5), 16);
  const b = parseInt(canonicalColor.slice(5, 7), 16);
  if (g > r && g > b) return 'green';
  if (b > r && b > g) return 'blue';
  return null;
}

// Normalize chroma params from a plain object (missing -> DEFAULTS). Throws a
// {status:400} error on invalid color / out-of-range numbers. Used by BOTH the
// preview route and the convert route so their filters always agree.
function normalizeChromaParams(raw = {}) {
  const source = raw || {};
  const color = source.color == null ? CHROMA_DEFAULTS.color : normalizeColor(source.color);
  if (!color) throw Object.assign(new Error('Invalid key color; use #RRGGBB.'), { status: 400 });

  const similarity = source.similarity == null ? CHROMA_DEFAULTS.similarity : Number(source.similarity);
  if (!Number.isFinite(similarity) || similarity < CHROMA_LIMITS.similarity[0] || similarity > CHROMA_LIMITS.similarity[1]) {
    throw Object.assign(new Error('similarity must be a number within [0.01, 1].'), { status: 400 });
  }
  const blend = source.blend == null ? CHROMA_DEFAULTS.blend : Number(source.blend);
  if (!Number.isFinite(blend) || blend < CHROMA_LIMITS.blend[0] || blend > CHROMA_LIMITS.blend[1]) {
    throw Object.assign(new Error('blend must be a number within [0, 1].'), { status: 400 });
  }

  let despill = source.despill === true || source.despill === 1 || source.despill === '1' || source.despill === 'true';
  // despill only applies to green/blue keys; otherwise silently disable it.
  const type = despillType(color);
  if (despill && !type) despill = false;

  return { color, similarity, blend, despill };
}

// Build the ffmpeg filter string for the given params. `pixel` is 'yuva420p'
// for the WebM encode or 'rgba' for a still PNG.
function chromaFilter(params, pixel) {
  const hex = `0x${params.color.slice(1)}`;
  let filter = `chromakey=${hex}:${chromaNum(params.similarity)}:${chromaNum(params.blend)}`;
  if (params.despill) filter += `,despill=type=${despillType(params.color)}`;
  filter += `,format=${pixel}`;
  return filter;
}

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

async function createAppServer({ dataDir = path.join(__dirname, 'data'), ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
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

          // Check and claim in the same synchronous step so two concurrent
          // requests (a double click) can never start two encodes.
          if ([...jobs.values()].some(other => other.state === 'converting')) {
            return sendJson(res, 409, { error: 'Another conversion is already running.' });
          }
          const filter = chromaFilter(params, 'yuva420p');
          job.state = 'converting';
          job.progress = job.source.duration != null ? 0 : null;
          job.params = params;
          job.error = null;
          job.result = null;
          // Human-readable command with a stable input name.
          job.command = `ffmpeg -i input${job.ext} -vf "${filter}" -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -row-mt 1 -an output.webm`;

          // A new conversion discards the previous result.
          const dir = jobDir(id);
          const resultPath = path.join(dir, 'result.webm');
          await fsp.rm(resultPath, { force: true }).catch(() => {});
          // A cancel or delete may have landed during the await above.
          if (job.state !== 'converting' || jobs.get(id) !== job) {
            return sendJson(res, 409, { error: 'The conversion was canceled before it started.' });
          }
          const tmpPath = path.join(dir, `result.${crypto.randomUUID()}.tmp.webm`);
          const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', job.sourcePath,
            '-vf', filter, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
            '-b:v', '0', '-crf', '30', '-row-mt', '1', '-an', '-progress', 'pipe:1', '-nostats', tmpPath];

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
            if (job.state === 'converting') { job.state = 'failed'; job.progress = null; job.error = 'Failed to run ffmpeg.'; }
          });
          child.on('close', async code => {
            jobChildren.delete(id);
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
