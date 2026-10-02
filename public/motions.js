'use strict';

// Shared motion catalog: the single source of the preset motions and the
// DOM-free helpers built on it. Loaded as a plain <script> (exposes
// window.VirtuallyMotions) by the controller and the animate page, and
// require()-able from node tests.
(function (root) {
  // Preset motions shown as buttons, in display order.
  const PRESET_MOTIONS = Object.freeze([
    { key: 'hi', label: '인사 (Hi)' },
    { key: 'wink', label: '윙크' },
    { key: 'cheek-heart', label: '볼하트' },
    { key: 'finger-heart', label: '손하트' },
    { key: 'kpop-heart', label: 'K-pop 하트' },
    { key: 'clap-laugh', label: '박수치며 웃음' },
    { key: 'dont-know', label: "I don't know 포즈" },
    { key: 'wonyoung-turn', label: '원영턴' },
    { key: 'bad-challenge', label: 'BAD 챌린지 춤' },
  ].map(preset => Object.freeze(preset)));

  // The name of a photo's default idle motion (lib/idle.js on the server decides which
  // motion loops as the idle; a result made from an idle loop gets this name).
  const IDLE_MOTION_NAME = '기본 대기 동작';

  const SUB_VIDEO = '영상';
  const SUB_NO_VIDEO = '영상 없음 · 데모 재생';
  const SUB_DEMO = '기본 아바타';
  // A preset without its video while a photo is on air: disabled, never the demo.
  const SUB_NO_VIDEO_ON_AIR = '영상 없음';

  function normalizeName(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  /** The preset label for `key`, or null when `key` is not a preset key. */
  function presetLabel(key) {
    const preset = PRESET_MOTIONS.find(p => p.key === key);
    return preset ? preset.label : null;
  }

  /**
   * The id of the photo on air in a library view (GET /api/library, SSE
   * `library`), or null: the one rule for "a photo is on air" on the client
   * (app.js uses it; overlay.js mirrors it and a test keeps the two equal).
   */
  function onAirPhotoId(library) {
    const photo = library && typeof library === 'object' ? library.photo : null;
    return photo && typeof photo === 'object' && typeof photo.id === 'string' && photo.id ? photo.id : null;
  }

  /**
   * Build the ordered list of motion buttons from a library snapshot.
   * A preset links to the first library motion (library order) whose trimmed,
   * case-insensitive name equals the preset key or label; unlinked presets trigger 'demo'.
   * With a photo on air the demo avatar never replaces it: there is no 데모 동작
   * item, and an unlinked preset is { sub: '영상 없음', triggerId: null, disabled: true }.
   * Each item: { key, label, sub, triggerId, linked, disabled? }.
   */
  function buildMotionItems(library) {
    const motions = Array.isArray(library?.motions)
      ? library.motions.filter(m => m && typeof m.id === 'string')
      : [];
    const onAir = onAirPhotoId(library) !== null;
    const linkedIds = new Set();
    const items = onAir ? [] : [{ key: 'demo', label: '데모 동작', sub: SUB_DEMO, triggerId: 'demo', linked: false }];

    for (const preset of PRESET_MOTIONS) {
      const names = new Set([normalizeName(preset.key), normalizeName(preset.label)]);
      const match = motions.find(m => names.has(normalizeName(m.name)));
      const key = `preset:${preset.key}`;
      if (match) {
        linkedIds.add(match.id);
        items.push({ key, label: preset.label, sub: SUB_VIDEO, triggerId: match.id, linked: true });
      } else if (onAir) {
        items.push({ key, label: preset.label, sub: SUB_NO_VIDEO_ON_AIR, triggerId: null, linked: false, disabled: true });
      } else {
        items.push({ key, label: preset.label, sub: SUB_NO_VIDEO, triggerId: 'demo', linked: false });
      }
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

  /**
   * The server's event stream (/api/events) that survives a restart of the server. A
   * browser retries an EventSource by itself only after a network drop; when the answer
   * is an error page (a deploy: the proxy says 502 for a few seconds) it gives up for
   * good, and the page would never hear anything again. Then a new one is opened after
   * RETRY_MS. handlers: { open(), message(event), error(closed) }.
   *
   * The stream starts with { type: 'build', id } (the deployment). A reconnect that hears
   * another id reached a newly deployed server: the page reloads to run its new code.
   */
  const RETRY_MS = 3000;
  let seenBuild = null;
  function noteBuild(event, reload) {
    if (typeof event?.data !== 'string' || !event.data.includes('"build"')) return false;
    let data;
    try { data = JSON.parse(event.data); } catch { return false; }
    if (data?.type !== 'build' || typeof data.id !== 'string' || !data.id) return false;
    if (seenBuild === null) seenBuild = data.id;
    else if (seenBuild !== data.id) { seenBuild = data.id; reload(); }
    return true;
  }
  function liveEvents(url, handlers = {}) {
    let source = null;
    let timer = null;
    const connect = () => {
      timer = null;
      source = new EventSource(url);
      if (handlers.open) source.addEventListener('open', () => handlers.open());
      source.addEventListener('message', (event) => {
        if (noteBuild(event, () => root && root.location.reload())) return;
        if (handlers.message) handlers.message(event);
      });
      source.addEventListener('error', () => {
        const closed = source.readyState === EventSource.CLOSED;
        if (handlers.error) handlers.error(closed);
        if (closed && !timer) timer = setTimeout(connect, RETRY_MS);
      });
    };
    connect();
    return { close() { clearTimeout(timer); if (source) source.close(); } };
  }

  const api = Object.freeze({
    liveEvents,
    noteBuild,
    PRESET_MOTIONS,
    IDLE_MOTION_NAME,
    normalizeName,
    presetLabel,
    onAirPhotoId,
    buildMotionItems,
    MOTION_BATCH_SIZE,
    motionRenderCount,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VirtuallyMotions = api;
})(typeof window !== 'undefined' ? window : null);
