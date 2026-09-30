'use strict';

// Characters: a name plus photos, shared by every allowed login. Every
// character has a base photo; every motion in library.json belongs to one
// photo (motion.photoId). At most one photo is ON AIR (activePhotoId): the
// overlay's idle image and motion list follow it (server.js builds that
// library view from this store and the library).
//
// Layout under <dataDir>/characters/:
//   index.json              { v: 1, activePhotoId, characters: [Character] }
//   photos/<photoId><ext>   the photos (.png | .jpg | .webp)
//
// Character { id: 'c-<uuid>', name, createdAt, basePhotoId, photos: [Photo] }
// Photo     { id: 'ph-<uuid>' | migrated 'ch-<uuid>', filename, mime, width,
//             height, hasAlpha, createdAt, fit }   (fit: fit.js, measured when added)
//
// index.json is written atomically (temp file + rename) behind one mutex, and
// the in-memory state only changes once that write has succeeded. Ids are
// checked against their pattern before they are ever used to build a path.
//
// Migration (load(), once: when index.json is absent): every valid photo of
// the old single-list library (<dataDir>/animate/characters/index.json, file
// present) becomes its own character '캐릭터 N' (N = 1.. by createdAt) with the
// SAME id; its file is copied, the legacy directory is left untouched. The
// legacy selection (else the first photo) goes on air. Library motions get the
// photo of their job (source.jobId -> job.characterId), unresolved ones the
// on-air photo; a legacy idle becomes the on-air photo's idle. library.json is
// written before index.json, so an interrupted migration simply runs again.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const media = require('./animate/media');
const { measureFit } = require('./animate/fit');
const { jobPhotoId } = require('./animate/pipeline');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHARACTER_ID_RE = new RegExp(`^c-${UUID}$`);
// 'ph-' for photos added here, 'ch-' for photos migrated from the old library.
const PHOTO_ID_RE = new RegExp(`^(?:ph|ch)-${UUID}$`);
const LEGACY_PHOTO_ID_RE = new RegExp(`^ch-${UUID}$`);
const JOB_ID_RE = new RegExp(`^${UUID}$`);

// The photo types, by sniffed extension.
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
});
const EXT_FOR_MIME = Object.freeze(Object.fromEntries(Object.entries(IMAGE_TYPES).map(([ext, mime]) => [mime, ext])));

const MAX_CHARACTERS = 50;
const MAX_PHOTOS = 30;
const NAME_MAX = 40;
const PHOTO_MAX_BYTES = 20 * 1024 * 1024;

// JSON error texts of the character API (and the finished-motion upload).
const ERRORS = Object.freeze({
  name_missing: [400, '캐릭터 이름을 입력해 주세요.'],
  name_too_long: [400, '캐릭터 이름은 40자까지 쓸 수 있습니다.'],
  photo_missing: [404, '사진을 찾을 수 없습니다.'],
  character_missing: [404, '캐릭터를 찾을 수 없습니다.'],
  unsupported_image: [415, 'PNG, JPEG, WebP 사진만 올릴 수 있습니다.'],
  too_large: [413, '사진은 20MB까지 올릴 수 있습니다.'],
  last_photo: [409, '사진이 하나뿐인 캐릭터는 캐릭터를 삭제해 주세요.'],
  too_many_characters: [409, '캐릭터는 50개까지 만들 수 있습니다.'],
  too_many_photos: [409, '사진은 캐릭터마다 30장까지 올릴 수 있습니다.'],
  unsupported_video: [415, 'WebM, MP4, MOV 영상만 올릴 수 있습니다.'],
  too_long: [400, '영상은 60초까지 올릴 수 있습니다.'],
  too_large_video: [413, '영상은 500MB까지 올릴 수 있습니다.'],
});

