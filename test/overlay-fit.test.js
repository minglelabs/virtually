'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../public/overlay.js');

// The user's keyed motion 원영턴 (800x1136 VP9 WebM with alpha), measured by the server.
const WONYOUNG_FIT = Object.freeze({
  v: 1,
  width: 800,
  height: 1136,
  first: [0.1138, 0.0731, 0.9625, 0.9472],
  union: [0, 0, 1, 1],
  touches: { left: true, right: true, top: true, bottom: true },
});

const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} not within ${tol} of ${expected}`);

/** The first-frame character box of a placed motion, in overlay px. */
function characterBox(place, fit) {
  const b = fit.first;
  return [
    place.left + b[0] * place.width,
    place.top + b[1] * place.height,
    place.left + b[2] * place.width,
    place.top + b[3] * place.height,
  ];
}

test('demo idle box on 800x600 matches the measured avatar rect', () => {
  const canvas = { width: 800, height: 600 };
  assert.deepEqual(F.demoRect(canvas), { left: 210, top: 148, width: 380, height: 440 });
  const box = F.idleBox(canvas, null);
  near(box[0], 307.3, 0.1, 'x0');
  near(box[1], 195.7, 0.1, 'y0');
  near(box[2], 538.3, 0.1, 'x1');
  near(box[3], 548.0, 0.1, 'y1');
  // A DOM rect gives the same box; an SVG rect wider than its content is xMidYMid meet.
  assert.deepEqual(F.idleBox(canvas, null, { avatarRect: { left: 210, top: 148, width: 380, height: 440 } }), box);
  const wide = F.idleBox(canvas, null, { avatarRect: { left: 110, top: 148, width: 580, height: 440 } });
  near(wide[0], box[0], 1e-9, 'meet x0');
  near(wide[3], box[3], 1e-9, 'meet y1');
});

test('demo idle box follows the 85vw / 75vh caps', () => {
  const box = F.idleBox({ width: 400, height: 400 }, null);
  // 340 x 300 rect -> s = min(340/380, 300/440) = 0.6818, content 259.1 x 300 centred.
  const s = 300 / 440;
  near(box[3] - box[1], (0.9091 - 0.1083) * 440 * s, 1e-6, 'height');
  near((box[0] + box[2]) / 2, 30 + 170 + ((0.2561 + 0.8640) / 2 - 0.5) * 380 * s, 1e-6, 'centre');
});

test('idle media box: never upscaled, centred, bottom-aligned, fit.first applied', () => {
  const canvas = { width: 800, height: 600 };
  const idle = { url: '/media/idle.webm', kind: 'video', fit: { v: 1, width: 400, height: 500, first: [0.25, 0.1, 0.75, 1] } };
  assert.deepEqual(F.idleBox(canvas, idle), [300, 150, 500, 600]);
  // Larger than the canvas: scaled down to the canvas height.
  assert.deepEqual(F.idleBox(canvas, { url: '/a.png' }, { natural: { width: 1200, height: 1200 } }), [100, 0, 700, 600]);
  // No natural size and no fit: unknown.
  assert.equal(F.idleBox(canvas, { url: '/a.png' }), null);
});

test('원영턴 on 800x600 with the demo idle: full mode, idle height, frame bottom on the canvas bottom', () => {
  const canvas = { width: 800, height: 600 };
  const idle = F.idleBox(canvas, null);
  const place = F.placeMotion(canvas, idle, WONYOUNG_FIT);
  assert.equal(place.mode, 'full');
  const box = characterBox(place, WONYOUNG_FIT);
  near(box[3] - box[1], 352.3, 0.5, 'character height');
  near(box[3] - box[1], idle[3] - idle[1], 1e-6, 'same height as idle');
  assert.equal(place.top + place.height, 600);
  near((box[0] + box[2]) / 2, (idle[0] + idle[2]) / 2, 1e-6, 'centred on the idle');
  near(place.width / place.height, 800 / 1136, 1e-9, 'aspect');
});

test('원영턴 on 1600x1080 keeps the idle size and centre', () => {
  const canvas = { width: 1600, height: 1080 };
  const idle = F.idleBox(canvas, null);
  const place = F.placeMotion(canvas, idle, WONYOUNG_FIT);
  assert.equal(place.mode, 'full');
  const box = characterBox(place, WONYOUNG_FIT);
  near(box[3] - box[1], idle[3] - idle[1], 1e-6, 'height');
  near(box[3] - box[1], 352.4, 0.5, 'character height');
  near((box[0] + box[2]) / 2, 800 + ((0.2561 + 0.8640) / 2 - 0.5) * 380, 1e-6, 'centre');
  assert.equal(place.top + place.height, 1080);
});

test('full mode without touches.bottom puts the first-frame feet on the idle feet', () => {
  const canvas = { width: 800, height: 600 };
  const idle = F.idleBox(canvas, null);
  const fit = { ...WONYOUNG_FIT, touches: { left: false, right: false, top: false, bottom: false } };
  const place = F.placeMotion(canvas, idle, fit);
  const box = characterBox(place, fit);
  near(box[3], idle[3], 1e-6, 'feet');
  near(box[1], idle[1], 1e-6, 'head');
});

test('first[3] >= 0.99 is cut mode: head at the idle head, frame bottom on the canvas bottom', () => {
  const canvas = { width: 800, height: 600 };
  const idle = F.idleBox(canvas, null);
  const fit = { ...WONYOUNG_FIT, first: [0.2, 0.1, 0.8, 1.0] };
  const place = F.placeMotion(canvas, idle, fit);
  assert.equal(place.mode, 'cut');
  const box = characterBox(place, fit);
  near(box[1], idle[1], 1e-6, 'head');
  near(place.top + place.height, 600, 1e-9, 'bottom');
  assert.equal(F.placeMotion(canvas, idle, { ...fit, first: [0.2, 0.1, 0.8, 0.99] }).mode, 'cut');
});

test('placeMotion returns null for a missing or broken fit or idle box', () => {
  const canvas = { width: 800, height: 600 };
  const idle = F.idleBox(canvas, null);
  assert.equal(F.placeMotion(canvas, idle, null), null);
  assert.equal(F.placeMotion(canvas, idle, undefined), null);
  assert.equal(F.placeMotion(canvas, idle, { ...WONYOUNG_FIT, first: [0.5, 0.5, 0.5, 0.9] }), null);
  assert.equal(F.placeMotion(canvas, idle, { ...WONYOUNG_FIT, first: [0.1, NaN, 0.9, 0.9] }), null);
  assert.equal(F.placeMotion(canvas, idle, { ...WONYOUNG_FIT, width: 0 }), null);
  assert.equal(F.placeMotion(canvas, idle, { ...WONYOUNG_FIT, height: '1136' }), null);
  assert.equal(F.placeMotion(canvas, null, WONYOUNG_FIT), null);
  assert.equal(F.placeMotion(canvas, [10, 10, 10, 20], WONYOUNG_FIT), null);
  assert.equal(F.placeMotion({ width: 0, height: 600 }, idle, WONYOUNG_FIT), null);
});

test('overlay.js keeps DOM code behind a document guard and the reaction layer clips', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlay.js'), 'utf8');
  assert.match(js, /if \(typeof document !== 'undefined'\) \(\(\) => \{/);
  assert.match(js, /OverlayFit\.placeMotion\(/);
  assert.match(js, /addEventListener\('resize'/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlay.css'), 'utf8');
  assert.match(css, /\.reaction-layer\s*\{\s*overflow: hidden;/);
});
