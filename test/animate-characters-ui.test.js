'use strict';

// 동작 만들기 page, characters part: the photo picker's DOM-free helpers
// (GET /api/characters views), the paste target, the finished-motion upload
// helpers and the page's static wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../public/animate.js');
const { PRESET_MOTIONS } = require('../public/motions.js');

const readPublic = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

const photo = (id, over = {}) => ({
  id, url: `/api/media/${id}`, displayUrl: `/api/media/${id}`, cutout: false, width: 800, height: 1200, hasAlpha: true,
  createdAt: '2026-09-30T00:00:00.000Z', isBase: false, onAir: false, idle: 'photo', motionCount: 0, motions: [], ...over,
});
const character = (id, name, photos, over = {}) => ({
  id, name, createdAt: '2026-09-30T00:00:00.000Z', basePhotoId: photos[0]?.id ?? null, onAir: photos.some(p => p.onAir), photos, ...over,
});
const LIST = {
  characters: [
    character('c-1', '민트', [photo('ph-a', { isBase: true }), photo('ph-b')]),
    character('c-2', '레몬', [photo('ph-c', { isBase: true, motionCount: 2, motions: [{ id: 'm-1' }, { id: 'm-2' }] }), photo('ph-d', { onAir: true })]),
  ],
  activePhotoId: 'ph-d',
  activeCharacterId: 'c-2',
};

test('listPhotos / findPhoto walk every character photo in list order', () => {
  assert.deepEqual(H.listPhotos(LIST).map(e => [e.character.id, e.photo.id, e.index]),
    [['c-1', 'ph-a', 0], ['c-1', 'ph-b', 1], ['c-2', 'ph-c', 0], ['c-2', 'ph-d', 1]]);
  assert.equal(H.findPhoto(LIST, 'ph-c').character.name, '레몬');
  assert.equal(H.findPhoto(LIST, 'ph-c').index, 0);
  assert.equal(H.findPhoto(LIST, 'nope'), null);
  assert.equal(H.findPhoto(LIST, null), null);
  assert.deepEqual(H.listPhotos(null), []);
  assert.deepEqual(H.listPhotos({ characters: [null, { id: 'c-x', photos: [null, { id: 7 }] }] }), []);
});

test('choosePhotoId: ?photo= while it exists, else the on-air photo, else the first base photo', () => {
  assert.equal(H.choosePhotoId(LIST, 'ph-b'), 'ph-b');
  assert.equal(H.choosePhotoId(LIST, 'ph-gone'), 'ph-d', 'a deleted photo falls back to the on-air one');
  assert.equal(H.choosePhotoId(LIST, null), 'ph-d');
  const offAir = { ...LIST, activePhotoId: null };
  assert.equal(H.choosePhotoId(offAir, null), 'ph-a');
  // The base photo wins over the first listed photo.
  const baseSecond = { characters: [character('c-1', 'x', [photo('ph-1'), photo('ph-2')], { basePhotoId: 'ph-2' })], activePhotoId: null };
  assert.equal(H.choosePhotoId(baseSecond, null), 'ph-2');
  // A base id that is not the character's own photo is ignored.
  const foreignBase = { characters: [character('c-1', 'x', [photo('ph-1')], { basePhotoId: 'ph-9' })], activePhotoId: 'ph-zz' };
  assert.equal(H.choosePhotoId(foreignBase, 'ph-zz'), 'ph-1');
  assert.equal(H.choosePhotoId({ characters: [], activePhotoId: null }, 'ph-a'), null);
  assert.equal(H.choosePhotoId(null, null), null);
});

