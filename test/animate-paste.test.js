'use strict';

// Unit tests for pasting images into the character library (AnimateHelpers.pastedImages).

const assert = require('node:assert/strict');
const test = require('node:test');

const H = require('../public/animate.js');

const NOW = Date.parse('2026-09-30T06:10:05Z');
const file = (name, type, size = 10) => ({ name, type, size });
const item = (f) => ({ kind: 'file', getAsFile: () => f });

test('a copied screenshot gets a stamped png name', () => {
  const shot = file('image.png', 'image/png');
  const out = H.pastedImages({ files: [shot], items: [item(shot)] }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, shot);
  assert.equal(out[0].name, 'pasted-20260930T061005.png');
});

test('a file copied from Finder/Explorer keeps its own name', () => {
  const photo = file('hero.jpg', 'image/jpeg');
  assert.deepEqual(H.pastedImages({ files: [photo], items: [] }, NOW).map(p => p.name), ['hero.jpg']);
});

test('unnamed items get a type-matched extension and an index', () => {
  const a = file('', 'image/jpeg', 1);
  const b = file('', 'image/webp', 2);
  const out = H.pastedImages({ files: [], items: [item(a), item(b)] }, NOW);
  assert.deepEqual(out.map(p => p.name), ['pasted-20260930T061005.jpg', 'pasted-20260930T061005-2.webp']);
});

test('the same image surfacing twice as different objects counts once', () => {
  const out = H.pastedImages({ files: [file('image.png', 'image/png', 5)], items: [item(file('image.png', 'image/png', 5))] }, NOW);
  assert.equal(out.length, 1);
});

test('text, videos and unsupported images are ignored', () => {
  assert.deepEqual(H.pastedImages(null), []);
  assert.deepEqual(H.pastedImages({ files: [], items: [{ kind: 'string', getAsFile: () => null }] }), []);
  assert.deepEqual(H.pastedImages({ files: [file('clip.mp4', 'video/mp4'), file('a.gif', 'image/gif')], items: [] }), []);
});
