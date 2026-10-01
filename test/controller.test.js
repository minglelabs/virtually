'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const motions = require('../public/motions.js');
const { PRESET_MOTIONS, buildMotionItems, MOTION_BATCH_SIZE, motionRenderCount, presetLabel } = motions;
const H = require('../public/animate.js');

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

test('presetLabel maps preset keys to labels', () => {
  assert.equal(presetLabel('hi'), '인사 (Hi)');
  assert.equal(presetLabel('dont-know'), "I don't know 포즈");
  assert.equal(presetLabel('nope'), null);
  assert.equal(presetLabel(null), null);
});

test('motions.js is the single catalog source: app.js and animate.js do not redeclare it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['app.js', 'animate.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.doesNotMatch(src, /PRESET_MOTIONS\s*=/, file);
    assert.doesNotMatch(src, /label:\s*'인사 \(Hi\)'/, file);
  }
  for (const page of ['index.html', 'animate.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    const shared = html.indexOf('<script src="./motions.js"></script>');
    const own = html.indexOf(`<script src="./${page === 'index.html' ? 'app' : 'animate'}.js"></script>`);
    assert.ok(shared > 0 && own > shared, `${page} loads motions.js before its page script`);
  }
});

test('main page links to the animate page instead of uploading', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // app.js points it at /animate?photo=<on-air photo> while a photo is on air.
  assert.match(html, /<a href="\.\/animate" id="motionAddLink" class="motion-add-btn">/);
  assert.match(html, /\+ 동작 추가하러 가기/);
  assert.match(html, /AI로 만들기 · 완성된 영상 올리기/);
  assert.doesNotMatch(html, /type="file"|addMotionInput|uploadStatus/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /\/api\/upload/);
  assert.match(app, /motionAddLink\.setAttribute\('href', view \? animateHref : '\.\/animate'\)/);
});

test('page scripts never assign innerHTML/outerHTML or use insertAdjacentHTML', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['animate.js', 'app.js', 'motions.js', 'login.js', 'auth.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
  }
});

const route = (over = {}) => ({
  id: 'wavespeed/wan-2.2-animate-2',
  provider: 'wavespeed',
  providerLabel: 'WaveSpeed',
  family: 'wan-animate-2',
  familyLabel: 'Wan 2.2 Animate 2',
  label: 'Wan 2.2 Animate 2',
  options: [{ key: 'resolution', field: 'resolution', label: '해상도', values: ['480p', '720p'], default: '720p' }],
  limits: { videoMinSec: 3, videoMaxSec: 120 },
  pricing: { usdPerSecond: 0.08, byOption: { resolution: { '480p': 0.04, '720p': 0.08 } }, minSeconds: 3 },
  verified: true,
  available: true,
  unavailableCode: null,
  ...over,
});

test('estimateUsd mirrors the server: option rate, min seconds, null without pricing', () => {
  const r = route();
  assert.equal(H.estimateUsd(r, 5, { resolution: '720p' }), 0.4);
  assert.equal(H.estimateUsd(r, 5, { resolution: '480p' }), 0.2);
  assert.equal(H.estimateUsd(r, 1, { resolution: '720p' }), 0.24); // min 3 s billed
  assert.equal(H.estimateUsd(r, 5, H.effectiveOptions(r)), 0.4); // default 720p
  assert.equal(H.estimateUsd(route({ pricing: null }), 5), null);
  assert.equal(H.estimateUsd(r, null), null);
});

test('effectiveOptions keeps valid choices and falls back to defaults; free-form options are not selects', () => {
  const r = route({ options: [
    { key: 'resolution', values: ['480p', '720p'], default: '720p' },
    { key: 'delayMs', values: null, default: 0 },
  ] });
  assert.deepEqual(H.selectableOptions(r).map(o => o.key), ['resolution']);
  assert.deepEqual(H.effectiveOptions(r, { resolution: '480p' }), { resolution: '480p' });
  assert.deepEqual(H.effectiveOptions(r, { resolution: '1080p' }), { resolution: '720p' });
  assert.deepEqual(H.effectiveOptions(route({ options: [{ key: 'm', values: ['a', 'b'], default: 'zz' }] })), { m: 'a' });
});

