'use strict';

// 방송 화면 (/broadcast = public/index.html + app.js): the on-air character strip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const B = require('../public/app.js');

const readPublic = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('animateHref names the photo', () => {
  assert.equal(B.animateHref('ph-1'), '/animate?photo=ph-1');
  assert.equal(B.animateHref('ch-a b'), '/animate?photo=ch-a%20b');
  assert.equal(B.animateHref(null), '/animate');
  assert.equal(B.animateHref(''), '/animate');
});

test('onAirView: nothing on air, the photo idle, an uploaded video idle', () => {
  assert.equal(B.onAirView({ idle: null, motions: [], character: null, photo: null }), null);
  assert.equal(B.onAirView(null), null);
  assert.equal(B.onAirView({ character: { id: 'c-1', name: 'x' }, photo: null }), null);

  const photo = { id: 'ph-1', url: '/api/media/ph-1', width: 800, height: 1200, hasAlpha: false };
  // The cut-out photo idle: the thumbnail is what OBS shows.
  const cut = { idle: { id: 'ph-1', kind: 'idle', mime: 'image/png', url: '/api/media/ph-1?variant=cutout' }, motions: [], character: { id: 'c-1', name: '레몬' }, photo };
  assert.deepEqual(B.onAirView(cut), {
    name: '레몬', photoId: 'ph-1', thumbUrl: '/api/media/ph-1?variant=cutout', thumbIsVideo: false, animateHref: '/animate?photo=ph-1',
  });
  const video = { ...cut, idle: { id: '0f0e0d0c-0b0a-4900-8800-706050403020', kind: 'idle', mime: 'video/webm', url: '/api/media/0f0e0d0c-0b0a-4900-8800-706050403020' } };
  assert.equal(B.onAirView(video).thumbIsVideo, true);
  // Without an idle url the photo file is the thumbnail.
  assert.equal(B.onAirView({ ...cut, idle: null }).thumbUrl, '/api/media/ph-1');
});

test('broadcast page wiring: the on-air strip and its links', () => {
  const html = readPublic('index.html');
  assert.match(html, /<title>방송 화면 · Virtually<\/title>/);
  // Right under the 컨트롤러 title, hidden until the first library message.
  assert.match(html, /<h2 id="controlTitle" class="pane-title">컨트롤러<\/h2>\s*(<!--[^>]*-->\s*)?<section id="onAirCard" class="card on-air" aria-labelledby="onAirName" hidden>/);
  assert.match(html, /<span id="onAirThumb" class="on-air-thumb checkerboard" hidden><\/span>/);
  assert.match(html, /<strong id="onAirName" class="on-air-name">방송할 캐릭터를 골라 주세요<\/strong>/);
  assert.match(html, /<a href="\/" id="onAirChange" class="btn btn-ghost btn-sm">캐릭터 고르기<\/a>/);
  assert.match(html, /<a href="\/animate" id="onAirAnimate" class="btn btn-sm" hidden>동작 관리<\/a>/);

  const app = readPublic('app.js');
  assert.match(app, /renderOnAir\(data\.library\);/);
  assert.match(app, /onAirChange\.textContent = view \? '캐릭터 바꾸기' : '캐릭터 고르기';/);
  assert.match(app, /onAirName\.textContent = view \? view\.name : '방송할 캐릭터를 골라 주세요';/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/);

  // app.css has no global [hidden] rule, so the strip's own display rules must yield to it.
  const css = readPublic('app.css');
  assert.match(css, /\.on-air\[hidden\], \.on-air \[hidden\] \{ display: none; \}/);
  assert.match(css, /a\.btn \{[^}]*text-decoration: none;/);
});
