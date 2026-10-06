'use strict';

// Two tools for the videos an account keeps (a photo's motions, the scene's video layers):
//
//   repeatClip  the clip N times in a row, as a new file. Nothing is re-encoded (the same
//               packets are written again), so it is quick, loses no quality, and a
//               transparent WebM keeps its alpha.
//   joinClips   two (or more) clips one after the other, as ONE new file. They are
//               re-encoded onto one frame at the first clip's frame rate:
//                 all transparent  -> VP9 WebM with alpha. Clips that carry a character
//                                     box (a motion's `fit`) are scaled and placed so the
//                                     character keeps its size and its feet stay where
//                                     they are, exactly as the overlay shows them one by
//                                     one; clips without a box are fitted into the first
//                                     clip's frame, standing on its bottom edge.
//                 all opaque       -> H.264 MP4 (+ AAC when a clip has sound; a silent
//                                     clip gets silence). Later clips are fitted into the
//                                     first clip's frame, centred, on black.
//               A transparent and an opaque clip are not joined (remove the background first).
//               A part may be a piece of its clip ({ start, end } in seconds): the video
//               editor (lib/videos.js) renders its timeline with this.
//
// Both write the result next to nothing else: the caller moves it into place.

const fsp = require('node:fs/promises');
const path = require('node:path');

const media = require('./animate/media');
const { containerOf } = require('./animate/motion-upload');

const MAX_TIMES = 20;
// What a repeated clip may last, and what joined clips may last together.
const MAX_REPEAT_SECONDS = 600;
const MAX_JOIN_SECONDS = 300;
const MAX_EDGE = 1920;
const PROBE_TIMEOUT_MS = 60 * 1000;
const COPY_TIMEOUT_MS = 5 * 60 * 1000;
const DURATION_TOLERANCE_SEC = 0.5;
// The one alpha encoder setting (animate/key.js encodeAlphaWebm).
const ALPHA_CRF = 30;
// How far a later clip may be scaled to match the first clip's character.
const MIN_SCALE = 0.2;
// The shortest piece of a clip that can be cut out.
const MIN_PIECE_SECONDS = 0.05;
const MAX_SCALE = 5;

const ERRORS = {
  bad_times: [400, `반복 횟수는 2부터 ${MAX_TIMES}까지 정할 수 있습니다.`],
  unsupported_clip: [422, '영상을 읽을 수 없습니다.'],
  mixed_alpha: [422, '배경이 투명한 영상과 배경이 있는 영상은 이어붙일 수 없습니다. 먼저 배경을 지워 주세요.'],
  too_long: [422, '만들어질 영상이 너무 깁니다.'],
  bad_piece: [400, '영상에서 잘라 쓸 구간이 올바르지 않습니다.'],
  clip_failed: [422, '영상을 만들지 못했습니다.'],
};

function clipError(code, message) {
  const [status, text] = ERRORS[code];
  return Object.assign(new Error(message || text), { status, code });
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => (finite(value) && value > 0 ? value : null);
const even = value => Math.max(2, Math.round(value / 2) * 2);

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

// What a video file is: { container, codec, pixFmt, vpxAlpha, alpha, width, height (as
// shown: a rotated clip has its sides swapped), fps, duration, audioCodec }, or null when
// it has no picture (cover art does not count) or is in no known wrapper.
async function probeClip(ffprobePath, filePath, head = null) {
  const probed = await media.run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { timeoutMs: PROBE_TIMEOUT_MS });
  let json;
  try { json = JSON.parse(probed.stdout.toString() || '{}'); } catch { return null; }
  const format = json.format || {};
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic));
  const container = containerOf(format.format_name, head || await readHead(filePath));
  if (!video || !container) return null;
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const codec = video.codec_name || null;
  const pixFmt = video.pix_fmt || null;
  const alphaTag = Object.entries(video.tags || {}).find(([tag]) => tag.toLowerCase() === 'alpha_mode');
  // VP8/VP9 keep their alpha in a side channel the pixel format does not show.
  const vpxAlpha = (codec === 'vp8' || codec === 'vp9') && Boolean(alphaTag) && String(alphaTag[1]) === '1';
  let width = positive(Number(video.width));
  let height = positive(Number(video.height));
  const turned = (Array.isArray(video.side_data_list) ? video.side_data_list : []).find(entry => entry.rotation != null);
  if (turned && Math.abs(Number(turned.rotation)) % 180 === 90) [width, height] = [height, width];
  let fps = null;
  const rate = video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate;
  if (rate && rate.includes('/')) {
    const [num, den] = rate.split('/').map(Number);
    if (num && den) fps = num / den;
  }
  return {
    container,
    codec,
    pixFmt,
    vpxAlpha,
    alpha: vpxAlpha || (media.pixFmtHasAlpha(pixFmt) && pixFmt !== 'pal8'),
    width,
    height,
    fps: positive(fps),
    duration: positive(Number(video.duration)) || positive(Number(format.duration)),
    audioCodec: audio ? audio.codec_name || 'unknown' : null,
  };
}

