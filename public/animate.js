/**
 * Virtually Controller - Generate motion presets with AI ("기본 동작 자동 생성").
 *
 * Consumes the /api/animate/* contract (see .kiro/specs/animate-presets.md).
 * A reference video of a real person performing a gesture + the idle character
 * image composited on #00FF00 is sent to an "animate"/motion-control model; the
 * generated clip is chroma-keyed to a transparent VP9 WebM and published as a
 * motion named after the preset.
 *
 * The card renders four regions: (1) character image, (2) generation model +
 * API key settings, (3) the 9 preset rows, (4) the batch generate bar.
 *
 * Contract discipline: this frontend consumes ONLY the Status / JobView fields
 * and codes defined in the spec, always uses server-provided URLs verbatim, and
 * never puts server/user strings into innerHTML (textContent only). Korean UI
 * copy, English code comments. Reuses window.VirtuallyUI toasts/log and hands a
 * generated clip to the converter through window.VirtuallyChroma.adoptJob.
 *
 * An older server without /api/animate/status (404) is handled with a notice
 * instead of crashing.
 */
(function () {
  'use strict';

  const POLL_INTERVAL_MS = 1500;             // spec: poll jobs every 1.5 s while active.
  const CHARACTER_MAX_BYTES = 30 * 1024 * 1024;  // spec: character image <= 30 MB.
  const REFERENCE_MAX_BYTES = 500 * 1024 * 1024; // spec: reference upload <= 500 MB.
  const CHARACTER_EXTS = ['.png', '.webp', '.jpg', '.jpeg'];
  const REFERENCE_EXTS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

  // Korean state labels (JobView.state).
  const STATE_LABELS = {
    queued: '대기 중',
    preparing: '준비 중',
    uploading: '업로드 중',
    generating: 'AI 생성 중',
    downloading: '받는 중',
    keying: '배경 제거 중',
    publishing: '등록 중',
    done: '완료',
    failed: '실패',
    canceled: '취소됨'
  };
  // Active states: a job in any of these is still running (drives polling + busy UI).
  const ACTIVE_STATES = ['queued', 'preparing', 'uploading', 'generating', 'downloading', 'keying', 'publishing'];

  // Error code -> Korean. reference_too_short interpolates detail.minSec.
  const ERROR_LABELS = {
    no_credentials: 'API 키가 없습니다',
    no_media_relay: 'Kling 직접 API는 영상 업로드용 WaveSpeed·fal·Higgsfield 키가 필요합니다',
    reference_missing: '레퍼런스 영상이 없습니다',
    reference_too_short: '레퍼런스가 너무 짧습니다',
    character_missing: '캐릭터 이미지가 없습니다',
    upload_failed: '파일 업로드 실패',
    submit_failed: '생성 요청 실패',
    generation_failed: 'AI 생성 실패',
    moderation: '콘텐츠 정책에 걸렸습니다',
    timeout: "생성이 너무 오래 걸립니다 ('결과 다시 확인' 가능)",
    download_failed: '결과 영상 다운로드 실패',
    keying_failed: '배경 제거 실패',
    publish_failed: '모션 등록 실패',
    server_restarted: '서버 재시작으로 중단됨',
    canceled: '취소됨'
  };
  // Warning code -> Korean. reference_trimmed interpolates detail.seconds.
  const WARNING_LABELS = {
    reference_trimmed: '레퍼런스를 잘랐습니다',
    key_color_fallback: '배경색 자동 감지 실패, #00FF00 사용',
    character_no_alpha: '캐릭터 이미지에 투명 배경이 없습니다'
  };

  // ==========================================================================
  // Shared UI surface (toasts + event log) exported by app.js
  // ==========================================================================
  function toast(message, type) {
    if (window.VirtuallyUI && typeof window.VirtuallyUI.showToast === 'function') {
      window.VirtuallyUI.showToast(message, type || 'info');
    }
  }
  function log(message, type) {
    if (window.VirtuallyUI && typeof window.VirtuallyUI.addLog === 'function') {
      window.VirtuallyUI.addLog(message, type || 'info');
    }
  }

  // ==========================================================================
  // Small helpers
  // ==========================================================================
  function h(tag, opts) {
    const node = document.createElement(tag);
    if (!opts) return node;
    if (opts.class) node.className = opts.class;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.id) node.id = opts.id;
    if (opts.type) node.type = opts.type;
    if (opts.attrs) {
      for (const k in opts.attrs) {
        if (Object.prototype.hasOwnProperty.call(opts.attrs, k)) node.setAttribute(k, opts.attrs[k]);
      }
    }
    if (opts.children) opts.children.forEach((c) => c && node.appendChild(c));
    return node;
  }

  function clampInt(value, lo, hi) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function extOf(filename) {
    const m = /\.[^.]+$/.exec(filename || '');
    return m ? m[0].toLowerCase() : '';
  }

  function formatUsd(v) {
    return Number.isFinite(v) ? '$' + v.toFixed(2) : null;
  }

  // JobView.error -> Korean message (interpolates known detail fields).
  function errorText(error) {
    if (!error || typeof error !== 'object') return '';
    const base = ERROR_LABELS[error.code];
    if (!base) return error.message ? String(error.message) : '알 수 없는 오류';
    if (error.code === 'reference_too_short' && error.detail && Number.isFinite(error.detail.minSec)) {
      return '레퍼런스가 너무 짧습니다 (최소 ' + error.detail.minSec + '초)';
    }
    return base;
  }

  // JobView.warnings[] -> Korean strings.
  function warningText(w) {
    if (!w || typeof w !== 'object') return '';
    const base = WARNING_LABELS[w.code];
    if (!base) return w.message ? String(w.message) : '';
    if (w.code === 'reference_trimmed' && w.detail && Number.isFinite(w.detail.seconds)) {
      return '레퍼런스를 ' + w.detail.seconds + '초로 잘랐습니다';
    }
    return base;
  }

  function isActive(job) {
    return !!(job && ACTIVE_STATES.indexOf(job.state) !== -1);
  }

  // ==========================================================================
  // Module state
  // ==========================================================================
  const state = {
    status: null,          // /api/animate/status payload
    available: false,      // status fetched (server supports the feature)
    jobsById: {},          // presetId -> latest JobView (from GET /api/animate/jobs + lastJob)
    selected: {},          // presetId -> boolean (batch checkbox)
    routeId: null,         // current model selection
    routeOptions: {},      // routeId -> { optionKey: value }
    pollTimer: null,
    startedAt: Date.now()  // for elapsed display on active jobs
  };

  // DOM handles populated during build.
  const dom = {};
  // Per-preset row DOM handles: presetId -> { ...nodes }
  const rows = {};

  // ==========================================================================
  // Bootstrapping
  // ==========================================================================
  async function boot() {
    const body = document.getElementById('animateBody');
    if (!body) return;

    let status = null;
    let http = 0;
    try {
      const res = await fetch('./api/animate/status', { headers: { Accept: 'application/json' } });
      http = res.status;
      if (res.ok) status = await res.json();
    } catch (_) {
      status = null;
    }

    if (status && Array.isArray(status.presets)) {
      state.status = status;
      state.available = true;
      initRouteSelection();
      buildUI(body);
      updateStatusPill();
      await refreshJobs();
    } else {
      // 404 = older server without this endpoint; anything else = unavailable.
      setStatusPill('disconnected', '사용 불가');
      const reason = http === 404
        ? '이 서버 버전은 기본 동작 자동 생성을 지원하지 않습니다. 서버를 업데이트한 뒤 다시 시도하세요.'
        : '기본 동작 자동 생성 기능을 불러오지 못했습니다. 서버 상태를 확인하세요.';
      renderUnavailable(body, reason);
    }
  }

  function setStatusPill(kind, label) {
    const pill = document.getElementById('animateStatusPill');
    if (!pill) return;
    const cls = kind === 'connected' ? 'status-connected'
      : kind === 'connecting' ? 'status-connecting' : 'status-disconnected';
    pill.className = 'status-pill ' + cls;
    const labelEl = pill.querySelector('.status-label');
    if (labelEl) labelEl.textContent = label;
  }

  // Status pill: ffmpeg missing / API 키 필요 / <n>개 서비스 연결됨.
  function updateStatusPill() {
    const s = state.status;
    if (!s) return;
    if (s.ffmpeg && !s.ffmpeg.available) {
      setStatusPill('disconnected', 'ffmpeg 필요');
      return;
    }
    const configured = (s.providers || []).filter((p) => p.configured && p.id !== 'mock').length;
    if (configured === 0) {
      setStatusPill('connecting', 'API 키 필요');
    } else {
      setStatusPill('connected', configured + '개 서비스 연결됨');
    }
  }

  function renderUnavailable(body, reason) {
    body.textContent = '';
    const box = h('div', { class: 'blank-guidance-box' });
    box.appendChild(h('div', { class: 'blank-guidance-icon', text: '🎬' }));
    box.appendChild(h('h4', { text: '기본 동작 자동 생성을 사용할 수 없습니다' }));
    box.appendChild(h('p', { text: reason }));
    body.appendChild(box);
  }

  // Pick the initial route: saved default if available, else first available route.
  function initRouteSelection() {
    const s = state.status;
    const routes = (s && s.routes) || [];
    const savedDefault = s && s.config && s.config.defaults ? s.config.defaults.routeId : null;
    // Seed remembered route options from config defaults.
    const savedOptions = (s && s.config && s.config.defaults && s.config.defaults.options) || {};
    if (savedDefault) state.routeOptions[savedDefault] = Object.assign({}, savedOptions);

    let chosen = null;
    if (savedDefault && routes.some((r) => r.id === savedDefault && r.available)) {
      chosen = savedDefault;
    } else {
      const firstAvailable = routes.find((r) => r.available);
      chosen = firstAvailable ? firstAvailable.id : (routes[0] ? routes[0].id : null);
    }
    state.routeId = chosen;
  }

  // ==========================================================================
  // UI construction
  // ==========================================================================
  function buildUI(body) {
    body.textContent = '';

    // ffmpeg-missing banner (feature still renders so keys can be set, but jobs will fail).
    if (state.status.ffmpeg && !state.status.ffmpeg.available) {
      const warn = h('div', { class: 'animate-ffmpeg-warn', attrs: { role: 'alert' } });
      warn.appendChild(h('strong', { text: 'ffmpeg를 사용할 수 없습니다. ' }));
      warn.appendChild(h('span', { text: state.status.ffmpeg.reason || '서버에 ffmpeg를 설치한 뒤 다시 시작하세요.' }));
      body.appendChild(warn);
    }

    body.appendChild(buildCharacterSection());
    body.appendChild(buildModelSection());
    body.appendChild(buildPresetSection());
    body.appendChild(buildBatchBar());

    renderCharacter();
    renderRoutePricing();
    renderProviderPanel();
  }

  // --- Section 1: character image -----------------------------------------
  function buildCharacterSection() {
    const sec = h('div', { class: 'animate-section' });
    sec.appendChild(h('h3', { class: 'upload-heading', text: '1. 캐릭터 이미지' }));

    const wrap = h('div', { class: 'animate-character' });
    const previewWrap = h('div', { class: 'animate-char-preview checkerboard-bg' });
    const previewImg = h('img', { id: 'animateCharImg', class: 'animate-char-img hidden', attrs: { alt: '캐릭터 이미지 미리보기' } });
    const previewMsg = h('div', { class: 'animate-char-msg', id: 'animateCharMsg' });
    previewWrap.appendChild(previewImg);
    previewWrap.appendChild(previewMsg);

    const info = h('div', { class: 'animate-char-info' });
    const meta = h('div', { class: 'animate-char-meta', id: 'animateCharMeta' });
    const alphaWarn = h('p', { class: 'animate-warn hidden', id: 'animateCharAlphaWarn', text: '투명 배경(알파)이 없는 이미지입니다. 배경이 함께 합성될 수 있습니다.' });
    const tip = h('p', { class: 'animate-hint', text: '팔을 뻗거나 춤출 여백을 두세요. 원영턴·BAD 챌린지는 전신 이미지여야 자연스럽습니다.' });

    const actions = h('div', { class: 'animate-char-actions' });
    const fileInput = h('input', { class: 'file-input-hidden', type: 'file', id: 'animateCharInput', attrs: { accept: CHARACTER_EXTS.join(',') } });
    const uploadBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', id: 'animateCharUpload', text: '다른 이미지 사용' });
    const revertBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', id: 'animateCharRevert', text: '대기 이미지로 되돌리기' });
    actions.appendChild(fileInput);
    actions.appendChild(uploadBtn);
    actions.appendChild(revertBtn);

    info.appendChild(meta);
    info.appendChild(alphaWarn);
    info.appendChild(tip);
    info.appendChild(actions);

    wrap.appendChild(previewWrap);
    wrap.appendChild(info);
    sec.appendChild(wrap);

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) uploadCharacter(f);
      fileInput.value = '';
    });
    revertBtn.addEventListener('click', deleteCharacter);

    Object.assign(dom, { charImg: previewImg, charMsg: previewMsg, charMeta: meta, charAlphaWarn: alphaWarn, charRevertBtn: revertBtn });
    return sec;
  }

  function renderCharacter() {
    const c = state.status.character || { source: null };
    if (c.source) {
      const sourceLabel = c.source === 'upload' ? '업로드한 이미지' : '현재 대기 이미지';
      const dims = (c.width && c.height) ? (c.width + '×' + c.height + ' · ') : '';
      dom.charMeta.textContent = dims + sourceLabel;
      dom.charAlphaWarn.classList.toggle('hidden', c.hasAlpha !== false);
      dom.charRevertBtn.classList.toggle('hidden', c.source !== 'upload');
      if (c.previewUrl) {
        dom.charImg.src = c.previewUrl;   // server-provided URL, used verbatim
        dom.charImg.classList.remove('hidden');
        dom.charMsg.textContent = '';
      } else {
        dom.charImg.classList.add('hidden');
        dom.charMsg.textContent = '미리보기를 불러올 수 없습니다.';
      }
    } else {
      dom.charImg.classList.add('hidden');
      dom.charImg.removeAttribute('src');
      dom.charMeta.textContent = '';
      dom.charAlphaWarn.classList.add('hidden');
      dom.charRevertBtn.classList.add('hidden');
      dom.charMsg.textContent = '대기 아바타가 없습니다. 먼저 대기(Idle) 이미지를 등록하거나 캐릭터 이미지를 업로드하세요.';
    }
  }

  // --- Section 2: model + API key settings ---------------------------------
  function buildModelSection() {
    const sec = h('div', { class: 'animate-section' });
    sec.appendChild(h('h3', { class: 'upload-heading', text: '2. 생성 모델' }));

    // Model select grouped by family.
    const modelRow = h('div', { class: 'animate-control' });
    modelRow.appendChild(h('label', { class: 'animate-control-label', attrs: { for: 'animateRouteSelect' }, text: '모델 · 서비스' }));
    const select = h('select', { id: 'animateRouteSelect', class: 'animate-select' });
    buildRouteOptions(select);
    select.value = state.routeId || '';
    select.addEventListener('change', () => {
      state.routeId = select.value;
      renderRoutePricing();
      persistDefaults();
    });
    modelRow.appendChild(select);
    const pricing = h('p', { class: 'animate-hint', id: 'animateRoutePricing', text: '' });
    const caution = h('p', { class: 'animate-warn hidden', id: 'animateRouteCaution', text: '이 모델은 배경을 그대로 유지하지 않을 수 있습니다. 결과를 확인하세요.' });
    modelRow.appendChild(pricing);
    modelRow.appendChild(caution);

    // Per-route option selects.
    const optionsWrap = h('div', { class: 'animate-route-options', id: 'animateRouteOptions' });
    modelRow.appendChild(optionsWrap);
    sec.appendChild(modelRow);

    // API key settings toggle + panel.
    const keyToggle = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', id: 'animateKeyToggle', attrs: { 'aria-expanded': 'false', 'aria-controls': 'animateKeyPanel' }, text: 'API 키 설정' });
    const keyPanel = h('div', { class: 'animate-key-panel hidden', id: 'animateKeyPanel' });
    keyToggle.addEventListener('click', () => {
      const open = keyPanel.classList.toggle('hidden') === false;
      keyToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    sec.appendChild(keyToggle);
    sec.appendChild(keyPanel);

    Object.assign(dom, { routeSelect: select, routePricing: pricing, routeCaution: caution, routeOptions: optionsWrap, keyPanel: keyPanel });
    return sec;
  }

  function buildRouteOptions(select) {
    const s = state.status;
    const routes = s.routes || [];
    // Group by family, preserving route (UI) order.
    const order = [];
    const byFamily = {};
    routes.forEach((r) => {
      if (!byFamily[r.family]) { byFamily[r.family] = { label: r.familyLabel || r.family, routes: [] }; order.push(r.family); }
      byFamily[r.family].routes.push(r);
    });
    order.forEach((fam) => {
      const group = h('optgroup', { attrs: { label: byFamily[fam].label } });
      byFamily[fam].routes.forEach((r) => {
        let label = r.label === r.providerLabel ? r.label : r.label + ' · ' + r.providerLabel;
        if (!r.available) {
          label += r.unavailableCode === 'no_media_relay' ? ' (업로드용 키 필요)' : ' (키 필요)';
        }
        if (r.verified === false) label += ' (검증 전)';
        const opt = h('option', { text: label });
        opt.value = r.id;
        if (!r.available) opt.disabled = true;
        group.appendChild(opt);
      });
      select.appendChild(group);
    });
  }

  function currentRoute() {
    if (!state.status) return null;
    return (state.status.routes || []).find((r) => r.id === state.routeId) || null;
  }

  // Re-render the route <select> after the Status changed (keys saved, relay
  // changed, folder rescanned): availability labels move, and a route that just
  // became unavailable falls back to the first available one.
  function renderRouteSelect() {
    if (!dom.routeSelect || !state.status) return;
    const routes = state.status.routes || [];
    const current = routes.find((r) => r.id === state.routeId);
    if (!current || !current.available) {
      const firstAvailable = routes.find((r) => r.available);
      if (firstAvailable) state.routeId = firstAvailable.id;
    }
    dom.routeSelect.textContent = '';
    buildRouteOptions(dom.routeSelect);
    renderRoutePricing();
  }

  function renderRoutePricing() {
    const r = currentRoute();
    dom.routeSelect.value = state.routeId || '';
    if (!r) {
      dom.routePricing.textContent = '';
      dom.routeCaution.classList.add('hidden');
      dom.routeOptions.textContent = '';
      return;
    }
    // Pricing hint.
    if (r.pricing && Number.isFinite(r.pricing.usdPerSecond)) {
      dom.routePricing.textContent = '약 $' + r.pricing.usdPerSecond + '/초';
    } else if (r.pricing && r.pricing.byOption) {
      dom.routePricing.textContent = '옵션에 따라 가격이 달라집니다';
    } else {
      dom.routePricing.textContent = '가격 정보 없음';
    }
    // Caution when the model does not preserve the background.
    dom.routeCaution.classList.toggle('hidden', !(r.keepsImageBackground === false || r.keepsImageBackground === null));
    // Route option selects.
    renderRouteOptionSelects(r);
  }

  function renderRouteOptionSelects(route) {
    dom.routeOptions.textContent = '';
    // Only options with a fixed value list are user-selectable; free-form ones
    // (e.g. the local test route's delay) stay API-only.
    const opts = (route.options || []).filter((opt) => Array.isArray(opt.values) && opt.values.length);
    const chosen = state.routeOptions[route.id] || (state.routeOptions[route.id] = {});
    opts.forEach((opt) => {
      const field = h('div', { class: 'animate-route-option' });
      const id = 'animateOpt-' + route.id.replace(/[^a-z0-9]/gi, '-') + '-' + opt.key;
      field.appendChild(h('label', { class: 'animate-control-label', attrs: { for: id }, text: opt.label }));
      const sel = h('select', { id: id, class: 'animate-select animate-select-sm' });
      (opt.values || []).forEach((v) => {
        const o = h('option', { text: String(v) });
        o.value = String(v);
        sel.appendChild(o);
      });
      const cur = chosen[opt.key] != null ? chosen[opt.key] : opt.default;
      sel.value = String(cur);
      chosen[opt.key] = sel.value;
      sel.addEventListener('change', () => {
        chosen[opt.key] = sel.value;
        renderAllRowEstimates();
        persistDefaults();
      });
      field.appendChild(sel);
      dom.routeOptions.appendChild(field);
    });
  }

  // Remember model + option choices via PUT /api/animate/config { defaults }.
  async function persistDefaults() {
    if (!state.routeId) return;
    const options = state.routeOptions[state.routeId] || {};
    try {
      const res = await putConfig({ defaults: { routeId: state.routeId, options: options } });
      if (res) state.status = res;
    } catch (_) { /* non-fatal: selection still works this session */ }
  }

  // --- API key settings panel ---------------------------------------------
  function renderProviderPanel() {
    const panel = dom.keyPanel;
    panel.textContent = '';
    // The local test generator has nothing to configure, so it gets no fieldset.
    const providers = (state.status.providers || [])
      .filter((p) => (p.credentials || []).length || (p.settings || []).length);

    providers.forEach((p) => {
      const fs = h('fieldset', { class: 'animate-provider' });
      const legend = h('legend', {});
      legend.appendChild(h('span', { text: p.label }));
      if (p.docs) {
        const a = h('a', { class: 'animate-doc-link', text: '문서', attrs: { href: p.docs, target: '_blank', rel: 'noopener noreferrer' } });
        legend.appendChild(a);
      }
      fs.appendChild(legend);

      // Credential password inputs.
      (p.credentials || []).forEach((cred) => {
        const grp = h('div', { class: 'input-group' });
        const inputId = 'animateCred-' + p.id + '-' + cred.key;
        const labelText = cred.label + (cred.optional ? ' (선택)' : '');
        grp.appendChild(h('label', { text: labelText, attrs: { for: inputId } }));
        const input = h('input', {
          type: 'password', id: inputId, class: 'animate-cred-input',
          attrs: { autocomplete: 'off', spellcheck: 'false' }
        });
        // Placeholder = masked value or "환경변수에서 읽음"; textContent-safe (placeholder attr).
        input.placeholder = cred.configured
          ? (cred.source === 'env' ? '환경변수에서 읽음' : (cred.masked || '••••'))
          : '';
        input.dataset.provider = p.id;
        input.dataset.field = cred.key;
        input.dataset.kind = 'credential';
        grp.appendChild(input);
        fs.appendChild(grp);
      });

      // Setting selects.
      (p.settings || []).forEach((setting) => {
        const grp = h('div', { class: 'input-group' });
        const selId = 'animateSet-' + p.id + '-' + setting.key;
        grp.appendChild(h('label', { text: setting.label, attrs: { for: selId } }));
        const sel = h('select', { id: selId, class: 'animate-select animate-select-sm' });
        (setting.values || []).forEach((v) => {
          const o = h('option', { text: String(v) });
          o.value = String(v);
          sel.appendChild(o);
        });
        if (setting.value != null) sel.value = String(setting.value);
        sel.dataset.provider = p.id;
        sel.dataset.field = setting.key;
        sel.dataset.kind = 'setting';
        grp.appendChild(sel);
        fs.appendChild(grp);
      });

      // Actions: 저장 + 연결 테스트 (when testable).
      const actions = h('div', { class: 'animate-provider-actions' });
      const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장' });
      saveBtn.addEventListener('click', () => saveProvider(p, fs));
      actions.appendChild(saveBtn);
      if (p.testable) {
        const testBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: '연결 테스트' });
        testBtn.addEventListener('click', () => testProvider(p.id, testBtn));
        actions.appendChild(testBtn);
      }
      const testResult = h('span', { class: 'animate-test-result', attrs: { 'aria-live': 'polite' } });
      actions.appendChild(testResult);
      fs.appendChild(actions);
      panel.appendChild(fs);
    });

    // Media relay select.
    panel.appendChild(buildMediaRelayControl());
    // Advanced <details>.
    panel.appendChild(buildAdvancedControls());
  }

  function buildMediaRelayControl() {
    const cfg = state.status.config || {};
    const wrap = h('div', { class: 'animate-control animate-relay' });
    wrap.appendChild(h('label', { class: 'animate-control-label', attrs: { for: 'animateRelaySelect' }, text: '영상 업로드 서비스 (미디어 릴레이)' }));
    const sel = h('select', { id: 'animateRelaySelect', class: 'animate-select' });
    const autoOpt = h('option', { text: '자동 (연결된 서비스 중 자동 선택)' });
    autoOpt.value = 'auto';
    sel.appendChild(autoOpt);
    // Providers that can host public uploads.
    (state.status.providers || []).filter((p) => p.publicUploads).forEach((p) => {
      const o = h('option', { text: p.label });
      o.value = p.id;
      sel.appendChild(o);
    });
    sel.value = cfg.mediaRelay || 'auto';
    sel.addEventListener('change', () => saveConfigField({ mediaRelay: sel.value }));
    wrap.appendChild(sel);
    wrap.appendChild(h('p', { class: 'animate-hint', text: 'Kling 직접 API는 레퍼런스 영상을 공개 URL로만 받아서, 여기서 고른 서비스에 임시로 올립니다' }));
    return wrap;
  }

  function buildAdvancedControls() {
    const cfg = state.status.config || {};
    const keying = cfg.keying || {};
    const details = h('details', { class: 'animate-advanced' });
    details.appendChild(h('summary', { text: '고급' }));

    // Keying defaults (color / similarity / blend / despill).
    const keyColor = numberOrTextField('키 배경색', 'animateAdvColor', keying.color != null ? String(keying.color) : 'auto', 'text');
    const keySim = numberOrTextField('유사도 (similarity)', 'animateAdvSim', keying.similarity, 'number', { step: '0.01', min: '0', max: '1' });
    const keyBlend = numberOrTextField('가장자리 (blend)', 'animateAdvBlend', keying.blend, 'number', { step: '0.01', min: '0', max: '1' });

    const despillGrp = h('div', { class: 'input-group animate-checkbox-row' });
    const despillLabel = h('label', { class: 'animate-checkbox-label', attrs: { for: 'animateAdvDespill' } });
    const despillCb = h('input', { type: 'checkbox', id: 'animateAdvDespill' });
    despillCb.checked = !!keying.despill;
    despillLabel.appendChild(despillCb);
    despillLabel.appendChild(h('span', { text: '색 번짐 제거 (despill)' }));
    despillGrp.appendChild(despillLabel);

    // Concurrency 1..4.
    const concGrp = numberOrTextField('동시 생성 개수 (1-4)', 'animateAdvConc', cfg.concurrency, 'number', { step: '1', min: '1', max: '4' });

    // Prompt suffix.
    const suffixGrp = h('div', { class: 'input-group' });
    suffixGrp.appendChild(h('label', { text: '공통 프롬프트 접미사', attrs: { for: 'animateAdvSuffix' } }));
    const suffix = h('textarea', { id: 'animateAdvSuffix', class: 'animate-textarea', attrs: { rows: '2' } });
    suffix.value = cfg.promptSuffix != null ? String(cfg.promptSuffix) : '';
    suffixGrp.appendChild(suffix);

    // replaceExisting + autoPublish.
    const replaceGrp = checkboxField('기존 등록 교체 (replaceExisting)', 'animateAdvReplace', !!cfg.replaceExisting);
    const publishGrp = checkboxField('완료 후 자동 등록 (autoPublish)', 'animateAdvPublish', cfg.autoPublish !== false);

    const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '고급 설정 저장' });
    saveBtn.addEventListener('click', () => {
      const body = {
        keying: {
          color: (document.getElementById('animateAdvColor').value || 'auto').trim() || 'auto',
          similarity: Number(document.getElementById('animateAdvSim').value),
          blend: Number(document.getElementById('animateAdvBlend').value),
          despill: document.getElementById('animateAdvDespill').checked
        },
        concurrency: clampInt(document.getElementById('animateAdvConc').value, 1, 4),
        promptSuffix: document.getElementById('animateAdvSuffix').value,
        replaceExisting: document.getElementById('animateAdvReplace').checked,
        autoPublish: document.getElementById('animateAdvPublish').checked
      };
      saveConfigField(body);
    });

    details.appendChild(keyColor);
    details.appendChild(keySim);
    details.appendChild(keyBlend);
    details.appendChild(despillGrp);
    details.appendChild(concGrp);
    details.appendChild(suffixGrp);
    details.appendChild(replaceGrp);
    details.appendChild(publishGrp);
    details.appendChild(saveBtn);
    return details;
  }

  function numberOrTextField(labelText, id, value, type, attrs) {
    const grp = h('div', { class: 'input-group' });
    grp.appendChild(h('label', { text: labelText, attrs: { for: id } }));
    const input = h('input', { type: type, id: id, attrs: attrs || {} });
    if (value != null) input.value = String(value);
    grp.appendChild(input);
    return grp;
  }

  function checkboxField(labelText, id, checked) {
    const grp = h('div', { class: 'input-group animate-checkbox-row' });
    const label = h('label', { class: 'animate-checkbox-label', attrs: { for: id } });
    const cb = h('input', { type: 'checkbox', id: id });
    cb.checked = !!checked;
    label.appendChild(cb);
    label.appendChild(h('span', { text: labelText }));
    grp.appendChild(label);
    return grp;
  }

  // --- Section 3: preset rows ----------------------------------------------
  function buildPresetSection() {
    const sec = h('div', { class: 'animate-section' });
    sec.appendChild(h('h3', { class: 'upload-heading', text: '3. 동작 목록' }));

    const list = h('div', { class: 'animate-preset-list', id: 'animatePresetList' });
    (state.status.presets || []).forEach((preset) => list.appendChild(buildPresetRow(preset)));
    sec.appendChild(list);

    // Reference folder helpers.
    const folder = h('div', { class: 'animate-folder-row' });
    const rescan = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', id: 'animateRescanBtn', text: '레퍼런스 폴더 다시 읽기' });
    rescan.addEventListener('click', () => refreshStatus(true));
    folder.appendChild(rescan);
    const hint = h('p', { class: 'animate-hint' });
    hint.appendChild(document.createTextNode(''));
    const dir = state.status.referencesDir || '';
    // Build with textContent-safe nodes: server path goes into a <code>.
    hint.appendChild(h('code', { text: dir }));
    hint.appendChild(document.createTextNode('에 hi.mp4처럼 넣어도 됩니다.'));
    folder.appendChild(hint);
    sec.appendChild(folder);

    return sec;
  }

  function buildPresetRow(preset) {
    const row = h('div', { class: 'animate-preset-row', attrs: { 'data-preset': preset.id } });

    // Header: checkbox + name + file hint + badges.
    const head = h('div', { class: 'animate-preset-head' });
    const cbLabel = h('label', { class: 'animate-checkbox-label' });
    const cb = h('input', { type: 'checkbox', attrs: { 'aria-label': preset.name + ' 선택' } });
    cb.checked = !!state.selected[preset.id];
    cb.addEventListener('change', () => { state.selected[preset.id] = cb.checked; renderBatchBar(); });
    cbLabel.appendChild(cb);
    cbLabel.appendChild(h('span', { class: 'animate-preset-name', text: preset.name }));
    head.appendChild(cbLabel);

    const fileHint = h('span', { class: 'animate-file-hint', text: preset.id + '.mp4' });
    head.appendChild(fileHint);

    const orientBadge = h('span', { class: 'badge badge-info', text: preset.orientation === 'video' ? '영상 동작 따라감' : '이미지 구도 유지' });
    head.appendChild(orientBadge);
    if (preset.fullBody) head.appendChild(h('span', { class: 'badge badge-accent', text: '전신' }));
    row.appendChild(head);

    const body = h('div', { class: 'animate-preset-body' });

    // Reference cell.
    const refCell = h('div', { class: 'animate-ref-cell' });
    const refVideo = h('video', { class: 'animate-ref-video hidden', attrs: { muted: '', playsinline: '', preload: 'metadata', controls: '' } });
    refVideo.muted = true;
    const refMeta = h('div', { class: 'animate-ref-meta' });
    const dropZone = h('div', { class: 'animate-ref-drop', attrs: { role: 'button', tabindex: '0', 'aria-label': preset.name + ' 레퍼런스 영상 올리기' } });
    dropZone.appendChild(h('span', { class: 'animate-ref-drop-text', text: '영상 올리기' }));
    const fileInput = h('input', { class: 'file-input-hidden', type: 'file', attrs: { accept: REFERENCE_EXTS.join(',') } });
    dropZone.appendChild(fileInput);
    const refActions = h('div', { class: 'animate-ref-actions' });
    const replaceBtn = h('button', { class: 'btn btn-ghost btn-xs hidden', type: 'button', text: '교체' });
    const deleteBtn = h('button', { class: 'btn btn-ghost btn-xs hidden', type: 'button', text: '삭제' });
    refActions.appendChild(replaceBtn);
    refActions.appendChild(deleteBtn);
    refCell.appendChild(refVideo);
    refCell.appendChild(refMeta);
    refCell.appendChild(dropZone);
    refCell.appendChild(refActions);

    // Wire reference upload/replace/delete.
    const triggerUpload = () => fileInput.click();
    dropZone.addEventListener('click', triggerUpload);
    dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerUpload(); } });
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadReference(preset.id, f);
    });
    replaceBtn.addEventListener('click', triggerUpload);
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) uploadReference(preset.id, f);
      fileInput.value = '';
    });
    deleteBtn.addEventListener('click', () => deleteReference(preset.id));

    // Trim inputs.
    const trimWrap = h('div', { class: 'animate-trim' });
    const startId = 'animateTrimStart-' + preset.id;
    const endId = 'animateTrimEnd-' + preset.id;
    const startGrp = h('div', { class: 'input-group input-group-sm' });
    startGrp.appendChild(h('label', { text: '시작(초)', attrs: { for: startId } }));
    const startInput = h('input', { type: 'number', id: startId, attrs: { min: '0', step: '0.1', placeholder: '0' } });
    startGrp.appendChild(startInput);
    const endGrp = h('div', { class: 'input-group input-group-sm' });
    endGrp.appendChild(h('label', { text: '끝(초)', attrs: { for: endId } }));
    const endInput = h('input', { type: 'number', id: endId, attrs: { min: '0', step: '0.1', placeholder: '끝까지' } });
    endGrp.appendChild(endInput);
    trimWrap.appendChild(startGrp);
    trimWrap.appendChild(endGrp);
    const saveTrim = () => saveTrimInputs(preset.id, startInput, endInput);
    startInput.addEventListener('change', saveTrim);
    endInput.addEventListener('change', saveTrim);

    // Status cell (state label + elapsed + providerStatus + progress).
    const statusCell = h('div', { class: 'animate-status-cell', attrs: { 'aria-live': 'polite' } });
    const statusText = h('span', { class: 'animate-status-text' });
    const progressWrap = h('div', { class: 'animate-progress hidden' });
    const progressBar = h('div', { class: 'animate-progress-bar' });
    const progressFill = h('div', { class: 'animate-progress-fill' });
    progressBar.appendChild(progressFill);
    progressWrap.appendChild(progressBar);
    const warnList = h('div', { class: 'animate-warn-list' });
    const errText = h('p', { class: 'animate-error hidden' });
    statusCell.appendChild(statusText);
    statusCell.appendChild(progressWrap);
    statusCell.appendChild(warnList);
    statusCell.appendChild(errText);

    // Result preview (transparent WebM over checkerboard).
    const resultWrap = h('div', { class: 'animate-result-wrap checkerboard-bg hidden' });
    const resultVideo = h('video', { class: 'animate-result-video', attrs: { autoplay: '', loop: '', muted: '', playsinline: '' } });
    resultVideo.muted = true;
    resultWrap.appendChild(resultVideo);

    // Per-state action buttons.
    const actions = h('div', { class: 'animate-actions' });

    body.appendChild(refCell);
    body.appendChild(trimWrap);
    body.appendChild(statusCell);
    body.appendChild(resultWrap);
    body.appendChild(actions);
    row.appendChild(body);

    rows[preset.id] = {
      root: row, checkbox: cb, refVideo, refMeta, dropZone, replaceBtn, deleteBtn,
      startInput, endInput, statusText, progressWrap, progressFill, warnList, errText,
      resultWrap, resultVideo, actions
    };
    renderPresetRow(preset);
    return row;
  }

  // Render a preset row from its Status.presets entry + latest job.
  function renderPresetRow(preset) {
    const r = rows[preset.id];
    if (!r) return;
    // Reference preview.
    const ref = preset.reference;
    if (ref) {
      r.refVideo.src = ref.url;                // server URL, verbatim
      r.refVideo.classList.remove('hidden');
      const parts = [];
      if (Number.isFinite(ref.duration)) parts.push(ref.duration.toFixed(1) + '초');
      if (ref.width && ref.height) parts.push(ref.width + '×' + ref.height);
      if (Number.isFinite(ref.fps)) parts.push(ref.fps + 'fps');
      r.refMeta.textContent = (ref.filename ? ref.filename + ' · ' : '') + parts.join(' · ');
      r.dropZone.querySelector('.animate-ref-drop-text').textContent = '교체하려면 여기에 놓기';
      r.replaceBtn.classList.remove('hidden');
      r.deleteBtn.classList.remove('hidden');
    } else {
      r.refVideo.classList.add('hidden');
      r.refVideo.removeAttribute('src');
      r.refMeta.textContent = '레퍼런스 영상이 없습니다.';
      r.dropZone.querySelector('.animate-ref-drop-text').textContent = '영상 올리기';
      r.replaceBtn.classList.add('hidden');
      r.deleteBtn.classList.add('hidden');
    }
    // Trim inputs (only overwrite when not focused, so typing is not clobbered by a poll).
    const trim = preset.trim || {};
    if (document.activeElement !== r.startInput) r.startInput.value = trim.start != null ? trim.start : '';
    if (document.activeElement !== r.endInput) r.endInput.value = trim.end != null ? trim.end : '';

    // Job-derived state.
    const job = state.jobsById[preset.id] || preset.lastJob || null;
    if (job) state.jobsById[preset.id] = job;
    renderJobState(preset, job);
  }

  function renderJobState(preset, job) {
    const r = rows[preset.id];
    if (!r) return;

    // Status text.
    if (job) {
      const label = STATE_LABELS[job.state] || job.state;
      const bits = [label];
      if (isActive(job) && job.startedAt) {
        const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000));
        if (Number.isFinite(elapsed)) bits.push(elapsed + '초 경과');
      }
      if (job.providerStatus && isActive(job)) bits.push(String(job.providerStatus));
      r.statusText.textContent = bits.join(' · ');
    } else {
      r.statusText.textContent = '대기';
    }

    // Progress bar (keying only).
    if (job && job.state === 'keying' && Number.isFinite(job.progress)) {
      r.progressWrap.classList.remove('hidden');
      r.progressFill.style.width = Math.round(job.progress * 100) + '%';
    } else if (job && isActive(job)) {
      // Indeterminate for other active states.
      r.progressWrap.classList.remove('hidden');
      r.progressFill.style.width = '100%';
      r.progressFill.classList.add('indeterminate');
    } else {
      r.progressWrap.classList.add('hidden');
      r.progressFill.classList.remove('indeterminate');
    }
    if (job && job.state === 'keying') r.progressFill.classList.remove('indeterminate');

    // Warnings.
    r.warnList.textContent = '';
    if (job && Array.isArray(job.warnings)) {
      job.warnings.forEach((w) => {
        const t = warningText(w);
        if (t) r.warnList.appendChild(h('p', { class: 'animate-warn', text: '⚠ ' + t }));
      });
    }

    // Error.
    if (job && job.error) {
      r.errText.textContent = errorText(job.error);
      r.errText.classList.remove('hidden');
    } else {
      r.errText.classList.add('hidden');
      r.errText.textContent = '';
    }

    // Result preview.
    if (job && job.resultUrl) {
      r.resultWrap.classList.remove('hidden');
      if (r.resultVideo.getAttribute('src') !== job.resultUrl) {
        r.resultVideo.src = job.resultUrl;      // server URL, verbatim
        r.resultVideo.load();
      }
    } else {
      r.resultWrap.classList.add('hidden');
      r.resultVideo.removeAttribute('src');
    }

    renderRowActions(preset, job);
  }

  function renderRowActions(preset, job) {
    const r = rows[preset.id];
    r.actions.textContent = '';
    const hasRef = !!preset.reference;

    if (!job || (!isActive(job) && ['done', 'failed', 'canceled'].indexOf(job.state) === -1)) {
      // No job yet: single 생성 button (disabled without a reference).
      const gen = h('button', { class: 'btn btn-accent btn-sm', type: 'button', text: '생성' });
      gen.disabled = !hasRef;
      gen.addEventListener('click', () => confirmAndCreate([preset.id]));
      r.actions.appendChild(gen);
      return;
    }

    if (isActive(job)) {
      const cancel = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: '취소' });
      cancel.addEventListener('click', () => cancelJob(job.id));
      r.actions.appendChild(cancel);
      return;
    }

    // Terminal (done / failed / canceled).
    if (job.canResume) {
      const resume = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: '배경만 다시' });
      resume.addEventListener('click', () => retryJob(job.id, false));
      r.actions.appendChild(resume);
    }
    if (job.canRetry) {
      const regen = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '다시 생성' });
      regen.addEventListener('click', () => {
        const est = formatUsd(job.estimateUsd);
        const msg = '"' + preset.name + '"을(를) 다시 생성하면 새로 요금이 부과됩니다' + (est ? (' (약 ' + est + ')') : '') + '. 계속할까요?';
        if (confirm(msg)) retryJob(job.id, true);
      });
      r.actions.appendChild(regen);
    }
    if (job.generatedUrl) {
      const adjust = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '변환기에서 조정' });
      adjust.addEventListener('click', () => openInConverter(job.id));
      r.actions.appendChild(adjust);
      const viewGen = h('a', { class: 'btn btn-ghost btn-sm', text: '생성 영상 보기', attrs: { href: job.generatedUrl, target: '_blank', rel: 'noopener noreferrer' } });
      r.actions.appendChild(viewGen);
    }
    // A brand new "생성" is offered again once terminal, so the preset can be re-run fresh.
    if (job.state === 'canceled' || job.state === 'failed') {
      const gen = h('button', { class: 'btn btn-accent btn-sm', type: 'button', text: '생성' });
      gen.disabled = !preset.reference;
      gen.addEventListener('click', () => confirmAndCreate([preset.id]));
      r.actions.appendChild(gen);
    }
    // A finished preset regenerates as a NEW job, so it picks up the current
    // reference, character, model and options (the cost dialog confirms).
    if (job.state === 'done') {
      const regen = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '다시 생성' });
      regen.disabled = !preset.reference;
      regen.addEventListener('click', () => confirmAndCreate([preset.id]));
      r.actions.appendChild(regen);
    }
  }

  // --- Section 4: batch bar -------------------------------------------------
  function buildBatchBar() {
    const bar = h('div', { class: 'animate-batch-bar' });
    const btn = h('button', { class: 'btn btn-accent', type: 'button', id: 'animateBatchBtn', text: '선택한 동작 생성' });
    btn.addEventListener('click', onBatchGenerate);
    bar.appendChild(btn);
    dom.batchBtn = btn;
    dom.batchBar = bar;
    renderBatchBar();
    return bar;
  }

  // Estimate total cost for the selected presets on the current route/options.
  function selectedPresetIds() {
    return (state.status.presets || [])
      .filter((p) => state.selected[p.id] && p.reference)
      .map((p) => p.id);
  }

  function estimateFor(preset) {
    const r = currentRoute();
    // A finished job's estimate (based on the seconds actually sent) is exact,
    // but only for the route it ran on.
    const job = state.jobsById[preset.id] || preset.lastJob;
    if (job && r && job.routeId === r.id && Number.isFinite(job.estimateUsd)) return job.estimateUsd;
    if (!r || !r.pricing) return null;
    const ref = preset.reference;
    const trim = preset.trim || {};
    if (!ref || !Number.isFinite(ref.duration)) return null;
    const start = Number.isFinite(trim.start) ? trim.start : 0;
    const end = Number.isFinite(trim.end) ? Math.min(trim.end, ref.duration) : ref.duration;
    let seconds = Math.max(0, end - start);
    // Cap by route orientation limit.
    const lim = r.limits || {};
    let maxSec = Number.isFinite(lim.videoMaxSec) ? lim.videoMaxSec : null;
    if (lim.videoMaxSecByOrientation && lim.videoMaxSecByOrientation[preset.orientation] != null) {
      maxSec = lim.videoMaxSecByOrientation[preset.orientation];
    }
    if (maxSec != null) seconds = Math.min(seconds, maxSec);
    // Option-specific rate.
    let rate = r.pricing.usdPerSecond;
    const chosen = state.routeOptions[r.id] || {};
    if (r.pricing.byOption) {
      Object.keys(r.pricing.byOption).forEach((optKey) => {
        const val = chosen[optKey];
        if (val != null && r.pricing.byOption[optKey] && r.pricing.byOption[optKey][val] != null) {
          rate = r.pricing.byOption[optKey][val];
        }
      });
    }
    if (!Number.isFinite(rate)) return null;
    const billSec = Math.max(Number.isFinite(r.pricing.minSeconds) ? r.pricing.minSeconds : 0, seconds);
    return rate * billSec;
  }

  function renderBatchBar() {
    if (!dom.batchBtn) return;
    const ids = selectedPresetIds();
    let total = 0;
    let known = true;
    ids.forEach((id) => {
      const preset = state.status.presets.find((p) => p.id === id);
      const e = estimateFor(preset);
      if (e == null) known = false; else total += e;
    });
    const costPart = ids.length && known ? (' · 약 ' + formatUsd(total)) : '';
    dom.batchBtn.textContent = '선택한 동작 생성 (' + ids.length + '개' + costPart + ')';
    dom.batchBtn.disabled = ids.length === 0 || !state.routeId;
  }

  function renderAllRowEstimates() {
    renderBatchBar();
  }

  async function onBatchGenerate() {
    confirmAndCreate(selectedPresetIds());
  }

  // Every generation on a real route costs money: confirm the preset list and
  // the estimate first (single rows and the batch alike). The local test route
  // (provider "mock") is free, so it skips the dialog.
  function confirmAndCreate(ids) {
    if (!ids.length) { toast('생성할 동작을 먼저 선택하세요.', 'error'); return; }
    const route = currentRoute();
    if (!route || route.provider !== 'mock') {
      const names = ids.map((id) => {
        const p = state.status.presets.find((x) => x.id === id);
        return p ? p.name : id;
      });
      let total = 0; let known = true;
      ids.forEach((id) => {
        const p = state.status.presets.find((x) => x.id === id);
        const e = estimateFor(p);
        if (e == null) known = false; else total += e;
      });
      const estLine = known ? ('예상 비용: 약 ' + formatUsd(total)) : '예상 비용: 알 수 없음';
      const msg = '다음 동작을 생성합니다 (실제 요금이 부과됩니다):\n\n· ' + names.join('\n· ') + '\n\n' + estLine + '\n\n계속할까요?';
      if (!confirm(msg)) return;
    }
    createJobs(ids);
  }

  // ==========================================================================
  // Server calls
  // ==========================================================================
  async function refreshStatus(notify) {
    try {
      const res = await fetch('./api/animate/status', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return;
      const status = await res.json();
      state.status = status;
      updateStatusPill();
      // Re-render preset rows in place (do not rebuild the whole card / lose focus).
      (status.presets || []).forEach((preset) => renderPresetRow(preset));
      renderCharacter();
      renderRouteSelect();
      renderBatchBar();
      if (notify) toast('레퍼런스 폴더를 다시 읽었습니다.', 'info');
    } catch (_) { /* transient */ }
  }

  async function refreshJobs() {
    try {
      const res = await fetch('./api/animate/jobs', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (res.status === 404) return; // older server; status already carried lastJob
      if (!res.ok) return;
      const data = await res.json();
      const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
      // Newest first: keep the first job seen per preset.
      const seen = {};
      jobs.forEach((job) => {
        if (!seen[job.presetId]) { seen[job.presetId] = true; state.jobsById[job.presetId] = job; }
      });
      // Re-render each preset row from the merged job map.
      (state.status.presets || []).forEach((preset) => {
        const job = state.jobsById[preset.id];
        renderJobState(preset, job || preset.lastJob || null);
      });
      renderBatchBar();
      managePolling(jobs);
    } catch (_) { /* transient */ }
  }

  function managePolling(jobs) {
    const anyActive = (jobs || []).some((j) => isActive(j))
      || Object.keys(state.jobsById).some((k) => isActive(state.jobsById[k]));
    if (anyActive) startPolling(); else stopPolling();
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(refreshJobs, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function putConfig(body) {
    const res = await fetch('./api/animate/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) return res.json();
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }

  async function saveConfigField(body) {
    try {
      const status = await putConfig(body);
      state.status = status;
      updateStatusPill();
      renderRouteSelect();
      renderBatchBar();
      toast('설정을 저장했습니다.', 'success');
    } catch (err) {
      toast('설정 저장 실패: ' + err.message, 'error');
    }
  }

  async function saveProvider(provider, fieldset) {
    // Collect credential + setting values. A masked/unchanged password is skipped
    // (server ignores strings starting with ••••; we simply do not send empties).
    const creds = {};
    let credCount = 0;
    fieldset.querySelectorAll('input[data-kind="credential"]').forEach((input) => {
      const v = input.value;
      if (v !== '') { creds[input.dataset.field] = v; credCount++; }
    });
    const settings = {};
    fieldset.querySelectorAll('select[data-kind="setting"]').forEach((sel) => {
      settings[sel.dataset.field] = sel.value;
    });
    const body = { providers: {} };
    body.providers[provider.id] = Object.assign({}, creds, settings);
    if (credCount === 0 && Object.keys(settings).length === 0) {
      toast('저장할 값이 없습니다.', 'info');
      return;
    }
    try {
      const status = await putConfig(body);
      state.status = status;
      updateStatusPill();
      // Clear password fields (values now held server-side, shown masked next render).
      fieldset.querySelectorAll('input[data-kind="credential"]').forEach((i) => { i.value = ''; });
      renderProviderPanel();
      renderRouteSelect();
      toast(provider.label + ' 설정을 저장했습니다.', 'success');
    } catch (err) {
      toast(provider.label + ' 저장 실패: ' + err.message, 'error');
    }
  }

  async function testProvider(providerId, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '테스트 중…';
    const resultEl = btn.parentNode.querySelector('.animate-test-result');
    try {
      const res = await fetch('./api/animate/providers/' + encodeURIComponent(providerId) + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.ok) {
        const data = await res.json();
        if (resultEl) { resultEl.textContent = data.ok ? ('연결됨' + (data.detail ? ' · ' + data.detail : '')) : ('실패' + (data.detail ? ' · ' + data.detail : '')); resultEl.className = 'animate-test-result ' + (data.ok ? 'animate-test-ok' : 'animate-test-fail'); }
      } else {
        let msg = 'HTTP ' + res.status;
        if (res.status === 400) msg = 'API 키가 설정되지 않았습니다';
        else if (res.status === 501) msg = '이 서비스는 테스트를 지원하지 않습니다';
        else { try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {} }
        if (resultEl) { resultEl.textContent = msg; resultEl.className = 'animate-test-result animate-test-fail'; }
      }
    } catch (_) {
      if (resultEl) { resultEl.textContent = '테스트 중 오류'; resultEl.className = 'animate-test-result animate-test-fail'; }
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function uploadCharacter(file) {
    const ext = extOf(file.name);
    if (CHARACTER_EXTS.indexOf(ext) === -1) { toast('지원하지 않는 이미지 형식입니다: ' + (ext || '(없음)'), 'error'); return; }
    if (file.size > CHARACTER_MAX_BYTES) { toast('이미지가 30MB를 초과합니다.', 'error'); return; }
    const url = './api/animate/character?filename=' + encodeURIComponent(file.name);
    rawUpload(url, file, (character) => {
      state.status.character = character;
      renderCharacter();
      toast('캐릭터 이미지를 업로드했습니다.', 'success');
      log('기본 동작 생성: 캐릭터 이미지 업로드 완료', 'info');
    });
  }

  async function deleteCharacter() {
    try {
      const res = await fetch('./api/animate/character', { method: 'DELETE' });
      if (res.ok) {
        state.status.character = await res.json();
        renderCharacter();
        toast('대기 이미지로 되돌렸습니다.', 'info');
      } else {
        toast('되돌리기 실패 (HTTP ' + res.status + ')', 'error');
      }
    } catch (_) { toast('되돌리기 중 오류가 발생했습니다.', 'error'); }
  }

  function uploadReference(presetId, file) {
    const ext = extOf(file.name);
    if (REFERENCE_EXTS.indexOf(ext) === -1) { toast('지원하지 않는 영상 형식입니다: ' + (ext || '(없음)') + ' — ' + REFERENCE_EXTS.join(', '), 'error'); return; }
    if (file.size > REFERENCE_MAX_BYTES) { toast('영상이 500MB를 초과합니다.', 'error'); return; }
    const url = './api/animate/references/' + encodeURIComponent(presetId) + '?filename=' + encodeURIComponent(file.name);
    rawUpload(url, file, (presetView) => {
      applyPresetView(presetView);
      toast('레퍼런스 영상을 올렸습니다.', 'success');
      log('기본 동작 생성: 레퍼런스 업로드 완료 — ' + presetId, 'info');
    }, (msg) => toast('레퍼런스 업로드 실패: ' + msg, 'error'));
  }

  async function deleteReference(presetId) {
    if (!confirm('이 동작의 레퍼런스 영상을 삭제할까요?')) return;
    try {
      const res = await fetch('./api/animate/references/' + encodeURIComponent(presetId), { method: 'DELETE' });
      if (res.ok) {
        // Refresh the single preset from status (server no longer returns a view here).
        await refreshStatus(false);
        toast('레퍼런스 영상을 삭제했습니다.', 'info');
      } else {
        toast('삭제 실패 (HTTP ' + res.status + ')', 'error');
      }
    } catch (_) { toast('삭제 중 오류가 발생했습니다.', 'error'); }
  }

  // Raw-body upload with progress via XHR (mirrors chroma.js pattern).
  function rawUpload(url, file, onOk, onErr) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.onload = () => {
      if (xhr.status === 201) {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_) { data = null; }
        if (data) onOk(data);
        else toast('서버 응답을 해석할 수 없습니다.', 'error');
      } else {
        let msg = 'HTTP ' + xhr.status;
        try { const j = JSON.parse(xhr.responseText); if (j && j.error) msg = j.error; } catch (_) {}
        if (onErr) onErr(msg); else toast('업로드 실패: ' + msg, 'error');
      }
    };
    xhr.onerror = () => { if (onErr) onErr('네트워크 오류'); else toast('업로드 중 네트워크 오류가 발생했습니다.', 'error'); };
    xhr.send(file);
  }

  // Apply a preset view (from reference upload / trim PUT) to status + row.
  function applyPresetView(view) {
    if (!view || !view.id) return;
    const idx = (state.status.presets || []).findIndex((p) => p.id === view.id);
    if (idx !== -1) state.status.presets[idx] = view;
    renderPresetRow(view);
    renderBatchBar();
  }

  async function saveTrimInputs(presetId, startInput, endInput) {
    const body = {};
    const sv = startInput.value.trim();
    const ev = endInput.value.trim();
    body.trimStart = sv === '' ? null : Number(sv);
    body.trimEnd = ev === '' ? null : Number(ev);
    if (body.trimStart != null && body.trimEnd != null && !(body.trimEnd > body.trimStart)) {
      toast('끝 시간이 시작 시간보다 커야 합니다.', 'error');
      return;
    }
    try {
      const res = await fetch('./api/animate/presets/' + encodeURIComponent(presetId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (res.ok) {
        applyPresetView(await res.json());
        toast('구간을 저장했습니다.', 'success');
      } else {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        toast('구간 저장 실패: ' + msg, 'error');
      }
    } catch (_) { toast('구간 저장 중 오류가 발생했습니다.', 'error'); }
  }

  async function createJobs(presetIds) {
    if (!state.routeId) { toast('먼저 생성 모델을 선택하세요.', 'error'); return; }
    const options = state.routeOptions[state.routeId] || {};
    try {
      const res = await fetch('./api/animate/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetIds: presetIds, routeId: state.routeId, options: options })
      });
      if (res.status === 202) {
        const data = await res.json();
        (data.jobs || []).forEach((job) => { state.jobsById[job.presetId] = job; });
        (state.status.presets || []).forEach((preset) => renderJobState(preset, state.jobsById[preset.id] || preset.lastJob || null));
        renderBatchBar();
        startPolling();
        toast(presetIds.length + '개 동작 생성을 시작했습니다.', 'success');
        log('기본 동작 생성: ' + presetIds.length + '개 작업 시작', 'info');
      } else if (res.status === 409) {
        let msg = '이미 생성 중인 동작이 있습니다.';
        try { const j = await res.json(); if (j && j.code === 'preset_busy') msg = '이미 생성 중인 동작이 있습니다.'; } catch (_) {}
        toast(msg, 'error');
      } else {
        toast('생성 요청 실패: ' + (await jobErrorText(res)), 'error');
      }
    } catch (_) { toast('생성 요청 중 오류가 발생했습니다.', 'error'); }
  }

  // Map a 400 create-job error to Korean using its code.
  async function jobErrorText(res) {
    let code = null; let detail = null; let fallback = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j) { code = j.code; detail = j.detail; if (j.error) fallback = j.error; } } catch (_) {}
    if (code && ERROR_LABELS[code]) {
      if (code === 'reference_missing' && detail && Array.isArray(detail.presetIds)) {
        const names = detail.presetIds.map((id) => { const p = state.status.presets.find((x) => x.id === id); return p ? p.name : id; });
        return '레퍼런스 영상이 없습니다: ' + names.join(', ');
      }
      return ERROR_LABELS[code];
    }
    if (code === 'unknown_preset') return '알 수 없는 동작입니다';
    if (code === 'unknown_route') return '알 수 없는 모델입니다';
    if (code === 'ffmpeg_unavailable') return 'ffmpeg를 사용할 수 없습니다';
    return fallback;
  }

  async function cancelJob(jobId) {
    try {
      const res = await fetch('./api/animate/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.ok) {
        const job = await res.json();
        state.jobsById[job.presetId] = job;
        const preset = state.status.presets.find((p) => p.id === job.presetId);
        if (preset) renderJobState(preset, job);
        renderBatchBar();
        toast('생성을 취소했습니다.', 'info');
      } else if (res.status === 409) {
        toast('이미 완료된 작업입니다.', 'error');
      }
    } catch (_) { toast('취소 요청 중 오류가 발생했습니다.', 'error'); }
  }

  async function retryJob(jobId, regenerate) {
    try {
      const res = await fetch('./api/animate/jobs/' + encodeURIComponent(jobId) + '/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: !!regenerate })
      });
      if (res.status === 202) {
        const job = await res.json();
        state.jobsById[job.presetId] = job;
        const preset = state.status.presets.find((p) => p.id === job.presetId);
        if (preset) renderJobState(preset, job);
        startPolling();
        toast(regenerate ? '다시 생성을 시작했습니다.' : '배경 제거를 다시 시작했습니다.', 'success');
      } else if (res.status === 409) {
        toast('진행 중인 작업은 다시 시작할 수 없습니다.', 'error');
      } else {
        toast('다시 시작 실패: ' + (await jobErrorText(res)), 'error');
      }
    } catch (_) { toast('다시 시작 중 오류가 발생했습니다.', 'error'); }
  }

  async function openInConverter(jobId) {
    try {
      const res = await fetch('./api/animate/jobs/' + encodeURIComponent(jobId) + '/open-in-converter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status === 201) {
        const data = await res.json();
        const chromaJob = data && data.chromaJob;
        if (chromaJob && window.VirtuallyChroma && typeof window.VirtuallyChroma.adoptJob === 'function') {
          const ok = window.VirtuallyChroma.adoptJob(chromaJob);
          if (ok) {
            const target = document.getElementById('chromaTool');
            if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            toast('변환기에서 이 영상을 열었습니다.', 'success');
          } else {
            toast('변환기를 열 수 없습니다.', 'error');
          }
        } else {
          toast('변환기를 사용할 수 없습니다.', 'error');
        }
      } else if (res.status === 409) {
        toast('생성된 영상이 없습니다.', 'error');
      } else {
        toast('변환기 열기 실패 (HTTP ' + res.status + ')', 'error');
      }
    } catch (_) { toast('변환기 열기 중 오류가 발생했습니다.', 'error'); }
  }

  // ==========================================================================
  // Go
  // ==========================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