// An error the server's handler turns into `{ error, code }`. `status`
// overrides the default (photo_missing is 400/409 on the animate routes).
function characterError(code, status) {
  const [defaultStatus, message] = ERRORS[code];
  return Object.assign(new Error(message), { status: status || defaultStatus, code });
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

// Control characters become spaces, whitespace runs collapse, ends are trimmed.
function cleanText(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// A character name as typed: trimmed, 1-40 characters (code points).
function checkName(value) {
  const name = typeof value === 'string' ? cleanText(value) : '';
  if (!name) throw characterError('name_missing');
  if ([...name].length > NAME_MAX) throw characterError('name_too_long');
  return name;
}

function cleanFilename(value, fallback) {
  return path.basename(String(value || '')).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) || fallback;
}

function timeValue(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function validPhoto(item) {
  return !!item && typeof item === 'object' && typeof item.id === 'string' && PHOTO_ID_RE.test(item.id)
    && typeof item.mime === 'string' && !!EXT_FOR_MIME[item.mime];
}

function normalizePhoto(item) {
  const num = value => (Number.isFinite(value) ? value : null);
  return {
    id: item.id,
    filename: cleanFilename(item.filename, `photo${EXT_FOR_MIME[item.mime]}`),
    mime: item.mime,
    width: num(item.width),
    height: num(item.height),
    hasAlpha: typeof item.hasAlpha === 'boolean' ? item.hasAlpha : null,
    createdAt: typeof item.createdAt === 'string' && timeValue(item.createdAt) ? item.createdAt : new Date(0).toISOString(),
    fit: item.fit && typeof item.fit === 'object' ? item.fit : null,
  };
}

// Oldest first (a stable sort, so equal times keep their stored order).
function byCreatedAt(items) {
  return [...items].sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt));
}

// The base photo first, then the others oldest first.
function orderedPhotos(character) {
  const base = character.photos.find(photo => photo.id === character.basePhotoId);
  return [...(base ? [base] : []), ...byCreatedAt(character.photos.filter(photo => photo !== base))];
}

// A stored index -> { characters, activePhotoId }. Malformed records are
// dropped; a character needs at least one valid photo; a missing base passes
// to the oldest photo; an unknown activePhotoId is cleared.
function normalizeState(stored) {
  const characters = [];
  const characterIds = new Set();
  const photoIds = new Set();
  for (const raw of stored && Array.isArray(stored.characters) ? stored.characters : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !CHARACTER_ID_RE.test(raw.id) || characterIds.has(raw.id)) continue;
    const photos = [];
    for (const photo of Array.isArray(raw.photos) ? raw.photos : []) {
      if (!validPhoto(photo) || photoIds.has(photo.id)) continue;
      photoIds.add(photo.id);
      photos.push(normalizePhoto(photo));
    }
    if (!photos.length) continue;
    characterIds.add(raw.id);
    const name = typeof raw.name === 'string' ? [...cleanText(raw.name)].slice(0, NAME_MAX).join('') : '';
    characters.push({
      id: raw.id,
      name: name || '캐릭터',
      createdAt: typeof raw.createdAt === 'string' && timeValue(raw.createdAt) ? raw.createdAt : photos[0].createdAt,
      basePhotoId: photos.some(photo => photo.id === raw.basePhotoId) ? raw.basePhotoId : byCreatedAt(photos)[0].id,
      photos,
    });
  }
  const activePhotoId = stored && typeof stored.activePhotoId === 'string' && photoIds.has(stored.activePhotoId) ? stored.activePhotoId : null;
  return { characters, activePhotoId };
}

