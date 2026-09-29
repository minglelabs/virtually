'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const crypto = require('node:crypto');

const httpHelpers = require('../lib/animate/http');
const { ProviderError, downloadToFile, fetchJson } = httpHelpers;
const catalog = require('../lib/animate/catalog');
const { ROUTES, FAMILIES, buildRequest, validateRoute } = catalog;
const providers = require('../lib/animate/providers');

// ---- fake-server helper -------------------------------------------------------------
// Start a node:http server on 127.0.0.1:0 whose handler receives (req, res, body). The
// handler must write the response. Returns { base, close, requests }.
function fakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      Promise.resolve(handler(req, res, body, requests)).catch(() => {
        if (!res.headersSent) { res.statusCode = 500; res.end('handler error'); }
      });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// A ctx for an adapter, pointed at a fake server (baseUrl => allowInsecure true, like the real config).
function makeCtx(base, { credentials = {}, settings = {}, extra = {} } = {}) {
  return {
    credentials, settings,
    fetch: (...args) => fetch(...args),
    baseUrl: base,
    signal: undefined,
    log: () => {},
    allowInsecure: base ? base.startsWith('http://') : false,
    ...extra,
  };
}

async function tmpFile(name, bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-prov-'));
  const p = path.join(dir, name);
  await fs.writeFile(p, bytes);
  return { path: p, filename: name, contentType: name.endsWith('.png') ? 'image/png' : 'video/mp4', size: bytes.length, dir };
}

// =====================================================================================
// catalog: buildRequest + validateRoute
// =====================================================================================

test('every catalog route validates and has a buildRequest', () => {
  assert.ok(ROUTES.length >= 15, `expected the full route table, got ${ROUTES.length}`);
  const ids = new Set();
  for (const route of ROUTES) {
    assert.doesNotThrow(() => validateRoute(route), `route ${route.id} should validate`);
    assert.equal(ids.has(route.id), false, `duplicate route id ${route.id}`);
    ids.add(route.id);
    assert.ok(FAMILIES[route.family], `route ${route.id} has a known family`);
    assert.ok(providers[route.provider], `route ${route.id} maps to a real provider adapter`);

    const built = buildRequest(route, {
      imageUrl: 'IMG', videoUrl: 'VID', prompt: 'hello',
      orientation: 'image', options: {},
    });
    // image + video always land at their mapped (possibly dotted) paths.
    assert.equal(getPath(built, route.fields.image), 'IMG', `${route.id} image path`);
    assert.equal(getPath(built, route.fields.video), 'VID', `${route.id} video path`);
    // static params are present.
    for (const [k, v] of Object.entries(route.params || {})) {
      assert.deepEqual(getPath(built, k), v, `${route.id} param ${k}`);
    }
    // each option defaults when not supplied.
    for (const opt of route.options || []) {
      assert.equal(getPath(built, opt.field), opt.default, `${route.id} option ${opt.key} default`);
    }
  }
});

function getPath(obj, dotted) {
  return String(dotted).split('.').reduce((n, k) => (n == null ? undefined : n[k]), obj);
}

test('buildRequest maps prompt only when the route supports it', () => {
  const wave = ROUTES.find(r => r.id === 'wavespeed/wan-2.2-animate');
  const withPrompt = buildRequest(wave, { imageUrl: 'i', videoUrl: 'v', prompt: 'p' });
  assert.equal(withPrompt.prompt, 'p');
  const dream = ROUTES.find(r => r.id === 'fal/dreamactor-v2'); // prompt field is null
  const noPrompt = buildRequest(dream, { imageUrl: 'i', videoUrl: 'v', prompt: 'p' });
  assert.equal('prompt' in noPrompt, false);
});

