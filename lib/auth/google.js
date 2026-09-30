'use strict';

// Google OpenID Connect, authorization code flow with PKCE, on Node built-ins
// only (crypto + global fetch). Every failure is a LoginError whose `code` is
// one of the /login?error= codes; `detail` is a one-line reason for the server
// log and never contains secrets, authorization codes or tokens.

const crypto = require('node:crypto');

const DEFAULT_ENDPOINTS = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
});
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const REQUEST_TIMEOUT_MS = 10000;
const CLOCK_SKEW_SEC = 300;
const JWKS_DEFAULT_MAX_AGE_SEC = 3600;
const JWKS_UNKNOWN_KID_REFETCH_MS = 60 * 1000;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

class LoginError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail || null;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function parseMaxAge(cacheControl) {
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(String(cacheControl || ''));
  return match ? Number(match[1]) : null;
}

// Short, log-safe token for an OAuth error code from Google.
function logSafe(value) {
  return typeof value === 'string' ? value.replace(/[^\w.-]/g, '').slice(0, 64) : '';
}

function decodeJsonSegment(segment) {
  if (!segment || !BASE64URL.test(segment)) throw new Error('not base64url');
  const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return value;
}

function createGoogleClient({ endpoints = {}, now = Date.now } = {}) {
  // A partial override (e.g. only `token`) keeps Google's URL for the rest.
  const overrides = Object.fromEntries(Object.entries(endpoints || {}).filter(([key, value]) => key in DEFAULT_ENDPOINTS && typeof value === 'string' && value));
  const urls = { ...DEFAULT_ENDPOINTS, ...overrides };
  let jwks = { keys: new Map(), fetchedAt: null, expiresAt: 0 };
  let jwksInflight = null;

  function authorizeUrl({ clientId, redirectUri, state, nonce, verifier }) {
    const url = new URL(urls.authorize);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  // POST the authorization code; resolves the raw ID token string.
  async function exchangeCode({ code, verifier, redirectUri, clientId, clientSecret }) {
    let response;
    try {
      response = await fetch(urls.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new LoginError('google_error', `google token request failed (${logSafe(error.name)})`);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const reason = logSafe(data && data.error);
      throw new LoginError('google_error', `google token error ${response.status}${reason ? ` ${reason}` : ''}`);
    }
    if (!data || typeof data.id_token !== 'string' || !data.id_token) {
      throw new LoginError('google_error', 'google token response had no id_token');
    }
    return data.id_token;
  }

  async function fetchJwks() {
    if (jwksInflight) return jwksInflight;
    jwksInflight = (async () => {
      let response;
      try {
        response = await fetch(urls.jwks, {
          headers: { Accept: 'application/json' },
          redirect: 'follow',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new LoginError('google_error', `google jwks request failed (${logSafe(error.name)})`);
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || !body || !Array.isArray(body.keys)) {
        throw new LoginError('google_error', `google jwks error ${response.status}`);
      }
      const keys = new Map();
      for (const jwk of body.keys) {
        if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
        if ((jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) continue;
        try {
          keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          // Skip a key Node cannot import; a token signed with it fails as unknown kid.
        }
      }
      const fetchedAt = now();
      const maxAge = parseMaxAge(response.headers.get('cache-control'));
      jwks = { keys, fetchedAt, expiresAt: fetchedAt + (maxAge ?? JWKS_DEFAULT_MAX_AGE_SEC) * 1000 };
    })().finally(() => { jwksInflight = null; });
    return jwksInflight;
  }

  // Cached by Cache-Control max-age; an unknown kid refetches at most once per 60 s.
  async function signingKey(kid) {
    const time = now();
    if (jwks.fetchedAt === null || time >= jwks.expiresAt || time < jwks.fetchedAt) {
      await fetchJwks();
    } else if (!jwks.keys.has(kid) && time - jwks.fetchedAt >= JWKS_UNKNOWN_KID_REFETCH_MS) {
      await fetchJwks();
    }
    return jwks.keys.get(kid) || null;
  }

  // Verifies an ID token and returns the user; throws LoginError('invalid_token' |
  // 'email_unverified' | 'google_error').
  async function verifyIdToken(idToken, { clientId, nonce }) {
    const invalid = reason => new LoginError('invalid_token', reason);
    const parts = String(idToken).split('.');
    if (parts.length !== 3) throw invalid('malformed token');
    let header;
    let claims;
    try {
      header = decodeJsonSegment(parts[0]);
      claims = decodeJsonSegment(parts[1]);
    } catch {
      throw invalid('malformed token');
    }
    if (header.alg !== 'RS256') throw invalid(`alg ${logSafe(String(header.alg))}`);
    if (typeof header.kid !== 'string' || !header.kid) throw invalid('no kid');
    if (!BASE64URL.test(parts[2]) || !parts[2]) throw invalid('malformed signature');
    const key = await signingKey(header.kid);
    if (!key) throw invalid('unknown kid');
    let signed = false;
    try {
      signed = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    } catch {
      signed = false;
    }
    if (!signed) throw invalid('bad signature');

    const nowSec = Math.floor(now() / 1000);
    if (!ISSUERS.has(claims.iss)) throw invalid('wrong iss');
    if (Array.isArray(claims.aud)) {
      if (!claims.aud.includes(clientId) || claims.azp !== clientId) throw invalid('wrong aud');
    } else if (claims.aud !== clientId) {
      throw invalid('wrong aud');
    }
    if (typeof claims.exp !== 'number' || !(claims.exp > nowSec - CLOCK_SKEW_SEC)) throw invalid('expired');
    if (typeof claims.iat !== 'number' || !(claims.iat <= nowSec + CLOCK_SKEW_SEC)) throw invalid('iat in the future');
    if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) throw invalid('nonce mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string' || !claims.email.trim()) {
      throw invalid('no sub or email');
    }
    const email = claims.email.trim().toLowerCase();
    if (claims.email_verified !== true) throw new LoginError('email_unverified', email);
    return {
      sub: claims.sub.slice(0, 255),
      email,
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : null,
      picture: typeof claims.picture === 'string' && /^https:\/\//i.test(claims.picture) && claims.picture.length <= 2000 ? claims.picture : null,
    };
  }

  return { authorizeUrl, exchangeCode, verifyIdToken, endpoints: urls };
}

module.exports = { DEFAULT_ENDPOINTS, LoginError, codeChallenge, createGoogleClient, logSafe, randomToken };
