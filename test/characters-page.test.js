'use strict';

// Character list (/ = public/characters.html + characters.js): the DOM-free
// helpers, their parity with the server and the other pages, and the static wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../public/characters.js');
const Animate = require('../public/animate.js');
const Broadcast = require('../public/app.js');
const server = require('../lib/characters');

const readPublic = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

const photo = (id, over = {}) => ({
  id, url: `/api/media/${id}`, displayUrl: `/api/media/${id}`, cutout: false, width: 400, height: 600, hasAlpha: true,
  createdAt: '2026-09-30T00:00:00.000Z', isBase: false, onAir: false, idle: 'photo', motionCount: 0, motions: [], ...over,
});
const character = (id, name, photos, over = {}) => ({
  id, name, createdAt: '2026-09-30T00:00:00.000Z', basePhotoId: photos.find(p => p.isBase)?.id ?? photos[0]?.id ?? null,
  onAir: photos.some(p => p.onAir), photos, ...over,
});
const motion = name => ({ id: `m-${name}`, name, mime: 'video/webm', createdAt: '2026-09-30T00:00:00.000Z' });

test('the texts and limits the page mirrors are the server\'s own', () => {
  const message = code => server.characterError(code).message;
  assert.equal(C.TEXT.unsupportedImage, message('unsupported_image'));
  assert.equal(C.TEXT.tooLarge, message('too_large'));
  assert.equal(C.TEXT.lastPhoto, message('last_photo'));
  assert.equal(C.TEXT.nameMissing, message('name_missing'));
  assert.equal(C.PHOTO_MAX_BYTES, server.PHOTO_MAX_BYTES);
  assert.equal(C.NAME_MAX, server.NAME_MAX);
});

test('isImageFile / photoFileProblem: PNG, JPEG, WebP up to 20 MB, like the 동작 만들기 page', () => {
  const cases = [
    ['a.png', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.webp', 'image/webp'], ['A.JPEG', ''], ['a.gif', 'image/gif'],
    ['a.png', 'text/plain'], ['clip.mp4', 'video/mp4'], ['noext', ''], ['x.WEBP', ''], ['', 'image/png'],
  ];
  for (const [name, type] of cases) {
    assert.equal(C.isImageFile({ name, type }), Animate.fileKind(name, type) === 'image', `${name} ${type}`);
  }
  assert.equal(C.isImageFile(null), false);
  assert.equal(C.photoFileProblem({ name: 'a.png', type: 'image/png', size: 10 }), '');
  assert.equal(C.photoFileProblem({ name: 'a.png', type: 'image/png', size: C.PHOTO_MAX_BYTES }), '');
  assert.equal(C.photoFileProblem({ name: 'a.png', type: 'image/png', size: C.PHOTO_MAX_BYTES + 1 }), C.TEXT.tooLarge);
  assert.equal(C.photoFileProblem({ name: 'a.gif', type: 'image/gif', size: 10 }), C.TEXT.unsupportedImage);
  assert.equal(C.photoFileProblem(null), C.TEXT.unsupportedImage);
});

test('pastedImage: the first image, named like the 동작 만들기 page names pastes', () => {
  const NOW = Date.parse('2026-09-30T06:10:05Z');
  const file = (name, type, size = 10) => ({ name, type, size });
  const item = f => ({ kind: 'file', getAsFile: () => f });
  const shot = file('image.png', 'image/png');
  assert.deepEqual(C.pastedImage({ files: [shot], items: [item(shot)] }, NOW), { file: shot, name: 'pasted-20260930T061005.png' });
  const named = file('hero.jpg', 'image/jpeg');
  assert.deepEqual(C.pastedImage({ files: [named], items: [] }, NOW), { file: named, name: 'hero.jpg' });
  const unnamed = file('', 'image/webp');
  assert.equal(C.pastedImage({ files: [], items: [item(unnamed)] }, NOW).name, 'pasted-20260930T061005.webp');
  // The same names as AnimateHelpers.pastedImages for a one-image paste.
  for (const f of [shot, named, unnamed, file('x', 'image/jpeg')]) {
    const clipboard = { files: [f], items: [] };
    assert.equal(C.pastedImage(clipboard, NOW).name, Animate.pastedImages(clipboard, NOW)[0].name, f.name);
  }
  // Text, videos, unsupported images and null items are no image.
  assert.equal(C.pastedImage(null), null);
  assert.equal(C.pastedImage({ files: [], items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => null }] }), null);
  assert.equal(C.pastedImage({ files: [file('clip.mp4', 'video/mp4'), file('a.gif', 'image/gif')], items: [] }), null);
});

