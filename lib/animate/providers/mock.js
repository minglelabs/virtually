'use strict';

// Local test generator ("mock"): NOT a real AI provider and never touches the
// network. It is added to the registry only when createAppServer({ animateMock:
// true }) or env VIRTUALLY_ANIMATE_MOCK=1 is set. It "generates" a clip with
// ffmpeg — the sent character image bobbing up and down over the green canvas
// for the length of the driving video (max 6 s) — so the pipeline can be driven
// end to end (prepare -> submit -> poll -> download) without any paid call.
//
// The route object for this provider lives in registry.js (mock/local-demo).

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const KEY_COLOR = '0x00FF00';

// Test hooks: a submit counter (so tests can assert submit is called exactly
// once) and an artificial per-task delay (so a resume test can restart the
// server mid-"generation").
let submitCount = 0;

const meta = {
  id: 'mock',
  label: '로컬 테스트 (AI 아님)',
  docs: null,
  credentials: [],
  credentialSets: [], // always configured; no keys needed
  settings: [],
  needsPublicVideoUrl: false,
  publicUploads: false,
  pollIntervalMs: 200,
};

// The mock needs no upload: the pipeline hands it local file paths directly.
async function upload(ctx, file) {
  return file.path;
}

// "Submit" records a task with the local inputs and a scheduled completion time
// derived from the artificial delay option (default 0). Nothing is sent.
async function submit(ctx, route, input) {
  submitCount += 1;
  const delayMs = mockDelayMs(ctx, route, input);
  return {
    id: crypto.randomUUID(),
    imagePath: input.imageUrl,
    videoPath: input.videoUrl,
    // Persisted in job.json; on restart the pipeline resumes polling and the
    // completion time survives, so a short delay reliably spans a restart.
    completeAt: Date.now() + delayMs,
    delayMs,
  };
}

async function poll(ctx, route, task) {
  if (Date.now() < (task.completeAt || 0)) {
    return { state: 'running', providerStatus: 'generating' };
  }
  // The output "url" is the local generated file path the pipeline downloads.
  // We render on demand into a temp file next to the requested output; the
  // pipeline's download() copies it to generated.mp4.
  return { state: 'succeeded', outputUrl: `mock://${task.id}`, providerStatus: 'succeeded' };
}

// The mock "download" renders the bobbing clip. The pipeline calls it with the
// outputUrl from poll() and the destination path. ctx carries the render inputs
// via ctx.mock (set by the pipeline) since a mock:// url holds no data.
async function download(ctx, url, destPath) {
  const render = ctx && ctx.mock;
  if (!render || !render.imagePath) {
    throw Object.assign(new Error('mock download requires render inputs.'), { retryable: false });
  }
  await renderBobbing(render, destPath);
  const stat = await fsp.stat(destPath);
  return { size: stat.size };
}

const cancel = null; // nothing to cancel remotely
const test = null;

// --- helpers -----------------------------------------------------------------

function mockDelayMs(ctx, route, input) {
  const opt = input && input.options && input.options.delayMs;
  const n = Number(opt);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 60000);
  return 0;
}

// Render the sent image bobbing over the key colour, at the sent size, for
// min(reference duration, 6 s), H.264. Wrapped with a hard timeout so a hung
// ffmpeg can never wedge a test.
function renderBobbing(render, destPath) {
  const ffmpegPath = render.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const width = Math.max(2, Math.round(render.width || 512));
  const height = Math.max(2, Math.round(render.height || 512));
  const duration = Math.min(6, Math.max(0.5, Number(render.duration) || 2));
  const fps = 24;
  // Background = key colour; overlay the image bobbing vertically by ~4% height.
  const bob = Math.round(height * 0.04);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=${KEY_COLOR}:s=${width}x${height}:r=${fps}:d=${duration}`,
    '-i', render.imagePath,
    '-filter_complex',
    `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[img];` +
      `[0:v][img]overlay=x=(W-w)/2:y=(H-h)/2+${bob}*sin(2*PI*t)[out]`,
    '-map', '[out]', '-t', String(duration),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps),
    destPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60000);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(destPath);
      reject(new Error(`mock render failed (${code}): ${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

module.exports = {
  meta,
  upload,
  submit,
  poll,
  cancel,
  download,
  test,
  // test-only introspection
  _submitCount: () => submitCount,
  _resetSubmitCount: () => { submitCount = 0; },
};
