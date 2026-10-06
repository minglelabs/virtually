'use strict';

// The videos one account keeps (영상 관리): uploaded clips and the ones made from them in
// the editor. The broadcast scene (lib/scene.js) shows them as layers; a video stays here
// when a layer that shows it is taken off the scene.
//
//   <dataDir>/videos.json   { videos: [<video>, ...] }, oldest first
//   <video>                 { id, name, mime, createdAt, width, height, duration, alpha, audio,
//                             source: null | { segments: [{ video, start, end }] } }
//   <mediaDir>/<id><ext>    its file (served by GET /api/media/<id>)
//
// The editor's timeline is a list of pieces, each a span of one of these videos:
// POST /api/videos/render { name, segments: [{ video, start, end }] } writes them one after
// the other as ONE new video (lib/clips.js joinClips). The videos it was cut from stay.
//
// Routes (handle): GET /api/videos, POST /api/videos?name= (the raw file),
// PATCH /api/videos/<id> { name }, DELETE /api/videos/<id>, POST /api/videos/render.
// Every change is sent to the pages as { type: 'videos', videos }.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const clips = require('./clips');
const { MAX_UPLOAD_BYTES, MEDIA_ID_RE, EXT_BY_MIME, requireJson, sendJson, readBody, receiveFile, serveMedia } = require('./server-util');

const MAX_VIDEOS = 200;
const MAX_SEGMENTS = 100;
// What a video made in the editor may last.
const MAX_RENDER_SECONDS = 600;
const MAX_NAME = 100;
const VIDEO_MIMES = ['video/webm', 'video/mp4'];
// A video's file never changes under its id: the browser (and OBS) may keep it.
const MEDIA_CACHE = 'private, max-age=31536000, immutable';

const ERRORS = {
  bad_request: [400, '요청 형식이 올바르지 않습니다.'],
  video_missing: [404, '없는 영상입니다.'],
  too_many_videos: [409, `영상은 ${MAX_VIDEOS}개까지 보관할 수 있습니다. 쓰지 않는 영상을 지워 주세요.`],
  too_large: [413, '파일이 500MB를 넘습니다.'],
  not_a_video: [415, '영상 파일만 올릴 수 있습니다. MP4, WebM, MOV 영상을 올려 주세요.'],
  bad_segments: [400, '타임라인이 올바르지 않습니다.'],
  too_many_segments: [400, `조각은 ${MAX_SEGMENTS}개까지 넣을 수 있습니다.`],
};

function videoError(code, message) {
  const [status, text] = ERRORS[code];
  return Object.assign(new Error(message || text), { status, code });
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => (finite(value) && value > 0 ? value : null);
const round3 = value => Math.round(value * 1000) / 1000;

function cleanName(value, fallback = '') {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || fallback;
}

// A stored video, or null when the record is not one.
function videoRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !MEDIA_ID_RE.test(raw.id)) return null;
  if (!VIDEO_MIMES.includes(raw.mime)) return null;
  const segments = raw.source && Array.isArray(raw.source.segments) ? raw.source.segments.filter(item => item && typeof item.video === 'string') : null;
  return {
    id: raw.id,
    name: cleanName(raw.name, '영상'),
    mime: raw.mime,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    width: positive(raw.width),
    height: positive(raw.height),
    duration: positive(raw.duration),
    alpha: raw.alpha === true,
    audio: raw.audio === true,
    source: segments && segments.length ? { segments: segments.map(item => ({ video: item.video, start: Number(item.start) || 0, end: Number(item.end) || 0 })) } : null,
  };
}

// videos.json as stored -> [video]: malformed and repeated records are dropped.
function parseVideos(stored) {
  const list = [];
  const seen = new Set();
  for (const raw of stored && Array.isArray(stored.videos) ? stored.videos : []) {
    const video = videoRecord(raw);
    if (!video || seen.has(video.id)) continue;
    seen.add(video.id);
    list.push(video);
  }
  return list;
}

// What the pages get: the newest video first, each with the url of its file.
function videosView(list) {
  return [...list].reverse().map(video => ({ ...video, url: `/api/media/${video.id}` }));
}