test('cleanName is the server\'s cleaning (checkName) for every name it accepts', () => {
  for (const raw of ['  민트  ', 'a\tb', 'x\u0085y', '고양이   후디', ' 초록\n후디 ', 'a'.repeat(40)]) {
    assert.equal(C.cleanName(raw), server.checkName(raw), JSON.stringify(raw));
  }
  for (const raw of ['', '   ', '\n\t', '\u0000']) {
    assert.equal(C.cleanName(raw), '');
    assert.throws(() => server.checkName(raw), { code: 'name_missing' });
  }
  assert.equal(C.cleanName(null), '');
});

test('createBlocker / canCreate: 만들기 needs a name and a base photo', () => {
  const file = { name: 'a.png' };
  assert.equal(C.createBlocker({ name: '', file: null }), '캐릭터 이름을 입력하고 기본 사진을 올려 주세요.');
  assert.equal(C.createBlocker({ name: '  ', file }), C.TEXT.nameMissing);
  assert.equal(C.createBlocker({ name: '민트', file: null }), '기본 사진을 올려 주세요.');
  assert.equal(C.createBlocker({ name: '민트', file }), '');
  assert.equal(C.createBlocker(), C.TEXT.bothMissing);
  assert.equal(C.canCreate({ name: '민트', file }), true);
  assert.equal(C.canCreate({ name: '민트', file, busy: true }), false);
  assert.equal(C.canCreate({ name: '', file }), false);
  assert.equal(C.canCreate({ name: '민트', file: null }), false);
});

test('links and API paths', () => {
  for (const id of ['ph-1', 'ch-a b', '', null, undefined]) {
    assert.equal(C.animateHref(id), Broadcast.animateHref(id), String(id));
  }
  assert.equal(C.animateHref('ph-1'), '/animate?photo=ph-1');
  assert.equal(C.animateHref(null), '/animate');
  // Names and file names survive the query string exactly (spaces, +, &, Korean).
  const created = new URL(C.createPath('고양이 후디 + A&B', 'my photo #1.png'), 'http://x');
  assert.equal(created.pathname, '/api/characters');
  assert.equal(created.searchParams.get('name'), '고양이 후디 + A&B');
  assert.equal(created.searchParams.get('filename'), 'my photo #1.png');
  const added = new URL(C.photosPath('c-1', 'a b.jpg'), 'http://x');
  assert.equal(added.pathname, '/api/characters/c-1/photos');
  assert.equal(added.searchParams.get('filename'), 'a b.jpg');
  assert.equal(C.characterPath('c-1'), '/api/characters/c-1');
  assert.equal(C.photoPath('c-1', 'ph-2'), '/api/characters/c-1/photos/ph-2');
  assert.equal(C.basePath('c-1'), '/api/characters/c-1/base');
  assert.equal(C.photoPath('c/1', 'ph?2'), '/api/characters/c%2F1/photos/ph%3F2');
});

test('a row selects its photo on air, else its base photo, else its first photo; a click wins while the photo exists', () => {
  const onAirSecond = character('c-1', '민트', [photo('ph-a', { isBase: true }), photo('ph-b', { onAir: true }), photo('ph-c')]);
  assert.equal(C.defaultPhotoId(onAirSecond), 'ph-b');
  const offAir = character('c-2', '레몬', [photo('ph-d'), photo('ph-e', { isBase: true })], { basePhotoId: 'ph-e' });
  assert.equal(C.defaultPhotoId(offAir), 'ph-e');
  // A basePhotoId that is not in the row falls back to the isBase flag, then to the first photo.
  assert.equal(C.defaultPhotoId(character('c-3', 'x', [photo('ph-f'), photo('ph-g', { isBase: true })], { basePhotoId: 'ph-zz' })), 'ph-g');
  assert.equal(C.defaultPhotoId(character('c-4', 'x', [photo('ph-h'), photo('ph-i')], { basePhotoId: null })), 'ph-h');
  assert.equal(C.defaultPhotoId(character('c-5', 'x', [])), null);
  assert.equal(C.selectedPhotoId(onAirSecond, 'ph-c'), 'ph-c');
  assert.equal(C.selectedPhotoId(onAirSecond, 'ph-gone'), 'ph-b');
  assert.equal(C.selectedPhotoId(onAirSecond, undefined), 'ph-b');
  assert.equal(C.selectedPhotoId(offAir, 'ph-b'), 'ph-e', "another row's photo is not a pick here");
  // Malformed entries are skipped everywhere.
  assert.deepEqual(C.photosOf({ photos: [null, { id: 3 }, photo('ph-ok')] }).map(p => p.id), ['ph-ok']);
  assert.deepEqual(C.charactersOf({ characters: [null, { id: '' }, character('c-9', 'y', [])] }).map(c => c.id), ['c-9']);
  assert.deepEqual(C.charactersOf(null), []);
});

