'use strict';

// 다운로드: the clip a person sees on the page, as a file they can use elsewhere.
//   - a transparent WebM (what the overlay plays) -> a QuickTime MOV, Apple ProRes 4444
//     with its alpha, which editing tools open (an MP4 cannot hold transparency);
//   - an MP4 (a clip with its background) -> as it is.
// MOVs are made on demand and kept in the system temp directory (not the data directory:
// the bucket mirror would upload them), keyed by the source file's path, size and time.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const media = require('./animate/media');
const { serveMedia } = require('./server-util');

const CACHE_DIR = path.join(os.tmpdir(), 'virtually-downloads');
const making = new Map(); // cache file -> in-flight conversion

// ffmpeg arguments: WebM (VP9, its alpha read by libvpx) -> ProRes 4444 with alpha.
function movArgs(srcPath, destPath) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-c:v', 'libvpx-vp9', '-i', srcPath,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '8', '-vendor', 'apl0', '-qscale:v', '9',
    '-c:a', 'aac', '-f', 'mov', destPath];
}

async function movFor(ffmpegPath, srcPath) {
  const stat = await fsp.stat(srcPath);
  const id = crypto.createHash('sha1').update(`${path.resolve(srcPath)}\n${stat.size}\n${stat.mtimeMs}`).digest('hex');
  const file = path.join(CACHE_DIR, `${id}.mov`);
  if (fs.existsSync(file)) return file;
  if (!making.has(file)) {
    const run = (async () => {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        const result = await media.run(ffmpegPath, movArgs(srcPath, tmp), { timeoutMs: 5 * 60 * 1000 });
        if (result.code !== 0) throw new Error(`Could not make the MOV: ${String(result.stderr).trim().slice(-200)}`);
        await fsp.rename(tmp, file);
        return file;
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    })().finally(() => making.delete(file));
    making.set(file, run);
  }
  return making.get(file);
}

// A file name for Content-Disposition: the ASCII fallback and the UTF-8 one.
function disposition(name, ext) {
  const base = String(name || 'motion').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'motion';
  const ascii = base.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, '') || 'motion';
  return `attachment; filename="${ascii}${ext}"; filename*=UTF-8''${encodeURIComponent(base + ext)}`;
}

// Serve srcPath (mime: the stored clip's) as a download named `name`.
async function serveDownload(req, res, { ffmpegPath, srcPath, mime, name }) {
  if (mime === 'video/webm') {
    const mov = await movFor(ffmpegPath, srcPath);
    return serveMedia(req, res, mov, 'video/quicktime', { 'Content-Disposition': disposition(name, '.mov') });
  }
  const ext = mime === 'video/mp4' ? '.mp4' : path.extname(srcPath) || '';
  return serveMedia(req, res, srcPath, mime, { 'Content-Disposition': disposition(name, ext) });
}

module.exports = { serveDownload, movArgs, disposition, CACHE_DIR };