test('pasteTarget: new photos of the chosen character, or a new 캐릭터 N', () => {
  assert.deepEqual(H.pasteTarget(LIST, 'ph-b'), { kind: 'photo', characterId: 'c-1' });
  assert.deepEqual(H.pasteTarget(LIST, 'ph-d'), { kind: 'photo', characterId: 'c-2' });
  assert.deepEqual(H.pasteTarget({ characters: [], activePhotoId: null }, null), { kind: 'character', name: '캐릭터 1' });
  assert.equal(H.nextCharacterName(0), '캐릭터 1');
  assert.equal(H.nextCharacterName(2), '캐릭터 3');
  assert.equal(H.nextCharacterName(-1), '캐릭터 1');
  assert.equal(H.nextCharacterName(Number.NaN), '캐릭터 1');
});

test('photo labels, captions and the chosen-photo summary', () => {
  assert.equal(H.photoLabel({ name: '레몬' }, 1), '레몬 사진 2');
  assert.equal(H.photoLabel({ name: '레몬' }, undefined), '레몬 사진 1');
  assert.equal(H.photoCaption(photo('p', { isBase: true, motionCount: 2 })), '기본 · 동작 2개');
  assert.equal(H.photoCaption(photo('p', { isBase: true })), '기본 · 동작 없음');
  assert.equal(H.photoCaption(photo('p', { motionCount: 1 })), '동작 1개');
  assert.equal(H.photoCaption(photo('p', { motionCount: -3 })), '동작 없음');
  assert.equal(H.photoSummary(H.findPhoto(LIST, 'ph-d')), '선택: 레몬 사진 2 · 800×1200 · 방송 중');
  const cut = { character: { name: '민트' }, photo: photo('p', { cutout: true, width: null, height: null }), index: 0 };
  assert.equal(H.photoSummary(cut), '선택: 민트 사진 1 · 단색 배경을 지워서 보여 줍니다');
  assert.equal(H.photoSummary(null), '');
});

test('knownMotionIds: every photo motion plus the live view (motions without a photo)', () => {
  const ids = H.knownMotionIds(LIST, [{ id: 'legacy-1' }, { id: 'm-1' }, null, { id: 5 }]);
  assert.deepEqual([...ids].sort(), ['legacy-1', 'm-1', 'm-2']);
  assert.deepEqual([...H.knownMotionIds(null, null)], []);
});

test('searchWithPhoto keeps the other parameters', () => {
  assert.equal(H.searchWithPhoto('', 'ph-1'), '?photo=ph-1');
  assert.equal(H.searchWithPhoto('?photo=ph-0&x=1', 'ph-1'), '?photo=ph-1&x=1');
  assert.equal(H.searchWithPhoto('?x=1&photo=ph-0', null), '?x=1');
  assert.equal(H.searchWithPhoto('?photo=ph-0', ''), '');
});

test('finished motion: base name, file checks and the upload path', () => {
  assert.equal(H.fileBaseName('wink.webm'), 'wink');
  assert.equal(H.fileBaseName('clips/wink.final.MOV'), 'wink.final');
  assert.equal(H.fileBaseName('C:\\clips\\원영턴.mp4'), '원영턴');
  assert.equal(H.fileBaseName('.hidden'), '.hidden');
  assert.equal(H.fileBaseName(''), '');
  assert.equal(H.MOTION_MAX_BYTES, 500 * 1024 * 1024);
  assert.equal(H.MOTION_MAX_SECONDS, 60);
  assert.equal(H.motionFileProblem({ name: 'a.webm', type: 'video/webm', size: 10 }), '');
  assert.equal(H.motionFileProblem({ name: 'a.mov', type: '', size: 10 }), '');
  assert.equal(H.motionFileProblem({ name: 'a.png', type: 'image/png', size: 10 }), 'WebM, MP4, MOV 영상만 올릴 수 있습니다');
  assert.equal(H.motionFileProblem({ name: 'a.avi', type: 'video/x-msvideo', size: 10 }), 'WebM, MP4, MOV 영상만 올릴 수 있습니다');
  assert.equal(H.motionFileProblem({ name: 'a.mp4', type: 'video/mp4', size: H.MOTION_MAX_BYTES + 1 }), '영상은 500MB까지 올릴 수 있습니다');
  assert.equal(H.motionFileProblem(null), '');

  const url = new URL(H.motionUploadPath('c-1', 'ph-2', { name: '  원영턴 ', filename: 'my clip.mov' }), 'http://x');
  assert.equal(url.pathname, '/api/characters/c-1/photos/ph-2/motions');
  assert.equal(url.searchParams.get('name'), '원영턴');
  assert.equal(url.searchParams.get('filename'), 'my clip.mov');
  // An empty name is sent empty: the server then names it after the file.
  assert.equal(new URL(H.motionUploadPath('c-1', 'ph-2', { filename: 'a.webm' }), 'http://x').searchParams.get('name'), '');
});