test('routeState and groupRoutes', () => {
  assert.deepEqual(H.routeState(route(), 5), { selectable: true, needsKey: false, tooLong: false, tooShort: false });
  assert.deepEqual(H.routeState(route(), 200), { selectable: true, needsKey: false, tooLong: true, tooShort: false });
  assert.deepEqual(H.routeState(route({ available: false, unavailableCode: 'no_credentials' }), 5),
    { selectable: false, needsKey: true, tooLong: false, tooShort: false });
  assert.deepEqual(H.routeState(route({ available: false, unavailableCode: 'no_media_relay' }), 5),
    { selectable: false, needsKey: false, tooLong: false, tooShort: false });
  const groups = H.groupRoutes([
    route({ id: 'a', familyLabel: 'Wan' }),
    route({ id: 'b', familyLabel: 'Kling' }),
    route({ id: 'c', familyLabel: 'Wan' }),
  ]);
  assert.deepEqual(groups.map(g => [g.familyLabel, g.routes.map(r => r.id)]), [['Wan', ['a', 'c']], ['Kling', ['b']]]);
  // Free only by the server's verdict (route view `free`), never by the provider.
  assert.equal(H.isFreeRoute({ id: 'mock/local-demo', provider: 'mock', free: true }), true);
  assert.equal(H.isFreeRoute({ id: 'mock/priced', provider: 'mock', free: false }), false);
  assert.equal(H.isFreeRoute({ provider: 'mock' }), false, 'a route without the flag is paid');
  assert.equal(H.isFreeRoute(null), false);
  assert.equal(H.isMockRoute, undefined);
});

test('routeMinSeconds and the length limits mirror the server tolerance', () => {
  const limited = (videoMinSec, videoMaxSec = 30) => ({ available: true, limits: { videoMinSec, videoMaxSec } });
  assert.equal(H.LENGTH_TOLERANCE_SEC, 0.05);
  assert.equal(H.routeMinSeconds(limited(3)), 3);
  assert.equal(H.routeMinSeconds(limited(null)), null);
  assert.equal(H.routeMinSeconds(limited(0)), null);
  assert.equal(H.routeMinSeconds(limited('x')), null);
  assert.equal(H.routeMinSeconds({}), null);
  assert.equal(H.routeMinSeconds(null), null);

  assert.equal(H.routeState(limited(3), 2.5).tooShort, true);
  assert.equal(H.routeState(limited(3), 2.94).tooShort, true);
  assert.equal(H.routeState(limited(3), 2.96).tooShort, false);
  assert.equal(H.routeState(limited(3), 3).tooShort, false);
  assert.equal(H.routeState(limited(null), 0.5).tooShort, false);
  assert.equal(H.routeState(limited(3), undefined).tooShort, false);
  assert.equal(H.routeState(limited(3), Number.NaN).tooShort, false);

  assert.equal(H.routeState(limited(3, 30), 30.03).tooLong, false);
  assert.equal(H.routeState(limited(3, 30), 30.06).tooLong, true);
});

test('errorText prefers known Korean codes, then the server message', () => {
  assert.equal(H.errorText({ error: 'x', code: 'character_missing' }), '캐릭터 이미지가 없습니다');
  assert.equal(H.errorText({ error: 'x', code: 'route_unavailable', detail: { unavailableCode: 'no_credentials' } }), 'API 키가 필요합니다');
  assert.equal(H.errorText({ error: 'Something broke', code: 'weird' }), 'Something broke');
  assert.equal(H.errorText({ code: 'weird', message: 'Provider said no' }), 'Provider said no');
  assert.equal(H.errorText(null), '알 수 없는 오류');
  assert.equal(H.errorText({ code: 'timeout', message: 'Generation timed out.' }), '시간 초과');
  assert.equal(H.errorText({ error: 'x', code: 'driving_too_short', detail: { minSec: 3, duration: 2.5 } }),
    '영상(2.5초)이 이 모델의 최소 길이(3초)보다 짧습니다');
  assert.equal(H.errorText({ error: 'x', code: 'driving_too_short' }), '영상이 모델 최소 길이보다 짧습니다');
  assert.equal(H.errorText({ error: 'x', code: 'driving_too_short', detail: { minSec: 3 } }), '영상이 모델 최소 길이보다 짧습니다');
  assert.equal(H.tooShortText(2.5, 3), '영상(2.5초)이 이 모델의 최소 길이(3초)보다 짧습니다');
});

