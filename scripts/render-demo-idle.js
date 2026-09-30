#!/usr/bin/env node
'use strict';

// Render the overlay's demo avatar idle loop into the bundled example driving
// video: assets/drivings/demo-idle.mp4 and its poster assets/drivings/demo-idle.jpg
// (both overwritten).
//
//   node scripts/render-demo-idle.js
//
// The #demo-avatar markup of public/overlay.html and public/overlay.css are read
// at run time, so the video always matches the overlay. overlay.js is not run:
// the avatar stays idle (no .reacting class, the sparkles stay hidden).
//
// Headless Chrome is driven over the DevTools protocol on a pipe
// (--remote-debugging-pipe, fds 3 and 4), so nothing has to be installed.
// Frames are deterministic: every animation is paused and set to the frame's
// time, then the page is captured after two animation frames.
//
// Seamless loop: the clip is LOOP_MS (3.8 s, the blink period) long. An
// animation of period P runs n = max(1, round(LOOP / P)) whole cycles per loop,
// i.e. at playback rate P * n / LOOP (breathe 3.6 -> 3.8 s, ears 4.6 -> 3.8 s,
// tail 3.0 -> 3.8 s, blink 3.8 s, gem 2.2 -> 1.9 s), so t = LOOP shows exactly
// the frame at t = 0. The script also captures t = LOOP and fails unless it is
// pixel-identical to frame 0 (that frame is not encoded).
//
// Framing: 540x720, opaque white, the whole avatar (drop shadows and the
// breathing lift included, measured from the pixels of every frame) centred
// with an 8 % margin. Frames are captured at device scale 2 and downscaled by
// ffmpeg (lanczos).
//
// Env: CHROME_PATH (default: Google Chrome on macOS), FFMPEG_PATH, FFPROBE_PATH.

const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const media = require('../lib/animate/media');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'drivings');
const VIDEO_PATH = path.join(OUT_DIR, 'demo-idle.mp4');
const POSTER_PATH = path.join(OUT_DIR, 'demo-idle.jpg');
// Chrome's throwaway profile lives inside the checkout, never in the system temp dir.
const PROFILE_PARENT = path.join(ROOT, '.kiro', 'tmp');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIDTH = 540;
const HEIGHT = 720;
const DEVICE_SCALE = 2;
const FPS = 30;
const LOOP_MS = 3800;
const FRAMES = (LOOP_MS * FPS) / 1000; // 114 frames = 3.8 s
const MARGIN = 0.08; // aimed at on the tighter axis
const MIN_MARGIN = 0.06; // the render fails when any side ends up below this
const CDP_TIMEOUT_MS = 30 * 1000;
const ENCODE_TIMEOUT_MS = 5 * 60 * 1000;

// --- source page -------------------------------------------------------------

// The outer HTML of the <div id="..."> element, matching nested divs.
function extractElement(html, id) {
  const open = new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
  if (!open) throw new Error(`#${id} was not found in overlay.html.`);
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(open.index, match.index + match[0].length);
  }
  throw new Error(`#${id} is not closed in overlay.html.`);
}

// The render page: overlay.css, then an opaque white page and a frame (moved
// and scaled by the script) holding the avatar box at its CSS size.
function renderPage(css, avatarMarkup) {
  if (/<\/style/i.test(css)) throw new Error('overlay.css cannot be inlined.');
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    `<style>${css}</style>`,
    '<style>',
    'html, body { background: #ffffff !important; }',
    '#render-frame { position: fixed; left: 0; top: 0; transform-origin: 0 0; }',
    '#render-frame .demo-avatar { left: 0; top: 0; bottom: auto; transform: none; max-width: none; max-height: none; }',
    '</style></head>',
    `<body><div id="render-frame">${avatarMarkup}</div></body></html>`,
  ].join('\n');
}

