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
  assert.match(html, /<a href="\.\/animate" class="motion-add-btn">/);
  assert.match(html, /\+ 동작 추가하러 가기/);
  assert.match(html, /예시 영상 \+ 캐릭터로 AI 동작 만들기/);
  assert.doesNotMatch(html, /type="file"|addMotionInput|uploadStatus/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /\/api\/upload/);
});

test('animate page never assigns innerHTML/outerHTML or uses insertAdjacentHTML', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['animate.js', 'app.js', 'motions.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
  }
});

const route = (over = {}) => ({
  id: 'wavespeed/wan-2.2-animate',
  provider: 'wavespeed',
  providerLabel: 'WaveSpeed',
  family: 'wan-animate',
  familyLabel: 'Wan 2.2 Animate',
  label: 'Wan 2.2 Animate',
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
  assert.equal(H.formatUsd(0.4), '약 $0.40');
  assert.equal(H.formatUsd(null), '');
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
  assert.deepEqual(H.routeState(route(), 5), { selectable: true, needsKey: false, tooLong: false });
  assert.deepEqual(H.routeState(route(), 200), { selectable: true, needsKey: false, tooLong: true });
  assert.deepEqual(H.routeState(route({ available: false, unavailableCode: 'no_credentials' }), 5),
    { selectable: false, needsKey: true, tooLong: false });
  assert.deepEqual(H.routeState(route({ available: false, unavailableCode: 'no_media_relay' }), 5),
    { selectable: false, needsKey: false, tooLong: false });
  const groups = H.groupRoutes([
    route({ id: 'a', familyLabel: 'Wan' }),
    route({ id: 'b', familyLabel: 'Kling' }),
    route({ id: 'c', familyLabel: 'Wan' }),
  ]);
  assert.deepEqual(groups.map(g => [g.familyLabel, g.routes.map(r => r.id)]), [['Wan', ['a', 'c']], ['Kling', ['b']]]);
  assert.equal(H.isMockRoute({ provider: 'mock' }), true);
});

test('errorText prefers known Korean codes, then the server message', () => {
  assert.equal(H.errorText({ error: 'x', code: 'character_missing' }), '캐릭터 이미지가 없습니다');
  assert.equal(H.errorText({ error: 'x', code: 'route_unavailable', detail: { unavailableCode: 'no_credentials' } }), 'API 키가 필요합니다');
  assert.equal(H.errorText({ error: 'Something broke', code: 'weird' }), 'Something broke');
  assert.equal(H.errorText({ code: 'weird', message: 'Provider said no' }), 'Provider said no');
  assert.equal(H.errorText(null), '알 수 없는 오류');
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
    ['queued', 'preparing', 'submitting', 'running', 'downloading', 'succeeded', 'failed', 'canceled']);
});

test('formatting helpers', () => {
  assert.equal(H.formatSeconds(5), '5초');
  assert.equal(H.formatSeconds(4.6), '5초');
  assert.equal(H.formatSeconds(null), '');
  const now = new Date(2026, 8, 29, 16, 0).getTime();
  assert.equal(H.formatTime(new Date(2026, 8, 29, 9, 5).toISOString(), now), '09:05');
  assert.equal(H.formatTime(new Date(2026, 8, 28, 9, 5).getTime(), now), '9/28 09:05');
  assert.equal(H.formatTime('nope', now), '');
  assert.equal(H.videoContentType('a.MOV', ''), 'video/quicktime');
  assert.equal(H.videoContentType('a.mp4', 'video/mp4'), 'video/mp4');
  assert.equal(H.videoContentType('a.webm', ''), 'video/webm');
  assert.equal(H.videoContentType('a.bin', ''), 'application/octet-stream');
});
