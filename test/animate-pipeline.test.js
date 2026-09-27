'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createAppServer } = require('../server');
const { makeGreenscreenSample } = require('../scripts/make-greenscreen-sample');
const mockProvider = require('../lib/animate/providers/mock');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

async function ffmpegUsable() {
  const run = (cmd, args) => new Promise(resolve => {
    let out = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => resolve(null));
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.on('close', code => resolve(code === 0 ? out : null));
  });
  const version = await run(FFMPEG, ['-hide_banner', '-version']);
  if (!version) return false;
  if (!(await run(FFPROBE, ['-hide_banner', '-version']))) return false;
  const encoders = await run(FFMPEG, ['-hide_banner', '-encoders']);
  if (!encoders || !/\blibvpx-vp9\b/.test(encoders)) return false;
  const filters = await run(FFMPEG, ['-hide_banner', '-filters']);
  return !!filters && /\bchromakey\b/.test(filters);
}

async function start(opts) {
  const server = await createAppServer(opts);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function alphaDims(filePath) {
  // Decode the first VP9 frame; return { width, height, alphaCorner, alphaCenter }.
  return new Promise((resolve, reject) => {
    const probe = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
    let dims = '';
    probe.stdout.on('data', c => { dims += c.toString(); });
    probe.on('error', reject);
    probe.on('close', () => {
      const [w, h] = dims.trim().split(',').map(Number);
      const args = ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
      const dec = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      dec.on('error', reject);
      dec.stdout.on('data', c => chunks.push(c));
      dec.on('close', code => {
        if (code !== 0) return reject(new Error(`decode exited ${code}`));
        const buf = Buffer.concat(chunks);
        const alpha = (x, y) => buf[(y * w + x) * 4 + 3];
        resolve({ width: w, height: h, alphaCorner: alpha(1, 1), alphaCenter: alpha(Math.floor(w / 2), Math.floor(h / 2)) });
      });
    });
  });
}

async function uploadReference(base, presetId, clipPath, filename) {
  const bytes = await fs.readFile(clipPath);
  return fetch(`${base}/api/animate/references/${presetId}?filename=${encodeURIComponent(filename)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
}

// Poll a job until terminal or timeout.
async function pollJob(base, id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (['done', 'failed', 'canceled'].includes(job.state)) return job;
  }
  throw new Error('job did not finish in time');
}

test('animate config: masking, env precedence, 0600, PUT rules', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-config-'));
  const { server, base } = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, animateMock: true });
  try {
    // Store a WaveSpeed key.
    let status = await (await fetch(`${base}/api/animate/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: { wavespeed: { apiKey: 'secret-abcd1234' } } }),
    })).json();
    const ws = status.providers.find(p => p.id === 'wavespeed');
    const apiKeyField = ws.credentials.find(c => c.key === 'apiKey');
    assert.equal(apiKeyField.configured, true);
    assert.equal(apiKeyField.source, 'config');
    assert.equal(apiKeyField.masked, '••••1234', 'masks all but last 4');
    assert.ok(JSON.stringify(status).indexOf('secret-abcd1234') === -1, 'raw secret never leaves the server');

    // 0600 on the providers.json file.
    const stat = await fs.stat(path.join(dataDir, 'animate', 'providers.json'));
    assert.equal(stat.mode & 0o777, 0o600, 'providers.json is 0600');

    // A masked value in a PUT is ignored (unchanged).
    status = await (await fetch(`${base}/api/animate/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: { wavespeed: { apiKey: '••••1234' } } }),
    })).json();
    assert.equal(status.providers.find(p => p.id === 'wavespeed').credentials.find(c => c.key === 'apiKey').masked, '••••1234');

    // "" removes the stored value; env fallback then applies.
    process.env.WAVESPEED_API_KEY = 'env-key-9999';
    try {
      status = await (await fetch(`${base}/api/animate/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { wavespeed: { apiKey: '' } } }),
      })).json();
      const field = status.providers.find(p => p.id === 'wavespeed').credentials.find(c => c.key === 'apiKey');
      assert.equal(field.source, 'env', 'falls back to env after removal');
      assert.equal(field.masked, null, 'env values are not masked back to the client');
    } finally {
      delete process.env.WAVESPEED_API_KEY;
    }

    // Unknown provider / field / bad concurrency -> 400.
    assert.equal((await fetch(`${base}/api/animate/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: { nope: { apiKey: 'x' } } }) })).status, 400);
    assert.equal((await fetch(`${base}/api/animate/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: { wavespeed: { bogus: 'x' } } }) })).status, 400);
    assert.equal((await fetch(`${base}/api/animate/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concurrency: 9 }) })).status, 400);
    assert.equal((await fetch(`${base}/api/animate/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaRelay: 'dashscope' }) })).status, 400, 'mediaRelay must support public uploads');
    assert.equal((await fetch(`${base}/api/animate/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keying: { similarity: 5 } }) })).status, 400);

    // Valid keying/concurrency/promptSuffix persist.
    status = await (await fetch(`${base}/api/animate/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keying: { color: '#00FF00', similarity: 0.2 }, concurrency: 3, autoPublish: false }),
    })).json();
    assert.equal(status.config.keying.similarity, 0.2);
    assert.equal(status.config.concurrency, 3);
    assert.equal(status.config.autoPublish, false);

    // requires application/json.
    assert.equal((await fetch(`${base}/api/animate/config`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  } finally {
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('animate status, presets, references, and validation codes', async (t) => {
  if (!(await ffmpegUsable())) { t.skip('ffmpeg with libvpx-vp9 is unavailable.'); return; }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-refs-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-refs-src-'));
  const clip = path.join(scratch, 'hi.mp4');
  await makeGreenscreenSample(clip, { width: 320, height: 240, duration: 3, fps: 24, ffmpegPath: FFMPEG });
  const { server, base } = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, animateMock: true });
  try {
    const status = await (await fetch(`${base}/api/animate/status`)).json();
    assert.equal(status.ffmpeg.available, true);
    assert.equal(status.presets.length, 9);
    assert.ok(status.presets.every(p => p.reference === null));
    assert.ok(status.routes.some(r => r.id === 'mock/local-demo'), 'mock route present when enabled');
    assert.ok(status.referencesDir.endsWith(path.join('animate', 'references')));

    // Unknown preset -> 404.
    assert.equal((await uploadReference(base, 'not-a-preset', clip, 'x.mp4')).status, 404);
    // Bad extension -> 415, nothing left behind.
    assert.equal((await fetch(`${base}/api/animate/references/hi?filename=x.gif`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('nope') })).status, 415);
    // Non-video bytes -> 415, nothing left behind.
    assert.equal((await fetch(`${base}/api/animate/references/hi?filename=x.mp4`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not a video') })).status, 415);
    const refsAfterBad = await fs.readdir(path.join(dataDir, 'animate', 'references'));
    assert.equal(refsAfterBad.length, 0, 'failed reference upload leaves nothing');

    // Good upload -> 201 with reference view.
    const uploaded = await uploadReference(base, 'hi', clip, 'hi.mp4');
    assert.equal(uploaded.status, 201);
    const preset = await uploaded.json();
    assert.equal(preset.id, 'hi');
    assert.ok(preset.reference && Math.abs(preset.reference.duration - 3) < 0.6);
    assert.equal(preset.reference.width, 320);

    // GET reference serves the file.
    assert.equal((await fetch(`${base}/api/animate/references/hi`)).status, 200);

    // PUT preset trim/prompt rules.
    assert.equal((await fetch(`${base}/api/animate/presets/hi`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trimStart: 2, trimEnd: 1 }) })).status, 400, 'end must exceed start');
    const trimmed = await (await fetch(`${base}/api/animate/presets/hi`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trimStart: 0.5, trimEnd: 2, prompt: 'custom wave' }) })).json();
    assert.equal(trimmed.trim.start, 0.5);
    assert.equal(trimmed.trim.end, 2);
    assert.equal(trimmed.promptOverride, 'custom wave');
    assert.ok(trimmed.prompt.startsWith('custom wave'), 'sent prompt uses the override');

    // Job creation validation: no character yet -> character_missing.
    let create = await fetch(`${base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presetIds: ['hi'], routeId: 'mock/local-demo' }) });
    assert.equal(create.status, 400);
    assert.equal((await create.json()).code, 'character_missing');

    // Unknown route -> unknown_route.
    // (upload a character first so we get past character_missing)
    const charClip = path.join(scratch, 'char.png');
    await makeCharacterPng(charClip);
    assert.equal((await fetch(`${base}/api/animate/character?filename=char.png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await fs.readFile(charClip) })).status, 201);
    create = await fetch(`${base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presetIds: ['hi'], routeId: 'no/such-route' }) });
    assert.equal((await create.json()).code, 'unknown_route');

    // reference_missing for a preset without a reference.
    create = await fetch(`${base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presetIds: ['wink'], routeId: 'mock/local-demo' }) });
    assert.equal((await create.json()).code, 'reference_missing');

    // DELETE reference.
    assert.equal((await fetch(`${base}/api/animate/references/hi`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/animate/references/hi`)).status, 404);
  } finally {
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('animate pipeline: mock route drives a preset end to end + retry-from-keying + replaceExisting', async (t) => {
  if (!(await ffmpegUsable())) { t.skip('ffmpeg with libvpx-vp9 is unavailable.'); return; }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-e2e-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-e2e-src-'));
  const clip = path.join(scratch, 'hi.mp4');
  await makeGreenscreenSample(clip, { width: 256, height: 256, duration: 3, fps: 24, ffmpegPath: FFMPEG });
  const charPng = path.join(scratch, 'char.png');
  await makeCharacterPng(charPng);

  mockProvider._resetSubmitCount();
  const { server, base } = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, animateMock: true });
  try {
    await uploadReference(base, 'hi', clip, 'hi.mp4');
    assert.equal((await fetch(`${base}/api/animate/character?filename=char.png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await fs.readFile(charPng) })).status, 201);

    // End to end.
    const create = await fetch(`${base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presetIds: ['hi'], routeId: 'mock/local-demo' }) });
    assert.equal(create.status, 202);
    const { jobs } = await create.json();
    const jobId = jobs[0].id;
    const done = await pollJob(base, jobId);
    assert.equal(done.state, 'done', `expected done, got ${done.state} (${done.error && done.error.message})`);
    assert.ok(done.media && done.media.id, 'published a motion');
    assert.equal(done.media.name, '인사');

    // The published motion is in the library and alpha-carrying; WebM size = canvas.
    const lib = await (await fetch(`${base}/api/library`)).json();
    assert.ok(lib.motions.some(m => m.id === done.media.id));
    const resultPath = path.join(scratch, 'result.webm');
    await fs.writeFile(resultPath, Buffer.from(await (await fetch(`${base}/api/animate/jobs/${jobId}/result`)).arrayBuffer()));
    const decoded = await alphaDims(resultPath);
    // Canvas size = the CHARACTER source size (200x200 from makeCharacterPng),
    // not the reference clip size. The WebM matches the canvas.
    assert.equal(decoded.width, 200, 'WebM width = canvas (character) width');
    assert.equal(decoded.height, 200, 'WebM height = canvas (character) height');
    assert.equal(decoded.alphaCorner, 0, 'corner keyed transparent');
    assert.ok(decoded.alphaCenter > 200, 'character centre opaque');

    const submitsAfterFirst = mockProvider._submitCount();
    assert.equal(submitsAfterFirst, 1, 'exactly one submit for the run');

    // Retry-from-keying (canResume) must NOT re-submit.
    const retry = await fetch(`${base}/api/animate/jobs/${jobId}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: false }) });
    // 'done' jobs are not active, retry is allowed; the generated.mp4 is present -> restarts at keying.
    assert.equal(retry.status, 202);
    const done2 = await pollJob(base, jobId);
    assert.equal(done2.state, 'done');
    assert.equal(mockProvider._submitCount(), submitsAfterFirst, 'retry-from-keying did not re-submit');

    // replaceExisting: a fresh job for the same preset removes the prior media.
    const priorMediaId = done2.media.id;
    const create2 = await fetch(`${base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presetIds: ['hi'], routeId: 'mock/local-demo' }) });
    const job2Id = (await create2.json()).jobs[0].id;
    const done3 = await pollJob(base, job2Id);
    assert.equal(done3.state, 'done');
    assert.notEqual(done3.media.id, priorMediaId);
    const lib2 = await (await fetch(`${base}/api/library`)).json();
    assert.ok(!lib2.motions.some(m => m.id === priorMediaId), 'replaceExisting removed the previous motion');
    assert.ok(lib2.motions.some(m => m.id === done3.media.id));
  } finally {
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('animate cancel and encoder-slot 409 with chroma', async (t) => {
  if (!(await ffmpegUsable())) { t.skip('ffmpeg with libvpx-vp9 is unavailable.'); return; }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-slot-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-slot-src-'));
  const clip = path.join(scratch, 'clip.mp4');
  await makeGreenscreenSample(clip, { width: 320, height: 240, duration: 5, fps: 30, ffmpegPath: FFMPEG });
  const { server, base } = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, animateMock: true });
  try {
    // Start a chroma conversion to hold the shared encoder slot.
    const created = await (await fetch(`${base}/api/chroma/jobs?filename=clip.mp4`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await fs.readFile(clip) })).json();
    const conv = await fetch(`${base}/api/chroma/jobs/${created.id}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(conv.status, 202);
    // A second chroma convert is refused while the slot is held.
    const conflict = await fetch(`${base}/api/chroma/jobs/${created.id}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(conflict.status, 409);
    // Cancel to free the slot.
    assert.equal((await fetch(`${base}/api/chroma/jobs/${created.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);

    // Cancel an animate job mid-flight (long mock delay so it stays active).
    await uploadReference(base, 'hi', clip, 'hi.mp4');
    const charPng = path.join(scratch, 'char.png');
    await makeCharacterPng(charPng);
    await fetch(`${base}/api/animate/character?filename=char.png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await fs.readFile(charPng) });
    const create = await fetch(`${base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presetIds: ['hi'], routeId: 'mock/local-demo', options: { delayMs: 30000 } }) });
    const jobId = (await create.json()).jobs[0].id;
    // Wait until it is generating, then cancel.
    let seenGenerating = false;
    for (let i = 0; i < 50 && !seenGenerating; i += 1) {
      await new Promise(r => setTimeout(r, 100));
      const j = await (await fetch(`${base}/api/animate/jobs/${jobId}`)).json();
      if (j.state === 'generating') seenGenerating = true;
      if (['done', 'failed', 'canceled'].includes(j.state)) break;
    }
    const cancel = await fetch(`${base}/api/animate/jobs/${jobId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).state, 'canceled');
    // Cancel again -> 409 (terminal).
    assert.equal((await fetch(`${base}/api/animate/jobs/${jobId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
  } finally {
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('animate restart resume: an interrupted generating job resumes and finishes', async (t) => {
  if (!(await ffmpegUsable())) { t.skip('ffmpeg with libvpx-vp9 is unavailable.'); return; }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-resume-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-resume-src-'));
  const clip = path.join(scratch, 'hi.mp4');
  await makeGreenscreenSample(clip, { width: 256, height: 256, duration: 2, fps: 24, ffmpegPath: FFMPEG });
  const charPng = path.join(scratch, 'char.png');
  await makeCharacterPng(charPng);

  mockProvider._resetSubmitCount();
  const first = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, animateMock: true });
  let jobId;
  try {
    await uploadReference(first.base, 'hi', clip, 'hi.mp4');
    await fetch(`${first.base}/api/animate/character?filename=char.png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await fs.readFile(charPng) });
    // A delay long enough to still be "generating" when we stop the server.
    const create = await fetch(`${first.base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presetIds: ['hi'], routeId: 'mock/local-demo', options: { delayMs: 1500 } }) });
    jobId = (await create.json()).jobs[0].id;
    // Wait until it has submitted (task persisted) and is generating.
    for (let i = 0; i < 50; i += 1) {
      await new Promise(r => setTimeout(r, 60));
      const j = await (await fetch(`${first.base}/api/animate/jobs/${jobId}`)).json();
      if (j.state === 'generating') break;
    }
  } finally {
    await stop(first.server);
  }
  const submitsBeforeRestart = mockProvider._submitCount();
  assert.equal(submitsBeforeRestart, 1, 'submitted once before restart');

  // Restart with the same dataDir: the job resumes polling (does not re-submit).
  const second = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, animateMock: true });
  try {
    const done = await pollJob(second.base, jobId, 30000);
    assert.equal(done.state, 'done', `resumed job should finish; got ${done.state} (${done.error && done.error.message})`);
    assert.equal(mockProvider._submitCount(), submitsBeforeRestart, 'resume did not re-submit');
    assert.ok(done.media && done.media.id, 'resumed job published a motion');
  } finally {
    await stop(second.server);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

// A character PNG on a solid green background with a centered opaque magenta
// box. Compositing keeps green; keying then removes the green (corner
// transparent) and leaves the magenta character opaque.
async function makeCharacterPng(destPath) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=200x200',
      '-vf', 'drawbox=x=50:y=50:w=100:h=100:color=0xC030C0:t=fill,format=yuv420p',
      '-frames:v', '1', destPath];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(destPath) : reject(new Error(`char png failed: ${stderr}`)));
  });
}
