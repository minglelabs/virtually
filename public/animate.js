'use strict';

// Animate page: pick a driving video, attach a character, run an AI animate
// route, watch the results and add one as a library motion.
// All names and labels are user or provider data: the DOM is built with
// createElement/textContent only, never from HTML strings.

const AnimateHelpers = (() => {
  const motions = typeof window !== 'undefined' && window.VirtuallyMotions
    ? window.VirtuallyMotions
    : require('./motions.js');

  const JOB_STATE_LABELS = Object.freeze({
    queued: '대기',
    preparing: '준비',
    submitting: '전송',
    running: '생성 중',
    downloading: '받는 중',
    succeeded: '완료',
    failed: '실패',
    canceled: '취소',
  });
  const ACTIVE_STATES = new Set(['queued', 'preparing', 'submitting', 'running', 'downloading']);

  // API error code -> short Korean text. Unknown codes fall back to the server message.
  const ERROR_TEXT = Object.freeze({
    unknown_route: '알 수 없는 모델입니다',
    route_unavailable: '지금 쓸 수 없는 모델입니다',
    no_credentials: 'API 키가 필요합니다',
    no_media_relay: '업로드용 키(WaveSpeed·fal·Higgsfield)가 필요합니다',
    character_missing: '캐릭터 이미지가 없습니다',
    driving_missing: '동작 영상이 없습니다',
    driving_unavailable: '예시 영상을 먼저 받아 주세요',
    driving_too_long: '영상이 모델 제한보다 깁니다',
    driving_too_short: '영상이 모델 최소 길이보다 짧습니다',
    ffmpeg_unavailable: 'ffmpeg가 필요합니다',
    not_confirmed: '확인이 필요합니다',
    fetch_in_progress: '이미 받는 중입니다',
    example_readonly: '예시 영상은 지울 수 없습니다',
    not_ready: '아직 완료되지 않았습니다',
    already_added: '이미 추가했습니다',
    interrupted: '서버 재시작으로 중단됐습니다',
    canceled: '취소됐습니다',
    moderation: '콘텐츠 정책에 걸렸습니다',
    upload_failed: '파일 업로드 실패',
    submit_failed: '생성 요청 실패',
    generation_failed: 'AI 생성 실패',
    download_failed: '결과 받기 실패',
  });

  /** Korean text for an API error `{ code, error|message, detail }`. */
  function errorText(error) {
    if (!error || typeof error !== 'object') return '알 수 없는 오류';
    const code = typeof error.code === 'string' ? error.code : null;
    if (code === 'route_unavailable' && error.detail && ERROR_TEXT[error.detail.unavailableCode]) {
      return ERROR_TEXT[error.detail.unavailableCode];
    }
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
    const message = typeof error.error === 'string' ? error.error : error.message;
    return typeof message === 'string' && message ? message : '알 수 없는 오류';
  }

  /** Options a route actually exposes as selects (fixed value lists only). */
  function selectableOptions(route) {
    return (Array.isArray(route?.options) ? route.options : [])
      .filter(o => o && typeof o.key === 'string' && Array.isArray(o.values) && o.values.length > 0);
  }

  /** The chosen option values for a route: `chosen` where valid, else each default. */
  function effectiveOptions(route, chosen = {}) {
    const out = {};
    for (const option of selectableOptions(route)) {
      const value = chosen[option.key];
      out[option.key] = option.values.includes(value)
        ? value
        : (option.values.includes(option.default) ? option.default : option.values[0]);
    }
    return out;
  }

  /** USD estimate for `seconds` of video, mirroring the server's registry.estimateUsd. Null if unknown. */
  function estimateUsd(route, seconds, options = {}) {
    const pricing = route?.pricing;
    if (!pricing || typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    let rate = pricing.usdPerSecond;
    if (pricing.byOption) {
      for (const [key, table] of Object.entries(pricing.byOption)) {
        const value = options[key];
        if (value != null && table && table[value] != null) rate = table[value];
      }
    }
    if (!Number.isFinite(rate)) return null;
    const billed = Math.max(Number(pricing.minSeconds) || 0, seconds);
    return Number((rate * billed).toFixed(4));
  }

  function formatUsd(usd) {
    return Number.isFinite(usd) ? `약 $${usd.toFixed(2)}` : '';
  }

  function formatSeconds(seconds) {
    return Number.isFinite(seconds) && seconds > 0 ? `${Math.round(seconds)}초` : '';
  }

  /** Longest driving video a route accepts, in seconds, or null. */
  function routeMaxSeconds(route) {
    const max = Number(route?.limits?.videoMaxSec);
    return Number.isFinite(max) && max > 0 ? max : null;
  }

  function isMockRoute(route) {
    return route?.provider === 'mock';
  }

  /**
   * How a route row behaves: `selectable` (radio enabled), `needsKey` (show the
   * "키 필요" link to the key panel), `tooLong` (driving exceeds the route limit).
   */
  function routeState(route, drivingSeconds) {
    const max = routeMaxSeconds(route);
    const tooLong = max != null && Number.isFinite(drivingSeconds) && drivingSeconds > max;
    return {
      selectable: Boolean(route?.available),
      needsKey: !route?.available && route?.unavailableCode === 'no_credentials',
      tooLong,
    };
  }

  /** Routes grouped by familyLabel, groups and routes in server order. */
  function groupRoutes(routes) {
    const groups = [];
    const byLabel = new Map();
    for (const route of Array.isArray(routes) ? routes : []) {
      const label = String(route?.familyLabel ?? route?.family ?? '');
      let group = byLabel.get(label);
      if (!group) {
        group = { familyLabel: label, routes: [] };
        byLabel.set(label, group);
        groups.push(group);
      }
      group.routes.push(route);
    }
    return groups;
  }

  /** Default name for a result added as a motion: the preset label, else the driving label. */
  function defaultMotionName(job) {
    return motions.presetLabel(job?.presetKey) || String(job?.drivingLabel ?? '');
  }

  function timeValue(value) {
    const t = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  /** Insert or replace `job` (by id) and keep the list newest first. Returns a new array. */
  function upsertJob(jobs, job) {
    if (!job || typeof job.id !== 'string') return jobs;
    const next = jobs.filter(j => j.id !== job.id);
    next.push(job);
    next.sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt));
    return next;
  }

  /**
   * Whether a succeeded job counts as already added. `libraryIds` is a Set of the
   * current library motion ids, or null before the first library snapshot (then
   * any recorded motionId counts as added).
   */
  function isAdded(job, libraryIds) {
    if (!job?.motionId) return false;
    return libraryIds == null || libraryIds.has(job.motionId);
  }

  /** "12:34" today, "9/28 12:34" otherwise. */
  function formatTime(value, now = Date.now()) {
    const t = timeValue(value);
    if (!t) return '';
    const date = new Date(t);
    const pad = n => String(n).padStart(2, '0');
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const today = new Date(now);
    const sameDay = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
  }

  /** "상태 · 42%" from providerStatus and a 0..1 progress. */
  function progressText(job) {
    const parts = [];
    if (typeof job?.providerStatus === 'string' && job.providerStatus) parts.push(job.providerStatus);
    if (Number.isFinite(job?.progress)) {
      parts.push(`${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}%`);
    }
    return parts.join(' · ');
  }

  /** Content-Type for an uploaded driving video (browsers may leave file.type empty). */
  function videoContentType(name, type) {
    if (type === 'video/mp4' || type === 'video/quicktime' || type === 'video/webm') return type;
    const ext = /\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase();
    return { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext]
      || 'application/octet-stream';
  }

  return {
    JOB_STATE_LABELS,
    ACTIVE_STATES,
    errorText,
    selectableOptions,
    effectiveOptions,
    estimateUsd,
    formatUsd,
    formatSeconds,
    routeMaxSeconds,
    isMockRoute,
    routeState,
    groupRoutes,
    defaultMotionName,
    upsertJob,
    isAdded,
    formatTime,
    progressText,
    videoContentType,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AnimateHelpers;

if (typeof document !== 'undefined') (() => {
  const H = AnimateHelpers;
  const MAX_DRIVING_BYTES = 200 * 1024 * 1024;
  const MAX_CHARACTER_BYTES = 20 * 1024 * 1024;

  const $ = id => document.getElementById(id);
  const globalStatus = $('globalStatus');
  const exampleBar = $('exampleBar');
  const fetchExamplesBtn = $('fetchExamplesBtn');
  const drivingList = $('drivingList');
  const drivingInput = $('drivingInput');
  const drivingStatus = $('drivingStatus');
  const drivingPreview = $('drivingPreview');
  const characterImg = $('characterImg');
  const characterEmpty = $('characterEmpty');
  const characterMeta = $('characterMeta');
  const characterIdle = $('characterIdle');
  const characterUploadBtn = $('characterUploadBtn');
  const characterRemoveBtn = $('characterRemoveBtn');
  const characterInput = $('characterInput');
  const characterStatus = $('characterStatus');
  const routeList = $('routeList');
  const routeOptions = $('routeOptions');
  const keyPanel = $('keyPanel');
  const keyList = $('keyList');
  const createBtn = $('createBtn');
  const createStatus = $('createStatus');
  const jobsEmpty = $('jobsEmpty');
  const jobList = $('jobList');
  const confirmDialog = $('confirmDialog');

  const state = {
    ffmpeg: null,
    routes: [],
    providers: [],
    character: null,
    characterVersion: Date.now(),
    drivings: [],
    drivingId: null,
    routeId: null,
    options: {}, // routeId -> { key: value }
    jobs: [],
    libraryIds: null,
    busy: { fetch: false, driving: false, character: false, create: false },
  };

  // ---- Small DOM helpers ----
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  class ApiError extends Error {
    constructor(body, status) {
      super(H.errorText(body));
      this.code = body?.code || null;
      this.detail = body?.detail || null;
      this.status = status;
    }
  }

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
      throw new ApiError({ error: '서버에 연결할 수 없습니다' }, 0);
    }
    let data = null;
    try { data = await response.json(); } catch { /* empty or non-JSON */ }
    if (!response.ok) throw new ApiError(data || { error: `HTTP ${response.status}` }, response.status);
    return data;
  }

  const selectedDriving = () => state.drivings.find(d => d.id === state.drivingId) || null;
  const selectedRoute = () => state.routes.find(r => r.id === state.routeId) || null;

  // ---- 1. Driving videos ----
  function renderDrivings() {
    const missing = state.drivings.some(d => d.kind === 'example' && !d.available);
    exampleBar.hidden = !missing;
    fetchExamplesBtn.disabled = state.busy.fetch;
    fetchExamplesBtn.textContent = state.busy.fetch ? '받는 중…' : '예시 영상 받기';

    // Keep a valid selection: the current one if still available, else the first available.
    if (!state.drivings.some(d => d.id === state.drivingId && d.available)) {
      state.drivingId = state.drivings.find(d => d.available)?.id || null;
    }

    const focusedId = drivingList.contains(document.activeElement) ? document.activeElement.value : null;
    const fragment = document.createDocumentFragment();
    for (const driving of state.drivings) fragment.append(drivingCard(driving));
    fragment.append(el('div', { className: 'driving-card driving-add' }, [
      el('button', {
        type: 'button',
        className: 'driving-add-btn',
        disabled: state.busy.driving,
        text: state.busy.driving ? '올리는 중…' : '+ 내 영상 올리기',
        onclick: () => drivingInput.click(),
      }),
    ]));
    drivingList.replaceChildren(fragment);
    if (focusedId) drivingList.querySelector(`input[value="${CSS.escape(focusedId)}"]`)?.focus();
    renderPreview();
  }

  function drivingCard(driving) {
    const checked = driving.id === state.drivingId;
    const radio = el('input', {
      type: 'radio',
      name: 'driving',
      className: 'visually-hidden',
      value: driving.id,
      checked,
      disabled: !driving.available,
      onchange: () => {
        state.drivingId = driving.id;
        for (const card of drivingList.querySelectorAll('.driving-card')) {
          card.classList.toggle('is-selected', card.dataset.id === driving.id);
        }
        renderPreview();
        renderRoutes();
      },
    });
    const poster = driving.posterUrl
      ? el('img', { className: 'driving-poster', src: driving.posterUrl, alt: '', loading: 'lazy' })
      : el('span', { className: 'driving-poster driving-poster-empty', text: driving.available ? '' : '없음' });
    const meta = [driving.label, H.formatSeconds(driving.duration)];
    const label = el('label', { className: 'driving-pick' }, [
      radio,
      poster,
      el('span', { className: 'driving-name', text: meta[0] }),
      meta[1] ? el('span', { className: 'driving-len', text: meta[1] }) : null,
    ]);
    const card = el('div', {
      className: 'driving-card' + (checked ? ' is-selected' : '') + (driving.available ? '' : ' is-unavailable'),
      dataset: { id: driving.id },
    }, [label]);

    const credit = driving.credit;
    if (credit && (credit.author || credit.license)) {
      const text = [credit.author, credit.license].filter(Boolean).join(' · ');
      const href = safeHttpUrl(credit.sourcePage);
      card.append(href
        ? el('a', { className: 'driving-credit', href, target: '_blank', rel: 'noopener noreferrer', text })
        : el('span', { className: 'driving-credit', text }));
    }
    if (driving.kind === 'upload') {
      card.append(el('button', {
        type: 'button',
        className: 'driving-delete',
        'aria-label': `${driving.label} 삭제`,
        title: '삭제',
        text: '×',
        onclick: () => deleteDriving(driving),
      }));
    }
    return card;
  }

  // Only http(s) links from the manifest are rendered as links.
  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function renderPreview() {
    const driving = selectedDriving();
    const url = driving?.url || null;
    drivingPreview.hidden = !url;
    if (!url) {
      if (drivingPreview.getAttribute('src')) {
        drivingPreview.removeAttribute('src');
        drivingPreview.load();
      }
      return;
    }
    if (drivingPreview.getAttribute('src') !== url) {
      drivingPreview.src = url;
      if (driving.posterUrl) drivingPreview.poster = driving.posterUrl;
      else drivingPreview.removeAttribute('poster');
      drivingPreview.play().catch(() => { /* autoplay may be blocked; controls remain */ });
    }
  }

  async function loadDrivings() {
    const data = await api('GET', '/api/animate/drivings');
    state.drivings = Array.isArray(data?.drivings) ? data.drivings : [];
    renderDrivings();
    renderRoutes();
  }

  fetchExamplesBtn.addEventListener('click', async () => {
    state.busy.fetch = true;
    renderDrivings();
    setStatus(drivingStatus, '');
    try {
      const data = await api('POST', '/api/animate/examples/fetch', { json: {} });
      if (Array.isArray(data?.drivings)) state.drivings = data.drivings;
      const failed = (data?.results || []).filter(r => !r.ok);
      if (failed.length) setStatus(drivingStatus, `${failed.length}개 받기 실패`, 'error');
    } catch (error) {
      setStatus(drivingStatus, error.message, 'error');
    } finally {
      state.busy.fetch = false;
    }
    try { await loadDrivings(); } catch (error) { setStatus(drivingStatus, error.message, 'error'); }
  });

  drivingInput.addEventListener('change', async () => {
    const file = drivingInput.files[0];
    drivingInput.value = '';
    if (!file) return;
    if (file.size > MAX_DRIVING_BYTES) {
      setStatus(drivingStatus, '200MB 이하만 올릴 수 있습니다', 'error');
      return;
    }
    state.busy.driving = true;
    renderDrivings();
    setStatus(drivingStatus, '');
    try {
      const driving = await api('POST', '/api/animate/drivings?name=' + encodeURIComponent(file.name), {
        body: file,
        contentType: H.videoContentType(file.name, file.type),
      });
      state.busy.driving = false;
      await loadDrivings();
      if (driving?.id && driving.available !== false) {
        state.drivingId = driving.id;
        renderDrivings();
        renderRoutes();
      }
    } catch (error) {
      setStatus(drivingStatus, `올리기 실패: ${error.message}`, 'error');
    } finally {
      state.busy.driving = false;
      renderDrivings();
    }
  });

  async function deleteDriving(driving) {
    if (!window.confirm(`'${driving.label}' 영상을 지울까요?`)) return;
    try {
      await api('DELETE', '/api/animate/drivings/' + encodeURIComponent(driving.id));
      await loadDrivings();
    } catch (error) {
      setStatus(drivingStatus, `삭제 실패: ${error.message}`, 'error');
    }
  }

  // ---- 2. Character ----
  function renderCharacter() {
    const c = state.character;
    characterImg.hidden = !c;
    characterEmpty.hidden = Boolean(c);
    if (c) {
      const sep = c.url.includes('?') ? '&' : '?';
      const src = `${c.url}${sep}v=${state.characterVersion}`;
      if (characterImg.getAttribute('src') !== src) characterImg.src = src;
    } else {
      characterImg.removeAttribute('src');
    }
    const meta = [];
    if (c?.source === 'upload' && c.filename) meta.push(c.filename);
    if (c && c.width && c.height) meta.push(`${c.width}×${c.height}`);
    characterMeta.textContent = meta.join(' · ');
    characterMeta.hidden = meta.length === 0;
    characterIdle.hidden = c?.source !== 'idle';
    characterUploadBtn.textContent = state.busy.character ? '올리는 중…' : (c ? '바꾸기' : '이미지 올리기');
    characterUploadBtn.disabled = state.busy.character;
    characterRemoveBtn.hidden = c?.source !== 'upload';
    characterRemoveBtn.disabled = state.busy.character;
  }

  function setCharacter(character) {
    state.character = character && typeof character.url === 'string' ? character : null;
    state.characterVersion = Date.now();
    renderCharacter();
    renderCreate();
  }

  characterUploadBtn.addEventListener('click', () => characterInput.click());

  characterInput.addEventListener('change', async () => {
    const file = characterInput.files[0];
    characterInput.value = '';
    if (!file) return;
    if (file.size > MAX_CHARACTER_BYTES) {
      setStatus(characterStatus, '20MB 이하만 올릴 수 있습니다', 'error');
      return;
    }
    state.busy.character = true;
    renderCharacter();
    setStatus(characterStatus, '');
    try {
      const character = await api('POST', '/api/animate/character?name=' + encodeURIComponent(file.name), {
        body: file,
        contentType: file.type || 'application/octet-stream',
      });
      state.busy.character = false;
      setCharacter(character);
    } catch (error) {
      setStatus(characterStatus, `올리기 실패: ${error.message}`, 'error');
    } finally {
      state.busy.character = false;
      renderCharacter();
    }
  });

  characterRemoveBtn.addEventListener('click', async () => {
    state.busy.character = true;
    renderCharacter();
    setStatus(characterStatus, '');
    try {
      const data = await api('DELETE', '/api/animate/character');
      state.busy.character = false;
      setCharacter(data?.character || null);
    } catch (error) {
      setStatus(characterStatus, `삭제 실패: ${error.message}`, 'error');
    } finally {
      state.busy.character = false;
      renderCharacter();
    }
  });

  // ---- 3. Routes ----
  function routeOptionsFor(route) {
    return H.effectiveOptions(route, state.options[route.id] || {});
  }

  function routeCost(route) {
    if (H.isMockRoute(route)) return '무료';
    const seconds = selectedDriving()?.duration;
    return H.formatUsd(H.estimateUsd(route, seconds, routeOptionsFor(route)));
  }

  function renderRoutes() {
    // Keep the selection if it is still available, else the first available route.
    if (!state.routes.some(r => r.id === state.routeId && r.available)) {
      state.routeId = state.routes.find(r => r.available)?.id || null;
    }
    const seconds = selectedDriving()?.duration;
    const focusedId = routeList.contains(document.activeElement) ? document.activeElement.value : null;
    const fragment = document.createDocumentFragment();
    if (state.routes.length === 0) fragment.append(el('p', { className: 'muted', text: '모델 없음' }));
    for (const group of H.groupRoutes(state.routes)) {
      const rows = group.routes.map(route => routeRow(route, H.routeState(route, seconds)));
      fragment.append(el('fieldset', { className: 'route-group' }, [
        el('legend', { text: group.familyLabel }),
        ...rows,
      ]));
    }
    routeList.replaceChildren(fragment);
    if (focusedId) routeList.querySelector(`input[value="${CSS.escape(focusedId)}"]`)?.focus();
    renderRouteOptions();
    renderCreate();
  }

  function routeRow(route, rs) {
    const badges = [];
    if (!route.verified) badges.push(el('span', { className: 'badge', text: '검증 전' }));
    if (rs.tooLong) badges.push(el('span', { className: 'badge badge-warn', text: `최대 ${Math.floor(H.routeMaxSeconds(route))}초` }));
    if (!route.available && !rs.needsKey) {
      badges.push(el('span', {
        className: 'badge badge-muted',
        text: route.unavailableCode === 'no_media_relay' ? '업로드 키 필요' : '사용 불가',
        title: H.errorText({ code: route.unavailableCode }),
      }));
    }
    const cost = route.available ? routeCost(route) : '';
    const label = el('label', { className: 'route-pick' }, [
      el('input', {
        type: 'radio',
        name: 'route',
        value: route.id,
        checked: route.id === state.routeId,
        disabled: !rs.selectable,
        onchange: () => {
          state.routeId = route.id;
          renderRoutes();
        },
      }),
      el('span', { className: 'route-name', text: route.label }),
      route.providerLabel && route.providerLabel !== route.label
        ? el('span', { className: 'route-provider', text: route.providerLabel })
        : null,
      ...badges,
      cost ? el('span', { className: 'route-cost', text: cost }) : null,
    ]);
    const row = el('div', {
      className: 'route-row' + (rs.selectable ? '' : ' is-disabled') + (route.id === state.routeId ? ' is-selected' : ''),
    }, [label]);
    if (rs.needsKey) {
      row.append(el('button', {
        type: 'button',
        className: 'badge badge-key',
        text: '키 필요',
        onclick: () => openKeyPanel(route.provider),
      }));
    }
    return row;
  }

  function renderRouteOptions() {
    const route = selectedRoute();
    const options = route ? H.selectableOptions(route) : [];
    const chosen = route ? routeOptionsFor(route) : {};
    routeOptions.replaceChildren(...options.map(option => {
      const id = `opt-${option.key}`;
      const select = el('select', {
        id,
        className: 'select-sm',
        onchange: () => {
          state.options[route.id] = { ...(state.options[route.id] || {}), [option.key]: select.value };
          renderRoutes();
        },
      }, option.values.map(value => el('option', { value: String(value), text: String(value) })));
      select.value = String(chosen[option.key]);
      return el('div', { className: 'route-option' }, [
        el('label', { for: id, text: option.label || option.key }),
        select,
      ]);
    }));
    routeOptions.hidden = options.length === 0;
  }

  // ---- API keys ----
  function openKeyPanel(providerId) {
    keyPanel.open = true;
    const box = keyList.querySelector(`[data-provider="${CSS.escape(String(providerId))}"]`);
    if (!box) return;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    box.querySelector('input, select')?.focus({ preventScroll: true });
  }

  function renderKeys() {
    const providers = state.providers.filter(p => (p.credentials || []).length || (p.settings || []).length);
    if (providers.length === 0) {
      keyList.replaceChildren(el('p', { className: 'muted', text: '설정할 키가 없습니다' }));
      return;
    }
    keyList.replaceChildren(...providers.map(providerBox));
  }

  function providerBox(provider) {
    const status = el('span', { className: 'status', 'aria-live': 'polite' });
    const inputs = [];
    const rows = [];
    for (const cred of provider.credentials || []) {
      const id = `key-${provider.id}-${cred.key}`;
      const placeholder = cred.source === 'env' ? '환경변수 사용 중' : (cred.masked || '');
      const input = el('input', {
        id,
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder,
        dataset: { key: cred.key },
      });
      inputs.push(input);
      const clear = cred.source === 'config'
        ? el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-sm',
          text: '지우기',
          onclick: () => saveProvider(provider, { [cred.key]: '' }, status),
        })
        : null;
      rows.push(el('div', { className: 'key-row' }, [
        el('label', { for: id, text: cred.label + (cred.optional ? ' (선택)' : '') }),
        el('div', { className: 'row' }, [input, clear]),
      ]));
    }
    for (const setting of provider.settings || []) {
      if (!Array.isArray(setting.values) || setting.values.length === 0) continue;
      const id = `set-${provider.id}-${setting.key}`;
      const select = el('select', { id, className: 'select-sm', dataset: { key: setting.key, setting: '1' } },
        setting.values.map(value => el('option', { value: String(value), text: String(value) })));
      select.value = String(setting.value ?? setting.values[0]);
      select.dataset.initial = select.value;
      inputs.push(select);
      rows.push(el('div', { className: 'key-row' }, [el('label', { for: id, text: setting.label }), select]));
    }
    const docs = safeHttpUrl(provider.docs);
    const save = el('button', {
      type: 'submit',
      className: 'btn btn-sm',
      text: '저장',
    });
    const form = el('form', {
      className: 'key-provider',
      dataset: { provider: provider.id },
      onsubmit: (event) => {
        event.preventDefault();
        const fields = {};
        for (const input of inputs) {
          if (input.dataset.setting) {
            if (input.value !== input.dataset.initial) fields[input.dataset.key] = input.value;
          } else if (input.value.trim()) {
            fields[input.dataset.key] = input.value.trim();
          }
        }
        if (Object.keys(fields).length === 0) {
          setStatus(status, '바뀐 값이 없습니다');
          return;
        }
        saveProvider(provider, fields, status);
      },
    }, [
      el('div', { className: 'key-title' }, [
        el('strong', { text: provider.label }),
        el('span', { className: provider.configured ? 'badge badge-ok' : 'badge badge-muted', text: provider.configured ? '설정됨' : '미설정' }),
        docs ? el('a', { className: 'link', href: docs, target: '_blank', rel: 'noopener noreferrer', text: '문서' }) : null,
      ]),
      ...rows,
      el('div', { className: 'row' }, [save, status]),
    ]);
    return form;
  }

  async function saveProvider(provider, fields, status) {
    setStatus(status, '저장 중…');
    try {
      const data = await api('PUT', '/api/animate/config', { json: { providers: { [provider.id]: fields } } });
      applyStatus(data);
      // The panel re-renders; show the result in the new box.
      const box = keyList.querySelector(`[data-provider="${CSS.escape(provider.id)}"] .status`);
      if (box) setStatus(box, '저장했습니다', 'success');
    } catch (error) {
      setStatus(status, error.message, 'error');
    }
  }

  function applyStatus(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.routes)) state.routes = data.routes;
    if (Array.isArray(data.providers)) {
      state.providers = data.providers;
      renderKeys();
    }
    if ('ffmpeg' in data) {
      state.ffmpeg = data.ffmpeg;
      const ok = data.ffmpeg?.available !== false;
      globalStatus.hidden = ok;
      globalStatus.textContent = ok ? '' : 'ffmpeg가 없어 영상을 처리할 수 없습니다';
    }
    if ('character' in data) setCharacter(data.character);
    renderRoutes();
  }

  // ---- Create ----
  function createBlocker() {
    const driving = selectedDriving();
    const route = selectedRoute();
    if (state.ffmpeg && state.ffmpeg.available === false) return 'ffmpeg가 필요합니다';
    if (!driving) return '동작 영상을 고르세요';
    if (!state.character) return '캐릭터를 올리세요';
    if (!route) return '모델을 고르세요';
    if (H.routeState(route, driving.duration).tooLong) return '영상이 모델 제한보다 깁니다';
    return null;
  }

  function renderCreate() {
    const blocker = createBlocker();
    createBtn.disabled = Boolean(blocker) || state.busy.create;
    createBtn.textContent = state.busy.create ? '요청 중…' : '동작 만들기';
    createBtn.title = blocker || '';
    // Show why the button is disabled, without hiding a result or error message.
    if (blocker && (!createStatus.dataset.kind || createStatus.dataset.kind === 'hint')) {
      setStatus(createStatus, blocker, 'hint');
    } else if (!blocker && createStatus.dataset.kind === 'hint') {
      setStatus(createStatus, '');
    }
  }

  function confirmCreate(route, driving) {
    $('confirmModel').textContent = `${route.label} · ${route.providerLabel}`;
    $('confirmLength').textContent = H.formatSeconds(driving.duration) || '알 수 없음';
    $('confirmCost').textContent = routeCost(route) || '알 수 없음';
    return new Promise((resolve) => {
      confirmDialog.returnValue = '';
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
      confirmDialog.showModal();
    });
  }

  createBtn.addEventListener('click', async () => {
    if (createBlocker()) return;
    const route = selectedRoute();
    const driving = selectedDriving();
    const mock = H.isMockRoute(route);
    if (!mock && !(await confirmCreate(route, driving))) return;
    state.busy.create = true;
    renderCreate();
    setStatus(createStatus, '');
    try {
      const payload = { drivingId: driving.id, routeId: route.id, options: routeOptionsFor(route) };
      if (!mock) payload.confirmed = true;
      const data = await api('POST', '/api/animate/jobs', { json: payload });
      if (data?.job) upsertJob(data.job);
      setStatus(createStatus, '요청했습니다', 'success');
      jobList.firstElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (error) {
      setStatus(createStatus, error.message, 'error');
    } finally {
      state.busy.create = false;
      renderCreate();
    }
  });

  // ---- 4. Jobs ----
  // Rows are keyed by job id and patched in place so a playing result video is
  // not reset by unrelated updates.
  const rows = new Map(); // id -> { li, head, body, media, actions, mediaKey, actionsKey }
  const nameDrafts = new Map(); // job id -> typed motion name
  const addBusy = new Set();
  const addErrors = new Map();

  function upsertJob(job) {
    state.jobs = H.upsertJob(state.jobs, job);
    renderJobs();
  }

  function renderJobs() {
    jobsEmpty.hidden = state.jobs.length > 0;
    const seen = new Set();
    state.jobs.forEach((job, index) => {
      seen.add(job.id);
      let row = rows.get(job.id);
      if (!row) {
        row = createRow();
        rows.set(job.id, row);
      }
      updateRow(row, job);
      if (jobList.children[index] !== row.li) jobList.insertBefore(row.li, jobList.children[index] || null);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.li.remove();
        rows.delete(id);
      }
    }
  }

  function createRow() {
    const head = el('div', { className: 'job-head' });
    const info = el('p', { className: 'job-info' });
    const media = el('div', { className: 'job-media' });
    const actions = el('div', { className: 'job-actions' });
    const li = el('li', { className: 'job' }, [head, info, media, actions]);
    return { li, head, info, media, actions, mediaKey: null, actionsKey: null };
  }

  function updateRow(row, job) {
    const stateLabel = H.JOB_STATE_LABELS[job.state] || String(job.state ?? '');
    row.li.dataset.state = String(job.state ?? '');
    row.head.replaceChildren(
      el('span', { className: `badge badge-state state-${job.state}`, text: stateLabel }),
      el('span', { className: 'job-title', text: `${job.routeLabel || job.routeId || ''} · ${job.drivingLabel || ''}` }),
      el('time', { className: 'job-time', dateTime: String(job.createdAt ?? ''), text: H.formatTime(job.createdAt) }),
    );

    let info = '';
    let infoKind = null;
    if (H.ACTIVE_STATES.has(job.state)) info = H.progressText(job);
    else if (job.state === 'failed') { info = H.errorText(job.error); infoKind = 'error'; }
    row.info.textContent = info;
    row.info.hidden = !info;
    if (infoKind) row.info.dataset.kind = infoKind;
    else delete row.info.dataset.kind;

    const mediaKey = job.state === 'succeeded' && job.result?.url ? job.result.url : null;
    if (mediaKey !== row.mediaKey) {
      row.mediaKey = mediaKey;
      row.media.replaceChildren(mediaKey
        ? el('video', {
          className: 'job-video',
          src: mediaKey,
          poster: job.result.posterUrl || null,
          controls: true,
          playsInline: true,
          preload: 'metadata',
        })
        : '');
      row.media.hidden = !mediaKey;
    }

    const added = H.isAdded(job, state.libraryIds);
    const actionsKey = JSON.stringify([job.state, added, addBusy.has(job.id), addErrors.get(job.id) || null]);
    if (actionsKey !== row.actionsKey) {
      row.actionsKey = actionsKey;
      row.actions.replaceChildren(...jobActions(job, added).filter(node => node != null));
    }
  }

  function jobActions(job, added) {
    if (H.ACTIVE_STATES.has(job.state)) {
      const cancel = el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        text: '취소',
        onclick: async () => {
          cancel.disabled = true;
          try {
            upsertJob(await api('POST', `/api/animate/jobs/${encodeURIComponent(job.id)}/cancel`, { json: {} }));
          } catch (error) {
            setStatus(createStatus, `취소 실패: ${error.message}`, 'error');
            cancel.disabled = false;
          }
        },
      });
      return [cancel];
    }
    if (job.state !== 'succeeded') return [];
    if (added) {
      return [el('span', { className: 'job-added' }, [
        '추가됨 · ',
        el('a', { className: 'link', href: './', text: '메인에서 보기' }),
      ])];
    }
    const inputId = `name-${job.id}`;
    const input = el('input', {
      id: inputId,
      type: 'text',
      className: 'name-input',
      maxLength: 100,
      value: nameDrafts.has(job.id) ? nameDrafts.get(job.id) : H.defaultMotionName(job),
      oninput: () => nameDrafts.set(job.id, input.value),
    });
    const busy = addBusy.has(job.id);
    const error = addErrors.get(job.id);
    return [
      el('label', { for: inputId, className: 'visually-hidden', text: '동작 이름' }),
      input,
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        disabled: busy,
        text: busy ? '추가 중…' : '동작으로 추가하기',
        onclick: () => addMotion(job, input.value),
      }),
      error ? el('span', { className: 'status', dataset: { kind: 'error' }, text: error }) : null,
    ];
  }

  async function addMotion(job, rawName) {
    const name = String(rawName ?? '').trim();
    addBusy.add(job.id);
    addErrors.delete(job.id);
    renderJobs();
    try {
      const data = await api('POST', `/api/animate/jobs/${encodeURIComponent(job.id)}/motion`, {
        json: name ? { name } : {},
      });
      if (data?.motion?.id && state.libraryIds) state.libraryIds.add(data.motion.id);
      addBusy.delete(job.id);
      nameDrafts.delete(job.id);
      if (data?.job) upsertJob(data.job);
    } catch (error) {
      addBusy.delete(job.id);
      if (error.code === 'already_added') {
        // Our view was stale: fetch the job to pick up its motionId.
        if (error.detail?.motionId && state.libraryIds) state.libraryIds.add(error.detail.motionId);
        try { upsertJob(await api('GET', `/api/animate/jobs/${encodeURIComponent(job.id)}`)); } catch { /* keep */ }
      } else {
        addErrors.set(job.id, error.message);
      }
    } finally {
      addBusy.delete(job.id);
      renderJobs();
    }
  }

  async function loadJobs() {
    const data = await api('GET', '/api/animate/jobs');
    // Replace wholesale (newest first) so jobs removed on the server disappear too.
    state.jobs = [];
    for (const job of Array.isArray(data?.jobs) ? data.jobs : []) state.jobs = H.upsertJob(state.jobs, job);
    renderJobs();
  }

  // ---- Live updates ----
  let everConnected = false;
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    // After a reconnect, refetch what may have changed while disconnected.
    if (everConnected) loadJobs().catch(() => {});
    everConnected = true;
  });
  events.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === 'animate-job' && data.job) {
      upsertJob(data.job);
    } else if (data?.type === 'library') {
      const list = Array.isArray(data.library?.motions) ? data.library.motions : [];
      state.libraryIds = new Set(list.filter(m => m && typeof m.id === 'string').map(m => m.id));
      // A job whose motion was deleted from the library can be added again.
      renderJobs();
    }
  });

  // ---- Boot ----
  renderCharacter();
  renderCreate();
  (async () => {
    const results = await Promise.allSettled([
      api('GET', '/api/animate/status').then(applyStatus),
      loadDrivings(),
      loadJobs(),
    ]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) {
      globalStatus.hidden = false;
      globalStatus.textContent = `불러오기 실패: ${failed.reason?.message || ''}`;
    }
  })();
})();