test('photo numbers, counts, labels, badges and the 방송하기 hint', () => {
  const row = character('c-1', '민트', [photo('ph-a', { isBase: true }), photo('ph-b', { onAir: true })]);
  assert.equal(C.photoNumber(row, 'ph-b'), 2);
  assert.equal(C.photoNumber(row, 'nope'), null);
  assert.equal(C.photoCountText(row), '사진 2장');
  assert.equal(C.photoLabel(row, 'ph-b'), '민트 사진 2');
  assert.deepEqual(C.photoBadges(photo('p', { isBase: true })), [{ text: '기본', live: false }]);
  assert.deepEqual(C.photoBadges(photo('p', { onAir: true })), [{ text: '방송 중', live: true }]);
  assert.deepEqual(C.photoBadges(photo('p', { isBase: true, onAir: true })).map(b => b.text), ['기본', '방송 중']);
  assert.deepEqual(C.photoBadges(photo('p')), []);
  assert.equal(C.goHint(row, 'ph-b'), '선택한 사진이 지금 방송 중입니다');
  assert.equal(C.goHint(row, 'ph-a'), '선택한 사진으로 방송합니다');
  assert.equal(C.goHint(row, null), '선택한 사진으로 방송합니다');
});

test('the left column and the detail area: base photo, counts, captions and the selected title', () => {
  const row = character('c-1', '민트', [
    photo('ph-a', { motionCount: 2, motions: [motion('a'), motion('b')] }),
    photo('ph-b', { isBase: true, motionCount: 5, motions: [] }),
    photo('ph-c'),
  ], { basePhotoId: 'ph-b' });
  assert.equal(C.basePhotoOf(row).id, 'ph-b');
  assert.equal(C.basePhotoOf(character('c-2', 'x', [photo('ph-d'), photo('ph-e', { isBase: true })], { basePhotoId: 'ph-zz' })).id, 'ph-e');
  assert.equal(C.basePhotoOf(character('c-3', 'x', [photo('ph-f'), photo('ph-g')], { basePhotoId: null })).id, 'ph-f');
  assert.equal(C.basePhotoOf(character('c-4', 'x', [])), null);
  assert.equal(C.basePhotoOf(null), null);
  // Every motion of every photo counts under the name.
  assert.equal(C.characterMeta(row), '사진 3장 · 동작 7개');
  assert.equal(C.characterMeta(character('c-5', 'x', [photo('ph-h')])), '사진 1장 · 동작 0개');
  assert.equal(C.motionCaption(photo('p', { motionCount: 3 })), '동작 3개');
  assert.equal(C.motionCaption(photo('p')), '동작 없음');
  assert.equal(C.selectedTitle(row, 'ph-b'), '선택한 사진 · 2번째');
  assert.equal(C.selectedTitle(row, 'ph-a'), '선택한 사진 · 1번째');
  assert.equal(C.selectedTitle(row, 'nope'), '선택한 사진');
});

test('motion count and name chips', () => {
  const four = photo('p', { motionCount: 6, motions: ['원영턴', 'BAD 챌린지', '인사 (Hi)', '볼하트', '윙크', ' '].map(motion) });
  assert.equal(C.motionCount(four), 6);
  assert.equal(C.motionCountText(four), '동작 6개');
  assert.deepEqual(C.motionChips(four), { names: ['원영턴', 'BAD 챌린지', '인사 (Hi)', '볼하트'], more: 2 });
  assert.deepEqual(C.motionChips(four, 10), { names: ['원영턴', 'BAD 챌린지', '인사 (Hi)', '볼하트', '윙크'], more: 1 });
  assert.deepEqual(C.motionChips(photo('p')), { names: [], more: 0 });
  assert.equal(C.motionCountText(photo('p')), '동작 0개');
  // Without motionCount the list counts.
  assert.equal(C.motionCount({ motions: [motion('a'), motion('b')] }), 2);
  assert.equal(C.motionCount(null), 0);
});

