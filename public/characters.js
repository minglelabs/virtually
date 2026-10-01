'use strict';

// Character list (/): every character with its photos, the photo on air and
// the create / rename / delete controls. GET /api/characters is the source;
// every change re-renders from the server's answer (or a refetch). Names are
// user data: rows and cards are cloned from the page's <template>s and every
// text is set with textContent. The DOM-free helpers below are require()-able
// from node tests (like AnimateHelpers); the page code runs only in a browser.

const CharactersHelpers = (() => {
  // Mirrors of the server (lib/characters.js); a test keeps them equal.
  const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
  const NAME_MAX = 40;
  const TEXT = Object.freeze({
    unsupportedImage: 'PNG, JPEG, WebP 사진만 올릴 수 있습니다.',
    tooLarge: '사진은 20MB까지 올릴 수 있습니다.',
    lastPhoto: '사진이 하나뿐인 캐릭터는 캐릭터를 삭제해 주세요.',
    nameMissing: '캐릭터 이름을 입력해 주세요.',
    baseMissing: '기본 사진을 올려 주세요.',
    bothMissing: '캐릭터 이름을 입력하고 기본 사진을 올려 주세요.',
    offline: '서버에 연결할 수 없습니다.',
  });
  // Deleting the photo on air (or its character) leaves nothing on air: the
  // overlay goes back to the demo avatar (server.js libraryView).
  const ON_AIR_PHOTO_NOTE = '지금 방송 중인 사진입니다. 지우면 방송에서 내려가고, 방송 화면에는 기본 아바타가 나옵니다.';
  const ON_AIR_CHARACTER_NOTE = '지금 방송 중인 캐릭터입니다. 지우면 방송에서 내려가고, 방송 화면에는 기본 아바타가 나옵니다.';

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

  /** A PNG/JPEG/WebP file, by its MIME type or, when that is empty, its extension (animate.js fileKind). */
  function isImageFile(file) {
    if (!file || typeof file !== 'object') return false;
    const type = String(file.type ?? '').toLowerCase();
    if (type) return IMAGE_TYPES.has(type);
    const ext = /\.([a-z0-9]+)$/i.exec(String(file.name ?? ''))?.[1]?.toLowerCase();
    return IMAGE_EXTS.has(ext);
  }

  /** Why a file cannot be a photo (the server's own Korean text), or ''. */
  function photoFileProblem(file) {
    if (!isImageFile(file)) return TEXT.unsupportedImage;
    if (Number(file.size) > PHOTO_MAX_BYTES) return TEXT.tooLarge;
    return '';
  }

  /**
   * The first image of a paste (ClipboardEvent.clipboardData) as { file, name },
   * or null. A copied screenshot arrives unnamed or as 'image.png', so it gets
   * 'pasted-<time>.<ext>', the 동작 만들기 page's rule.
   */
  function pastedImage(clipboardData, now = Date.now()) {
    if (!clipboardData) return null;
    const files = Array.from(clipboardData.files || []);
    for (const item of Array.from(clipboardData.items || [])) {
      if (item && item.kind === 'file' && typeof item.getAsFile === 'function') files.push(item.getAsFile());
    }
    const file = files.find(isImageFile);
    return file ? { file, name: pastedName(file, now) } : null;
  }

  function pastedName(file, now) {
    const name = String(file.name ?? '');
    if (name && name.toLowerCase() !== 'image.png' && /\.[a-z0-9]+$/i.test(name)) return name;
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[String(file.type ?? '').toLowerCase()] || 'png';
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    return `pasted-${stamp}.${ext}`;
  }

  /** A name as the server stores it: control characters become spaces, whitespace runs collapse, ends trimmed. */
  function cleanName(value) {
    return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** What still stops '만들기' (Korean), or '' once a name and a base photo are set. */
  function createBlocker({ name, file } = {}) {
    const hasName = cleanName(name) !== '';
    const hasFile = Boolean(file);
    if (!hasName && !hasFile) return TEXT.bothMissing;
    if (!hasName) return TEXT.nameMissing;
    if (!hasFile) return TEXT.baseMissing;
    return '';
  }

  function canCreate({ name, file, busy = false } = {}) {
    return !busy && createBlocker({ name, file }) === '';
  }

  // ---- Links and API paths ----
  const enc = encodeURIComponent;

  /** The 동작 만들기 link for a photo: '/animate?photo=<id>', or '/animate' without one (app.js animateHref). */
  function animateHref(photoId) {
    return typeof photoId === 'string' && photoId ? `/animate?photo=${enc(photoId)}` : '/animate';
  }

  const createPath = (name, filename) => `/api/characters?${new URLSearchParams({ name: String(name ?? ''), filename: String(filename ?? '') })}`;
  const characterPath = characterId => `/api/characters/${enc(characterId)}`;
  const photosPath = (characterId, filename) => `${characterPath(characterId)}/photos?${new URLSearchParams({ filename: String(filename ?? '') })}`;
  const photoPath = (characterId, photoId) => `${characterPath(characterId)}/photos/${enc(photoId)}`;
  const basePath = characterId => `${characterPath(characterId)}/base`;

  // ---- The list (GET /api/characters views) ----

  /** The list's characters with an id (server order: oldest first). */
  function charactersOf(list) {
    return (Array.isArray(list?.characters) ? list.characters : []).filter(c => c && typeof c.id === 'string' && c.id);
  }

  /** A character's photos with an id, in the view's order (the base photo first). */
  function photosOf(character) {
    return (Array.isArray(character?.photos) ? character.photos : []).filter(p => p && typeof p.id === 'string' && p.id);
  }

  /** The character's base photo (basePhotoId, else the isBase flag, else the first photo), or null. */
  function basePhotoOf(character) {
    const photos = photosOf(character);
    return photos.find(p => p.id === character?.basePhotoId) || photos.find(p => p.isBase === true) || photos[0] || null;
  }

  /** The photo a row selects by itself: the photo on air when it is in the row, else the base photo (else the first). */
  function defaultPhotoId(character) {
    const onAir = photosOf(character).find(p => p.onAir === true);
    return (onAir || basePhotoOf(character))?.id ?? null;
  }

  /** The row's selected photo: the one the user clicked while it still exists, else the default. */
  function selectedPhotoId(character, picked) {
    return photosOf(character).some(p => p.id === picked) ? picked : defaultPhotoId(character);
  }

  /** 1-based position of a photo in its row, or null. */
  function photoNumber(character, photoId) {
    const index = photosOf(character).findIndex(p => p.id === photoId);
    return index < 0 ? null : index + 1;
  }

  const photoCountText = character => `사진 ${photosOf(character).length}장`;

  /** '민트 사진 2': how a photo is named (photos have no names of their own). */
  function photoLabel(character, photoId) {
    return `${String(character?.name ?? '')} 사진 ${photoNumber(character, photoId) ?? 1}`.trim();
  }

  /** The badges on a photo: '기본', then '방송 중'. */
  function photoBadges(photo) {
    const badges = [];
    if (photo?.isBase === true) badges.push({ text: '기본', live: false });
    if (photo?.onAir === true) badges.push({ text: '방송 중', live: true });
    return badges;
  }

  function motionCount(photo) {
    const count = Number(photo?.motionCount);
    if (Number.isInteger(count) && count >= 0) return count;
    return Array.isArray(photo?.motions) ? photo.motions.length : 0;
  }

  const motionCountText = photo => `동작 ${motionCount(photo)}개`;

  /** The line under a small photo: '동작 2개', or '동작 없음'. */
  function motionCaption(photo) {
    const count = motionCount(photo);
    return count ? `동작 ${count}개` : '동작 없음';
  }

  /** The counts under a character's name: '사진 5장 · 동작 7개' (motions of every photo). */
  function characterMeta(character) {
    const motions = photosOf(character).reduce((sum, photo) => sum + motionCount(photo), 0);
    return `${photoCountText(character)} · 동작 ${motions}개`;
  }

  /** The detail area's title: '선택한 사진 · 2번째'. */
  function selectedTitle(character, photoId) {
    const number = photoNumber(character, photoId);
    return number ? `선택한 사진 · ${number}번째` : '선택한 사진';
  }

  /** The motion name chips of a photo: at most `max` names, and how many more there are. */
  function motionChips(photo, max = 4) {
    const names = (Array.isArray(photo?.motions) ? photo.motions : [])
      .map(motion => String(motion?.name ?? '').trim())
      .filter(Boolean);
    const shown = names.slice(0, max);
    return { names: shown, more: Math.max(names.length, motionCount(photo)) - shown.length };
  }

  /** The line next to '이 캐릭터로 방송하기'. */
  function goHint(character, selectedId) {
    const photo = photosOf(character).find(p => p.id === selectedId);
    return photo && photo.onAir === true ? '선택한 사진이 지금 방송 중입니다' : '선택한 사진으로 방송합니다';
  }

  /** The photo on air as { characterId, name, photoId, photoNumber }, or null. */
  function onAirSummary(list) {
    for (const character of charactersOf(list)) {
      const photos = photosOf(character);
      const index = photos.findIndex(p => p.onAir === true);
      if (index >= 0) return { characterId: character.id, name: String(character.name ?? ''), photoId: photos[index].id, photoNumber: index + 1 };
    }
    return null;
  }

  /** The server refuses to delete a character's only photo (409 last_photo); its text, or ''. */
  function photoDeleteRefusal(character) {
    return photosOf(character).length <= 1 ? TEXT.lastPhoto : '';
  }

  /** window.confirm text before deleting a photo: what goes with it and what changes. */
  function photoDeleteConfirm(character, photo) {
    const lines = [`이 사진(${photoLabel(character, photo?.id)})을 지울까요?`];
    const motions = motionCount(photo);
    if (motions) lines.push(`이 사진의 동작 ${motions}개도 함께 지워집니다.`);
    if (photo?.idle === 'upload') lines.push('이 사진에 올린 대기 영상도 함께 지워집니다.');
    if (photo?.isBase === true) lines.push('기본 사진이라서, 남은 사진 중 가장 먼저 올린 사진이 기본이 됩니다.');
    if (photo?.onAir === true) lines.push(ON_AIR_PHOTO_NOTE);
    return lines.join('\n');
  }

  /** window.confirm text before deleting a character. */
  function characterDeleteConfirm(character) {
    const photos = photosOf(character);
    const motions = photos.reduce((sum, photo) => sum + motionCount(photo), 0);
    const lines = [`'${String(character?.name ?? '')}' 캐릭터를 지울까요?`];
    lines.push(motions
      ? `사진 ${photos.length}장과 동작 ${motions}개가 함께 지워집니다.`
      : `사진 ${photos.length}장이 함께 지워집니다.`);
    if (character?.onAir === true || photos.some(p => p.onAir === true)) lines.push(ON_AIR_CHARACTER_NOTE);
    return lines.join('\n');
  }

  /** The server's Korean `error` text, else 'HTTP <status>' (or the offline text without a status). */
  function errorText(body, status) {
    const text = body && typeof body.error === 'string' ? body.error.trim() : '';
    if (text) return text;
    return status ? `HTTP ${status}` : TEXT.offline;
  }

  return {
    PHOTO_MAX_BYTES,
    NAME_MAX,
    TEXT,
    isImageFile,
    photoFileProblem,
    pastedImage,
    cleanName,
    createBlocker,
    canCreate,
    animateHref,
    createPath,
    characterPath,
    photosPath,
    photoPath,
    basePath,
    charactersOf,
    photosOf,
    basePhotoOf,
    defaultPhotoId,
    selectedPhotoId,
    photoNumber,
    photoCountText,
    photoLabel,
    photoBadges,
    motionCount,
    motionCountText,
    motionCaption,
    characterMeta,
    selectedTitle,
    motionChips,
    goHint,
    onAirSummary,
    photoDeleteRefusal,
    photoDeleteConfirm,
    characterDeleteConfirm,
    errorText,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CharactersHelpers;

if (typeof document !== 'undefined') (() => {
  const H = CharactersHelpers;
  const $ = id => document.getElementById(id);
  const pageStatus = $('pageStatus');
  const onAirPill = $('onAirPill');
  const onAirName = $('onAirName');
  const onAirPhoto = $('onAirPhoto');
  const onAirNone = $('onAirNone');
  const emptyState = $('emptyState');
  const createPanel = $('createPanel');
  const createDrop = $('createDrop');
  const createPreview = $('createPreview');
  const createPreviewImg = $('createPreviewImg');
  const createDropTitle = $('createDropTitle');
  const createDropSub = $('createDropSub');
  const createDropFileSub = $('createDropFileSub');
  const createInput = $('createInput');
  const createName = $('createName');
  const createBtn = $('createBtn');
  const createStatus = $('createStatus');
  const charList = $('charList');
  const rowTemplate = $('rowTemplate');
  const photoTemplate = $('photoTemplate');

  const state = {
    list: null, // GET /api/characters; null until loaded
    picked: new Map(), // character id -> the photo the user clicked in that row
    editing: new Map(), // character id -> rename draft, while its name is being edited
    busy: new Map(), // character id -> the add tile's text while a request of that row runs ('' = no text change)
    rowStatus: new Map(), // character id -> { text, kind }
    create: { file: null, previewUrl: null, busy: false, message: null }, // message: { text, kind } from the last try
  };

  // ---- Small DOM helpers ----
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  const part = (root, name) => root.querySelector(`[data-part="${name}"]`);

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    if (kind && text) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  // JSON API call; a refusal throws an Error carrying the server's Korean `error` text.
  async function api(method, path, { json, body, contentType } = {}) {
    const init = { method, headers: { Accept: 'application/json' } };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.headers['Content-Type'] = contentType || 'application/octet-stream';
      init.body = body;
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw Object.assign(new Error(H.TEXT.offline), { status: 0, code: null });
    }
    let data = null;
    try { data = await response.json(); } catch { /* empty or not JSON */ }
    if (!response.ok) throw Object.assign(new Error(H.errorText(data, response.status)), { status: response.status, code: data?.code || null });
    return data;
  }

  // ---- Horizontal strips (animate.js setupStrip, without taking over the wheel:
  // this page scrolls vertically, so a wheel over a strip keeps scrolling the page) ----
  function setupStrip(scroller) {
    const wrap = scroller.parentElement;
    function update() {
      const max = scroller.scrollWidth - scroller.clientWidth;
      wrap.toggleAttribute('data-more-left', scroller.scrollLeft > 1);
      wrap.toggleAttribute('data-more-right', max > 1 && scroller.scrollLeft < max - 1);
    }
    scroller.addEventListener('scroll', update, { passive: true });
    const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (resizer) resizer.observe(scroller);
    else window.addEventListener('resize', update);
    return {
      refresh: update,
      destroy() {
        if (resizer) resizer.disconnect();
        else window.removeEventListener('resize', update);
      },
    };
  }

  // Drag-and-drop of files onto `target`, shown as the drag-over state on `zone` (animate.js acceptDrops).
  function acceptDrops(target, zone, onFiles) {
    let depth = 0;
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    target.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      zone.classList.add('is-dragover');
    });
    target.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-dragover');
    });
    target.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.classList.remove('is-dragover');
    });
    target.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      zone.classList.remove('is-dragover');
      onFiles(Array.from(event.dataTransfer.files || []));
    });
  }

  // A file dropped outside a drop zone must not navigate away from the page.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
    });
  }

  // ---- The list ----
  // Answers can arrive out of order: a GET started before a newer answer was
  // shown is dropped. Mutation answers count from when they arrive.
  let listClock = 0;
  let listShownAt = 0;

  const findCharacter = id => H.charactersOf(state.list).find(character => character.id === id) || null;

  function applyList(data, at = ++listClock) {
    if (!data || !Array.isArray(data.characters) || at < listShownAt) return;
    listShownAt = at;
    state.list = {
      characters: data.characters,
      activePhotoId: typeof data.activePhotoId === 'string' ? data.activePhotoId : null,
      activeCharacterId: typeof data.activeCharacterId === 'string' ? data.activeCharacterId : null,
    };
    // Forget picks, drafts and notes of characters or photos that are gone.
    for (const [id, photoId] of state.picked) {
      const character = findCharacter(id);
      if (!character || !H.photosOf(character).some(photo => photo.id === photoId)) state.picked.delete(id);
    }
    for (const map of [state.editing, state.rowStatus]) {
      for (const id of [...map.keys()]) if (!findCharacter(id)) map.delete(id);
    }
    render();
  }

  async function loadList() {
    const at = ++listClock;
    applyList(await api('GET', '/api/characters'), at);
  }

  // Refetch soon: the library view changed, or the tab came back (another page may have changed things).
  let loadTimer = null;
  function scheduleLoad(delay = 150) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => loadList().catch(() => {}), delay);
  }

  // ---- Rendering: rows and photos are keyed by id and patched in place, so a
  // refresh keeps scroll positions, focus and a half-typed name, and never
  // reloads an unchanged image (media is served no-store). ----
  const rows = new Map(); // character id -> row (createRow)

  function render() {
    const characters = H.charactersOf(state.list);
    emptyState.hidden = state.list == null || characters.length > 0;
    renderOnAir();
    const seen = new Set();
    characters.forEach((character, index) => {
      seen.add(character.id);
      let row = rows.get(character.id);
      if (!row) {
        row = createRow(character.id);
        rows.set(character.id, row);
      }
      if (charList.children[index] !== row.node) charList.insertBefore(row.node, charList.children[index] || null);
      updateRow(row, character);
    });
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.strip.destroy();
      row.node.remove();
      rows.delete(id);
    }
    renderCreate();
  }

  function renderOnAir() {
    const summary = H.onAirSummary(state.list);
    onAirPill.hidden = !summary;
    onAirNone.hidden = Boolean(summary) || state.list == null;
    onAirName.textContent = summary ? summary.name : '';
    onAirName.title = summary ? summary.name : '';
    onAirPhoto.textContent = summary ? `· 사진 ${summary.photoNumber}` : '';
  }

  function createRow(characterId) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const row = {
      node,
      baseImg: part(node, 'baseImg'),
      nameLine: part(node, 'nameLine'),
      name: part(node, 'name'),
      live: part(node, 'live'),
      renameForm: part(node, 'renameForm'),
      renameInput: part(node, 'renameInput'),
      renameSave: part(node, 'renameSave'),
      renameCancel: part(node, 'renameCancel'),
      meta: part(node, 'meta'),
      tools: part(node, 'tools'),
      rename: part(node, 'rename'),
      remove: part(node, 'delete'),
      go: part(node, 'go'),
      hint: part(node, 'hint'),
      status: part(node, 'status'),
      scroller: part(node, 'scroller'),
      add: part(node, 'add'),
      addTitle: part(node, 'addTitle'),
      input: part(node, 'input'),
      detail: part(node, 'detail'),
      detailTitle: part(node, 'detailTitle'),
      detailLive: part(node, 'detailLive'),
      makeBase: part(node, 'makeBase'),
      deletePhoto: part(node, 'deletePhoto'),
      count: part(node, 'count'),
      chips: part(node, 'chips'),
      addMotion: part(node, 'addMotion'),
      chipsKey: null,
      thumbs: new Map(), // photo id -> small photo (createThumb)
    };
    node.dataset.id = characterId;
    const nameId = `char-${characterId}`;
    row.name.id = nameId;
    node.setAttribute('aria-labelledby', nameId);
    row.scroller.setAttribute('aria-labelledby', nameId);
    row.renameInput.id = `rename-${characterId}`;
    part(node, 'renameLabel').setAttribute('for', row.renameInput.id);
    row.strip = setupStrip(row.scroller);

    row.rename.addEventListener('click', () => startRename(characterId));
    row.remove.addEventListener('click', () => deleteCharacter(characterId));
    row.go.addEventListener('click', () => goOnAir(characterId));
    row.makeBase.addEventListener('click', () => {
      const photoId = selectedIn(characterId);
      if (photoId) makeBase(characterId, photoId);
    });
    row.deletePhoto.addEventListener('click', () => {
      const photoId = selectedIn(characterId);
      if (photoId) deletePhoto(characterId, photoId);
    });
    row.renameForm.addEventListener('submit', (event) => {
      event.preventDefault();
      saveRename(characterId);
    });
    row.renameCancel.addEventListener('click', () => cancelRename(characterId));
    row.renameInput.addEventListener('input', () => {
      state.editing.set(characterId, row.renameInput.value);
      row.renameSave.disabled = H.cleanName(row.renameInput.value) === '' || state.busy.has(characterId);
    });
    row.renameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') cancelRename(characterId);
    });
    row.add.addEventListener('click', () => { if (!state.busy.has(characterId)) row.input.click(); });
    row.input.addEventListener('change', () => {
      const files = Array.from(row.input.files || []);
      row.input.value = '';
      addPhotos(characterId, files);
    });
    acceptDrops(node, row.add, files => addPhotos(characterId, files));
    return row;
  }

  // The photo a row has selected right now (its click, else the default), or null.
  function selectedIn(characterId) {
    const character = findCharacter(characterId);
    return character ? H.selectedPhotoId(character, state.picked.get(characterId)) : null;
  }

  function updateRow(row, character) {
    const id = character.id;
    const photos = H.photosOf(character);
    const selectedId = H.selectedPhotoId(character, state.picked.get(id));
    const selected = photos.find(photo => photo.id === selectedId) || null;
    const busy = state.busy.has(id);
    const editing = state.editing.has(id);

    // Left column: the base photo, the name and what the whole character does.
    const base = H.basePhotoOf(character);
    const baseSrc = base ? base.displayUrl || base.url : '';
    if (baseSrc && row.baseImg.getAttribute('src') !== baseSrc) row.baseImg.src = baseSrc;
    row.baseImg.hidden = !baseSrc;
    row.name.textContent = character.name;
    row.name.title = character.name;
    row.nameLine.hidden = editing;
    row.renameForm.hidden = !editing;
    row.tools.hidden = editing;
    row.renameSave.disabled = busy || H.cleanName(row.renameInput.value) === '';
    row.renameCancel.disabled = busy;
    row.renameInput.disabled = busy;
    row.live.hidden = !photos.some(photo => photo.onAir === true);
    row.meta.textContent = H.characterMeta(character);
    row.rename.disabled = busy;
    row.remove.disabled = busy;
    row.rename.setAttribute('aria-label', `${character.name} 이름 바꾸기`);
    row.remove.setAttribute('aria-label', `${character.name} 삭제`);
    row.hint.textContent = H.goHint(character, selectedId);
    row.go.disabled = busy || !selectedId;
    const note = state.rowStatus.get(id);
    setStatus(row.status, note?.text, note?.kind);

    // Right column: the strip of small photos, '+ 사진 추가' last.
    row.add.disabled = busy;
    row.add.setAttribute('aria-busy', String(busy && Boolean(state.busy.get(id))));
    row.add.setAttribute('aria-label', `${character.name}에 사진 추가: 끌어다 놓거나 눌러서 고르기`);
    row.addTitle.textContent = busy && state.busy.get(id) ? state.busy.get(id) : '+ 사진 추가';
    const seen = new Set();
    photos.forEach((photo, index) => {
      seen.add(photo.id);
      let thumb = row.thumbs.get(photo.id);
      if (!thumb) {
        thumb = createThumb(id, photo.id);
        row.thumbs.set(photo.id, thumb);
      }
      updateThumb(thumb, character, photo, selectedId);
      if (row.scroller.children[index] !== thumb.node) row.scroller.insertBefore(thumb.node, row.scroller.children[index] || null);
    });
    for (const [photoId, thumb] of row.thumbs) {
      if (seen.has(photoId)) continue;
      thumb.node.remove();
      row.thumbs.delete(photoId);
    }
    row.strip.refresh();

    renderDetail(row, character, selected, busy);
  }

  function createThumb(characterId, photoId) {
    const node = photoTemplate.content.firstElementChild.cloneNode(true);
    const thumb = { node, img: part(node, 'img'), badges: part(node, 'badges'), cap: part(node, 'cap') };
    node.dataset.id = photoId;
    node.addEventListener('click', () => selectPhoto(characterId, photoId));
    return thumb;
  }

  function updateThumb(thumb, character, photo, selectedId) {
    const selected = photo.id === selectedId;
    const label = H.photoLabel(character, photo.id);
    thumb.node.classList.toggle('is-selected', selected);
    thumb.node.setAttribute('aria-pressed', String(selected));
    const notes = H.photoBadges(photo).map(badge => badge.text).join(', ');
    thumb.node.setAttribute('aria-label', `${label}${notes ? ` (${notes})` : ''}, ${H.motionCaption(photo)}${selected ? ', 선택됨' : ''}`);
    // What OBS shows for the photo: its cutout when the plain background was cut out.
    const src = photo.displayUrl || photo.url;
    if (thumb.img.getAttribute('src') !== src) thumb.img.src = src;
    thumb.badges.replaceChildren(...H.photoBadges(photo).map(badge =>
      el('span', { className: badge.live ? 'tag tag-live' : 'tag', text: badge.text })));
    thumb.cap.textContent = H.motionCaption(photo);
  }

  // The selected photo's own info: how many motions, their names, '기본으로', delete, '동작 추가하러 가기'.
  function renderDetail(row, character, photo, busy) {
    row.detail.hidden = !photo;
    if (!photo) return;
    const label = H.photoLabel(character, photo.id);
    row.detailTitle.textContent = H.selectedTitle(character, photo.id);
    row.detailLive.hidden = photo.onAir !== true;
    row.makeBase.hidden = photo.isBase === true;
    row.makeBase.disabled = busy;
    row.makeBase.setAttribute('aria-label', `${label}: 기본 사진으로 정하기`);
    row.deletePhoto.disabled = busy;
    row.deletePhoto.setAttribute('aria-label', `${label} 삭제`);
    row.count.textContent = H.motionCountText(photo);
    row.count.classList.toggle('has-motions', H.motionCount(photo) > 0);
    const chips = H.motionChips(photo, 24);
    const chipsKey = JSON.stringify(chips);
    if (chipsKey !== row.chipsKey) {
      row.chipsKey = chipsKey;
      row.chips.replaceChildren(...(chips.names.length || chips.more
        ? [
          ...chips.names.map(name => el('span', { className: 'chip', text: name, title: name })),
          chips.more ? el('span', { className: 'chip chip-more', text: `+${chips.more}` }) : null,
        ].filter(Boolean)
        : [el('p', { className: 'empty', text: '아직 동작이 없습니다' })]));
    }
    row.addMotion.setAttribute('href', H.animateHref(photo.id));
    row.addMotion.setAttribute('aria-label', `${label}에 동작 추가하러 가기`);
  }

  // Scroll a photo's strip (never the page) so the small photo is not past an edge.
  function revealPhoto(characterId, photoId) {
    const row = rows.get(characterId);
    const thumb = row?.thumbs.get(photoId);
    if (!thumb) return;
    const box = row.scroller.getBoundingClientRect();
    const rect = thumb.node.getBoundingClientRect();
    const left = box.left + 8;
    const right = box.right - 8;
    if (rect.left < left) row.scroller.scrollLeft -= left - rect.left;
    else if (rect.right > right) row.scroller.scrollLeft += rect.right - right;
  }

  function setRowStatus(characterId, text, kind) {
    if (text) state.rowStatus.set(characterId, { text, kind });
    else state.rowStatus.delete(characterId);
    const row = rows.get(characterId);
    if (row) setStatus(row.status, text, kind);
  }

  function renderRow(characterId) {
    const row = rows.get(characterId);
    const character = findCharacter(characterId);
    if (row && character) updateRow(row, character);
  }

  // ---- Row actions ----
  function selectPhoto(characterId, photoId) {
    const character = findCharacter(characterId);
    if (!character || !H.photosOf(character).some(photo => photo.id === photoId)) return;
    state.picked.set(characterId, photoId);
    setRowStatus(characterId, '');
    renderRow(characterId);
  }

  // One request of a row at a time: its controls are disabled meanwhile. A
  // refusal shows the server's text and refetches (the view may be stale).
  async function rowAction(characterId, run, { busyText = '' } = {}) {
    if (state.busy.has(characterId)) return;
    state.busy.set(characterId, busyText);
    setRowStatus(characterId, '');
    setStatus(pageStatus, '');
    renderRow(characterId);
    try {
      await run();
    } catch (error) {
      setRowStatus(characterId, error.message, 'error');
      scheduleLoad(0);
    } finally {
      state.busy.delete(characterId);
      renderRow(characterId);
    }
  }

  function goOnAir(characterId) {
    const character = findCharacter(characterId);
    const photoId = character ? H.selectedPhotoId(character, state.picked.get(characterId)) : null;
    if (!photoId) return;
    return rowAction(characterId, async () => {
      await api('PUT', '/api/active-photo', { json: { photoId } });
      window.location.assign('/broadcast');
    });
  }

  function makeBase(characterId, photoId) {
    return rowAction(characterId, async () => {
      applyList(await api('PUT', H.basePath(characterId), { json: { photoId } }));
      setRowStatus(characterId, '기본 사진을 바꿨습니다.', 'success');
    });
  }

  function deletePhoto(characterId, photoId) {
    const character = findCharacter(characterId);
    const photo = character ? H.photosOf(character).find(item => item.id === photoId) : null;
    if (!photo) return;
    // The server refuses the only photo (409 last_photo): say so without asking first.
    const refusal = H.photoDeleteRefusal(character);
    if (refusal) {
      setRowStatus(characterId, refusal, 'error');
      return;
    }
    if (!window.confirm(H.photoDeleteConfirm(character, photo))) return;
    return rowAction(characterId, async () => {
      applyList(await api('DELETE', H.photoPath(characterId, photoId)));
      setRowStatus(characterId, '사진을 지웠습니다.', 'success');
    });
  }

  function startRename(characterId) {
    const row = rows.get(characterId);
    const character = findCharacter(characterId);
    if (!row || !character || state.busy.has(characterId)) return;
    state.editing.set(characterId, character.name);
    row.renameInput.value = character.name;
    setRowStatus(characterId, '');
    renderRow(characterId);
    row.renameInput.focus();
    row.renameInput.select();
  }

  function cancelRename(characterId) {
    if (state.busy.has(characterId)) return;
    state.editing.delete(characterId);
    renderRow(characterId);
    rows.get(characterId)?.rename.focus();
  }

  async function saveRename(characterId) {
    const row = rows.get(characterId);
    const character = findCharacter(characterId);
    if (!row || !character) return;
    const name = H.cleanName(row.renameInput.value);
    if (!name) {
      setRowStatus(characterId, H.TEXT.nameMissing, 'error');
      return;
    }
    if (name === character.name) {
      cancelRename(characterId);
      return;
    }
    await rowAction(characterId, async () => {
      const data = await api('PATCH', H.characterPath(characterId), { json: { name } });
      state.editing.delete(characterId);
      applyList(data);
      setRowStatus(characterId, '이름을 바꿨습니다.', 'success');
    });
    // Back on the (enabled again) button once the editor closed.
    if (!state.editing.has(characterId)) rows.get(characterId)?.rename.focus();
  }

  function deleteCharacter(characterId) {
    const character = findCharacter(characterId);
    if (!character || !window.confirm(H.characterDeleteConfirm(character))) return;
    const name = character.name;
    return rowAction(characterId, async () => {
      applyList(await api('DELETE', H.characterPath(characterId)));
      setStatus(pageStatus, `'${name}' 캐릭터를 지웠습니다.`, 'success');
    });
  }

  // Upload images one by one as photos of a character; the last one added is selected.
  async function addPhotos(characterId, files) {
    if (files.length === 0 || state.busy.has(characterId)) return;
    const problems = [];
    const good = [];
    for (const file of files) {
      const problem = H.photoFileProblem(file);
      if (problem) problems.push(`${file.name}: ${problem}`);
      else good.push(file);
    }
    if (!good.length) {
      setRowStatus(characterId, problems.join('\n'), 'error');
      return;
    }
    let lastId = null;
    let added = 0;
    await rowAction(characterId, async () => {
      for (const [index, file] of good.entries()) {
        state.busy.set(characterId, good.length > 1 ? `올리는 중… (${index + 1}/${good.length})` : '올리는 중…');
        renderRow(characterId);
        try {
          const data = await api('POST', H.photosPath(characterId, file.name), { body: file, contentType: file.type || 'application/octet-stream' });
          applyList(data);
          if (data?.photo?.id) lastId = data.photo.id;
          added += 1;
        } catch (error) {
          problems.push(`${file.name}: ${error.message}`);
        }
      }
    });
    if (lastId) {
      state.picked.set(characterId, lastId);
      renderRow(characterId);
      requestAnimationFrame(() => revealPhoto(characterId, lastId));
    }
    if (problems.length) setRowStatus(characterId, problems.join('\n'), 'error');
    else if (added) setRowStatus(characterId, added > 1 ? `사진 ${added}장을 추가했습니다.` : '사진을 추가했습니다.', 'success');
  }

  // ---- 새 캐릭터 만들기 ----
  function renderCreate() {
    const { file, busy, message } = state.create;
    const blocker = H.createBlocker({ name: createName.value, file });
    createBtn.disabled = !H.canCreate({ name: createName.value, file, busy });
    createBtn.textContent = busy ? '만드는 중…' : '만들기';
    createDrop.disabled = busy;
    createDrop.setAttribute('aria-busy', String(busy));
    createDrop.classList.toggle('has-file', Boolean(file));
    createPreview.hidden = !file;
    createDropTitle.textContent = file ? file.name : '+ 기본 사진 올리기';
    createDropSub.hidden = Boolean(file);
    createDropFileSub.hidden = !file;
    createName.disabled = busy;
    // The last refusal until something changes, else what is still missing
    // (said only once the user started: the row is always on the page).
    const started = Boolean(file) || H.cleanName(createName.value) !== '';
    if (message) setStatus(createStatus, message.text, message.kind);
    else setStatus(createStatus, started ? blocker : '', 'warn');
  }

  // The base photo: checked like the server checks it, shown on the checkerboard.
  function setCreateFile(file) {
    if (!file || state.create.busy) return;
    const problem = H.photoFileProblem(file);
    if (problem) {
      state.create.message = { text: problem, kind: 'error' };
      renderCreate();
      return;
    }
    if (state.create.previewUrl) URL.revokeObjectURL(state.create.previewUrl);
    state.create.file = file;
    state.create.previewUrl = URL.createObjectURL(file);
    createPreviewImg.src = state.create.previewUrl;
    state.create.message = null;
    renderCreate();
  }

  function resetCreate() {
    if (state.create.previewUrl) URL.revokeObjectURL(state.create.previewUrl);
    Object.assign(state.create, { file: null, previewUrl: null, message: null });
    createPreviewImg.removeAttribute('src');
    createName.value = '';
  }

  async function createCharacter() {
    const { file } = state.create;
    const name = H.cleanName(createName.value);
    if (!H.canCreate({ name, file, busy: state.create.busy })) return;
    state.create.busy = true;
    state.create.message = null;
    setStatus(pageStatus, '');
    renderCreate();
    try {
      const data = await api('POST', H.createPath(name, file.name), { body: file, contentType: file.type || 'application/octet-stream' });
      resetCreate();
      applyList(data);
      const created = data?.character;
      if (created?.id && rows.has(created.id)) {
        setRowStatus(created.id, `'${created.name}' 캐릭터를 만들었습니다.`, 'success');
        rows.get(created.id).node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    } catch (error) {
      state.create.message = { text: error.message, kind: 'error' };
    } finally {
      state.create.busy = false;
      renderCreate();
    }
  }

  createDrop.addEventListener('click', () => { if (!state.create.busy) createInput.click(); });
  createInput.addEventListener('change', () => {
    const files = Array.from(createInput.files || []);
    createInput.value = '';
    setCreateFile(files[0]);
  });
  acceptDrops(createPanel, createDrop, files => setCreateFile(files.find(H.isImageFile) || files[0]));
  createName.addEventListener('input', () => {
    state.create.message = null;
    renderCreate();
  });
  createName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) createCharacter();
  });
  createBtn.addEventListener('click', createCharacter);

  // Paste (⌘V / Ctrl+V): the copied image becomes the new character's base
  // photo. A paste without an image (text into a name field) is left alone.
  document.addEventListener('paste', (event) => {
    if (state.create.busy) return;
    const pasted = H.pastedImage(event.clipboardData);
    if (!pasted) return;
    event.preventDefault();
    const { file, name } = pasted;
    setCreateFile(name === file.name ? file : new File([file], name, { type: file.type || 'image/png' }));
    createDrop.classList.add('is-dragover');
    setTimeout(() => createDrop.classList.remove('is-dragover'), 600);
  });

  // ---- Live updates ----
  // The server broadcasts the library view (SSE) when the photo on air, its
  // motions or its character's name change; other changes (another tab added a
  // photo, a job added a motion to a photo off air) show when this tab comes back.
  window.addEventListener('focus', () => scheduleLoad(0));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleLoad(0); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) scheduleLoad(0); });
  let everConnected = false;
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    // After a reconnect, refetch what may have changed while disconnected.
    if (everConnected) scheduleLoad();
    everConnected = true;
  });
  events.addEventListener('error', () => {
    // A refused stream (the login ended) is not retried: ask once, so auth.js sends the browser to /login.
    if (events.readyState === EventSource.CLOSED) fetch('/api/auth/me', { cache: 'no-store' }).catch(() => {});
  });
  events.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === 'library' && state.list) scheduleLoad();
  });

  // ---- Boot ----
  render();
  loadList().catch(error => setStatus(pageStatus, `캐릭터를 불러오지 못했습니다: ${error.message}`, 'error'));
})();
