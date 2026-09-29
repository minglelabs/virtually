'use strict';

// Controller: motion buttons, OBS Browser Source guide, and a large live overlay preview.

// Preset motions shown as buttons, in display order (shared catalog).
const PRESET_MOTIONS = [
  { key: 'hi', label: '인사 (Hi)' },
  { key: 'wink', label: '윙크' },
  { key: 'cheek-heart', label: '볼하트' },
  { key: 'finger-heart', label: '손하트' },
  { key: 'kpop-heart', label: 'K-pop 하트' },
  { key: 'clap-laugh', label: '박수치며 웃음' },
  { key: 'dont-know', label: "I don't know 포즈" },
  { key: 'wonyoung-turn', label: '원영턴' },
  { key: 'bad-challenge', label: 'BAD 챌린지 춤' },
];

const SUB_VIDEO = '영상';
const SUB_NO_VIDEO = '영상 없음 · 데모 재생';
const SUB_DEMO = '기본 아바타';

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Build the ordered list of motion buttons from a library snapshot.
 * A preset links to the first library motion (library order) whose trimmed,
 * case-insensitive name equals the preset key or label; unlinked presets trigger 'demo'.
 * Each item: { key, label, sub, triggerId, linked }.
 */
function buildMotionItems(library) {
  const motions = Array.isArray(library?.motions)
    ? library.motions.filter(m => m && typeof m.id === 'string')
    : [];
  const linkedIds = new Set();
  const items = [{ key: 'demo', label: '데모 동작', sub: SUB_DEMO, triggerId: 'demo', linked: false }];

  for (const preset of PRESET_MOTIONS) {
    const names = new Set([normalizeName(preset.key), normalizeName(preset.label)]);
    const match = motions.find(m => names.has(normalizeName(m.name)));
    if (match) linkedIds.add(match.id);
    items.push({
      key: `preset:${preset.key}`,
      label: preset.label,
      sub: match ? SUB_VIDEO : SUB_NO_VIDEO,
      triggerId: match ? match.id : 'demo',
      linked: Boolean(match),
    });
  }

  for (const motion of motions) {
    if (linkedIds.has(motion.id)) continue;
    items.push({
      key: `motion:${motion.id}`,
      label: String(motion.name ?? ''),
      sub: SUB_VIDEO,
      triggerId: motion.id,
      linked: true,
    });
  }
  return items;
}

// Motion buttons are rendered in batches as the list scrolls into view.
const MOTION_BATCH_SIZE = 30;

/**
 * How many of `total` motion items to render.
 * Without `grow` (initial render or a library update) keep what is already shown,
 * but at least one batch; with `grow` (the sentinel came into view) add one batch.
 * Never exceeds `total`.
 */
function motionRenderCount(shown, total, { grow = false, batchSize = MOTION_BATCH_SIZE } = {}) {
  const safeShown = Math.max(0, Number.isFinite(shown) ? Math.floor(shown) : 0);
  const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
  const target = grow ? safeShown + batchSize : Math.max(safeShown, batchSize);
  return Math.min(safeTotal, target);
}

/** True for a file name the add button accepts (.webm, case-insensitive). */
function isWebmFileName(name) {
  return /\.webm$/i.test(String(name ?? '').trim());
}

/**
 * Index of the button that plays library motion `motionId`: the preset it links to,
 * or its own button. -1 when this snapshot does not contain the motion yet.
 */
function motionItemIndex(items, motionId) {
  if (typeof motionId !== 'string' || motionId === 'demo') return -1;
  return items.findIndex(item => item.triggerId === motionId);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PRESET_MOTIONS, buildMotionItems, MOTION_BATCH_SIZE, motionRenderCount, isWebmFileName, motionItemIndex };
}

