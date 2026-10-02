'use strict';

// One account's data and the routes that act on it: the character store, the
// motion library, the OBS source size, the animate jobs and driving videos, and
// the SSE clients of the overlay and controller. Nothing here knows about other
// accounts: server.js opens one workspace per Google account (<dataDir>/users/<id>/)
// and hands each request to the workspace of the account it belongs to. With login
// off there is a single workspace at <dataDir>/ itself.
//
// Shared by every workspace, passed in: the animate provider config and route
// registry (the server's own API keys), the billing ledger, and the activity log.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { createFileDocs } = require('./docs');
const { createAnimateApi } = require('./animate/api');
const { measureFit } = require('./animate/fit');
const { processMotionUpload } = require('./animate/motion-upload');
const {
  CharacterStore, characterError, checkName, cleanFilename, photoDisplay,
  CHARACTER_ID_RE, PHOTO_ID_RE, MAX_CHARACTERS, MAX_PHOTOS, PHOTO_MAX_BYTES,
} = require('./characters');
const {
  MAX_UPLOAD_BYTES, MEDIA_ID_RE, OBS_SOURCE_MIN, OBS_SOURCE_MAX, extForMime, parseIdles, requireJson, parseObsSource,
  sendJson, sanitizeName, mediaType, hasExpectedSignature, readBody, receiveFile, serveMedia, serveFile,
} = require('./server-util');
const { parseIdleChoice, resolveIdle } = require('./idle');
const { createDirector } = require('./director');
const { createDecider } = require('./director/decider');
const media = require('./animate/media');

// Soniox: a short-lived key so the controller's browser streams the microphone to it directly.
const SONIOX_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';
const SONIOX_MODEL = 'stt-rt-v5';