test('buildRequest maps orientation and sound for Kling routes', () => {
  const kling = ROUTES.find(r => r.id === 'fal/kling-v3-standard-motion-control');
  const body = buildRequest(kling, { imageUrl: 'i', videoUrl: 'v', orientation: 'video' });
  assert.equal(body.character_orientation, 'video');
  assert.equal(body.keep_original_sound, false); // sound.off value applied

  const hf = ROUTES.find(r => r.id === 'higgsfield/kling-v3-motion-control-std');
  const hfBody = buildRequest(hf, { imageUrl: 'i', videoUrl: 'v', orientation: 'image' });
  assert.equal(hfBody.character_orientation, 'image');
  assert.equal(hfBody.keep_original_sound, 'no'); // Higgsfield uses string "no"
});

test('buildRequest uses the option default when a supplied value is not allowed', () => {
  const dash = ROUTES.find(r => r.id === 'dashscope/wan2.2-animate-move');
  const bad = buildRequest(dash, { imageUrl: 'i', videoUrl: 'v', options: { mode: 'nonsense' } });
  assert.equal(getPath(bad, 'parameters.mode'), 'wan-std');
  const good = buildRequest(dash, { imageUrl: 'i', videoUrl: 'v', options: { mode: 'wan-pro' } });
  assert.equal(getPath(good, 'parameters.mode'), 'wan-pro');
  assert.equal(getPath(good, 'input.watermark'), false);
});

test('validateRoute rejects malformed routes', () => {
  assert.throws(() => validateRoute({}), /Invalid route/);
  assert.throws(() => validateRoute({ id: 'x', provider: 'p', family: 'nope', label: 'l', endpoint: 'e', fields: { image: 'i', video: 'v' }, verified: true }), /family/);
  assert.throws(() => validateRoute({ id: 'x', provider: 'p', family: 'other', label: 'l', endpoint: 'e', fields: { image: 'i' }, verified: true }), /fields.video/);
  assert.throws(() => validateRoute({ id: 'x', provider: 'p', family: 'other', label: 'l', endpoint: 'e', fields: { image: 'i', video: 'v' } }), /verified/);
});

// =====================================================================================
// http.js: download cap, https rule, secret-free errors
// =====================================================================================

test('downloadToFile refuses insecure URLs unless allowInsecure', async () => {
  await assert.rejects(
    downloadToFile({ fetch, url: 'http://127.0.0.1:1/x', destPath: '/tmp/none' }),
    err => err instanceof ProviderError && err.code === 'insecure_url'
  );
});

