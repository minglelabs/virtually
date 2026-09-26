'use strict';

// Generate a small green-screen test clip: a pure #00FF00 background with a
// moving non-green "character" (skin-colored head + colored body, softened
// edges). Used by the chroma-key tests and available via `pnpm sample:greenscreen`.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fsp = require('node:fs/promises');

/**
 * Write a green-screen sample clip to `outputPath` (H.264 yuv420p .mp4).
 * @param {string} outputPath
 * @param {{width?:number, height?:number, duration?:number, fps?:number, ffmpegPath?:string}} [options]
 * @returns {Promise<string>} the output path
 */
function makeGreenscreenSample(outputPath, options = {}) {
  const width = Number(options.width) || 1280;
  const height = Number(options.height) || 720;
  const duration = Number(options.duration) || 4;
  const fps = Number(options.fps) || 30;
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';

  // Pure green background. The head and body oscillate horizontally so the
  // chroma output has motion to verify. Coordinates are expressed with the
  // frame timestamp `t` so drawing stays resolution-independent.
  const headRadius = Math.round(Math.min(width, height) * 0.12);
  const bodyWidth = Math.round(width * 0.18);
  const bodyHeight = Math.round(height * 0.32);
  // Horizontal centre sweeps around the middle third of the frame.
  const centerExpr = `(${width}/2 + ${Math.round(width * 0.18)}*sin(2*PI*t/${duration}))`;
  const headCy = Math.round(height * 0.34);
  const bodyTop = Math.round(height * 0.48);

  // The "character" is a skin-colored head over a colored body. A round head
  // via geq needs cross-plane reads that geq forbids in its default YUV mode,
  // so we draw it as its own opaque green-free layer instead: build a small
  // head/body picture on a fully green canvas, then let chromakey remove the
  // green everywhere. Two filled drawbox layers (head + body) with a light
  // gblur give soft, non-green edges for the key to handle. The head sits just
  // above the body so together they read as a simple figure.
  const bgColor = '0x00FF00';
  const skin = { r: 240, g: 200, b: 170 };
  const shirt = { r: 60, g: 90, b: 200 };
  const headW = headRadius * 2;
  const headX = `${centerExpr}-${headRadius}`;
  const headY = Math.round(headCy - headRadius);
  const bodyX = `${centerExpr}-${Math.round(bodyWidth / 2)}`;

  // Build a filtergraph:
  //   green background -> filled body box -> filled head box -> soft blur.
  const filter = [
    `color=c=${bgColor}:s=${width}x${height}:r=${fps}:d=${duration}[bg]`,
    `[bg]drawbox=x='${bodyX}':y=${bodyTop}:w=${bodyWidth}:h=${bodyHeight}:` +
      `color=0x${toHex(shirt)}:t=fill[body]`,
    `[body]drawbox=x='${headX}':y=${headY}:w=${headW}:h=${headW}:` +
      `color=0x${toHex(skin)}:t=fill[char]`,
    // Soften edges a touch so the key has semi-transparent borders to handle.
    `[char]gblur=sigma=0.8,format=yuv420p[out]`,
  ].join(';');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps),
    outputPath,
  ];

  return fsp.mkdir(path.dirname(outputPath), { recursive: true }).then(() => new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(outputPath);
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  }));
}

function toHex(color) {
  const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
  return [clamp(color.r), clamp(color.g), clamp(color.b)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

module.exports = { makeGreenscreenSample };

if (require.main === module) {
  const outputPath = path.join(__dirname, '..', 'data', 'samples', 'greenscreen-sample.mp4');
  makeGreenscreenSample(outputPath, { width: 1280, height: 720, duration: 4, fps: 30 })
    .then(() => console.log(`Wrote green-screen sample: ${outputPath}`))
    .catch(error => { console.error(error.message || error); process.exitCode = 1; });
}
