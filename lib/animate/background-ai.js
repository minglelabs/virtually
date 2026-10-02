'use strict';

// Paid background removal by an AI model, for what the free local methods cannot do:
// a photo whose background is not one colour, and a result video whose background did
// not come out as the key colour. Only ever called when the user picked it.
//
// WaveSpeed (the animate key, WAVESPEED_API_KEY):
//   image  wavespeed-ai/image-background-remover   $0.01 per image -> transparent PNG
//   video  wavespeed-ai/video-background-remover   $0.01 per second, 3 s minimum
// The video answer's format is not documented, so it goes through the finished-motion
// converter (motion-upload.js): its own alpha is kept, a plain key colour is keyed, and
// an answer that is still opaque is refused.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PRICES = Object.freeze({ imageUsd: 0.01, videoUsdPerSecond: 0.01, videoMinSeconds: 3 });

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
    // -> a transparent WebM at destPath.
    async video(srcPath, destPath, { signal } = {}) {
      const workDir = `${destPath}.${crypto.randomUUID()}.tmp`;
      await fsp.mkdir(workDir);
      try {
        const raw = path.join(workDir, 'answer');
        await run('video', srcPath, raw, signal);
        // Required here: motion-upload.js needs lib/characters.js, which needs the pipeline.
        const { processMotionUpload } = require('./motion-upload');
        const converted = await processMotionUpload({ ffmpegPath, ffprobePath, sourcePath: raw, workDir });
        if (converted.mime !== 'video/webm' || !(converted.alpha || converted.keyed)) throw new Error('The AI answer has no transparent background.');
        await fsp.rename(converted.path, destPath);
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    videoUsd,
    view: () => ({ available: available(), ...PRICES }),
  };
}

module.exports = { createBackgroundAi, videoUsd, PRICES };
