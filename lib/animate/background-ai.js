'use strict';

// Paid background removal by an AI model, for what the free local methods cannot do:
// a photo whose background is not one colour, and a result video whose background did
// not come out as the key colour. Only ever called when the user picked it.
//
// WaveSpeed (the animate key, WAVESPEED_API_KEY):
//   image  wavespeed-ai/image-background-remover   $0.004 per image -> transparent PNG
//   video  wavespeed-ai/video-background-remover   $0.01 per second, 3 s minimum
// (both as billed on the WaveSpeed account, 2026-10-02; the docs say $0.01 per image).
// The video remover has no transparent output: it answers with an opaque MP4, the subject
// on plain white or on a background image we give it. So we give it a plain key-colour
// image (the job's key colour, else the one that clashes least with the clip) and key that
// colour out locally (key.js), like a job result. Should an answer not be that colour, the
// finished-motion converter and then the plain-background cut are tried before giving up.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const media = require('./media');
const key = require('./key');
const { repairFlicker } = require('./alpha-repair');
const keyColors = require('./key-color');
const plainCut = require('./plain-cut');

const PRICES = Object.freeze({ imageUsd: 0.004, videoUsdPerSecond: 0.01, videoMinSeconds: 3 });

// What removing the background of `seconds` of video costs.
function videoUsd(seconds) {
  const billed = Math.max(PRICES.videoMinSeconds, Math.ceil((Number(seconds) || 0) - 1e-9));
  return Number((billed * PRICES.videoUsdPerSecond).toFixed(4));
}

const CONTENT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

function createBackgroundAi({ providers, configStore, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' }) {
  const adapter = providers.wavespeed;
  const available = () => Boolean(adapter && typeof adapter.removeBackground === 'function' && configStore.resolvedCredentials('wavespeed').apiKey);

  async function run(kind, srcPath, destPath, signal, backgroundPath = null) {
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
    const backgroundFile = backgroundPath
      ? { path: backgroundPath, filename: 'background.png', size: (await fsp.stat(backgroundPath)).size, contentType: 'image/png' } : null;
    await adapter.removeBackground(ctx, { path: srcPath, filename: `source${ext}`, size: stat.size, contentType: CONTENT_TYPES[ext] || 'application/octet-stream' }, destPath, kind, { backgroundFile });
  }

  return {
    available,
    // -> a transparent PNG at destPath.
    image: (srcPath, destPath, { signal } = {}) => run('image', srcPath, destPath, signal),
    // -> a transparent WebM at destPath. keyColor: the job's ({ name }), when there is one.
    async video(srcPath, destPath, { signal, keyColor = null } = {}) {
      const workDir = `${destPath}.${crypto.randomUUID()}.tmp`;
      await fsp.mkdir(workDir);
      try {
        const probe = await media.probeVideo(ffprobePath, srcPath).catch(() => null);
        if (!probe || !probe.width || !probe.height) throw new Error('Could not read the video.');
        // The colour put behind the subject: one the subject itself has little of.
        const wanted = keyColors.resolveKeyColor(keyColor || await keyColors.chooseKeyColor(ffmpegPath, srcPath).catch(() => null));
        const background = path.join(workDir, 'background.png');
        const made = await media.run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
          '-i', `color=c=${keyColors.ffmpegHex(wanted)}:s=${probe.width}x${probe.height}`, '-frames:v', '1', background], { timeoutMs: 30000 });
        if (made.code !== 0) throw new Error('Could not make the key-colour background.');
        const raw = path.join(workDir, 'answer.mp4');
        await run('video', srcPath, raw, signal, background);
        const keyed = path.join(workDir, 'keyed.webm');
        const outcome = await key.autoKey(ffmpegPath, ffprobePath, raw, keyed, { signal, expected: wanted });
        if (outcome.keyed) {
          // Thin parts the model dropped for a frame or two come back (alpha-repair.js); a
          // repair that fails or finds nothing leaves the keyed answer as it is.
          const repaired = path.join(workDir, 'repaired.webm');
          const fixed = await repairFlicker(ffmpegPath, ffprobePath, keyed, srcPath, repaired, { signal, keyHex: keyColor ? wanted.hex : null })
            .catch((error) => { if (error.name === 'AbortError') throw error; return null; });
          await fsp.rename(fixed && fixed.repaired ? repaired : keyed, destPath);
          return;
        }
        // Not that colour after all: its own alpha, another key colour, or a plain background.
        // Required here: motion-upload.js needs lib/characters.js, which needs the pipeline.
        const { processMotionUpload } = require('./motion-upload');
        const copy = path.join(workDir, 'answer-copy.mp4');
        await fsp.copyFile(raw, copy);
        const converted = await processMotionUpload({ ffmpegPath, ffprobePath, sourcePath: copy, workDir }).catch(() => null);
        if (converted && converted.mime === 'video/webm' && (converted.alpha || converted.keyed)) {
          await fsp.rename(converted.path, destPath);
          return;
        }
        const plain = await plainCut.plainCutVideo(ffmpegPath, ffprobePath, raw, keyed, { signal }).catch(() => null);
        if (!plain || !plain.cut) throw new Error(`The AI answer's background could not be keyed (${outcome.reason || 'unknown'}).`);
        await fsp.rename(keyed, destPath);
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    videoUsd,
    view: () => ({ available: available(), ...PRICES }),
  };
}

module.exports = { createBackgroundAi, videoUsd, PRICES };