test('onAirSummary names the character and photo on air', () => {
  const list = {
    characters: [
      character('c-1', '민트', [photo('ph-a', { isBase: true })]),
      character('c-2', '레몬', [photo('ph-b', { isBase: true }), photo('ph-c', { onAir: true })]),
    ],
    activePhotoId: 'ph-c',
    activeCharacterId: 'c-2',
  };
  assert.deepEqual(C.onAirSummary(list), { characterId: 'c-2', name: '레몬', photoId: 'ph-c', photoNumber: 2 });
  assert.equal(C.onAirSummary(list).photoId, list.activePhotoId);
  assert.equal(C.onAirSummary({ characters: [character('c-1', '민트', [photo('ph-a')])], activePhotoId: null }), null);
  assert.equal(C.onAirSummary(null), null);
});

test('delete texts follow the server rules: the only photo, the base photo, what is on air', () => {
  const only = character('c-1', '민트', [photo('ph-a', { isBase: true })]);
  assert.equal(C.photoDeleteRefusal(only), server.characterError('last_photo').message);
  const row = character('c-2', '레몬', [
    photo('ph-b', { isBase: true, motionCount: 2, motions: [motion('a'), motion('b')] }),
    photo('ph-c', { onAir: true, idle: 'upload' }),
    photo('ph-d'),
  ]);
  assert.equal(C.photoDeleteRefusal(row), '');
  assert.equal(C.photoDeleteConfirm(row, row.photos[0]), [
    '이 사진(레몬 사진 1)을 지울까요?',
    '이 사진의 동작 2개도 함께 지워집니다.',
    '기본 사진이라서, 남은 사진 중 가장 먼저 올린 사진이 기본이 됩니다.',
  ].join('\n'));
  assert.equal(C.photoDeleteConfirm(row, row.photos[1]), [
    '이 사진(레몬 사진 2)을 지울까요?',
    '이 사진에 올린 대기 영상도 함께 지워집니다.',
    '지금 방송 중인 사진입니다. 지우면 방송에서 내려가고, 방송 화면에는 기본 아바타가 나옵니다.',
  ].join('\n'));
  assert.equal(C.photoDeleteConfirm(row, row.photos[2]), '이 사진(레몬 사진 3)을 지울까요?');
  assert.equal(C.characterDeleteConfirm(row), [
    "'레몬' 캐릭터를 지울까요?",
    '사진 3장과 동작 2개가 함께 지워집니다.',
    '지금 방송 중인 캐릭터입니다. 지우면 방송에서 내려가고, 방송 화면에는 기본 아바타가 나옵니다.',
  ].join('\n'));
  assert.equal(C.characterDeleteConfirm(only), "'민트' 캐릭터를 지울까요?\n사진 1장이 함께 지워집니다.");
});

test('errorText: the server\'s Korean error, else the status', () => {
  assert.equal(C.errorText({ error: '사진을 찾을 수 없습니다.', code: 'photo_missing' }, 404), '사진을 찾을 수 없습니다.');
  assert.equal(C.errorText({ error: '  ' }, 500), 'HTTP 500');
  assert.equal(C.errorText(null, 502), 'HTTP 502');
  assert.equal(C.errorText(null, 0), C.TEXT.offline);
});