test('downloadToFile enforces the size cap (declared and streamed) and writes tmp+rename', async () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const srv = await fakeServer((req, res) => {
    if (req.url === '/big') { res.setHeader('Content-Length', String(10 * 1024 * 1024 * 1024)); res.end(payload); return; }
    res.setHeader('Content-Type', 'application/octet-stream'); res.end(payload);
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
  try {
    // declared too large
    await assert.rejects(
      downloadToFile({ fetch, url: `${srv.base}/big`, destPath: path.join(dir, 'a'), allowInsecure: true }),
      err => err instanceof ProviderError && err.code === 'too_large'
    );
    // streamed cap (maxBytes tiny)
    await assert.rejects(
      downloadToFile({ fetch, url: `${srv.base}/ok`, destPath: path.join(dir, 'b'), allowInsecure: true, maxBytes: 1024 }),
      err => err instanceof ProviderError && err.code === 'too_large'
    );
    // success + no leftover .part
    const out = path.join(dir, 'c');
    const { size } = await downloadToFile({ fetch, url: `${srv.base}/ok`, destPath: out, allowInsecure: true });
    assert.equal(size, payload.length);
    assert.deepEqual(await fs.readFile(out), payload);
    const leftovers = (await fs.readdir(dir)).filter(f => f.endsWith('.part'));
    assert.equal(leftovers.length, 0, 'no .part tmp file should remain');
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('downloadToFile sends the auth header only to the matching host', async () => {
  const srv = await fakeServer((req, res) => { res.end(Buffer.from('data')); });
  const host = new URL(srv.base).host;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl2-'));
  try {
    await downloadToFile({
      fetch, url: `${srv.base}/f`, destPath: path.join(dir, 'f'), allowInsecure: true,
      auth: { header: 'Authorization', value: 'Bearer SECRET', host },
    });
    assert.equal(srv.requests[0].headers.authorization, 'Bearer SECRET');

    // a different host must NOT receive the header
    srv.requests.length = 0;
    await downloadToFile({
      fetch, url: `${srv.base}/g`, destPath: path.join(dir, 'g'), allowInsecure: true,
      auth: { header: 'Authorization', value: 'Bearer SECRET', host: 'other.example' },
    });
    assert.equal(srv.requests[0].headers.authorization, undefined);
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('fetchJson maps 401 as non-retryable and 429 as retryable, without leaking secrets', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url === '/401') return json(res, 401, { code: 'InvalidApiKey', message: 'key sk-abcdefghijklmnopqrstuvwxyz012345 at https://secret.example/path bad' });
    if (req.url === '/429') return json(res, 429, { message: 'slow down' });
    return json(res, 200, { ok: true });
  });
  try {
    const e401 = await fetchJson(fetch, `${srv.base}/401`, { label: 'probe' }).catch(e => e);
    assert.ok(e401 instanceof ProviderError);
    assert.equal(e401.status, 401);
    assert.equal(e401.retryable, false);
    assert.equal(e401.code, 'InvalidApiKey');
    assert.doesNotMatch(e401.message, /sk-abcdefghijklmnop/, 'token must be redacted');
    assert.doesNotMatch(e401.message, /secret\.example/, 'url must be redacted');

    const e429 = await fetchJson(fetch, `${srv.base}/429`, { label: 'probe' }).catch(e => e);
    assert.equal(e429.status, 429);
    assert.equal(e429.retryable, true);
  } finally {
    await srv.close();
  }
});

// =====================================================================================
// WaveSpeed
// =====================================================================================

function wavespeedServer() {
  return fakeServer((req, res) => {
    if (req.method === 'POST' && req.url === '/media/uploads') {
      return json(res, 200, { data: { upload: { method: 'PUT', url: `http://${req.headers.host}/put/obj`, headers: {} }, download_url: `http://${req.headers.host}/dl/obj.png` } });
    }
    if (req.method === 'PUT' && req.url === '/put/obj') { res.statusCode = 200; return res.end(); }
    if (req.method === 'POST' && req.url === '/wavespeed-ai/wan-2.2/animate') {
      return json(res, 200, { data: { id: 'ws-1', urls: { get: `http://${req.headers.host}/predictions/ws-1/result` } } });
    }
    if (req.url === '/predictions/ws-1/result') {
      return json(res, 200, { data: { status: 'completed', outputs: [`http://${req.headers.host}/out.mp4`] } });
    }
    if (req.url === '/out.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(Buffer.from('MP4DATA')); }
    return json(res, 404, { error: 'nope' });
  });
}

test('wavespeed: upload -> submit -> poll(completed) -> download', async () => {
  const srv = await wavespeedServer();
  const ctx = makeCtx(srv.base, { credentials: { apiKey: 'ws-key' } });
  const route = ROUTES.find(r => r.id === 'wavespeed/wan-2.2-animate');
  const file = await tmpFile('idle.png', Buffer.from('PNG'));
  try {
    const url = await providers.wavespeed.upload(ctx, file);
    assert.match(url, /\/dl\/obj\.png$/);
    // PUT must not carry the API key
    const put = srv.requests.find(r => r.method === 'PUT');
    assert.equal(put.headers.authorization, undefined);

    const task = await providers.wavespeed.submit(ctx, route, { imageUrl: url, videoUrl: 'v', options: { resolution: '720p' } });
    assert.equal(task.id, 'ws-1');
    const submitReq = srv.requests.find(r => r.url === '/wavespeed-ai/wan-2.2/animate');
    assert.equal(JSON.parse(submitReq.body).resolution, '720p');
    assert.equal(JSON.parse(submitReq.body).mode, 'animate');

    const state = await providers.wavespeed.poll(ctx, route, task);
    assert.equal(state.state, 'succeeded');
    assert.ok(state.outputUrl.endsWith('/out.mp4'));

    const dest = path.join(file.dir, 'out.mp4');
    const { size } = await providers.wavespeed.download(ctx, state.outputUrl, dest);
    assert.equal(size, 7);
  } finally {
    await srv.close();
    await fs.rm(file.dir, { recursive: true, force: true });
  }
});

test('wavespeed: status mapping covers every documented value', async () => {
  const map = { created: 'queued', processing: 'running', completed: 'succeeded', failed: 'failed', cancelled: 'canceled', timeout: 'failed', deleted: 'failed' };
  for (const [provider, expected] of Object.entries(map)) {
    const srv = await fakeServer((req, res) => json(res, 200, { data: { status: provider, outputs: provider === 'completed' ? ['http://x/o.mp4'] : [] } }));
    const ctx = makeCtx(srv.base, { credentials: { apiKey: 'k' } });
    const st = await providers.wavespeed.poll(ctx, ROUTES.find(r => r.provider === 'wavespeed'), { getUrl: `${srv.base}/r` });
    assert.equal(st.state, expected, `wavespeed ${provider} -> ${expected}`);
    await srv.close();
  }
});

// =====================================================================================
// Replicate
// =====================================================================================

test('replicate: files upload, version-resolved submit, poll(succeeded), delivery download with auth', async () => {
  const srv = await fakeServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/files') return json(res, 201, { urls: { get: `http://${req.headers.host}/f/abc` } });
    if (req.method === 'GET' && req.url === '/models/wan-video/wan-2.2-animate-animation') return json(res, 200, { latest_version: { id: 'VER123' } });
    if (req.method === 'POST' && req.url === '/predictions') {
      const parsed = JSON.parse(body);
      assert.equal(parsed.version, 'wan-video/wan-2.2-animate-animation:VER123');
      return json(res, 201, { id: 'rp-1', status: 'starting', urls: { get: `http://${req.headers.host}/predictions/rp-1`, cancel: `http://${req.headers.host}/predictions/rp-1/cancel` } });
    }
    if (req.url === '/predictions/rp-1') return json(res, 200, { id: 'rp-1', status: 'succeeded', output: `http://${req.headers.host}/delivery/out.mp4` });
    if (req.url === '/delivery/out.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(Buffer.from('REPL')); }
    return json(res, 404, { detail: 'nope' });
  });
  const deliveryHost = new URL(srv.base).host;
  const ctx = makeCtx(srv.base, { credentials: { apiToken: 'r8_secret' }, extra: { deliveryHost } });
  const route = ROUTES.find(r => r.id === 'replicate/wan-2.2-animate-animation');
  const file = await tmpFile('idle.png', Buffer.from('PNG'));
  try {
    const url = await providers.replicate.upload(ctx, file);
    assert.match(url, /\/f\/abc$/);
    const task = await providers.replicate.submit(ctx, route, { imageUrl: url, videoUrl: 'v' });
    assert.equal(task.id, 'rp-1');
    const st = await providers.replicate.poll(ctx, route, task);
    assert.equal(st.state, 'succeeded');
    const dest = path.join(file.dir, 'o.mp4');
    await providers.replicate.download(ctx, st.outputUrl, dest);
    const dl = srv.requests.find(r => r.url === '/delivery/out.mp4');
    assert.equal(dl.headers.authorization, 'Bearer r8_secret', 'delivery host receives the token');
    assert.equal((await fs.readFile(dest)).toString(), 'REPL');
  } finally {
    await srv.close();
    await fs.rm(file.dir, { recursive: true, force: true });
  }
});

test('replicate: status mapping + failed moderation', async () => {
  const cases = [
    ['starting', 'queued'], ['processing', 'running'], ['succeeded', 'succeeded'],
    ['failed', 'failed'], ['canceled', 'canceled'],
  ];
  for (const [status, expected] of cases) {
    const srv = await fakeServer((req, res) => json(res, 200, { status, output: status === 'succeeded' ? 'http://x/o.mp4' : null, error: status === 'failed' ? 'NSFW content detected' : null }));
    const ctx = makeCtx(srv.base, { credentials: { apiToken: 't' } });
    const st = await providers.replicate.poll(ctx, ROUTES.find(r => r.provider === 'replicate'), { getUrl: `${srv.base}/p` });
    assert.equal(st.state, expected);
    if (status === 'failed') assert.equal(st.moderated, true);
    await srv.close();
  }
});

// =====================================================================================
// fal.ai
// =====================================================================================

test('fal: upload, queue submit, poll(COMPLETED) -> response video.url, cancel', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url.startsWith('/v1/serverless/files/file/upload-local')) return json(res, 200, { access_url: `http://${req.headers.host}/media/x.png` });
    if (req.method === 'POST' && req.url === '/fal-ai/kling-video/v3/standard/motion-control') {
      return json(res, 200, { request_id: 'fal-1', status_url: `http://${req.headers.host}/status/fal-1`, response_url: `http://${req.headers.host}/resp/fal-1`, cancel_url: `http://${req.headers.host}/cancel/fal-1` });
    }
    if (req.url === '/status/fal-1') return json(res, 200, { status: 'COMPLETED' });
    if (req.url === '/resp/fal-1') return json(res, 200, { video: { url: `http://${req.headers.host}/media/out.mp4` } });
    if (req.method === 'PUT' && req.url === '/cancel/fal-1') return json(res, 202, { status: 'CANCELLATION_REQUESTED' });
    return json(res, 404, {});
  });
  const ctx = makeCtx(srv.base, { credentials: { apiKey: 'fal-key' } });
  const route = ROUTES.find(r => r.id === 'fal/kling-v3-standard-motion-control');
  const file = await tmpFile('idle.png', Buffer.from('PNG'));
  try {
    const url = await providers.fal.upload(ctx, file);
    assert.match(url, /\/media\/x\.png$/);
    const upReq = srv.requests.find(r => r.url.includes('upload-local'));
    assert.match(upReq.headers.authorization, /^Key /);

    const task = await providers.fal.submit(ctx, route, { imageUrl: url, videoUrl: 'v', orientation: 'image' });
    assert.equal(task.id, 'fal-1');
    const st = await providers.fal.poll(ctx, route, task);
    assert.equal(st.state, 'succeeded');
    assert.ok(st.outputUrl.endsWith('/media/out.mp4'));
    await providers.fal.cancel(ctx, route, task);
    assert.ok(srv.requests.some(r => r.method === 'PUT' && r.url === '/cancel/fal-1'));
  } finally {
    await srv.close();
    await fs.rm(file.dir, { recursive: true, force: true });
  }
});

