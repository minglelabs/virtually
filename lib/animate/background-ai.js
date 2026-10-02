'use strict';

// Paid background removal by an AI model, for what the free local methods cannot do:
// a photo whose background is not one colour, and a result video whose background did
// not come out as the key colour. Only ever called when the user picked it.
//
// WaveSpeed (the animate key, WAVESPEED_API_KEY):
//   image  wavespeed-ai/image-background-remover   $0.004 per image -> transparent PNG
//   video  bria/fibo/video-background-remover      $0.05 per second -> WebM with its own alpha
// (as billed on the WaveSpeed account, 2026-10-02: 2.97 s of video cost $0.15).
// The video answer is used as it comes: soft hair edges, no keying here.

const fsp = require('node:fs/promises');
const path = require('node:path');

const { measureFit } = require('./fit');

// Whole seconds, rounded up.
const PRICES = Object.freeze({ imageUsd: 0.004, videoUsdPerSecond: 0.05, videoMinSeconds: 1 });

// What removing the background of `seconds` of video costs.
function videoUsd(seconds) {
  const billed = Math.max(PRICES.videoMinSeconds, Math.ceil((Number(seconds) || 0) - 1e-9));
  return Number((billed * PRICES.videoUsdPerSecond).toFixed(4));
}

const CONTENT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

function createBackgroundAi({ providers, configStore, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' }) {
  const adapter = providers.wavespeed;
  const available = () => Boolean(adapter && typeof adapter.removeBackground === 'function' && configStore.resolvedCredentials('wavespeed').apiKey);

  async function run(kind, srcPath, destPath, signal) {
    if (!available()) throw Object.assign(new Error('AI background removal is not configured.'), { code: 'background_ai_unavailable' });
    const ext = path.extname(srcPath).toLowerCase();
    const stat = await fsp.stat(srcPath);
    const ctx = {
      credentials: configStore.resolvedCredentials('wavespeed'),
      fetch: (...args) => fetch(...args),
      baseUrl: configStore.baseUrl('wavespeed'),
      allowInsecure: configStore.allowInsecure('wavespeed'),
      signal,
    };
    await adapter.removeBackground(ctx, { path: srcPath, filename: `source${ext}`, size: stat.size, contentType: CONTENT_TYPES[ext] || 'application/octet-stream' }, destPath, kind);
  }

  return {
    available,
    // -> a transparent PNG at destPath.
    image: (srcPath, destPath, { signal } = {}) => run('image', srcPath, destPath, signal),
    // -> a transparent WebM at destPath (the remover's own alpha). An answer without a
    // transparent pixel is a failure: the caller gives the credits back.
    async video(srcPath, destPath, { signal } = {}) {
      await run('video', srcPath, destPath, signal);
      const fit = await measureFit(ffmpegPath, ffprobePath, destPath).catch(() => null);
      if (!fit) {
        await fsp.rm(destPath, { force: true }).catch(() => {});
        throw new Error('The AI answer has no transparent background.');
      }
    },
    videoUsd,
    view: () => ({ available: available(), ...PRICES }),
  };
}

module.exports = { createBackgroundAi, videoUsd, PRICES };
