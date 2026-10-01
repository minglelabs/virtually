'use strict';

// No demo avatar while a photo is on air: the controller's motion list
// (motions.js), the controller page (app.js), and the overlay's own guard
// (overlay.js), with the one "a photo is on air" rule they share.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const motions = require('../public/motions.js');
const overlay = require('../public/overlay.js');
const broadcast = require('../public/app.js');

const readPublic = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

const motion = (id, name) => ({ id, name, kind: 'motion', mime: 'video/webm', url: `/api/media/${id}`, photoId: 'ph-1' });
const PHOTO = { id: 'ph-1', url: '/api/media/ph-1', width: 400, height: 600, hasAlpha: true };
const onAir = (list = []) => ({
  idle: { id: 'ph-1', name: '민트', kind: 'idle', mime: 'image/png', url: '/api/media/ph-1', fit: null, source: { photoId: 'ph-1' } },
  motions: list,
  character: { id: 'c-1', name: '민트' },
  photo: PHOTO,
});
const offAir = (list = []) => ({ idle: null, motions: list, character: null, photo: null });

test('on air: no 데모 동작, unlinked presets are disabled with no trigger, linked ones and other motions play', () => {
  const items = motions.buildMotionItems(onAir([motion('a', '윙크'), motion('b', 'my dance')]));
  assert.equal(items.some(item => item.key === 'demo'), false);
  assert.equal(items.some(item => item.triggerId === 'demo'), false);
  const byKey = Object.fromEntries(items.map(item => [item.key, item]));
  assert.deepEqual(byKey['preset:wink'], { key: 'preset:wink', label: '윙크', sub: '영상', triggerId: 'a', linked: true });
  assert.deepEqual(byKey['preset:hi'], { key: 'preset:hi', label: '인사 (Hi)', sub: '영상 없음', triggerId: null, linked: false, disabled: true });
  assert.deepEqual(items.map(item => item.key), [...motions.PRESET_MOTIONS.map(p => `preset:${p.key}`), 'motion:b']);
  assert.deepEqual(items.filter(item => item.disabled).map(item => item.key),
    motions.PRESET_MOTIONS.filter(p => p.key !== 'wink').map(p => `preset:${p.key}`));
  assert.deepEqual(byKey['motion:b'], { key: 'motion:b', label: 'my dance', sub: '영상', triggerId: 'b', linked: true });
  // A photo on air without any motion: nine disabled presets, nothing else.
  const empty = motions.buildMotionItems(onAir());
  assert.equal(empty.length, motions.PRESET_MOTIONS.length);
  assert.ok(empty.every(item => item.disabled === true && item.triggerId === null && item.sub === '영상 없음'));
});

test('nothing on air: exactly the old list (데모 동작 first, unlinked presets play the demo, no disabled key)', () => {
  const lists = [offAir([motion('a', '윙크'), motion('b', 'extra')]), offAir(), { idle: null, motions: [] }, null, undefined, {}];
  for (const library of lists) {
    const items = motions.buildMotionItems(library);
    assert.deepEqual(items[0], { key: 'demo', label: '데모 동작', sub: '기본 아바타', triggerId: 'demo', linked: false });
    for (const item of items) assert.equal('disabled' in item, false, item.key);
    for (const item of items.slice(1, 1 + motions.PRESET_MOTIONS.length)) {
      if (!item.linked) assert.deepEqual([item.sub, item.triggerId], ['영상 없음 · 데모 재생', 'demo'], item.key);
    }
  }
  assert.equal(motions.buildMotionItems(offAir([motion('a', '윙크')])).find(i => i.key === 'preset:wink').triggerId, 'a');
});

