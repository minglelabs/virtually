'use strict';

// WaveSpeed AI adapter.
// Protocol (verified from wavespeed.ai/docs):
//  - Base: https://api.wavespeed.ai/api/v3 ; auth: Authorization: Bearer <apiKey>.
//  - Upload: POST /media/uploads {filename,size,content_type} -> {upload:{method,url,headers},download_url};
//    PUT bytes to the signed url with NO Authorization header; use download_url as the model input.
//  - Submit: POST /{endpoint} JSON body -> {data:{id, urls:{get}}}.
//  - Poll: GET /predictions/{id}/result -> {data:{status, outputs:[url], error}}.
//    status: created|processing|completed|failed|cancelled|timeout|deleted.
//  - Output: data.outputs[0]. URLs public (publicUploads:true) for ~7 days.
//  - Cancel: no documented cancel endpoint -> cancel is null (best effort handled by pipeline abort).

const { ProviderError, fetchJson, fetchRaw, downloadToFile } = require('../http');

const meta = {
  id: 'wavespeed',
  label: 'WaveSpeed',
  docs: 'https://wavespeed.ai/docs',
  credentials: [{ key: 'apiKey', label: 'API Key', env: ['WAVESPEED_API_KEY'] }],
  credentialSets: [['apiKey']],
  settings: [],
  needsPublicVideoUrl: false,
  publicUploads: true,
  pollIntervalMs: 5000,
};

const DEFAULT_BASE = 'https://api.wavespeed.ai/api/v3';