test('job helpers: default name, newest-first upsert, added state, progress text', () => {
  assert.equal(H.defaultMotionName({ presetKey: 'hi', drivingLabel: 'hello' }), '인사 (Hi)');
  assert.equal(H.defaultMotionName({ presetKey: null, drivingLabel: 'my clip' }), 'my clip');

  let jobs = [];
  jobs = H.upsertJob(jobs, { id: 'a', createdAt: '2026-09-29T01:00:00Z', state: 'queued' });
  jobs = H.upsertJob(jobs, { id: 'b', createdAt: '2026-09-29T02:00:00Z', state: 'queued' });
  jobs = H.upsertJob(jobs, { id: 'a', createdAt: '2026-09-29T01:00:00Z', state: 'running' });
  assert.deepEqual(jobs.map(j => [j.id, j.state]), [['b', 'queued'], ['a', 'running']]);
  assert.equal(H.upsertJob(jobs, null), jobs);

  assert.equal(H.isAdded({ motionId: null }, new Set()), false);
  assert.equal(H.isAdded({ motionId: 'm1' }, null), true);
  assert.equal(H.isAdded({ motionId: 'm1' }, new Set(['m1'])), true);
  assert.equal(H.isAdded({ motionId: 'm1' }, new Set(['m2'])), false); // deleted from the library

  assert.equal(H.progressText({ providerStatus: 'IN_PROGRESS', progress: 0.42 }), 'IN_PROGRESS · 42%');
  assert.equal(H.progressText({ providerStatus: null, progress: null }), '');
  assert.deepEqual(Object.keys(H.JOB_STATE_LABELS),
    ['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying', 'succeeded', 'failed', 'canceled']);
  assert.equal(H.JOB_STATE_LABELS.keying, '배경 지우는 중');
  assert.ok(H.ACTIVE_STATES.has('keying'));
  assert.equal(H.keyNote({ result: { keyedUrl: '/k', keySkipped: null, keyFailed: false } }), '');
  assert.equal(H.keyNote({ result: { keyedUrl: null, keySkipped: 'not_uniform', keyFailed: false } }), '배경이 한 가지 색이 아니라서 원본 영상을 그대로 씁니다');
  assert.equal(H.keyNote({ result: { keyedUrl: null, keySkipped: null, keyFailed: true } }), '배경을 지우지 못해 원본 영상을 그대로 씁니다');
  assert.equal(H.keyNote({ result: { keyedUrl: null, keySkipped: null, keyFailed: false } }), '');
  assert.equal(H.keyNote({ result: null }), '');
});

test('formatting helpers', () => {
  assert.equal(H.formatSeconds(5), '5초');
  assert.equal(H.formatSeconds(2.5), '2.5초');
  assert.equal(H.formatSeconds(3), '3초');
  assert.equal(H.formatSeconds(3.04), '3초');
  assert.equal(H.formatSeconds(3.6), '3.6초');
  assert.equal(H.formatSeconds(4.6), '4.6초');
  assert.equal(H.formatSeconds(9.96), '10초');
  assert.equal(H.formatSeconds(10), '10초');
  assert.equal(H.formatSeconds(12.4), '12초');
  assert.equal(H.formatSeconds(null), '');
  assert.equal(H.formatSeconds(0), '');
  assert.equal(H.formatSeconds(-1), '');
  assert.equal(H.formatSeconds(Number.POSITIVE_INFINITY), '');
  const now = new Date(2026, 8, 29, 16, 0).getTime();
  assert.equal(H.formatTime(new Date(2026, 8, 29, 9, 5).toISOString(), now), '09:05');
  assert.equal(H.formatTime(new Date(2026, 8, 28, 9, 5).getTime(), now), '9/28 09:05');
  assert.equal(H.formatTime('nope', now), '');
  assert.equal(H.videoContentType('a.MOV', ''), 'video/quicktime');
  assert.equal(H.videoContentType('a.mp4', 'video/mp4'), 'video/mp4');
  assert.equal(H.videoContentType('a.webm', ''), 'video/webm');
  assert.equal(H.videoContentType('a.bin', ''), 'application/octet-stream');
});

test('drivingRenderCount renders batches of 12 and never shrinks below what is shown', () => {
  assert.equal(H.DRIVING_BATCH_SIZE, 12);
  assert.equal(H.drivingRenderCount(0, 5), 5);
  assert.equal(H.drivingRenderCount(0, 32), 12);
  assert.equal(H.drivingRenderCount(12, 32, { grow: true }), 24);
  assert.equal(H.drivingRenderCount(24, 32, { grow: true }), 32);
  assert.equal(H.drivingRenderCount(32, 32, { grow: true }), 32);
  // A live refresh keeps what is shown; one more item stays unrendered until reached.
  assert.equal(H.drivingRenderCount(24, 33), 24);
  assert.equal(H.drivingRenderCount(32, 33), 32);
  assert.equal(H.drivingRenderCount(24, 20), 20);
  assert.equal(H.drivingRenderCount(Number.NaN, 3), 3);
});