// Total size of the files under `dir` (symbolic links are not followed).
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(file);
    else if (entry.isFile()) total += (await fsp.stat(file).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// The calls that put new files on disk: refused once the account's storage is full.
const GROWING_ROUTES = [
  ['POST', /^\/api\/characters$/],
  ['POST', /^\/api\/characters\/[^/]+\/photos$/],
  ['POST', /^\/api\/characters\/[^/]+\/photos\/[^/]+\/motions$/],
  ['POST', /^\/api\/characters\/[^/]+\/photos\/[^/]+\/transparent$/],
  ['POST', /^\/api\/upload$/],
  ['POST', /^\/api\/animate\/drivings$/],
  ['POST', /^\/api\/animate\/examples\/fetch$/],
  ['POST', /^\/api\/animate\/jobs$/],
  ['POST', /^\/api\/animate\/jobs\/[^/]+\/(?:motion|key|refetch)$/],
];

async function createWorkspace({
  dataDir,
  docs = createFileDocs(),
  // { sub, email, name } of the account that owns it (null for the login-off workspace).
  owner: initialOwner = null,
  ffmpegPath,
  ffprobePath,
  animateMock = false,
  animatePollIntervalMs = null,
  animateShared,
  examplesManifestPath,
  allowHttpExamples = false,
  bundledDrivingsDir,
  // The downloaded example drivings every account shares (null: this workspace's own).
  sharedExamplesDir = null,
  billing = null,
  activity,
  // Bytes this workspace may hold (null: no limit).
  quotaBytes = null,
  // The AI director (lib/director): { env, fetchImpl } replace the environment and fetch in tests.
  director: directorOptions = {},
}) {
  let owner = initialOwner;
  const mediaDir = path.join(dataDir, 'media');
  const manifestPath = path.join(dataDir, 'library.json');
  await fsp.mkdir(mediaDir, { recursive: true });
  // { idle, motions, idles, idleChoice }: `idle` is the legacy idle (shown while no
  // photo is on air), every motion has a photoId (null = no photo), `idles` maps a
  // photo id to the idle uploaded for that photo, `idleChoice` a photo id to the
  // motion the user chose as that photo's idle (lib/idle.js decides what is shown).
  let library = { idle: null, motions: [], idles: {}, idleChoice: {} };
  const storedLibrary = await docs.read(manifestPath);
  if (storedLibrary && Array.isArray(storedLibrary.motions)) {
    library = {
      idle: storedLibrary.idle || null, motions: storedLibrary.motions, idles: parseIdles(storedLibrary.idles),
      idleChoice: parseIdleChoice(storedLibrary.idleChoice),
    };
  }
  // Latest viewport size reported by the OBS browser source ({width, height} or null).
  const obsSourcePath = path.join(dataDir, 'obs-source.json');
  let obsSource = null;
  try {
    obsSource = parseObsSource(await docs.read(obsSourcePath));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
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
  // and the motions without a photo. A motion that is the photo's idle
  // (lib/idle.js) loops as the idle and is not one of the motion buttons.
  function libraryView() {
    const active = characters.active();
    if (!active) return { idle: library.idle, motions: library.motions.filter(item => !item.photoId), character: null, photo: null };
    const { character, photo } = active;
    const idle = resolveIdle(library, photo.id);
    const idleMotion = idle.kind === 'motion' ? idle.motion : null;
    return {
      idle: idleMotion ? { ...idleMotion, kind: 'idle' } : idle.kind === 'upload' ? idle.item : photoIdle(character, photo),
      motions: library.motions.filter(item => item.photoId === photo.id && item !== idleMotion),
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
    // A choice whose motion is gone (deleted, or its photo was) goes with it.
    const idleChoice = Object.fromEntries(Object.entries(next.idleChoice || {})
      .filter(([photoId, motionId]) => next.motions.some(item => item.id === motionId && item.photoId === photoId)));
    const value = { idle: next.idle || null, motions: next.motions, idles: next.idles || {}, idleChoice };
    await docs.write(manifestPath, value);
    library = value;
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
    await docs.write(obsSourcePath, next);
    obsSource = next;
    broadcast(obsSourceMessage());
  }

  // Characters and the on-air photo (migrates the old character library once).
  const characters = await new CharacterStore({ dataDir, docs, ffmpegPath, ffprobePath }).load({ library, writeLibrary });
  lastLibraryMessage = libraryMessage();

  const animate = await createAnimateApi({
    dataDir, docs, mediaDir, ffmpegPath, ffprobePath, mock: animateMock, pollIntervalMs: animatePollIntervalMs,
    examplesManifestPath, allowHttpExamples, bundledDrivingsDir, sharedExamplesDir, shared: animateShared,
    getLibrary: () => library, mediaPathForItem, enqueue, save, broadcast,
    getPhoto: id => characters.getPhoto(id),
    aiCutout: (characterId, photoId) => aiCutout(characterId, photoId),
    sendJson, readBody, receiveFile, serveMedia, sanitizeName, billing,
  });

  // --- the AI director (/api/director*): motions picked from what the streamer says ---
  const directorEnv = directorOptions.env || process.env;
  const directorFetch = directorOptions.fetchImpl || ((...args) => fetch(...args));
  const motionSeconds = new Map(); // motion id -> length in seconds (null: unknown)
  const director = createDirector({
    decider: createDecider({ env: directorEnv, fetchImpl: directorFetch, log: message => console.warn(message) }),
    getView: () => libraryView(),
    play: motion => {
      const seq = ++sequence;
      broadcast({ type: 'play', id: motion.id, seq });
      return seq;
    },
    stop: () => broadcast({ type: 'idle', seq: ++sequence }),
    durationOf: async motion => {
      if (!motionSeconds.has(motion.id)) {
        const probed = await media.probeVideo(ffprobePath, mediaPathForItem(motion)).catch(() => null);
        motionSeconds.set(motion.id, probed && Number.isFinite(probed.duration) ? probed.duration : null);
      }
      return motionSeconds.get(motion.id);
    },
    onChange: state => broadcast({ type: 'director', state }),
    stt: { configured: Boolean(directorEnv.SONIOX_API_KEY) },
    tickMs: directorOptions.tickMs,
    log: message => console.warn(message),
  });

  // Returns true when the request was handled.
  async function handleDirector(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (!pathname.startsWith('/api/director')) return false;
    if (pathname === '/api/director' && method === 'GET') {
      sendJson(res, 200, director.state());
      return true;
    }
    if (pathname === '/api/director' && method === 'POST') {
      requireJson(req);
      const body = await readBody(req);
      if (!body || typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false.'), { status: 400, code: 'bad_request' });
      sendJson(res, 200, director.setEnabled(body.enabled));
      return true;
    }
    if (pathname === '/api/director/speech' && method === 'POST') {
      requireJson(req);
      const body = await readBody(req);
      director.speech(body && typeof body.text === 'string' ? body.text : '');
      sendJson(res, 200, { ok: true });
      return true;
    }
    // The overlay finished the motion of a 'play' message (the queue goes on).
    if (pathname === '/api/director/done' && method === 'POST') {
      requireJson(req);
      const body = await readBody(req);
      sendJson(res, 200, { ok: director.done(body && Number.isInteger(body.seq) ? body.seq : -1) });
      return true;
    }
    if (pathname === '/api/director/skip' && method === 'POST') {
      await readBody(req).catch(error => { if (error.status !== 400) throw error; });
      director.skip();
      sendJson(res, 200, director.state());
      return true;
    }
    if (pathname === '/api/director/queue' && method === 'DELETE') {
      director.clear();
      sendJson(res, 200, director.state());
      return true;
    }
    if (pathname.startsWith('/api/director/queue/') && method === 'DELETE') {
      if (!director.remove(pathname.slice('/api/director/queue/'.length))) {
        sendJson(res, 404, { error: '이미 대기열에 없는 동작입니다.', code: 'queue_item_missing' });
        return true;
      }
      sendJson(res, 200, director.state());
      return true;
    }
    if (pathname === '/api/director/stt-key' && method === 'POST') {
      await readBody(req).catch(error => { if (error.status !== 400) throw error; });
      if (!directorEnv.SONIOX_API_KEY) {
        sendJson(res, 503, { error: '음성 인식 설정(SONIOX_API_KEY)이 서버에 없습니다.', code: 'stt_not_configured' });
        return true;
      }
      let key = null;
      try {
        const response = await directorFetch(SONIOX_KEY_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${directorEnv.SONIOX_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 300 }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data && typeof data.api_key === 'string') key = data.api_key;
        else console.warn(`[director] Soniox key request failed: HTTP ${response.status}`);
      } catch (error) {
        console.warn(`[director] Soniox key request failed: ${error.message}`);
      }
      if (!key) {
        sendJson(res, 502, { error: '음성 인식 서비스에 연결하지 못했습니다.', code: 'stt_unavailable' });
        return true;
      }
      sendJson(res, 200, { apiKey: key, model: SONIOX_MODEL, url: 'wss://stt-rt.soniox.com/transcribe-websocket' });
      return true;
    }
    return false;
  }

  // The photo's background removed by the paid AI remover (animate/background-ai.js), kept
  // as the photo's cutout so it is paid once. -> { path, called } (called: the AI ran now).
  async function aiCutout(characterId, photoId, { again = false } = {}) {
    const entry = characters.getPhoto(photoId);
    if (!entry || entry.character.id !== characterId) throw characterError('photo_missing');
    const made = entry.photo.cutout && entry.photo.cutout.cut && entry.photo.cutout.method === 'ai' && fs.existsSync(characters.cutoutPath(entry.photo));
    if (made && !again) return { path: characters.cutoutPath(entry.photo), called: false };
    if (!animate.backgroundAi.available()) throw Object.assign(new Error('AI 배경 제거 설정이 서버에 없습니다.'), { status: 503, code: 'background_ai_unavailable' });
    await characters.makeTransparent(characterId, photoId, { method: 'ai', removeBackground: (src, dest) => animate.backgroundAi.image(src, dest) });
    broadcastLibrary();
    return { path: characters.cutoutPath(characters.getPhoto(photoId).photo), called: true };
  }

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
    // The photo's idle: one of its motions ({ motionId }), or null for the default
    // (its 기본 대기 동작 when there is one, else the photo itself). See lib/idle.js.
    if (parts.length === 4 && parts[1] === 'photos' && parts[3] === 'idle' && method === 'PUT') {
      requireJson(req);
      const body = await readBody(req);
      const photoId = photoIdFrom(parts[2]);
      const motionId = body && typeof body === 'object' ? body.motionId : undefined;
      if (motionId !== null && typeof motionId !== 'string') throw Object.assign(new Error('motionId must be a motion id or null.'), { status: 400, code: 'bad_request' });
      await enqueue(async () => {
        const entry = characters.getPhoto(photoId);
        if (!entry || entry.character.id !== id) throw characterError('photo_missing');
        const idleChoice = { ...library.idleChoice };
        if (motionId === null) delete idleChoice[photoId];
        else {
          if (!library.motions.some(item => item.id === motionId && item.photoId === photoId)) {
            throw Object.assign(new Error('이 사진의 동작이 아닙니다.'), { status: 404, code: 'motion_missing' });
          }
          idleChoice[photoId] = motionId;
        }
        await save({ ...library, idleChoice });
      });
      sendJson(res, 200, { character: characterView(id), ...listView() });
      return true;
    }
    // The photo's background: POST cuts a plain one out (local, free), DELETE goes back to the photo as uploaded.
    if (parts.length === 4 && parts[1] === 'photos' && parts[3] === 'transparent' && (method === 'POST' || method === 'DELETE')) {
      const photoId = photoIdFrom(parts[2]);
      const body = await readBody(req).catch(error => { if (error.status !== 400) throw error; });
      if (method === 'DELETE') await characters.keepOriginal(id, photoId);
      // { "method": "ai" }: the paid AI remover, for a background that is not one colour.
      else if (body && body.method === 'ai') await aiCutout(id, photoId, { again: true });
      else await characters.makeTransparent(id, photoId);
      // The photo on air is shown as its cutout (or as itself again).
      broadcastLibrary();
      sendJson(res, 200, { character: characterView(id), ...listView() });
      return true;
    }
    if (parts.length === 4 && parts[1] === 'photos' && parts[3] === 'motions' && method === 'POST') {
      await uploadMotion(req, res, url, id, photoIdFrom(parts[2]));
      return true;
    }
    return false;
  }

  // --- everything else this account's data answers ---------------------------
  // Returns true when the request was handled. `access` is the auth gate's verdict.
  async function handle(req, res, url, access) {
    const { pathname } = url;
    if (quotaBytes != null && GROWING_ROUTES.some(([method, pattern]) => req.method === method && pattern.test(pathname))) {
      const used = await dirSize(dataDir);
      if (used + (Number(req.headers['content-length']) || 0) > quotaBytes) {
        const gb = Math.round((quotaBytes / 1024 ** 3) * 10) / 10;
        sendJson(res, 413, { error: `저장 공간(${gb}GB)이 가득 찼습니다. 쓰지 않는 캐릭터, 사진, 모션, 동작 영상을 지워 주세요.`, code: 'quota_exceeded' });
        return true;
      }
    }
    if (req.method === 'GET' && pathname === '/api/library') {
      sendJson(res, 200, libraryView());
      return true;
    }
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
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/obs-source') {
      sendJson(res, 200, obsSource);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/obs-source') {
      if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'Expected application/json.' });
        return true;
      }
      const next = parseObsSource(await readBody(req));
      if (!next) {
        sendJson(res, 400, { error: `width and height must be integers from ${OBS_SOURCE_MIN} to ${OBS_SOURCE_MAX}.` });
        return true;
      }
      await enqueue(async () => {
        // Skip the write and the broadcast when nothing changed (every reconnect reports again).
        if (obsSource && obsSource.width === next.width && obsSource.height === next.height) return;
        await saveObsSource(next);
      });
      sendJson(res, 200, obsSource);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/upload') {
      const kind = url.searchParams.get('kind');
      const originalName = url.searchParams.get('name') || '';
      const filename = url.searchParams.get('filename') || originalName;
      const type = mediaType(kind, filename, req.headers['content-type']);
      if (!['idle', 'motion'].includes(kind) || !type) {
        sendJson(res, 415, { error: 'Upload a WebM motion, or a WebM/PNG/WebP idle asset.' });
        return true;
      }
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_UPLOAD_BYTES) {
        sendJson(res, 413, { error: 'File exceeds 500 MB.' });
        return true;
      }
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
        sendJson(res, 201, item);
        return true;
      } catch (error) {
        if (!committed) await fsp.rm(filePath, { force: true });
        throw error;
      }
    }
    if (req.method === 'POST' && pathname === '/api/trigger') {
      if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'Expected application/json.' });
        return true;
      }
      const body = await readBody(req);
      if (!body || typeof body.id !== 'string') {
        sendJson(res, 400, { error: 'Motion id is required.' });
        return true;
      }
      // Only the motions the overlay can see: those of the on-air photo (or of no photo).
      const view = libraryView();
      // The demo avatar never replaces a photo on air (the controller shows no 데모 동작 then).
      if (body.id === 'demo' && view.photo) {
        sendJson(res, 409, { error: '캐릭터 사진이 방송 중일 때는 데모 동작을 재생할 수 없습니다.', code: 'demo_on_air' });
        return true;
      }
      if (body.id !== 'demo' && !view.motions.some(item => item.id === body.id)) {
        sendJson(res, 404, { error: 'Motion not found.' });
        return true;
      }
      const seq = ++sequence;
      broadcast({ type: 'play', id: body.id, seq });
      const played = view.motions.find(item => item.id === body.id);
      activity.record(access, 'motion.trigger', {
        motionId: body.id,
        motionName: played ? played.name : null,
        characterId: view.character ? view.character.id : null,
        characterName: view.character ? view.character.name : null,
        photoId: view.photo ? view.photo.id : null,
      });
      sendJson(res, 200, { ok: true, seq });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/idle') {
      if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'Expected application/json.' });
        return true;
      }
      // The body (usually {}) is drained with the usual size limit; its contents are ignored,
      // so an empty or non-JSON body is accepted too.
      await readBody(req).catch(error => { if (error.status !== 400) throw error; });
      const seq = ++sequence;
      broadcast({ type: 'idle', seq });
      sendJson(res, 200, { ok: true, seq });
      return true;
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/media/')) {
      // Motions and idles only: photos are deleted through the character API.
      const id = pathname.slice('/api/media/'.length);
      if (!MEDIA_ID_RE.test(id)) {
        sendJson(res, 404, { error: 'Media not found.' });
        return true;
      }
      let removed;
      await enqueue(async () => {
        removed = findLibraryItem(id);
        if (!removed) return;
        // An idle uploaded for a photo: the photo shows its own image again.
        const idles = Object.fromEntries(Object.entries(library.idles).filter(([, item]) => item.id !== id));
        const next = { ...library, idle: library.idle?.id === id ? null : library.idle, motions: library.motions.filter(item => item.id !== id), idles };
        await save(next);
      });
      if (!removed) {
        sendJson(res, 404, { error: 'Media not found.' });
        return true;
      }
      await fsp.rm(mediaPathForItem(removed), { force: true });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/media/')) {
      const id = pathname.slice('/api/media/'.length);
      const variant = url.searchParams.get('variant');
      if (variant === null) {
        const item = findLibraryItem(id);
        if (item) {
          await serveFile(req, res, mediaPathForItem(item), item.mime);
          return true;
        }
      }
      // A character photo (the on-air photo is the overlay's idle image), or
      // ?variant=cutout: the photo with its plain background cut out.
      const entry = characters.getPhoto(id);
      if (entry && variant === null) {
        await serveFile(req, res, entry.path, entry.photo.mime);
        return true;
      }
      if (entry && variant === 'cutout' && entry.photo.cutout && entry.photo.cutout.cut) {
        await serveFile(req, res, characters.cutoutPath(entry.photo), 'image/png');
        return true;
      }
      sendJson(res, 404, { error: 'Media not found.' });
      return true;
    }
    if (await handleDirector(req, res, url)) return true;
    if (await handleCharacters(req, res, url)) return true;
    if (await animate.handle(req, res, url, access)) return true;
    return false;
  }

  // --- the admin page's view of this account's data ---------------------------

  function adminSnapshot() {
    const label = (kind, id) => activity.ownerOf(kind, id) || (owner && owner.email) || null;
    const motionView = item => ({ id: item.id, name: item.name, mime: item.mime, url: `/api/media/${item.id}`, createdAt: item.createdAt, owner: label('motion', item.id) });
    const list = listView();
    return {
      activePhotoId: list.activePhotoId,
      characters: list.characters.map(character => ({
        id: character.id,
        name: character.name,
        createdAt: character.createdAt,
        onAir: character.onAir,
        owner: label('character', character.id),
        photos: character.photos.map(photo => ({
          id: photo.id,
          url: photo.url,
          displayUrl: photo.displayUrl || photo.url,
          isBase: photo.isBase,
          onAir: photo.onAir,
          createdAt: photo.createdAt,
          owner: label('photo', photo.id),
          motions: photo.motions.map(motion => motionView(motion)),
        })),
      })),
      looseMotions: library.motions.filter(item => !item.photoId).map(motionView),
    };
  }

  async function adminAnimateSnapshot() {
    const label = (kind, id) => activity.ownerOf(kind, id) || (owner && owner.email) || null;
    const uploads = (await animate.drivings.list()).filter(item => item.kind === 'upload');
    return {
      drivings: uploads.map(item => ({
        id: item.id,
        label: item.label,
        url: item.url,
        posterUrl: item.posterUrl,
        duration: item.duration,
        createdAt: (animate.drivings.uploads.get(item.id) || {}).createdAt || null,
        owner: label('driving', item.id),
      })),
      jobs: animate.pipeline.list().map(job => {
        const view = animate.pipeline.view(job);
        return {
          id: view.id,
          state: view.state,
          routeLabel: view.routeLabel,
          drivingLabel: view.drivingLabel,
          characterLabel: view.characterLabel,
          photoId: view.photoId,
          createdAt: view.createdAt,
          finishedAt: view.finishedAt,
          error: view.error ? view.error.message : null,
          credits: view.billing ? view.billing.credits : null,
          resultUrl: view.result ? view.result.url : null,
          posterUrl: view.result ? view.result.posterUrl : null,
          motionName: view.motionName,
          owner: activity.ownerOf('job', view.id) || (job.billing && job.billing.email) || (owner && owner.email) || null,
        };
      }),
    };
  }

  // --- background work and shutdown --------------------------------------------

  let closed = false;
  // Library records stored before fit measurement: measured without delaying
  // the server. Resolves when done.
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

  // Both backfills (the fit of old library records, the cutout of photos stored
  // before cutouts existed); the overlay hears when the on-air photo changes.
  // Resolves { fits, cutouts } when each is done.
  function backfill() {
    const fits = new Promise(resolve => {
      setImmediate(() => backfillFits().catch(error => console.warn(`[fit] library backfill failed: ${error.message}`)).finally(resolve));
    });
    const cutouts = new Promise(resolve => {
      setImmediate(() => characters.backfillCutouts({ isClosed: () => closed })
        .then(changed => { if (changed && !closed) broadcastLibrary(); })
        .catch(error => console.warn(`[characters] cutout backfill failed: ${error.message}`))
        .finally(resolve));
    });
    return { fits, cutouts };
  }

  async function close() {
    closed = true;
    // The overlay and controller streams belong to this workspace only.
    for (const client of clients) {
      try { client.end(); } catch { /* already gone */ }
    }
    clients.clear();
    director.close();
    await animate.close().catch(() => {});
  }

  return {
    dataDir, characters, animate, director, handle, adminSnapshot, adminAnimateSnapshot, backfill, close, libraryView,
    get owner() { return owner; },
    setOwner(next) { owner = next; },
  };
}

module.exports = { createWorkspace };