async function ffmpeg(ffmpegPath, args, timeoutMs, what) {
  const result = await media.run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeoutMs });
  if (result.timedOut) throw new Error(`${what} timed out.`);
  if (result.code !== 0) throw new Error(media.tidy(result.stderr) || `${what} failed.`);
}

// 2..MAX_TIMES as an integer, else a bad_times error.
function checkTimes(value) {
  if (!Number.isInteger(value) || value < 2 || value > MAX_TIMES) throw clipError('bad_times');
  return value;
}

// A line of an ffmpeg concat list for `filePath`.
function listLine(filePath) {
  return `file '${String(filePath).replace(/'/g, "'\\''")}'`;
}

// `sourcePath` played `times` times -> `destPath` (the same wrapper: .webm or .mp4), written
// by copying its packets. `workDir` takes the list file. -> { duration } (null when unknown).
async function repeatClip({ ffmpegPath, ffprobePath, sourcePath, destPath, workDir, times }) {
  checkTimes(times);
  const info = await probeClip(ffprobePath, sourcePath).catch(() => null);
  if (!info || (info.container !== 'webm' && info.container !== 'mp4')) throw clipError('unsupported_clip');
  if (info.duration && info.duration * times > MAX_REPEAT_SECONDS + DURATION_TOLERANCE_SEC) {
    throw clipError('too_long', `${times}번 반복하면 ${Math.round(info.duration * times)}초가 됩니다. ${MAX_REPEAT_SECONDS / 60}분까지 만들 수 있습니다.`);
  }
  const listPath = path.join(workDir, 'repeat.txt');
  await fsp.writeFile(listPath, `${Array.from({ length: times }, () => listLine(sourcePath)).join('\n')}\n`);
  const webm = info.container === 'webm';
  try {
    await ffmpeg(ffmpegPath, ['-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0', '-c', 'copy',
      ...(webm ? ['-f', 'webm'] : ['-movflags', '+faststart', '-f', 'mp4']), destPath], COPY_TIMEOUT_MS, 'Repeating');
  } catch (error) {
    console.warn(`[clips] ${error.message}`);
    throw clipError('clip_failed');
  }
  // The copy is only kept when it is what was asked for: the picture's alpha and N times the length.
  const made = await probeClip(ffprobePath, destPath).catch(() => null);
  const length = made && made.duration;
  if (!made || made.alpha !== info.alpha || (info.duration && (!length || Math.abs(length - info.duration * times) > Math.max(DURATION_TOLERANCE_SEC, 0.02 * info.duration * times)))) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw clipError('clip_failed');
  }
  return { duration: length || null };
}

// The character box of a clip in its own pixels, from its fit (animate/fit.js), or null:
// { height, centre (x), bottom (y) } of the first frame's box.
function characterBox(clip) {
  const first = clip.fit && Array.isArray(clip.fit.first) ? clip.fit.first : null;
  if (!first || first.length !== 4 || !first.every(finite) || !(first[2] > first[0]) || !(first[3] > first[1])) return null;
  return { height: (first[3] - first[1]) * clip.height, centre: ((first[0] + first[2]) / 2) * clip.width, bottom: first[3] * clip.height };
}

