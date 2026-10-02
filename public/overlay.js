'use strict';

// Size fit: pure helpers that place a motion video so its first-frame character
// box matches the idle character box. Exported for node tests like AnimateHelpers.
const OverlayFit = (() => {
  // Demo SVG avatar: viewBox size and the character box inside it (normalized, x1/y1 exclusive).
  const DEMO_VIEWBOX = Object.freeze({ width: 380, height: 440 });
  const DEMO_BOX = Object.freeze([0.2561, 0.1083, 0.8640, 0.9091]);
  // Mirrors .demo-avatar in overlay.css (380x440 px, max 85vw x 75vh, bottom 12 px, centred).
  const DEMO_CSS = Object.freeze({ width: 380, height: 440, maxW: 0.85, maxH: 0.75, bottom: 12 });
  // A first-frame box reaching this far down means the frame already cuts the body.
  const CUT_BOTTOM = 0.99;

  const finite = (...values) => values.every(v => typeof v === 'number' && Number.isFinite(v));

  function validBox(b) {
    return Array.isArray(b) && b.length === 4 && finite(...b) && b[2] > b[0] && b[3] > b[1];
  }

  function validCanvas(canvas) {
    return Boolean(canvas) && finite(canvas.width, canvas.height) && canvas.width > 0 && canvas.height > 0;
  }

  /** The demo avatar's layout rect computed from the CSS rules (used when no DOM rect is given). */
  function demoRect(canvas) {
    const width = Math.min(DEMO_CSS.width, DEMO_CSS.maxW * canvas.width);
    const height = Math.min(DEMO_CSS.height, DEMO_CSS.maxH * canvas.height);
    return {
      left: (canvas.width - width) / 2,
      top: canvas.height - DEMO_CSS.bottom - height,
      width,
      height,
    };
  }

  /** Map a normalized box onto a px rect: [x0, y0, x1, y1]. */
  function mapBox(rect, b) {
    return [
      rect.left + b[0] * rect.width,
      rect.top + b[1] * rect.height,
      rect.left + b[2] * rect.width,
      rect.top + b[3] * rect.height,
    ];
  }

  /**
   * The idle character box [x0, y0, x1, y1] in overlay px, or null when unknown.
   * `idle` null / without url = the demo SVG avatar: `measure.avatarRect` (its
   * getBoundingClientRect) or else the CSS rules, with the SVG content xMidYMid meet.
   * Idle media: placed like `.media-element` (never upscaled, centred, bottom-aligned)
   * from `measure.natural` (or idle.fit's size); the box is idle.fit.first when present.
   */
  function idleBox(canvas, idle, measure = {}) {
    if (!validCanvas(canvas)) return null;
    if (!idle || !idle.url) {
      const r = measure.avatarRect || demoRect(canvas);
      if (!finite(r.left, r.top, r.width, r.height) || r.width <= 0 || r.height <= 0) return null;
      const s = Math.min(r.width / DEMO_VIEWBOX.width, r.height / DEMO_VIEWBOX.height);
      const w = DEMO_VIEWBOX.width * s;
      const h = DEMO_VIEWBOX.height * s;
      return mapBox({ left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h }, DEMO_BOX);
    }
    const fit = idle.fit && typeof idle.fit === 'object' ? idle.fit : null;
    const natW = measure.natural?.width || fit?.width;
    const natH = measure.natural?.height || fit?.height;
    if (!finite(natW, natH) || natW <= 0 || natH <= 0) return null;
    const r = Math.min(1, canvas.width / natW, canvas.height / natH);
    const width = natW * r;
    const height = natH * r;
    const rect = { left: (canvas.width - width) / 2, top: canvas.height - height, width, height };
    return mapBox(rect, fit && validBox(fit.first) ? fit.first : [0, 0, 1, 1]);
  }

  /**
   * Where to draw a motion video so its first-frame character box matches `box`
   * (the idle box): { left, top, width, height, mode } in px, or null to keep the CSS.
   * 'cut'  - the first frame reaches the bottom (upper-body clip): head at the idle
   *          head height, frame bottom on the overlay bottom.
   * 'full' - first-frame feet on the idle feet at the idle height; a motion whose
   *          frames touch the bottom edge is lowered onto the overlay bottom so the cut is hidden.
   */
  function placeMotion(canvas, box, fit) {
    if (!fit || typeof fit !== 'object' || !validCanvas(canvas) || !validBox(box)) return null;
    const W = fit.width;
    const H = fit.height;
    const b = fit.first;
    if (!finite(W, H) || W <= 0 || H <= 0 || !validBox(b)) return null;
    const ih = box[3] - box[1];
    const cx = (box[0] + box[2]) / 2;
    let s;
    let top;
    let mode;
    if (b[3] >= CUT_BOTTOM) {
      mode = 'cut';
      s = (canvas.height - box[1]) / ((1 - b[1]) * H);
      top = canvas.height - H * s;
    } else {
      mode = 'full';
      s = ih / ((b[3] - b[1]) * H);
      top = box[3] - b[3] * H * s;
      if (fit.touches && fit.touches.bottom && top + H * s < canvas.height) top = canvas.height - H * s;
    }
    const width = W * s;
    const height = H * s;
    const left = cx - ((b[0] + b[2]) / 2) * width;
    if (!finite(s, top, left, width, height) || s <= 0) return null;
    return { left, top, width, height, mode };
  }

  return { DEMO_BOX, DEMO_VIEWBOX, CUT_BOTTOM, demoRect, idleBox, placeMotion };
})();

