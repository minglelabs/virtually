/**
 * Virtually Controller - Background Removal Tool (chroma key -> transparent WebM)
 *
 * Consumes the /api/chroma/* contract. Builds a full-width tool card that lets a
 * user upload a solid-background clip, pick the key color (color picker, hex,
 * swatches, auto-detect, or eyedropper on the original frame), tune similarity /
 * blend / despill against a live checkerboard preview, convert to a transparent
 * VP9 WebM, and register the result as a motion / idle avatar or download it.
 *
 * The frontend always uses URLs from the Job JSON and never rebuilds them. All
 * server/user strings go through textContent (never innerHTML). Korean UI copy,
 * English code comments.
 */
(function () {
  'use strict';

  // Fallbacks only; the real values come from /api/chroma/status.
  const FALLBACK = {
    defaults: { color: '#00FF00', similarity: 0.12, blend: 0.06, despill: false },
    limits: { similarity: [0.01, 1], blend: [0, 1] },
    acceptedExtensions: ['.mp4', '.mov', '.m4v', '.webm', '.mkv']
  };
  const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB, mirrors server MAX_UPLOAD_BYTES.
  const SIMILARITY_SLIDER_MAX = 0.40;
  const BLEND_SLIDER_MAX = 0.30;
  const PREVIEW_DEBOUNCE_MS = 250;
  const FRAME_DEBOUNCE_MS = 120;
  const POLL_INTERVAL_MS = 700;

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

  function clampNumber(value, lo, hi) {
    if (!Number.isFinite(value)) return lo;
    return Math.min(hi, Math.max(lo, value));
  }

  function normalizeHex(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (s.startsWith('#')) s = s.slice(1);
    else if (/^0x/i.test(s)) s = s.slice(2);
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return '#' + s.toUpperCase();
  }

  // color -> 'green' | 'blue' | null, matching the server despill rule.
  function despillType(hex) {
    const n = normalizeHex(hex);
    if (!n) return null;
    const r = parseInt(n.slice(1, 3), 16);
    const g = parseInt(n.slice(3, 5), 16);
    const b = parseInt(n.slice(5, 7), 16);
    if (g > r && g > b) return 'green';
    if (b > r && b > g) return 'blue';
    return null;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }

  function extOf(filename) {
    const m = /\.[^.]+$/.exec(filename || '');
    return m ? m[0].toLowerCase() : '';
  }

  // ==========================================================================
  // Module state
  // ==========================================================================
  const state = {
    status: null,          // /api/chroma/status payload
    available: false,
    defaults: FALLBACK.defaults,
    limits: FALLBACK.limits,
    acceptedExtensions: FALLBACK.acceptedExtensions,
    job: null,             // current Job JSON
    params: null,          // current UI params {color, similarity, blend, despill}
    t: 0,                  // current frame time (sec)
    previewBg: 'checker',  // checker | dark | light
    resultBg: 'checker',
    frameController: null, // in-flight frame AbortController
    frameDebounce: null,
    frameSeq: 0,           // bumped per frame request; stale responses are dropped
    frameLoaded: false,    // true once a real frame is painted (eyedropper guard)
    previewController: null, // in-flight preview AbortController
    previewDebounce: null,
    pollTimer: null,
    uploading: false
  };

  // DOM handles populated by buildUI()
  const dom = {};

  // ==========================================================================
  // Bootstrapping
  // ==========================================================================
  async function boot() {
    const body = document.getElementById('chromaBody');
    if (!body) return;

    let status = null;
    try {
      const res = await fetch('./api/chroma/status', { headers: { Accept: 'application/json' } });
      if (res.ok) status = await res.json();
    } catch (_) {
      status = null;
    }

    if (status && status.available) {
      state.status = status;
      state.available = true;
      state.defaults = status.defaults || FALLBACK.defaults;
      state.limits = status.limits || FALLBACK.limits;
      state.acceptedExtensions = Array.isArray(status.acceptedExtensions) && status.acceptedExtensions.length
        ? status.acceptedExtensions
        : FALLBACK.acceptedExtensions;
      setStatusPill(true, status.ffmpegVersion);
      buildUI(body);
      await restoreLatestJob();
    } else {
      // Unavailable, request failed, or older server (404). Show a notice + disable.
      const reason = (status && status.reason) ? status.reason : 'ffmpeg를 사용할 수 없거나 서버가 이 기능을 지원하지 않습니다.';
      setStatusPill(false, null);
      renderUnavailable(body, reason);
    }
  }

  function setStatusPill(available, version) {
    const pill = document.getElementById('chromaStatusPill');
    if (!pill) return;
    pill.className = 'status-pill ' + (available ? 'status-connected' : 'status-disconnected');
    const label = pill.querySelector('.status-label');
    if (label) label.textContent = available ? ('ffmpeg ' + (version || '') + ' 사용 가능').replace('  ', ' ').trim() : 'ffmpeg 필요';
  }

  function renderUnavailable(body, reason) {
    body.textContent = '';
    const box = h('div', { class: 'blank-guidance-box' });
    box.appendChild(h('div', { class: 'blank-guidance-icon', text: '🎬' }));
    box.appendChild(h('h4', { text: '배경 제거 변환기를 사용할 수 없습니다' }));
    box.appendChild(h('p', { text: reason }));
    box.appendChild(h('p', { class: 'chroma-hint', text: 'macOS: brew install ffmpeg 후 서버를 다시 시작하세요' }));
    body.appendChild(box);
  }

  // ==========================================================================
  // UI construction
  // ==========================================================================
  function buildUI(body) {
    body.textContent = '';

    // --- Step 1: source video -----------------------------------------------
    const uploadSection = h('div', { class: 'chroma-section' });
    uploadSection.appendChild(h('h3', { class: 'upload-heading', text: '1. 원본 영상' }));

    const acceptAttr = state.acceptedExtensions.join(',');
    // role=button + tabindex make the file picker reachable by keyboard (Enter/Space).
    const dropZone = h('div', { class: 'drop-zone', id: 'chromaDropZone', attrs: { role: 'button', tabindex: '0' } });
    const fileInput = h('input', { class: 'file-input-hidden', type: 'file', attrs: { accept: acceptAttr, id: 'chromaFileInput' } });
    const dzContent = h('div', { class: 'drop-zone-content' });
    dzContent.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>';
    const dzLabel = h('span', { class: 'drop-zone-text', id: 'chromaDzLabel', text: '녹색/파란 배경 영상을 끌어다 놓거나 클릭하여 선택' });
    const dzHint = h('span', { class: 'drop-zone-hint', text: state.acceptedExtensions.join(', ') + ' · 최대 500MB' });
    dzContent.appendChild(dzLabel);
    dzContent.appendChild(dzHint);
    dropZone.appendChild(fileInput);
    dropZone.appendChild(dzContent);

    const nameRow = h('div', { class: 'form-controls-row' });
    const nameGroup = h('div', { class: 'input-group' });
    const nameLabel = h('label', { text: '레이블 (선택)', attrs: { for: 'chromaNameInput' } });
    const nameInput = h('input', { type: 'text', id: 'chromaNameInput', attrs: { placeholder: '미입력 시 파일명 사용', maxlength: '50' } });
    nameGroup.appendChild(nameLabel);
    nameGroup.appendChild(nameInput);
    const uploadBtn = h('button', { class: 'btn btn-primary', type: 'button', id: 'chromaUploadBtn' });
    uploadBtn.appendChild(h('span', { class: 'btn-spinner hidden', id: 'chromaUploadSpinner' }));
    uploadBtn.appendChild(h('span', { class: 'btn-text', text: '영상 업로드' }));
    nameRow.appendChild(nameGroup);
    nameRow.appendChild(uploadBtn);

    const progressWrap = h('div', { class: 'chroma-progress hidden', id: 'chromaUploadProgressWrap' });
    const progressBar = h('div', { class: 'chroma-progress-bar' });
    const progressFill = h('div', { class: 'chroma-progress-fill', id: 'chromaUploadProgressFill' });
    progressBar.appendChild(progressFill);
    const progressText = h('span', { class: 'chroma-progress-text', id: 'chromaUploadProgressText', attrs: { 'aria-live': 'polite' }, text: '' });
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressText);

    const sourceMeta = h('div', { class: 'chroma-source-meta hidden', id: 'chromaSourceMeta' });
    const changeBtn = h('button', { class: 'btn btn-secondary btn-sm hidden', type: 'button', id: 'chromaChangeBtn', text: '다른 영상으로 바꾸기' });

    uploadSection.appendChild(dropZone);
    uploadSection.appendChild(nameRow);
    uploadSection.appendChild(progressWrap);
    uploadSection.appendChild(sourceMeta);
    uploadSection.appendChild(changeBtn);
    body.appendChild(uploadSection);

    // --- Steps 2..4 live in an editor that is hidden until a job exists ------
    const editor = h('div', { class: 'chroma-editor hidden', id: 'chromaEditor' });

    // Step 2: adjust
    const adjust = h('div', { class: 'chroma-section' });
    adjust.appendChild(h('h3', { class: 'upload-heading', text: '2. 배경색·강도 조정' }));

    const panes = h('div', { class: 'chroma-panes' });

    // Left pane: original frame canvas (eyedropper)
    const leftPane = h('div', { class: 'chroma-pane' });
    leftPane.appendChild(h('div', { class: 'chroma-pane-title', text: '원본 프레임' }));
    const canvasWrap = h('div', { class: 'chroma-canvas-wrap checkerboard-bg' });
    const canvas = h('canvas', { id: 'chromaFrameCanvas', class: 'chroma-frame-canvas', attrs: { role: 'img', 'aria-label': '원본 프레임 (클릭하여 배경색 추출)', width: '0', height: '0' } });
    canvasWrap.appendChild(canvas);
    leftPane.appendChild(canvasWrap);
    leftPane.appendChild(h('p', { class: 'chroma-hint', text: '프레임을 클릭하면 그 지점의 색이 배경색으로 설정됩니다. 키보드 사용자는 아래 색상 필드를 이용하세요.' }));

    // Right pane: transparent preview
    const rightPane = h('div', { class: 'chroma-pane' });
    const rightTitleRow = h('div', { class: 'chroma-pane-title-row' });
    rightTitleRow.appendChild(h('div', { class: 'chroma-pane-title', text: '투명 미리보기' }));
    const bgToggle = buildBgToggle('preview');
    rightTitleRow.appendChild(bgToggle);
    rightPane.appendChild(rightTitleRow);
    const previewWrap = h('div', { class: 'chroma-preview-wrap checkerboard-bg', id: 'chromaPreviewWrap' });
    const previewImg = h('img', { id: 'chromaPreviewImg', class: 'chroma-preview-img hidden', attrs: { alt: '투명 미리보기' } });
    const previewMsg = h('div', { class: 'chroma-preview-msg', id: 'chromaPreviewMsg' });
    previewWrap.appendChild(previewImg);
    previewWrap.appendChild(previewMsg);
    rightPane.appendChild(previewWrap);

    panes.appendChild(leftPane);
    panes.appendChild(rightPane);
    adjust.appendChild(panes);

    // Frame position slider (hidden when duration unknown)
    const frameRow = h('div', { class: 'chroma-control hidden', id: 'chromaFrameRow' });
    const frameLabel = h('label', { class: 'chroma-control-label', attrs: { for: 'chromaFrameSlider' }, text: '프레임 위치' });
    const frameSlider = h('input', { type: 'range', id: 'chromaFrameSlider', attrs: { min: '0', max: '0', step: '0.05', value: '0' } });
    const frameTime = h('output', { class: 'chroma-output', id: 'chromaFrameTime', text: '0.00초' });
    frameRow.appendChild(frameLabel);
    frameRow.appendChild(frameSlider);
    frameRow.appendChild(frameTime);
    adjust.appendChild(frameRow);

    // Key color controls
    const colorRow = h('div', { class: 'chroma-control' });
    colorRow.appendChild(h('label', { class: 'chroma-control-label', attrs: { for: 'chromaHexInput' }, text: '배경 키 색상' }));
    const colorControls = h('div', { class: 'chroma-color-controls' });
    const colorPicker = h('input', { type: 'color', id: 'chromaColorPicker', attrs: { 'aria-label': '색상 선택기', value: '#00FF00' } });
    const hexInput = h('input', { type: 'text', id: 'chromaHexInput', class: 'chroma-hex-input', attrs: { 'aria-label': '16진 색상값', maxlength: '7', placeholder: '#00FF00' } });
    colorControls.appendChild(colorPicker);
    colorControls.appendChild(hexInput);
    // swatches
    [['녹색', '#00FF00'], ['파랑', '#0000FF'], ['마젠타', '#FF00FF']].forEach((sw) => {
      const b = h('button', { class: 'btn btn-secondary btn-sm chroma-swatch', type: 'button', text: sw[0] });
      const dot = h('span', { class: 'chroma-swatch-dot' });
      dot.style.background = sw[1];
      b.insertBefore(dot, b.firstChild);
      b.addEventListener('click', () => setColor(sw[1]));
      colorControls.appendChild(b);
    });
    const autoBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', id: 'chromaAutoBtn', text: '자동 감지' });
    colorControls.appendChild(autoBtn);
    colorRow.appendChild(colorControls);
    adjust.appendChild(colorRow);

    // Similarity slider
    const simRow = h('div', { class: 'chroma-control' });
    const simLabelRow = h('div', { class: 'chroma-control-head' });
    simLabelRow.appendChild(h('label', { class: 'chroma-control-label', attrs: { for: 'chromaSimSlider' }, text: '유사도' }));
    const simOut = h('output', { class: 'chroma-output', id: 'chromaSimOut', text: '0.12' });
    simLabelRow.appendChild(simOut);
    const simSlider = h('input', {
      type: 'range', id: 'chromaSimSlider',
      attrs: { min: String(state.limits.similarity[0]), max: String(SIMILARITY_SLIDER_MAX), step: '0.01', value: '0.12' }
    });
    simRow.appendChild(simLabelRow);
    simRow.appendChild(simSlider);
    simRow.appendChild(h('p', { class: 'chroma-hint', text: '높을수록 배경과 비슷한 색까지 투명해집니다. 캐릭터 일부가 사라지면 낮추세요.' }));
    adjust.appendChild(simRow);

    // Blend slider
    const blendRow = h('div', { class: 'chroma-control' });
    const blendLabelRow = h('div', { class: 'chroma-control-head' });
    blendLabelRow.appendChild(h('label', { class: 'chroma-control-label', attrs: { for: 'chromaBlendSlider' }, text: '가장자리 부드러움' }));
    const blendOut = h('output', { class: 'chroma-output', id: 'chromaBlendOut', text: '0.06' });
    blendLabelRow.appendChild(blendOut);
    const blendSlider = h('input', {
      type: 'range', id: 'chromaBlendSlider',
      attrs: { min: '0', max: String(BLEND_SLIDER_MAX), step: '0.01', value: '0.06' }
    });
    blendRow.appendChild(blendLabelRow);
    blendRow.appendChild(blendSlider);
    blendRow.appendChild(h('p', { class: 'chroma-hint', text: '머리카락·옷 가장자리의 반투명 폭입니다.' }));
    adjust.appendChild(blendRow);

    // Despill checkbox
    const despillRow = h('div', { class: 'chroma-control chroma-checkbox-row' });
    const despillLabel = h('label', { class: 'chroma-checkbox-label', attrs: { for: 'chromaDespill' } });
    const despillCb = h('input', { type: 'checkbox', id: 'chromaDespill' });
    despillLabel.appendChild(despillCb);
    despillLabel.appendChild(h('span', { text: '색 번짐 제거 (despill)' }));
    despillRow.appendChild(despillLabel);
    const despillNote = h('span', { class: 'chroma-hint', id: 'chromaDespillNote', text: '' });
    despillRow.appendChild(despillNote);
    despillRow.appendChild(h('p', { class: 'chroma-hint', text: '가장자리에 남는 녹색/파란 반사광을 줄입니다.' }));
    adjust.appendChild(despillRow);

    const resetBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', id: 'chromaResetBtn', text: '기본값' });
    adjust.appendChild(resetBtn);

    editor.appendChild(adjust);

    // Step 3: convert
    const convert = h('div', { class: 'chroma-section' });
    convert.appendChild(h('h3', { class: 'upload-heading', text: '3. 변환' }));
    const convertBtn = h('button', { class: 'btn btn-accent', type: 'button', id: 'chromaConvertBtn' });
    convertBtn.appendChild(h('span', { class: 'btn-text', text: '투명 WebM으로 변환' }));
    convert.appendChild(convertBtn);
    const convProgressWrap = h('div', { class: 'chroma-progress hidden', id: 'chromaConvProgressWrap' });
    const convBar = h('div', { class: 'chroma-progress-bar' });
    const convFill = h('div', { class: 'chroma-progress-fill', id: 'chromaConvProgressFill' });
    convBar.appendChild(convFill);
    const convText = h('span', { class: 'chroma-progress-text', id: 'chromaConvProgressText', attrs: { 'aria-live': 'polite' }, text: '' });
    const cancelBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', id: 'chromaCancelBtn', text: '취소' });
    convProgressWrap.appendChild(convBar);
    convProgressWrap.appendChild(convText);
    convProgressWrap.appendChild(cancelBtn);
    convert.appendChild(convProgressWrap);
    const convError = h('p', { class: 'chroma-error hidden', id: 'chromaConvError', attrs: { 'aria-live': 'polite' } });
    convert.appendChild(convError);
    editor.appendChild(convert);

    // Step 4: result
    const result = h('div', { class: 'chroma-section hidden', id: 'chromaResultSection' });
    const resultTitleRow = h('div', { class: 'chroma-pane-title-row' });
    resultTitleRow.appendChild(h('h3', { class: 'upload-heading', text: '4. 결과' }));
    resultTitleRow.appendChild(buildBgToggle('result'));
    result.appendChild(resultTitleRow);
    const resultWrap = h('div', { class: 'chroma-preview-wrap chroma-result-wrap checkerboard-bg', id: 'chromaResultWrap' });
    const resultVideo = h('video', { id: 'chromaResultVideo', class: 'chroma-preview-img', attrs: { autoplay: '', loop: '', muted: '', playsinline: '', controls: '' } });
    resultVideo.muted = true;
    resultWrap.appendChild(resultVideo);
    result.appendChild(resultWrap);
    const resultMeta = h('div', { class: 'chroma-source-meta', id: 'chromaResultMeta' });
    result.appendChild(resultMeta);
    const staleNote = h('p', { class: 'chroma-error hidden', id: 'chromaStaleNote', text: '설정이 바뀌었습니다 — 다시 변환해야 반영됩니다' });
    result.appendChild(staleNote);
    result.appendChild(h('p', { class: 'chroma-hint', text: '체크무늬가 비치는지, 머리카락·옷 가장자리가 깨지거나 녹색 테두리가 남지 않는지 확인한 뒤 등록하세요' }));
    const cmdDetails = h('details', { class: 'chroma-cmd' });
    cmdDetails.appendChild(h('summary', { text: 'ffmpeg 명령 보기' }));
    const cmdBox = h('div', { class: 'chroma-cmd-box' });
    const cmdCode = h('code', { id: 'chromaCmdCode' });
    const cmdCopy = h('button', { class: 'btn btn-ghost btn-xs', type: 'button', id: 'chromaCmdCopy', text: '복사' });
    cmdBox.appendChild(cmdCode);
    cmdBox.appendChild(cmdCopy);
    cmdDetails.appendChild(cmdBox);
    result.appendChild(cmdDetails);

    const publishRow = h('div', { class: 'form-controls-row' });
    const pubNameGroup = h('div', { class: 'input-group' });
    pubNameGroup.appendChild(h('label', { text: '등록 이름', attrs: { for: 'chromaPubName' } }));
    const pubName = h('input', { type: 'text', id: 'chromaPubName', attrs: { maxlength: '50', placeholder: '이름' } });
    pubNameGroup.appendChild(pubName);
    publishRow.appendChild(pubNameGroup);
    result.appendChild(publishRow);
    const actionsRow = h('div', { class: 'chroma-actions' });
    const motionBtn = h('button', { class: 'btn btn-accent', type: 'button', id: 'chromaPubMotion', text: '모션으로 등록' });
    const idleBtn = h('button', { class: 'btn btn-primary', type: 'button', id: 'chromaPubIdle', text: '대기(Idle)로 등록' });
    const downloadLink = h('a', { class: 'btn btn-secondary', id: 'chromaDownload', text: 'WebM 다운로드', attrs: { download: '' } });
    actionsRow.appendChild(motionBtn);
    actionsRow.appendChild(idleBtn);
    actionsRow.appendChild(downloadLink);
    result.appendChild(actionsRow);
    editor.appendChild(result);

    body.appendChild(editor);

    // Cache handles
    Object.assign(dom, {
      dropZone, fileInput, dzLabel, nameInput, uploadBtn, uploadSpinner: uploadBtn.querySelector('.btn-spinner'),
      progressWrap, progressFill, progressText, sourceMeta, changeBtn,
      editor, canvas, previewImg, previewMsg, previewWrap,
      frameRow, frameSlider, frameTime,
      colorPicker, hexInput, autoBtn, simSlider, simOut, blendSlider, blendOut,
      despillCb, despillNote, resetBtn,
      convertBtn, convProgressWrap, convFill, convText, cancelBtn, convError,
      resultSection: result, resultVideo, resultWrap, resultMeta, staleNote,
      cmdCode, cmdCopy, pubName, motionBtn, idleBtn, downloadLink
    });

    wireEvents();

    // Initialize params from defaults.
    state.params = {
      color: normalizeHex(state.defaults.color) || '#00FF00',
      similarity: state.defaults.similarity,
      blend: state.defaults.blend,
      despill: !!state.defaults.despill
    };
    syncControlsFromParams();
  }

  function buildBgToggle(which) {
    const group = h('div', { class: 'chroma-bg-toggle', attrs: { role: 'group', 'aria-label': '미리보기 배경 선택' } });
    const opts = [['checker', '체크무늬'], ['dark', '어두운 배경'], ['light', '밝은 배경']];
    opts.forEach((o) => {
      const b = h('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: o[1] });
      b.setAttribute('aria-pressed', o[0] === 'checker' ? 'true' : 'false');
      b.dataset.bg = o[0];
      b.dataset.which = which;
      b.addEventListener('click', () => setBg(which, o[0], group));
      group.appendChild(b);
    });
    return group;
  }

  function setBg(which, bg, group) {
    if (which === 'preview') state.previewBg = bg; else state.resultBg = bg;
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.bg === bg ? 'true' : 'false'));
    const wrap = which === 'preview' ? dom.previewWrap : dom.resultWrap;
    applyBgClass(wrap, bg);
  }

  function applyBgClass(wrap, bg) {
    if (!wrap) return;
    wrap.classList.remove('checkerboard-bg', 'chroma-bg-dark', 'chroma-bg-light');
    if (bg === 'dark') wrap.classList.add('chroma-bg-dark');
    else if (bg === 'light') wrap.classList.add('chroma-bg-light');
    else wrap.classList.add('checkerboard-bg');
  }

  // ==========================================================================
  // Event wiring
  // ==========================================================================
  function wireEvents() {
    // Drop zone
    dom.dropZone.addEventListener('click', (e) => {
      if (e.target === dom.fileInput) return; // the programmatic click bubbles back here
      dom.fileInput.click();
    });
    dom.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dom.fileInput.click();
      }
    });
    dom.fileInput.addEventListener('change', () => {
      const f = dom.fileInput.files && dom.fileInput.files[0];
      if (f) dom.dzLabel.textContent = f.name;
    });
    dom.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropZone.classList.add('dragover'); });
    dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('dragover'));
    dom.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.dropZone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        dom.fileInput.files = e.dataTransfer.files;
        dom.dzLabel.textContent = e.dataTransfer.files[0].name;
      }
    });

    dom.uploadBtn.addEventListener('click', onUploadClick);
    dom.changeBtn.addEventListener('click', onChangeSource);

    // Frame canvas eyedropper
    dom.canvas.addEventListener('click', onCanvasClick);
    dom.canvas.style.cursor = 'crosshair';

    // Color inputs
    dom.colorPicker.addEventListener('input', () => setColor(dom.colorPicker.value));
    dom.hexInput.addEventListener('change', () => {
      const n = normalizeHex(dom.hexInput.value);
      if (n) setColor(n);
      else { dom.hexInput.value = state.params.color; toast('올바른 16진 색상값이 아닙니다 (예: #00FF00).', 'error'); }
    });
    dom.autoBtn.addEventListener('click', autoDetectColor);

    // Sliders
    dom.simSlider.addEventListener('input', () => {
      state.params.similarity = clampNumber(Number(dom.simSlider.value), state.limits.similarity[0], state.limits.similarity[1]);
      dom.simOut.textContent = String(Number(state.params.similarity.toFixed(4)));
      schedulePreview();
    });
    dom.blendSlider.addEventListener('input', () => {
      state.params.blend = clampNumber(Number(dom.blendSlider.value), state.limits.blend[0], state.limits.blend[1]);
      dom.blendOut.textContent = String(Number(state.params.blend.toFixed(4)));
      schedulePreview();
    });
    dom.despillCb.addEventListener('change', () => {
      state.params.despill = dom.despillCb.checked && !dom.despillCb.disabled;
      schedulePreview();
    });
    dom.resetBtn.addEventListener('click', () => {
      state.params = {
        color: normalizeHex(state.defaults.color) || '#00FF00',
        similarity: state.defaults.similarity,
        blend: state.defaults.blend,
        despill: !!state.defaults.despill
      };
      syncControlsFromParams();
      schedulePreview();
    });

    // Frame slider
    dom.frameSlider.addEventListener('input', () => {
      state.t = Number(dom.frameSlider.value);
      dom.frameTime.textContent = state.t.toFixed(2) + '초';
      scheduleFrame();
      schedulePreview();
    });

    // Convert / cancel
    dom.convertBtn.addEventListener('click', onConvert);
    dom.cancelBtn.addEventListener('click', onCancel);

    // Result actions
    dom.cmdCopy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(dom.cmdCode.textContent || ''); toast('명령을 복사했습니다.', 'success'); }
      catch { toast('복사에 실패했습니다.', 'error'); }
    });
    dom.motionBtn.addEventListener('click', () => publish('motion'));
    dom.idleBtn.addEventListener('click', () => {
      if (confirm('기존 대기 아바타가 교체됩니다')) publish('idle');
    });
    dom.pubName.addEventListener('input', () => { /* used at publish time */ });
  }

  // ==========================================================================
  // Params <-> controls
  // ==========================================================================
  function syncControlsFromParams() {
    const p = state.params;
    dom.colorPicker.value = p.color;
    dom.hexInput.value = p.color;
    dom.simSlider.value = String(p.similarity);
    dom.simOut.textContent = String(Number(p.similarity.toFixed(4)));
    dom.blendSlider.value = String(p.blend);
    dom.blendOut.textContent = String(Number(p.blend.toFixed(4)));
    updateDespillAvailability();
    dom.despillCb.checked = p.despill && !dom.despillCb.disabled;
  }

  function setColor(hex) {
    const n = normalizeHex(hex);
    if (!n) return;
    state.params.color = n;
    dom.colorPicker.value = n;
    dom.hexInput.value = n;
    updateDespillAvailability();
    schedulePreview();
  }

  // Enable despill only when the server rule would classify it green/blue.
  function updateDespillAvailability() {
    const type = despillType(state.params.color);
    if (type) {
      dom.despillCb.disabled = false;
      dom.despillNote.textContent = type === 'green' ? '(녹색 배경)' : '(파란 배경)';
    } else {
      dom.despillCb.disabled = true;
      dom.despillCb.checked = false;
      state.params.despill = false;
      dom.despillNote.textContent = '(이 색에는 적용할 수 없습니다)';
    }
  }

  // ==========================================================================
  // Upload
  // ==========================================================================
  function onUploadClick() {
    if (state.uploading) return;
    const file = dom.fileInput.files && dom.fileInput.files[0];
    if (!file) { toast('업로드할 영상을 먼저 선택하세요.', 'error'); return; }

    const ext = extOf(file.name);
    if (state.acceptedExtensions.indexOf(ext) === -1) {
      toast('지원하지 않는 형식입니다: ' + (ext || '(없음)') + ' — ' + state.acceptedExtensions.join(', '), 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast('파일이 500MB를 초과합니다.', 'error');
      return;
    }
    uploadFile(file, dom.nameInput.value.trim());
  }

  function uploadFile(file, label) {
    state.uploading = true;
    dom.uploadBtn.disabled = true;
    dom.uploadSpinner.classList.remove('hidden');
    dom.progressWrap.classList.remove('hidden');
    dom.progressFill.style.width = '0%';
    dom.progressText.textContent = '업로드 중… 0%';

    const oldJobId = state.job ? state.job.id : null;

    const params = new URLSearchParams();
    params.set('filename', file.name);
    if (label) params.set('name', label);
    const url = './api/chroma/jobs?' + params.toString();

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        dom.progressFill.style.width = pct + '%';
        dom.progressText.textContent = '업로드 중… ' + pct + '%';
      }
    };
    xhr.onload = async () => {
      state.uploading = false;
      dom.uploadBtn.disabled = false;
      dom.uploadSpinner.classList.add('hidden');
      dom.progressWrap.classList.add('hidden');
      if (xhr.status === 201) {
        let job = null;
        try { job = JSON.parse(xhr.responseText); } catch (_) { job = null; }
        if (!job) { toast('서버 응답을 해석할 수 없습니다.', 'error'); return; }
        // Delete the previous job after the new one is created (one current job).
        if (oldJobId && oldJobId !== job.id) deleteJob(oldJobId).catch(() => {});
        adoptJob(job);
        toast('영상을 업로드했습니다.', 'success');
        log('배경 제거: 원본 영상 업로드 완료 — ' + (job.name || job.id), 'info');
      } else {
        let msg = 'HTTP ' + xhr.status;
        try { const j = JSON.parse(xhr.responseText); if (j && j.error) msg = j.error; } catch (_) {}
        toast('업로드 실패: ' + msg, 'error');
        log('배경 제거 업로드 실패: ' + msg, 'error');
      }
    };
    xhr.onerror = () => {
      state.uploading = false;
      dom.uploadBtn.disabled = false;
      dom.uploadSpinner.classList.add('hidden');
      dom.progressWrap.classList.add('hidden');
      toast('업로드 중 네트워크 오류가 발생했습니다.', 'error');
    };
    xhr.send(file);
  }

  function onChangeSource() {
    const id = state.job ? state.job.id : null;
    stopPolling();
    if (id) deleteJob(id).catch(() => {});
    resetToUpload();
  }

  function resetToUpload() {
    resetJobUi();
    state.job = null;
    state.t = 0;
    dom.editor.classList.add('hidden');
    dom.sourceMeta.classList.add('hidden');
    dom.changeBtn.classList.add('hidden');
    dom.fileInput.value = '';
    dom.dzLabel.textContent = '녹색/파란 배경 영상을 끌어다 놓거나 클릭하여 선택';
  }

  // Clear everything that belongs to the previous job so a newly adopted job
  // never shows a stale result, error, progress bar, preview or frame, and no
  // timer or request of the old job keeps running.
  function resetJobUi() {
    stopPolling();
    clearTimeout(state.previewDebounce);
    clearTimeout(state.frameDebounce);
    state.previewDebounce = null;
    state.frameDebounce = null;
    if (state.previewController) { state.previewController.abort(); state.previewController = null; }
    if (state.frameController) { state.frameController.abort(); state.frameController = null; }
    state.frameSeq++;
    state.frameLoaded = false;
    dom.canvas.width = 0;
    dom.canvas.height = 0;
    if (dom.previewImg.dataset.objurl) URL.revokeObjectURL(dom.previewImg.dataset.objurl);
    delete dom.previewImg.dataset.objurl;
    dom.previewImg.removeAttribute('src');
    dom.previewImg.classList.add('hidden');
    dom.previewMsg.textContent = '';
    dom.previewWrap.classList.remove('is-loading');
    dom.convProgressWrap.classList.add('hidden');
    dom.convError.classList.add('hidden');
    dom.convError.textContent = '';
    dom.convertBtn.disabled = false;
    dom.resultSection.classList.add('hidden');
    dom.resultVideo.removeAttribute('src');
    dom.resultVideo.load();
    dom.staleNote.classList.add('hidden');
    dom.pubName.value = '';
  }

  // ==========================================================================
  // Job adoption / restore
  // ==========================================================================
  async function restoreLatestJob() {
    try {
      const res = await fetch('./api/chroma/jobs', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
      if (jobs.length) {
        adoptJob(jobs[0]); // newest first
      }
    } catch (_) { /* ignore */ }
  }

  function adoptJob(job) {
    resetJobUi();
    state.job = job;
    // Restore params from the job if a conversion was done before.
    if (job.params) {
      state.params = {
        color: normalizeHex(job.params.color) || state.params.color,
        similarity: job.params.similarity,
        blend: job.params.blend,
        despill: !!job.params.despill
      };
    }
    syncControlsFromParams();
    renderSourceMeta();
    setupFrameSlider();
    dom.editor.classList.remove('hidden');
    dom.changeBtn.classList.remove('hidden');
    loadFrame();
    schedulePreview();

    if (job.state === 'converting') {
      showConvertProgress(job.progress);
      startPolling();
    } else if (job.state === 'done') {
      renderResult();
    } else if (job.state === 'failed') {
      showConvertError(job.error);
    }
  }

  function renderSourceMeta() {
    const s = state.job.source || {};
    const parts = [];
    if (s.width && s.height) parts.push(s.width + '×' + s.height);
    if (Number.isFinite(s.duration)) parts.push(s.duration.toFixed(1) + '초');
    if (Number.isFinite(s.fps)) parts.push(s.fps + 'fps');
    if (s.codec) parts.push(s.codec);
    if (Number.isFinite(s.size)) parts.push(formatBytes(s.size));
    dom.sourceMeta.textContent = (state.job.name ? state.job.name + ' · ' : '') + parts.join(' · ');
    dom.sourceMeta.classList.remove('hidden');
  }

  function setupFrameSlider() {
    const s = state.job.source || {};
    if (Number.isFinite(s.duration) && s.duration > 0) {
      const max = Math.max(0, s.duration - 0.1);
      const step = Number.isFinite(s.fps) && s.fps > 0 ? Math.max(0.01, 1 / s.fps) : 0.05;
      dom.frameSlider.min = '0';
      dom.frameSlider.max = String(max);
      dom.frameSlider.step = String(Number(step.toFixed(4)));
      dom.frameSlider.value = '0';
      state.t = 0;
      dom.frameTime.textContent = '0.00초';
      dom.frameRow.classList.remove('hidden');
    } else {
      state.t = 0;
      dom.frameRow.classList.add('hidden');
    }
  }

  // ==========================================================================
  // Original frame (canvas) + eyedropper
  // ==========================================================================
  // One 2D context for the frame canvas; willReadFrequently keeps repeated
  // getImageData reads (eyedropper, auto detect) on the fast CPU path.
  function frameContext() {
    return dom.canvas.getContext('2d', { willReadFrequently: true });
  }

  function scheduleFrame() {
    clearTimeout(state.frameDebounce);
    state.frameDebounce = setTimeout(loadFrame, FRAME_DEBOUNCE_MS);
  }

  // Fetch the original frame at state.t and paint it on the canvas. Each call
  // aborts the previous request (the server then kills that ffmpeg child) and
  // drops stale responses, so scrubbing never stacks frame extractions or
  // paints an older frame over a newer one.
  async function loadFrame() {
    if (!state.job || !state.job.frameUrl) return;
    if (state.frameController) state.frameController.abort();
    const controller = new AbortController();
    state.frameController = controller;
    const seq = ++state.frameSeq;
    const url = state.job.frameUrl + '?t=' + encodeURIComponent(state.t);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) return;
      const blob = await res.blob();
      if (seq !== state.frameSeq) return;
      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        if (seq !== state.frameSeq) return;
        dom.canvas.width = img.naturalWidth;
        dom.canvas.height = img.naturalHeight;
        frameContext().drawImage(img, 0, 0);
        state.frameLoaded = true;
      };
      img.onerror = () => URL.revokeObjectURL(objUrl);
      img.src = objUrl;
    } catch (_) {
      /* aborted or failed: the next request repaints; the preview pane reports errors */
    } finally {
      if (state.frameController === controller) state.frameController = null;
    }
  }

  function onCanvasClick(e) {
    const canvas = dom.canvas;
    if (!state.frameLoaded || !canvas.width || !canvas.height) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // object-fit: contain letterboxes the bitmap inside the element box.
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const px = (e.clientX - rect.left - (rect.width - canvas.width * scale) / 2) / scale;
    const py = (e.clientY - rect.top - (rect.height - canvas.height * scale) / 2) / scale;
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return; // clicked the letterbox
    const nx = Math.floor(px);
    const ny = Math.floor(py);
    const ctx = frameContext();
    // Average a 5x5 area at the clicked natural-pixel position.
    const x0 = clampNumber(nx - 2, 0, canvas.width - 1);
    const y0 = clampNumber(ny - 2, 0, canvas.height - 1);
    const w = Math.min(5, canvas.width - x0);
    const hgt = Math.min(5, canvas.height - y0);
    let data;
    try { data = ctx.getImageData(x0, y0, w, hgt).data; } catch (_) { return; }
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; count++; }
    if (!count) return;
    const hex = '#' + [r, g, b].map((v) => Math.round(v / count).toString(16).padStart(2, '0')).join('').toUpperCase();
    setColor(hex);
  }

  // Auto-detect: per-channel median of border pixels (~2px inset, every ~4px).
  function autoDetectColor() {
    const canvas = dom.canvas;
    if (!state.frameLoaded || !canvas.width || !canvas.height) { toast('프레임을 불러오는 중입니다. 잠시 후 다시 시도하세요.', 'error'); return; }
    const ctx = frameContext();
    let data;
    try { data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; } catch (_) { toast('프레임 픽셀을 읽을 수 없습니다.', 'error'); return; }
    const W = canvas.width, H = canvas.height;
    const inset = 2, stepPx = 4;
    const rs = [], gs = [], bs = [];
    function sample(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
    for (let x = 0; x < W; x += stepPx) { sample(x, inset); sample(x, H - 1 - inset); }
    for (let y = 0; y < H; y += stepPx) { sample(inset, y); sample(W - 1 - inset, y); }
    if (!rs.length) return;
    const median = (arr) => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; };
    const hex = '#' + [median(rs), median(gs), median(bs)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    setColor(hex);
    toast('배경색을 자동 감지했습니다: ' + hex, 'info');
  }

  // ==========================================================================
  // Preview (debounced, abortable)
  // ==========================================================================
  function schedulePreview() {
    updateStaleNote();
    if (!state.job || !state.job.previewUrl) return;
    if (state.previewDebounce) clearTimeout(state.previewDebounce);
    state.previewDebounce = setTimeout(fetchPreview, PREVIEW_DEBOUNCE_MS);
  }

  async function fetchPreview() {
    if (!state.job || !state.job.previewUrl) return;
    if (state.previewController) state.previewController.abort();
    const controller = new AbortController();
    state.previewController = controller;

    const p = state.params;
    const params = new URLSearchParams();
    params.set('t', String(state.t));
    params.set('color', p.color.slice(1)); // send RRGGBB
    params.set('similarity', String(Number(p.similarity.toFixed(4))));
    params.set('blend', String(Number(p.blend.toFixed(4))));
    params.set('despill', p.despill ? '1' : '0');
    const url = state.job.previewUrl + '?' + params.toString();

    dom.previewWrap.classList.add('is-loading');
    dom.previewMsg.textContent = '';
    try {
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        dom.previewImg.removeAttribute('src');
        dom.previewImg.classList.add('hidden');
        dom.previewMsg.textContent = '미리보기 오류: ' + msg;
        return;
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const prev = dom.previewImg.dataset.objurl;
      dom.previewImg.onload = () => {
        dom.previewImg.classList.remove('hidden');
        if (prev) URL.revokeObjectURL(prev);
      };
      dom.previewImg.src = objUrl;
      dom.previewImg.dataset.objurl = objUrl;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // superseded
      dom.previewMsg.textContent = '미리보기를 불러오지 못했습니다.';
    } finally {
      if (state.previewController === controller) {
        dom.previewWrap.classList.remove('is-loading');
        state.previewController = null;
      }
    }
  }

  // ==========================================================================
  // Convert / poll / cancel
  // ==========================================================================
  async function onConvert() {
    if (!state.job) return;
    dom.convError.classList.add('hidden');
    dom.convertBtn.disabled = true;
    const p = state.params;
    const body = {
      color: p.color,
      similarity: Number(p.similarity.toFixed(4)),
      blend: Number(p.blend.toFixed(4)),
      despill: !!p.despill
    };
    try {
      const res = await fetch('./api/chroma/jobs/' + state.job.id + '/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status === 202) {
        const job = await res.json();
        state.job = job;
        showConvertProgress(job.progress);
        dom.resultVideo.pause();
        dom.resultSection.classList.add('hidden');
        log('배경 제거: 변환 시작', 'info');
        startPolling();
      } else if (res.status === 409) {
        dom.convertBtn.disabled = false;
        toast('다른 변환이 진행 중입니다', 'error');
      } else {
        dom.convertBtn.disabled = false;
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        toast('변환 요청 실패: ' + msg, 'error');
      }
    } catch (err) {
      dom.convertBtn.disabled = false;
      toast('변환 요청 중 오류가 발생했습니다.', 'error');
    }
  }

  function showConvertProgress(progress) {
    dom.convertBtn.disabled = true;
    dom.convProgressWrap.classList.remove('hidden');
    updateConvProgress(progress);
  }

  function showConvertError(message) {
    dom.convError.textContent = '변환 실패: ' + (message || '알 수 없는 오류') + ' (다시 시도할 수 있습니다)';
    dom.convError.classList.remove('hidden');
  }

  function updateConvProgress(progress) {
    if (progress == null || !Number.isFinite(progress)) {
      dom.convFill.classList.add('indeterminate');
      dom.convFill.style.width = '100%';
      dom.convText.textContent = '변환 중…';
    } else {
      dom.convFill.classList.remove('indeterminate');
      const pct = Math.round(progress * 100);
      dom.convFill.style.width = pct + '%';
      dom.convText.textContent = '변환 중… ' + pct + '%';
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollJob, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function pollJob() {
    if (!state.job || !state.job.id) { stopPolling(); return; }
    try {
      const res = await fetch('./api/chroma/jobs/' + state.job.id, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (res.status === 404) { stopPolling(); return; }
      if (!res.ok) return;
      const job = await res.json();
      state.job = job;
      if (job.state === 'converting') {
        updateConvProgress(job.progress);
      } else if (job.state === 'done') {
        stopPolling();
        dom.convProgressWrap.classList.add('hidden');
        dom.convertBtn.disabled = false;
        renderResult();
        toast('변환이 완료되었습니다.', 'success');
        log('배경 제거: 변환 완료', 'info');
      } else if (job.state === 'failed') {
        stopPolling();
        dom.convProgressWrap.classList.add('hidden');
        dom.convertBtn.disabled = false;
        showConvertError(job.error);
        log('배경 제거: 변환 실패 — ' + (job.error || ''), 'error');
      } else {
        // canceled (or any other non-converting state): allow converting again.
        stopPolling();
        dom.convProgressWrap.classList.add('hidden');
        dom.convertBtn.disabled = false;
      }
    } catch (_) { /* transient; keep polling */ }
  }

  async function onCancel() {
    if (!state.job || !state.job.id) return;
    try {
      const res = await fetch('./api/chroma/jobs/' + state.job.id + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.ok) {
        const job = await res.json();
        state.job = job;
        stopPolling();
        dom.convProgressWrap.classList.add('hidden');
        dom.convertBtn.disabled = false;
        toast('변환을 취소했습니다.', 'info');
      } else if (res.status === 409) {
        toast('진행 중인 변환이 없습니다.', 'error');
      }
    } catch (_) { toast('취소 요청 중 오류가 발생했습니다.', 'error'); }
  }

  // ==========================================================================
  // Result rendering + publish
  // ==========================================================================
  function renderResult() {
    const job = state.job;
    if (!job || job.state !== 'done' || !job.result) return;
    dom.resultSection.classList.remove('hidden');
    applyBgClass(dom.resultWrap, state.resultBg);
    dom.resultVideo.src = job.result.url;
    dom.resultVideo.load();

    // Meta line
    dom.resultMeta.textContent = '';
    const sizeSpan = h('span', { text: '크기: ' + formatBytes(job.result.size) });
    dom.resultMeta.appendChild(sizeSpan);
    const alphaSpan = h('span', { class: job.result.alpha ? 'chroma-alpha-ok' : 'chroma-alpha-warn', text: job.result.alpha ? '알파 채널 확인됨 ✓' : '경고: 알파 채널이 감지되지 않았습니다' });
    dom.resultMeta.appendChild(alphaSpan);

    // Command
    dom.cmdCode.textContent = job.command || '';

    updateStaleNote();

    // Publish name default
    if (!dom.pubName.value) dom.pubName.value = job.name || '';

    // Download link (always from Job JSON)
    dom.downloadLink.href = job.result.downloadUrl;
  }

  function paramsDiffer(cur, saved) {
    if (!saved) return true;
    const c1 = normalizeHex(cur.color), c2 = normalizeHex(saved.color);
    if (c1 !== c2) return true;
    if (Number(cur.similarity.toFixed(2)) !== Number(Number(saved.similarity).toFixed(2))) return true;
    if (Number(cur.blend.toFixed(2)) !== Number(Number(saved.blend).toFixed(2))) return true;
    if (!!cur.despill !== !!saved.despill) return true;
    return false;
  }

  // Live "settings changed" hint: shown while a finished result exists and the
  // controls no longer match the parameters it was encoded with.
  function updateStaleNote() {
    const job = state.job;
    const stale = !!(job && job.state === 'done' && job.result && paramsDiffer(state.params, job.params));
    dom.staleNote.classList.toggle('hidden', !stale);
  }

  async function publish(kind) {
    if (!state.job || !state.job.id) return;
    if (state.job.state !== 'done') { toast('변환이 완료된 뒤에 등록할 수 있습니다.', 'error'); return; }
    const name = dom.pubName.value.trim() || state.job.name || '';
    try {
      const res = await fetch('./api/chroma/jobs/' + state.job.id + '/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, name: name })
      });
      if (res.status === 201) {
        const item = await res.json();
        const label = kind === 'idle' ? '대기(Idle)' : '모션';
        toast('"' + (item.name || name) + '"을(를) ' + label + '(으)로 등록했습니다.', 'success');
        log('배경 제거: ' + label + ' 등록 완료 — ' + (item.name || name), 'info');
        // The library re-renders via the existing SSE broadcast.
      } else if (res.status === 409) {
        toast('변환이 완료된 뒤에 등록할 수 있습니다.', 'error');
      } else {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        toast('등록 실패: ' + msg, 'error');
      }
    } catch (_) { toast('등록 요청 중 오류가 발생했습니다.', 'error'); }
  }

  async function deleteJob(id) {
    const res = await fetch('./api/chroma/jobs/' + id, { method: 'DELETE' });
    return res.ok;
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