test('page wiring: own CSS, auth chip, header links, no other page script', () => {
  const html = readPublic('characters.html');
  assert.match(html, /<html lang="ko">/);
  const ownCss = html.indexOf('<link rel="stylesheet" href="./characters.css">');
  const authCss = html.indexOf('<link rel="stylesheet" href="./auth.css">');
  assert.ok(ownCss > 0 && authCss > ownCss, 'auth.css after characters.css, like the other pages');
  const authJs = html.indexOf('<script src="./auth.js"></script>');
  const ownJs = html.indexOf('<script src="./characters.js"></script>');
  assert.ok(authJs > 0 && ownJs > authJs, 'auth.js before characters.js');
  // animate.js and app.js run their page code whenever a document exists.
  assert.doesNotMatch(html, /animate\.js|app\.js|app\.css|animate\.css|motions\.js|<script>/);
  assert.equal((html.match(/id="authSlot"/g) || []).length, 1);
  assert.match(html, /<div class="brand-row">\s*<h1 class="brand"><a href="\/" class="brand-link">Virtually<\/a><\/h1>\s*<nav class="page-links" aria-label="다른 화면">\s*<a href="\/broadcast" class="nav-link">방송 화면<\/a>\s*<a href="\/animate" class="nav-link">동작 관리<\/a>\s*<\/nav>\s*<div id="authSlot" class="auth-slot" hidden><\/div>/);
  assert.match(html, /<h2 class="page-title">캐릭터<\/h2>/);
  assert.match(html, /사진을 고르고 '이 캐릭터로 방송하기'를 누르면 그 사진이 방송에 나갑니다\. 동작은 사진마다 따로 만듭니다\./);
  assert.match(html, /<a id="onAirPill" class="onair" href="\/broadcast"[^>]*hidden>/);
  // Layout C: creating a character is the always-visible, dashed first row (no toggle button, no dialog).
  assert.doesNotMatch(html, /createToggle|createClose|btn-create/);
});

test('page wiring: the dashed create row, the empty state and the row / photo templates', () => {
  const html = readPublic('characters.html');
  assert.match(html, /<section id="createPanel" class="create-row" aria-labelledby="createTitle">/);
  assert.doesNotMatch(html, /<section id="createPanel"[^>]*hidden/);
  assert.ok(html.indexOf('id="createPanel"') < html.indexOf('id="charList"'), 'the create row comes first');
  assert.match(html, /<h3 id="createTitle">새 캐릭터 만들기<\/h3>/);
  assert.match(html, /<span class="req">필수<\/span>/);
  assert.match(html, /\+ 기본 사진 올리기/);
  assert.match(html, /\(⌘V \/ Ctrl\+V\)/);
  assert.match(html, /<input id="createName" class="text-input" type="text" maxlength="40" autocomplete="off" placeholder="캐릭터 이름 \(40자까지\)" required>/);
  assert.match(html, /<button type="button" id="createBtn" class="btn" disabled>만들기<\/button>/);
  assert.match(html, /<input type="file" id="createInput" accept="image\/png,image\/jpeg,image\/webp" hidden>/);
  assert.match(html, /<div id="emptyState" class="empty-state" hidden>\s*<strong>첫 캐릭터를 만들어 주세요<\/strong>/);
  const row = html.slice(html.indexOf('<template id="rowTemplate">'), html.indexOf('<template id="photoTemplate">'));
  // Left column: the base photo ('기본 사진'), name, counts, 이름 바꾸기 / 삭제 and 이 캐릭터로 방송하기.
  assert.match(row, /<div class="base-thumb checkerboard">\s*<img alt="" decoding="async" draggable="false" data-part="baseImg">/);
  assert.match(row, /<span class="tag">기본 사진<\/span>/);
  assert.match(row, />이름 바꾸기<\/button>/);
  assert.match(row, /class="btn btn-ghost btn-sm btn-danger" data-part="delete">삭제<\/button>/);
  assert.match(row, /class="btn btn-go" data-part="go">이 캐릭터로 방송하기<\/button>/);
  assert.match(row, /maxlength="40"/);
  // Right column: the strip ('+ 사진 추가' is its last tile, after the photos) and the selected photo's detail.
  assert.match(row, /<div class="strip-scroller" role="group" data-part="scroller">\s*<button type="button" class="dropzone thumb-add" data-part="add">/);
  assert.match(row, /<input type="file" accept="image\/png,image\/jpeg,image\/webp" multiple hidden data-part="input">/);
  assert.match(row, /data-part="makeBase">기본으로<\/button>/);
  assert.match(row, /class="btn btn-ghost btn-sm btn-danger" data-part="deletePhoto">사진 삭제<\/button>/);
  assert.match(row, /<a class="add-motion" data-part="addMotion">동작 관리<\/a>/);
  assert.match(row, /이 캐릭터의 동작을 만들고, 올리고, 대기 동작을 고릅니다/);
  // A small photo is one button: select it, see its badges and its motion caption.
  const thumb = html.slice(html.indexOf('<template id="photoTemplate">'));
  assert.match(thumb, /<button type="button" class="thumb">\s*<span class="thumb-img checkerboard">/);
  assert.match(thumb, /data-part="badges"/);
  assert.match(thumb, /<span class="thumb-cap" data-part="cap">/);
});