// Runs in the page (stringified): pauses every animation and installs
// window.__render with seek / place / box. Returns the loop plan per animation.
function pageHelpers(loopMs, frames) {
  const avatar = document.getElementById('demo-avatar');
  const frame = document.getElementById('render-frame');
  if (!avatar || !frame) throw new Error('The avatar markup is missing.');
  if (document.querySelector('.reacting')) throw new Error('The avatar is not idle.');
  if ([...document.querySelectorAll('.sparkle')].some(el => getComputedStyle(el).opacity !== '0')) {
    throw new Error('Sparkles are visible.');
  }
  const tracks = document.getAnimations().map(animation => {
    const period = Number(animation.effect.getTiming().duration);
    if (!(period > 0)) throw new Error(`Animation ${animation.animationName} has no period.`);
    animation.pause();
    return { animation, name: animation.animationName || '(unnamed)', period, cycles: Math.max(1, Math.round(loopMs / period)) };
  });
  if (tracks.length === 0) throw new Error('The avatar has no animations.');
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.__render = {
    // Frame `index` of the loop: every animation at index / frames of its whole cycles.
    seek(index) {
      for (const track of tracks) track.animation.currentTime = (index * track.period * track.cycles) / frames;
      return nextFrame();
    },
    place(x, y, scale) {
      frame.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      return nextFrame();
    },
    box() {
      const rect = avatar.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    },
  };
  return tracks.map(({ name, period, cycles }) => ({ name, period, cycles, rate: (period * cycles) / loopMs }));
}

// --- Chrome over the DevTools pipe --------------------------------------------

// JSON messages separated by NUL bytes: we write to Chrome's fd 3 and read its fd 4.
class CdpPipe {
  constructor(input, output) {
    this.input = input;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.failure = null;
    let chunks = [];
    output.on('data', chunk => {
      let start = 0;
      for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
        chunks.push(chunk.subarray(start, end));
        const text = Buffer.concat(chunks).toString('utf8');
        chunks = [];
        start = end + 1;
        this._receive(JSON.parse(text));
      }
      if (start < chunk.length) chunks.push(chunk.subarray(start));
    });
    // Writing after Chrome died: reported through fail() when it exits.
    input.on('error', () => {});
  }

  _receive(message) {
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== message.method || waiter.sessionId !== message.sessionId) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }

  // The params of the next `method` event of `sessionId`.
  waitFor(method, sessionId, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`${method} did not arrive.`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  fail(error) {
    this.failure = error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }
}

async function launchChrome(chromePath, profileDir) {
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--use-mock-keychain', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
    '--mute-audio', '--force-color-profile=srgb',
    `--user-data-dir=${profileDir}`, '--remote-debugging-pipe', 'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', error => reject(new Error(`Could not start Chrome (${chromePath}): ${error.message}. Set CHROME_PATH.`)));
  });
  const cdp = new CdpPipe(child.stdio[3], child.stdio[4]);
  exited.then(code => cdp.fail(new Error(`Chrome exited (${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`)));
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        cdp.send('Browser.close', {}, undefined, 5000).catch(() => {});
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
      })();
    }
    return closing;
  };
  return { cdp, close };
}

// A page of WIDTH x HEIGHT CSS px at DEVICE_SCALE showing `html`.
async function openPage(chromePath, profileDir, html) {
  const chrome = await launchChrome(chromePath, profileDir);
  try {
    const { cdp } = chrome;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: DEVICE_SCALE, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });
    const loaded = cdp.waitFor('Page.loadEventFired', sessionId);
    const navigation = await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
    if (navigation.errorText) throw new Error(`Chrome could not open the render page: ${navigation.errorText}`);
    await loaded;
    return {
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) {
          const { exception, text } = result.exceptionDetails;
          throw new Error(`Render page script failed: ${(exception && exception.description) || text}`);
        }
        return result.result.value;
      },
      async screenshot() {
        const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        return Buffer.from(data, 'base64');
      },
      close: chrome.close,
    };
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

// --- pixels ------------------------------------------------------------------

// Decode an 8-bit, non-interlaced PNG (what Chrome writes) into raw pixels.
function decodePng(buffer) {
  if (buffer.toString('latin1', 1, 4) !== 'PNG') throw new Error('Not a PNG.');
  let header = null;
  const idat = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const channels = header ? { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType] : null;
  if (!channels || header.depth !== 8 || header.interlace !== 0) throw new Error('Unsupported PNG layout.');
  const { width, height } = header;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = data.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`Bad PNG filter ${filter}.`);
      row[x] = value & 0xff;
    }
    previous = row;
  }
  return { width, height, channels, data };
}

