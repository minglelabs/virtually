'use strict';

// Paid background removal by an AI model, for what the free local methods cannot do:
// a photo whose background is not one colour, and a result video whose background did
// not come out as the key colour. Only ever called when the user picked it.
//
// WaveSpeed (the animate key, WAVESPEED_API_KEY):
//   image  wavespeed-ai/image-background-remover   $0.004 per image -> transparent PNG
//   video  bria/fibo/video-background-remover      $0.05 per second -> WebM with its own alpha
// (as billed on the WaveSpeed account, 2026-10-02: 2.97 s of video cost $0.15).
// The video answer keeps its own alpha (soft hair edges, no keying here). When the clip's
// background is a key colour (a job result on green or blue), the matte's rim still carries
// that colour as a thin coloured line: the rim is then cleaned locally (edgeCleanFilter).

const fsp = require('node:fs/promises');
const path = require('node:path');

const media = require('./media');
const key = require('./key');
const keyColors = require('./key-color');
const { measureFit } = require('./fit');

// despill's channel options, as in key.js: type=blue alone would lower green.
const DESPILL_CHANNELS = { green: '', blue: ':green=0:blue=-1' };
const RIM_PX = 6; // how far in from the matte's edge the colour is corrected

// The rim of a matte cut from a key-colour background: the spill colour is taken out of a
// band RIM_PX wide along the alpha edge (the inside of the character is left as it is, so
// its own greens or blues stay), and the alpha is pulled in by one pixel, which drops the
// outermost ring where the matte kept the background itself.
function edgeCleanFilter(despill) {
  const erode = Array(RIM_PX).fill('erosion').join(',');
  return [
    'format=rgba,split=3[o][d][m]',
    `[d]despill=type=${despill}:mix=1:expand=0.6${DESPILL_CHANNELS[despill] || ''},format=gbrap[ds]`,
    '[m]alphaextract,split=3[a1][a2][a3]',
    `[a2]${erode}[er]`,
    "[a1][er]blend=all_expr='A-B',lut=y='if(gt(val,0),255,0)',dilation,format=gbrap[band]",
    '[a3]erosion[al]',
    '[o]format=gbrap[ob]',
    '[ob][ds][band]maskedmerge=planes=7[mm]',
    '[mm][al]alphamerge,format=yuva420p',
  ].join(';');
}

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
    // keyColor: the job's ({ name }), when there is one; else green and blue are looked for.
    async video(srcPath, destPath, { signal, keyColor = null } = {}) {
      await run('video', srcPath, destPath, signal);
      const fit = await measureFit(ffmpegPath, ffprobePath, destPath).catch(() => null);
      if (!fit) {
        await fsp.rm(destPath, { force: true }).catch(() => {});
        throw new Error('The AI answer has no transparent background.');
      }
      // A clip on a key colour: clean the rim. Any problem leaves the answer as it came.
      try {
        const probe = await media.probeVideo(ffprobePath, srcPath).catch(() => null);
        const wanted = keyColor ? [keyColors.resolveKeyColor(keyColor)] : [keyColors.resolveKeyColor({ name: 'green' }), keyColors.resolveKeyColor({ name: 'blue' })];
        for (const candidate of wanted) {
          if (!candidate || !candidate.despill) continue;
          const detected = await key.detectKeyColor(ffmpegPath, ffprobePath, srcPath, { probe, expected: candidate });
          if (!detected.color) continue;
          await key.encodeAlphaWebm(ffmpegPath, destPath, destPath, {
            filter: edgeCleanFilter(candidate.despill), inputArgs: ['-c:v', 'libvpx-vp9'],
            duration: probe && probe.duration, signal, what: 'Edge clean-up',
          });
          break;
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.warn(`[animate] edge clean-up skipped: ${error.message}`);
      }
    },
    videoUsd,
    view: () => ({ available: available(), ...PRICES }),
  };
}

module.exports = { createBackgroundAi, videoUsd, PRICES, edgeCleanFilter };
