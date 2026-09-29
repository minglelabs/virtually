'use strict';

// Character library for the "동작 만들기" page: many uploaded character
// images, one of them selected.
//
// Layout under <dataDir>/animate/characters/:
//   <id>.png | <id>.jpg | <id>.webp   the images (id = ch-<uuid>)
//   index.json                        { selectedId, items: [CharacterRecord] }
//
// index.json is written atomically (temp file + rename) and every mutation
// runs behind one mutex. Ids are checked against CHARACTER_ID_RE before they
// are ever used to build a path.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const media = require('./media');

const CHARACTER_ID_RE = /^ch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHARACTER_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
});
const EXT_FOR_MIME = Object.freeze(Object.fromEntries(Object.entries(CHARACTER_TYPES).map(([ext, mime]) => [mime, ext])));

function apiError(status, code, message, detail) {
  return Object.assign(new Error(message), { status, code, detail });
}

// The image type from its first bytes: '.png' | '.jpg' | '.webp' | null.
async function sniffImage(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, 12, 0);
    if (bytesRead >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (bytesRead >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
    if (bytesRead >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    return null;
  } finally {
    await handle.close();
  }
}

function cleanFilename(originalName, fallback) {
  return String(path.basename(String(originalName || ''))).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) || fallback;
}

function timeValue(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

// Most recently selected first; never-selected items after them, newest first.
function compareRecords(a, b) {
  const as = a.lastSelectedAt ? timeValue(a.lastSelectedAt) : null;
  const bs = b.lastSelectedAt ? timeValue(b.lastSelectedAt) : null;
  if (as != null && bs != null && as !== bs) return bs - as;
  if (as != null && bs == null) return -1;
  if (as == null && bs != null) return 1;
  const diff = timeValue(b.createdAt) - timeValue(a.createdAt);
  if (diff) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validRecord(item) {
  return item && typeof item === 'object'
    && typeof item.id === 'string' && CHARACTER_ID_RE.test(item.id)
    && typeof item.mime === 'string' && EXT_FOR_MIME[item.mime];
}

class CharacterStore {
  constructor({ animateDir, ffprobePath }) {
    this.animateDir = animateDir;
    this.dir = path.join(animateDir, 'characters');
    this.indexPath = path.join(this.dir, 'index.json');
    this.ffprobePath = ffprobePath;
    this.items = [];
    this.selectedId = null;
    this._mutation = Promise.resolve();
    this._lastStamp = 0;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    let stored = null;
    try {
      stored = JSON.parse(await fsp.readFile(this.indexPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`character index unreadable: ${error.message}`);
    }
    const seen = new Set();
    const items = [];
    for (const item of stored && Array.isArray(stored.items) ? stored.items : []) {
      if (!validRecord(item) || seen.has(item.id)) continue;
      if (!fs.existsSync(this._pathFor(item))) continue;
      seen.add(item.id);
      items.push(normalizeRecord(item));
    }
    this.items = items;
    this.selectedId = stored && seen.has(stored.selectedId) ? stored.selectedId : null;
    for (const item of items) {
      for (const value of [item.createdAt, item.lastSelectedAt]) this._lastStamp = Math.max(this._lastStamp, timeValue(value));
    }
    this._fixSelection();
    await this._lock(() => this._migrateLegacy());
    return this;
  }

  _pathFor(item) {
    return path.join(this.dir, `${item.id}${EXT_FOR_MIME[item.mime]}`);
  }

  // Strictly increasing ISO timestamps, so two selections in the same
  // millisecond still order deterministically.
  _stamp() {
    const now = Math.max(Date.now(), this._lastStamp + 1);
    this._lastStamp = now;
    return new Date(now).toISOString();
  }

  _lock(callback) {
    const next = this._mutation.then(callback);
    this._mutation = next.catch(() => {});
    return next;
  }

  _sorted() {
    return [...this.items].sort(compareRecords);
  }

  // Keep selectedId pointing at an existing item: the most recent one when
  // the stored selection is gone, null when the library is empty.
  _fixSelection() {
    if (this.selectedId && this.items.some(item => item.id === this.selectedId)) return;
    const first = this._sorted()[0];
    this.selectedId = first ? first.id : null;
  }

  async _save() {
    const tmp = `${this.indexPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ selectedId: this.selectedId, items: this.items }, null, 2) + '\n');
      await fsp.rename(tmp, this.indexPath);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // Import the old single-slot character (character.json + character.<ext>)
  // when the library is still empty, then remove the legacy files.
  async _migrateLegacy() {
    if (this.items.length > 0) return;
    const metaPath = path.join(this.animateDir, 'character.json');
    let meta;
    try { meta = JSON.parse(await fsp.readFile(metaPath, 'utf8')); } catch { return; }
    if (!meta || !CHARACTER_TYPES[meta.ext]) return;
    const legacyPath = path.join(this.animateDir, `character${meta.ext}`);
    if (!fs.existsSync(legacyPath)) return;
    const id = `ch-${crypto.randomUUID()}`;
    const record = normalizeRecord({
      id,
      filename: cleanFilename(meta.filename, `character${meta.ext}`),
      mime: CHARACTER_TYPES[meta.ext],
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.hasAlpha,
      createdAt: typeof meta.uploadedAt === 'string' && timeValue(meta.uploadedAt) ? meta.uploadedAt : this._stamp(),
      lastSelectedAt: this._stamp(),
    });
    await fsp.rename(legacyPath, this._pathFor(record));
    this.items = [record];
    this.selectedId = id;
    await this._save();
    await fsp.rm(metaPath, { force: true }).catch(() => {});
    for (const ext of Object.keys(CHARACTER_TYPES)) {
      await fsp.rm(path.join(this.animateDir, `character${ext}`), { force: true }).catch(() => {});
    }
  }

  // Internal record for an id, with its file path, or null. Unknown or
  // malformed ids never reach the file system.
  get(id) {
    if (typeof id !== 'string' || !CHARACTER_ID_RE.test(id)) return null;
    const item = this.items.find(entry => entry.id === id);
    return item ? { ...item, path: this._pathFor(item) } : null;
  }

  selected() {
    return this.selectedId ? this.get(this.selectedId) : null;
  }

  view(item) {
    return {
      id: item.id,
      filename: item.filename,
      width: item.width,
      height: item.height,
      hasAlpha: item.hasAlpha,
      url: `/api/animate/characters/${item.id}/image`,
      createdAt: item.createdAt,
      lastSelectedAt: item.lastSelectedAt,
      selected: item.id === this.selectedId,
    };
  }

  listView() {
    return { characters: this._sorted().map(item => this.view(item)), selectedId: this.selectedId };
  }

  // Register an image already written to `tmpPath` (moved, not copied). The
  // new character becomes the selected one. Returns its view.
  async add(tmpPath, originalName) {
    const ext = await sniffImage(tmpPath);
    if (!ext) throw apiError(415, 'unsupported_type', 'Upload a PNG, JPEG or WebP image.');
    const probed = await media.probeVideo(this.ffprobePath, tmpPath).catch(() => null);
    return this._lock(async () => {
      const now = this._stamp();
      const record = normalizeRecord({
        id: `ch-${crypto.randomUUID()}`,
        filename: cleanFilename(originalName, `character${ext}`),
        mime: CHARACTER_TYPES[ext],
        width: probed ? probed.width : null,
        height: probed ? probed.height : null,
        hasAlpha: probed ? !!probed.hasAlpha : null,
        createdAt: now,
        lastSelectedAt: now,
      });
      const target = this._pathFor(record);
      await fsp.rename(tmpPath, target);
      const previous = { items: this.items, selectedId: this.selectedId };
      this.items = [...this.items, record];
      this.selectedId = record.id;
      try {
        await this._save();
      } catch (error) {
        this.items = previous.items;
        this.selectedId = previous.selectedId;
        await fsp.rm(target, { force: true }).catch(() => {});
        throw error;
      }
      return this.view(record);
    });
  }

  async select(id) {
    if (!this.get(id)) throw apiError(404, 'character_missing', 'Character not found.');
    return this._lock(async () => {
      const index = this.items.findIndex(item => item.id === id);
      if (index < 0) throw apiError(404, 'character_missing', 'Character not found.');
      const items = [...this.items];
      items[index] = { ...items[index], lastSelectedAt: this._stamp() };
      this.items = items;
      this.selectedId = id;
      await this._save();
      return this.listView();
    });
  }

  // Delete one character. Removing the selected one selects the next most
  // recently selected item (or none). Jobs keep their own snapshot copy.
  async remove(id) {
    if (!this.get(id)) throw apiError(404, 'character_missing', 'Character not found.');
    return this._lock(async () => {
      const item = this.items.find(entry => entry.id === id);
      if (!item) throw apiError(404, 'character_missing', 'Character not found.');
      this.items = this.items.filter(entry => entry.id !== id);
      if (this.selectedId === id) this.selectedId = null;
      this._fixSelection();
      await this._save();
      await fsp.rm(this._pathFor(item), { force: true }).catch(() => {});
      return this.listView();
    });
  }
}

function normalizeRecord(item) {
  const num = value => (Number.isFinite(value) ? value : null);
  return {
    id: item.id,
    filename: typeof item.filename === 'string' && item.filename ? item.filename.slice(0, 100) : `character${EXT_FOR_MIME[item.mime]}`,
    mime: item.mime,
    width: num(item.width),
    height: num(item.height),
    hasAlpha: typeof item.hasAlpha === 'boolean' ? item.hasAlpha : null,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    lastSelectedAt: typeof item.lastSelectedAt === 'string' && timeValue(item.lastSelectedAt) ? item.lastSelectedAt : null,
  };
}

module.exports = { CharacterStore, sniffImage, compareRecords, CHARACTER_ID_RE, CHARACTER_TYPES };