test('fal: IN_QUEUE/IN_PROGRESS mapping and COMPLETED-with-error', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url === '/queue') return json(res, 200, { status: 'IN_QUEUE' });
    if (req.url === '/prog') return json(res, 200, { status: 'IN_PROGRESS' });
    if (req.url === '/err') return json(res, 200, { status: 'COMPLETED', error: 'blocked', error_type: 'nsfw' });
    return json(res, 404, {});
  });
  const ctx = makeCtx(srv.base, { credentials: { apiKey: 'k' } });
  const route = ROUTES.find(r => r.provider === 'fal');
  assert.equal((await providers.fal.poll(ctx, route, { statusUrl: `${srv.base}/queue` })).state, 'queued');
  assert.equal((await providers.fal.poll(ctx, route, { statusUrl: `${srv.base}/prog` })).state, 'running');
  const errSt = await providers.fal.poll(ctx, route, { statusUrl: `${srv.base}/err`, responseUrl: `${srv.base}/never` });
  assert.equal(errSt.state, 'failed');
  assert.equal(errSt.moderated, true);
  await srv.close();
});

// =====================================================================================
// Higgsfield
// =====================================================================================

test('higgsfield: presigned upload sends all upload_headers, submit, poll(nsfw)=failed', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url === '/files/generate-upload-url') {
      return json(res, 200, { public_url: `http://${req.headers.host}/pub/x.png`, upload_url: `http://${req.headers.host}/put/x`, upload_headers: { 'x-amz-tagging': 'retention=temporary' } });
    }
    if (req.method === 'PUT' && req.url === '/put/x') { res.statusCode = 200; return res.end(); }
    if (req.method === 'POST' && req.url === '/kling-video/v3/motion-control/std') {
      return json(res, 200, { status: 'queued', request_id: 'hf-1', status_url: `http://${req.headers.host}/requests/hf-1/status`, cancel_url: `http://${req.headers.host}/requests/hf-1/cancel` });
    }
    if (req.url === '/requests/hf-1/status') return json(res, 200, { status: 'nsfw', error: 'blocked' });
    return json(res, 404, {});
  });
  const ctx = makeCtx(srv.base, { credentials: { apiKeyId: 'id', apiKeySecret: 'sec' } });
  const route = ROUTES.find(r => r.id === 'higgsfield/kling-v3-motion-control-std');
  const file = await tmpFile('idle.png', Buffer.from('PNG'));
  try {
    const url = await providers.higgsfield.upload(ctx, file);
    assert.match(url, /\/pub\/x\.png$/);
    const put = srv.requests.find(r => r.method === 'PUT');
    assert.equal(put.headers['x-amz-tagging'], 'retention=temporary', 'upload_headers forwarded');
    assert.equal(put.headers.authorization, undefined, 'no HF creds on the presigned URL');

    const genReq = srv.requests.find(r => r.url === '/files/generate-upload-url');
    assert.match(genReq.headers.authorization, /^Key id:sec$/);

    const task = await providers.higgsfield.submit(ctx, route, { imageUrl: url, videoUrl: 'v', orientation: 'image' });
    assert.equal(task.id, 'hf-1');
    const st = await providers.higgsfield.poll(ctx, route, task);
    assert.equal(st.state, 'failed');
    assert.equal(st.moderated, true);
  } finally {
    await srv.close();
    await fs.rm(file.dir, { recursive: true, force: true });
  }
});

