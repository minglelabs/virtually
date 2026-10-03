'use strict';

// A photo is one thing with versions (original, free cut, AI cut). The copies that a
// removed background used to add as separate photos are merged back into their photos.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CharacterStore, photoVersionKinds, usedVersion, photoDisplay } = require('../lib/characters');

const ffmpeg = (args) => {
  const done = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  assert.equal(done.status, 0, String(done.stderr));
};
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('versions of a photo record: what it has and which one is in use', () => {
  const plain = { id: `ph-${uuid(1)}`, mime: 'image/jpeg', cutout: { cut: true, color: '#fff', fit: { v: 1 } }, fit: null };
  assert.deepEqual(photoVersionKinds(plain), ['original', 'plain']);
  assert.equal(usedVersion(plain), 'plain', 'without a choice: the cut made at upload, as before');
  assert.equal(usedVersion({ ...plain, use: 'original' }), 'original');
  assert.equal(usedVersion({ ...plain, use: 'ai' }), 'plain', 'a version the photo does not have is not in use');
  const both = { ...plain, aiCut: true, aiCutFit: { v: 2 }, use: 'ai' };
  assert.deepEqual(photoVersionKinds(both), ['original', 'plain', 'ai']);
  assert.deepEqual(photoDisplay(both), { cut: true, kind: 'ai', url: `/api/media/${both.id}?variant=aicut`, mime: 'image/png', fit: { v: 2 } });
  assert.deepEqual(photoDisplay({ ...both, use: 'original' }), { cut: false, kind: 'original', url: `/api/media/${both.id}`, mime: 'image/jpeg', fit: null });
  assert.deepEqual(photoVersionKinds({ id: 'x', mime: 'image/png', cutout: { cut: false, reason: 'not_uniform' } }), ['original']);
});