if (typeof document !== 'undefined') (() => {
  const PLAYING_TIMEOUT_MS = 15000;

  const urlInput = document.getElementById('overlayUrlInput');
  const settingUrl = document.getElementById('settingUrl');
  const copyBtn = document.getElementById('copyUrlBtn');
  const refreshBtn = document.getElementById('refreshOverlayBtn');
  const frame = document.getElementById('overlayPreviewFrame');
  const motionList = document.getElementById('motionList');
  const motionStatus = document.getElementById('motionStatus');
  const motionSentinel = document.getElementById('motionSentinel');
  const motionHeader = document.querySelector('.motion-header');
  const motionFooter = document.querySelector('.motion-footer');
  const idleBtn = document.getElementById('idleBtn');
  const addMotionBtn = document.getElementById('addMotionBtn');
  const addMotionInput = document.getElementById('addMotionInput');
  const uploadStatus = document.getElementById('uploadStatus');
  const NEW_HIGHLIGHT_MS = 1500;
  const UPLOAD_SUCCESS_CLEAR_MS = 4000;

  const overlayUrl = new URL('/overlay', window.location.origin).href;
  urlInput.value = overlayUrl;
  settingUrl.textContent = overlayUrl;

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(urlInput.value);
    } catch {
      // Clipboard API can be unavailable (non-secure context); fall back to selection.
      urlInput.select();
      document.execCommand('copy');
    }
    copyBtn.textContent = '복사됨';
    setTimeout(() => { copyBtn.textContent = 'URL 복사'; }, 1500);
  });

  refreshBtn.addEventListener('click', () => {
    frame.src = './overlay?t=' + Date.now();
  });

  // ---- Motion buttons ----
  let items = buildMotionItems(null);
  let shownCount = 0;
  let playingKey = null;
  let playingTimer = null;
  let lastOverlayIdleAt = 0;
  // Just-added motion: its button key gets the brief highlight (survives re-renders).
  let highlightKey = null;
  let highlightTimer = null;
  // Uploaded motion ids waiting for the library update that contains them.
  const pendingReveal = new Set();

  function setStatus(text, kind) {
    motionStatus.textContent = text;
    if (kind) motionStatus.dataset.kind = kind;
    else delete motionStatus.dataset.kind;
  }

  function applyPlayingState() {
    for (const button of motionList.querySelectorAll('button')) {
      const playing = button.dataset.key === playingKey;
      button.classList.toggle('is-playing', playing);
      button.setAttribute('aria-pressed', playing ? 'true' : 'false');
      button.classList.toggle('is-new', button.dataset.key === highlightKey);
    }
  }

  function setPlaying(key) {
    clearTimeout(playingTimer);
    playingTimer = null;
    playingKey = key;
    if (key) {
      playingTimer = setTimeout(() => setPlaying(null), PLAYING_TIMEOUT_MS);
    }
    applyPlayingState();
  }

  // root: null watches the viewport, so it works both inside the scrolling pane
  // (ancestor clipping applies) and when the page itself scrolls (narrow layout).
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) loadMore();
    }, { root: null, rootMargin: '300px 0px' })
    : null;
  let observing = false;

  function updateSentinel() {
    const done = shownCount >= items.length;
    motionSentinel.hidden = done;
    if (!observer) return;
    if (observing) observer.unobserve(motionSentinel);
    observing = false;
    if (!done) {
      // Re-observing delivers a fresh entry, so a sentinel that is still in view
      // after a batch keeps loading until it leaves the viewport.
      observer.observe(motionSentinel);
      observing = true;
    }
  }

  function loadMore() {
    const next = motionRenderCount(shownCount, items.length, { grow: true });
    if (next <= shownCount) return;
    shownCount = next;
    render();
  }

  function render() {
    // Without IntersectionObserver, render everything.
    shownCount = observer ? motionRenderCount(shownCount, items.length) : items.length;
    const fragment = document.createDocumentFragment();
    for (const item of items.slice(0, shownCount)) {
      // Motion names are user data: build with textContent only.
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'motion-btn' + (item.linked ? ' is-linked' : '');
      button.dataset.key = item.key;
      const label = document.createElement('span');
      label.className = 'motion-label';
      label.textContent = item.label;
      const sub = document.createElement('span');
      sub.className = 'motion-sub';
      sub.textContent = item.sub;
      button.append(label, sub);
      fragment.append(button);
    }
    // Keep keyboard focus on the same logical button across re-renders.
    const focusedKey = motionList.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    motionList.replaceChildren(fragment);
    if (playingKey && !items.some(item => item.key === playingKey)) setPlaying(null);
    applyPlayingState();
    if (focusedKey) {
      const again = [...motionList.children].find(el => el.dataset.key === focusedKey);
      if (again) again.focus();
    }
    updateSentinel();
  }

  async function trigger(item) {
    const clickedAt = performance.now();
    setStatus('');
    try {
      const response = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.triggerId }),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body && typeof body.error === 'string') message = body.error;
        } catch { /* keep the status text */ }
        throw new Error(message);
      }
      // If the overlay already went back to idle (very short/failed clip), do not mark it.
      if (lastOverlayIdleAt > clickedAt) return;
      setPlaying(item.key);
    } catch (error) {
      setStatus(`재생 요청 실패: ${error.message}`);
    }
  }

  motionList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-key]');
    if (!button) return;
    const item = items.find(value => value.key === button.dataset.key);
    if (item) trigger(item);
  });

  async function errorMessage(response) {
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') return body.error;
    } catch { /* keep the status text */ }
    return `HTTP ${response.status}`;
  }

  // ---- Back to idle ----
  idleBtn.addEventListener('click', async () => {
    setStatus('');
    try {
      const response = await fetch('/api/idle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      // The playing mark clears through the preview's 'idle' message.
    } catch (error) {
      setStatus(`대기 전환 실패: ${error.message}`);
    }
  });

  // ---- Add motions ----
  let uploadClearTimer = null;
  function setUploadStatus(text, kind) {
    clearTimeout(uploadClearTimer);
    uploadClearTimer = null;
    uploadStatus.textContent = text;
    if (kind) uploadStatus.dataset.kind = kind;
    else delete uploadStatus.dataset.kind;
    if (kind === 'success') {
      uploadClearTimer = setTimeout(() => setUploadStatus(''), UPLOAD_SUCCESS_CLEAR_MS);
    }
  }

  // Render, scroll to and briefly highlight the button that plays `motionId`.
  // Returns false when the current snapshot does not contain it yet.
  function reveal(motionId) {
    const index = motionItemIndex(items, motionId);
    if (index < 0) return false;
    const key = items[index].key;
    clearTimeout(highlightTimer);
    highlightKey = key;
    highlightTimer = setTimeout(() => {
      highlightKey = null;
      applyPlayingState();
    }, NEW_HIGHLIGHT_MS);
    if (index >= shownCount) shownCount = index + 1;
    render();
    const button = [...motionList.children].find(el => el.dataset.key === key);
    if (button) {
      // Keep the button clear of the sticky header and footer.
      button.style.scrollMarginTop = `${motionHeader.offsetHeight + 8}px`;
      button.style.scrollMarginBottom = `${motionFooter.offsetHeight + 8}px`;
      button.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }

  addMotionBtn.addEventListener('click', () => addMotionInput.click());

  addMotionInput.addEventListener('change', async () => {
    const files = [...addMotionInput.files];
    // Reset so picking the same file again fires 'change'.
    addMotionInput.value = '';
    if (files.length === 0) return;
    addMotionBtn.disabled = true;
    let lastError = null;
    try {
      for (const [index, file] of files.entries()) {
        if (!isWebmFileName(file.name)) {
          lastError = `WebM 파일만 추가할 수 있습니다: ${file.name}`;
          setUploadStatus(lastError, 'error');
          continue;
        }
        setUploadStatus(`추가하는 중 (${index + 1}/${files.length}): ${file.name}`);
        try {
          const response = await fetch('/api/upload?kind=motion&name=' + encodeURIComponent(file.name), {
            method: 'POST',
            // Always video/webm: some systems label .webm as audio/webm, which the server rejects.
            headers: { 'Content-Type': 'video/webm' },
            body: file,
          });
          if (!response.ok) throw new Error(await errorMessage(response));
          const motion = await response.json();
          setUploadStatus(`추가했습니다: ${motion.name}`, 'success');
          // The library broadcast may arrive before or after this response.
          if (!reveal(motion.id)) pendingReveal.add(motion.id);
        } catch (error) {
          lastError = `추가 실패: ${file.name} · ${error.message}`;
          setUploadStatus(lastError, 'error');
        }
      }
      // With several files, keep the last failure visible instead of a later success.
      if (lastError && files.length > 1) setUploadStatus(lastError, 'error');
    } finally {
      addMotionBtn.disabled = false;
    }
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== 'virtually-overlay') return;
    if (event.data.state === 'idle') {
      lastOverlayIdleAt = performance.now();
      setPlaying(null);
    }
  });

  render();

  // The server sends the library on connect and after every change; EventSource reconnects itself.
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    if (motionStatus.dataset.kind === 'connection') setStatus('');
  });
  events.addEventListener('error', () => {
    setStatus('서버 연결이 끊겼습니다. 다시 연결하는 중입니다.', 'connection');
  });
  events.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data?.type === 'library') {
      items = buildMotionItems(data.library);
      render();
      for (const id of [...pendingReveal]) {
        if (reveal(id)) pendingReveal.delete(id);
      }
    }
  });
})();