test('higgsfield: completed -> video.url', async () => {
  const srv = await fakeServer((req, res) => json(res, 200, { status: 'completed', video: { url: 'http://x/o.mp4' } }));
  const ctx = makeCtx(srv.base, { credentials: { apiKeyId: 'i', apiKeySecret: 's' } });
  const st = await providers.higgsfield.poll(ctx, ROUTES.find(r => r.provider === 'higgsfield'), { statusUrl: `${srv.base}/s` });
  assert.equal(st.state, 'succeeded');
  assert.equal(st.outputUrl, 'http://x/o.mp4');
  await srv.close();
});

// =====================================================================================
// DashScope (Wan direct)
// =====================================================================================

test('dashscope: getPolicy + OSS multipart (file field LAST) -> oss:// URL; async submit; poll', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url.startsWith('/api/v1/uploads')) {
      return json(res, 200, { data: {
        policy: 'POLICY', signature: 'SIG', upload_dir: 'dashscope-instant/xyz', upload_host: `http://${req.headers.host}/oss`,
        oss_access_key_id: 'OSSAK', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
      } });
    }
    if (req.method === 'POST' && req.url === '/oss') { res.statusCode = 200; return res.end(); }
    if (req.method === 'POST' && req.url === '/api/v1/services/aigc/image2video/video-synthesis') {
      return json(res, 200, { output: { task_status: 'PENDING', task_id: 'ds-1' } });
    }
    if (req.url === '/api/v1/tasks/ds-1') {
      return json(res, 200, { output: { task_status: 'SUCCEEDED', results: { video_url: `http://${req.headers.host}/out.mp4` } } });
    }
    return json(res, 404, { code: 'X', message: 'nope' });
  });
  const ctx = makeCtx(srv.base, { credentials: { apiKey: 'ds-key' }, settings: { region: 'intl' } });
  const route = ROUTES.find(r => r.id === 'dashscope/wan2.2-animate-move');
  const file = await tmpFile('idle.png', Buffer.from('PNG'));
  try {
    const url = await providers.dashscope.upload(ctx, file);
    assert.equal(url, 'oss://dashscope-instant/xyz/idle.png');
    // Verify multipart body ordering: `file` disposition must appear after `key`.
    const ossReq = srv.requests.find(r => r.method === 'POST' && r.url === '/oss');
    const bodyStr = ossReq.body.toString('latin1');
    assert.ok(bodyStr.indexOf('name="key"') < bodyStr.indexOf('name="file"'), 'file field must be last');
    assert.ok(bodyStr.includes('name="success_action_status"'));
    // getPolicy carried no oss:// resolve header; submit must.
    const task = await providers.dashscope.submit(ctx, route, { imageUrl: url, videoUrl: 'oss://dashscope-instant/xyz/ref.mp4', options: { mode: 'wan-std' } });
    assert.equal(task.id, 'ds-1');
    const submitReq = srv.requests.find(r => r.url.endsWith('/video-synthesis'));
    assert.equal(submitReq.headers['x-dashscope-async'], 'enable');
    assert.equal(submitReq.headers['x-dashscope-ossresourceresolve'], 'enable');
    assert.equal(JSON.parse(submitReq.body).model, 'wan2.2-animate-move');
    const st = await providers.dashscope.poll(ctx, route, task);
    assert.equal(st.state, 'succeeded');
    assert.ok(st.outputUrl.endsWith('/out.mp4'));
  } finally {
    await srv.close();
    await fs.rm(file.dir, { recursive: true, force: true });
  }
});