test('page script: the API it calls, textContent only, DOM code behind the document guard', () => {
  const js = readPublic('characters.js');
  assert.match(js, /if \(typeof document !== 'undefined'\) \(\(\) => \{/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /api\('GET', '\/api\/characters'\)/);
  assert.match(js, /api\('PUT', '\/api\/active-photo', \{ json: \{ photoId \} \}\);\s*window\.location\.assign\('\/broadcast'\);/);
  assert.match(js, /api\('PUT', H\.basePath\(characterId\), \{ json: \{ photoId \} \}\)/);
  assert.match(js, /api\('PATCH', H\.characterPath\(characterId\), \{ json: \{ name \} \}\)/);
  assert.match(js, /api\('DELETE', H\.characterPath\(characterId\)\)/);
  assert.match(js, /api\('DELETE', H\.photoPath\(characterId, photoId\)\)/);
  assert.match(js, /api\('POST', H\.photosPath\(characterId, file\.name\)/);
  assert.match(js, /api\('POST', H\.createPath\(name, file\.name\)/);
  // Deletes ask first; the only photo is refused before asking.
  assert.match(js, /window\.confirm\(H\.photoDeleteConfirm\(character, photo\)\)/);
  assert.match(js, /window\.confirm\(H\.characterDeleteConfirm\(character\)\)/);
  assert.match(js, /const refusal = H\.photoDeleteRefusal\(character\);/);
  // Photos show what OBS shows; live refresh from the library view and on focus.
  assert.match(js, /const src = photo\.displayUrl \|\| photo\.url;/);
  // The big photo is the character's base photo; the strip's small photos select, the detail area acts on the selection.
  assert.match(js, /const base = H\.basePhotoOf\(character\);/);
  assert.match(js, /node\.addEventListener\('click', \(\) => selectPhoto\(characterId, photoId\)\);/);
  assert.match(js, /row\.makeBase\.addEventListener\('click'/);
  assert.match(js, /row\.deletePhoto\.addEventListener\('click'/);
  assert.match(js, /new EventSource\('\/api\/events'\)/);
  assert.match(js, /if \(data\?\.type === 'library' && state\.list\) scheduleLoad\(\);/);
  assert.match(js, /window\.addEventListener\('focus', \(\) => scheduleLoad\(0\)\);/);
  assert.match(js, /document\.addEventListener\('paste', \(event\) => \{\s*if \(state\.create\.busy\) return;/);
  assert.doesNotMatch(js, /openCreate|closeCreate/);
});

test('page CSS: the shared palette, [hidden], strips scroll inside, the narrow layout', () => {
  const css = readPublic('characters.css');
  const tokens = source => Object.fromEntries([...source.match(/:root \{([^}]*)\}/)[1].matchAll(/(--[a-z]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const own = tokens(css);
  const animate = tokens(readPublic('animate.css'));
  for (const [name, value] of Object.entries(own)) assert.equal(value, animate[name], name);
  for (const name of ['--bg', '--panel', '--border', '--text', '--muted', '--accent', '--danger']) assert.ok(own[name], name);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /\.strip-scroller \{[^}]*overflow-x: auto;/);
  assert.match(css, /\.create-row \{[^}]*grid-template-columns: 220px minmax\(0, 1fr\);/);
  assert.match(css, /\.char-row \{ display: grid; grid-template-columns: 220px minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 720px\) \{[^@]*\.create-row \{ grid-template-columns: 1fr;/);
  // Narrow: photos first, then 방송하기 (the button acts on the selected photo).
  assert.match(css, /@media \(max-width: 720px\) \{[^@]*\.char-row \{ display: flex; flex-direction: column;[^@]*\.base-col, \.main-col \{ display: contents; \}[^@]*\.strip \{ order: 5; \}[^@]*\.btn-go \{ order: 7;/);
  assert.match(css, /\.btn-go \{ width: 100%;/);
});
