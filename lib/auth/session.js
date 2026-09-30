'use strict';

// Signed cookies and the small pure helpers the login flow shares.
// A signed value is `<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, first part))>`;
// the HMAC key is the sessionSecret string from state.json, used as-is.

const crypto = require('node:crypto');

const SESSION_COOKIE = 'virtually_session';
const OAUTH_COOKIE = 'virtually_oauth';
const OVERLAY_COOKIE = 'virtually_overlay';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds
const SESSION_RENEW_AFTER = 24 * 60 * 60; // seconds since iat
const OAUTH_MAX_AGE = 600; // seconds
const OVERLAY_MAX_AGE = 34560000; // seconds (400 days, the browser maximum)
const OAUTH_PATH = '/auth/google';
const MAX_SIGNED_LENGTH = 8192;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

// Returns the payload object, or null for anything malformed or not signed with `secret`.
function verify(token, secret) {
  if (typeof token !== 'string' || token.length > MAX_SIGNED_LENGTH) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!BASE64URL.test(body) || !BASE64URL.test(mac)) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  // Only the canonical encoding counts (no variants that differ in unused bits).
  if (given.toString('base64url') !== mac) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

// Constant-time string comparison (hashing first hides the length too).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right) && a.length === b.length;
}

// Every value of each cookie name, in header order (a browser may send the same
// name twice, e.g. from two paths).
function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!name) continue;
    if (!cookies.has(name)) cookies.set(name, []);
    cookies.get(name).push(value);
  }
  return cookies;
}

function cookieValues(req, name) {
  return parseCookies(req.headers.cookie).get(name) || [];
}

function serializeCookie(name, value, { path = '/', maxAge, secure = false }) {
  const parts = [`${name}=${value}`, 'HttpOnly', 'SameSite=Lax', `Path=${path}`, `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(name, { path = '/', secure = false } = {}) {
  return serializeCookie(name, '', { path, maxAge: 0, secure });
}

// Adds one Set-Cookie value, keeping any set before (writeHead merges these).
function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

const NEXT_BASE = 'http://virtually.invalid';

// The post-login destination: a same-origin path, never /login or /auth/*;
// anything else becomes "/". Non-ASCII characters are percent-encoded so the
// value is safe in a Location header.
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return '/';
  let encoded;
  try {
    encoded = value.replace(/[^\x20-\x7e]/gu, char => encodeURIComponent(char)).replace(/ /g, '%20');
  } catch {
    return '/';
  }
  if (encoded.length > 2000) return '/';
  let resolved;
  try {
    resolved = new URL(encoded, NEXT_BASE);
  } catch {
    return '/';
  }
  if (resolved.origin !== NEXT_BASE) return '/';
  const { pathname } = resolved;
  if (pathname === '/login' || pathname.startsWith('/login/') || pathname === '/auth' || pathname.startsWith('/auth/')) return '/';
  return encoded;
}

function unixSeconds(ms) {
  return Math.floor(ms / 1000);
}

// A fresh session payload for a verified Google user.
function sessionPayload(user, nowSec) {
  return {
    v: 1,
    sub: user.sub,
    email: user.email,
    name: user.name ?? null,
    picture: user.picture ?? null,
    iat: nowSec,
    exp: nowSec + SESSION_MAX_AGE,
  };
}

// The payload when it is a well-formed, unexpired session; otherwise null.
function checkSessionPayload(payload, nowSec) {
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string' || !payload.email) return null;
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= nowSec) return null;
  return payload;
}

// The payload when it is a well-formed, unexpired login attempt; otherwise null.
function checkOauthPayload(payload, nowSec) {
  if (!payload) return null;
  for (const key of ['state', 'nonce', 'verifier', 'next']) {
    if (typeof payload[key] !== 'string' || !payload[key]) return null;
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSec) return null;
  return payload;
}

module.exports = {
  OAUTH_COOKIE,
  OAUTH_MAX_AGE,
  OAUTH_PATH,
  OVERLAY_COOKIE,
  OVERLAY_MAX_AGE,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  SESSION_RENEW_AFTER,
  appendSetCookie,
  checkOauthPayload,
  checkSessionPayload,
  clearCookie,
  cookieValues,
  parseCookies,
  safeEqual,
  safeNext,
  serializeCookie,
  sessionPayload,
  sign,
  unixSeconds,
  verify,
};
