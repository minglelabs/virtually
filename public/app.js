'use strict';

// Minimal controller: OBS Browser Source URL + large live overlay preview.
(() => {
  const urlInput = document.getElementById('overlayUrlInput');
  const copyBtn = document.getElementById('copyUrlBtn');
  const refreshBtn = document.getElementById('refreshOverlayBtn');
  const frame = document.getElementById('overlayPreviewFrame');

  urlInput.value = new URL('/overlay', window.location.origin).href;

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
})();
