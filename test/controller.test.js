'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PRESET_MOTIONS, buildMotionItems, MOTION_BATCH_SIZE, motionRenderCount, isWebmFileName, motionItemIndex } = require('../public/app.js');

const motion = (id, name) => ({ id, name, kind: 'motion', mime: 'video/webm', url: `/api/media/${id}` });

test('empty library: demo button plus 9 unlinked presets in catalog order', () => {
  const items = buildMotionItems({ idle: null, motions: [] });
  assert.equal(items.length, 10);
  assert.deepEqual(items[0], { key: 'demo', label: '데모 동작', sub: '기본 아바타', triggerId: 'demo', linked: false });
  assert.deepEqual(items.slice(1).map(i => i.label), PRESET_MOTIONS.map(p => p.label));
  assert.deepEqual(PRESET_MOTIONS.map(p => p.key), [
    'hi', 'wink', 'cheek-heart', 'finger-heart', 'kpop-heart', 'clap-laugh', 'dont-know', 'wonyoung-turn', 'bad-challenge',
  ]);
  for (const item of items.slice(1)) {
    assert.equal(item.sub, '영상 없음 · 데모 재생');
    assert.equal(item.triggerId, 'demo');
  }
  assert.equal(buildMotionItems(null).length, 10);
});

test('presets link by trimmed, case-insensitive key or label; first match wins', () => {
  const items = buildMotionItems({
    motions: [
      motion('a', 'extra'),
      motion('b', '  WINK '),
      motion('c', 'wink'),
      motion('d', '볼하트'),
      motion('e', "I DON'T KNOW 포즈"),
    ],
  });
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(byKey['preset:wink'].triggerId, 'b');
  assert.equal(byKey['preset:wink'].sub, '영상');
  assert.equal(byKey['preset:cheek-heart'].triggerId, 'd');
  assert.equal(byKey['preset:dont-know'].triggerId, 'e');
  assert.equal(byKey['preset:hi'].triggerId, 'demo');
  // Unlinked library motions follow the presets in library order (duplicate 'wink' included).
  assert.deepEqual(items.slice(10).map(i => [i.label, i.triggerId, i.sub]), [
    ['extra', 'a', '영상'],
    ['wink', 'c', '영상'],
  ]);
});

test('motionRenderCount renders batches of 30 and never shrinks below what is shown', () => {
  assert.equal(MOTION_BATCH_SIZE, 30);
  // Initial render: one batch, capped by the total.
  assert.equal(motionRenderCount(0, 10), 10);
  assert.equal(motionRenderCount(0, 85), 30);
  // Sentinel intersections add one batch each until everything is shown.
  assert.equal(motionRenderCount(30, 85, { grow: true }), 60);
  assert.equal(motionRenderCount(60, 85, { grow: true }), 85);
  assert.equal(motionRenderCount(85, 85, { grow: true }), 85);
  // A library update keeps the already-rendered count (a new item stays unrendered until reached).
  assert.equal(motionRenderCount(60, 86), 60);
  assert.equal(motionRenderCount(85, 86), 85);
  assert.equal(motionRenderCount(85, 86, { grow: true }), 86);
  // A shrinking library caps at the new total.
  assert.equal(motionRenderCount(60, 40), 40);
  // Defensive inputs.
  assert.equal(motionRenderCount(Number.NaN, 5), 5);
  assert.equal(motionRenderCount(-3, 0), 0);
  assert.equal(motionRenderCount(0, 100, { batchSize: 7 }), 7);
});

test('isWebmFileName accepts only .webm names, case-insensitively', () => {
  assert.equal(isWebmFileName('wink.webm'), true);
  assert.equal(isWebmFileName('윙크.WEBM'), true);
  assert.equal(isWebmFileName('bad.png'), false);
  assert.equal(isWebmFileName('webm'), false);
  assert.equal(isWebmFileName('clip.webm.mov'), false);
  assert.equal(isWebmFileName(undefined), false);
});

test('motionItemIndex finds the linked preset or the motion button', () => {
  const items = buildMotionItems({ motions: [motion('a', 'extra'), motion('b', '윙크')] });
  assert.equal(items[motionItemIndex(items, 'b')].key, 'preset:wink');
  assert.equal(items[motionItemIndex(items, 'a')].key, 'motion:a');
  assert.equal(motionItemIndex(items, 'missing'), -1);
  assert.equal(motionItemIndex(items, 'demo'), -1);
});
