/**
 * Virtually Controller Application
 * OBS Transparent Avatar & Motion Trigger System
 */

(function () {
  'use strict';

  // ==========================================================================
  // State
  // ==========================================================================
  let libraryState = {
    idle: null,
    motions: []
  };

  let eventSource = null;
  let isIdleUploading = false;
  let isMotionUploading = false;
  let visibleMotionCount = 60;

  // ==========================================================================
  // DOM Elements
  // ==========================================================================
  const el = {
    connectionStatus: document.getElementById('connectionStatus'),
    openOverlayBtn: document.getElementById('openOverlayBtn'),
    overlayUrlInput: document.getElementById('overlayUrlInput'),
    copyUrlBtn: document.getElementById('copyUrlBtn'),
    copyBtnText: document.getElementById('copyBtnText'),
    refreshOverlayBtn: document.getElementById('refreshOverlayBtn'),
    overlayPreviewFrame: document.getElementById('overlayPreviewFrame'),
    previewPlayStatus: document.getElementById('previewPlayStatus'),
    previewLastSeq: document.getElementById('previewLastSeq'),
    eventLogContainer: document.getElementById('eventLogContainer'),
    clearLogBtn: document.getElementById('clearLogBtn'),
    toastContainer: document.getElementById('toastContainer'),

    // Demo triggers
    headerDemoTriggerBtn: document.getElementById('headerDemoTriggerBtn'),
    inlineDemoTriggerBtn: document.getElementById('inlineDemoTriggerBtn'),

    // Idle
    idleMediaContainer: document.getElementById('idleMediaContainer'),
    idleUploadForm: document.getElementById('idleUploadForm'),
    idleDropZone: document.getElementById('idleDropZone'),
    idleFileInput: document.getElementById('idleFileInput'),
    idleDropZoneLabel: document.getElementById('idleDropZoneLabel'),
    idleNameInput: document.getElementById('idleNameInput'),
    idleUploadBtn: document.getElementById('idleUploadBtn'),
    idleUploadSpinner: document.getElementById('idleUploadSpinner'),

    // Motions
    motionCountBadge: document.getElementById('motionCountBadge'),
    motionsListContainer: document.getElementById('motionsListContainer'),
    motionSearchInput: document.getElementById('motionSearchInput'),
    moreMotionsBtn: document.getElementById('moreMotionsBtn'),
    motionUploadForm: document.getElementById('motionUploadForm'),
    motionDropZone: document.getElementById('motionDropZone'),
    motionFileInput: document.getElementById('motionFileInput'),
    motionDropZoneLabel: document.getElementById('motionDropZoneLabel'),
    motionNameInput: document.getElementById('motionNameInput'),
    motionUploadBtn: document.getElementById('motionUploadBtn'),
    motionUploadSpinner: document.getElementById('motionUploadSpinner')
  };

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Safe text escaping helper creating a text node or setting textContent
   */
  function setText(element, text) {
    if (element) {
      element.textContent = text == null ? '' : String(text);
    }
  }

  /**
   * Format ISO date string to Korean friendly format
   */
  function formatDate(isoString) {
    if (!isoString) return '-';
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      return d.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return isoString;
    }
  }

  /**
   * Display toast notification
   */
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;

    const content = document.createElement('div');
    content.className = 'toast-content';
    content.textContent = message; // Safe textContent escaping

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', '닫기');
    closeBtn.textContent = '×';
    closeBtn.onclick = () => {
      toast.remove();
    };

    toast.appendChild(content);
    toast.appendChild(closeBtn);
    el.toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 4500);
  }

  /**
   * Append event entry to log container
   */
  function addLog(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = 'log-entry log-entry-' + type;

    const time = document.createElement('span');
    time.className = 'log-time';
    const now = new Date();
    time.textContent = now.toTimeString().split(' ')[0];

    const message = document.createElement('span');
    message.className = 'log-msg';
    message.textContent = msg; // Safe textContent escaping

    entry.appendChild(time);
    entry.appendChild(message);

    el.eventLogContainer.appendChild(entry);
    el.eventLogContainer.scrollTop = el.eventLogContainer.scrollHeight;

    // Keep max 80 entries
    while (el.eventLogContainer.children.length > 80) {
      el.eventLogContainer.removeChild(el.eventLogContainer.firstChild);
    }
  }

  // ==========================================================================
  // OBS URL & Setup
  // ==========================================================================

  function setupObsUrl() {
    const fullOverlayUrl = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '') + '/overlay';
    el.overlayUrlInput.value = fullOverlayUrl;

    el.copyUrlBtn.addEventListener('click', async () => {
      const url = el.overlayUrlInput.value;
      let copied = false;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch {
          copied = false;
        }
      }

      if (!copied) {
        try {
          el.overlayUrlInput.select();
          document.execCommand('copy');
          copied = true;
        } catch {
          copied = false;
        }
      }

      if (copied) {
        el.copyBtnText.textContent = '복사 완료! ✓';
        showToast('OBS 브라우저 소스 URL이 클립보드에 복사되었습니다.', 'success');
        setTimeout(() => {
          el.copyBtnText.textContent = 'URL 복사';
        }, 2200);
      } else {
        showToast('클립보드 복사에 실패했습니다. URL을 직접 복사해주세요.', 'error');
      }
    });

    el.refreshOverlayBtn.addEventListener('click', () => {
      el.overlayPreviewFrame.src = './overlay?t=' + Date.now();
      addLog('오버레이 미리보기를 새로고침했습니다.', 'info');
      showToast('오버레이 미리보기가 새로고침되었습니다.', 'info');
    });
  }

  // ==========================================================================
  // SSE Connection & Status
  // ==========================================================================

  function setConnectionStatus(status) {
    el.connectionStatus.className = 'status-pill status-' + status;
    const label = el.connectionStatus.querySelector('.status-label');
    if (status === 'connected') {
      setText(label, '실시간 연결됨');
    } else if (status === 'connecting') {
      setText(label, '재연결 시도 중');
    } else {
      setText(label, '연결 끊김');
    }
  }

  function initSSE() {
    if (eventSource) {
      eventSource.close();
    }

    setConnectionStatus('connecting');
    eventSource = new EventSource('./api/events');

    eventSource.onopen = () => {
      setConnectionStatus('connected');
      addLog('서버 SSE 이벤트 스트림에 연결되었습니다.', 'info');
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerEvent(data);
      } catch (err) {
        addLog('이벤트 파싱 오류: ' + err.message, 'error');
      }
    };

    eventSource.onerror = () => {
      setConnectionStatus('disconnected');
      addLog('SSE 연결이 중단되었습니다. 재연결을 시도합니다...', 'error');
    };
  }

  function handleServerEvent(event) {
    if (!event || !event.type) return;

    if (event.type === 'library') {
      if (event.library) {
        libraryState = event.library;
        renderLibrary();
        addLog('라이브러리 목록이 동기화되었습니다.', 'info');
      }
    } else if (event.type === 'play') {
      const { id, seq } = event;
      handlePlayEvent(id, seq);
    }
  }

  function handlePlayEvent(id, seq) {
    el.previewLastSeq.textContent = '#' + (seq != null ? seq : '-');

    let triggeredName = '데모 동작';
    if (id === 'demo') {
      triggeredName = '기본 데모 동작';
      highlightDemoButtons();
    } else {
      const motion = libraryState.motions.find((m) => m.id === id);
      if (motion) {
        triggeredName = motion.name || motion.id;
      } else {
        triggeredName = '모션 (' + id + ')';
      }
      highlightMotionCard(id);
    }

    addLog('모션 재생 요청: ' + triggeredName + ' (seq #' + seq + ')', 'play');
  }

  function highlightDemoButtons() {
    clearHighlights();
    if (el.headerDemoTriggerBtn) el.headerDemoTriggerBtn.classList.add('is-playing');
    if (el.inlineDemoTriggerBtn) el.inlineDemoTriggerBtn.classList.add('is-playing');
  }

  function highlightMotionCard(id) {
    clearHighlights();
    const card = document.querySelector('[data-motion-id="' + CSS.escape(id) + '"]');
    if (card) {
      card.classList.add('is-playing');
    }
  }

  function clearHighlights() {
    if (el.headerDemoTriggerBtn) el.headerDemoTriggerBtn.classList.remove('is-playing');
    if (el.inlineDemoTriggerBtn) el.inlineDemoTriggerBtn.classList.remove('is-playing');
    document.querySelectorAll('.motion-item-card.is-playing').forEach((c) => {
      c.classList.remove('is-playing');
    });
  }

  // ==========================================================================
  // Library Fetch & Rendering
  // ==========================================================================

  async function fetchLibrary() {
    try {
      const res = await fetch('./api/library', {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      }
      const data = await res.json();
      libraryState = {
        idle: data.idle || null,
        motions: Array.isArray(data.motions) ? data.motions : []
      };
      renderLibrary();
    } catch (err) {
      addLog('라이브러리 불러오기 실패: ' + err.message, 'error');
      showToast('라이브러리 목록을 불러오지 못했습니다: ' + err.message, 'error');
    }
  }

  function renderLibrary() {
    renderIdle();
    renderMotions();
  }

  // Render Idle
  function renderIdle() {
    const container = el.idleMediaContainer;
    container.innerHTML = '';

    const idle = libraryState.idle;

    if (!idle) {
      // Blank library guidance
      const guidance = document.createElement('div');
      guidance.className = 'blank-guidance-box';

      const icon = document.createElement('div');
      icon.className = 'blank-guidance-icon';
      icon.textContent = '👤';

      const title = document.createElement('h4');
      title.textContent = '등록된 사용자 대기(Idle) 미디어가 없습니다';

      const desc = document.createElement('p');
      desc.textContent =
        '현재 OBS 오버레이는 내장 플레이스홀더 아바타를 표시하고 있습니다. 투명 배경의 WebM 비디오 또는 PNG/WebP 이미지를 아래에서 업로드하면 나만의 커스텀 아바타로 즉시 교체됩니다.';

      guidance.appendChild(icon);
      guidance.appendChild(title);
      guidance.appendChild(desc);
      container.appendChild(guidance);
      return;
    }

    // Media card
    const card = document.createElement('div');
    card.className = 'media-card';

    // Thumbnail
    const thumbBox = document.createElement('div');
    thumbBox.className = 'media-thumb-box checkerboard-bg';

    const isVideo = idle.mime ? idle.mime.startsWith('video/') : (idle.url && idle.url.endsWith('.webm'));
    if (isVideo) {
      const video = document.createElement('video');
      video.src = idle.url;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      thumbBox.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = idle.url;
      img.alt = idle.name || 'Idle Avatar';
      thumbBox.appendChild(img);
    }

    // Info
    const info = document.createElement('div');
    info.className = 'media-info';

    const titleLine = document.createElement('div');
    titleLine.className = 'media-title-line';

    const title = document.createElement('span');
    title.className = 'media-title';
    title.textContent = idle.name || '기본 대기 아바타'; // Safe DOM textContent

    const badge = document.createElement('span');
    badge.className = 'badge badge-user';
    badge.textContent = '사용자 아바타';

    titleLine.appendChild(title);
    titleLine.appendChild(badge);

    const metaLine = document.createElement('div');
    metaLine.className = 'media-meta-line';

    const mimeSpan = document.createElement('span');
    mimeSpan.textContent = '포맷: ' + (idle.mime || 'unknown');

    const dateSpan = document.createElement('span');
    dateSpan.textContent = '등록: ' + formatDate(idle.createdAt);

    metaLine.appendChild(mimeSpan);
    metaLine.appendChild(dateSpan);

    info.appendChild(titleLine);
    info.appendChild(metaLine);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'media-actions';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-secondary btn-sm';
    delBtn.textContent = '삭제';
    delBtn.onclick = () => deleteMedia(idle.id, idle.name || '대기 아바타');

    actions.appendChild(delBtn);

    card.appendChild(thumbBox);
    card.appendChild(info);
    card.appendChild(actions);

    container.appendChild(card);
  }

  // Render Motions
  function renderMotions() {
    const container = el.motionsListContainer;
    container.innerHTML = '';

    const motions = libraryState.motions || [];
    setText(el.motionCountBadge, motions.length + '개');
    el.moreMotionsBtn.hidden = true;

    if (motions.length === 0) {
      const guidance = document.createElement('div');
      guidance.className = 'blank-guidance-box';
      guidance.style.gridColumn = '1 / -1';

      const icon = document.createElement('div');
      icon.className = 'blank-guidance-icon';
      icon.textContent = '🎬';

      const title = document.createElement('h4');
      title.textContent = '등록된 모션 클립이 없습니다';

      const desc = document.createElement('p');
      desc.textContent =
        '시청자 반응, 도네이션 리액션 등에 사용할 투명 WebM (.webm) 비디오 클립을 아래에서 업로드해보세요. 업로드 전에는 상단의 [데모 동작] 버튼으로 동작 연동을 바로 테스트할 수 있습니다.';

      guidance.appendChild(icon);
      guidance.appendChild(title);
      guidance.appendChild(desc);
      container.appendChild(guidance);
      return;
    }

    const query = el.motionSearchInput.value.trim().toLocaleLowerCase();
    const matching = motions.filter((motion) => (motion.name || '').toLocaleLowerCase().includes(query)).reverse();
    el.moreMotionsBtn.hidden = matching.length <= visibleMotionCount;
    if (!matching.length) {
      const empty = document.createElement('p');
      empty.className = 'motion-search-empty';
      empty.textContent = '검색 결과가 없습니다.';
      container.appendChild(empty);
      return;
    }

    matching.slice(0, visibleMotionCount).forEach((motion) => {
      const card = document.createElement('div');
      card.className = 'motion-item-card';
      card.setAttribute('data-motion-id', motion.id);

      const top = document.createElement('div');
      top.className = 'motion-card-top';

      const info = document.createElement('div');
      info.className = 'motion-card-info';

      const name = document.createElement('div');
      name.className = 'motion-name';
      name.textContent = motion.name || motion.id; // Safe DOM textContent

      const subtext = document.createElement('div');
      subtext.className = 'motion-subtext';
      subtext.textContent = (motion.mime || 'video/webm') + ' • ' + formatDate(motion.createdAt);

      info.appendChild(name);
      info.appendChild(subtext);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-delete-icon';
      delBtn.title = '모션 삭제';
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      delBtn.onclick = () => deleteMedia(motion.id, motion.name || motion.id);

      top.appendChild(info);
      top.appendChild(delBtn);

      const actions = document.createElement('div');
      actions.className = 'motion-card-actions';

      const triggerBtn = document.createElement('button');
      triggerBtn.type = 'button';
      triggerBtn.className = 'btn-trigger';
      triggerBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
      const triggerLabel = document.createElement('span');
      triggerLabel.textContent = '지금 재생';
      triggerBtn.appendChild(triggerLabel);

      triggerBtn.onclick = () => triggerMotion(motion.id, motion.name || motion.id);

      actions.appendChild(triggerBtn);

      card.appendChild(top);
      card.appendChild(actions);

      container.appendChild(card);
    });
    el.moreMotionsBtn.textContent = `더 보기 (${Math.max(0, matching.length - visibleMotionCount)}개 남음)`;
  }

  // ==========================================================================
  // Trigger Motion
  // ==========================================================================

  async function triggerMotion(id, displayName) {
    try {
      addLog('모션 트리거 요청 중: ' + (displayName || id), 'info');
      const res = await fetch('./api/trigger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id: id })
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText || 'HTTP ' + res.status);
      }

      const result = await res.json();
      if (result.ok) {
        showToast((displayName || id) + ' 모션이 트리거되었습니다. (seq #' + result.seq + ')', 'success');
      }
    } catch (err) {
      addLog('모션 트리거 실패 (' + id + '): ' + err.message, 'error');
      showToast('모션 재생 요청 실패: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // Delete Media
  // ==========================================================================

  async function deleteMedia(id, name) {
    if (!confirm('"' + name + '" 미디어를 삭제하시겠습니까?')) {
      return;
    }

    try {
      addLog('미디어 삭제 중: ' + name, 'info');
      const res = await fetch('./api/media/' + encodeURIComponent(id), {
        method: 'DELETE'
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'HTTP ' + res.status);
      }

      showToast('미디어가 성공적으로 삭제되었습니다.', 'success');
      addLog('미디어 삭제 완료: ' + name, 'info');
      fetchLibrary();
    } catch (err) {
      addLog('미디어 삭제 실패: ' + err.message, 'error');
      showToast('미디어 삭제 중 오류가 발생했습니다: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // Upload Logic & Validation
  // ==========================================================================

  function validateFileType(file, kind) {
    if (!file) return { valid: false, message: '파일이 선택되지 않았습니다.' };

    const name = file.name.toLowerCase();
    const type = file.type ? file.type.toLowerCase() : '';

    if (kind === 'motion') {
      const isWebm = name.endsWith('.webm');
      if (!isWebm) {
        return {
          valid: false,
          message: '모션 클립은 투명 배경을 지원하는 .webm 비디오 파일만 업로드할 수 있습니다.'
        };
      }
    } else if (kind === 'idle') {
      const isWebm = name.endsWith('.webm');
      const isPng = name.endsWith('.png');
      const isWebp = name.endsWith('.webp');

      if (!isWebm && !isPng && !isWebp) {
        return {
          valid: false,
          message: '대기(Idle) 아바타는 .webm 비디오 또는 .png, .webp 이미지만 지원합니다.'
        };
      }
    }

    return { valid: true };
  }

  async function uploadMedia(file, kind, labelName, onProgressStart, onProgressEnd) {
    const validation = validateFileType(file, kind);
    if (!validation.valid) {
      showToast(validation.message, 'error');
      addLog('업로드 유효성 검사 실패: ' + validation.message, 'error');
      return;
    }

    const finalName = (labelName && labelName.trim()) || file.name.replace(/\.[^/.]+$/, '');
    const encodedName = encodeURIComponent(finalName);
    const contentType = file.type || (file.name.endsWith('.webm') ? 'video/webm' : 'application/octet-stream');

    try {
      onProgressStart();
      addLog('[' + (kind === 'idle' ? 'Idle' : 'Motion') + '] 파일 업로드 시작: ' + finalName, 'info');

      const url = './api/upload?kind=' + encodeURIComponent(kind) + '&name=' + encodedName + '&filename=' + encodeURIComponent(file.name);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType
        },
        body: file
      });

      if (!res.ok) {
        const errorMsg = await res.text();
        throw new Error(errorMsg || 'HTTP ' + res.status);
      }

      const media = await res.json();
      showToast('"' + (media.name || finalName) + '" 업로드가 완료되었습니다.', 'success');
      addLog('업로드 완료: ' + (media.name || finalName), 'info');

      fetchLibrary();
    } catch (err) {
      showToast('업로드 실패: ' + err.message, 'error');
      addLog('업로드 실패: ' + err.message, 'error');
    } finally {
      onProgressEnd();
    }
  }

  function setupUploadForms() {
    // Setup Idle Dropzone
    setupDropZone(
      el.idleDropZone,
      el.idleFileInput,
      el.idleDropZoneLabel,
      '.webm, .png, .webp 파일 선택됨'
    );

    el.idleUploadForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (isIdleUploading) return;

      const file = el.idleFileInput.files[0];
      if (!file) {
        showToast('업로드할 대기 파일을 먼저 선택해주세요.', 'error');
        return;
      }

      uploadMedia(
        file,
        'idle',
        el.idleNameInput.value,
        () => {
          isIdleUploading = true;
          el.idleUploadBtn.disabled = true;
          el.idleUploadSpinner.classList.remove('hidden');
        },
        () => {
          isIdleUploading = false;
          el.idleUploadBtn.disabled = false;
          el.idleUploadSpinner.classList.add('hidden');
          el.idleFileInput.value = '';
          el.idleNameInput.value = '';
          el.idleDropZoneLabel.textContent = '파일을 끌어다 놓거나 클릭하여 선택';
        }
      );
    });

    // Setup Motion Dropzone
    setupDropZone(
      el.motionDropZone,
      el.motionFileInput,
      el.motionDropZoneLabel,
      '.webm 모션 파일 선택됨'
    );

    el.motionUploadForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (isMotionUploading) return;

      const file = el.motionFileInput.files[0];
      if (!file) {
        showToast('업로드할 모션 WebM 파일을 먼저 선택해주세요.', 'error');
        return;
      }

      uploadMedia(
        file,
        'motion',
        el.motionNameInput.value,
        () => {
          isMotionUploading = true;
          el.motionUploadBtn.disabled = true;
          el.motionUploadSpinner.classList.remove('hidden');
        },
        () => {
          isMotionUploading = false;
          el.motionUploadBtn.disabled = false;
          el.motionUploadSpinner.classList.add('hidden');
          el.motionFileInput.value = '';
          el.motionNameInput.value = '';
          el.motionDropZoneLabel.textContent = '모션 WebM 파일을 끌어다 놓거나 클릭하여 선택';
        }
      );
    });
  }

  function setupDropZone(dropZone, fileInput, labelElem, selectedPrefix) {
    dropZone.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        labelElem.textContent = fileInput.files[0].name + ' (' + selectedPrefix + ')';
      }
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        labelElem.textContent = e.dataTransfer.files[0].name + ' (' + selectedPrefix + ')';
      }
    });
  }

  // ==========================================================================
  // Demo Triggers & Log Controls
  // ==========================================================================

  function setupDemoTriggers() {
    const handleDemoClick = () => {
      triggerMotion('demo', '데모 동작');
    };

    if (el.headerDemoTriggerBtn) {
      el.headerDemoTriggerBtn.addEventListener('click', handleDemoClick);
    }

    if (el.inlineDemoTriggerBtn) {
      el.inlineDemoTriggerBtn.addEventListener('click', handleDemoClick);
    }

    if (el.clearLogBtn) {
      el.clearLogBtn.addEventListener('click', () => {
        el.eventLogContainer.innerHTML = '';
        addLog('로그를 초기화했습니다.', 'info');
      });
    }
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  function init() {
    setupObsUrl();
    setupDemoTriggers();
    setupUploadForms();
    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin || event.source !== el.overlayPreviewFrame.contentWindow) return;
      if (!event.data || event.data.source !== 'virtually-overlay') return;
      if (event.data.state === 'idle') {
        setText(el.previewPlayStatus, '대기(Idle) 유지 중');
        el.previewPlayStatus.className = 'meta-value status-idle-text';
        clearHighlights();
      } else if (event.data.state === 'playing') {
        const motion = libraryState.motions.find(item => item.id === event.data.id);
        setText(el.previewPlayStatus, '미리보기 재생 중: ' + (event.data.id === 'demo' ? '데모 동작' : motion?.name || '모션'));
        el.previewPlayStatus.className = 'meta-value status-play-text';
      }
    });
    el.motionSearchInput.addEventListener('input', () => {
      visibleMotionCount = 60;
      renderMotions();
    });
    el.moreMotionsBtn.addEventListener('click', () => {
      visibleMotionCount += 60;
      renderMotions();
    });
    fetchLibrary();
    initSSE();
  }

  // Expose a tiny UI surface so chroma.js (a separate script) can reuse the
  // toast + event-log infrastructure instead of duplicating it.
  window.VirtuallyUI = { showToast, addLog };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