test('dashscope: task status mapping', async () => {
  const map = { PENDING: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'canceled', UNKNOWN: 'failed' };
  for (const [provider, expected] of Object.entries(map)) {
    const srv = await fakeServer((req, res) => json(res, 200, { output: { task_status: provider, results: provider === 'SUCCEEDED' ? { video_url: 'http://x/o.mp4' } : undefined, code: 'DataInspectionFailed' } }));
    const ctx = makeCtx(srv.base, { credentials: { apiKey: 'k' }, settings: { region: 'intl' } });
    const st = await providers.dashscope.poll(ctx, ROUTES.find(r => r.provider === 'dashscope'), { id: 'ds-1' });
    assert.equal(st.state, expected, `${provider} -> ${expected}`);
    await srv.close();
  }
});

// =====================================================================================
// Kling direct: JWT structure + signature, upload rules, submit/poll
// =====================================================================================

test('kling: JWT has the right header/claims and a valid HS256 signature', () => {
  const now = 1_000_000;
  const token = providers.kling.signJwt('AK', 'SK', now);
  const [h, p, sig] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64'));
  const payload = JSON.parse(Buffer.from(p, 'base64'));
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
  assert.equal(payload.iss, 'AK');
  assert.equal(payload.exp, now + 1800);
  assert.equal(payload.nbf, now - 5);
  const expected = crypto.createHmac('sha256', 'SK').update(`${h}.${p}`).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sig, expected, 'signature must verify against the secret key');
});