class CharacterStore {
  constructor({ dataDir, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', log = message => console.log(message) }) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'characters');
    this.photosDir = path.join(this.dir, 'photos');
    this.indexPath = path.join(this.dir, 'index.json');
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.log = log;
    this.characters = [];
    this.activePhotoId = null;
    this._mutation = Promise.resolve();
    this._lastStamp = 0;
  }

  // Read index.json, or migrate the old library when it is absent.
  // `library` is the loaded library.json and `writeLibrary(next)` persists a
  // changed one; both are used by the migration only.
  async load({ library = null, writeLibrary = null } = {}) {
    await fsp.mkdir(this.photosDir, { recursive: true });
    let stored;
    try {
      stored = JSON.parse(await fsp.readFile(this.indexPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this._migrate(library, writeLibrary);
        return this;
      }
      console.warn(`[characters] index unreadable: ${error.message}`);
      stored = null;
    }
    const state = normalizeState(stored);
    this.characters = state.characters;
    this.activePhotoId = state.activePhotoId;
    for (const character of this.characters) {
      this._lastStamp = Math.max(this._lastStamp, timeValue(character.createdAt), ...character.photos.map(photo => timeValue(photo.createdAt)));
    }
    return this;
  }

  // --- lookups (committed state only) ----------------------------------------

  photoPath(photo) {
    return path.join(this.photosDir, `${photo.id}${EXT_FOR_MIME[photo.mime]}`);
  }

  getCharacter(id) {
    if (typeof id !== 'string' || !CHARACTER_ID_RE.test(id)) return null;
    return this.characters.find(character => character.id === id) || null;
  }

  // { character, photo, path } | null. Unknown or malformed ids never reach the file system.
  getPhoto(id) {
    if (typeof id !== 'string' || !PHOTO_ID_RE.test(id)) return null;
    for (const character of this.characters) {
      const photo = character.photos.find(item => item.id === id);
      if (photo) return { character, photo, path: this.photoPath(photo) };
    }
    return null;
  }

  // The on-air photo, same shape as getPhoto, or null.
  active() {
    return this.activePhotoId ? this.getPhoto(this.activePhotoId) : null;
  }

  activeCharacterId() {
    const active = this.active();
    return active ? active.character.id : null;
  }

  // --- views -------------------------------------------------------------------

  // `library` = the stored library ({ idle, motions, idles }).
  photoView(photo, character, library) {
    const motions = library.motions.filter(item => item.photoId === photo.id)
      .map(item => ({ id: item.id, name: item.name, mime: item.mime, createdAt: item.createdAt }));
    return {
      id: photo.id,
      url: `/api/media/${photo.id}`,
      width: photo.width,
      height: photo.height,
      hasAlpha: photo.hasAlpha,
      createdAt: photo.createdAt,
      isBase: photo.id === character.basePhotoId,
      onAir: photo.id === this.activePhotoId,
      idle: library.idles && library.idles[photo.id] ? 'upload' : 'photo',
      motionCount: motions.length,
      motions,
    };
  }

  // CharacterView for a record or an id (null when unknown).
  characterView(value, library) {
    const character = typeof value === 'string' ? this.getCharacter(value) : value;
    if (!character) return null;
    return {
      id: character.id,
      name: character.name,
      createdAt: character.createdAt,
      basePhotoId: character.basePhotoId,
      onAir: character.photos.some(photo => photo.id === this.activePhotoId),
      photos: orderedPhotos(character).map(photo => this.photoView(photo, character, library)),
    };
  }

  // { characters (oldest first), activePhotoId, activeCharacterId }
  listView(library) {
    return {
      characters: byCreatedAt(this.characters).map(character => this.characterView(character, library)),
      activePhotoId: this.activePhotoId,
      activeCharacterId: this.activeCharacterId(),
    };
  }

  // --- mutations ---------------------------------------------------------------

  // A new character from an image already written to `tmpPath` (moved, not
  // copied). Returns { character, photo }.
  async create(tmpPath, { name, filename } = {}) {
    const cleanName = checkName(name);
    if (this.characters.length >= MAX_CHARACTERS) throw characterError('too_many_characters');
    const photo = await this._preparePhoto(tmpPath, filename);
    try {
      return await this._lock(async () => {
        if (this.characters.length >= MAX_CHARACTERS) throw characterError('too_many_characters');
        const stamp = this._stamp();
        const added = { ...photo, createdAt: stamp };
        const character = { id: `c-${crypto.randomUUID()}`, name: cleanName, createdAt: stamp, basePhotoId: added.id, photos: [added] };
        await this._commit({ characters: [...this.characters, character], activePhotoId: this.activePhotoId });
        return { character, photo: added };
      });
    } catch (error) {
      await fsp.rm(this.photoPath(photo), { force: true }).catch(() => {});
      throw error;
    }
  }

  async rename(id, name) {
    const cleanName = checkName(name);
    return this._lock(async () => {
      const character = this._require(id);
      const next = { ...character, name: cleanName };
      await this._commit({ characters: this._replace(next), activePhotoId: this.activePhotoId });
      return next;
    });
  }

  // Add a photo (already written to `tmpPath`) to a character. Returns { character, photo }.
  async addPhoto(id, tmpPath, { filename } = {}) {
    const existing = this._require(id);
    if (existing.photos.length >= MAX_PHOTOS) throw characterError('too_many_photos');
    const photo = await this._preparePhoto(tmpPath, filename);
    try {
      return await this._lock(async () => {
        const character = this._require(id);
        if (character.photos.length >= MAX_PHOTOS) throw characterError('too_many_photos');
        const added = { ...photo, createdAt: this._stamp() };
        const next = { ...character, photos: [...character.photos, added] };
        await this._commit({ characters: this._replace(next), activePhotoId: this.activePhotoId });
        return { character: next, photo: added };
      });
    } catch (error) {
      await fsp.rm(this.photoPath(photo), { force: true }).catch(() => {});
      throw error;
    }
  }

  // Delete a character and its photo files. `beforeCommit(photoIds)` runs
  // after validation and before index.json is written (the server removes
  // the photos' motions and idles there). Returns { character, photos }.
  async remove(id, { beforeCommit = null } = {}) {
    return this._lock(async () => {
      const character = this._require(id);
      const photoIds = character.photos.map(photo => photo.id);
      if (beforeCommit) await beforeCommit(photoIds);
      await this._commit({
        characters: this.characters.filter(item => item.id !== id),
        activePhotoId: photoIds.includes(this.activePhotoId) ? null : this.activePhotoId,
      });
      await this._removeFiles(character.photos);
      return { character, photos: character.photos };
    });
  }

  // Delete one photo (never the last one: 409 last_photo). A deleted base
  // passes to the oldest remaining photo. `beforeCommit` as in remove().
  // Returns { character (updated), photo }.
  async removePhoto(id, photoId, { beforeCommit = null } = {}) {
    return this._lock(async () => {
      const character = this._require(id);
      const photo = character.photos.find(item => item.id === photoId);
      if (!photo) throw characterError('photo_missing');
      if (character.photos.length === 1) throw characterError('last_photo');
      if (beforeCommit) await beforeCommit([photoId]);
      const photos = character.photos.filter(item => item.id !== photoId);
      const basePhotoId = character.basePhotoId === photoId ? byCreatedAt(photos)[0].id : character.basePhotoId;
      const next = { ...character, basePhotoId, photos };
      await this._commit({
        characters: this._replace(next),
        activePhotoId: this.activePhotoId === photoId ? null : this.activePhotoId,
      });
      await this._removeFiles([photo]);
      return { character: next, photo };
    });
  }

  async setBase(id, photoId) {
    return this._lock(async () => {
      const character = this._require(id);
      if (!character.photos.some(item => item.id === photoId)) throw characterError('photo_missing');
      if (character.basePhotoId === photoId) return character;
      const next = { ...character, basePhotoId: photoId };
      await this._commit({ characters: this._replace(next), activePhotoId: this.activePhotoId });
      return next;
    });
  }

  // Put a photo on air (null = nothing). Returns { changed }.
  async setActive(photoId) {
    if (photoId !== null && typeof photoId !== 'string') throw characterError('photo_missing', 400);
    return this._lock(async () => {
      if (photoId !== null && !this.getPhoto(photoId)) throw characterError('photo_missing');
      if (this.activePhotoId === photoId) return { changed: false };
      await this._commit({ characters: this.characters, activePhotoId: photoId });
      return { changed: true };
    });
  }

  // --- internals ---------------------------------------------------------------

  _require(id) {
    const character = this.getCharacter(id);
    if (!character) throw characterError('character_missing');
    return character;
  }

  _replace(next) {
    return this.characters.map(item => (item.id === next.id ? next : item));
  }

  _lock(callback) {
    const next = this._mutation.then(callback);
    this._mutation = next.catch(() => {});
    return next;
  }

  // Strictly increasing ISO timestamps, so records made in the same
  // millisecond still order deterministically.
  _stamp() {
    const now = Math.max(Date.now(), this._lastStamp + 1);
    this._lastStamp = now;
    return new Date(now).toISOString();
  }

  async _write(state) {
    const tmp = `${this.indexPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ v: 1, activePhotoId: state.activePhotoId, characters: state.characters }, null, 2) + '\n');
      await fsp.rename(tmp, this.indexPath);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async _commit(state) {
    await this._write(state);
    this.characters = state.characters;
    this.activePhotoId = state.activePhotoId;
  }

  async _removeFiles(photos) {
    for (const photo of photos) await fsp.rm(this.photoPath(photo), { force: true }).catch(() => {});
  }

  // Sniff, probe and measure an uploaded image, moving it into photos/.
  // Returns the photo record (createdAt is stamped on commit).
  async _preparePhoto(tmpPath, filename) {
    const ext = await sniffImage(tmpPath);
    if (!ext) throw characterError('unsupported_image');
    const probed = await media.probeVideo(this.ffprobePath, tmpPath).catch(() => null);
    const photo = {
      id: `ph-${crypto.randomUUID()}`,
      filename: cleanFilename(filename, `photo${ext}`),
      mime: IMAGE_TYPES[ext],
      width: probed ? probed.width : null,
      height: probed ? probed.height : null,
      hasAlpha: probed ? !!probed.hasAlpha : null,
      createdAt: null,
      fit: null,
    };
    const target = this.photoPath(photo);
    await fsp.rename(tmpPath, target);
    photo.fit = await measureFit(this.ffmpegPath, this.ffprobePath, target);
    return photo;
  }

  // --- migration ---------------------------------------------------------------

  async _migrate(library, writeLibrary) {
    const legacy = await this._legacyPhotos();
    const characters = [];
    for (const [index, item] of legacy.photos.entries()) {
      const photo = normalizePhoto(item.record);
      const target = this.photoPath(photo);
      await fsp.copyFile(item.path, target);
      if (photo.width == null || photo.height == null || photo.hasAlpha == null) {
        const probed = await media.probeVideo(this.ffprobePath, target).catch(() => null);
        if (probed) Object.assign(photo, { width: probed.width, height: probed.height, hasAlpha: !!probed.hasAlpha });
      }
      photo.fit = await measureFit(this.ffmpegPath, this.ffprobePath, target);
      characters.push({ id: `c-${crypto.randomUUID()}`, name: `캐릭터 ${index + 1}`, createdAt: photo.createdAt, basePhotoId: photo.id, photos: [photo] });
    }
    const photoIds = new Set(characters.map(character => character.basePhotoId));
    const activePhotoId = photoIds.has(legacy.selectedId) ? legacy.selectedId : (characters.length ? characters[0].basePhotoId : null);
    if (library && writeLibrary) {
      const next = await this._migrateLibrary(library, photoIds, activePhotoId);
      if (next) await writeLibrary(next);
    }
    // Written last: until it exists, a restart migrates again from the same inputs.
    await this._commit({ characters, activePhotoId });
    for (const character of characters) this._lastStamp = Math.max(this._lastStamp, timeValue(character.createdAt));
    if (characters.length) this.log(`[characters] migrated ${characters.length} photo(s)`);
  }

  // The valid legacy photos whose file exists, oldest first, and the legacy selection.
  async _legacyPhotos() {
    const dir = path.join(this.dataDir, 'animate', 'characters');
    let stored = null;
    try {
      stored = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[characters] legacy index unreadable: ${error.message}`);
    }
    const seen = new Set();
    const photos = [];
    for (const record of stored && Array.isArray(stored.items) ? stored.items : []) {
      if (!validPhoto(record) || !LEGACY_PHOTO_ID_RE.test(record.id) || seen.has(record.id)) continue;
      const file = path.join(dir, `${record.id}${EXT_FOR_MIME[record.mime]}`);
      if (!fs.existsSync(file)) continue;
      seen.add(record.id);
      photos.push({ record, path: file });
    }
    photos.sort((a, b) => timeValue(a.record.createdAt) - timeValue(b.record.createdAt));
    return { photos, selectedId: stored && typeof stored.selectedId === 'string' ? stored.selectedId : null };
  }