function apiBase(ctx) {
  return (ctx.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

function authHeaders(ctx) {
  const key = ctx.credentials && ctx.credentials.apiKey;
  if (!key) throw new ProviderError('WaveSpeed API key is not configured.', { status: null, retryable: false, code: 'no_credentials' });
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function upload(ctx, file) {
  const base = apiBase(ctx);
  const ticket = await fetchJson(ctx.fetch, `${base}/media/uploads`, {
    method: 'POST',
    headers: authHeaders(ctx),
    body: JSON.stringify({ filename: file.filename, size: file.size, content_type: file.contentType }),
    signal: ctx.signal,
    label: 'WaveSpeed upload ticket',
  });
  const data = ticket && ticket.data;
  const put = data && data.upload;
  const downloadUrl = data && data.download_url;
  if (!put || !put.url || !downloadUrl) {
    throw new ProviderError('WaveSpeed upload ticket was missing the signed URL.', { status: null, retryable: false, code: 'bad_upload_ticket' });
  }
  // PUT the bytes to the opaque signed URL. NO Authorization header (the URL is the credential).
  const fs = require('node:fs');
  const bytes = await fs.promises.readFile(file.path);
  const putHeaders = { ...(put.headers || {}) };
  if (!putHeaders['Content-Type'] && !putHeaders['content-type']) putHeaders['Content-Type'] = file.contentType || 'application/octet-stream';
  const putResp = await fetchRaw(ctx.fetch, put.url, {
    method: put.method || 'PUT',
    headers: putHeaders,
    body: bytes,
    signal: ctx.signal,
  });
  if (!putResp.ok) {
    throw new ProviderError(`WaveSpeed upload PUT failed with HTTP ${putResp.status}.`, {
      status: putResp.status, retryable: putResp.status >= 500, code: 'upload_put',
    });
  }
  return downloadUrl;
}

async function submit(ctx, route, input) {
  const base = apiBase(ctx);
  const { buildRequest } = require('../catalog');
  const body = buildRequest(route, input);
  const res = await fetchJson(ctx.fetch, `${base}/${route.endpoint}`, {
    method: 'POST',
    headers: authHeaders(ctx),
    body: JSON.stringify(body),
    signal: ctx.signal,
    label: 'WaveSpeed submit',
  });
  const data = res && res.data;
  const id = data && data.id;
  if (!id) throw new ProviderError('WaveSpeed submit did not return a prediction id.', { status: null, retryable: false, code: 'bad_submit' });
  return { id, getUrl: (data.urls && data.urls.get) || `${base}/predictions/${id}/result` };
}

const STATUS_MAP = {
  created: 'queued',
  processing: 'running',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'canceled',
  timeout: 'failed',
  deleted: 'failed',
};

async function poll(ctx, route, task) {
  const base = apiBase(ctx);
  const url = task.getUrl || `${base}/predictions/${task.id}/result`;
  const res = await fetchJson(ctx.fetch, url, {
    method: 'GET', headers: authHeaders(ctx), signal: ctx.signal, label: 'WaveSpeed poll',
  });
  const data = res && res.data ? res.data : {};
  const providerStatus = data.status || 'unknown';
  const state = STATUS_MAP[providerStatus] || 'running';
  const outputUrl = Array.isArray(data.outputs) && data.outputs.length ? data.outputs[0] : undefined;
  return {
    state,
    outputUrl: state === 'succeeded' ? outputUrl : undefined,
    error: data.error || undefined,
    providerStatus,
  };
}

async function download(ctx, url, destPath) {
  // WaveSpeed output URLs are public; do not attach the API key to them.
  return downloadToFile({
    fetch: ctx.fetch, url, destPath, signal: ctx.signal, allowInsecure: ctx.allowInsecure,
  });
}

async function test(ctx) {
  // Cheap, documented, side-effect-free credential check:
  // GET /api/v3/balance -> { code: 200, data: { balance } } (https://wavespeed.ai/docs/check-balance).
  try {
    authHeaders(ctx);
  } catch (err) {
    return { ok: false, detail: err.message };
  }
  const base = apiBase(ctx);
  try {
    const resp = await fetchRaw(ctx.fetch, `${base}/balance`, {
      method: 'GET',
      headers: authHeaders(ctx),
      signal: ctx.signal,
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, detail: 'WaveSpeed rejected the API key.' };
    if (!resp.ok) return { ok: false, detail: `WaveSpeed balance check returned HTTP ${resp.status}.` };
    let balance = null;
    try {
      const body = await resp.json();
      balance = body && body.data && Number.isFinite(body.data.balance) ? body.data.balance : null;
    } catch { /* balance is optional in the reply */ }
    return { ok: true, detail: balance == null ? 'WaveSpeed credentials accepted.' : `WaveSpeed credentials accepted (balance $${balance}).` };
  } catch (err) {
    return { ok: false, detail: err instanceof ProviderError ? err.message : 'WaveSpeed test request failed.' };
  }
}

// Background removal (lib/animate/background-ai.js; only when the user picked it):
//   image: POST /wavespeed-ai/image-background-remover { image: <url> } -> a transparent PNG, $0.01 per image
//   video: POST /bria/fibo/video-background-remover { video: <url>, background_color: 'Transparent', ... }
//          -> a WebM (VP9) with its own alpha, $0.05 per second (2.97 s billed $0.15, 2026-10-02)
// (https://wavespeed.ai/docs/docs-api/wavespeed-ai/image-background-remover,
//  https://wavespeed.ai/models/bria/fibo/video-background-remover).
// Until 2026-10-02 the video remover was wavespeed-ai/video-background-remover ($0.01 per second): it has
// no transparent output, so its answer was keyed here, which left hard edges and colour patches.
// file: { path, filename, size, contentType }. The answer is written to destPath.
const BACKGROUND_REMOVERS = {
  image: { endpoint: 'wavespeed-ai/image-background-remover', field: 'image', timeoutMs: 90 * 1000, pollMs: 1500 },
  video: {
    endpoint: 'bria/fibo/video-background-remover', field: 'video', timeoutMs: 15 * 60 * 1000, pollMs: 4000,
    body: { background_color: 'Transparent', output_container_and_codec: 'webm_vp9', preserve_audio: false },
  },
};

async function removeBackground(ctx, file, destPath, kind = 'image') {
  const remover = BACKGROUND_REMOVERS[kind];
  const base = apiBase(ctx);
  const source = await upload(ctx, file);
  const res = await fetchJson(ctx.fetch, `${base}/${remover.endpoint}`, {
    method: 'POST',
    headers: authHeaders(ctx),
    body: JSON.stringify({ [remover.field]: source, ...(remover.body || {}) }),
    signal: ctx.signal,
    label: 'WaveSpeed background remover',
  });
  const data = res && res.data ? res.data : {};
  let outputUrl = data.status === 'completed' && Array.isArray(data.outputs) && data.outputs.length ? data.outputs[0] : null;
  if (!outputUrl) {
    if (!data.id) throw new ProviderError('WaveSpeed background remover did not return a prediction id.', { status: null, retryable: false, code: 'bad_submit' });
    const task = { id: data.id, getUrl: (data.urls && data.urls.get) || null };
    const deadline = Date.now() + (ctx.timeoutMs || remover.timeoutMs);
    for (;;) {
      const polled = await poll(ctx, null, task);
      if (polled.state === 'succeeded' && polled.outputUrl) { outputUrl = polled.outputUrl; break; }
      if (polled.state === 'failed' || polled.state === 'canceled') {
        throw new ProviderError(`WaveSpeed background remover failed: ${polled.error || polled.providerStatus}`, { status: null, retryable: false, code: 'generation_failed' });
      }
      if (Date.now() > deadline) throw new ProviderError('WaveSpeed background remover timed out.', { status: null, retryable: true, code: 'timeout' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ctx.pollMs || remover.pollMs);
        if (ctx.signal) ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Canceled.'), { name: 'AbortError' })); }, { once: true });
      });
    }
  }
  await download(ctx, outputUrl, destPath);
}

module.exports = { meta, upload, submit, poll, cancel: null, download, test, removeBackground };
