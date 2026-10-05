'use strict';

// The broadcast scene of one account: what the overlay draws, as layers.
//
// A list of layers from the back to the front. One of them is always the character
// (its idle and motions, as before); the others are videos and images the streamer
// uploaded: a looping background, a frame, a logo. The streamer orders them, hides
// them, and sizes and places the ones that do not fill the canvas, so the whole
// picture can be put together here and sent to OBS as one browser source.
//
//   <dataDir>/scene.json   { layers: [<layer>, ...] }, back -> front
//   <layer>   the character  { id: 'character', kind: 'character', visible, scale, x, y }
//             a video/image  { id, kind: 'video' | 'image', name, mime, createdAt, width, height,
//                              duration, alpha, audio, visible, fill, scale, x, y, muted }
//   <mediaDir>/<id><ext>   the layer's file (served by GET /api/media/<id>)
//
// fill: the layer covers the whole canvas, cropped to it. Otherwise it is fitted inside
// the canvas, scaled by `scale` and moved by x, y: fractions of the canvas width and
// height, from the centre. The character scales around the middle of its bottom edge.
//
// Routes (handle): GET /api/scene, POST /api/scene/layers (the raw file),
// PATCH /api/scene/layers/<id>, POST /api/scene/layers/<id>/move, DELETE /api/scene/layers/<id>.
// Every change is sent to the pages as { type: 'scene', scene } (broadcast).

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const media = require('./animate/media');
const key = require('./animate/key');
const { containerOf } = require('./animate/motion-upload');
const { MAX_UPLOAD_BYTES, MEDIA_ID_RE, EXT_BY_MIME, requireJson, sendJson, readBody, receiveFile, serveMedia } = require('./server-util');

const CHARACTER_ID = 'character';
const MAX_LAYERS = 20;
const SCALE_MIN = 0.05;
const SCALE_MAX = 4;
const OFFSET_MAX = 1.5;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
// A video that has to be re-encoded is converted inside the upload request.
const MAX_CONVERT_SECONDS = 300;
const MAX_NAME = 100;
const PROBE_TIMEOUT_MS = 60 * 1000;
const REMUX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ENCODE_WIDTH = 1920;
// What a browser (and the OBS browser source) plays as it is.
const WEBM_CODECS = new Set(['vp8', 'vp9', 'av1']);
const H264_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);
const MP4_AUDIO_CODECS = new Set(['aac', 'mp3']);
const MOVES = ['top', 'up', 'down', 'bottom'];
// A layer's file never changes under its id: the browser (and OBS) may keep it.
const MEDIA_CACHE = 'private, max-age=31536000, immutable';

const ERRORS = {
  bad_request: [400, '요청 형식이 올바르지 않습니다.'],
  layer_missing: [404, '없는 레이어입니다.'],
  character_fixed: [400, '캐릭터 레이어는 지울 수 없습니다.'],
  too_many_layers: [409, `영상과 이미지는 ${MAX_LAYERS}개까지 넣을 수 있습니다.`],
  too_large: [413, '파일이 500MB를 넘습니다.'],
  too_large_image: [413, '이미지가 30MB를 넘습니다.'],
  unsupported_media: [415, '지원하지 않는 파일입니다. MP4, WebM, MOV 영상이나 PNG, JPEG, WebP, GIF 이미지를 올려 주세요.'],
  too_long_to_convert: [422, `이 형식은 변환이 필요해서 ${MAX_CONVERT_SECONDS / 60}분까지만 올릴 수 있습니다. MP4(H.264)나 WebM은 길이 제한이 없습니다.`],
  convert_failed: [422, '영상을 변환하지 못했습니다. MP4(H.264)나 WebM으로 올려 주세요.'],
};

function sceneError(code, message) {
  const [status, text] = ERRORS[code];
  return Object.assign(new Error(message || text), { status, code });
}

// ---- the record --------------------------------------------------------------

const round4 = value => Math.round(value * 10000) / 10000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max, fallback) => (finite(value) ? round4(Math.min(max, Math.max(min, value))) : fallback);
const positive = value => (finite(value) && value > 0 ? value : null);

function cleanName(value, fallback = '') {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || fallback;
}

