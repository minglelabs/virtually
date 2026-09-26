'use strict';

// Seam test: the animate pipeline driving the REAL WaveSpeed and Kling adapters
// (Kling's reference video travels through the WaveSpeed media relay) against a
// local fake that emulates their documented HTTP protocols. No network access.
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createAppServer } = require('../server');
const { makeGreenscreenSample } = require('../scripts/make-greenscreen-sample');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const WAVESPEED_KEY = 'ws-test-key-0123456789abcdef';
const KLING_ACCESS = 'kling-access-0123456789';
const KLING_SECRET = 'kling-secret-abcdef0123456789';

function run(cmd, args) {
  return new Promise(resolve => {
    const chunks = [];
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => resolve(null));
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', code => resolve(code === 0 ? Buffer.concat(chunks) : null));
  });
}

async function ffmpegUsable() {
  const encoders = await run(FFMPEG, ['-hide_banner', '-encoders']);
  const filters = await run(FFMPEG, ['-hide_banner', '-filters']);
  const probe = await run(FFPROBE, ['-hide_banner', '-version']);
  return !!(encoders && filters && probe && /\blibvpx-vp9\b/.test(encoders) && /\bchromakey\b/.test(filters));
}

// Transparent 320x240 PNG with an opaque magenta "character" box in the middle.
async function makeIdlePng(destPath) {
  const out = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=black@0.0:s=320x240,format=rgba',
    '-vf', 'drawbox=x=110:y=70:w=100:h=100:color=0xC030C0@1:t=fill',
    '-frames:v', '1', destPath]);
  assert.ok(out, 'idle PNG fixture');
  return destPath;
}

// First decoded frame of a VP9 WebM (libvpx keeps alpha): size + corner/centre alpha.
async function alphaDims(filePath) {
  const dims = (await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath])).toString();
  const [width, height] = dims.trim().split(',').map(Number);
  const raw = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  const alpha = (x, y) => raw[(y * width + x) * 4 + 3];
  return { width, height, alphaCorner: alpha(1, 1), alphaCenter: alpha(Math.floor(width / 2), Math.floor(height / 2)) };
}

