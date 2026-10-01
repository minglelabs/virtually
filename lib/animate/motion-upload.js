'use strict';

// A finished motion video uploaded for one character photo
// (POST /api/characters/<id>/photos/<photoId>/motions). Whatever comes in,
// a browser-playable file comes out:
//   1. ffprobe must find a video stream in WebM/Matroska or MP4/MOV, else
//      415 unsupported_video; longer than 60 s is 400 too_long.
//   2. Own alpha (VP8/VP9 flagged alpha_mode=1, or a yuva/rgba/argb/... pix_fmt
//      such as ProRes 4444, qtrle or PNG in MOV): a WebM is kept as is,
//      anything else becomes a VP9 yuva420p WebM (key.js encodeAlphaWebm, the
//      keyed job result's encoder settings). alpha: true, keyed: false.
//   3. No alpha: key.js's border detection, trying green, then blue, then
//      magenta; the first uniform key colour is keyed out exactly like a job
//      result. keyed: true, keyColor = the detected '#RRGGBB'.
//   4. Otherwise opaque: MP4 H.264 (yuv420p) or WebM VP8/VP9 kept as is,
//      anything else re-encoded to H.264 yuv420p MP4 (+faststart).
//      keyed: false, keyReason = the detector's reason.
// Then fit = measureFit(the result). Every file it writes lives in the
// caller's work directory, which the caller removes.

const fsp = require('node:fs/promises');
const path = require('node:path');

const media = require('./media');
const key = require('./key');
const keyColors = require('./key-color');
const { measureFit } = require('./fit');
const { characterError } = require('../characters');

const MAX_SECONDS = 60;
const DURATION_TOLERANCE_SEC = 0.05;
const PROBE_TIMEOUT_MS = 60 * 1000;
const MIN_ENCODE_TIMEOUT_MS = 120 * 1000;
const PLAYABLE_H264_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const EBML_DOCTYPE = Buffer.from([0x42, 0x82]);

// A pixel format with its own alpha channel. pal8 does not count here: an
// 8-bit palette clip is far more often opaque than transparent, and keying
// it (step 3) is the better guess.
function ownAlphaPixFmt(pixFmt) {
  return media.pixFmtHasAlpha(pixFmt) && pixFmt !== 'pal8';
}

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

// The EBML DocType ('webm', 'matroska', ...) from a file's first bytes, or null.
function ebmlDocType(head) {
  if (head.length < 4 || !head.subarray(0, 4).equals(EBML_MAGIC)) return null;
  const at = head.indexOf(EBML_DOCTYPE, 4);
  if (at < 0 || at + 3 > head.length) return null;
  const size = head[at + 2];
  if (!(size & 0x80)) return null; // a one-byte size is all a DocType needs
  const end = at + 3 + (size & 0x7f);
  return end <= head.length ? head.toString('ascii', at + 3, end) : null;
}

// 'webm' | 'matroska' | 'mp4' | 'mov' | null from ffprobe's format name and
// the file head (WebM and Matroska share a demuxer, as do MP4 and MOV).
function containerOf(formatName, head) {
  const names = String(formatName || '').split(',');
  if (names.includes('matroska') || names.includes('webm')) return ebmlDocType(head) === 'webm' ? 'webm' : 'matroska';
  if (names.includes('mov') || names.includes('mp4')) {
    const branded = head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp';
    return branded && head.toString('ascii', 8, 12) !== 'qt  ' ? 'mp4' : 'mov';
  }
  return null;
}

// A stream tag, whatever its case (muxers write alpha_mode or ALPHA_MODE).
function tagValue(tags, name) {
  if (!tags || typeof tags !== 'object') return null;
  const entry = Object.entries(tags).find(([tag]) => tag.toLowerCase() === name);
  return entry ? String(entry[1]) : null;
}

// Matroska keeps a stream's length in a DURATION tag ('00:00:01.000000000').
function tagSeconds(value) {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(value || '').trim());
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

// The end of the last video packet, for files whose header has no duration
// (a browser-recorded WebM). Demuxes only, nothing is decoded.
async function packetSeconds(ffprobePath, filePath) {
  const result = await media.run(ffprobePath, ['-v', 'error', '-select_streams', 'V:0',
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', filePath], { timeoutMs: PROBE_TIMEOUT_MS });
  let end = 0;
  for (const line of result.stdout.toString().split('\n')) {
    const [pts, duration] = line.split(',').map(Number);
    if (Number.isFinite(pts)) end = Math.max(end, pts + (Number.isFinite(duration) ? duration : 0));
  }
  return end > 0 ? end : null;
}

// { container, codec, pixFmt, vpxAlpha, duration } for a WebM/Matroska or
// MP4/MOV with a video stream (cover art does not count), else null.
async function probeUpload(ffprobePath, filePath) {
  const probed = await media.run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { timeoutMs: PROBE_TIMEOUT_MS });
  let json;
  try { json = JSON.parse(probed.stdout.toString() || '{}'); } catch { return null; }
  const format = json.format || {};
  const container = containerOf(format.format_name, await readHead(filePath));
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic));
  if (!container || !video) return null;
  const codec = video.codec_name || null;
  let duration = Number(video.duration) || tagSeconds(tagValue(video.tags, 'duration')) || Number(format.duration) || null;
  if (!duration) duration = await packetSeconds(ffprobePath, filePath).catch(() => null);
  return {
    container,
    codec,
    pixFmt: video.pix_fmt || null,
    // VP8/VP9 carry alpha in a side channel that ffmpeg's native decoders
    // drop (pix_fmt says yuv420p); the muxer flags it with alpha_mode=1.
    vpxAlpha: (codec === 'vp8' || codec === 'vp9') && tagValue(video.tags, 'alpha_mode') === '1',
    duration,
  };
}

