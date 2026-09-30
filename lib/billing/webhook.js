'use strict';

// Polar webhook deliveries (Standard Webhooks): the raw-body reader and the
// signature check. A delivery carries webhook-id, webhook-timestamp (unix
// seconds) and webhook-signature ("v1,<base64>" entries separated by spaces);
// the signature is base64(HMAC-SHA256(key, "<id>.<timestamp>." + raw body)).
// Two keys are accepted: the secret string's UTF-8 bytes (Polar's own HMAC,
// secrets made before 2026-09-08) and the base64 part after "whsec_"
// (Standard Webhooks).

const crypto = require('node:crypto');

const MAX_WEBHOOK_BYTES = 1024 * 1024;
// A too-large body is drained (so the 413 reaches the sender) up to this
// size; past it the connection is closed instead.
const MAX_DRAIN_BYTES = 8 * MAX_WEBHOOK_BYTES;
const TOLERANCE_SEC = 300;
const MAX_ID_LENGTH = 256;
const SECRET_PREFIX = 'whsec_';

// Resolves { bytes } for a body within `limit`, or { bytes: null, close } for
// a larger one (close: the sender is still writing; answer with
// Connection: close).
function readRawBody(req, limit = MAX_WEBHOOK_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_DRAIN_BYTES) return Promise.resolve({ bytes: null, close: true });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const settle = (callback, value) => {
      if (done) return;
      done = true;
      cleanup();
      callback(value);
    };
    function onData(chunk) {
      total += chunk.length;
      if (total <= limit) {
        chunks.push(chunk);
      } else if (total > MAX_DRAIN_BYTES) {
        req.pause();
        settle(resolve, { bytes: null, close: true });
      }
    }
    function onEnd() {
      settle(resolve, total > limit ? { bytes: null, close: false } : { bytes: Buffer.concat(chunks), close: false });
    }
    function onError(error) {
      settle(reject, Object.assign(new Error(error.message || 'Request aborted.'), { status: 400 }));
    }
    function onClose() {
      settle(reject, Object.assign(new Error('Request aborted.'), { status: 400 }));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// The HMAC keys a secret stands for. An empty key would make signatures
// forgeable, so a secret whose base64 part decodes to nothing only has the
// UTF-8 key.
function signingKeys(secret) {
  const keys = [Buffer.from(secret, 'utf8')];
  const standard = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  if (standard.length) keys.push(standard);
  return keys;
}

function signPayload(key, id, timestamp, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return crypto.createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), body]))
    .digest('base64');
}

function headerText(value) {
  return typeof value === 'string' ? value : '';
}

// -> { ok: true, id, timestamp } or { ok: false, reason }. The reason is for
// the log only; the sender always sees the same 403.
function verifyWebhook({ secret, headers, rawBody, nowMs }) {
  const id = headerText(headers['webhook-id']);
  const timestamp = headerText(headers['webhook-timestamp']).trim();
  const signatureHeader = headerText(headers['webhook-signature']);
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: 'missing_headers' };
  if (id.length > MAX_ID_LENGTH || /[\x00-\x20\x7f]/.test(id)) return { ok: false, reason: 'bad_id' };
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const sentAt = Number(timestamp);
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - sentAt > TOLERANCE_SEC) return { ok: false, reason: 'stale_timestamp' };
  if (sentAt - nowSec > TOLERANCE_SEC) return { ok: false, reason: 'future_timestamp' };
  const given = signatureHeader.split(' ')
    .filter(entry => entry.startsWith('v1,'))
    .map(entry => Buffer.from(entry.slice(3), 'utf8'));
  if (!given.length) return { ok: false, reason: 'no_v1_signature' };
  const expected = signingKeys(secret).map(key => Buffer.from(signPayload(key, id, timestamp, rawBody), 'utf8'));
  const valid = given.some(value => expected.some(candidate => value.length === candidate.length && crypto.timingSafeEqual(value, candidate)));
  return valid ? { ok: true, id, timestamp: sentAt } : { ok: false, reason: 'bad_signature' };
}

module.exports = { MAX_WEBHOOK_BYTES, TOLERANCE_SEC, readRawBody, signPayload, signingKeys, verifyWebhook };