test('one on-air rule: motions.js, overlay.js and app.js agree', () => {
  const cases = [
    [onAir(), 'ph-1'],
    [offAir(), null],
    [null, null],
    [undefined, null],
    ['x', null],
    [{ photo: { id: '' } }, null],
    [{ photo: { id: 5 } }, null],
    [{ photo: 'ph-1' }, null],
    [{ photo: { id: 'ch-2' }, character: null, idle: null }, 'ch-2'],
  ];
  for (const [library, expected] of cases) {
    assert.equal(motions.onAirPhotoId(library), expected, JSON.stringify(library));
    assert.equal(overlay.onAirPhotoId(library), expected, `overlay ${JSON.stringify(library)}`);
    assert.equal(broadcast.onAirView(library)?.photoId ?? null, expected, `app ${JSON.stringify(library)}`);
    // The motion list follows the same rule.
    assert.equal(motions.buildMotionItems(library)[0].key === 'demo', expected === null, `list ${JSON.stringify(library)}`);
  }
});

test('overlay reactionFor: motions play; demo / unknown are the demo only while nothing is on air', () => {
  const m = motion('m-1', '윙크');
  assert.deepEqual(overlay.reactionFor(onAir([m]), 'm-1'), { kind: 'motion', motion: m });
  assert.deepEqual(overlay.reactionFor(offAir([m]), 'm-1'), { kind: 'motion', motion: m });
  for (const id of ['demo', 'm-unknown', '', null]) {
    assert.deepEqual(overlay.reactionFor(onAir([m]), id), { kind: 'idle' }, `on air ${id}`);
    assert.deepEqual(overlay.reactionFor(offAir([m]), id), { kind: 'demo' }, `off air ${id}`);
  }
  // A motion without a url never plays: idle on air, the demo otherwise (as before).
  const broken = { id: 'm-2', name: 'x' };
  assert.deepEqual(overlay.reactionFor(onAir([broken]), 'm-2'), { kind: 'idle' });
  assert.deepEqual(overlay.reactionFor(offAir([broken]), 'm-2'), { kind: 'demo' });
  assert.deepEqual(overlay.reactionFor(null, 'demo'), { kind: 'demo' });
  // The fit helpers are still exported next to it.
  assert.equal(typeof overlay.placeMotion, 'function');
  assert.equal(typeof overlay.idleBox, 'function');
});

test('overlay wiring: every play goes through reactionFor; the demo layer is hidden until the library is known', () => {
  const js = readPublic('overlay.js');
  assert.match(js, /const reaction = OverlayPlayback\.reactionFor\(library, id\);/);
  assert.match(js, /if \(reaction\.kind === 'idle'\) \{\s*returnToIdle\(\);\s*return;\s*\}/);
  // playDemoReaction is only reached through the 'demo' reaction.
  assert.equal((js.match(/playDemoReaction\(token\);/g) || []).length, 1);
  assert.match(js, /photo: newLibrary\.photo && typeof newLibrary\.photo === 'object' \? newLibrary\.photo : null/);
  assert.match(js, /if \(first \|\| newIdleUrl !== prevIdleUrl\) \{/);
  const html = readPublic('overlay.html');
  assert.match(html, /<div id="demo-layer" class="layer demo-layer" aria-hidden="true">/);
  assert.doesNotMatch(html, /class="[^"]*\bactive\b/, 'no layer is shown before overlay.js knows the library');
});

test('controller wiring: disabled buttons are not clickable, the hint follows the mode', () => {
  const html = readPublic('index.html');
  assert.match(html, /<p id="motionHint" class="hint">영상이 없는 동작은 기본 아바타 데모로 재생됩니다\.<\/p>/);
  const app = readPublic('app.js');
  assert.match(app, /button\.disabled = item\.disabled === true;/);
  assert.match(app, /if \(!button \|\| button\.disabled\) return;/);
  assert.match(app, /if \(item && item\.disabled !== true && item\.triggerId\) trigger\(item\);/);
  assert.match(app, /const HINT_ON_AIR = '영상이 없는 동작은 누를 수 없습니다\. 동작 관리에서 영상을 넣어 주세요\.';/);
  assert.match(app, /motionHint\.textContent = onAirPhotoId\(data\.library\) \? HINT_ON_AIR : HINT_DEMO;/);
  const css = readPublic('app.css');
  assert.match(css, /\.motion-btn:disabled \{[^}]*color: var\(--muted\);[^}]*cursor: default;/);
});