// Where each clip goes on the one frame they share:
// { width, height, aligned, places: [{ width, height, x, y }] } in whole (even) pixels.
//   aligned    every clip has a character box: each is scaled so its box is as tall as the
//              first clip's, and placed so the boxes share their bottom edge and their
//              middle. The frame grows to hold every clip whole.
//   otherwise  the frame is the first clip's; the others are fitted inside it, centred
//              (anchor 'bottom': standing on its bottom edge).
// A frame longer than maxEdge is scaled down with everything on it.
function joinLayout(clips, { anchor = 'center', maxEdge = MAX_EDGE } = {}) {
  const boxes = clips.map(characterBox);
  const aligned = clips.length > 0 && boxes.every(Boolean);
  let width;
  let height;
  let places;
  if (aligned) {
    const scaled = clips.map((clip, index) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, boxes[0].height / boxes[index].height));
      return { width: clip.width * scale, height: clip.height * scale, centre: boxes[index].centre * scale, bottom: boxes[index].bottom * scale };
    });
    const left = Math.max(...scaled.map(item => item.centre));
    const right = Math.max(...scaled.map(item => item.width - item.centre));
    const above = Math.max(...scaled.map(item => item.bottom));
    const below = Math.max(...scaled.map(item => item.height - item.bottom));
    width = left + right;
    height = above + below;
    places = scaled.map(item => ({ width: item.width, height: item.height, x: left - item.centre, y: above - item.bottom }));
  } else {
    width = clips[0].width;
    height = clips[0].height;
    places = clips.map((clip, index) => {
      const scale = index === 0 ? 1 : Math.min(width / clip.width, height / clip.height);
      const w = clip.width * scale;
      const h = clip.height * scale;
      return { width: w, height: h, x: (width - w) / 2, y: anchor === 'bottom' ? height - h : (height - h) / 2 };
    });
  }
  const shrink = Math.min(1, maxEdge / Math.max(width, height));
  const frame = { width: even(width * shrink), height: even(height * shrink) };
  return {
    ...frame,
    aligned,
    places: places.map((place) => {
      const w = Math.min(frame.width, even(place.width * shrink));
      const h = Math.min(frame.height, even(place.height * shrink));
      return {
        width: w,
        height: h,
        x: Math.min(frame.width - w, Math.max(0, Math.round(place.x * shrink))),
        y: Math.min(frame.height - h, Math.max(0, Math.round(place.y * shrink))),
      };
    }),
  };
}

// The ffmpeg arguments that join `clips` (probeClip results with `path`) as laid out:
// -> [...inputs, '-filter_complex', graph, ...maps, ...encoder] (without the output file).
function joinArgs(clips, layout, { alpha, fps, audio }) {
  const args = [];
  for (const clip of clips) {
    // A piece of the clip: read from `start` for `length` seconds.
    if (clip.trimmed) args.push('-ss', clip.start.toFixed(3), '-t', clip.length.toFixed(3));
    // ffmpeg's own VP8/VP9 decoders drop the alpha; libvpx keeps it.
    if (clip.vpxAlpha) args.push('-c:v', clip.codec === 'vp8' ? 'libvpx' : 'libvpx-vp9');
    args.push('-i', clip.path);
  }
  const pixFmt = alpha ? 'yuva420p' : 'yuv420p';
  const chains = [];
  const pads = [];
  clips.forEach((clip, index) => {
    const place = layout.places[index];
    chains.push(`[${index}:v:0]${clip.trimmed ? 'setpts=PTS-STARTPTS,' : ''}fps=${fps},scale=${place.width}:${place.height}:flags=lanczos,setsar=1,format=${pixFmt},`
      + `pad=${layout.width}:${layout.height}:${place.x}:${place.y}:color=${alpha ? 'black@0.0' : 'black'}[v${index}]`);
    pads.push(`[v${index}]`);
    if (!audio) return;
    chains.push(clip.audioCodec
      ? `[${index}:a:0]${clip.trimmed ? 'asetpts=PTS-STARTPTS,' : ''}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${(clip.trimmed ? clip.length : clip.duration).toFixed(3)}[a${index}]`);
    pads.push(`[a${index}]`);
  });
  chains.push(`${pads.join('')}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}${audio ? '[v][a]' : '[v]'}`);
  args.push('-filter_complex', chains.join(';'), '-map', '[v]');
  if (audio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  else args.push('-an');
  if (alpha) args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', String(ALPHA_CRF), '-row-mt', '1', '-f', 'webm');
  else args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'veryfast', '-movflags', '+faststart', '-f', 'mp4');
  return args;
}

