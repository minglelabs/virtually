'use strict';

// Alibaba Cloud Model Studio (DashScope) direct Wan adapter.
// Protocol (verified from help.aliyun.com model-studio docs):
//  - Base by region: intl -> https://dashscope-intl.aliyuncs.com ; cn -> https://dashscope.aliyuncs.com.
//    Auth: Authorization: Bearer <apiKey>. Content-Type: application/json.
//  - Upload (3 steps, works from localhost, no public hosting):
//    1) GET /api/v1/uploads?action=getPolicy&model=<model> -> data:{policy, signature, upload_dir,
//       upload_host, oss_access_key_id, x_oss_object_acl, x_oss_forbid_overwrite}.
//    2) POST multipart/form-data to data.upload_host with fields OSSAccessKeyId, policy, Signature,
//       key(=upload_dir + '/' + filename), x-oss-object-acl, x-oss-forbid-overwrite,
//       success_action_status=200, and `file` LAST (one file per request). 200, no body.
//    3) input URL = oss://<upload_dir>/<filename> ; add header X-DashScope-OssResourceResolve: enable.
//  - Submit: POST /api/v1/services/aigc/image2video/video-synthesis with X-DashScope-Async: enable
//    (+ OssResourceResolve when any input is oss://) -> {output:{task_id, task_status}}.
//  - Poll: GET /api/v1/tasks/{task_id} -> {output:{task_status: PENDING|RUNNING|SUCCEEDED|FAILED|
//    CANCELED|UNKNOWN, results:{video_url}, code, message}}.
//  - Output: output.results.video_url (24h TTL). No cancel endpoint documented -> cancel null.

const { ProviderError, fetchJson, fetchRaw, downloadToFile } = require('../http');

const meta = {
  id: 'dashscope',
  label: 'Alibaba Model Studio (직접)',
  docs: 'https://www.alibabacloud.com/help/en/model-studio/wan-animate-move-api',
  credentials: [{ key: 'apiKey', label: 'API Key', env: ['DASHSCOPE_API_KEY'] }],
  credentialSets: [['apiKey']],
  settings: [{ key: 'region', label: '리전', values: ['intl', 'cn'], default: 'intl', env: 'DASHSCOPE_REGION' }],
  needsPublicVideoUrl: false,
  publicUploads: false,
  pollIntervalMs: 10000,
};

const BASE_BY_REGION = {
  intl: 'https://dashscope-intl.aliyuncs.com',
  cn: 'https://dashscope.aliyuncs.com',
};

function apiBase(ctx) {
  if (ctx.baseUrl) return ctx.baseUrl.replace(/\/+$/, '');
  const region = (ctx.settings && ctx.settings.region) || 'intl';
  return BASE_BY_REGION[region] || BASE_BY_REGION.intl;
}

function apiKey(ctx) {
  const key = ctx.credentials && ctx.credentials.apiKey;
  if (!key) throw new ProviderError('DashScope API key is not configured.', { status: null, retryable: false, code: 'no_credentials' });
  return key;
}

function authHeaders(ctx, extra = {}) {
  return { Authorization: `Bearer ${apiKey(ctx)}`, 'Content-Type': 'application/json', ...extra };
}

// The upload is bound to a model; the pipeline passes it via ctx.uploadModel (falls back to the
// move model, which is what every dashscope route in the catalog uses).
function uploadModel(ctx) {
  return (ctx.uploadModel) || 'wan2.2-animate-move';
}