test('fileKind accepts PNG/JPEG/WebP images and MP4/MOV/WebM videos only', () => {
  assert.equal(H.fileKind('a.png', 'image/png'), 'image');
  assert.equal(H.fileKind('a.jpg', 'image/jpeg'), 'image');
  assert.equal(H.fileKind('a.webp', 'image/webp'), 'image');
  assert.equal(H.fileKind('a.gif', 'image/gif'), null);
  assert.equal(H.fileKind('A.JPEG', ''), 'image');
  assert.equal(H.fileKind('clip.mp4', 'video/mp4'), 'video');
  assert.equal(H.fileKind('clip.mov', 'video/quicktime'), 'video');
  assert.equal(H.fileKind('clip.webm', ''), 'video');
  assert.equal(H.fileKind('clip.avi', 'video/x-msvideo'), null);
  assert.equal(H.fileKind('notes.txt', 'text/plain'), null);
  assert.equal(H.fileKind('noext', ''), null);
  // A typed file is judged by its type, not a misleading name.
  assert.equal(H.fileKind('fake.png', 'text/plain'), null);
});

test('stripWheelDelta maps vertical wheels to horizontal scroll until either end', () => {
  const strip = (scrollLeft, scrollWidth = 1000, clientWidth = 400) => ({ scrollLeft, scrollWidth, clientWidth });
  assert.equal(H.stripWheelDelta({ deltaY: 100 }, strip(0)), 100);
  assert.equal(H.stripWheelDelta({ deltaY: -100 }, strip(300)), -100);
  assert.equal(H.stripWheelDelta({ deltaY: 3, deltaMode: 1 }, strip(0)), 48);
  // At the ends the page scrolls instead.
  assert.equal(H.stripWheelDelta({ deltaY: 100 }, strip(600)), 0);
  assert.equal(H.stripWheelDelta({ deltaY: -100 }, strip(0)), 0);
  assert.equal(H.stripWheelDelta({ deltaY: -100 }, strip(1)), 0);
  assert.equal(H.stripWheelDelta({ deltaY: 100 }, strip(599.5)), 0);
  // Nothing to scroll, horizontal gestures and pinch zoom are left alone.
  assert.equal(H.stripWheelDelta({ deltaY: 100 }, strip(0, 400, 400)), 0);
  assert.equal(H.stripWheelDelta({ deltaY: 10, deltaX: 40 }, strip(0)), 0);
  assert.equal(H.stripWheelDelta({ deltaY: 100, ctrlKey: true }, strip(0)), 0);
});

test('animate page: drop zones (per-character 사진 추가, driving videos, finished videos)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'animate.html'), 'utf8');
  assert.doesNotMatch(html, /이미지 올리기<\/button>|characterUploadBtn|id="characterDrop"/);
  // Every character row clones this lead tile; the chosen row's says paste works too (animate.js).
  assert.match(html, /<template id="photoDropTemplate">\s*<button type="button" class="dropzone dropzone-image dropzone-photo">/);
  assert.match(html, /<span class="dropzone-title">\+ 사진 추가<\/span>/);
  assert.match(html, /<div class="strip-lead">\s*<button type="button" id="drivingDrop" class="dropzone/);
  assert.match(html, /id="drivingSentinel"/);
  assert.match(html, /<button type="button" id="motionDrop" class="dropzone dropzone-video"/);
  assert.match(html, /클릭해서 고르기 · WebM · MP4 · MOV · 60초 · 500MB까지/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'animate.js'), 'utf8');
  assert.match(js, /rootMargin: '0px 300px 0px 0px'/);
  assert.match(js, /이미지 파일만 올릴 수 있습니다/);
  assert.match(js, /영상 파일만 올릴 수 있습니다/);
  assert.match(js, /'클릭 · 끌어다 놓기 · 붙여넣기\(⌘V \/ Ctrl\+V\)' : '클릭 · 끌어다 놓기'/);
  assert.match(js, /acceptDrops\(node, drop, files => addPhotos\(characterId, files\)\)/);
  assert.match(js, /acceptDrops\(motionUploadCard, motionDrop, chooseMotionFile\)/);
});

