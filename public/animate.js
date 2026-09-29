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

  const DRIVING_BATCH_SIZE = 12;

  /**
   * How many driving cards to render: one batch of 12 at first, one more batch
   * per sentinel hit (`grow`), never fewer than already shown, capped by the total.
   */
  function drivingRenderCount(shown, total, { grow = false } = {}) {
    return motions.motionRenderCount(shown, total, { grow, batchSize: DRIVING_BATCH_SIZE });
  }

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

  /** 'image' (PNG/JPEG/WebP), 'video' (MP4/MOV/WebM) or null, from the MIME type or, when empty, the extension. */
  function fileKind(name, type) {
    const mime = String(type ?? '').toLowerCase();
    if (IMAGE_TYPES.has(mime)) return 'image';
    if (VIDEO_TYPES.has(mime)) return 'video';
    if (mime) return null;
    const ext = /\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
    if (['mp4', 'm4v', 'mov', 'webm'].includes(ext)) return 'video';
    return null;
  }

  /**
   * Horizontal scroll delta for a wheel event over a strip, or 0 to leave the
   * event to the page: only mostly-vertical wheels, only when the strip can
   * scroll, and not past either end.
   */
  function stripWheelDelta({ deltaX = 0, deltaY = 0, deltaMode = 0, ctrlKey = false }, { scrollLeft, scrollWidth, clientWidth }) {
    if (ctrlKey || Math.abs(deltaY) <= Math.abs(deltaX)) return 0;
    const max = scrollWidth - clientWidth;
    if (!(max > 1)) return 0;
    const delta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * clientWidth : deltaY;
    // 1px tolerance: fractional layout and snapping can leave a strip a pixel off its end.
    if (delta > 0 && scrollLeft >= max - 1) return 0;
    if (delta < 0 && scrollLeft <= 1) return 0;
    return delta;
  }

  return {
    DRIVING_BATCH_SIZE,
    drivingRenderCount,
    fileKind,
    stripWheelDelta,
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
  const restoreExamplesBtn = $('restoreExamplesBtn');
  const drivingList = $('drivingList');
  const drivingDrop = $('drivingDrop');
  const drivingDropTitle = $('drivingDropTitle');
  const drivingSentinel = $('drivingSentinel');
  const drivingInput = $('drivingInput');
  const drivingStatus = $('drivingStatus');
  const drivingPreview = $('drivingPreview');
  const characterCard = $('characterCard');
  const characterList = $('characterList');
  const characterDrop = $('characterDrop');
  const characterDropTitle = $('characterDropTitle');
  const characterMeta = $('characterMeta');
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
    characters: [],
    selectedCharacterId: null,
    idle: null, // the idle-image character view from /status, used while the library is empty
    drivings: [],
    hiddenExamples: 0,
    drivingShown: 0,
    drivingId: null,
    routeId: null,
    options: {}, // routeId -> { key: value }
    jobs: [],
    libraryIds: null,
    busy: { fetch: false, restore: false, driving: false, character: false, create: false },
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

  // ---- Horizontal strips (shared by 1 and 2) ----
  // A strip is `.strip > .strip-scroller`; the scroller's first child is a
  // sticky lead tile (drop zone). This adds: vertical wheel -> horizontal
  // scroll, fade edges when there is more to see, and an optional sentinel
  // that asks for the next batch as it nears the right edge.
  function setupStrip(scroller, { sentinel = null, onMore = null } = {}) {
    const wrap = scroller.parentElement;
    const lead = scroller.querySelector('.strip-lead');
    let wheelTimer = null;

    function updateEdges() {
      const max = scroller.scrollWidth - scroller.clientWidth;
      wrap.style.setProperty('--strip-lead', `${lead ? lead.offsetWidth : 0}px`);
      wrap.toggleAttribute('data-more-left', scroller.scrollLeft > 1);
      wrap.toggleAttribute('data-more-right', max > 1 && scroller.scrollLeft < max - 1);
    }

    scroller.addEventListener('wheel', (event) => {
      const delta = H.stripWheelDelta(event, scroller);
      if (!delta) return;
      event.preventDefault();
      // Snapping would pull small wheel steps back; pause it while wheeling.
      scroller.classList.add('is-wheeling');
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => scroller.classList.remove('is-wheeling'), 180);
      scroller.scrollLeft += delta;
    }, { passive: false });
    scroller.addEventListener('scroll', updateEdges, { passive: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(updateEdges).observe(scroller);
    else window.addEventListener('resize', updateEdges);

    const observer = sentinel && onMore && typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.isIntersecting)) onMore();
      }, { root: scroller, rootMargin: '0px 300px 0px 0px' })
      : null;

    return {
      // Call after every render. `more` = whether unrendered items remain.
      refresh({ more = false } = {}) {
        if (sentinel) {
          sentinel.hidden = !more;
          if (observer) {
            observer.unobserve(sentinel);
            // Re-observing delivers a fresh entry, so a sentinel still in range
            // after a batch keeps loading until it leaves the range.
            if (more) observer.observe(sentinel);
          }
        }
        updateEdges();
      },
    };
  }

  // Replace a strip's tiles, keeping its lead tile (and sentinel) in place so
  // a focused drop zone keeps focus.
  function setTiles(scroller, nodes, tail = null) {
    for (const child of [...scroller.children]) {
      if (child.classList.contains('strip-lead') || child === tail) continue;
      child.remove();
    }
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    scroller.insertBefore(fragment, tail);
  }

  // Drag-and-drop of files onto `target`, shown as the drag-over state on `zone`.
  function acceptDrops(target, zone, onFiles) {
    let depth = 0;
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const clear = () => { depth = 0; zone.classList.remove('is-dragover'); };
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
      clear();
      onFiles(Array.from(event.dataTransfer.files || []));
    });
  }

  // A file dropped outside a drop zone must not navigate away from the page.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
    });
  }

  // ---- 1. Driving videos ----
  const drivingStrip = setupStrip(drivingList, {
    sentinel: drivingSentinel,
    onMore: () => {
      const next = H.drivingRenderCount(state.drivingShown, state.drivings.length, { grow: true });
      if (next <= state.drivingShown) return;
      state.drivingShown = next;
      renderDrivings();
    },
  });

  function renderDrivings() {
    const missing = state.drivings.some(d => d.kind === 'example' && !d.available);
    exampleBar.hidden = !missing;
    fetchExamplesBtn.disabled = state.busy.fetch;
    fetchExamplesBtn.textContent = state.busy.fetch ? '받는 중…' : '예시 영상 받기';
    // Deleted examples are hidden, not gone: offer to bring them back.
    restoreExamplesBtn.hidden = !(state.hiddenExamples > 0);
    restoreExamplesBtn.disabled = state.busy.restore;
    restoreExamplesBtn.textContent = `숨긴 예시 ${state.hiddenExamples}개 되돌리기`;

    // Keep a valid selection: the current one if still available, else the first available.
    if (!state.drivings.some(d => d.id === state.drivingId && d.available)) {
      state.drivingId = state.drivings.find(d => d.available)?.id || null;
    }
    // Live refreshes never shrink what is rendered; the selected card is always rendered.
    const selectedIndex = state.drivings.findIndex(d => d.id === state.drivingId);
    state.drivingShown = Math.max(
      H.drivingRenderCount(state.drivingShown, state.drivings.length),
      Math.min(state.drivings.length, selectedIndex + 1),
    );

    drivingDrop.setAttribute('aria-busy', String(state.busy.driving));

    const focusedId = drivingList.contains(document.activeElement) && document.activeElement.name === 'driving'
      ? document.activeElement.value : null;
    setTiles(drivingList, state.drivings.slice(0, state.drivingShown).map(drivingCard), drivingSentinel);
    if (focusedId) drivingList.querySelector(`input[value="${CSS.escape(focusedId)}"]`)?.focus();
    drivingStrip.refresh({ more: state.drivingShown < state.drivings.length });
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
    // Uploads are deleted; examples are hidden (restorable from the strip).
    card.append(el('button', {
      type: 'button',
      className: 'driving-delete',
      'aria-label': `${driving.label} 삭제`,
      title: '삭제',
      text: '×',
      onclick: () => deleteDriving(driving),
    }));
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
    state.hiddenExamples = Number(data?.hiddenExamples) || 0;
    renderDrivings();
    renderRoutes();
  }

  restoreExamplesBtn.addEventListener('click', async () => {
    if (state.busy.restore) return;
    state.busy.restore = true;
    renderDrivings();
    setStatus(drivingStatus, '');
    try {
      await api('POST', '/api/animate/examples/restore', { json: {} });
    } catch (error) {
      setStatus(drivingStatus, `되돌리기 실패: ${error.message}`, 'error');
    } finally {
      state.busy.restore = false;
    }
    try { await loadDrivings(); } catch (error) { setStatus(drivingStatus, error.message, 'error'); }
  });

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

  // Upload driving videos one by one; the last uploaded one becomes selected.
  async function uploadDrivings(files) {
    if (state.busy.driving || files.length === 0) return;
    const videos = files.filter(file => H.fileKind(file.name, file.type) === 'video');
    const errors = [];
    if (videos.length < files.length) errors.push('영상 파일만 올릴 수 있습니다');
    const fitting = videos.filter(file => file.size <= MAX_DRIVING_BYTES);
    if (fitting.length < videos.length) errors.push('200MB 이하만 올릴 수 있습니다');
    setStatus(drivingStatus, errors.join(' · '), errors.length ? 'error' : null);
    if (fitting.length === 0) return;
    state.busy.driving = true;
    renderDrivings();
    let lastId = null;
    try {
      for (const [index, file] of fitting.entries()) {
        drivingDropTitle.textContent = fitting.length > 1 ? `올리는 중… (${index + 1}/${fitting.length})` : '올리는 중…';
        try {
          const driving = await api('POST', '/api/animate/drivings?name=' + encodeURIComponent(file.name), {
            body: file,
            contentType: H.videoContentType(file.name, file.type),
          });
          if (driving?.id && driving.available !== false) lastId = driving.id;
        } catch (error) {
          errors.push(`올리기 실패: ${error.message}`);
          setStatus(drivingStatus, errors.join(' · '), 'error');
        }
      }
    } finally {
      state.busy.driving = false;
      drivingDropTitle.textContent = '+ 내 영상 올리기';
    }
    if (lastId) state.drivingId = lastId;
    try { await loadDrivings(); } catch (error) { setStatus(drivingStatus, error.message, 'error'); }
  }

  drivingDrop.addEventListener('click', () => { if (!state.busy.driving) drivingInput.click(); });
  drivingInput.addEventListener('change', () => {
    const files = Array.from(drivingInput.files || []);
    drivingInput.value = '';
    uploadDrivings(files);
  });
  acceptDrops(drivingDrop, drivingDrop, uploadDrivings);

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
  const characterStrip = setupStrip(characterList);

  // The character a new job would use: the selected library item, else the idle image.
  function currentCharacter() {
    const selected = state.characters.find(c => c.id === state.selectedCharacterId);
    if (selected) return { source: 'upload', ...selected };
    return state.characters.length === 0 && state.idle ? state.idle : null;
  }

  function renderCharacters() {
    characterDrop.setAttribute('aria-busy', String(state.busy.character));
    const active = document.activeElement;
    const focusedId = characterList.contains(active) ? active.closest('.char-tile')?.dataset.id : null;
    const focusedDelete = Boolean(focusedId) && active.classList.contains('char-delete');
    const tiles = state.characters.map(characterTile);
    if (state.characters.length === 0 && state.idle) tiles.push(idleTile(state.idle));
    setTiles(characterList, tiles);
    if (focusedId) {
      const tile = characterList.querySelector(`.char-tile[data-id="${CSS.escape(focusedId)}"]`);
      (focusedDelete ? tile?.querySelector('.char-delete') : tile?.querySelector('.char-pick'))?.focus({ preventScroll: true });
    }
    characterStrip.refresh();

    const c = currentCharacter();
    const meta = [];
    if (c?.source === 'idle') meta.push('대기 이미지 사용 중');
    else if (c) meta.push(`선택: ${c.filename || ''}`);
    else meta.push('캐릭터 이미지를 올려 주세요');
    if (c && c.width && c.height) meta.push(`${c.width}×${c.height}`);
    characterMeta.textContent = meta.join(' · ');
  }

  function tileParts(src, name, selected) {
    return [
      el('span', { className: 'char-thumb checkerboard' }, [
        el('img', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: false }),
      ]),
      el('span', { className: 'char-name', text: name, title: name }),
      selected ? el('span', { className: 'char-check', 'aria-hidden': 'true', text: '✓' }) : null,
    ];
  }

  function characterTile(character) {
    const selected = character.id === state.selectedCharacterId;
    const name = character.filename || '캐릭터';
    const [thumb, label, check] = tileParts(character.url, name, selected);
    return el('div', {
      className: 'char-tile' + (selected ? ' is-selected' : ''),
      role: 'listitem',
      dataset: { id: character.id },
    }, [
      el('button', {
        type: 'button',
        className: 'char-pick',
        'aria-pressed': String(selected),
        'aria-label': `${name}${selected ? ' (선택됨)' : ' 선택'}`,
        onclick: () => selectCharacter(character),
      }, [thumb, label]),
      check,
      el('button', {
        type: 'button',
        className: 'char-delete',
        'aria-label': `${name} 삭제`,
        title: '삭제',
        text: '×',
        onclick: () => deleteCharacter(character),
      }),
    ]);
  }

  function idleTile(idle) {
    const [thumb, label, check] = tileParts(idle.url, '대기 이미지', true);
    return el('div', { className: 'char-tile char-idle is-selected', role: 'listitem', dataset: { id: 'idle' } }, [
      el('button', { type: 'button', className: 'char-pick', 'aria-pressed': 'true', 'aria-label': '대기 이미지 (사용 중)' }, [thumb, label]),
      check,
      el('span', { className: 'char-tag', text: '사용 중' }),
    ]);
  }

  async function applyCharacters(data) {
    if (!data || !Array.isArray(data.characters)) return;
    state.characters = data.characters;
    state.selectedCharacterId = typeof data.selectedId === 'string' ? data.selectedId : null;
    if (state.characters.length === 0) {
      // The idle fallback may only be known now that the library is empty.
      try {
        const status = await api('GET', '/api/animate/status');
        state.idle = status?.character?.source === 'idle' ? status.character : null;
      } catch { /* keep what we had */ }
    }
    renderCharacters();
    renderCreate();
  }

  async function loadCharacters() {
    await applyCharacters(await api('GET', '/api/animate/characters'));
  }

  // Upload images one by one; each upload becomes the selected one.
  async function uploadCharacters(files) {
    if (state.busy.character || files.length === 0) return;
    const images = files.filter(file => H.fileKind(file.name, file.type) === 'image');
    const errors = [];
    if (images.length < files.length) errors.push('이미지 파일만 올릴 수 있습니다');
    const fitting = images.filter(file => file.size <= MAX_CHARACTER_BYTES);
    if (fitting.length < images.length) errors.push('20MB 이하만 올릴 수 있습니다');
    setStatus(characterStatus, errors.join(' · '), errors.length ? 'error' : null);
    if (fitting.length === 0) return;
    state.busy.character = true;
    renderCharacters();
    try {
      for (const [index, file] of fitting.entries()) {
        characterDropTitle.textContent = fitting.length > 1 ? `올리는 중… (${index + 1}/${fitting.length})` : '올리는 중…';
        try {
          const data = await api('POST', '/api/animate/characters?name=' + encodeURIComponent(file.name), {
            body: file,
            contentType: file.type || 'application/octet-stream',
          });
          await applyCharacters(data);
        } catch (error) {
          errors.push(`올리기 실패: ${error.message}`);
          setStatus(characterStatus, errors.join(' · '), 'error');
        }
      }
    } finally {
      state.busy.character = false;
      characterDropTitle.textContent = '이미지를 끌어다 놓으세요';
      renderCharacters();
    }
    characterList.scrollTo({ left: 0, behavior: 'smooth' });
  }

  async function selectCharacter(character) {
    if (character.id === state.selectedCharacterId) return;
    setStatus(characterStatus, '');
    try {
      await applyCharacters(await api('POST', `/api/animate/characters/${encodeURIComponent(character.id)}/select`, { json: {} }));
      // The selected tile moves to the front.
      characterList.scrollTo({ left: 0, behavior: 'smooth' });
    } catch (error) {
      setStatus(characterStatus, `선택 실패: ${error.message}`, 'error');
      loadCharacters().catch(() => {});
    }
  }

  async function deleteCharacter(character) {
    if (!window.confirm('이 캐릭터를 지울까요?')) return;
    setStatus(characterStatus, '');
    try {
      await applyCharacters(await api('DELETE', `/api/animate/characters/${encodeURIComponent(character.id)}`));
    } catch (error) {
      setStatus(characterStatus, `삭제 실패: ${error.message}`, 'error');
      loadCharacters().catch(() => {});
    }
  }

  characterDrop.addEventListener('click', () => { if (!state.busy.character) characterInput.click(); });
  characterInput.addEventListener('change', () => {
    const files = Array.from(characterInput.files || []);
    characterInput.value = '';
    uploadCharacters(files);
  });
  acceptDrops(characterCard, characterDrop, uploadCharacters);

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
    if ('character' in data) {
      state.idle = data.character?.source === 'idle' ? data.character : null;
      renderCharacters();
    }
    renderRoutes();
  }

  // ---- Create ----
  function createBlocker() {
    const driving = selectedDriving();
    const route = selectedRoute();
    if (state.ffmpeg && state.ffmpeg.available === false) return 'ffmpeg가 필요합니다';
    if (!driving) return '동작 영상을 고르세요';
    if (!currentCharacter()) return '캐릭터를 올리세요';
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
  renderCharacters();
  renderDrivings();
  renderCreate();
  (async () => {
    const results = await Promise.allSettled([
      api('GET', '/api/animate/status').then(applyStatus),
      loadDrivings(),
      loadCharacters(),
      loadJobs(),
    ]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) {
      globalStatus.hidden = false;
      globalStatus.textContent = `불러오기 실패: ${failed.reason?.message || ''}`;
    }
  })();
})();
