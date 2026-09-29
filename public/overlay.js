(() => {
  'use strict';

  // DOM Elements
  const demoLayer = document.getElementById('demo-layer');
  const demoAvatar = document.getElementById('demo-avatar');
  const idleLayer = document.getElementById('idle-layer');
  const idleVideo = document.getElementById('idle-video');
  const idleImage = document.getElementById('idle-image');
  const reactionLayer = document.getElementById('reaction-layer');
  const reactionVideo = document.getElementById('reaction-video');
  const reactionImage = document.getElementById('reaction-image');

  // Application State
  let library = {
    idle: null,
    motions: []
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

  function cleanupReactionMedia() {
    stopVideo(reactionVideo);
    reactionImage.classList.remove('visible');
    reactionImage.onerror = null;
    reactionImage.removeAttribute('src');
    demoAvatar.classList.remove('reacting');
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

    // Special trigger id 'demo'
    if (id === 'demo') {
      playDemoReaction(token);
      return;
    }

    // Look for matching motion in user library
    const motion = library.motions.find((m) => m && (m.id === id || String(m.id) === String(id)));
    if (!motion || !motion.url) {
      // If motion not found in user media, trigger demo reaction to give feedback
      playDemoReaction(token);
      return;
    }

    // Real user motion media playback
    isReacting = true;

    if (isVideoMedia(motion)) {
      // Video motion reaction
      reactionImage.classList.remove('visible');
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

      const onEnded = () => {
        finish();
      };

      const onError = (e) => {
        console.warn('Reaction video error:', e);
        finish();
      };

      const onPlaying = () => {
        if (activeTriggerToken !== token) return;
        hasStarted = true;
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
          returnToIdle();
        }
      }, IMAGE_REACTION_DURATION_MS);
    }
  }

  // Update library data
  function updateLibrary(newLibrary) {
    if (!newLibrary) return;
    const prevIdleUrl = library.idle ? library.idle.url : null;
    library = {
      idle: newLibrary.idle || null,
      motions: Array.isArray(newLibrary.motions) ? newLibrary.motions : []
    };

    const newIdleUrl = library.idle ? library.idle.url : null;

    // If not currently reacting, update idle display if idle media changed
    if (!isReacting) {
      if (newIdleUrl !== prevIdleUrl) {
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
