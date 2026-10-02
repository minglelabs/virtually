'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../public/animate.js');

const MARGINS = [
  { value: 'none', label: '없음' },
  { value: 'normal', label: '보통' },
  { value: 'wide', label: '넓게' },
];

test('marginOptions reads the payload margins and hides the select when absent', () => {
  assert.deepEqual(H.marginOptions({ routes: [], margins: MARGINS }), MARGINS);
  assert.deepEqual(H.marginOptions({ routes: [] }), []);
  assert.deepEqual(H.marginOptions({ margins: [null, { value: 'x' }, { value: 'wide', label: '넓게' }] }), [MARGINS[2]]);
});

test('routeDefaultMargin uses the route default, else none', () => {
  assert.equal(H.routeDefaultMargin({ defaultMargin: 'normal' }, MARGINS), 'normal');
  assert.equal(H.routeDefaultMargin({ defaultMargin: 'none' }, MARGINS), 'none');
  assert.equal(H.routeDefaultMargin({}, MARGINS), 'none');
  assert.equal(H.routeDefaultMargin({ defaultMargin: 'huge' }, MARGINS), 'none');
  assert.equal(H.routeDefaultMargin(null, []), null);
});

test('marginText labels non-none margins from the payload', () => {
  assert.equal(H.marginText({ margin: 'normal' }, MARGINS), '여백 보통');
  assert.equal(H.marginText({ margin: 'wide' }, MARGINS), '여백 넓게');
  assert.equal(H.marginText({ margin: 'none' }, MARGINS), '');
  assert.equal(H.marginText({}, MARGINS), '');
  assert.equal(H.marginText({ margin: 'normal' }, []), '');
});

test('fitNote: edge touches first, then a cut bottom, else nothing', () => {
  const touching = { result: { fit: { first: [0.1, 0.07, 0.96, 0.95], touches: { left: true, right: false, top: false, bottom: true } } } };
  assert.equal(H.fitNote(touching), '캐릭터가 영상 밖으로 나가 잘린 선이 보일 수 있습니다. 여백을 넓혀 다시 만들어 보세요.');
  const top = { result: { fit: { first: [0.1, 0, 0.9, 1], touches: { top: true } } } };
  assert.match(H.fitNote(top), /여백을 넓혀/);
  const cut = { result: { fit: { first: [0.1, 0.1, 0.9, 0.995], touches: { left: false, right: false, top: false, bottom: true } } } };
  assert.equal(H.fitNote(cut), '영상 아래쪽이 잘려 있어 대기 캐릭터와 크기가 조금 다를 수 있습니다.');
  const clean = { result: { fit: { first: [0.1, 0.1, 0.9, 0.9], touches: { left: false, right: false, top: false, bottom: false } } } };
  assert.equal(H.fitNote(clean), '');
  assert.equal(H.fitNote({ result: { fit: null } }), '');
  assert.equal(H.fitNote({ result: {} }), '');
  assert.equal(H.fitNote(null), '');
});

test('jobPayload sends the photo, and margin only when the server offers it', () => {
  const route = { id: 'wavespeed/wan-2.2-animate-2' };
  const demo = { id: 'mock/local-demo', provider: 'mock', free: true };
  assert.deepEqual(
    H.jobPayload({ drivingId: 'd1', photoId: 'ph-1', route, options: { resolution: '480p' }, margin: 'wide', margins: MARGINS }),
    { drivingId: 'd1', photoId: 'ph-1', routeId: route.id, options: { resolution: '480p' }, margin: 'wide', confirmed: true },
  );
  assert.deepEqual(
    H.jobPayload({ drivingId: 'd1', photoId: 'ph-1', route: demo, options: {}, margin: 'none', margins: MARGINS }),
    { drivingId: 'd1', photoId: 'ph-1', routeId: demo.id, options: {}, margin: 'none' },
  );
  assert.deepEqual(
    H.jobPayload({ drivingId: 'd1', photoId: 'ch-2', route: demo, options: {}, margin: null, margins: [] }),
    { drivingId: 'd1', photoId: 'ch-2', routeId: demo.id, options: {} },
  );
});

test('animate page has the 여백 select and hint, labels come from the payload', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'animate.html'), 'utf8');
  assert.match(html, /<div id="marginBox" class="route-margin" hidden>/);
  assert.match(html, /<label for="marginSelect">여백<\/label>/);
  assert.match(html, /<select id="marginSelect"/);
  assert.match(html, /캐릭터가 화면 밖으로 나가 잘리지 않게 동작 영상과 사진 둘레\(아래 제외\)에 여백을 붙입니다\. 사진은 동작 영상과 같은 비율로 맞춰 보냅니다\. 넓을수록 캐릭터가 작게 만들어집니다\./);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'animate.js'), 'utf8');
  // No hardcoded margin labels: only the payload's `margins` names them.
  assert.doesNotMatch(js, /'보통'|'넓게'|label: '없음'/);
});