// The piece of a clip a part asks for: { start, length } in seconds, or null when the part
// is the whole clip. A piece outside the clip, or shorter than MIN_PIECE_SECONDS, is refused.
function pieceOf(part, duration) {
  if (part.start == null && part.end == null) return null;
  const start = part.start == null ? 0 : part.start;
  const end = part.end == null ? duration : duration ? Math.min(part.end, duration) : part.end;
  if (!finite(start) || !finite(end) || start < 0 || !(end - start >= MIN_PIECE_SECONDS)) throw clipError('bad_piece');
  return { start, length: end - start };
}

// `parts` ([{ path, fit, start, end }], in order; fit: the clip's character box or null;
// start, end: the piece of the clip to take, in seconds, both optional) -> one file in
// `workDir`: { path, mime, alpha, audio, width, height, duration, aligned }. Two parts or
// more, or one part that is a piece of its clip.
async function joinClips({ ffmpegPath, ffprobePath, parts, workDir, maxSeconds = MAX_JOIN_SECONDS }) {
  if (!Array.isArray(parts) || !parts.length) throw clipError('unsupported_clip');
  const clips = [];
  const probed = new Map();
  for (const part of parts) {
    if (!probed.has(part.path)) probed.set(part.path, await probeClip(ffprobePath, part.path).catch(() => null));
    const info = probed.get(part.path);
    if (!info || !info.width || !info.height) throw clipError('unsupported_clip');
    const piece = pieceOf(part, info.duration);
    clips.push({ ...info, path: part.path, fit: part.fit || null, ...(piece ? { trimmed: true, ...piece, duration: piece.length } : {}) });
  }
  if (clips.length < 2 && !clips[0].trimmed) throw clipError('unsupported_clip');
  const alpha = clips.every(clip => clip.alpha);
  if (!alpha && clips.some(clip => clip.alpha)) throw clipError('mixed_alpha');
  const known = clips.every(clip => clip.duration);
  const total = clips.reduce((sum, clip) => sum + (clip.duration || 0), 0);
  if (total > maxSeconds + DURATION_TOLERANCE_SEC) {
    throw clipError('too_long', `이어붙이면 ${Math.round(total)}초가 됩니다. ${Math.round(maxSeconds / 60)}분까지 만들 수 있습니다.`);
  }
  // A character box only means something on a transparent clip.
  const layout = joinLayout(clips.map(clip => ({ width: clip.width, height: clip.height, fit: alpha ? clip.fit : null })), { anchor: alpha ? 'bottom' : 'center' });
  const fps = Math.min(60, Math.max(1, Math.round(clips[0].fps || 30)));
  // Sound only when every length is known (a silent clip needs silence of its own length).
  const audio = !alpha && known && clips.some(clip => clip.audioCodec);
  const destPath = path.join(workDir, alpha ? 'joined.webm' : 'joined.mp4');
  const timeoutMs = Math.max(120 * 1000, 10 * 1000 * (total || MAX_JOIN_SECONDS));
  try {
    await ffmpeg(ffmpegPath, [...joinArgs(clips, layout, { alpha, fps, audio }), destPath], timeoutMs, 'Joining');
  } catch (error) {
    console.warn(`[clips] ${error.message}`);
    throw clipError('clip_failed');
  }
  const made = await probeClip(ffprobePath, destPath).catch(() => null);
  if (!made || made.alpha !== alpha || (known && (!made.duration || Math.abs(made.duration - total) > Math.max(DURATION_TOLERANCE_SEC, 0.05 * total)))) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw clipError('clip_failed');
  }
  return {
    path: destPath, mime: alpha ? 'video/webm' : 'video/mp4', alpha, audio: Boolean(made.audioCodec),
    width: made.width, height: made.height, duration: made.duration || (known ? total : null), aligned: layout.aligned,
  };
}

module.exports = {
  repeatClip, joinClips, joinLayout, joinArgs, probeClip, checkTimes, listLine, clipError,
  MAX_TIMES, MAX_REPEAT_SECONDS, MAX_JOIN_SECONDS, MAX_EDGE, MIN_PIECE_SECONDS,
};