async function startApp(dataDir) {
  const server = await createAppServer({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, animatePollIntervalMs: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function pollJob(base, id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (['done', 'failed', 'canceled'].includes(job.state)) return job;
  }
  throw new Error('job did not finish in time');
}

// Emulates WaveSpeed (upload tickets + presigned PUT, submit, prediction result)
// and the Kling classic motion-control create/query pair.
async function startFakeProviders(generatedClip) {
  const state = { tickets: [], puts: [], submits: [], polls: 0, files: new Map(), kling: { submits: [], polls: 0 } };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const send = (status, value, type = 'application/json') => {
      const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': payload.length });
      res.end(payload);
    };

    if (req.method === 'GET' && url.pathname === '/api/v3/balance') {
      state.balanceChecks = (state.balanceChecks || 0) + 1;
      if (req.headers.authorization !== `Bearer ${WAVESPEED_KEY}`) return send(401, { code: 401, message: 'Unauthorized' });
      return send(200, { code: 200, message: 'success', data: { balance: 12.5 } });
    }
    if (req.method === 'POST' && url.pathname === '/api/v3/media/uploads') {
      const ticket = JSON.parse(body.toString());
      const token = crypto.randomUUID();
      state.tickets.push({ auth: req.headers.authorization, token, ...ticket });
      return send(200, { code: 200, message: 'success', data: {
        type: 'file', filename: ticket.filename, size: ticket.size,
        download_url: `${origin}/files/${token}/${ticket.filename}`,
        upload: { method: 'PUT', url: `${origin}/upload/${token}`, headers: { 'Content-Type': ticket.content_type || 'application/octet-stream', 'If-None-Match': '*' }, expires_at: '2099-01-01T00:00:00Z' },
      } });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const token = url.pathname.split('/')[2];
      state.puts.push({ token, auth: req.headers.authorization || null, size: body.length, ifNoneMatch: req.headers['if-none-match'] || null });
      state.files.set(token, body);
      return send(200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/v3/wavespeed-ai/wan-2.2/animate') {
      state.submits.push({ auth: req.headers.authorization, body: JSON.parse(body.toString()) });
      return send(200, { code: 200, message: 'success', data: { id: 'pred-1', status: 'created', outputs: [], urls: { get: `${origin}/api/v3/predictions/pred-1/result` } } });
    }
    if (req.method === 'GET' && url.pathname === '/api/v3/predictions/pred-1/result') {
      state.polls += 1;
      const done = state.polls >= 2;
      return send(200, { code: 200, message: 'success', data: { id: 'pred-1', status: done ? 'completed' : 'processing', outputs: done ? [`${origin}/out/generated.mp4`] : [], error: '' } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/videos/motion-control') {
      state.kling.submits.push({ auth: req.headers.authorization, body: JSON.parse(body.toString()) });
      return send(200, { code: 0, message: 'SUCCEED', request_id: 'req-1', data: { task_id: 'k-1', task_status: 'submitted' } });
    }
    if (req.method === 'GET' && url.pathname === '/v1/videos/motion-control/k-1') {
      state.kling.polls += 1;
      const done = state.kling.polls >= 2;
      return send(200, { code: 0, message: 'SUCCEED', data: { task_id: 'k-1', task_status: done ? 'succeed' : 'processing',
        task_result: done ? { videos: [{ id: 'v-1', url: `${origin}/out/generated.mp4`, duration: '2' }] } : {} } });
    }
    if (req.method === 'GET' && url.pathname === '/out/generated.mp4') {
      return send(200, await fs.readFile(generatedClip), 'video/mp4');
    }
    return send(404, { error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, state, origin: `http://127.0.0.1:${server.address().port}` };
}

function decodeJwt(token) {
  const [header, payload, signature] = token.split('.');
  const json = part => JSON.parse(Buffer.from(part, 'base64url').toString());
  const expected = crypto.createHmac('sha256', KLING_SECRET).update(`${header}.${payload}`).digest('base64url');
  return { header: json(header), payload: json(payload), validSignature: signature === expected };
}

test('seam: pipeline drives the real WaveSpeed adapter, and Kling direct via the WaveSpeed relay', async t => {
  if (!(await ffmpegUsable())) return t.skip('ffmpeg with libvpx-vp9 and chromakey is required');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-seam-'));
  const generatedClip = path.join(dataDir, 'fake-generated.mp4');
  const referenceClip = path.join(dataDir, 'reference.mp4');
  const idlePng = path.join(dataDir, 'idle.png');
  // 16:9 "generated" output vs a 4:3 canvas exercises contain + pad + crop + scale.
  await makeGreenscreenSample(generatedClip, { width: 640, height: 360, duration: 2, ffmpegPath: FFMPEG });
  await makeGreenscreenSample(referenceClip, { width: 320, height: 240, duration: 4, ffmpegPath: FFMPEG });
  await makeIdlePng(idlePng);

  const fake = await startFakeProviders(generatedClip);
  await fs.mkdir(path.join(dataDir, 'animate'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'animate', 'providers.json'), JSON.stringify({
    version: 1,
    providers: {
      wavespeed: { apiKey: WAVESPEED_KEY, baseUrl: `${fake.origin}/api/v3` },
      kling: { accessKey: KLING_ACCESS, secretKey: KLING_SECRET, baseUrl: fake.origin },
    },
  }), { mode: 0o600 });
  const { server, base } = await startApp(dataDir);
  try {
    const idle = await fetch(`${base}/api/upload?kind=idle&name=idle&filename=idle.png`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await fs.readFile(idlePng),
    });
    assert.equal(idle.status, 201, 'idle registered');
    for (const presetId of ['hi', 'wink']) {
      const uploaded = await fetch(`${base}/api/animate/references/${presetId}?filename=${presetId}.mp4`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await fs.readFile(referenceClip),
      });
      assert.equal(uploaded.status, 201, `reference ${presetId}`);
    }

    const status = await (await fetch(`${base}/api/animate/status`)).json();

    // Every script the controller page loads must be served as JavaScript.
    const html = await (await fetch(`${base}/`)).text();
    const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(m => m[1]);
    assert.ok(scripts.includes('animate.js'), 'index.html loads animate.js');
    for (const script of scripts) {
      const res = await fetch(`${base}/${script}`);
      assert.equal(res.status, 200, `${script} is served`);
      assert.match(res.headers.get('content-type'), /javascript/, `${script} has a JS MIME type`);
    }
    const routeById = Object.fromEntries(status.routes.map(route => [route.id, route]));
    assert.equal(routeById['wavespeed/wan-2.2-animate'].available, true);
    assert.equal(routeById['kling/v3-motion-control'].available, true, 'kling is available because WaveSpeed can relay');
    assert.equal(status.character.hasAlpha, true);
    assert.equal(status.character.width, 320);
    assert.ok(!JSON.stringify(status).includes(WAVESPEED_KEY) && !JSON.stringify(status).includes(KLING_SECRET), 'status never returns secrets');

    // The API can never repoint a provider (that would ship its key elsewhere).
    const repoint = await fetch(`${base}/api/animate/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: { wavespeed: { baseUrl: 'http://attacker.invalid' } } }),
    });
    assert.equal(repoint.status, 400, 'baseUrl is file-only');

    // "연결 테스트" must be free: WaveSpeed's balance endpoint, no upload ticket.
    const probe = await (await fetch(`${base}/api/animate/providers/wavespeed/test`, { method: 'POST' })).json();
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.match(probe.detail, /balance \$12\.5/);
    assert.equal(fake.state.balanceChecks, 1);
    assert.equal(fake.state.tickets.length, 0, 'the credential test creates no upload ticket');

    // --- Wan 2.2 Animate on WaveSpeed ------------------------------------------------
    const created = await fetch(`${base}/api/animate/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetIds: ['hi'], routeId: 'wavespeed/wan-2.2-animate', options: { resolution: '720p' } }),
    });
    assert.equal(created.status, 202);
    const wanJob = await pollJob(base, (await created.json()).jobs[0].id);
    assert.equal(wanJob.state, 'done', JSON.stringify(wanJob.error));
    assert.equal(wanJob.estimateUsd, 0.32, '720p $0.08/s x 4 s');

    assert.equal(fake.state.tickets.length, 2, 'image + video upload tickets');
    for (const ticket of fake.state.tickets) assert.equal(ticket.auth, `Bearer ${WAVESPEED_KEY}`);
    assert.deepEqual(fake.state.tickets.map(tk => tk.content_type).sort(), ['image/png', 'video/mp4']);
    assert.equal(fake.state.puts.length, 2);
    for (const put of fake.state.puts) {
      assert.equal(put.auth, null, 'the API key never goes to the presigned PUT URL');
      assert.equal(put.ifNoneMatch, '*', 'every ticket header is forwarded');
      assert.equal(put.size, fake.state.tickets.find(tk => tk.token === put.token).size, 'declared size matches the bytes');
    }
    assert.equal(fake.state.submits.length, 1, 'submitted exactly once');
    const submit = fake.state.submits[0];
    assert.equal(submit.auth, `Bearer ${WAVESPEED_KEY}`);
    const imageTicket = fake.state.tickets.find(tk => tk.content_type === 'image/png');
    const videoTicket = fake.state.tickets.find(tk => tk.content_type === 'video/mp4');
    assert.equal(submit.body.image, `${fake.origin}/files/${imageTicket.token}/${imageTicket.filename}`);
    assert.equal(submit.body.video, `${fake.origin}/files/${videoTicket.token}/${videoTicket.filename}`);
    assert.equal(submit.body.mode, 'animate');
    assert.equal(submit.body.resolution, '720p');
    assert.match(submit.body.prompt, /waves hello/);
    assert.match(submit.body.prompt, /solid green background/);
    assert.ok(fake.state.polls >= 2);

    const library = await (await fetch(`${base}/api/library`)).json();
    const motion = library.motions.find(item => item.id === wanJob.media.id);
    assert.ok(motion, 'published into the library');
    assert.equal(motion.name, '인사');
    assert.equal(motion.mime, 'video/webm');
    const resultPath = path.join(dataDir, 'wan-result.webm');
    await fs.writeFile(resultPath, Buffer.from(await (await fetch(`${base}/api/animate/jobs/${wanJob.id}/result`)).arrayBuffer()));
    const keyed = await alphaDims(resultPath);
    assert.deepEqual({ width: keyed.width, height: keyed.height }, { width: 320, height: 240 }, 'WebM matches the idle canvas');
    assert.equal(keyed.alphaCorner, 0, 'green background keyed out');
    assert.equal(keyed.alphaCenter, 255, 'character stays opaque');

    // --- Kling direct: image inline, video through the WaveSpeed relay ----------------
    const klingCreated = await fetch(`${base}/api/animate/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetIds: ['wink'], routeId: 'kling/v3-motion-control', options: { mode: 'std' } }),
    });
    assert.equal(klingCreated.status, 202);
    const klingJob = await pollJob(base, (await klingCreated.json()).jobs[0].id);
    assert.equal(klingJob.state, 'done', JSON.stringify(klingJob.error));
    assert.equal(fake.state.kling.submits.length, 1);
    const klingSubmit = fake.state.kling.submits[0];
    const jwt = decodeJwt(klingSubmit.auth.replace(/^Bearer /, ''));
    assert.equal(jwt.header.alg, 'HS256');
    assert.equal(jwt.payload.iss, KLING_ACCESS);
    assert.ok(jwt.payload.exp > jwt.payload.nbf, 'exp after nbf');
    assert.equal(jwt.validSignature, true, 'signed with the secret key');
    assert.match(klingSubmit.body.image, /^data:image\/png;base64,/, 'image travels inline');
    const relayTicket = fake.state.tickets.at(-1);
    assert.equal(relayTicket.content_type, 'video/mp4', 'the video went through the WaveSpeed relay');
    assert.equal(klingSubmit.body.video, `${fake.origin}/files/${relayTicket.token}/${relayTicket.filename}`);
    assert.equal(klingSubmit.body.character_orientation, 'image', 'wink keeps the image framing');
    assert.equal(klingSubmit.body.keep_original_sound, false);
    assert.equal(klingSubmit.body.model_name, 'kling-v3');
    assert.equal(klingSubmit.body.mode, 'std');

    const jobsJson = JSON.stringify(await (await fetch(`${base}/api/animate/jobs`)).json());
    for (const secret of [WAVESPEED_KEY, KLING_ACCESS, KLING_SECRET]) assert.ok(!jobsJson.includes(secret), 'jobs never expose credentials');
  } finally {
    await stop(server);
    await stop(fake.server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('config: setting env names are exact (a string is not iterated) and invalid values fall back to the default', async () => {
  const { ConfigStore } = require('../lib/animate/config');
  const providers = require('../lib/animate/providers');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-config-env-'));
  const saved = { DASHSCOPE_REGION: process.env.DASHSCOPE_REGION, KLING_REGION: process.env.KLING_REGION };
  try {
    delete process.env.DASHSCOPE_REGION;
    process.env.KLING_REGION = 'mars';
    const store = await new ConfigStore(path.join(dir, 'providers.json'), providers).load();
    // `process.env._` (set by shells) must never leak in through a string env name.
    assert.equal(store.resolvedSettings('dashscope').region, 'intl');
    assert.equal(store.resolvedSettings('kling').region, 'global', 'an env value outside `values` is ignored');
    process.env.DASHSCOPE_REGION = 'cn';
    assert.equal(store.resolvedSettings('dashscope').region, 'cn', 'a valid env value is used');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
