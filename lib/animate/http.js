'use strict';

/**
 * Shared HTTP helpers for the animate provider adapters.
 *
 * Everything here is zero-dependency: global `fetch`, `AbortController`/`AbortSignal`,
 * `fs`, and Node's built-in `crypto`. The helpers exist so the six adapters never
 * hand-roll timeouts, error shaping, or the streaming-download safety rules.
 *
 * ProviderError is the ONE error type adapters throw. Its message is English and MUST
 * NOT contain secrets (API keys, bearer tokens, signed URLs, absolute paths). The
 * pipeline maps `.retryable` onto its backoff/give-up logic.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

// 1 GB hard cap on any downloaded file. A generated clip is a handful of MB; anything
// approaching this is a misbehaving/hostile endpoint and must be refused.
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

// Default per-request timeout. Overridable per call.
const DEFAULT_TIMEOUT_MS = 30000;

class ProviderError extends Error {
  /**
   * @param {string} message  English, secret-free.
   * @param {{ status?: number|null, retryable?: boolean, code?: string|null, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status == null ? null : opts.status;
    this.retryable = Boolean(opts.retryable);
    this.code = opts.code == null ? null : opts.code;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

// A 4xx (except 408/429) is the caller's fault and will not fix itself: not retryable.
// 408/429/5xx and transport failures are transient: retryable.
function retryableForStatus(status) {
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

// Turn an arbitrary thrown value into a ProviderError without leaking a URL/secret.
// AbortError is preserved as a non-retryable cancellation signal.
function wrapNetworkError(err, context) {
  if (err instanceof ProviderError) return err;
  const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
  if (aborted) {
    return new ProviderError(`${context} was aborted.`, { status: null, retryable: false, code: 'aborted', cause: err });
  }
  // Do NOT interpolate err.message blindly for the network case: fetch puts the full
  // URL (which may be a signed URL) into some failure messages. Use a fixed string.
  return new ProviderError(`${context} failed: network error.`, { status: null, retryable: true, code: 'network', cause: err });
}

// Compose an external AbortSignal with an internal timeout. Returns { signal, cancel }.
// cancel() must be called in a finally to clear the timer.
function withTimeout(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal && externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => {
    controller.abort(new ProviderError('Request timed out.', { status: null, retryable: true, code: 'timeout' }));
  }, timeoutMs) : null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  };
  return { signal: controller.signal, cancel };
}

/**
 * fetch wrapper: bounds the request with a timeout, honours an external signal, and
 * always returns the raw Response (status not asserted). Throws ProviderError only on
 * transport failure / timeout / abort.
 *
 * @param {typeof fetch} doFetch  the ctx.fetch to use (injectable for tests).
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number, signal?: AbortSignal }} [options]
 */
async function fetchRaw(doFetch, url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, ...init } = options;
  const { signal, cancel } = withTimeout(externalSignal, timeoutMs);
  try {
    return await doFetch(url, { ...init, signal });
  } catch (err) {
    throw wrapNetworkError(err, 'Request');
  } finally {
    cancel();
  }
}

// Read a response body as text, but never surface it raw if it might carry a secret.
async function safeText(response, cap = 2000) {
  try {
    const text = await response.text();
    return typeof text === 'string' ? text.slice(0, cap) : '';
  } catch {
    return '';
  }
}

/**
 * fetch + JSON parse + status check in one. On a non-OK status, throws a ProviderError
 * whose message names the status but NOT the URL. Attempts to read a provider error
 * `code`/`message` from a JSON body, sanitised.
 *
 * @returns {Promise<any>} parsed JSON on 2xx.
 */
async function fetchJson(doFetch, url, options = {}) {
  const { label = 'request', okStatuses = null, ...rest } = options;
  const response = await fetchRaw(doFetch, url, rest);
  const ok = okStatuses ? okStatuses.includes(response.status) : response.ok;
  if (!ok) {
    const body = await safeText(response);
    let providerCode = null;
    let providerMessage = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        // Common shapes: {code, message}, {detail}, {error}.
        if (parsed.code !== undefined && parsed.code !== null) providerCode = String(parsed.code);
        if (typeof parsed.message === 'string') providerMessage = parsed.message;
        else if (typeof parsed.detail === 'string') providerMessage = parsed.detail;
        else if (typeof parsed.error === 'string') providerMessage = parsed.error;
      }
    } catch { /* body was not JSON */ }
    const suffix = providerMessage ? ` (${sanitizeMessage(providerMessage)})` : '';
    throw new ProviderError(`The ${label} was rejected with HTTP ${response.status}${suffix}.`, {
      status: response.status,
      retryable: retryableForStatus(response.status),
      code: providerCode,
    });
  }
  try {
    return await response.json();
  } catch (err) {
    throw new ProviderError(`The ${label} returned a body that was not valid JSON.`, {
      status: response.status, retryable: false, code: 'bad_json', cause: err,
    });
  }
}