// Key the clip on the first of green, blue, magenta its border is a uniform
// match for (one border sampling for all three). -> { keyed: true, color } or
// { keyed: false, reason }.
async function keyAnyColor(ffmpegPath, ffprobePath, sourcePath, destPath) {
  const probe = await media.probeVideo(ffprobePath, sourcePath).catch(() => null);
  const samples = await key.sampleBorder(ffmpegPath, ffprobePath, sourcePath, { probe });
  if (!samples.length) return { keyed: false, reason: 'unreadable' };
  let reason = 'not_key_color';
  for (const name of keyColors.CANDIDATES) {
    const keyColor = keyColors.KEY_COLORS[name];
    const decided = key.decideKeyColor(samples, keyColor);
    if (!decided.color) {
      reason = decided.reason;
      continue;
    }
    try {
      await key.keyVideo(ffmpegPath, sourcePath, destPath, { color: decided.color, despill: keyColor.despill, duration: probe && probe.duration });
    } catch (error) {
      console.warn(`[motion-upload] keying failed: ${error.message}`);
      return { keyed: false, reason: 'key_failed' };
    }
    return { keyed: true, color: decided.color };
  }
  return { keyed: false, reason };
}

// H.264 yuv420p MP4 (+faststart), even dimensions, no audio.
async function transcodeH264(ffmpegPath, sourcePath, destPath, duration) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', sourcePath,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'veryfast',
    '-an', '-movflags', '+faststart', destPath];
  const result = await media.run(ffmpegPath, args, { timeoutMs: Math.max(MIN_ENCODE_TIMEOUT_MS, 10 * 1000 * (Number(duration) || 0)) });
  if (result.timedOut) throw new Error('Video conversion timed out.');
  if (result.code !== 0) throw new Error(media.tidy(result.stderr) || 'Video conversion failed.');
}

async function convert(ffmpegPath, ffprobePath, sourcePath, workDir, probe) {
  const outcome = (file, mime, fields = {}) => ({ path: file, mime, alpha: false, keyed: false, keyColor: null, keyReason: null, ...fields });
  const keep = async ext => {
    const target = path.join(workDir, `motion${ext}`);
    await fsp.rename(sourcePath, target);
    return target;
  };
  const webm = probe.container === 'webm' && (probe.codec === 'vp8' || probe.codec === 'vp9');

  if (probe.vpxAlpha || ownAlphaPixFmt(probe.pixFmt)) {
    if (webm) return outcome(await keep('.webm'), 'video/webm', { alpha: true });
    const target = path.join(workDir, 'alpha.webm');
    // libvpx keeps a Matroska VP8/VP9 alpha channel; other codecs decode natively.
    const inputArgs = probe.vpxAlpha ? ['-c:v', probe.codec === 'vp8' ? 'libvpx' : 'libvpx-vp9'] : [];
    await key.encodeAlphaWebm(ffmpegPath, sourcePath, target, { inputArgs, duration: probe.duration, what: 'Alpha conversion' });
    return outcome(target, 'video/webm', { alpha: true });
  }

  const keyedPath = path.join(workDir, 'keyed.webm');
  const keying = await keyAnyColor(ffmpegPath, ffprobePath, sourcePath, keyedPath);
  if (keying.keyed) return outcome(keyedPath, 'video/webm', { keyed: true, keyColor: keying.color });

  const keyReason = keying.reason;
  if (webm) return outcome(await keep('.webm'), 'video/webm', { keyReason });
  if (probe.container === 'mp4' && probe.codec === 'h264' && PLAYABLE_H264_PIX_FMTS.has(probe.pixFmt)) {
    return outcome(await keep('.mp4'), 'video/mp4', { keyReason });
  }
  const target = path.join(workDir, 'opaque.mp4');
  await transcodeH264(ffmpegPath, sourcePath, target, probe.duration);
  return outcome(target, 'video/mp4', { keyReason });
}

// Process the raw upload at `sourcePath` (inside `workDir`). Resolves
// { path, mime, alpha, keyed, keyColor, keyReason, fit }: `path` (inside
// `workDir`) is the file to store. Rejects with a characterError.
async function processMotionUpload({ ffmpegPath, ffprobePath, sourcePath, workDir }) {
  const probe = await probeUpload(ffprobePath, sourcePath).catch(() => null);
  if (!probe || !probe.duration) throw characterError('unsupported_video');
  if (probe.duration > MAX_SECONDS + DURATION_TOLERANCE_SEC) throw characterError('too_long');
  let result;
  try {
    result = await convert(ffmpegPath, ffprobePath, sourcePath, workDir, probe);
  } catch (error) {
    // ffmpeg could not read or convert it.
    console.warn(`[motion-upload] ${error.message || error}`);
    throw characterError('unsupported_video');
  }
  return { ...result, fit: await measureFit(ffmpegPath, ffprobePath, result.path) };
}

module.exports = { processMotionUpload, probeUpload, containerOf, ebmlDocType, MAX_SECONDS };