// The timeline a render was asked for -> [{ video (the record), start, end }] in seconds.
// `find`: id -> record. A piece runs inside its video and lasts at least MIN_PIECE_SECONDS.
function checkSegments(value, find) {
  if (!Array.isArray(value) || !value.length) throw videoError('bad_segments', '타임라인에 영상이 없습니다.');
  if (value.length > MAX_SEGMENTS) throw videoError('too_many_segments');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.video !== 'string' || !MEDIA_ID_RE.test(item.video)) throw videoError('bad_segments');
    const video = find(item.video);
    if (!video) throw videoError('video_missing', '타임라인에 지워진 영상이 있습니다.');
    const length = video.duration || Infinity;
    const start = item.start == null ? 0 : item.start;
    const end = item.end == null ? length : Math.min(item.end, length);
    if (!finite(start) || !finite(end) || start < 0 || !(end - start >= clips.MIN_PIECE_SECONDS)) throw videoError('bad_segments');
    return { video, start: round3(start), end: round3(end) };
  });
}

async function createVideos({
  dataDir, mediaDir, docs, ffmpegPath, ffprobePath,
  // async () => void: throws when ffmpeg is not there.
  requireFfmpeg = async () => {},
  // (message) => void: to every page of the account.
  broadcast = () => {},
  // async ({ ffmpegPath, ffprobePath, sourcePath, workDir, size }) => what the upload is (lib/scene.js processUpload).
  processUpload,
  // async (id) => void: the video was deleted (the scene drops the layers that show it).
  onRemove = async () => {},
}) {
  const storePath = path.join(dataDir, 'videos.json');
  let stored = null;
  try {
    stored = await docs.read(storePath);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  let list = parseVideos(stored);
  let mutation = Promise.resolve();
  function enqueue(callback) {
    const next = mutation.then(callback);
    mutation = next.catch(() => {});
    return next;
  }

  const view = () => videosView(list);
  const find = id => (typeof id === 'string' ? list.find(video => video.id === id) || null : null);
  const filePath = video => path.join(mediaDir, `${video.id}${EXT_BY_MIME[video.mime]}`);

  async function save(next) {
    await docs.write(storePath, { videos: next });
    list = next;
    broadcast({ type: 'videos', videos: view() });
  }

  // A finished file at `sourcePath` becomes a video of the library (the file is moved).
  // -> the record. `id`: keep this id (a file that is already in place under it).
  async function add({ sourcePath, id = null, name, mime, width, height, duration, alpha, audio, source = null, createdAt = null }) {
    const video = videoRecord({
      id: id || crypto.randomUUID(), name, mime, createdAt: createdAt || new Date().toISOString(), width, height, duration, alpha, audio, source,
    });
    if (!video) throw videoError('not_a_video');
    const target = filePath(video);
    let committed = false;
    try {
      await enqueue(async () => {
        if (find(video.id)) throw videoError('bad_request');
        if (list.length >= MAX_VIDEOS) throw videoError('too_many_videos');
        if (sourcePath && sourcePath !== target) await fsp.rename(sourcePath, target);
        await save([...list, video]);
        committed = true;
      });
    } catch (error) {
      if (!committed && sourcePath && sourcePath !== target) await fsp.rm(target, { force: true }).catch(() => {});
      throw error;
    }
    return video;
  }

  // The raw upload in `req` -> what it is, in a work directory the caller removes:
  // { workDir, result (processUpload), name }. Shared with the scene's own upload.
  async function receive(req, url, { tooLarge = () => videoError('too_large'), unsupported = () => videoError('not_a_video') } = {}) {
    if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) throw tooLarge();
    await requireFfmpeg();
    const workDir = path.join(mediaDir, `video-upload.${crypto.randomUUID()}.tmp`);
    await fsp.mkdir(workDir, { recursive: true });
    try {
      const sourcePath = path.join(workDir, 'upload');
      try {
        await receiveFile(req, sourcePath, MAX_UPLOAD_BYTES, ERRORS.too_large[1]);
      } catch (error) {
        if (error.status === 413) throw tooLarge();
        if (error.status === 400) throw unsupported(); // an empty body
        throw error;
      }
      const { size } = await fsp.stat(sourcePath);
      const result = await processUpload({ ffmpegPath, ffprobePath, sourcePath, workDir, size });
      const filename = path.basename(String(url.searchParams.get('name') || '').replace(/\\/g, '/'));
      return { workDir, result, name: cleanName(path.basename(filename, path.extname(filename))) };
    } catch (error) {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // POST /api/videos?name=<file name>: the raw file.
  async function upload(req, res, url) {
    if (list.length >= MAX_VIDEOS) throw videoError('too_many_videos');
    const { workDir, result, name } = await receive(req, url);
    let video;
    try {
      if (result.kind !== 'video') throw videoError('not_a_video');
      video = await add({ sourcePath: result.path, name, ...result });
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    sendJson(res, 201, { video: videosView([video])[0], videos: view() });
  }

  // POST /api/videos/render { name, segments }: the timeline as one new video.
  async function render(req, res) {
    requireJson(req);
    const body = await readBody(req, 64 * 1024);
    if (!body || typeof body !== 'object') throw videoError('bad_request');
    const segments = checkSegments(body.segments, find);
    if (list.length >= MAX_VIDEOS) throw videoError('too_many_videos');
    await requireFfmpeg();
    const workDir = path.join(mediaDir, `video-render.${crypto.randomUUID()}.tmp`);
    await fsp.mkdir(workDir, { recursive: true });
    let video;
    try {
      const made = await clips.joinClips({
        ffmpegPath, ffprobePath, workDir, maxSeconds: MAX_RENDER_SECONDS,
        parts: segments.map(item => ({ path: filePath(item.video), fit: null, start: item.start, end: item.end })),
      });
      video = await add({
        sourcePath: made.path,
        name: cleanName(body.name, cleanName(`${segments[0].video.name} 편집`)),
        mime: made.mime, width: made.width, height: made.height, duration: made.duration, alpha: made.alpha, audio: made.audio,
        source: { segments: segments.map(item => ({ video: item.video.id, start: item.start, end: item.end })) },
      });
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    sendJson(res, 201, { video: videosView([video])[0], videos: view() });
  }

  // Returns true when the request was handled.
  async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (pathname === '/api/videos' && method === 'GET') {
      sendJson(res, 200, { videos: view() });
      return true;
    }
    if (pathname === '/api/videos' && method === 'POST') {
      await upload(req, res, url);
      return true;
    }
    if (pathname === '/api/videos/render' && method === 'POST') {
      await render(req, res);
      return true;
    }
    const match = /^\/api\/videos\/([^/]+)$/.exec(pathname);
    if (!match) return false;
    const id = match[1];
    if (!MEDIA_ID_RE.test(id)) throw videoError('video_missing');
    if (method === 'PATCH') {
      requireJson(req);
      const body = await readBody(req);
      const name = body && typeof body.name === 'string' ? cleanName(body.name) : '';
      if (!name) throw videoError('bad_request', '이름을 입력해 주세요.');
      await enqueue(async () => {
        const video = find(id);
        if (!video) throw videoError('video_missing');
        if (video.name !== name) await save(list.map(item => (item.id === id ? { ...item, name } : item)));
      });
      sendJson(res, 200, { videos: view() });
      return true;
    }
    if (method === 'DELETE') {
      let removed = null;
      await enqueue(async () => {
        removed = find(id);
        if (!removed) throw videoError('video_missing');
        // Off the scene first: a layer never points at a video that is gone.
        await onRemove(id);
        await save(list.filter(video => video.id !== id));
      });
      await fsp.rm(filePath(removed), { force: true }).catch(() => {});
      sendJson(res, 200, { videos: view() });
      return true;
    }
    return false;
  }

  // GET /api/media/<id> of a video (?download=1: as a file to save): true when `id` is one.
  async function serve(req, res, url, id) {
    const video = MEDIA_ID_RE.test(id) ? find(id) : null;
    if (!video) return false;
    const headers = { 'Cache-Control': MEDIA_CACHE };
    if (url.searchParams.get('download') === '1') {
      const filename = `${video.name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'video'}${EXT_BY_MIME[video.mime]}`;
      headers['Content-Disposition'] = `attachment; filename="video${EXT_BY_MIME[video.mime]}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    try {
      await serveMedia(req, res, filePath(video), video.mime, headers);
    } catch (error) {
      if (error.code !== 'ENOENT' || res.headersSent) throw error;
      sendJson(res, 404, { error: 'Media not found.' });
    }
    return true;
  }

  return { view, find, filePath, add, receive, handle, serve, count: () => list.length };
}

module.exports = {
  createVideos, parseVideos, videosView, checkSegments, videoError, cleanName,
  MAX_VIDEOS, MAX_SEGMENTS, MAX_RENDER_SECONDS,
};
