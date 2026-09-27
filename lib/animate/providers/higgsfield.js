'use strict';

// Higgsfield adapter.
// Protocol (verified from docs.higgsfield.ai):
//  - Base: https://api.higgsfield.ai ; auth: Authorization: Key <apiKeyId>:<apiKeySecret>.
//  - Upload: POST /files/generate-upload-url {content_type} -> {public_url, upload_url, upload_headers};
//    PUT bytes to upload_url sending EVERY header in upload_headers (e.g. x-amz-tagging); NO Higgsfield
//    credentials on the presigned URL. Use public_url as image_url/video_url.
//  - Submit: POST /{endpoint} JSON -> {status:"queued", request_id, status_url, cancel_url}.
//  - Poll: GET {status_url} -> terminal completed|failed|nsfw|canceled; completed -> {video:{url}}.
//  - Cancel: POST {cancel_url}.
//  - Errors: FastAPI {"detail":...}; 401 invalid creds, 403 insufficient credits, 423/503 model blocked.

const { ProviderError, fetchJson, fetchRaw, downloadToFile } = require('../http');

const meta = {
  id: 'higgsfield',
  label: 'Higgsfield',
  docs: 'https://docs.higgsfield.ai',
  credentials: [
    { key: 'apiKeyId', label: 'API Key ID', env: ['HIGGSFIELD_API_KEY_ID', 'HF_API_KEY_ID'] },
    { key: 'apiKeySecret', label: 'API Key Secret', env: ['HIGGSFIELD_API_KEY_SECRET', 'HF_API_KEY_SECRET'] },
  ],
  credentialSets: [['apiKeyId', 'apiKeySecret']],
  settings: [],
  needsPublicVideoUrl: false,
  publicUploads: true,
  pollIntervalMs: 5000,
};

const DEFAULT_BASE = 'https://api.higgsfield.ai';

function apiBase(ctx) {
  return (ctx.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

function authValue(ctx) {
  const id = ctx.credentials && ctx.credentials.apiKeyId;
  const secret = ctx.credentials && ctx.credentials.apiKeySecret;
  if (!id || !secret) throw new ProviderError('Higgsfield API key pair is not configured.', { status: null, retryable: false, code: 'no_credentials' });
  return `Key ${id}:${secret}`;
}

async function upload(ctx, file) {
  const base = apiBase(ctx);
  const ticket = await fetchJson(ctx.fetch, `${base}/files/generate-upload-url`, {
    method: 'POST',
    headers: { Authorization: authValue(ctx), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: file.contentType }),
    signal: ctx.signal,
    label: 'Higgsfield upload URL',
  });
  const uploadUrl = ticket && ticket.upload_url;
  const publicUrl = ticket && ticket.public_url;
  if (!uploadUrl || !publicUrl) throw new ProviderError('Higgsfield upload URL response was incomplete.', { status: null, retryable: false, code: 'bad_upload_ticket' });

  const fs = require('node:fs');
  const bytes = await fs.promises.readFile(file.path);
  // Send EVERY header the ticket returned; add Content-Type if the ticket did not.
  const headers = { ...(ticket.upload_headers || {}) };
  if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = file.contentType || 'application/octet-stream';
  }
  const putResp = await fetchRaw(ctx.fetch, uploadUrl, { method: 'PUT', headers, body: bytes, signal: ctx.signal });
  if (!putResp.ok) {
    throw new ProviderError(`Higgsfield upload PUT failed with HTTP ${putResp.status}.`, {
      status: putResp.status, retryable: putResp.status >= 500, code: 'upload_put',
    });
  }
  return publicUrl;
}

async function submit(ctx, route, input) {
  const base = apiBase(ctx);
  const { buildRequest } = require('../catalog');
  const body = buildRequest(route, input);
  const res = await fetchJson(ctx.fetch, `${base}/${route.endpoint}`, {
    method: 'POST',
    headers: { Authorization: authValue(ctx), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal,
    label: 'Higgsfield submit',
    okStatuses: [200, 201, 202],
  });
  const requestId = res && res.request_id;
  const statusUrl = res && res.status_url;
  if (!requestId || !statusUrl) throw new ProviderError('Higgsfield submit did not return a request id/status URL.', { status: null, retryable: false, code: 'bad_submit' });
  return { id: requestId, statusUrl, cancelUrl: res.cancel_url };
}

const STATUS_MAP = {
  queued: 'queued',
  in_progress: 'running',
  processing: 'running',
  completed: 'succeeded',
  failed: 'failed',
  nsfw: 'failed',
  canceled: 'canceled',
  cancelled: 'canceled',
};

async function poll(ctx, route, task) {
  if (!task.statusUrl) throw new ProviderError('Higgsfield poll is missing the status URL.', { status: null, retryable: false, code: 'bad_task' });
  const res = await fetchJson(ctx.fetch, task.statusUrl, {
    method: 'GET', headers: { Authorization: authValue(ctx) }, signal: ctx.signal, label: 'Higgsfield status',
  });
  const providerStatus = res && res.status ? res.status : 'unknown';
  const state = STATUS_MAP[providerStatus] || 'running';
  if (state === 'succeeded') {
    const outputUrl = res.video && res.video.url;
    if (!outputUrl) return { state: 'failed', error: 'Higgsfield completed without a video URL.', providerStatus };
    return { state: 'succeeded', outputUrl, providerStatus };
  }
  return {
    state,
    error: res.error || undefined,
    providerStatus,
    moderated: providerStatus === 'nsfw',
  };
}

async function cancel(ctx, route, task) {
  if (!task.cancelUrl) return;
  try {
    await fetchRaw(ctx.fetch, task.cancelUrl, { method: 'POST', headers: { Authorization: authValue(ctx) }, signal: ctx.signal });
  } catch { /* best effort */ }
}

async function download(ctx, url, destPath) {
  // Higgsfield output is a public URL; no auth header attached.
  return downloadToFile({
    fetch: ctx.fetch, url, destPath, signal: ctx.signal, allowInsecure: ctx.allowInsecure,
  });
}

async function test(ctx) {
  try { authValue(ctx); } catch (err) { return { ok: false, detail: err.message }; }
  const base = apiBase(ctx);
  // Cheap check: request an upload URL. 401 => bad creds.
  try {
    const resp = await fetchRaw(ctx.fetch, `${base}/files/generate-upload-url`, {
      method: 'POST',
      headers: { Authorization: authValue(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'image/png' }),
      signal: ctx.signal,
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, detail: 'Higgsfield rejected the API key.' };
    return { ok: true, detail: 'Higgsfield credentials accepted.' };
  } catch (err) {
    return { ok: false, detail: err instanceof ProviderError ? err.message : 'Higgsfield test request failed.' };
  }
}

module.exports = { meta, upload, submit, poll, cancel, download, test };
