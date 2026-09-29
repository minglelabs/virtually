'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const { createAnimateApi } = require('./lib/animate/api');

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const EXAMPLES_MANIFEST = path.join(__dirname, 'examples', 'driving.json');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/overlay', ['overlay.html', 'text/html; charset=utf-8']],
  ['/animate', ['animate.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/animate.css', ['animate.css', 'text/css; charset=utf-8']],
  ['/animate.js', ['animate.js', 'text/javascript; charset=utf-8']],
  ['/motions.js', ['motions.js', 'text/javascript; charset=utf-8']],
  ['/overlay.css', ['overlay.css', 'text/css; charset=utf-8']],
  ['/overlay.js', ['overlay.js', 'text/javascript; charset=utf-8']],
]);

// The one place a library item's file extension comes from (serve, delete and
// idle replacement all use it).
const EXT_BY_MIME = {
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'image/png': '.png',
  'image/webp': '.webp',
};

function extForMime(mime) {
  return EXT_BY_MIME[mime] || '.webm';
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

async function receiveFile(req, target, limit = MAX_UPLOAD_BYTES, tooLargeMessage = 'File exceeds 500 MB') {
  const output = fs.createWriteStream(target, { flags: 'wx' });
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        break;
      }
      if (!output.write(chunk)) await once(output, 'drain');
    }
    if (tooLarge) throw Object.assign(new Error(tooLargeMessage), { status: 413, code: 'too_large' });
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

async function createAppServer({
  dataDir = path.join(__dirname, 'data'),
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  animateMock = process.env.VIRTUALLY_ANIMATE_MOCK === '1',
  animatePollIntervalMs = null,
  examplesManifestPath = EXAMPLES_MANIFEST,
  // Test-only: lets example downloads use plain http fixture servers.
  allowHttpExamples = false,
} = {}) {
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
  function mediaPathForItem(item) {
    return path.join(mediaDir, `${item.id}${extForMime(item.mime)}`);
  }

  const animate = await createAnimateApi({
    dataDir, mediaDir, ffmpegPath, ffprobePath, mock: animateMock, pollIntervalMs: animatePollIntervalMs,
    examplesManifestPath, allowHttpExamples,
    getLibrary: () => library, mediaPathForItem, enqueue, save, broadcast,
    sendJson, readBody, receiveFile, serveMedia, sanitizeName,
  });

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
          let priorIdle;
          await enqueue(async () => {
            priorIdle = library.idle;
            const next = kind === 'idle'
              ? { ...library, idle: item }
              : { ...library, motions: [...library.motions, item] };
            await save(next);
          });
          committed = true;
          if (kind === 'idle' && priorIdle) {
            await fsp.rm(mediaPathForItem(priorIdle), { force: true }).catch(() => {});
          }
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
      if (req.method === 'POST' && pathname === '/api/idle') {
        if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
          return sendJson(res, 415, { error: 'Expected application/json.' });
        }
        // The body (usually {}) is drained with the usual size limit; its contents are ignored,
        // so an empty or non-JSON body is accepted too.
        await readBody(req).catch(error => { if (error.status !== 400) throw error; });
        const seq = ++sequence;
        broadcast({ type: 'idle', seq });
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
        await fsp.rm(mediaPathForItem(removed), { force: true });
        return sendJson(res, 200, { ok: true });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/media/')) {
        const id = pathname.slice('/api/media/'.length);
        const item = [library.idle, ...library.motions].find(value => value && value.id === id);
        if (!item) return sendJson(res, 404, { error: 'Media not found.' });
        return serveMedia(req, res, mediaPathForItem(item), item.mime);
      }
      if (await animate.handle(req, res, url)) return;
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC_FILES.has(pathname)) {
        const [filename, mime] = STATIC_FILES.get(pathname);
        const content = await fsp.readFile(path.join(PUBLIC_DIR, filename));
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      sendJson(res, 404, { error: 'Not found.' });
    })().catch(error => {
      if (res.headersSent) return res.destroy(error);
      if (!error.status) {
        sendJson(res, 500, { error: 'Internal server error.' });
        return console.error(error);
      }
      const body = { error: error.message };
      if (typeof error.code === 'string') body.code = error.code;
      if (error.detail && typeof error.detail === 'object') body.detail = error.detail;
      sendJson(res, error.status, body);
    });
  });
  // Stop running jobs and downloads with the server (tests must not leak).
  server.on('close', () => { animate.close().catch(() => {}); });
  server.animate = animate;
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

module.exports = { createAppServer, listenWithPortRotation, extForMime };
