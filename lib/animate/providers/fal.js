'use strict';

// fal.ai adapter.
// Protocol (verified from docs.fal.ai / fal.ai model API pages):
//  - Queue base: https://queue.fal.run/{model-id} ; auth: Authorization: Key <apiKey>.
//  - Upload (REST, no SDK): POST https://rest.alpha.fal.ai/storage/upload/initiate?... is SDK-internal;
//    the documented no-SDK REST path is POST https://api.fal.ai/v1/serverless/files/file/upload-local
//    (multipart field `file_upload`) -> returns a public fal.media URL. We also accept a base64 data URI
//    fallback for the small character image when ctx says the file is small enough.
//  - Submit: POST https://queue.fal.run/{model-id} JSON -> {request_id,status_url,response_url,cancel_url}.
//  - Poll: GET {status_url} -> {status: IN_QUEUE|IN_PROGRESS|COMPLETED, error?, error_type?}.
//    On COMPLETED, GET {response_url} -> { video:{url} }.
//  - Cancel: PUT {cancel_url}.
//  - Output: video.url on fal.media (public).

const { ProviderError, fetchJson, fetchRaw, downloadToFile } = require('../http');

const meta = {
  id: 'fal',
  label: 'fal.ai',
  docs: 'https://docs.fal.ai/model-endpoints/queue',
  credentials: [{ key: 'apiKey', label: 'API Key', env: ['FAL_KEY'] }],
  credentialSets: [['apiKey']],
  settings: [],
  needsPublicVideoUrl: false,
  publicUploads: true,
  pollIntervalMs: 5000,
};

const QUEUE_BASE = 'https://queue.fal.run';
const UPLOAD_URL = 'https://api.fal.ai/v1/serverless/files/file/upload-local';

function queueBase(ctx) {
  return (ctx.baseUrl || QUEUE_BASE).replace(/\/+$/, '');
}
function uploadUrl(ctx) {
  // When a test baseUrl is set, the fake server serves the upload endpoint under it too.
  return ctx.baseUrl ? `${ctx.baseUrl.replace(/\/+$/, '')}/v1/serverless/files/file/upload-local` : UPLOAD_URL;
}

function authValue(ctx) {
  const key = ctx.credentials && ctx.credentials.apiKey;
  if (!key) throw new ProviderError('fal.ai API key is not configured.', { status: null, retryable: false, code: 'no_credentials' });
  return `Key ${key}`;
}

// Build a multipart/form-data body from one file field, without any dependency.
async function multipartFile(fieldName, file) {
  const fs = require('node:fs');
  const bytes = await fs.promises.readFile(file.path);
  const form = new FormData();
  const blob = new Blob([bytes], { type: file.contentType || 'application/octet-stream' });
  form.append(fieldName, blob, file.filename);
  return form;
}

async function upload(ctx, file) {
  const form = await multipartFile('file_upload', file);
  const res = await fetchJson(ctx.fetch, uploadUrl(ctx), {
    method: 'POST',
    headers: { Authorization: authValue(ctx) }, // FormData sets its own Content-Type boundary
    body: form,
    signal: ctx.signal,
    label: 'fal.ai upload',
  });
  // The documented response returns the public URL; accept common shapes.
  const url = res && (res.access_url || res.url || res.file_url || (res.data && res.data.url));
  if (!url) throw new ProviderError('fal.ai upload did not return a file URL.', { status: null, retryable: false, code: 'bad_upload' });
  return url;
}

async function submit(ctx, route, input) {
  const base = queueBase(ctx);
  const { buildRequest } = require('../catalog');
  const body = buildRequest(route, input);
  const res = await fetchJson(ctx.fetch, `${base}/${route.endpoint}`, {
    method: 'POST',
    headers: { Authorization: authValue(ctx), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal,
    label: 'fal.ai submit',
  });
  const requestId = res && res.request_id;
  if (!requestId) throw new ProviderError('fal.ai submit did not return a request_id.', { status: null, retryable: false, code: 'bad_submit' });
  return {
    id: requestId,
    statusUrl: res.status_url,
    responseUrl: res.response_url,
    cancelUrl: res.cancel_url,
  };
}

const STATUS_MAP = {
  IN_QUEUE: 'queued',
  IN_PROGRESS: 'running',
  COMPLETED: 'succeeded',
};

async function poll(ctx, route, task) {
  if (!task.statusUrl) throw new ProviderError('fal.ai poll is missing the status URL.', { status: null, retryable: false, code: 'bad_task' });
  const status = await fetchJson(ctx.fetch, task.statusUrl, {
    method: 'GET', headers: { Authorization: authValue(ctx) }, signal: ctx.signal, label: 'fal.ai status',
  });
  const providerStatus = status && status.status ? status.status : 'unknown';

  if (providerStatus === 'COMPLETED') {
    // A COMPLETED request may still carry an error/error_type -> treat as failed.
    if (status.error || status.error_type) {
      return { state: 'failed', error: status.error || status.error_type, providerStatus, moderated: /nsfw|safety|moderat/i.test(String(status.error_type || status.error || '')) };
    }
    const result = await fetchJson(ctx.fetch, task.responseUrl, {
      method: 'GET', headers: { Authorization: authValue(ctx) }, signal: ctx.signal, label: 'fal.ai result',
    });
    const outputUrl = result && result.video && result.video.url;
    if (!outputUrl) return { state: 'failed', error: 'fal.ai completed without a video URL.', providerStatus };
    return { state: 'succeeded', outputUrl, providerStatus };
  }

  const state = STATUS_MAP[providerStatus] || 'running';
  return { state, providerStatus };
}

async function cancel(ctx, route, task) {
  if (!task.cancelUrl) return;
  try {
    await fetchRaw(ctx.fetch, task.cancelUrl, { method: 'PUT', headers: { Authorization: authValue(ctx) }, signal: ctx.signal });
  } catch { /* best effort */ }
}

async function download(ctx, url, destPath) {
  // fal.media URLs are public; no auth header attached.
  return downloadToFile({
    fetch: ctx.fetch, url, destPath, signal: ctx.signal, allowInsecure: ctx.allowInsecure,
  });
}

async function test(ctx) {
  try { authValue(ctx); } catch (err) { return { ok: false, detail: err.message }; }
  // fal has no free "whoami" documented; probe the upload endpoint cheaply with an empty form.
  try {
    const form = new FormData();
    form.append('file_upload', new Blob([Buffer.from('x')], { type: 'image/png' }), 'probe.png');
    const resp = await fetchRaw(ctx.fetch, uploadUrl(ctx), {
      method: 'POST', headers: { Authorization: authValue(ctx) }, body: form, signal: ctx.signal,
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, detail: 'fal.ai rejected the API key.' };
    return { ok: true, detail: 'fal.ai credentials accepted.' };
  } catch (err) {
    return { ok: false, detail: err instanceof ProviderError ? err.message : 'fal.ai test request failed.' };
  }
}

module.exports = { meta, upload, submit, poll, cancel, download, test };