// The inclusive box { x0, y0, x1, y1 } of the non-white pixels, or null.
function contentBox(image) {
  const { width, height, channels, data } = image;
  const colors = channels >= 3 ? 3 : 1;
  const hasAlpha = channels === 2 || channels === 4;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0, p = y * width * channels; x < width; x += 1, p += channels) {
      if (hasAlpha && data[p + channels - 1] !== 255) throw new Error('The render background is not opaque.');
      let white = true;
      for (let c = 0; c < colors; c += 1) if (data[p + c] !== 255) white = false;
      if (white) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

function unionBox(a, b) {
  if (!a || !b) return a || b;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

// { identical, pixels, maxDiff } of two decoded images.
function comparePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    return { identical: false, pixels: a.width * a.height, maxDiff: 255 };
  }
  if (a.data.equals(b.data)) return { identical: true, pixels: 0, maxDiff: 0 };
  let pixels = 0;
  let maxDiff = 0;
  for (let p = 0; p < a.data.length; p += a.channels) {
    let differs = false;
    for (let c = 0; c < a.channels; c += 1) {
      const diff = Math.abs(a.data[p + c] - b.data[p + c]);
      if (diff > 0) differs = true;
      if (diff > maxDiff) maxDiff = diff;
    }
    if (differs) pixels += 1;
  }
  return { identical: false, pixels, maxDiff };
}

// --- encode --------------------------------------------------------------------

// PNG frames -> H.264 yuv420p (tagged BT.709), CRF 18, FPS, no audio, +faststart.
async function encode(ffmpegPath, pngFrames, destPath) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', 'pipe:0',
    '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p,` +
      'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-r', String(FPS),
    '-an', '-movflags', '+faststart', destPath];
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  closed.catch(() => {});
  // ffmpeg stopping early shows in its exit code.
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), ENCODE_TIMEOUT_MS);
  try {
    for (const png of pngFrames) {
      if (!child.stdin.write(png)) await Promise.race([once(child.stdin, 'drain'), closed]);
    }
    child.stdin.end();
    const code = await closed;
    if (code !== 0) throw new Error(`ffmpeg failed: ${media.tidy(stderr) || `exit code ${code}`}`);
  } finally {
    clearTimeout(timer);
  }
}

// --- render --------------------------------------------------------------------