function placement(raw) {
  return {
    scale: clamp(raw.scale, SCALE_MIN, SCALE_MAX, 1),
    x: clamp(raw.x, -OFFSET_MAX, OFFSET_MAX, 0),
    y: clamp(raw.y, -OFFSET_MAX, OFFSET_MAX, 0),
  };
}

function characterLayer(raw = {}) {
  return { id: CHARACTER_ID, kind: 'character', visible: raw.visible !== false, ...placement(raw) };
}

// A stored video or image layer, or null when the record is not one.
function mediaLayer(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !MEDIA_ID_RE.test(raw.id)) return null;
  if (!['video', 'image'].includes(raw.kind) || !Object.hasOwn(EXT_BY_MIME, raw.mime) || !raw.mime.startsWith(`${raw.kind}/`)) return null;
  return {
    id: raw.id,
    kind: raw.kind,
    name: cleanName(raw.name, raw.kind === 'video' ? '영상' : '이미지'),
    mime: raw.mime,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    width: positive(raw.width),
    height: positive(raw.height),
    duration: positive(raw.duration),
    alpha: raw.alpha === true,
    audio: raw.audio === true,
    visible: raw.visible !== false,
    fill: raw.fill !== false,
    ...placement(raw),
    muted: raw.muted !== false,
  };
}

// scene.json as stored -> { layers }: malformed and repeated layers are dropped, and the
// character is always there (in front of everything when the record has none).
function parseScene(stored) {
  const layers = [];
  const seen = new Set();
  for (const raw of stored && Array.isArray(stored.layers) ? stored.layers : []) {
    const layer = raw && raw.id === CHARACTER_ID ? characterLayer(raw) : mediaLayer(raw);
    if (!layer || seen.has(layer.id)) continue;
    seen.add(layer.id);
    layers.push(layer);
  }
  if (!seen.has(CHARACTER_ID)) layers.push(characterLayer());
  return { layers };
}

// The layer with the fields of `patch` that it has: { name, visible, fill, muted, scale, x, y }.
// A field of the wrong type, or nothing to change, is a bad request.
function patchLayer(layer, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw sceneError('bad_request');
  const isMedia = layer.kind !== 'character';
  const next = { ...layer };
  let touched = false;
  const take = (field, valid, apply) => {
    if (patch[field] === undefined) return;
    if (!valid(patch[field])) throw sceneError('bad_request', `${field} 값이 올바르지 않습니다.`);
    apply(patch[field]);
    touched = true;
  };
  const isBoolean = value => typeof value === 'boolean';
  take('visible', isBoolean, (value) => { next.visible = value; });
  take('scale', finite, (value) => { next.scale = clamp(value, SCALE_MIN, SCALE_MAX, 1); });
  take('x', finite, (value) => { next.x = clamp(value, -OFFSET_MAX, OFFSET_MAX, 0); });
  take('y', finite, (value) => { next.y = clamp(value, -OFFSET_MAX, OFFSET_MAX, 0); });
  if (isMedia) {
    take('name', value => typeof value === 'string' && Boolean(cleanName(value)), (value) => { next.name = cleanName(value); });
    take('fill', isBoolean, (value) => { next.fill = value; });
    if (layer.kind === 'video') take('muted', isBoolean, (value) => { next.muted = value; });
  }
  if (!touched) throw sceneError('bad_request');
  return next;
}

// `layers` (back -> front) with the layer `id` moved: 'top' (the very front), 'up' (one
// step to the front), 'down', 'bottom'. The same array when it is already there.
function moveLayer(layers, id, to) {
  const from = layers.findIndex(layer => layer.id === id);
  if (from < 0) throw sceneError('layer_missing');
  if (!MOVES.includes(to)) throw sceneError('bad_request', "to는 'top', 'up', 'down', 'bottom' 중 하나여야 합니다.");
  const last = layers.length - 1;
  const target = to === 'top' ? last : to === 'bottom' ? 0 : Math.min(last, Math.max(0, from + (to === 'up' ? 1 : -1)));
  if (target === from) return layers;
  const next = layers.filter(layer => layer.id !== id);
  next.splice(target, 0, layers[from]);
  return next;
}

