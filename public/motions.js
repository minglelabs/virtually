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

  const SUB_VIDEO = '영상';
  const SUB_NO_VIDEO = '영상 없음 · 데모 재생';
  const SUB_DEMO = '기본 아바타';

  function normalizeName(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  /** The preset label for `key`, or null when `key` is not a preset key. */
  function presetLabel(key) {
    const preset = PRESET_MOTIONS.find(p => p.key === key);
    return preset ? preset.label : null;
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

  const api = Object.freeze({
    PRESET_MOTIONS,
    normalizeName,
    presetLabel,
    buildMotionItems,
    MOTION_BATCH_SIZE,
    motionRenderCount,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VirtuallyMotions = api;
})(typeof window !== 'undefined' ? window : null);