test('uploadResultText: keyed colour, own alpha, or kept background with the reason in Korean', () => {
  const answer = (upload, top = {}) => ({ motion: { source: { upload } }, keyed: upload.keyed, keyReason: upload.keyReason ?? null, ...top });
  assert.deepEqual(H.uploadResultText(answer({ keyed: true, alpha: false, keyColor: '#00fe01', keyReason: null })),
    { text: '배경을 지웠습니다 (#00FE01)', kind: 'success' });
  assert.deepEqual(H.uploadResultText(answer({ keyed: true, keyColor: 'green' })), { text: '배경을 지웠습니다', kind: 'success' });
  assert.deepEqual(H.uploadResultText(answer({ keyed: false, alpha: true, keyColor: null, keyReason: null })),
    { text: '투명 배경 그대로 추가했습니다', kind: 'success' });
  assert.deepEqual(H.uploadResultText(answer({ keyed: false, alpha: false, keyReason: 'not_uniform' })),
    { text: '배경이 있는 채로 추가됨 · 가장자리 배경이 한 가지 색이 아니라서 지우지 않았습니다', kind: 'warn' });
  assert.match(H.uploadResultText(answer({ keyed: false, alpha: false, keyReason: 'not_key_color' })).text, /초록·파랑·분홍 단색이 아니라서/);
  assert.match(H.uploadResultText(answer({ keyed: false, alpha: false, keyReason: 'unreadable' })).text, /읽지 못해/);
  assert.match(H.uploadResultText(answer({ keyed: false, alpha: false, keyReason: 'key_failed' })).text, /실패했습니다/);
  assert.deepEqual(H.uploadResultText(answer({ keyed: false, alpha: false, keyReason: 'something_new' })),
    { text: '배경이 있는 채로 추가됨', kind: 'warn' });
  // The top-level keyed/keyReason of the answer win over the record.
  assert.equal(H.uploadResultText({ keyed: false, keyReason: 'not_uniform', motion: { source: { upload: { keyed: true } } } }).kind, 'warn');
  assert.equal(H.keyReasonText(undefined), '');
  assert.equal(H.uploadResultText(null).text, '배경이 있는 채로 추가됨');
});

test('character API errors show the server Korean text; job errors keep the code mapping', () => {
  assert.equal(H.serverErrorText({ error: '캐릭터를 찾을 수 없습니다.', code: 'character_missing' }), '캐릭터를 찾을 수 없습니다.');
  assert.equal(H.serverErrorText({ error: '영상은 60초까지 올릴 수 있습니다.', code: 'too_long' }), '영상은 60초까지 올릴 수 있습니다.');
  assert.equal(H.serverErrorText({ error: '  ', code: 'no_credentials' }), 'API 키가 필요합니다');
  assert.equal(H.serverErrorText(null), '알 수 없는 오류');
  // A job's error ({ code, message } in English) still reads through the Korean code table.
  assert.equal(H.errorText({ code: 'character_missing', message: 'No character image.' }), '캐릭터 이미지가 없습니다');
  // The animate API's photo_missing already carries Korean text: no mapping hides it.
  assert.equal(H.errorText({ error: '사진을 찾을 수 없습니다.', code: 'photo_missing' }), '사진을 찾을 수 없습니다.');
});