// What the pages get: the layers, each video and image with the url of its file.
function sceneView(scene) {
  return { layers: scene.layers.map(layer => (layer.kind === 'character' ? { ...layer } : { ...layer, url: `/api/media/${layer.id}` })) };
}

// ---- an uploaded file ----------------------------------------------------------

async function readHead(filePath, length = 64) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// The image type of a file head: its mime, or null.
function imageMime(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 6 && ['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

// { container, codec, pixFmt, alpha, vpxAlpha, duration, audioCodec } of a video file
// (cover art does not count as its picture), or null.
async function probeUpload(ffprobePath, filePath, head) {
  const probed = await media.run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { timeoutMs: PROBE_TIMEOUT_MS });
  let json;
  try { json = JSON.parse(probed.stdout.toString() || '{}'); } catch { return null; }
  const format = json.format || {};
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic));
  const container = containerOf(format.format_name, head);
  if (!video || !container) return null;
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const codec = video.codec_name || null;
  const pixFmt = video.pix_fmt || null;
  const alphaTag = Object.entries(video.tags || {}).find(([tag]) => tag.toLowerCase() === 'alpha_mode');
  // VP8/VP9 keep their alpha in a side channel the pixel format does not show.
  const vpxAlpha = (codec === 'vp8' || codec === 'vp9') && Boolean(alphaTag) && String(alphaTag[1]) === '1';
  return {
    container,
    codec,
    pixFmt,
    vpxAlpha,
    alpha: vpxAlpha || (media.pixFmtHasAlpha(pixFmt) && pixFmt !== 'pal8'),
    duration: positive(Number(video.duration)) || positive(Number(format.duration)),
    audioCodec: audio ? audio.codec_name || 'unknown' : null,
  };
}

async function ffmpeg(ffmpegPath, args, timeoutMs, what) {
  const result = await media.run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeoutMs });
  if (result.timedOut) throw new Error(`${what} timed out.`);
  if (result.code !== 0) throw new Error(media.tidy(result.stderr) || `${what} failed.`);
}

const encodeTimeout = duration => Math.max(120 * 1000, 2.5 * 1000 * (Number(duration) || MAX_CONVERT_SECONDS));