test('controller previews a true-scale canvas at the reported OBS source size', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // Both pane titles are h2 with one shared class, and each section is labelled by its h2.
  // The brand row also holds the signed-in chip slot (auth.js fills it when login is on).
  assert.match(html, /<section class="pane pane-control" aria-labelledby="controlTitle">\s*<div class="brand-row">\s*<h1 class="brand"><a href="\/" class="brand-link">Virtually<\/a><\/h1>\s*<div id="authSlot" class="auth-slot" hidden><\/div>\s*<\/div>\s*<h2 id="controlTitle" class="pane-title">컨트롤러<\/h2>/);
  assert.match(html, /<section class="pane pane-preview" aria-labelledby="previewTitle">/);
  assert.match(html, /<div class="pane-title-row">\s*<h2 id="previewTitle" class="pane-title">캔버스<\/h2>\s*<button type="button" id="refreshOverlayBtn"/);
  assert.equal((html.match(/<h2 [^>]*class="pane-title"/g) || []).length, 2);
  assert.doesNotMatch(html, /class="subtitle"/);
  assert.match(html, /<p class="caption" id="canvasCaption">800 × 600 \(OBS 연결 전\) · 체크무늬 부분은 투명하게 송출됩니다\.<\/p>/);
  assert.match(html,
    /<div class="stage">\s*<div class="canvas" id="canvasBox">\s*<iframe id="overlayPreviewFrame" src="\.\/overlay" title="OBS 캔버스 미리보기"><\/iframe>\s*<\/div>\s*<\/div>/);
  // OBS guide: the source matches the OBS canvas instead of a fixed 1920 x 1080.
  assert.match(html, /<dt>너비 \/ 높이<\/dt><dd><strong>OBS 캔버스와 같게<\/strong> <span class="note">\(설정 → 비디오 → 기본 \(캔버스\) 해상도\)<\/span><\/dd>/);
  assert.match(html, /<li>소스 우클릭 → '변환' → '화면에 맞추기'<\/li>/);
  assert.doesNotMatch(html, /1920 \/ 1080|캔버스가 1920/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const title = css.match(/\.pane-title \{([^}]*)\}/);
  assert.ok(title, 'app.css has a .pane-title rule');
  assert.match(title[1], /font-size:\s*18px;/);
  assert.match(title[1], /font-weight:\s*700;/);
  assert.match(title[1], /color:\s*var\(--text\);/);
  // One brand-row height drives the left brand row and the right pane's top spacing.
  assert.match(css, /--brand-row-h:\s*\d+px;/);
  assert.match(css, /\.brand-row \{[^}]*height:\s*var\(--brand-row-h\);/);
  assert.match(css, /\.pane-preview \{[^}]*padding-top:\s*calc\(var\(--pane-pad\) \+ var\(--brand-row-h\) \+ var\(--pane-gap\)\);/);

  const box = css.match(/\.canvas \{([^}]*)\}/);
  assert.ok(box, 'app.css has a .canvas rule');
  // Until OBS reports a size, the canvas uses the OBS browser-source default (800 x 600),
  // and the CSS, the script and the initial caption agree on it.
  assert.match(box[1], /--canvas-w:\s*800px;/);
  assert.match(box[1], /--canvas-h:\s*600px;/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'),
    /const DEFAULT_CANVAS = \{ width: 800, height: 600 \};/);
  assert.match(box[1], /width:\s*calc\(var\(--canvas-w\) \* var\(--canvas-scale\)\);/);
  assert.match(box[1], /height:\s*calc\(var\(--canvas-h\) \* var\(--canvas-scale\)\);/);
  const rule = css.match(/\.stage iframe \{([^}]*)\}/);
  assert.ok(rule, 'app.css has a .stage iframe rule');
  assert.match(rule[1], /width:\s*var\(--canvas-w\);/);
  assert.match(rule[1], /height:\s*var\(--canvas-h\);/);
  assert.match(rule[1], /transform-origin:\s*0 0;/);
  assert.match(rule[1], /transform:\s*scale\(var\(--canvas-scale\)\);/);
  assert.match(rule[1], /color-scheme:\s*normal;/);
  assert.doesNotMatch(css, /1920px \*|1080px \*/);

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /data\?\.type === 'obs-source'/);
  assert.match(app, /setProperty\('--canvas-w'/);
  assert.match(app, /setProperty\('--canvas-h'/);
  assert.match(app, /OBS 소스 \$\{canvasSize\.width\} × \$\{canvasSize\.height\}/);

  // Only the overlay running inside OBS reports its size.
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlay.js'), 'utf8');
  assert.match(overlay, /typeof window\.obsstudio === 'object'/);
  assert.match(overlay, /if \(!IS_OBS_SOURCE\) return;/);
});
