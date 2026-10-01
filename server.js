'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const { createAnimateApi } = require('./lib/animate/api');
const { measureFit } = require('./lib/animate/fit');
const { processMotionUpload } = require('./lib/animate/motion-upload');
const { createAuth } = require('./lib/auth');
const {
  CharacterStore, characterError, checkName, cleanFilename, photoDisplay,
  CHARACTER_ID_RE, PHOTO_ID_RE, MAX_CHARACTERS, MAX_PHOTOS, PHOTO_MAX_BYTES,
} = require('./lib/characters');
const { WEBHOOK_PATH, createBilling } = require('./lib/billing');

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const EXAMPLES_MANIFEST = path.join(__dirname, 'examples', 'driving.json');
// Bundled example driving videos (the manifest's `file` entries): our own, committed assets.
const BUNDLED_DRIVINGS_DIR = path.join(__dirname, 'assets', 'drivings');
const STATIC_FILES = new Map([
  ['/', ['characters.html', 'text/html; charset=utf-8']],
  ['/broadcast', ['index.html', 'text/html; charset=utf-8']],
  ['/overlay', ['overlay.html', 'text/html; charset=utf-8']],
  ['/animate', ['animate.html', 'text/html; charset=utf-8']],
  ['/characters.css', ['characters.css', 'text/css; charset=utf-8']],
  ['/characters.js', ['characters.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/animate.css', ['animate.css', 'text/css; charset=utf-8']],
  ['/animate.js', ['animate.js', 'text/javascript; charset=utf-8']],
  ['/motions.js', ['motions.js', 'text/javascript; charset=utf-8']],
  ['/overlay.css', ['overlay.css', 'text/css; charset=utf-8']],
  ['/overlay.js', ['overlay.js', 'text/javascript; charset=utf-8']],
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/login.css', ['login.css', 'text/css; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/auth.css', ['auth.css', 'text/css; charset=utf-8']],
  ['/auth.js', ['auth.js', 'text/javascript; charset=utf-8']],
  ['/billing', ['billing.html', 'text/html; charset=utf-8']],
  ['/billing.css', ['billing.css', 'text/css; charset=utf-8']],
  ['/billing.js', ['billing.js', 'text/javascript; charset=utf-8']],
  ['/credits.js', ['credits.js', 'text/javascript; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
]);

// With login on, anyone may load the non-HTML static files (the repo is public anyway).
function isPublicStatic(pathname) {
  const entry = STATIC_FILES.get(pathname);
  return !!entry && !entry[1].startsWith('text/html');
}

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

// Library item ids (motions, idles) are UUIDs; photo ids have their own pattern.
const MEDIA_ID_RE = /^[0-9a-f-]{36}$/;

// library.json `idles`: { <photoId>: idle item } uploaded for one photo.
// Anything malformed is dropped.
function parseIdles(value) {
  const idles = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return idles;
  for (const [photoId, item] of Object.entries(value)) {
    if (PHOTO_ID_RE.test(photoId) && item && typeof item === 'object' && typeof item.id === 'string' && MEDIA_ID_RE.test(item.id)) {
      idles[photoId] = item;
    }
  }
  return idles;
}

function requireJson(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('Expected application/json.'), { status: 415, code: 'expected_json' });
  }
}

// Bounds for the OBS browser-source size the overlay reports.
const OBS_SOURCE_MIN = 16;
const OBS_SOURCE_MAX = 8192;

function parseObsSource(value) {
  if (!value || typeof value !== 'object') return null;
  const valid = n => Number.isInteger(n) && n >= OBS_SOURCE_MIN && n <= OBS_SOURCE_MAX;
  if (!valid(value.width) || !valid(value.height)) return null;
  return { width: value.width, height: value.height };
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

// serveMedia, answering 404 when the file itself is gone.
async function serveFile(req, res, filePath, mime) {
  try {
    await serveMedia(req, res, filePath, mime);
  } catch (error) {
    if (error.code !== 'ENOENT' || res.headersSent) throw error;
    sendJson(res, 404, { error: 'Media not found.' });
  }
}

async function createAppServer({
  dataDir = path.join(__dirname, 'data'),
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  animateMock = process.env.VIRTUALLY_ANIMATE_MOCK === '1',
  animatePollIntervalMs = null,
  examplesManifestPath = EXAMPLES_MANIFEST,
  bundledDrivingsDir = BUNDLED_DRIVINGS_DIR,
  // Test-only: lets example downloads use plain http fixture servers.
  allowHttpExamples = false,
  // Google login (off unless <dataDir>/auth/config.json exists). Tests inject
  // { endpoints: { authorize, token, jwks }, now: () => ms, configCheckIntervalMs, log }.
  auth: authOptions = {},
  // Credit billing (off unless <dataDir>/billing/config.json exists). Tests inject
  // { apiBase, now: () => ms, configCheckIntervalMs, log }.
  billing: billingOptions = {},
} = {}) {
  const mediaDir = path.join(dataDir, 'media');
  const manifestPath = path.join(dataDir, 'library.json');
  await fsp.mkdir(mediaDir, { recursive: true });
  // { idle, motions, idles }: `idle` is the legacy idle (shown while no photo
  // is on air), every motion has a photoId (null = no photo), `idles` maps a
  // photo id to the idle uploaded for that photo.
  let library = { idle: null, motions: [], idles: {} };
  try {
    const stored = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (stored && Array.isArray(stored.motions)) library = { idle: stored.idle || null, motions: stored.motions, idles: parseIdles(stored.idles) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Latest viewport size reported by the OBS browser source ({width, height} or null).
  const obsSourcePath = path.join(dataDir, 'obs-source.json');
  let obsSource = null;
  try {
    obsSource = parseObsSource(JSON.parse(await fsp.readFile(obsSourcePath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
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
  // The photo as the idle item, while no idle was uploaded for it: its cutout
  // when the plain background was cut out, else the photo file.
  function photoIdle(character, photo) {
    const display = photoDisplay(photo);
    return {
      id: photo.id, name: character.name, kind: 'idle', mime: display.mime, url: display.url,
      createdAt: photo.createdAt, fit: display.fit, source: { photoId: photo.id },
    };
  }
  // What the controller and the overlay see (GET /api/library, SSE): the
  // on-air photo's idle and motions, or with nothing on air the legacy idle
  // and the motions without a photo.
  function libraryView() {
    const active = characters.active();
    if (!active) return { idle: library.idle, motions: library.motions.filter(item => !item.photoId), character: null, photo: null };
    const { character, photo } = active;
    return {
      idle: library.idles[photo.id] || photoIdle(character, photo),
      motions: library.motions.filter(item => item.photoId === photo.id),
      character: { id: character.id, name: character.name },
      photo: { id: photo.id, url: `/api/media/${photo.id}`, width: photo.width, height: photo.height, hasAlpha: photo.hasAlpha },
    };
  }
  function libraryMessage() {
    return JSON.stringify({ type: 'library', library: libraryView() });
  }
  // Called after anything that may change the view; sends it only when it did.
  let lastLibraryMessage = null;
  function broadcastLibrary() {
    const message = libraryMessage();
    if (message === lastLibraryMessage) return;
    lastLibraryMessage = message;
    broadcast(JSON.parse(message));
  }
  async function writeLibrary(next) {
    const value = { idle: next.idle || null, motions: next.motions, idles: next.idles || {} };
    const temporary = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
      await fsp.rename(temporary, manifestPath);
      library = value;
    } finally {
      await fsp.rm(temporary, { force: true });
    }
  }
  async function save(next) {
    await writeLibrary(next);
    broadcastLibrary();
  }
  function mediaPathForItem(item) {
    return path.join(mediaDir, `${item.id}${extForMime(item.mime)}`);
  }
  // Every library item a GET /api/media/<id> may serve (photos are looked up separately).
  function findLibraryItem(id) {
    return [library.idle, ...Object.values(library.idles), ...library.motions].find(item => item && item.id === id) || null;
  }
  function obsSourceMessage() {
    return { type: 'obs-source', width: obsSource ? obsSource.width : null, height: obsSource ? obsSource.height : null };
  }
  async function saveObsSource(next) {
    const temporary = `${obsSourcePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(next) + '\n');
      await fsp.rename(temporary, obsSourcePath);
      obsSource = next;
    } finally {
      await fsp.rm(temporary, { force: true });
    }
    broadcast(obsSourceMessage());
  }

  // Characters and the on-air photo (migrates the old character library once).
  const characters = await new CharacterStore({ dataDir, ffmpegPath, ffprobePath }).load({ library, writeLibrary });
  lastLibraryMessage = libraryMessage();

  // Before the animate API, so a failing auth setup cannot leave its jobs running.
  const auth = await createAuth({ ...authOptions, dataDir, sendJson, readBody, isPublicStatic });
  // Before the animate API too: jobs are charged and refunded through it.
  const billing = await createBilling({ ...billingOptions, dataDir, auth, sendJson, readBody });

  const animate = await createAnimateApi({
    dataDir, mediaDir, ffmpegPath, ffprobePath, mock: animateMock, pollIntervalMs: animatePollIntervalMs,
    examplesManifestPath, allowHttpExamples, bundledDrivingsDir,
    getLibrary: () => library, mediaPathForItem, enqueue, save, broadcast,
    getPhoto: id => characters.getPhoto(id),
    sendJson, readBody, receiveFile, serveMedia, sanitizeName, billing,
  });

  // --- characters (/api/characters*, /api/active-photo) ----------------------

  const listView = () => characters.listView(library);
  const characterView = id => characters.characterView(id, library);
  // Malformed ids are refused before any lookup or path use.
  const characterIdFrom = value => {
    if (!CHARACTER_ID_RE.test(value)) throw characterError('character_missing');
    return value;
  };
  const photoIdFrom = value => {
    if (!PHOTO_ID_RE.test(value)) throw characterError('photo_missing');
    return value;
  };

  // Stream a raw image body (<= 20 MB) to a temp file and hand it to
  // `register`, which moves it into the store; what is left is removed.
  async function receivePhoto(req, register) {
    if (Number(req.headers['content-length']) > PHOTO_MAX_BYTES) throw characterError('too_large');
    const tmpPath = path.join(characters.dir, `photo-upload.${crypto.randomUUID()}.tmp`);
    try {
      try {
        await receiveFile(req, tmpPath, PHOTO_MAX_BYTES, characterError('too_large').message);
      } catch (error) {
        if (error.status === 400) throw characterError('unsupported_image'); // an empty body
        throw error;
      }
      return await register(tmpPath);
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  // Run a store deletion (`run(beforeCommit)`) inside the library queue: the
  // photos' motions and uploaded idles leave library.json first, then the
  // store commits (and removes the photo files); their media files go once
  // both records are saved. Deleting the on-air photo takes it off air.
  async function removeWithMedia(run) {
    let dropped = [];
    const result = await enqueue(() => run(async photoIds => {
      const ids = new Set(photoIds);
      const idles = { ...library.idles };
      dropped = library.motions.filter(item => ids.has(item.photoId));
      for (const photoId of ids) {
        if (!idles[photoId]) continue;
        dropped.push(idles[photoId]);
        delete idles[photoId];
      }
      if (dropped.length) await writeLibrary({ ...library, motions: library.motions.filter(item => !ids.has(item.photoId)), idles });
    }));
    broadcastLibrary();
    for (const item of dropped) await fsp.rm(mediaPathForItem(item), { force: true }).catch(() => {});
    return result;
  }

  // POST /api/characters/<id>/photos/<photoId>/motions: a finished video,
  // processed (motion-upload.js) before the answer. Temp files always go; a
  // failed upload leaves no record.
  async function uploadMotion(req, res, url, characterId, photoId) {
    if (!characters.getCharacter(characterId)) throw characterError('character_missing');
    const entry = characters.getPhoto(photoId);
    if (!entry || entry.character.id !== characterId) throw characterError('photo_missing');
    if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) throw characterError('too_large_video');
    await animate.requireFfmpeg();
    const workDir = path.join(mediaDir, `motion-upload.${crypto.randomUUID()}.tmp`);
    await fsp.mkdir(workDir);
    let answer;
    try {
      const sourcePath = path.join(workDir, 'upload');
      try {
        await receiveFile(req, sourcePath, MAX_UPLOAD_BYTES, characterError('too_large_video').message);
      } catch (error) {
        if (error.status === 413) throw characterError('too_large_video');
        if (error.status === 400) throw characterError('unsupported_video'); // an empty body
        throw error;
      }
      const result = await processMotionUpload({ ffmpegPath, ffprobePath, sourcePath, workDir });
      const filename = cleanFilename(url.searchParams.get('filename'), '');
      const requested = (url.searchParams.get('name') || '').trim();
      const id = crypto.randomUUID();
      const item = {
        id,
        name: sanitizeName(requested || path.basename(filename, path.extname(filename))),
        kind: 'motion',
        mime: result.mime,
        url: `/api/media/${id}`,
        createdAt: new Date().toISOString(),
        photoId,
        source: { upload: { filename: filename || null, alpha: result.alpha, keyed: result.keyed, keyColor: result.keyColor, keyReason: result.keyReason } },
        fit: result.fit,
      };
      const target = mediaPathForItem(item);
      let committed = false;
      try {
        await enqueue(async () => {
          // Photo deletions run in this queue too, so this check cannot go stale.
          if (!characters.getPhoto(photoId)) throw characterError('photo_missing');
          await fsp.rename(result.path, target);
          await save({ ...library, motions: [...library.motions, item] });
          committed = true;
        });
      } catch (error) {
        if (!committed) await fsp.rm(target, { force: true }).catch(() => {});
        throw error;
      }
      answer = { motion: item, keyed: result.keyed, keyReason: result.keyReason, character: characterView(characterId), ...listView() };
    } finally {
      // Before the answer, so a client never sees the work directory.
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    return sendJson(res, 201, answer);
  }

  // Returns true when the request was handled.
  async function handleCharacters(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (pathname === '/api/active-photo' && method === 'PUT') {
      requireJson(req);
      const body = await readBody(req);
      const photoId = body && typeof body === 'object' ? body.photoId : undefined;
      if (photoId !== null && typeof photoId !== 'string') throw characterError('photo_missing', 400);
      const { changed } = await characters.setActive(photoId);
      if (changed) broadcastLibrary();
      sendJson(res, 200, { activePhotoId: characters.activePhotoId, activeCharacterId: characters.activeCharacterId(), library: libraryView() });
      return true;
    }
    if (pathname === '/api/characters') {
      if (method === 'GET') {
        sendJson(res, 200, listView());
        return true;
      }
      if (method === 'POST') {
        // Name and count are checked before the upload is read.
        const name = checkName(url.searchParams.get('name') || '');
        if (characters.characters.length >= MAX_CHARACTERS) throw characterError('too_many_characters');
        const filename = url.searchParams.get('filename');
        const { character } = await receivePhoto(req, tmpPath => characters.create(tmpPath, { name, filename }));
        sendJson(res, 201, { character: characterView(character.id), ...listView() });
        return true;
      }
      return false;
    }
    if (!pathname.startsWith('/api/characters/')) return false;
    const parts = pathname.slice('/api/characters/'.length).split('/');
    const id = characterIdFrom(parts[0]);
    if (parts.length === 1 && method === 'PATCH') {
      requireJson(req);
      const body = await readBody(req);
      if (!characters.getCharacter(id)) throw characterError('character_missing');
      const character = await characters.rename(id, body && typeof body === 'object' ? body.name : undefined);
      // The on-air character's name is in the view (character.name, the photo idle's name).
      if (character.photos.some(photo => photo.id === characters.activePhotoId)) broadcastLibrary();
      sendJson(res, 200, { character: characterView(id), ...listView() });
      return true;
    }
    if (parts.length === 1 && method === 'DELETE') {
      await removeWithMedia(beforeCommit => characters.remove(id, { beforeCommit }));
      sendJson(res, 200, listView());
      return true;
    }
    if (parts.length === 2 && parts[1] === 'base' && method === 'PUT') {
      requireJson(req);
      const body = await readBody(req);
      const photoId = body && typeof body === 'object' && typeof body.photoId === 'string' ? body.photoId : '';
      await characters.setBase(id, photoId);
      sendJson(res, 200, { character: characterView(id), ...listView() });
      return true;
    }
    if (parts.length === 2 && parts[1] === 'photos' && method === 'POST') {
      const existing = characters.getCharacter(id);
      if (!existing) throw characterError('character_missing');
      if (existing.photos.length >= MAX_PHOTOS) throw characterError('too_many_photos');
      const filename = url.searchParams.get('filename');
      const added = await receivePhoto(req, tmpPath => characters.addPhoto(id, tmpPath, { filename }));
      const character = characters.getCharacter(id) || added.character;
      sendJson(res, 201, { photo: characters.photoView(added.photo, character, library), character: characterView(character), ...listView() });
      return true;
    }
    if (parts.length === 3 && parts[1] === 'photos' && method === 'DELETE') {
      const photoId = photoIdFrom(parts[2]);
      await removeWithMedia(beforeCommit => characters.removePhoto(id, photoId, { beforeCommit }));
      sendJson(res, 200, { character: characterView(id), ...listView() });
      return true;
    }
    if (parts.length === 4 && parts[1] === 'photos' && parts[3] === 'motions' && method === 'POST') {
      await uploadMotion(req, res, url, id, photoIdFrom(parts[2]));
      return true;
    }
    return false;
  }

  const server = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      // Picks up config.json edits (checked at most once per configCheckIntervalMs).
      await auth.refresh();
      await billing.refresh();
      const listeningAddress = server.address();
      if (listeningAddress && ['127.0.0.1', '::1'].includes(listeningAddress.address)) {
        const allowedHosts = new Set([`127.0.0.1:${listeningAddress.port}`, `localhost:${listeningAddress.port}`, `[::1]:${listeningAddress.port}`]);
        // A reverse proxy / tunnel forwarding publicUrl's Host to this loopback server.
        const publicHost = auth.publicHost();
        if (publicHost) allowedHosts.add(publicHost);
        if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
          return sendJson(res, 403, { error: 'Invalid host.' });
        }
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && !auth.isPublicOrigin(req)) {
        return sendJson(res, 403, { error: 'Cross-origin changes are not allowed.' });
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
        return sendJson(res, 403, { error: 'Cross-site changes are not allowed.' });
      }
      // The Polar webhook comes without a session: before the login routes and the gate
      // (it verifies its own signature).
      if (await billing.handleWebhook(req, res, url)) return;
      // Login routes, then the access gate (sends the refusal itself), then the app.
      if (await auth.handleRoute(req, res, url)) return;
      const access = auth.gate(req, res, url);
      if (!access) return;
      if (await auth.handleApi(req, res, url, access)) return;
      if (await billing.handleApi(req, res, url, access)) return;
      if (req.method === 'GET' && pathname === '/api/library') return sendJson(res, 200, libraryView());
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
        // One write, so the library and the OBS source size arrive together.
        res.write(`data: ${libraryMessage()}\n\ndata: ${JSON.stringify(obsSourceMessage())}\n\n`);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/obs-source') return sendJson(res, 200, obsSource);
      if (req.method === 'POST' && pathname === '/api/obs-source') {
        if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
          return sendJson(res, 415, { error: 'Expected application/json.' });
        }
        const next = parseObsSource(await readBody(req));
        if (!next) return sendJson(res, 400, { error: `width and height must be integers from ${OBS_SOURCE_MIN} to ${OBS_SOURCE_MAX}.` });
        await enqueue(async () => {
          // Skip the write and the broadcast when nothing changed (every reconnect reports again).
          if (obsSource && obsSource.width === next.width && obsSource.height === next.height) return;
          await saveObsSource(next);
        });
        return sendJson(res, 200, obsSource);
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
          // Character box from the alpha channel (null when the file has none).
          const fit = await measureFit(ffmpegPath, ffprobePath, filePath);
          const item = { id, name: sanitizeName(path.basename(originalName, type.ext)), kind, mime: type.mime, url: `/api/media/${id}`, createdAt: new Date().toISOString(), fit };
          let priorIdle;
          await enqueue(async () => {
            // Goes to the photo on air when the upload is saved (none: the legacy idle / no-photo motions).
            const active = characters.active();
            const photoId = active ? active.photo.id : null;
            let next;
            if (kind === 'motion') {
              item.photoId = photoId;
              next = { ...library, motions: [...library.motions, item] };
            } else if (photoId) {
              priorIdle = library.idles[photoId] || null;
              next = { ...library, idles: { ...library.idles, [photoId]: item } };
            } else {
              priorIdle = library.idle;
              next = { ...library, idle: item };
            }
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
        // Only the motions the overlay can see: those of the on-air photo (or of no photo).
        const view = libraryView();
        // The demo avatar never replaces a photo on air (the controller shows no 데모 동작 then).
        if (body.id === 'demo' && view.photo) {
          return sendJson(res, 409, { error: '캐릭터 사진이 방송 중일 때는 데모 동작을 재생할 수 없습니다.', code: 'demo_on_air' });
        }
        if (body.id !== 'demo' && !view.motions.some(item => item.id === body.id)) return sendJson(res, 404, { error: 'Motion not found.' });
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
        // Motions and idles only: photos are deleted through the character API.
        const id = pathname.slice('/api/media/'.length);
        if (!MEDIA_ID_RE.test(id)) return sendJson(res, 404, { error: 'Media not found.' });
        let removed;
        await enqueue(async () => {
          removed = findLibraryItem(id);
          if (!removed) return;
          // An idle uploaded for a photo: the photo shows its own image again.
          const idles = Object.fromEntries(Object.entries(library.idles).filter(([, item]) => item.id !== id));
          const next = { idle: library.idle?.id === id ? null : library.idle, motions: library.motions.filter(item => item.id !== id), idles };
          await save(next);
        });
        if (!removed) return sendJson(res, 404, { error: 'Media not found.' });
        await fsp.rm(mediaPathForItem(removed), { force: true });
        return sendJson(res, 200, { ok: true });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/media/')) {
        const id = pathname.slice('/api/media/'.length);
        const variant = url.searchParams.get('variant');
        if (variant === null) {
          const item = findLibraryItem(id);
          if (item) return serveFile(req, res, mediaPathForItem(item), item.mime);
        }
        // A character photo (the on-air photo is the overlay's idle image), or
        // ?variant=cutout: the photo with its plain background cut out.
        const entry = characters.getPhoto(id);
        if (entry && variant === null) return serveFile(req, res, entry.path, entry.photo.mime);
        if (entry && variant === 'cutout' && entry.photo.cutout && entry.photo.cutout.cut) {
          return serveFile(req, res, characters.cutoutPath(entry.photo), 'image/png');
        }
        return sendJson(res, 404, { error: 'Media not found.' });
      }
      if (await handleCharacters(req, res, url)) return;
      if (await animate.handle(req, res, url, access)) return;
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
  // Library records stored before fit measurement: measured once the server
  // listens, without delaying it. server.fitBackfill resolves when done.
  let closed = false;
  async function backfillFits() {
    const pending = [library.idle, ...Object.values(library.idles), ...library.motions].filter(item => item && !('fit' in item));
    if (!pending.length) return;
    const measured = new Map();
    for (const item of pending) {
      if (closed) return;
      measured.set(item.id, await measureFit(ffmpegPath, ffprobePath, mediaPathForItem(item)));
    }
    if (closed) return;
    // Merge into the CURRENT library inside the mutation queue, so a motion
    // added or deleted meanwhile is kept or stays gone, and a record that got
    // a fit meanwhile is not rewritten.
    await enqueue(async () => {
      let changed = false;
      const apply = item => {
        if (!item || 'fit' in item || !measured.has(item.id)) return item;
        changed = true;
        return { ...item, fit: measured.get(item.id) };
      };
      const idles = Object.fromEntries(Object.entries(library.idles).map(([photoId, item]) => [photoId, apply(item)]));
      const next = { ...library, idle: apply(library.idle), idles, motions: library.motions.map(apply) };
      if (changed && !closed) await save(next);
    });
  }
  server.fitBackfill = new Promise(resolve => {
    server.once('listening', () => {
      setImmediate(() => backfillFits().catch(error => console.warn(`[fit] library backfill failed: ${error.message}`)).finally(resolve));
    });
  });
  // Photos stored before cutouts existed (or undecodable last time) get their
  // cutout decided the same way, in the background; the overlay hears when the
  // on-air photo changes. server.cutoutBackfill resolves when done.
  server.cutoutBackfill = new Promise(resolve => {
    server.once('listening', () => {
      setImmediate(() => characters.backfillCutouts({ isClosed: () => closed })
        .then(changed => { if (changed && !closed) broadcastLibrary(); })
        .catch(error => console.warn(`[characters] cutout backfill failed: ${error.message}`))
        .finally(resolve));
    });
  });

  // Stop running jobs and downloads with the server (tests must not leak), then
  // let the ledger finish its pending writes and refuse new ones.
  server.on('close', () => {
    closed = true;
    animate.close().catch(() => {}).finally(() => billing.close().catch(() => {}));
  });
  server.animate = animate;
  server.auth = auth;
  server.characters = characters;
  server.billing = billing;
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

function isLoopbackHost(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
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
    console.log(`Virtually characters: http://${displayHost}:${port}/`);
    console.log(`Virtually controller: http://${displayHost}:${port}/broadcast`);
    const login = server.auth.summary();
    if (login.mode === 'disabled') {
      console.log(`OBS Browser Source: http://${displayHost}:${port}/overlay`);
      if (!isLoopbackHost(host)) {
        console.warn(`Warning: HOST=${host} is not a loopback address and Google login is off, so anyone who can reach this address controls Virtually. Add data/auth/config.json to require Google login.`);
      }
    } else {
      // "Google login: on (N allowed entries)" or the config problem line.
      console.log(login.text);
      console.log('OBS Browser Source: copy the keyed URL from the controller (/broadcast)');
    }
    const billing = server.billing.summary();
    if (billing.mode === 'enabled') {
      // "Billing (Polar): on (sandbox)", or "Billing: on (admin top-ups; Polar off)"
      console.log(billing.text);
      if (billing.polar && login.publicUrl) {
        console.log(`Polar webhook URL: ${login.publicUrl}${WEBHOOK_PATH}`);
      } else if (billing.polar) {
        console.log('Polar webhooks need a public URL (publicUrl in data/auth/config.json); without one the billing page\'s sync still grants credits.');
      }
    } else if (billing.mode === 'invalid') {
      // "Billing config problem: <code> (data/billing/config.json) - paid generation stays locked until it is fixed"
      console.log(billing.text);
    }
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { createAppServer, listenWithPortRotation, extForMime };