// Strip anything that looks like a URL, an absolute path, or a long token from a
// provider-supplied message before it goes into a ProviderError.
function sanitizeMessage(message) {
  if (typeof message !== 'string') return '';
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/oss:\/\/\S+/gi, '[url]')
    .replace(/\/(?:[\w.-]+\/){2,}[\w.-]+/g, '[path]')       // /a/b/c style paths
    .replace(/[A-Za-z0-9_-]*[A-Za-z0-9]{16,}[A-Za-z0-9_-]*/g, '[redacted]') // opaque tokens/keys (>=16 alnum run)
    .slice(0, 300)
    .trim();
}

function isHttps(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Stream a URL to a destination path safely.
 *
 * Rules (from the spec's adapter interface):
 *  - https only, unless ctx.allowInsecure is true (used only for local test http servers).
 *  - Write to a `<dest>.<rand>.part` tmp file, then atomically rename to dest.
 *  - Enforce the 1 GB cap while streaming (Content-Length AND actual bytes).
 *  - Provider Authorization header is sent ONLY when the URL host matches `authHost`
 *    (the provider's own API host, e.g. replicate.delivery for Replicate) — never to an
 *    arbitrary output CDN.
 *  - Honour ctx.signal.
 *
 * @param {object} args
 * @param {typeof fetch} args.fetch
 * @param {string} args.url
 * @param {string} args.destPath
 * @param {AbortSignal} [args.signal]
 * @param {boolean} [args.allowInsecure]
 * @param {{ header: string, value: string, host: string }} [args.auth]  send `header: value` only to `host`.
 * @param {number} [args.maxBytes]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ size: number }>}
 */
async function downloadToFile(args) {
  const {
    fetch: doFetch, url, destPath, signal, allowInsecure = false,
    auth = null, maxBytes = MAX_DOWNLOAD_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS,
  } = args;

  if (!isHttps(url) && !allowInsecure) {
    throw new ProviderError('Refusing to download over an insecure (non-https) URL.', {
      status: null, retryable: false, code: 'insecure_url',
    });
  }

  const headers = {};
  if (auth && auth.header && auth.value && auth.host && hostOf(url) === auth.host) {
    headers[auth.header] = auth.value;
  }

  const response = await fetchRaw(doFetch, url, { method: 'GET', headers, signal, timeoutMs });
  if (!response.ok) {
    await safeText(response);
    throw new ProviderError(`Download failed with HTTP ${response.status}.`, {
      status: response.status, retryable: retryableForStatus(response.status), code: 'download_status',
    });
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderError('Download exceeds the 1 GB size cap.', {
      status: null, retryable: false, code: 'too_large',
    });
  }
  if (!response.body) {
    throw new ProviderError('Download response had no body.', { status: null, retryable: false, code: 'empty_body' });
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.${crypto.randomBytes(6).toString('hex')}.part`;
  const out = fs.createWriteStream(tmpPath);
  let written = 0;
  const abortErr = () => new ProviderError('Download was aborted.', { status: null, retryable: false, code: 'aborted' });

  try {
    if (signal && signal.aborted) throw abortErr();
    const reader = response.body.getReader();
    for (;;) {
      if (signal && signal.aborted) throw abortErr();
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new ProviderError('Download exceeds the 1 GB size cap.', {
          status: null, retryable: false, code: 'too_large',
        });
      }
      // events.once() rejects on 'error' and removes both listeners, so repeated drains do not pile up listeners.
      if (!out.write(Buffer.from(value))) await once(out, 'drain');
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });
    await fsp.rename(tmpPath, destPath);
    return { size: written };
  } catch (err) {
    out.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    if (err instanceof ProviderError) throw err;
    throw wrapNetworkError(err, 'Download');
  }
}

module.exports = {
  ProviderError,
  MAX_DOWNLOAD_BYTES,
  DEFAULT_TIMEOUT_MS,
  fetchRaw,
  fetchJson,
  downloadToFile,
  sanitizeMessage,
  retryableForStatus,
  isHttps,
  hostOf,
  withTimeout,
};
