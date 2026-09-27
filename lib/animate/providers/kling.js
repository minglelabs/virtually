'use strict';

// Kling AI direct developer API adapter.
// Protocol (from research; several items UNVERIFIED — see docs/animate-providers.md):
//  - Base by region: global -> https://api-singapore.klingai.com ; cn -> https://api-beijing.klingai.com.
//  - Auth (TWO regimes, both supported):
//    * Access/Secret JWT: HS256 over { iss: accessKey, exp: now+1800, nbf: now-5 }, header
//      { alg:HS256, typ:JWT }. Sent as Authorization: Bearer <jwt>. (verified signing mechanics)
//    * Static API key: Authorization: Bearer <apiKey> (newer "path-per-model" standard).
//    We prefer the API key when configured, else mint a JWT from the access/secret pair.
//  - Image input: https URL OR base64 data URI (<=~10 MB) -> upload() returns a data URI.
//  - Video input: URL only, NO upload API -> upload() throws ProviderError{code:'needs_public_url'}
//    for videos, so the pipeline routes the video through the media relay.
//  - Submit: POST /v1/videos/motion-control (path segment UNVERIFIED) JSON with model_name, image,
//    video, mode, character_orientation, keep_original_sound -> {code, data:{task_id}}.
//  - Poll: GET /v1/videos/motion-control/{task_id} -> {code, data:{task_status:
//    submitted|processing|succeed|failed, task_result:{videos:[{url}]}}}.
//  - Output URLs valid ~30 days.

const crypto = require('node:crypto');
const { ProviderError, fetchJson, downloadToFile } = require('../http');

const meta = {
  id: 'kling',
  label: 'Kling AI (직접)',
  docs: 'https://app.klingai.com/global/dev/document-api',
  credentials: [
    { key: 'accessKey', label: 'Access Key', env: ['KLING_ACCESS_KEY'] },
    { key: 'secretKey', label: 'Secret Key', env: ['KLING_SECRET_KEY'] },
    { key: 'apiKey', label: 'API Key (신규 방식)', env: ['KLING_API_KEY'], optional: true },
  ],
  credentialSets: [['accessKey', 'secretKey'], ['apiKey']],
  settings: [{ key: 'region', label: '리전', values: ['global', 'cn'], default: 'global', env: 'KLING_REGION' }],
  needsPublicVideoUrl: true,
  publicUploads: false,
  pollIntervalMs: 5000,
};

const BASE_BY_REGION = {
  global: 'https://api-singapore.klingai.com',
  cn: 'https://api-beijing.klingai.com',
};

// Max inline base64 image (legacy standard ~10 MB). Applied to the raw file bytes.
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

function apiBase(ctx) {
  if (ctx.baseUrl) return ctx.baseUrl.replace(/\/+$/, '');
  const region = (ctx.settings && ctx.settings.region) || 'global';
  return BASE_BY_REGION[region] || BASE_BY_REGION.global;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Mint an HS256 JWT: { iss: accessKey, exp: now+1800, nbf: now-5 }.
function signJwt(accessKey, secretKey, nowSec = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: accessKey, exp: nowSec + 1800, nbf: nowSec - 5 }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secretKey).update(signingInput).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signingInput}.${signature}`;
}

function authValue(ctx) {
  const c = ctx.credentials || {};
  if (c.apiKey) return `Bearer ${c.apiKey}`;
  if (c.accessKey && c.secretKey) return `Bearer ${signJwt(c.accessKey, c.secretKey)}`;
  throw new ProviderError('Kling requires either an API key or an Access/Secret key pair.', { status: null, retryable: false, code: 'no_credentials' });
}

// Images: inline base64 data URI when small enough. Videos: no upload API.
async function upload(ctx, file) {
  const isVideo = (file.contentType && file.contentType.startsWith('video/'))
    || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.filename || '');
  if (isVideo) {
    throw new ProviderError('Kling has no video upload API; the reference video needs a public URL.', {
      status: null, retryable: false, code: 'needs_public_url',
    });
  }
  const fs = require('node:fs');
  const bytes = await fs.promises.readFile(file.path);
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    throw new ProviderError('Kling image exceeds the inline base64 size limit.', {
      status: null, retryable: false, code: 'needs_public_url',
    });
  }
  const mime = file.contentType || 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function submit(ctx, route, input) {
  const base = apiBase(ctx);
  const { buildRequest } = require('../catalog');
  const body = buildRequest(route, input);
  // Name the model version from the route endpoint (kling-v3 / kling-v2-6).
  body.model_name = route.endpoint;

  const res = await fetchJson(ctx.fetch, `${base}/v1/videos/motion-control`, {
    method: 'POST',
    headers: { Authorization: authValue(ctx), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal,
    label: 'Kling submit',
  });
  // Kling wraps business errors in a non-zero `code` even on HTTP 200.
  if (res && res.code !== undefined && res.code !== 0) {
    const retryable = res.code === 1302 || res.code === 5000 || res.code === 5001 || res.code === 5002;
    throw new ProviderError('Kling rejected the submission.', { status: null, retryable, code: String(res.code) });
  }
  const taskId = res && res.data && res.data.task_id;
  if (!taskId) throw new ProviderError('Kling submit did not return a task id.', { status: null, retryable: false, code: 'bad_submit' });
  return { id: taskId };
}

const STATUS_MAP = {
  submitted: 'queued',
  processing: 'running',
  succeed: 'succeeded',
  succeeded: 'succeeded',
  failed: 'failed',
};

async function poll(ctx, route, task) {
  const base = apiBase(ctx);
  const res = await fetchJson(ctx.fetch, `${base}/v1/videos/motion-control/${encodeURIComponent(task.id)}`, {
    method: 'GET', headers: { Authorization: authValue(ctx) }, signal: ctx.signal, label: 'Kling poll',
  });
  if (res && res.code !== undefined && res.code !== 0) {
    const retryable = res.code === 1302 || (res.code >= 5000 && res.code < 5100);
    return { state: retryable ? 'running' : 'failed', error: `Kling error code ${res.code}.`, providerStatus: String(res.code) };
  }
  const data = (res && res.data) || {};
  const providerStatus = data.task_status || 'unknown';
  const state = STATUS_MAP[providerStatus] || 'running';
  if (state === 'succeeded') {
    const videos = data.task_result && data.task_result.videos;
    const outputUrl = Array.isArray(videos) && videos.length ? videos[0].url : undefined;
    if (!outputUrl) return { state: 'failed', error: 'Kling succeeded without a video URL.', providerStatus };
    return { state: 'succeeded', outputUrl, providerStatus };
  }
  const moderated = state === 'failed' && /moderat|sensitive|risk|nsfw/i.test(String(data.task_status_msg || ''));
  return { state, error: data.task_status_msg || undefined, providerStatus, moderated };
}

async function download(ctx, url, destPath) {
  // Kling output URLs are public signed URLs; no auth header attached.
  return downloadToFile({
    fetch: ctx.fetch, url, destPath, signal: ctx.signal, allowInsecure: ctx.allowInsecure,
  });
}

async function test(ctx) {
  // Cheap check: can we form credentials? A real credential probe would cost a call / need a
  // known-free endpoint we cannot confirm, so validate only that auth material is present + a JWT
  // can be minted.
  try {
    authValue(ctx);
    return { ok: true, detail: 'Kling credentials are present (not verified against the API).' };
  } catch (err) {
    return { ok: false, detail: err instanceof ProviderError ? err.message : 'Kling credentials are missing.' };
  }
}

module.exports = { meta, upload, submit, poll, cancel: null, download, test, signJwt };
