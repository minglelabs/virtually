'use strict';

// A dependency-free stand-in for Google's OAuth 2.0 / OpenID Connect endpoints,
// for tests (and a browser E2E): point createAppServer({ auth: { endpoints } })
// at it.
//
//   const google = await startFakeGoogle({ clientId, clientSecret });
//   google.endpoints        // { authorize, token, jwks } URLs
//   google.setUser(claims)  // merge ID-token claims (sub, email, email_verified,
//                           // name, picture, ...); undefined removes a claim
//   google.fail(kind|null)  // make the next responses fail until fail(null)
//   google.rotateKey()      // sign with a new key/kid (the old one stays in JWKS)
//   google.requests         // { authorize, token, jwks } request counts
//   await google.close()
//
// Options beyond the contract: `now` (ms clock for iat/exp; share the one given
// to the app server) and `jwksMaxAge` (seconds, JWKS Cache-Control max-age).
//
// The authorize endpoint approves at once: 302 to redirect_uri?code&state
// (or ?error=access_denied&state). The token endpoint checks the client,
// single-use code, PKCE verifier and redirect_uri, like Google does.

const http = require('node:http');
const crypto = require('node:crypto');

const FAIL_KINDS = new Set([
  'access_denied', // authorize redirects back with error=access_denied
  'token_500', // token endpoint answers 500 (not JSON)
  'token_400', // token endpoint answers 400 invalid_grant
  'token_no_id_token', // token endpoint answers 200 without id_token
  'jwks_500', // JWKS endpoint answers 500
  'bad_signature', // id_token signed with a different key (same kid)
  'unknown_kid', // id_token header names a kid the JWKS does not have
  'alg_none', // id_token header alg "none", no signature
  'wrong_alg', // id_token header alg "RS512" over a valid RS256 signature
  'wrong_aud', // aud is another client
  'wrong_iss', // iss is not Google
  'expired', // exp an hour ago
  'future_iat', // iat an hour ahead
  'bad_nonce', // nonce differs from the one sent to authorize
]);

const DEFAULT_USER = Object.freeze({
  sub: '109876543210987654321',
  email: 'streamer@example.com',
  email_verified: true,
  name: 'Test Streamer',
  picture: 'https://lh3.googleusercontent.com/a/test-picture',
});

function newSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(10).toString('hex');
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function b64json(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function startFakeGoogle({ clientId, clientSecret, now = Date.now, jwksMaxAge = 3600 } = {}) {
  if (!clientId || !clientSecret) throw new Error('startFakeGoogle needs clientId and clientSecret.');
  let signing = newSigningKey();
  const published = [signing.jwk];
  let impostor = null; // a key the JWKS never lists, for 'bad_signature'
  let user = { ...DEFAULT_USER };
  let failure = null;
  const codes = new Map(); // code -> { nonce, codeChallenge, redirectUri, claims, used }
  const requests = { authorize: 0, token: 0, jwks: 0 };

  function idToken(grant) {
    const nowSec = Math.floor(now() / 1000);
    const claims = {
      iss: 'https://accounts.google.com',
      azp: clientId,
      aud: clientId,
      iat: nowSec,
      exp: nowSec + 3600,
      nonce: grant.nonce,
      ...grant.claims,
    };
    if (failure === 'wrong_aud') claims.aud = claims.azp = 'someone-else.apps.googleusercontent.com';
    if (failure === 'wrong_iss') claims.iss = 'https://accounts.example.com';
    if (failure === 'expired') Object.assign(claims, { iat: nowSec - 7200, exp: nowSec - 3600 });
    if (failure === 'future_iat') Object.assign(claims, { iat: nowSec + 3600, exp: nowSec + 7200 });
    if (failure === 'bad_nonce') claims.nonce = 'not-the-nonce-that-was-sent';
    if (failure === 'alg_none') return `${b64json({ alg: 'none', typ: 'JWT' })}.${b64json(claims)}.`;
    const header = {
      alg: failure === 'wrong_alg' ? 'RS512' : 'RS256',
      kid: failure === 'unknown_kid' ? 'kid-that-is-not-published' : signing.kid,
      typ: 'JWT',
    };
    const input = `${b64json(header)}.${b64json(claims)}`;
    let key = signing.privateKey;
    if (failure === 'bad_signature') key = (impostor ||= newSigningKey()).privateKey;
    return `${input}.${crypto.sign('sha256', Buffer.from(input), key).toString('base64url')}`;
  }

  function authorize(req, res, url) {
    requests.authorize += 1;
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri');
    // Like Google: a bad client or request is an error page, never a redirect.
    if (q.get('client_id') !== clientId) return send(res, 401, 'invalid_client');
    if (!redirectUri || !/^https?:\/\//.test(redirectUri)) return send(res, 400, 'invalid redirect_uri');
    if (q.get('response_type') !== 'code') return send(res, 400, 'unsupported_response_type');
    if (!String(q.get('scope') || '').split(' ').includes('openid')) return send(res, 400, 'invalid_scope');
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(res, 400, 'invalid code_challenge');
    if (!q.get('state') || !q.get('nonce')) return send(res, 400, 'state and nonce are required');
    const target = new URL(redirectUri);
    if (failure === 'access_denied') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('state', q.get('state'));
    } else {
      const code = `4/${crypto.randomBytes(24).toString('base64url')}`;
      codes.set(code, {
        nonce: q.get('nonce'), codeChallenge: q.get('code_challenge'), redirectUri, claims: { ...user }, used: false,
      });
      target.searchParams.set('state', q.get('state'));
      target.searchParams.set('code', code);
      target.searchParams.set('scope', 'email profile openid');
    }
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    return res.end();
  }

  async function token(req, res) {
    requests.token += 1;
    const form = await readForm(req);
    if (failure === 'token_500') return send(res, 500, 'Internal Server Error');
    if (failure === 'token_400') return send(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
      return send(res, 400, { error: 'invalid_request' });
    }
    if (form.get('grant_type') !== 'authorization_code') return send(res, 400, { error: 'unsupported_grant_type' });
    if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
      return send(res, 401, { error: 'invalid_client' });
    }
    const grant = codes.get(form.get('code') || '');
    if (!grant || grant.used) return send(res, 400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
    grant.used = true;
    if (form.get('redirect_uri') !== grant.redirectUri) return send(res, 400, { error: 'redirect_uri_mismatch' });
    const verifier = form.get('code_verifier') || '';
    if (crypto.createHash('sha256').update(verifier).digest('base64url') !== grant.codeChallenge) {
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
    }
    if (failure === 'token_no_id_token') {
      return send(res, 200, { access_token: 'ya29.fake', expires_in: 3599, token_type: 'Bearer', scope: 'openid' });
    }
    return send(res, 200, {
      access_token: `ya29.${crypto.randomBytes(16).toString('base64url')}`,
      expires_in: 3599,
      id_token: idToken(grant),
      token_type: 'Bearer',
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    });
  }

  function jwks(req, res) {
    requests.jwks += 1;
    if (failure === 'jwks_500') return send(res, 500, 'Internal Server Error');
    return send(res, 200, { keys: published }, { 'Cache-Control': `public, max-age=${jwksMaxAge}, must-revalidate, no-transform` });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake-google.invalid');
    (async () => {
      if (req.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') return authorize(req, res, url);
      if (req.method === 'POST' && url.pathname === '/token') return token(req, res);
      if (req.method === 'GET' && url.pathname === '/oauth2/v3/certs') return jwks(req, res);
      return send(res, 404, 'not found');
    })().catch(error => {
      if (!res.headersSent) send(res, 500, String(error && error.message));
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    endpoints: {
      authorize: `${base}/o/oauth2/v2/auth`,
      token: `${base}/token`,
      jwks: `${base}/oauth2/v3/certs`,
    },
    requests,
    setUser(claims = {}) {
      for (const [key, value] of Object.entries(claims)) {
        if (value === undefined) delete user[key];
        else user[key] = value;
      }
      return { ...user };
    },
    fail(kind) {
      if (kind != null && !FAIL_KINDS.has(kind)) throw new Error(`Unknown fake Google failure: ${kind}`);
      failure = kind ?? null;
    },
    rotateKey() {
      signing = newSigningKey();
      published.unshift(signing.jwk);
      return signing.kid;
    },
    close() {
      server.closeAllConnections();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { startFakeGoogle, FAIL_KINDS, DEFAULT_USER };