// What a 'play' message shows: pure helpers, exported for node tests like OverlayFit.
const OverlayPlayback = (() => {
  /**
   * The id of the photo on air in a library view, or null. The same rule as
   * motions.js onAirPhotoId (the overlay loads no other script; a test keeps
   * the two equal).
   */
  function onAirPhotoId(library) {
    const photo = library && typeof library === 'object' ? library.photo : null;
    return photo && typeof photo === 'object' && typeof photo.id === 'string' && photo.id ? photo.id : null;
  }

  /**
   * The reaction to a trigger for `id`: { kind: 'motion', motion } for a motion
   * of the view that has a url. Anything else ('demo', an unknown or url-less
   * motion) is { kind: 'demo' } with nothing on air (the demo avatar reacts, as
   * before), but { kind: 'idle' } while a photo is on air: the demo avatar never
   * replaces the photo, the overlay stays on (or returns to) the photo idle.
   */
  function reactionFor(library, id) {
    const motions = library && Array.isArray(library.motions) ? library.motions : [];
    if (id !== 'demo') {
      const motion = motions.find(m => m && (m.id === id || String(m.id) === String(id)));
      if (motion && motion.url) return { kind: 'motion', motion };
    }
    return onAirPhotoId(library) ? { kind: 'idle' } : { kind: 'demo' };
  }

  return { onAirPhotoId, reactionFor };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ...OverlayFit, ...OverlayPlayback };

if (typeof document !== 'undefined') (() => {
  // DOM Elements
  const demoLayer = document.getElementById('demo-layer');
  const demoAvatar = document.getElementById('demo-avatar');
  const idleLayer = document.getElementById('idle-layer');
  const idleVideo = document.getElementById('idle-video');
  const idleImage = document.getElementById('idle-image');
  const reactionLayer = document.getElementById('reaction-layer');
  const reactionVideo = document.getElementById('reaction-video');
  const reactionImage = document.getElementById('reaction-image');

  // Application State (photo: the view's on-air photo, or null in demo mode)
  let library = {
    idle: null,
    motions: [],
    photo: null
  };

  // Trigger & playback tracking
  let activeTriggerToken = 0;
  let activeReactionTimer = null;
  let activeVideoCleanup = null;
  let isReacting = false;

  // Constants
  const DEMO_REACTION_DURATION_MS = 1600;
  const IMAGE_REACTION_DURATION_MS = 3200;
  const VIDEO_LOAD_TIMEOUT_MS = 4000;

  function reportPreviewState(state, id = null) {
    if (window.parent !== window) {
      window.parent.postMessage({ source: 'virtually-overlay', state, id }, window.location.origin);
    }
  }

  // Media helper: detect whether media item is video
  function isVideoMedia(media) {
    if (!media) return false;
    if (media.kind === 'video') return true;
    if (typeof media.mime === 'string' && media.mime.startsWith('video/')) return true;
    if (typeof media.url === 'string') {
      const clean = media.url.split('?')[0].toLowerCase();
      if (clean.endsWith('.webm') || clean.endsWith('.mp4')) return true;
    }
    return false;
  }

  // Layer visibility controllers
  function showOnlyLayer(layerName) {
    demoLayer.classList.toggle('active', layerName === 'demo');
    idleLayer.classList.toggle('active', layerName === 'idle');
    reactionLayer.classList.toggle('active', layerName === 'reaction');
  }

  function pauseIdleVideoIfPlaying() {
    try {
      if (idleVideo && !idleVideo.paused) {
        idleVideo.pause();
      }
    } catch (_) {}
  }

  function clearVideoHandlers() {
    if (activeVideoCleanup) activeVideoCleanup();
  }

  // Restore idle state
  function returnToIdle() {
    isReacting = false;
    if (activeReactionTimer) {
      clearTimeout(activeReactionTimer);
      activeReactionTimer = null;
    }

    clearVideoHandlers();

    if (library.idle && library.idle.url) {
      showOnlyLayer('idle');
      applyIdleMedia(library.idle);
    } else {
      showOnlyLayer('demo');
      stopIdleMedia();
    }
    cleanupReactionMedia();
    reportPreviewState('idle');
  }

  // Apply Idle Media
  let currentIdleUrl = null;
  function applyIdleMedia(idleMedia) {
    if (!idleMedia || !idleMedia.url) {
      stopIdleMedia();
      showOnlyLayer('demo');
      return;
    }

    const isVid = isVideoMedia(idleMedia);
    if (isVid) {
      idleImage.classList.remove('visible');
      idleImage.removeAttribute('src');

      if (currentIdleUrl !== idleMedia.url) {
        currentIdleUrl = idleMedia.url;
        idleVideo.src = idleMedia.url;
        idleVideo.loop = true;
        idleVideo.muted = true;
        idleVideo.playsInline = true;
      }
      idleVideo.classList.add('visible');
      const playPromise = idleVideo.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('Idle video play blocked or failed:', err);
        });
      }
    } else {
      // Image idle (PNG, WebP, etc.)
      stopVideo(idleVideo);
      if (currentIdleUrl !== idleMedia.url) {
        currentIdleUrl = idleMedia.url;
        idleImage.src = idleMedia.url;
      }
      idleImage.classList.add('visible');
    }
  }

  function stopVideo(videoEl) {
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (_) {}
    videoEl.classList.remove('visible');
  }

  function stopIdleMedia() {
    currentIdleUrl = null;
    stopVideo(idleVideo);
    idleImage.classList.remove('visible');
    idleImage.removeAttribute('src');
  }

  // Motion size fit: inline placement of #reaction-video from the motion's `fit`,
  // recomputed on resize (an OBS source size change resizes the viewport).
  const FIT_STYLE_PROPS = ['position', 'left', 'top', 'width', 'height', 'max-width', 'max-height', 'margin'];
  let activeFit = null; // fit of the playing video motion, or null

  function currentIdleBox(canvas) {
    const idle = library.idle && library.idle.url ? library.idle : null;
    if (idle) {
      const natural = isVideoMedia(idle)
        ? { width: idleVideo.videoWidth, height: idleVideo.videoHeight }
        : { width: idleImage.naturalWidth, height: idleImage.naturalHeight };
      return OverlayFit.idleBox(canvas, idle, { natural: natural.width > 0 && natural.height > 0 ? natural : null });
    }
    // The demo layer keeps its layout while hidden (visibility/opacity only).
    const r = demoAvatar.getBoundingClientRect();
    const avatarRect = r.width > 0 && r.height > 0
      ? { left: r.left, top: r.top, width: r.width, height: r.height }
      : null;
    return OverlayFit.idleBox(canvas, null, { avatarRect });
  }

  function clearMotionFit() {
    for (const prop of FIT_STYLE_PROPS) reactionVideo.style.removeProperty(prop);
    delete reactionVideo.dataset.fit;
  }

  function applyMotionFit() {
    if (!activeFit) {
      clearMotionFit();
      return;
    }
    const canvas = { width: window.innerWidth, height: window.innerHeight };
    const place = OverlayFit.placeMotion(canvas, currentIdleBox(canvas), activeFit);
    if (!place) {
      clearMotionFit();
      return;
    }
    const style = reactionVideo.style;
    style.setProperty('position', 'absolute');
    style.setProperty('left', `${place.left}px`);
    style.setProperty('top', `${place.top}px`);
    style.setProperty('width', `${place.width}px`);
    style.setProperty('height', `${place.height}px`);
    style.setProperty('max-width', 'none');
    style.setProperty('max-height', 'none');
    style.setProperty('margin', '0');
    reactionVideo.dataset.fit = place.mode;
  }

  window.addEventListener('resize', () => {
    if (activeFit) applyMotionFit();
  });

  function cleanupReactionMedia() {
    activeFit = null;
    clearMotionFit();
    stopVideo(reactionVideo);
    reactionImage.classList.remove('visible');
    reactionImage.onerror = null;
    reactionImage.removeAttribute('src');
    demoAvatar.classList.remove('reacting');
  }

  // Tell the server that the motion of the 'play' message `seq` ended: the AI
  // director's queue (lib/director) then starts the next one.
  function reportMotionDone(seq) {
    if (!Number.isInteger(seq)) return;
    fetch('/api/director/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq })
    }).catch(() => {});
  }

  // Trigger Demo Reaction
  function playDemoReaction(token) {
    isReacting = true;
    pauseIdleVideoIfPlaying();
    showOnlyLayer('demo');
    reportPreviewState('playing', 'demo');

    // Deterministic restart: toggle reacting class with reflow
    demoAvatar.classList.remove('reacting');
    void demoAvatar.offsetWidth; // Force CSS reflow to restart keyframe animation
    demoAvatar.classList.add('reacting');

    activeReactionTimer = setTimeout(() => {
      if (activeTriggerToken === token) {
        demoAvatar.classList.remove('reacting');
        returnToIdle();
      }
    }, DEMO_REACTION_DURATION_MS);
  }

  // Play motion media (or demo fallback)
  function playMotion(id, seq) {
    const token = ++activeTriggerToken;

    // Clear previous timer
    if (activeReactionTimer) {
      clearTimeout(activeReactionTimer);
      activeReactionTimer = null;
    }
    clearVideoHandlers();
    cleanupReactionMedia();

    const reaction = OverlayPlayback.reactionFor(library, id);
    // 'demo', or a motion the overlay does not have, with nothing on air:
    // the demo avatar reacts, so the trigger still gives feedback.
    if (reaction.kind === 'demo') {
      playDemoReaction(token);
      return;
    }
    // The same with a photo on air: the photo idle stays (or comes back), and
    // the preview hears 'idle' so the controller clears its playing mark.
    if (reaction.kind === 'idle') {
      returnToIdle();
      return;
    }

    // Real user motion media playback
    const motion = reaction.motion;
    isReacting = true;

    if (isVideoMedia(motion)) {
      // Video motion reaction
      reactionImage.classList.remove('visible');
      // Size fit before the first frame shows; motions without a fit keep the CSS placement.
      activeFit = motion.fit && typeof motion.fit === 'object' ? motion.fit : null;
      applyMotionFit();
      reactionVideo.classList.add('visible');
      showOnlyLayer('reaction');

      let hasStarted = false;
      let loadTimeoutId = null;

      const detach = () => {
        if (loadTimeoutId) clearTimeout(loadTimeoutId);
        reactionVideo.removeEventListener('ended', onEnded);
        reactionVideo.removeEventListener('error', onError);
        reactionVideo.removeEventListener('playing', onPlaying);
        if (activeVideoCleanup === detach) activeVideoCleanup = null;
      };

      const finish = () => {
        detach();
        if (activeTriggerToken === token) returnToIdle();
      };

      // Only a motion that played to its end is reported: a page that could not play it
      // (a hidden controller tab) must not cut short what the overlay in OBS still plays.
      const onEnded = () => {
        if (activeTriggerToken === token) reportMotionDone(seq);
        finish();
      };

      const onError = (e) => {
        console.warn('Reaction video error:', e);
        finish();
      };

      const onPlaying = () => {
        if (activeTriggerToken !== token) return;
        hasStarted = true;
        applyMotionFit();
        pauseIdleVideoIfPlaying();
        reportPreviewState('playing', id);
      };

      // Watch for late loading / stalled load
      loadTimeoutId = setTimeout(() => {
        if (!hasStarted && activeTriggerToken === token) {
          console.warn('Reaction video load timeout, reverting to idle');
          finish();
        }
      }, VIDEO_LOAD_TIMEOUT_MS);

      activeVideoCleanup = detach;
      reactionVideo.addEventListener('ended', onEnded, { once: true });
      reactionVideo.addEventListener('error', onError, { once: true });
      reactionVideo.addEventListener('playing', onPlaying, { once: true });

      reactionVideo.src = motion.url;
      reactionVideo.currentTime = 0;
      reactionVideo.loop = false;
      reactionVideo.playsInline = true;
      reactionVideo.muted = true;

      const playPromise = reactionVideo.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (activeTriggerToken !== token) return;
          console.warn('Reaction play failed:', err);
          finish();
        });
      }
    } else {
      // Static / animated image motion reaction
      pauseIdleVideoIfPlaying();
      reactionVideo.classList.remove('visible');
      reactionImage.classList.add('visible');
      reactionImage.src = motion.url;
      showOnlyLayer('reaction');
      reportPreviewState('playing', id);

      reactionImage.onerror = () => {
        if (activeTriggerToken === token) {
          returnToIdle();
        }
      };

      activeReactionTimer = setTimeout(() => {
        if (activeTriggerToken === token) {
          reportMotionDone(seq);
          returnToIdle();
        }
      }, IMAGE_REACTION_DURATION_MS);
    }
  }

  // Update library data. The first snapshot always picks the layer (overlay.html
  // starts with none shown); later ones only when the idle media changed.
  let libraryKnown = false;
  function updateLibrary(newLibrary) {
    if (!newLibrary) return;
    const prevIdleUrl = library.idle ? library.idle.url : null;
    library = {
      idle: newLibrary.idle || null,
      motions: Array.isArray(newLibrary.motions) ? newLibrary.motions : [],
      photo: newLibrary.photo && typeof newLibrary.photo === 'object' ? newLibrary.photo : null
    };

    const newIdleUrl = library.idle ? library.idle.url : null;
    const first = !libraryKnown;
    libraryKnown = true;

    // If not currently reacting, update idle display if idle media changed
    if (!isReacting) {
      if (first || newIdleUrl !== prevIdleUrl) {
        if (library.idle) {
          showOnlyLayer('idle');
          applyIdleMedia(library.idle);
        } else {
          showOnlyLayer('demo');
          stopIdleMedia();
        }
      }
    }
  }

  // Fetch library from API
  async function fetchLibrary() {
    try {
      const res = await fetch('/api/library', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      const data = await res.json();
      updateLibrary(data);
    } catch (err) {
      // If server is not ready or returns 404/500, fallback to demo avatar
      console.warn('Could not fetch /api/library:', err);
      if (!library.idle && !isReacting) {
        showOnlyLayer('demo');
      }
    }
  }

  // Handle SSE message
  function handleSSEMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'library') {
      updateLibrary(data.library);
    } else if (data.type === 'play') {
      playMotion(data.id, data.seq);
    } else if (data.type === 'idle') {
      // Stop button: invalidate any in-flight playback, then show the idle state.
      ++activeTriggerToken;
      returnToIdle();
    }
  }

  // Report this page's viewport as the OBS browser-source size, so the controller can
  // preview the real canvas. Only inside OBS (window.obsstudio): the controller's own
  // preview iframe and a normal browser tab must never overwrite it.
  const IS_OBS_SOURCE = typeof window.obsstudio === 'object' && window.obsstudio !== null;
  const OBS_REPORT_DEBOUNCE_MS = 300;
  let obsReportTimer = null;

  function reportObsSourceSize() {
    if (!IS_OBS_SOURCE) return;
    fetch('/api/obs-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: window.innerWidth, height: window.innerHeight })
    }).catch((err) => {
      console.warn('Could not report the OBS source size:', err);
    });
  }

  if (IS_OBS_SOURCE) {
    window.addEventListener('resize', () => {
      clearTimeout(obsReportTimer);
      obsReportTimer = setTimeout(reportObsSourceSize, OBS_REPORT_DEBOUNCE_MS);
    });
  }

  // Connect SSE
  let eventSource = null;
  function connectSSE() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
      // Reconnected / connected: refresh library immediately
      fetchLibrary();
      // A restarted server may have lost or never seen the size: report it again.
      reportObsSourceSize();
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleSSEMessage(data);
      } catch (err) {
        console.warn('Failed to parse SSE event data:', err);
      }
    };

    eventSource.onerror = (err) => {
      // EventSource auto-reconnects in browser. onopen will trigger fetchLibrary.
      console.warn('SSE connection error, will retry...', err);
    };
  }

  // Initialize
  fetchLibrary();
  connectSSE();
})();