// The raw upload at `sourcePath` (inside `workDir`) -> the file to keep and what it is:
// { path, kind, mime, width, height, duration, alpha, audio, converted }. An image is kept
// as it is, and so is a video browsers play (WebM VP8/VP9/AV1, MP4 H.264); an H.264 MOV is
// rewrapped as MP4; anything else is re-encoded (H.264 + AAC, or VP9 with its alpha).
async function processUpload({ ffmpegPath, ffprobePath, sourcePath, workDir, size }) {
  const head = await readHead(sourcePath);
  const image = imageMime(head);
  if (image) {
    if (size > MAX_IMAGE_BYTES) throw sceneError('too_large_image');
    const info = await media.probeVideo(ffprobePath, sourcePath).catch(() => null);
    return {
      path: sourcePath, kind: 'image', mime: image, width: info ? info.width : null, height: info ? info.height : null,
      duration: null, alpha: image !== 'image/jpeg', audio: false, converted: false,
    };
  }
  const info = await probeUpload(ffprobePath, sourcePath, head).catch(() => null);
  if (!info) throw sceneError('unsupported_media');
  const out = { kind: 'video', alpha: info.alpha, audio: Boolean(info.audioCodec), converted: false };
  const keep = async (ext) => {
    const target = path.join(workDir, `layer${ext}`);
    await fsp.rename(sourcePath, target);
    return target;
  };
  const reencode = async (run) => {
    if (info.duration && info.duration > MAX_CONVERT_SECONDS + 0.05) throw sceneError('too_long_to_convert');
    try {
      await run();
    } catch (error) {
      console.warn(`[scene] ${error.message || error}`);
      throw sceneError('convert_failed');
    }
    out.converted = true;
  };
  const h264 = (info.container === 'mp4' || info.container === 'mov') && info.codec === 'h264' && H264_PIX_FMTS.has(info.pixFmt);
  const audioOk = !info.audioCodec || MP4_AUDIO_CODECS.has(info.audioCodec);
  if (info.container === 'webm' && WEBM_CODECS.has(info.codec)) {
    out.path = await keep('.webm');
    out.mime = 'video/webm';
  } else if (info.alpha) {
    // Alpha in another wrapper or codec (a ProRes 4444 MOV): VP9 with the alpha; the sound goes.
    out.path = path.join(workDir, 'alpha.webm');
    out.mime = 'video/webm';
    out.audio = false;
    const inputArgs = info.vpxAlpha ? ['-c:v', info.codec === 'vp8' ? 'libvpx' : 'libvpx-vp9'] : [];
    await reencode(() => key.encodeAlphaWebm(ffmpegPath, sourcePath, out.path, { inputArgs, duration: info.duration, what: 'Alpha conversion' }));
  } else if (h264 && info.container === 'mp4' && audioOk) {
    out.path = await keep('.mp4');
    out.mime = 'video/mp4';
  } else {
    out.path = path.join(workDir, 'converted.mp4');
    out.mime = 'video/mp4';
    let rewrapped = false;
    if (h264) {
      // The picture as it is, in an MP4 (the sound too when a browser plays it).
      rewrapped = await ffmpeg(ffmpegPath, ['-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy',
        ...(audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']), '-movflags', '+faststart', '-f', 'mp4', out.path], REMUX_TIMEOUT_MS, 'Rewrapping')
        .then(() => true, (error) => { console.warn(`[scene] ${error.message}`); return false; });
    }
    if (!rewrapped) {
      await reencode(() => ffmpeg(ffmpegPath, ['-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `scale=trunc(min(iw\\,${MAX_ENCODE_WIDTH})/2)*2:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', out.path], encodeTimeout(info.duration), 'Video conversion'));
    }
  }
  // As a browser shows it (a rotated phone clip has its sides swapped).
  const shown = await media.probeVideo(ffprobePath, out.path).catch(() => null);
  if (!shown) throw sceneError('unsupported_media');
  return { ...out, width: shown.width, height: shown.height, duration: shown.duration || info.duration || null };
}

// ---- the store and its routes ----------------------------------------------------

async function createScene({
  dataDir, mediaDir, docs, ffmpegPath, ffprobePath,
  // async () => void: throws when ffmpeg is not there (uploads need it).
  requireFfmpeg = async () => {},
  // (message) => void: to every page of the account.
  broadcast = () => {},
}) {
  const scenePath = path.join(dataDir, 'scene.json');
  let stored = null;
  try {
    stored = await docs.read(scenePath);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  let scene = parseScene(stored);
  let mutation = Promise.resolve();
  function enqueue(callback) {
    const next = mutation.then(callback);
    mutation = next.catch(() => {});
    return next;
  }

  const view = () => sceneView(scene);
  const message = () => ({ type: 'scene', scene: view() });
  const find = id => scene.layers.find(layer => layer.id === id) || null;
  const filePath = layer => path.join(mediaDir, `${layer.id}${EXT_BY_MIME[layer.mime]}`);
  const mediaCount = () => scene.layers.filter(layer => layer.kind !== 'character').length;

  async function save(layers) {
    const next = { layers };
    await docs.write(scenePath, next);
    scene = next;
    broadcast(message());
  }

  // POST /api/scene/layers?name=<file name>: the raw file. The new layer goes right behind
  // the character (in front of the layers already behind it), filling the canvas.
  async function upload(req, res, url) {
    if (mediaCount() >= MAX_LAYERS) throw sceneError('too_many_layers');
    if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) throw sceneError('too_large');
    await requireFfmpeg();
    const workDir = path.join(mediaDir, `scene-upload.${crypto.randomUUID()}.tmp`);
    await fsp.mkdir(workDir, { recursive: true });
    let layer;
    try {
      const sourcePath = path.join(workDir, 'upload');
      try {
        await receiveFile(req, sourcePath, MAX_UPLOAD_BYTES, ERRORS.too_large[1]);
      } catch (error) {
        if (error.status === 413) throw sceneError('too_large');
        if (error.status === 400) throw sceneError('unsupported_media'); // an empty body
        throw error;
      }
      const { size } = await fsp.stat(sourcePath);
      const result = await processUpload({ ffmpegPath, ffprobePath, sourcePath, workDir, size });
      const filename = path.basename(String(url.searchParams.get('name') || '').replace(/\\/g, '/'));
      layer = mediaLayer({
        id: crypto.randomUUID(),
        kind: result.kind,
        name: cleanName(path.basename(filename, path.extname(filename))),
        mime: result.mime,
        createdAt: new Date().toISOString(),
        width: result.width,
        height: result.height,
        duration: result.duration,
        alpha: result.alpha,
        audio: result.audio,
      });
      const target = filePath(layer);
      let committed = false;
      try {
        await enqueue(async () => {
          if (mediaCount() >= MAX_LAYERS) throw sceneError('too_many_layers');
          await fsp.rename(result.path, target);
          const at = scene.layers.findIndex(item => item.id === CHARACTER_ID);
          const layers = [...scene.layers];
          layers.splice(at, 0, layer);
          await save(layers);
          committed = true;
        });
      } catch (error) {
        if (!committed) await fsp.rm(target, { force: true }).catch(() => {});
        throw error;
      }
    } finally {
      // Before the answer, so a client never sees the work directory.
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    sendJson(res, 201, { layer: sceneView({ layers: [layer] }).layers[0], scene: view() });
  }

  // Returns true when the request was handled.
  async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (pathname === '/api/scene' && method === 'GET') {
      sendJson(res, 200, view());
      return true;
    }
    if (pathname === '/api/scene/layers' && method === 'POST') {
      await upload(req, res, url);
      return true;
    }
    const match = /^\/api\/scene\/layers\/([^/]+)(\/move)?$/.exec(pathname);
    if (!match) return false;
    const id = match[1];
    if (id !== CHARACTER_ID && !MEDIA_ID_RE.test(id)) throw sceneError('layer_missing');
    if (match[2] && method === 'POST') {
      requireJson(req);
      const body = await readBody(req);
      await enqueue(async () => {
        const layers = moveLayer(scene.layers, id, body && body.to);
        if (layers !== scene.layers) await save(layers);
      });
      sendJson(res, 200, { scene: view() });
      return true;
    }
    if (!match[2] && method === 'PATCH') {
      requireJson(req);
      const body = await readBody(req);
      await enqueue(async () => {
        const layer = find(id);
        if (!layer) throw sceneError('layer_missing');
        const next = patchLayer(layer, body);
        if (JSON.stringify(next) !== JSON.stringify(layer)) await save(scene.layers.map(item => (item.id === id ? next : item)));
      });
      sendJson(res, 200, { scene: view() });
      return true;
    }
    if (!match[2] && method === 'DELETE') {
      if (id === CHARACTER_ID) throw sceneError('character_fixed');
      let removed = null;
      await enqueue(async () => {
        removed = find(id);
        if (!removed) throw sceneError('layer_missing');
        await save(scene.layers.filter(layer => layer.id !== id));
      });
      await fsp.rm(filePath(removed), { force: true }).catch(() => {});
      sendJson(res, 200, { scene: view() });
      return true;
    }
    return false;
  }

  // GET /api/media/<id> of a video or image layer: true when `id` is one.
  async function serve(req, res, id) {
    const layer = MEDIA_ID_RE.test(id) ? find(id) : null;
    if (!layer || layer.kind === 'character') return false;
    try {
      await serveMedia(req, res, filePath(layer), layer.mime, { 'Cache-Control': MEDIA_CACHE });
    } catch (error) {
      if (error.code !== 'ENOENT' || res.headersSent) throw error;
      sendJson(res, 404, { error: 'Media not found.' });
    }
    return true;
  }

  return { view, message, find, filePath, handle, serve };
}

module.exports = {
  createScene, parseScene, patchLayer, moveLayer, sceneView, processUpload, imageMime, sceneError,
  CHARACTER_ID, MAX_LAYERS, SCALE_MIN, SCALE_MAX, OFFSET_MAX, MAX_CONVERT_SECONDS, MAX_IMAGE_BYTES,
};