async function upload(ctx, file) {
  const base = apiBase(ctx);
  const model = uploadModel(ctx);
  // Step 1: getPolicy
  const policyResp = await fetchJson(ctx.fetch, `${base}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
    method: 'GET', headers: authHeaders(ctx), signal: ctx.signal, label: 'DashScope getPolicy',
  });
  const d = policyResp && policyResp.data;
  if (!d || !d.upload_host || !d.upload_dir || !d.policy || !d.signature || !d.oss_access_key_id) {
    throw new ProviderError('DashScope getPolicy response was incomplete.', { status: null, retryable: false, code: 'bad_policy' });
  }
  const key = `${d.upload_dir}/${file.filename}`;

  // Step 2: OSS multipart form POST. Field ORDER matters: `file` MUST be last.
  const fs = require('node:fs');
  const bytes = await fs.promises.readFile(file.path);
  const form = new FormData();
  form.append('OSSAccessKeyId', d.oss_access_key_id);
  form.append('Signature', d.signature);
  form.append('policy', d.policy);
  form.append('x-oss-object-acl', d.x_oss_object_acl != null ? String(d.x_oss_object_acl) : 'private');
  form.append('x-oss-forbid-overwrite', d.x_oss_forbid_overwrite != null ? String(d.x_oss_forbid_overwrite) : 'true');
  form.append('key', key);
  form.append('success_action_status', '200');
  // file LAST:
  form.append('file', new Blob([bytes], { type: file.contentType || 'application/octet-stream' }), file.filename);

  const ossResp = await fetchRaw(ctx.fetch, d.upload_host, { method: 'POST', body: form, signal: ctx.signal });
  if (!ossResp.ok) {
    throw new ProviderError(`DashScope OSS upload failed with HTTP ${ossResp.status}.`, {
      status: ossResp.status, retryable: ossResp.status >= 500, code: 'oss_upload',
    });
  }
  // Step 3: build the oss:// URL.
  return `oss://${key}`;
}

async function submit(ctx, route, input) {
  const base = apiBase(ctx);
  const { buildRequest } = require('../catalog');
  const body = buildRequest(route, input);
  body.model = route.endpoint;

  const usesOss = [input.imageUrl, input.videoUrl].some(u => typeof u === 'string' && u.startsWith('oss://'));
  const extra = { 'X-DashScope-Async': 'enable' };
  if (usesOss) extra['X-DashScope-OssResourceResolve'] = 'enable';

  const res = await fetchJson(ctx.fetch, `${base}/api/v1/services/aigc/image2video/video-synthesis`, {
    method: 'POST',
    headers: authHeaders(ctx, extra),
    body: JSON.stringify(body),
    signal: ctx.signal,
    label: 'DashScope submit',
  });
  const taskId = res && res.output && res.output.task_id;
  if (!taskId) {
    const code = res && res.code ? String(res.code) : null;
    throw new ProviderError('DashScope submit did not return a task id.', { status: null, retryable: false, code: code || 'bad_submit' });
  }
  return { id: taskId };
}

const STATUS_MAP = {
  PENDING: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  UNKNOWN: 'failed',
};

async function poll(ctx, route, task) {
  const base = apiBase(ctx);
  const res = await fetchJson(ctx.fetch, `${base}/api/v1/tasks/${encodeURIComponent(task.id)}`, {
    method: 'GET', headers: authHeaders(ctx), signal: ctx.signal, label: 'DashScope poll',
  });
  const output = (res && res.output) || {};
  const providerStatus = output.task_status || 'UNKNOWN';
  const state = STATUS_MAP[providerStatus] || 'running';
  if (state === 'succeeded') {
    const outputUrl = output.results && output.results.video_url;
    if (!outputUrl) return { state: 'failed', error: 'DashScope succeeded without a video URL.', providerStatus };
    return { state: 'succeeded', outputUrl, providerStatus };
  }
  const moderated = state === 'failed' && /Infringement|DataInspection|moderat/i.test(String(output.code || ''));
  return { state, error: output.message || undefined, providerStatus, moderated };
}

async function download(ctx, url, destPath) {
  // DashScope result URLs are public OSS signed URLs; do not attach the API key.
  return downloadToFile({
    fetch: ctx.fetch, url, destPath, signal: ctx.signal, allowInsecure: ctx.allowInsecure,
  });
}

async function test(ctx) {
  try { apiKey(ctx); } catch (err) { return { ok: false, detail: err.message }; }
  const base = apiBase(ctx);
  // getPolicy is free and validates the key + region.
  try {
    const resp = await fetchRaw(ctx.fetch, `${base}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(uploadModel(ctx))}`, {
      method: 'GET', headers: authHeaders(ctx), signal: ctx.signal,
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, detail: 'DashScope rejected the API key (check the region).' };
    if (!resp.ok) return { ok: false, detail: `DashScope credential check returned HTTP ${resp.status}.` };
    return { ok: true, detail: 'DashScope credentials accepted.' };
  } catch (err) {
    return { ok: false, detail: err instanceof ProviderError ? err.message : 'DashScope test request failed.' };
  }
}

module.exports = { meta, upload, submit, poll, cancel: null, download, test };