test('the upload name suggests the preset labels from the one catalog', () => {
  assert.deepEqual(H.presetNames(), PRESET_MOTIONS.map(p => p.label));
  assert.ok(H.presetNames().includes('원영턴'));
});

test('animate page wiring: character API only, photo picker, two paths, finished-video upload', () => {
  const html = readPublic('animate.html');
  const js = readPublic('animate.js');
  // The old character library is gone.
  assert.doesNotMatch(js, /\/api\/animate\/character|selectedId|status\.character|'character' in data/);
  assert.match(js, /api\('GET', '\/api\/characters', \{ errorText: H\.serverErrorText \}\)/);
  assert.match(js, /`\/api\/characters\/\$\{encodeURIComponent\(target\)\}\/photos\?filename=/);
  assert.match(js, /`\/api\/characters\?\$\{query\}`/);
  assert.match(js, /photoId: photo\.id,/);
  // Picker: rows of photos shown as displayUrl on the checkerboard; ?photo= preselects.
  assert.match(js, /new URLSearchParams\(window\.location\.search\)\.get\('photo'\)/);
  assert.match(js, /const src = photo\.displayUrl \|\| photo\.url;/);
  assert.match(js, /className: 'char-thumb checkerboard'/);
  assert.match(html, /<h2 id="characterTitle">1\. 캐릭터 사진<\/h2>/);
  assert.match(html, /<div id="characterEmpty" class="bar char-empty" hidden>[\s\S]*?<strong>캐릭터를 먼저 만들어 주세요<\/strong>[\s\S]*?<a href="\/" class="btn btn-sm">캐릭터 만들러 가기<\/a>/);
  // Two paths as tabs.
  assert.match(html, /<div class="path-choice" role="tablist" aria-label="동작 만드는 방법">/);
  assert.match(html, /<button type="button" role="tab" id="pathAiTab"[^>]*aria-controls="aiPath">\s*<span class="path-title">AI로 만들기<\/span>/);
  assert.match(html, /<button type="button" role="tab" id="pathUploadTab"[^>]*aria-controls="uploadPath" tabindex="-1">\s*<span class="path-title">완성된 영상 올리기<\/span>/);
  assert.match(html, /<div id="aiPath" class="path-panel" role="tabpanel" aria-labelledby="pathAiTab">\s*<!-- 2\. Driving video -->/);
  assert.match(html, /<div id="uploadPath" class="path-panel" role="tabpanel" aria-labelledby="pathUploadTab" hidden>/);
  // Upload card: name field with the preset suggestions, the hint, progress.
  assert.match(html, /<input type="text" id="motionName" class="name-input" maxlength="100" list="presetNames"/);
  assert.match(html, /<datalist id="presetNames"><\/datalist>/);
  assert.match(html, /기본 동작 이름을 쓰면 방송 화면의 그 버튼으로 이 영상이 재생됩니다\./);
  assert.match(html, /<progress id="motionProgress" class="upload-progress" max="100" value="0" hidden><\/progress>/);
  assert.match(html, /<input type="file" id="motionInput" accept="video\/webm,video\/mp4,video\/quicktime,\.webm,\.mp4,\.mov" hidden>/);
  assert.match(js, /const path = H\.motionUploadPath\(chosen\.character\.id, chosen\.photo\.id, \{ name: motionName\.value, filename: file\.name \}\);/);
  assert.match(js, /xhr\.upload\.addEventListener\('progress'/);
  assert.match(js, /failUpload\(H\.serverErrorText\(data \|\| \{ error: `HTTP \$\{xhr\.status\}` \}\)\)/);
  // The paid-generation dialog names the character photo.
  assert.match(html, /<div><dt>캐릭터<\/dt><dd id="confirmPhoto"><\/dd><\/div>/);
  // No markup parsing anywhere, including the cloned template.
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
});
