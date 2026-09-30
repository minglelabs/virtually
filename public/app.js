'use strict';

// Controller: motion buttons, OBS Browser Source guide, and a large live overlay preview.
// The preset catalog and the DOM-free helpers live in motions.js (loaded first).

(() => {
  const { buildMotionItems, motionRenderCount } = window.VirtuallyMotions;
  const PLAYING_TIMEOUT_MS = 15000;

  const urlInput = document.getElementById('overlayUrlInput');
  const settingUrl = document.getElementById('settingUrl');
  const copyBtn = document.getElementById('copyUrlBtn');
  const refreshBtn = document.getElementById('refreshOverlayBtn');
  const frame = document.getElementById('overlayPreviewFrame');
  const motionList = document.getElementById('motionList');
  const motionStatus = document.getElementById('motionStatus');
  const motionSentinel = document.getElementById('motionSentinel');
  const idleBtn = document.getElementById('idleBtn');

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

  // ---- True-scale canvas preview ----
  // The overlay renders at the OBS browser-source size (reported by the overlay running
  // inside OBS; 800 x 600, the OBS browser-source default, until then) and is scaled to fit the stage.
  const DEFAULT_CANVAS = { width: 800, height: 600 };
  const CANVAS_BORDER = 2; // 1px border on each side, outside the scaled box
  const CAPTION_TAIL = ' · 체크무늬 부분은 투명하게 송출됩니다.';
  const stage = document.querySelector('.stage');
  const canvasBox = document.getElementById('canvasBox');
  const canvasCaption = document.getElementById('canvasCaption');
  // Mirrors the narrow layout in app.css, where the stage has no fixed height.
  const narrowQuery = window.matchMedia('(max-width: 800px)');
  let canvasSize = DEFAULT_CANVAS;

  function fitCanvas() {
    const byWidth = Math.max(0, stage.clientWidth - CANVAS_BORDER) / canvasSize.width;
    const byHeight = Math.max(0, stage.clientHeight - CANVAS_BORDER) / canvasSize.height;
    const scale = narrowQuery.matches ? byWidth : Math.min(byWidth, byHeight);
    canvasBox.style.setProperty('--canvas-scale', String(scale));
  }

  // size: {width, height} from the server, or null before OBS has reported one.
  function setCanvasSize(size) {
    const reported = Boolean(size && Number.isInteger(size.width) && Number.isInteger(size.height));
    canvasSize = reported ? { width: size.width, height: size.height } : DEFAULT_CANVAS;
    canvasBox.style.setProperty('--canvas-w', `${canvasSize.width}px`);
    canvasBox.style.setProperty('--canvas-h', `${canvasSize.height}px`);
    canvasCaption.textContent = reported
      ? `OBS 소스 ${canvasSize.width} × ${canvasSize.height}${CAPTION_TAIL}`
      : `${DEFAULT_CANVAS.width} × ${DEFAULT_CANVAS.height} (OBS 연결 전)${CAPTION_TAIL}`;
    fitCanvas();
  }

  setCanvasSize(null); // initial pass before first paint
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitCanvas).observe(stage);
  else window.addEventListener('resize', fitCanvas);
  narrowQuery.addEventListener('change', fitCanvas);

  refreshBtn.addEventListener('click', () => {
    frame.src = './overlay?t=' + Date.now();
  });

  // ---- Motion buttons ----
  let items = buildMotionItems(null);
  let shownCount = 0;
  let playingKey = null;
  let playingTimer = null;
  let lastOverlayIdleAt = 0;

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

  async function errorMessage(response) {
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') return body.error;
    } catch { /* keep the status text */ }
    return `HTTP ${response.status}`;
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
      if (!response.ok) throw new Error(await errorMessage(response));
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

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== 'virtually-overlay') return;
    if (event.data.state === 'idle') {
      lastOverlayIdleAt = performance.now();
      setPlaying(null);
    }
  });

  render();

  // The server sends the library and the OBS source size on connect and after every
  // change; EventSource reconnects itself.
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
    } else if (data?.type === 'obs-source') {
      setCanvasSize(data);
    }
  });
})();