  // The migrated library, or null when nothing changes. A motion keeps a
  // photoId that is already a migrated photo (an interrupted run), else gets
  // its job's photo, else the on-air photo (null when there are no photos).
  async _migrateLibrary(library, photoIds, activePhotoId) {
    const jobPhotos = new Map();
    const jobPhoto = async jobId => {
      if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return null;
      if (!jobPhotos.has(jobId)) {
        let value = null;
        try {
          value = jobPhotoId(JSON.parse(await fsp.readFile(path.join(this.dataDir, 'animate', 'jobs', jobId, 'job.json'), 'utf8')));
        } catch { /* a missing or unreadable job resolves nothing */ }
        jobPhotos.set(jobId, value);
      }
      return jobPhotos.get(jobId);
    };
    let changed = false;
    const motions = [];
    for (const motion of library.motions) {
      let photoId = typeof motion.photoId === 'string' && photoIds.has(motion.photoId) ? motion.photoId : null;
      if (!photoId) {
        const fromJob = await jobPhoto(motion && motion.source ? motion.source.jobId : null);
        photoId = fromJob && photoIds.has(fromJob) ? fromJob : activePhotoId;
      }
      if ((motion.photoId ?? null) === photoId) {
        motions.push(motion);
      } else {
        changed = true;
        motions.push({ ...motion, photoId });
      }
    }
    let idle = library.idle || null;
    const idles = { ...(library.idles || {}) };
    if (activePhotoId && idle && !idles[activePhotoId]) {
      idles[activePhotoId] = idle;
      idle = null;
      changed = true;
    }
    return changed ? { ...library, idle, motions, idles } : null;
  }
}

module.exports = {
  CharacterStore,
  sniffImage,
  characterError,
  checkName,
  cleanFilename,
  IMAGE_TYPES,
  CHARACTER_ID_RE,
  PHOTO_ID_RE,
  MAX_CHARACTERS,
  MAX_PHOTOS,
  NAME_MAX,
  PHOTO_MAX_BYTES,
};
