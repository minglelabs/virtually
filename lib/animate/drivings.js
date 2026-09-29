'use strict';

// Driving videos for the "동작 만들기" page: the committed example manifest
// (examples/driving.json, metadata only) plus the user's own uploads.
//
// Layout under <dataDir>/animate/drivings/:
//   examples/<id>.mp4, <id>.jpg, <id>.json   downloaded + normalized examples
//   uploads/<up-uuid>/video.<ext>, poster.jpg, meta.json
//   hidden-examples.json                     { "hidden": [ids] } examples the user deleted
//
// Example videos are downloaded at runtime (fetchExamples) from the manifest's
// own URLs only; nothing third-party is stored in the repository. Deleting an
// example hides it for this install (its files are removed and fetchExamples
// skips it) until restoreExamples() clears the hidden list.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const media = require('./media');
const { isPreset } = require('./presets');

const EXAMPLE_ID_RE = /^[a-z0-9-]{1,40}$/;
const UPLOAD_ID_RE = /^up-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXAMPLE_MAX_BYTES = 100 * 1024 * 1024;
const EXAMPLE_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'virtually/0.1';

const UPLOAD_TYPES = {
  mp4: { ext: '.mp4', mime: 'video/mp4' },
  mov: { ext: '.mov', mime: 'video/quicktime' },
  webm: { ext: '.webm', mime: 'video/webm' },
};

function apiError(status, code, message, detail) {
  return Object.assign(new Error(message), { status, code, detail });
}

// Read and validate the manifest. Invalid entries are skipped (with a warning)
// so one bad row cannot hide the others. `allowHttp` exists only for tests,
// whose fixture servers are plain http on 127.0.0.1.
async function loadManifest(manifestPath, { allowHttp = false } = {}) {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.warn(`examples manifest unreadable: ${error.message}`);
    return [];
  }
  const list = raw && Array.isArray(raw.examples) ? raw.examples : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const problem = validateExample(entry, { allowHttp });
    if (problem || seen.has(entry.id)) {
      console.warn(`examples manifest: skipping ${entry && entry.id ? entry.id : 'an entry'} (${problem || 'duplicate id'})`);
      continue;
    }
    seen.add(entry.id);
    out.push({
      id: entry.id,
      label: String(entry.label).slice(0, 100),
      presetKey: entry.presetKey || null,
      downloadUrl: entry.downloadUrl,
      credit: {
        author: stringOrNull(entry.author),
        license: stringOrNull(entry.license),
        licenseUrl: stringOrNull(entry.licenseUrl),
        sourcePage: stringOrNull(entry.sourcePage),
      },
      trim: { start: Number(entry.trim.start) || 0, duration: Number(entry.trim.duration) },
    });
  }
  return out;
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function validateExample(entry, { allowHttp }) {
  if (!entry || typeof entry !== 'object') return 'not an object';
  if (typeof entry.id !== 'string' || !EXAMPLE_ID_RE.test(entry.id)) return 'bad id';
  if (typeof entry.label !== 'string' || !entry.label.trim()) return 'missing label';
  if (entry.presetKey != null && !isPreset(entry.presetKey)) return 'unknown presetKey';
  let url;
  try { url = new URL(entry.downloadUrl); } catch { return 'bad downloadUrl'; }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return 'downloadUrl must be https';
  const trim = entry.trim;
  if (!trim || typeof trim !== 'object') return 'missing trim';
  const start = Number(trim.start || 0);
  const duration = Number(trim.duration);
  if (!Number.isFinite(start) || start < 0) return 'bad trim.start';
  if (!Number.isFinite(duration) || duration < 3 || duration > 10) return 'trim.duration must be 3..10';
  return null;
}

class DrivingStore {
  constructor({ dataDir, manifestPath, ffmpegPath, ffprobePath, allowHttpExamples = false, fetchImpl = null }) {
    this.dir = path.join(dataDir, 'animate', 'drivings');
    this.examplesDir = path.join(this.dir, 'examples');
    this.uploadsDir = path.join(this.dir, 'uploads');
    this.hiddenPath = path.join(this.dir, 'hidden-examples.json');
    this.manifestPath = manifestPath;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.allowHttp = allowHttpExamples;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.examples = [];
    this.uploads = new Map(); // id -> meta
    this.hidden = new Set(); // hidden example ids
    this._hiddenWrite = Promise.resolve(); // serializes hidden-examples.json writes
    this.fetching = null; // AbortController while fetchExamples runs
  }