test('kling: image upload -> data URI; video upload -> needs_public_url', async () => {
  const ctx = makeCtx('https://api-singapore.klingai.com', { credentials: { accessKey: 'AK', secretKey: 'SK' } });
  const img = await tmpFile('idle.png', Buffer.from('PNGBYTES'));
  const vid = await tmpFile('ref.mp4', Buffer.from('MP4BYTES'));
  try {
    const dataUri = await providers.kling.upload(ctx, img);
    assert.match(dataUri, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(dataUri.split(',')[1], 'base64').toString(), 'PNGBYTES');
    await assert.rejects(
      providers.kling.upload(ctx, vid),
      err => err instanceof ProviderError && err.code === 'needs_public_url'
    );
  } finally {
    await fs.rm(img.dir, { recursive: true, force: true });
    await fs.rm(vid.dir, { recursive: true, force: true });
  }
});

test('kling: submit sends a JWT bearer, maps code!=0 to error, poll succeed extracts url', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos/motion-control') {
      // JWT regime: Authorization must be a Bearer token with 3 dot-parts.
      const auth = req.headers.authorization || '';
      assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      return json(res, 200, { code: 0, data: { task_id: 'kl-1' } });
    }
    if (req.url === '/v1/videos/motion-control/kl-1') {
      return json(res, 200, { code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: `http://${req.headers.host}/o.mp4` }] } } });
    }
    if (req.url === '/v1/videos/motion-control/err') return json(res, 200, { code: 1201, message: 'bad param' });
    return json(res, 404, {});
  });
  const ctx = makeCtx(srv.base, { credentials: { accessKey: 'AK', secretKey: 'SK' } });
  const route = ROUTES.find(r => r.id === 'kling/v3-motion-control');
  try {
    const task = await providers.kling.submit(ctx, route, { imageUrl: 'data:...', videoUrl: 'https://pub/ref.mp4', orientation: 'image' });
    assert.equal(task.id, 'kl-1');
    const st = await providers.kling.poll(ctx, route, task);
    assert.equal(st.state, 'succeeded');
    assert.ok(st.outputUrl.endsWith('/o.mp4'));
    // business-error code on poll -> failed (non-retryable code 1201)
    const errSt = await providers.kling.poll(ctx, route, { id: 'err' });
    assert.equal(errSt.state, 'failed');
  } finally {
    await srv.close();
  }
});

