'use strict';

// Replicate adapter.
// Protocol (verified from replicate.com/docs/reference/http; Files API shape is SDK-wrapped and
// marked UNVERIFIED in docs/animate-providers.md):
//  - Base: https://api.replicate.com/v1 ; auth: Authorization: Bearer <apiToken>.
//  - Upload: POST /files (multipart field `content`) -> { urls: { get } } (the hosted file URL).
//    TTL is account-dependent; download promptly. (UNVERIFIED exact response — accept common shapes.)
//  - Submit: community models -> POST /predictions {version:"owner/name:VERSION", input};
//    official models (owner/name only) -> POST /models/{owner}/{name}/predictions {input}.
//    We resolve the community version id via GET /models/{owner}/{name} -> latest_version.id.
//  - Poll: GET /predictions/{id} -> {status: starting|processing|succeeded|failed|canceled, output, error}.
//    output is a single URI string (or array — take first).
//  - Cancel: POST /predictions/{id}/cancel.
//  - Output files served from replicate.delivery and need the Authorization header to fetch.
//  - Data (input/output) auto-removed ~1h after an API prediction; download immediately.

const { ProviderError, fetchJson, fetchRaw, downloadToFile } = require('../http');

const meta = {
  id: 'replicate',
  label: 'Replicate',
  docs: 'https://replicate.com/docs/reference/http',
  credentials: [{ key: 'apiToken', label: 'API Token', env: ['REPLICATE_API_TOKEN'] }],
  credentialSets: [['apiToken']],
  settings: [],
  needsPublicVideoUrl: false,
  publicUploads: false,
  pollIntervalMs: 5000,
};

const DEFAULT_BASE = 'https://api.replicate.com/v1';
const DELIVERY_HOST = 'replicate.delivery';

function apiBase(ctx) {
  return (ctx.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

function authValue(ctx) {
  const token = ctx.credentials && ctx.credentials.apiToken;
  if (!token) throw new ProviderError('Replicate API token is not configured.', { status: null, retryable: false, code: 'no_credentials' });
  return `Bearer ${token}`;
}

async function upload(ctx, file) {
  const base = apiBase(ctx);
  const fs = require('node:fs');
  const bytes = await fs.promises.readFile(file.path);
  const form = new FormData();
  form.append('content', new Blob([bytes], { type: file.contentType || 'application/octet-stream' }), file.filename);
  const res = await fetchJson(ctx.fetch, `${base}/files`, {
    method: 'POST',
    headers: { Authorization: authValue(ctx) },
    body: form,
    signal: ctx.signal,
    label: 'Replicate file upload',
    okStatuses: [200, 201],
  });
  const url = res && ((res.urls && res.urls.get) || res.url || res.download_url);
  if (!url) throw new ProviderError('Replicate upload did not return a file URL.', { status: null, retryable: false, code: 'bad_upload' });
  return url;
}

// endpoint = "owner/name". Community models need a version; official models can run without one.
async function resolveVersion(ctx, endpoint) {
  const base = apiBase(ctx);
  const model = await fetchJson(ctx.fetch, `${base}/models/${endpoint}`, {
    method: 'GET', headers: { Authorization: authValue(ctx) }, signal: ctx.signal, label: 'Replicate model lookup',
  });
  const version = model && model.latest_version && model.latest_version.id;
  return version || null;
}

async function submit(ctx, route, input) {
  const base = apiBase(ctx);
  const { buildRequest } = require('../catalog');
  const inputBody = buildRequest(route, input);

  // Try community-model flow (needs a version). If the model has no versions, fall back to
  // the official-model endpoint.
  let version = null;
  try {
    version = await resolveVersion(ctx, route.endpoint);
  } catch (err) {
    if (err instanceof ProviderError && err.status && err.status < 500 && err.status !== 429) {
      // model lookup 4xx -> proceed to official-model attempt
      version = null;
    } else {
      throw err;
    }
  }

  let res;
  if (version) {
    res = await fetchJson(ctx.fetch, `${base}/predictions`, {
      method: 'POST',
      headers: { Authorization: authValue(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: `${route.endpoint}:${version}`, input: inputBody }),
      signal: ctx.signal,
      label: 'Replicate submit',
      okStatuses: [200, 201],
    });
  } else {
    res = await fetchJson(ctx.fetch, `${base}/models/${route.endpoint}/predictions`, {
      method: 'POST',
      headers: { Authorization: authValue(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: inputBody }),
      signal: ctx.signal,
      label: 'Replicate submit',
      okStatuses: [200, 201],
    });
  }
  const id = res && res.id;
  if (!id) throw new ProviderError('Replicate submit did not return a prediction id.', { status: null, retryable: false, code: 'bad_submit' });
  const getUrl = (res.urls && res.urls.get) || `${base}/predictions/${id}`;
  const cancelUrl = (res.urls && res.urls.cancel) || `${base}/predictions/${id}/cancel`;
  return { id, getUrl, cancelUrl };
}

const STATUS_MAP = {
  starting: 'queued',
  processing: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

function extractOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length) {
    const last = output[output.length - 1];
    if (typeof last === 'string') return last;
  }
  if (output && typeof output === 'object' && typeof output.url === 'string') return output.url;
  return undefined;
}

async function poll(ctx, route, task) {
  const base = apiBase(ctx);
  const url = task.getUrl || `${base}/predictions/${task.id}`;
  const res = await fetchJson(ctx.fetch, url, {
    method: 'GET', headers: { Authorization: authValue(ctx) }, signal: ctx.signal, label: 'Replicate poll',
  });
  const providerStatus = res && res.status ? res.status : 'unknown';
  const state = STATUS_MAP[providerStatus] || 'running';
  if (state === 'succeeded') {
    const outputUrl = extractOutput(res.output);
    if (!outputUrl) return { state: 'failed', error: 'Replicate succeeded without an output URL (it may have been auto-removed).', providerStatus };
    return { state: 'succeeded', outputUrl, providerStatus };
  }
  const moderated = state === 'failed' && /nsfw|safety|moderat|sensitive/i.test(String(res.error || ''));
  return { state, error: res.error || undefined, providerStatus, moderated };
}

async function cancel(ctx, route, task) {
  const base = apiBase(ctx);
  const url = task.cancelUrl || `${base}/predictions/${task.id}/cancel`;
  try {
    await fetchRaw(ctx.fetch, url, { method: 'POST', headers: { Authorization: authValue(ctx) }, signal: ctx.signal });
  } catch { /* best effort */ }
}

async function download(ctx, url, destPath) {
  // replicate.delivery output requires the Authorization header; scope it to that host only.
  return downloadToFile({
    fetch: ctx.fetch, url, destPath, signal: ctx.signal, allowInsecure: ctx.allowInsecure,
    auth: { header: 'Authorization', value: authValue(ctx), host: (ctx.deliveryHost || DELIVERY_HOST) },
  });
}

async function test(ctx) {
  try { authValue(ctx); } catch (err) { return { ok: false, detail: err.message }; }
  const base = apiBase(ctx);
  try {
    const resp = await fetchRaw(ctx.fetch, `${base}/account`, {
      method: 'GET', headers: { Authorization: authValue(ctx) }, signal: ctx.signal,
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, detail: 'Replicate rejected the API token.' };
    if (!resp.ok) return { ok: false, detail: `Replicate account check returned HTTP ${resp.status}.` };
    return { ok: true, detail: 'Replicate credentials accepted.' };
  } catch (err) {
    return { ok: false, detail: err instanceof ProviderError ? err.message : 'Replicate test request failed.' };
  }
}

module.exports = { meta, upload, submit, poll, cancel, download, test };