async function render({
  chromePath = process.env.CHROME_PATH || DEFAULT_CHROME,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  log = console.log,
} = {}) {
  if (!Number.isInteger(FRAMES)) throw new Error('The loop is not a whole number of frames.');
  const overlayHtml = await fsp.readFile(path.join(ROOT, 'public', 'overlay.html'), 'utf8');
  const overlayCss = await fsp.readFile(path.join(ROOT, 'public', 'overlay.css'), 'utf8');
  const page = renderPage(overlayCss, extractElement(overlayHtml, 'demo-avatar'));
  const deviceW = WIDTH * DEVICE_SCALE;
  const deviceH = HEIGHT * DEVICE_SCALE;
  const decode = png => {
    const image = decodePng(png);
    if (image.width !== deviceW || image.height !== deviceH) throw new Error(`Screenshot is ${image.width}x${image.height}, expected ${deviceW}x${deviceH}.`);
    return image;
  };

  await fsp.mkdir(PROFILE_PARENT, { recursive: true });
  const profileDir = await fsp.mkdtemp(path.join(PROFILE_PARENT, 'render-demo-idle-chrome-'));
  let browser = null;
  let plan = null;
  const frames = [];
  let content = null;
  let loopCheck = null;
  try {
    browser = await openPage(chromePath, profileDir, page);
    plan = await browser.evaluate(`(${pageHelpers})(${LOOP_MS}, ${FRAMES})`);
    for (const track of plan) {
      log(`${track.name}: ${track.period / 1000} s x ${track.cycles} per ${LOOP_MS / 1000} s loop (playback rate ${track.rate.toFixed(4)})`);
    }

    // 1. Measure: the avatar box at scale 1, centred, over one whole loop.
    const box = await browser.evaluate('window.__render.box()');
    const mx = (WIDTH - box.width) / 2;
    const my = (HEIGHT - box.height) / 2;
    await browser.evaluate(`window.__render.place(${mx}, ${my}, 1)`);
    let measured = null;
    for (let i = 0; i < FRAMES; i += 1) {
      await browser.evaluate(`window.__render.seek(${i})`);
      measured = unionBox(measured, contentBox(decode(await browser.screenshot())));
    }
    if (!measured) throw new Error('Nothing was drawn.');
    if (measured.x0 === 0 || measured.y0 === 0 || measured.x1 === deviceW - 1 || measured.y1 === deviceH - 1) {
      throw new Error('The avatar does not fit the measuring page.');
    }
    // In CSS px of the avatar box at scale 1.
    const bounds = {
      x: measured.x0 / DEVICE_SCALE - mx,
      y: measured.y0 / DEVICE_SCALE - my,
      width: (measured.x1 + 1 - measured.x0) / DEVICE_SCALE,
      height: (measured.y1 + 1 - measured.y0) / DEVICE_SCALE,
    };

    // 2. Place: centred, MARGIN on the tighter axis.
    const scale = Math.min((WIDTH * (1 - 2 * MARGIN)) / bounds.width, (HEIGHT * (1 - 2 * MARGIN)) / bounds.height);
    const x = (WIDTH - scale * bounds.width) / 2 - scale * bounds.x;
    const y = (HEIGHT - scale * bounds.height) / 2 - scale * bounds.y;
    log(`avatar ${bounds.width} x ${bounds.height} CSS px incl. shadows and motion; placed at scale ${scale.toFixed(4)}`);
    await browser.evaluate(`window.__render.place(${x}, ${y}, ${scale})`);

    // 3. Capture frames 0..FRAMES-1, plus t = LOOP to check the loop.
    let first = null;
    for (let i = 0; i <= FRAMES; i += 1) {
      await browser.evaluate(`window.__render.seek(${i})`);
      const png = await browser.screenshot();
      const image = decode(png);
      if (i === 0) first = image;
      if (i < FRAMES) {
        frames.push(png);
        content = unionBox(content, contentBox(image));
      } else {
        loopCheck = comparePixels(first, image);
      }
    }
  } finally {
    if (browser) await browser.close();
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!loopCheck.identical) {
    throw new Error(`Not a seamless loop: the frame at ${LOOP_MS / 1000} s differs from frame 0 in ${loopCheck.pixels} px (max channel difference ${loopCheck.maxDiff}).`);
  }
  log(`loop check: the frame at ${LOOP_MS / 1000} s is pixel-identical to frame 0 (${deviceW}x${deviceH} px)`);
  const margins = {
    left: content.x0 / deviceW,
    right: (deviceW - 1 - content.x1) / deviceW,
    top: content.y0 / deviceH,
    bottom: (deviceH - 1 - content.y1) / deviceH,
  };
  log(`margins: ${Object.entries(margins).map(([side, value]) => `${side} ${(value * 100).toFixed(1)} %`).join(', ')}`);
  if (Object.values(margins).some(value => value < MIN_MARGIN)) throw new Error('The avatar is too close to the frame edge.');
  if (Math.abs(margins.left - margins.right) > 0.01) throw new Error('The avatar is not horizontally centred.');

  await fsp.mkdir(OUT_DIR, { recursive: true });
  const tmpVideo = `${VIDEO_PATH}.${crypto.randomUUID()}.tmp.mp4`;
  try {
    await encode(ffmpegPath, frames, tmpVideo);
    await fsp.rename(tmpVideo, VIDEO_PATH);
  } finally {
    await fsp.rm(tmpVideo, { force: true }).catch(() => {});
  }
  await media.makePoster(ffmpegPath, VIDEO_PATH, POSTER_PATH);

  const video = await media.probeVideo(ffprobePath, VIDEO_PATH);
  const poster = await media.probeVideo(ffprobePath, POSTER_PATH);
  const bytes = (await fsp.stat(VIDEO_PATH)).size;
  log(`video:  ${VIDEO_PATH} (${video.codec} ${video.width}x${video.height}, ${video.fps} fps, ${video.duration} s, ${bytes} bytes)`);
  log(`poster: ${POSTER_PATH} (${poster.width}x${poster.height})`);
  return { videoPath: VIDEO_PATH, posterPath: POSTER_PATH, video, poster, bytes, margins, plan };
}

if (require.main === module) {
  render().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { render, extractElement, renderPage, decodePng, contentBox, comparePixels, FRAMES, LOOP_MS };