test('kling: static API key regime sends the key verbatim as the bearer', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url === '/v1/videos/motion-control') {
      assert.equal(req.headers.authorization, 'Bearer static-key-123');
      return json(res, 200, { code: 0, data: { task_id: 'kl-2' } });
    }
    return json(res, 404, {});
  });
  const ctx = makeCtx(srv.base, { credentials: { apiKey: 'static-key-123' } });
  const route = ROUTES.find(r => r.id === 'kling/v3-motion-control');
  try {
    const task = await providers.kling.submit(ctx, route, { imageUrl: 'i', videoUrl: 'https://pub/v.mp4', orientation: 'image' });
    assert.equal(task.id, 'kl-2');
  } finally {
    await srv.close();
  }
});

// =====================================================================================
// Adapter meta invariants + no-secrets-in-errors
// =====================================================================================

test('every adapter exposes the required interface and meta', () => {
  for (const [id, adapter] of Object.entries(providers)) {
    assert.ok(adapter.meta && adapter.meta.id === id, `${id} meta.id matches key`);
    assert.equal(typeof adapter.upload, 'function', `${id}.upload`);
    assert.equal(typeof adapter.submit, 'function', `${id}.submit`);
    assert.equal(typeof adapter.poll, 'function', `${id}.poll`);
    assert.equal(typeof adapter.download, 'function', `${id}.download`);
    assert.ok(adapter.cancel === null || typeof adapter.cancel === 'function', `${id}.cancel`);
    assert.ok(adapter.test === null || typeof adapter.test === 'function', `${id}.test`);
    assert.ok(Array.isArray(adapter.meta.credentialSets) && adapter.meta.credentialSets.length, `${id} credentialSets`);
  }
});

test('adapter errors never contain the API key', async () => {
  // A 401 with the key echoed back must be scrubbed before it reaches a ProviderError.
  const srv = await fakeServer((req, res) => json(res, 401, { message: 'token Bearer-supersecretkey1234567890 rejected' }));
  const ctx = makeCtx(srv.base, { credentials: { apiKey: 'supersecretkey1234567890' } });
  try {
    const err = await providers.wavespeed.submit(ctx, ROUTES.find(r => r.provider === 'wavespeed'), { imageUrl: 'i', videoUrl: 'v' }).catch(e => e);
    assert.ok(err instanceof ProviderError);
    assert.doesNotMatch(err.message, /supersecretkey1234567890/);
  } finally {
    await srv.close();
  }
});