test('load merges the background-removed copies of before versions into their photos', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-photo-versions-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const photosDir = path.join(dataDir, 'characters', 'photos');
  await fs.mkdir(photosDir, { recursive: true });
  const ids = { busy: `ph-${uuid(1)}`, aiCopy: `ph-${uuid(2)}`, white: `ph-${uuid(3)}`, plainCopy: `ph-${uuid(4)}`, other: `ph-${uuid(5)}` };
  const opaque = (color, file) => ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=64x96`, '-vf', 'drawbox=x=16:y=24:w=32:h=48:color=red:t=fill', '-frames:v', '1', file]);
  const cut = file => ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=200:g=40:b=40:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'", '-frames:v', '1', file]);
  opaque('gray', path.join(photosDir, `${ids.busy}.jpg`));
  cut(path.join(photosDir, `${ids.busy}.aicut.png`));
  await fs.copyFile(path.join(photosDir, `${ids.busy}.aicut.png`), path.join(photosDir, `${ids.aiCopy}.png`)); // the AI copy is the kept AI cut
  opaque('white', path.join(photosDir, `${ids.white}.png`));
  cut(path.join(photosDir, `${ids.plainCopy}.png`));
  cut(path.join(photosDir, `${ids.other}.png`));
  const at = n => new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString();
  const photo = (id, filename, mime, hasAlpha, n, extra = {}) => ({ id, filename, mime, width: 64, height: 96, hasAlpha, createdAt: at(n), fit: hasAlpha ? { v: 1, mark: id } : null, ...extra });
  const characterId = `c-${uuid(9)}`;
  const index = {
    v: 1, activePhotoId: ids.aiCopy,
    characters: [{
      id: characterId, name: '캐릭터', createdAt: at(0), basePhotoId: ids.plainCopy,
      photos: [
        photo(ids.busy, 'girl.jpg', 'image/jpeg', false, 1, { cutout: { cut: false, reason: 'not_uniform' }, aiCut: true }),
        photo(ids.aiCopy, 'girl-투명.png', 'image/png', true, 2, { cutout: { cut: false, reason: 'has_alpha' } }),
        photo(ids.white, 'boy.png', 'image/png', false, 3, { cutout: { cut: false, reason: 'kept' } }),
        photo(ids.plainCopy, 'boy-투명.png', 'image/png', true, 4, { cutout: { cut: false, reason: 'has_alpha' } }),
        // Named like a copy, but no photo it could come from: stays a photo.
        photo(ids.other, 'cat-투명.png', 'image/png', true, 5, { cutout: { cut: false, reason: 'has_alpha' } }),
      ],
    }],
  };
  await fs.writeFile(path.join(dataDir, 'characters', 'index.json'), JSON.stringify(index));
  const motion = (n, photoId) => ({ id: uuid(100 + n), name: `m${n}`, kind: 'motion', mime: 'video/webm', photoId });
  let library = {
    idle: null,
    motions: [motion(1, ids.busy), motion(2, ids.aiCopy), motion(3, ids.plainCopy), motion(4, ids.other)],
    idles: { [ids.aiCopy]: { id: uuid(200), kind: 'idle' } },
    idleChoice: { [ids.plainCopy]: uuid(103) },
  };
  const store = await new CharacterStore({ dataDir, log: () => {} }).load({ library, writeLibrary: async (next) => { library = next; } });

  const [character] = store.characters;
  assert.deepEqual(character.photos.map(p => p.id).sort(), [ids.busy, ids.white, ids.other].sort(), 'the two copies are gone as photos');
  const busy = character.photos.find(p => p.id === ids.busy);
  const white = character.photos.find(p => p.id === ids.white);
  assert.deepEqual([busy.use, photoVersionKinds(busy), busy.aiCutFit.mark], ['ai', ['original', 'ai'], ids.aiCopy]);
  assert.deepEqual([white.use, photoVersionKinds(white), white.cutout.fit.mark], ['plain', ['original', 'plain'], ids.plainCopy]);
  assert.ok(fsSync.existsSync(path.join(photosDir, `${ids.white}.cutout.png`)), 'the copy became the photo\'s free version');
  assert.deepEqual([ids.aiCopy, ids.plainCopy].map(id => fsSync.existsSync(path.join(photosDir, `${id}.png`))), [false, false]);
  // On air, base, motions, the idle and the idle choice follow the photo.
  assert.deepEqual([store.activePhotoId, character.basePhotoId], [ids.busy, ids.white]);
  assert.deepEqual(library.motions.map(m => m.photoId), [ids.busy, ids.busy, ids.white, ids.other]);
  assert.deepEqual([Object.keys(library.idles), library.idleChoice], [[ids.busy], { [ids.white]: uuid(103) }]);
  // A job made from a copy still finds its photo.
  assert.equal(store.getPhoto(ids.aiCopy).photo.id, ids.busy);
  assert.equal(store.getPhoto(ids.plainCopy).photo.id, ids.white);
  assert.deepEqual(store.merged, { [ids.aiCopy]: ids.busy, [ids.plainCopy]: ids.white });

  // Written as v2: the next start changes nothing and keeps the aliases.
  const written = JSON.parse(await fs.readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
  assert.deepEqual([written.v, written.merged], [2, store.merged]);
  const again = await new CharacterStore({ dataDir, log: () => {} }).load({ library, writeLibrary: async () => { throw new Error('nothing to write'); } });
  assert.deepEqual(again.characters, store.characters);
  assert.equal(again.getPhoto(ids.aiCopy).photo.id, ids.busy);

  // Versions are picked, never lost.
  let changed = await again.setUse(characterId, ids.busy, 'original');
  assert.deepEqual([changed.photo.use, photoVersionKinds(changed.photo)], ['original', ['original', 'ai']]);
  await assert.rejects(again.setUse(characterId, ids.busy, 'plain'), { code: 'no_such_version' });
  changed = await again.setUse(characterId, ids.busy, 'ai');
  assert.equal(changed.photo.use, 'ai');
});