  async init() {
    await fsp.mkdir(this.examplesDir, { recursive: true });
    await fsp.mkdir(this.uploadsDir, { recursive: true });
    this.examples = await loadManifest(this.manifestPath, { allowHttp: this.allowHttp });
    this.hidden = await readHidden(this.hiddenPath);
    // Finish a hide that was interrupted between saving the list and removing files.
    for (const id of this.hidden) await this._removeExampleFiles(id);
    let entries = [];
    try { entries = await fsp.readdir(this.uploadsDir); } catch { entries = []; }
    for (const id of entries) {
      if (!UPLOAD_ID_RE.test(id)) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.uploadsDir, id, 'meta.json'), 'utf8'));
        if (meta && meta.id === id && fs.existsSync(path.join(this.uploadsDir, id, `video${meta.ext}`))) this.uploads.set(id, meta);
      } catch { /* incomplete upload; ignore */ }
    }
    return this;
  }

  examplePaths(id) {
    return {
      video: path.join(this.examplesDir, `${id}.mp4`),
      poster: path.join(this.examplesDir, `${id}.jpg`),
      meta: path.join(this.examplesDir, `${id}.json`),
    };
  }

  async _removeExampleFiles(id) {
    if (!EXAMPLE_ID_RE.test(id)) return;
    const paths = this.examplePaths(id);
    for (const filePath of [paths.video, paths.poster, paths.meta]) await fsp.rm(filePath, { force: true }).catch(() => {});
  }

  // Manifest examples the user has not hidden, in manifest order.
  visibleExamples() {
    return this.examples.filter(item => !this.hidden.has(item.id));
  }

  // How many manifest examples are hidden (ids no longer in the manifest do not count).
  hiddenCount() {
    return this.examples.filter(item => this.hidden.has(item.id)).length;
  }

  _saveHidden() {
    const snapshot = { hidden: [...this.hidden].sort() };
    const write = this._hiddenWrite.then(() => writeJsonAtomic(this.hiddenPath, snapshot));
    this._hiddenWrite = write.catch(() => {});
    return write;
  }

  // The resolved driving record (internal): { id, kind, label, presetKey,
  // videoPath, posterPath, mime, available, duration, width, height, credit }.
  // Hidden examples resolve to null, like a deleted upload.
  async get(id) {
    const example = this.visibleExamples().find(item => item.id === id);
    if (example) {
      const paths = this.examplePaths(id);
      const available = fs.existsSync(paths.video) && fs.existsSync(paths.poster);
      let info = null;
      if (available) info = await this._exampleInfo(id);
      return {
        id, kind: 'example', label: example.label, presetKey: example.presetKey,
        videoPath: paths.video, posterPath: paths.poster, mime: 'video/mp4',
        available, duration: info ? info.duration : null, width: info ? info.width : null, height: info ? info.height : null,
        credit: example.credit,
      };
    }
    const meta = UPLOAD_ID_RE.test(id) ? this.uploads.get(id) : null;
    if (!meta) return null;
    const dir = path.join(this.uploadsDir, id);
    return {
      id, kind: 'upload', label: meta.label, presetKey: null,
      videoPath: path.join(dir, `video${meta.ext}`), posterPath: path.join(dir, 'poster.jpg'), mime: meta.mime,
      available: true, duration: meta.duration, width: meta.width, height: meta.height, credit: null,
      createdAt: meta.createdAt,
    };
  }

  async _exampleInfo(id) {
    const paths = this.examplePaths(id);
    try {
      const info = JSON.parse(await fsp.readFile(paths.meta, 'utf8'));
      if (info && Number.isFinite(info.duration)) return info;
    } catch { /* probe below */ }
    const probed = await media.probeVideo(this.ffprobePath, paths.video).catch(() => null);
    if (!probed) return null;
    const info = { duration: roundSec(probed.duration), width: probed.width, height: probed.height };
    await writeJsonAtomic(paths.meta, info).catch(() => {});
    return info;
  }

  view(record) {
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      presetKey: record.presetKey || null,
      available: record.available,
      duration: record.duration ?? null,
      width: record.width ?? null,
      height: record.height ?? null,
      url: record.available ? `/api/animate/drivings/${record.id}/video` : null,
      posterUrl: record.available ? `/api/animate/drivings/${record.id}/poster` : null,
      credit: record.credit || null,
    };
  }

  // Visible examples in manifest order, then uploads newest first.
  async list() {
    const out = [];
    for (const example of this.visibleExamples()) out.push(this.view(await this.get(example.id)));
    const uploads = [...this.uploads.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const meta of uploads) out.push(this.view(await this.get(meta.id)));
    return out;
  }

  isFetching() {
    return !!this.fetching;
  }

  // Download + normalize every visible example whose file is missing. One run
  // at a time (409 fetch_in_progress). Returns [{ id, ok, error? }].
  async fetchExamples() {
    if (this.fetching) throw apiError(409, 'fetch_in_progress', 'Example videos are already being downloaded.');
    const controller = new AbortController();
    this.fetching = controller;
    const results = [];
    try {
      for (const example of this.examples) {
        if (this.hidden.has(example.id)) continue;
        const paths = this.examplePaths(example.id);
        if (fs.existsSync(paths.video) && fs.existsSync(paths.poster)) continue;
        try {
          await this._fetchOne(example, controller.signal);
          // Hidden while it was downloading: drop what was just written.
          if (this.hidden.has(example.id)) {
            await this._removeExampleFiles(example.id);
            continue;
          }
          results.push({ id: example.id, ok: true });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (this.hidden.has(example.id)) continue;
          results.push({ id: example.id, ok: false, error: safeMessage(error.message) || 'Download failed.' });
        }
      }
      return results;
    } finally {
      this.fetching = null;
    }
  }

  async _fetchOne(example, outerSignal) {
    const paths = this.examplePaths(example.id);
    const rawPath = path.join(this.examplesDir, `${example.id}.${crypto.randomUUID()}.download`);
    try {
      await downloadExample(this.fetch, example.downloadUrl, rawPath, {
        signal: outerSignal, allowHttp: this.allowHttp, maxBytes: EXAMPLE_MAX_BYTES, timeoutMs: EXAMPLE_TIMEOUT_MS,
      });
      if (!(await hasVideoSignature(rawPath))) throw new Error('The downloaded file is not a video.');
      await media.normalizeDriving(this.ffmpegPath, rawPath, paths.video, {
        start: example.trim.start, duration: example.trim.duration, timeoutMs: 5 * 60 * 1000,
      });
      const probed = await media.probeVideo(this.ffprobePath, paths.video);
      if (!probed || !probed.duration) throw new Error('The converted video has no video stream.');
      await media.makePoster(this.ffmpegPath, paths.video, paths.poster);
      await writeJsonAtomic(paths.meta, { duration: roundSec(probed.duration), width: probed.width, height: probed.height });
    } catch (error) {
      await fsp.rm(paths.video, { force: true }).catch(() => {});
      await fsp.rm(paths.poster, { force: true }).catch(() => {});
      await fsp.rm(paths.meta, { force: true }).catch(() => {});
      throw error;
    } finally {
      await fsp.rm(rawPath, { force: true }).catch(() => {});
    }
  }

  // Register an uploaded driving video already written to `tmpPath`. Checks
  // the signature, probes it and makes a poster. Returns the DrivingView.
  async addUpload(tmpPath, originalName) {
    const type = await uploadType(tmpPath, originalName);
    if (!type) throw apiError(415, 'unsupported_type', 'Upload an MP4, MOV or WebM video.');
    const probed = await media.probeVideo(this.ffprobePath, tmpPath).catch(() => null);
    if (!probed || !probed.duration) throw apiError(415, 'no_video_stream', 'No video stream found in the file.');
    const id = `up-${crypto.randomUUID()}`;
    const dir = path.join(this.uploadsDir, id);
    await fsp.mkdir(dir, { recursive: true });
    try {
      const videoPath = path.join(dir, `video${type.ext}`);
      await fsp.rename(tmpPath, videoPath);
      await media.makePoster(this.ffmpegPath, videoPath, path.join(dir, 'poster.jpg'));
      const base = path.basename(String(originalName || ''), path.extname(String(originalName || '')));
      const meta = {
        id,
        label: cleanLabel(base) || '내 영상',
        filename: cleanLabel(path.basename(String(originalName || ''))) || null,
        ext: type.ext,
        mime: type.mime,
        createdAt: new Date().toISOString(),
        duration: roundSec(probed.duration),
        width: probed.width,
        height: probed.height,
      };
      await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
      this.uploads.set(id, meta);
      return this.view(await this.get(id));
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // Delete a driving video. An upload is removed; an example is hidden for
  // this install and its downloaded files are removed. False when `id` is
  // unknown or already hidden.
  async remove(id) {
    if (EXAMPLE_ID_RE.test(id) && this.examples.some(item => item.id === id)) {
      if (this.hidden.has(id)) return false;
      this.hidden.add(id);
      try {
        await this._saveHidden();
      } catch (error) {
        this.hidden.delete(id);
        throw error;
      }
      await this._removeExampleFiles(id);
      return true;
    }
    if (!UPLOAD_ID_RE.test(id) || !this.uploads.has(id)) return false;
    this.uploads.delete(id);
    await fsp.rm(path.join(this.uploadsDir, id), { recursive: true, force: true });
    return true;
  }

  // Clear the hidden list. Restored examples are unavailable until fetched again.
  async restoreExamples() {
    const previous = new Set(this.hidden);
    this.hidden.clear();
    try {
      await this._saveHidden();
    } catch (error) {
      this.hidden = previous;
      throw error;
    }
  }

  close() {
    if (this.fetching) this.fetching.abort();
  }
}

// Stream a manifest URL to `destPath`, following redirects manually so every
// hop is checked (https only, unless allowHttp), with a size cap and one
// overall timeout.
async function downloadExample(doFetch, url, destPath, { signal, allowHttp = false, maxBytes = EXAMPLE_MAX_BYTES, timeoutMs = EXAMPLE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const allowed = (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'https:' || (allowHttp && protocol === 'http:');
    } catch { return false; }
  };
  let out = null;
  try {
    let current = url;
    let response;
    for (let hop = 0; ; hop += 1) {
      if (!allowed(current)) throw new Error('Only https download URLs are allowed.');
      response = await doFetch(current, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) throw new Error('Redirect without a location.');
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects.');
        current = new URL(location, current).href;
        continue;
      }
      break;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Download failed with HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error('The file is larger than 100 MB.');
    }
    if (!response.body) throw new Error('Empty response.');
    out = fs.createWriteStream(destPath, { flags: 'wx' });
    let written = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('The file is larger than 100 MB.');
      }
      // events.once() rejects on 'error' and removes both listeners, so repeated drains do not pile up listeners.
      if (!out.write(Buffer.from(value))) await once(out, 'drain');
    }
    if (written === 0) throw new Error('Empty response.');
    await new Promise((resolve, reject) => { out.end(resolve); out.once('error', reject); });
    out = null;
  } catch (error) {
    if (out) await closeStream(out);
    await fsp.rm(destPath, { force: true }).catch(() => {});
    if (timedOut) throw new Error('Download timed out.');
    if (error.name === 'AbortError') throw new Error('Download was aborted.');
    if (error instanceof TypeError) throw new Error('Download failed: network error.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Destroy a write stream and wait until its file handle is closed, so a
// following rm cannot race the lazy open.
function closeStream(stream) {
  return new Promise(resolve => {
    if (stream.closed) return resolve();
    stream.once('close', resolve);
    stream.destroy();
  });
}

async function readHead(filePath, length = 12) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// 'mp4' | 'mov' | 'webm' | null from the file's first bytes.
async function sniffVideo(filePath) {
  const head = await readHead(filePath, 12);
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
    return head.toString('ascii', 8, 12) === 'qt  ' ? 'mov' : 'mp4';
  }
  return null;
}

async function hasVideoSignature(filePath) {
  return (await sniffVideo(filePath)) !== null;
}

// The upload type from the signature; a .mov name on an ISO-BMFF file is
// served as QuickTime even when its brand is not 'qt  '.
async function uploadType(filePath, originalName) {
  const sniffed = await sniffVideo(filePath);
  if (!sniffed) return null;
  if (sniffed === 'webm') return UPLOAD_TYPES.webm;
  if (sniffed === 'mov' || path.extname(String(originalName || '')).toLowerCase() === '.mov') return UPLOAD_TYPES.mov;
  return UPLOAD_TYPES.mp4;
}

function cleanLabel(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function roundSec(value) {
  return Number.isFinite(value) ? Number(Number(value).toFixed(3)) : null;
}

function safeMessage(message) {
  return String(message || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/(\/[^\s"']+)/g, m => path.basename(m)).slice(0, 240);
}

// The hidden example ids from hidden-examples.json; malformed ids are dropped.
async function readHidden(filePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    const list = raw && Array.isArray(raw.hidden) ? raw.hidden : [];
    return new Set(list.filter(id => typeof id === 'string' && EXAMPLE_ID_RE.test(id)));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`hidden examples list unreadable: ${error.message}`);
    return new Set();
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
    await fsp.rename(tmp, filePath);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

module.exports = {
  DrivingStore,
  loadManifest,
  validateExample,
  downloadExample,
  sniffVideo,
  EXAMPLE_ID_RE,
  UPLOAD_ID_RE,
  EXAMPLE_MAX_BYTES,
};
