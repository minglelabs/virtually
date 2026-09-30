'use strict';

// Google login (server side): modes, access classes, OAuth flow against the
// fake Google, cookies, overlay key, hot-reloaded config and publicUrl.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const crypto = require('node:crypto');

const { createAppServer } = require('../server');
const { safeNext, sign } = require('../lib/auth/session');
const { parseAuthConfig, isEmailAllowed } = require('../lib/auth/config');
const { startFakeGoogle } = require('./helpers/fake-google');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-client-secret';
const START = Date.parse('2026-03-01T09:00:00Z');
const START_SEC = START / 1000;
const DAY = 24 * 60 * 60 * 1000;
const PUBLIC_HOST = 'virtually.example.com';
const MISCONFIGURED = { error: '로그인 설정 파일에 문제가 있습니다.', code: 'auth_misconfigured' };
const AUTH_REQUIRED = { error: '로그인이 필요합니다.', code: 'auth_required' };
const OVERLAY_LINE = 'Virtually: OBS 주소의 키가 없거나 바뀌었습니다. 컨트롤러에서 OBS 주소를 다시 복사하세요.';

function config(overrides = {}) {
  return { google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, allowedEmails: ['streamer@example.com'], ...overrides };
}

function makeClock(start = START) {
  const clock = { t: start, now: () => clock.t, advance: ms => { clock.t += ms; } };
  return clock;
}

let stampCounter = 0;
// Writes config.json and gives it a fresh mtime, so the change is visible to the
// mtime/size check however quickly a test writes twice.
async function writeConfig(dataDir, value) {
  const dir = path.join(dataDir, 'auth');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  stampCounter += 1;
  const stamp = new Date(Date.now() + stampCounter * 1000);
  await fs.utimes(file, stamp, stamp);
}

async function startApp(ctx) {
  ctx.server = await createAppServer({
    dataDir: ctx.dataDir,
    auth: { endpoints: ctx.google.endpoints, now: ctx.clock.now, configCheckIntervalMs: ctx.interval, log: line => ctx.logs.push(line) },
  });
  await new Promise(resolve => ctx.server.listen(0, '127.0.0.1', resolve));
  ctx.port = ctx.server.address().port;
  ctx.host = `127.0.0.1:${ctx.port}`;
  return ctx;
}

async function stopApp(ctx) {
  if (!ctx.server || !ctx.server.listening) return;
  ctx.server.closeAllConnections();
  await new Promise(resolve => ctx.server.close(resolve));
}

// A running app + fake Google on a fresh dataDir. `authConfig: null` = no config.json.
async function setup(t, { authConfig = config(), interval = 0, seed } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-auth-'));
  const ctx = { dataDir, clock: makeClock(), interval, logs: [] };
  ctx.google = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: ctx.clock.now });
  t.after(async () => {
    await stopApp(ctx);
    await ctx.google.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (authConfig !== null) await writeConfig(dataDir, authConfig);
  if (seed) await seed(dataDir);
  return startApp(ctx);
}

function request(port, pathname, { method = 'GET', headers = {}, body, cookie } = {}) {
  const allHeaders = { ...headers };
  if (cookie) allHeaders.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (!Object.keys(allHeaders).some(name => name.toLowerCase() === 'content-type')) allHeaders['Content-Type'] = 'application/json';
    allHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: allHeaders, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json, setCookies: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function parseSetCookie(line) {
  const [pair, ...attributes] = line.split(';').map(part => part.trim());
  const eq = pair.indexOf('=');
  const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs: {} };
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    if (at < 0) cookie.attrs[attribute.toLowerCase()] = true;
    else cookie.attrs[attribute.slice(0, at).toLowerCase()] = attribute.slice(at + 1);
  }
  return cookie;
}

function cookieFrom(response, name) {
  return response.setCookies.map(parseSetCookie).find(cookie => cookie.name === name) || null;
}

function decodeSigned(value) {
  return JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8'));
}

async function readState(dataDir) {
  return JSON.parse(await fs.readFile(path.join(dataDir, 'auth', 'state.json'), 'utf8'));
}

// Walks the whole login: app -> fake Google authorize -> app callback.
async function login(ctx, { next = '/', host, mutateCallback } = {}) {
  const headers = host ? { Host: host } : {};
  const start = await request(ctx.port, `/auth/google/login?next=${encodeURIComponent(next)}`, { headers });
  assert.equal(start.status, 302, 'login start redirects to Google');
  const oauth = cookieFrom(start, 'virtually_oauth');
  const authorizeUrl = new URL(start.headers.location);
  const approved = await request(Number(authorizeUrl.port), authorizeUrl.pathname + authorizeUrl.search);
  assert.equal(approved.status, 302, 'fake Google approves');
  const back = new URL(approved.headers.location);
  let callbackPath = back.pathname + back.search;
  let cookie = oauth ? `virtually_oauth=${oauth.value}` : undefined;
  if (mutateCallback) ({ callbackPath, cookie } = mutateCallback({ callbackPath, cookie, back, oauth }));
  const callback = await request(ctx.port, callbackPath, { headers, cookie });
  const session = cookieFrom(callback, 'virtually_session');
  return { start, oauth, authorizeUrl, approved, back, callback, session, cookie: session && session.value ? `virtually_session=${session.value}` : null };
}

async function signIn(ctx, options) {
  const result = await login(ctx, options);
  assert.equal(result.callback.status, 302);
  assert.ok(result.cookie, `signed in (got ${result.callback.headers.location})`);
  return result.cookie;
}

function assertLoginFailed(callback, code, label = code) {
  assert.equal(callback.status, 302, label);
  const location = new URL(callback.headers.location, 'http://app.invalid');
  assert.equal(location.pathname, '/login', label);
  assert.equal(location.searchParams.get('error'), code, label);
  const cleared = cookieFrom(callback, 'virtually_oauth');
  assert.ok(cleared, `${label}: clears virtually_oauth`);
  assert.equal(cleared.value, '', label);
  assert.equal(cleared.attrs['max-age'], '0', label);
  assert.equal(cleared.attrs.path, '/auth/google', label);
  assert.equal(cookieFrom(callback, 'virtually_session'), null, `${label}: no session cookie`);
}

function within(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// An open SSE response: waitFor(regex) resolves once the text so far matches.
function openStream(port, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: cookie ? { Cookie: cookie } : {}, agent: false }, res => {
      let text = '';
      let wake = () => {};
      let markEnded;
      const ended = new Promise(done => { markEnded = done; });
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; wake(); });
      res.on('error', () => {});
      res.on('end', () => markEnded('end'));
      res.on('close', () => markEnded('close'));
      resolve({
        status: res.statusCode,
        headers: res.headers,
        ended,
        get text() { return text; },
        async waitFor(pattern, ms = 5000) {
          const deadline = Date.now() + ms;
          while (!pattern.test(text)) {
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`SSE never matched ${pattern}: ${JSON.stringify(text)}`);
            await within(new Promise(done => { wake = done; }), left, `SSE never matched ${pattern}`).catch(() => {});
          }
          return text;
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const json = body => ({ body, headers: { 'Content-Type': 'application/json' } });

test('disabled mode: no login, auth endpoints answer, existing routes stay open', async t => {
  const ctx = await setup(t, { authConfig: null });
  const status = await request(ctx.port, '/api/auth/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, {
    mode: 'disabled', problem: null, loggedIn: false,
    redirectUri: `http://${ctx.host}/auth/google/callback`, configPath: 'data/auth/config.json',
  });
  assert.deepEqual((await request(ctx.port, '/api/auth/me')).json, { enabled: false, user: null, overlayKey: null });
  const rotate = await request(ctx.port, '/api/auth/overlay-key', { method: 'POST', ...json({}) });
  assert.equal(rotate.status, 409);
  assert.equal(rotate.json.code, 'auth_disabled');
  assert.equal(typeof rotate.json.error, 'string');

  const start = await request(ctx.port, '/auth/google/login?next=%2Fanimate');
  assert.equal(start.status, 302);
  assert.equal(start.headers.location, '/login?error=not_configured');
  assert.equal(cookieFrom(start, 'virtually_oauth'), null);
  assertLoginFailed(await request(ctx.port, '/auth/google/callback?code=x&state=y'), 'not_configured');

  for (const pathname of ['/', '/animate', '/overlay', '/login', '/app.js', '/login.js', '/auth.js']) {
    assert.equal((await request(ctx.port, pathname)).status, 200, pathname);
  }
  assert.equal((await request(ctx.port, '/api/library')).status, 200);
  assert.equal((await request(ctx.port, '/api/trigger', { method: 'POST', ...json({ id: 'demo' }) })).status, 200);
  const events = await openStream(ctx.port, '/api/events');
  assert.equal(events.status, 200);
  await events.waitFor(/"type":"library"/);
  events.close();
  assert.deepEqual((await request(ctx.port, '/auth/logout', { method: 'POST', ...json({}) })).json, { ok: true });
  assert.deepEqual(ctx.google.requests, { authorize: 0, token: 0, jwks: 0 });

  // The secrets file exists from startup, even while login is off.
  const state = await readState(ctx.dataDir);
  assert.match(state.sessionSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(state.overlayKey, /^[A-Za-z0-9_-]{32}$/);
});

test('enabled, signed out: pages redirect to /login with next, APIs answer 401, assets stay public', async t => {
  const ctx = await setup(t);
  for (const [pathname, next] of [['/', '/'], ['/animate?tab=jobs', '/animate?tab=jobs'], ['/nope', '/nope']]) {
    const response = await request(ctx.port, pathname);
    assert.equal(response.status, 302, pathname);
    assert.equal(response.headers.location, `/login?next=${encodeURIComponent(next)}`, pathname);
  }
  assert.equal((await request(ctx.port, '/animate', { method: 'HEAD' })).status, 302);

  const denied = [
    ['GET', '/api/library'], ['GET', '/api/events'], ['POST', '/api/trigger'], ['POST', '/api/idle'],
    ['GET', '/api/auth/me'], ['POST', '/api/auth/overlay-key'], ['GET', '/api/animate/status'],
    ['DELETE', '/api/media/0f0e0d0c-0b0a-4900-8800-706050403020'], ['POST', '/api/obs-source'], ['POST', '/nope'],
  ];
  for (const [method, pathname] of denied) {
    const response = await request(ctx.port, pathname, { method, ...(method === 'GET' || method === 'DELETE' ? {} : json({ id: 'demo' })) });
    assert.equal(response.status, 401, `${method} ${pathname}`);
    assert.deepEqual(response.json, AUTH_REQUIRED, `${method} ${pathname}`);
    assert.equal(response.headers['x-virtually-auth'], 'required', `${method} ${pathname}`);
  }

  for (const pathname of ['/app.js', '/app.css', '/motions.js', '/animate.js', '/animate.css', '/overlay.js', '/overlay.css', '/login.css', '/login.js', '/auth.css', '/auth.js']) {
    const response = await request(ctx.port, pathname);
    assert.equal(response.status, 200, pathname);
    assert.doesNotMatch(response.headers['content-type'], /html/, pathname);
  }
  const loginPage = await request(ctx.port, '/login?next=%2Fanimate');
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers['content-type'], /^text\/html/);
  assert.equal((await request(ctx.port, '/login', { method: 'HEAD' })).status, 200);

  const overlay = await request(ctx.port, '/overlay');
  assert.equal(overlay.status, 401);
  assert.match(overlay.headers['content-type'], /^text\/html/);
  assert.equal(overlay.headers['x-virtually-auth'], 'required');
  assert.ok(overlay.text.includes(OVERLAY_LINE));
  assert.match(overlay.text, /background:transparent/);
  const overlayHead = await request(ctx.port, '/overlay', { method: 'HEAD' });
  assert.equal(overlayHead.status, 401);
  assert.equal(overlayHead.text, '');

  const status = await request(ctx.port, '/api/auth/status');
  assert.deepEqual(status.json, {
    mode: 'enabled', problem: null, loggedIn: false,
    redirectUri: `http://${ctx.host}/auth/google/callback`, configPath: 'data/auth/config.json',
  });
});

test('overlay key: /overlay?key sets the overlay cookie, which opens the overlay routes only', async t => {
  const id = '0f0e0d0c-0b0a-4900-8800-706050403020';
  const bytes = Buffer.from('0000ftypisom-fake-mp4-body');
  const ctx = await setup(t, {
    seed: async dataDir => {
      await fs.mkdir(path.join(dataDir, 'media'), { recursive: true });
      await fs.writeFile(path.join(dataDir, 'media', `${id}.mp4`), bytes);
      await fs.writeFile(path.join(dataDir, 'library.json'), JSON.stringify({
        idle: null,
        motions: [{ id, name: 'wave', kind: 'motion', mime: 'video/mp4', url: `/api/media/${id}`, createdAt: new Date(START).toISOString(), fit: null }],
      }));
    },
  });
  const { overlayKey } = await readState(ctx.dataDir);

  assert.equal((await request(ctx.port, '/overlay?key=wrong-key')).status, 401);
  assert.equal((await request(ctx.port, '/overlay', { cookie: 'virtually_overlay=wrong-key' })).status, 401);
  // ?key only counts on /overlay itself.
  assert.equal((await request(ctx.port, `/api/library?key=${overlayKey}`)).status, 401);

  const keyed = await request(ctx.port, `/overlay?key=${encodeURIComponent(overlayKey)}`);
  assert.equal(keyed.status, 200);
  assert.match(keyed.headers['content-type'], /^text\/html/);
  const overlayCookie = cookieFrom(keyed, 'virtually_overlay');
  assert.deepEqual(overlayCookie, {
    name: 'virtually_overlay', value: overlayKey,
    attrs: { httponly: true, samesite: 'Lax', path: '/', 'max-age': '34560000' },
  });

  const cookie = `virtually_overlay=${overlayKey}`;
  assert.equal((await request(ctx.port, '/overlay', { cookie })).status, 200);
  assert.equal((await request(ctx.port, '/overlay', { method: 'HEAD', cookie })).status, 200);
  const library = await request(ctx.port, '/api/library', { cookie });
  assert.equal(library.status, 200);
  assert.equal(library.json.motions[0].id, id);
  const media = await request(ctx.port, `/api/media/${id}`, { cookie });
  assert.equal(media.status, 200);
  assert.equal(media.text, bytes.toString());
  assert.equal((await request(ctx.port, `/api/media/${id}`, { method: 'HEAD', cookie })).status, 200);
  assert.equal((await request(ctx.port, '/api/obs-source', { cookie })).status, 200);
  const reported = await request(ctx.port, '/api/obs-source', { method: 'POST', cookie, ...json({ width: 800, height: 600 }) });
  assert.equal(reported.status, 200);
  assert.deepEqual(reported.json, { width: 800, height: 600 });
  const events = await openStream(ctx.port, '/api/events', cookie);
  assert.equal(events.status, 200);
  await events.waitFor(/"type":"obs-source"/);
  events.close();
  await within(events.ended, 5000, 'stream closed');

  for (const [method, pathname] of [
    ['POST', '/api/trigger'], ['POST', '/api/idle'], ['POST', '/api/upload?kind=motion&name=x&filename=x.webm'],
    ['GET', '/api/animate/status'], ['GET', '/api/auth/me'], ['POST', '/api/auth/overlay-key'], ['DELETE', `/api/media/${id}`],
  ]) {
    const response = await request(ctx.port, pathname, { method, cookie, ...(method === 'POST' ? json({ id: 'demo' }) : {}) });
    assert.equal(response.status, 401, `${method} ${pathname}`);
    assert.equal(response.headers['x-virtually-auth'], 'required', `${method} ${pathname}`);
  }
  for (const pathname of ['/', '/animate']) {
    assert.equal((await request(ctx.port, pathname, { cookie })).status, 302, pathname);
  }
  // The file is still there: the refused DELETE did nothing.
  await fs.stat(path.join(ctx.dataDir, 'media', `${id}.mp4`));
});

test('full login flow: authorize request, cookies, callback, /api/auth/me, logout', async t => {
  const ctx = await setup(t);
  const flow = await login(ctx, { next: '/animate?x=1' });

  const authorize = flow.authorizeUrl;
  assert.equal(`${authorize.origin}${authorize.pathname}`, ctx.google.endpoints.authorize);
  const params = Object.fromEntries(authorize.searchParams);
  assert.deepEqual(Object.keys(params).sort(), [
    'client_id', 'code_challenge', 'code_challenge_method', 'nonce', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
  ]);
  assert.equal(params.client_id, CLIENT_ID);
  assert.equal(params.redirect_uri, `http://${ctx.host}/auth/google/callback`);
  assert.equal(params.response_type, 'code');
  assert.equal(params.scope, 'openid email profile');
  assert.equal(params.code_challenge_method, 'S256');
  assert.equal(params.prompt, 'select_account');

  assert.deepEqual(flow.oauth.attrs, { httponly: true, samesite: 'Lax', path: '/auth/google', 'max-age': '600' });
  const attempt = decodeSigned(flow.oauth.value);
  assert.equal(attempt.state, params.state);
  assert.equal(attempt.nonce, params.nonce);
  assert.match(attempt.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(params.code_challenge, crypto.createHash('sha256').update(attempt.verifier).digest('base64url'));
  assert.equal(attempt.next, '/animate?x=1');
  assert.equal(attempt.exp, START_SEC + 600);

  assert.equal(flow.callback.status, 302);
  assert.equal(flow.callback.headers.location, '/animate?x=1');
  assert.deepEqual(flow.session.attrs, { httponly: true, samesite: 'Lax', path: '/', 'max-age': '2592000' });
  const cleared = cookieFrom(flow.callback, 'virtually_oauth');
  assert.deepEqual(cleared, { name: 'virtually_oauth', value: '', attrs: { httponly: true, samesite: 'Lax', path: '/auth/google', 'max-age': '0' } });
  assert.deepEqual(decodeSigned(flow.session.value), {
    v: 1, sub: '109876543210987654321', email: 'streamer@example.com', name: 'Test Streamer',
    picture: 'https://lh3.googleusercontent.com/a/test-picture', iat: START_SEC, exp: START_SEC + 2592000,
  });

  const cookie = flow.cookie;
  const { overlayKey } = await readState(ctx.dataDir);
  const me = await request(ctx.port, '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, {
    enabled: true,
    user: { email: 'streamer@example.com', name: 'Test Streamer', picture: 'https://lh3.googleusercontent.com/a/test-picture' },
    overlayKey,
  });
  assert.equal((await request(ctx.port, '/api/auth/status', { cookie })).json.loggedIn, true);
  for (const pathname of ['/', '/animate', '/overlay', '/api/library', '/api/animate/status']) {
    assert.equal((await request(ctx.port, pathname, { cookie })).status, 200, pathname);
  }
  assert.equal((await request(ctx.port, '/api/trigger', { method: 'POST', cookie, ...json({ id: 'demo' }) })).status, 200);
  // Signed in already: /login goes straight to next.
  assert.equal((await request(ctx.port, '/login', { cookie })).headers.location, '/');
  assert.equal((await request(ctx.port, '/login?next=%2Fanimate', { cookie })).headers.location, '/animate');

  const logout = await request(ctx.port, '/auth/logout', { method: 'POST', cookie, ...json({}) });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.json, { ok: true });
  assert.deepEqual(cookieFrom(logout, 'virtually_session'), {
    name: 'virtually_session', value: '', attrs: { httponly: true, samesite: 'Lax', path: '/', 'max-age': '0' },
  });

  // A missing name and picture come back as null.
  ctx.google.setUser({ sub: 'second-user', email: 'streamer@example.com', name: undefined, picture: undefined });
  const second = await signIn(ctx);
  assert.deepEqual((await request(ctx.port, '/api/auth/me', { cookie: second })).json.user, { email: 'streamer@example.com', name: null, picture: null });

  // One line per outcome, and nothing secret in the log.
  assert.ok(ctx.logs.includes('[auth] login ok streamer@example.com'), ctx.logs.join('\n'));
  const logText = ctx.logs.join('\n');
  const state = await readState(ctx.dataDir);
  for (const secret of [CLIENT_SECRET, state.sessionSecret, state.overlayKey, attempt.state, attempt.nonce, attempt.verifier, flow.back.searchParams.get('code'), flow.session.value]) {
    assert.ok(!logText.includes(secret), 'a secret reached the log');
  }
});

test('callback failures clear the login cookie, set no session and say why', async t => {
  const ctx = await setup(t);
  const cases = [
    // First, while the JWKS is not cached yet.
    { label: 'jwks request fails', code: 'google_error', fail: 'jwks_500' },
    { label: 'state differs', code: 'state_mismatch', mutate: ({ callbackPath, cookie }) => ({ callbackPath: callbackPath.replace(/state=[^&]+/, 'state=somebody-else'), cookie }) },
    { label: 'no oauth cookie', code: 'state_mismatch', mutate: ({ callbackPath }) => ({ callbackPath, cookie: undefined }) },
    {
      label: 'tampered oauth cookie', code: 'state_mismatch',
      mutate: ({ callbackPath, oauth }) => {
        const [body, mac] = oauth.value.split('.');
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        const forged = Buffer.from(JSON.stringify({ ...payload, next: '/animate' })).toString('base64url');
        return { callbackPath, cookie: `virtually_oauth=${forged}.${mac}` };
      },
    },
    { label: 'oauth cookie signed with another secret', code: 'state_mismatch', mutate: ({ callbackPath, oauth }) => ({ callbackPath, cookie: `virtually_oauth=${sign(decodeSigned(oauth.value), 'another-secret')}` }) },
    { label: 'expired oauth cookie', code: 'state_mismatch', mutate: input => { ctx.clock.advance(601 * 1000); return input; } },
    { label: 'user cancelled', code: 'cancelled', fail: 'access_denied' },
    { label: 'token endpoint 400', code: 'google_error', fail: 'token_400' },
    { label: 'token endpoint 500', code: 'google_error', fail: 'token_500' },
    { label: 'token without id_token', code: 'google_error', fail: 'token_no_id_token' },
    { label: 'bad signature', code: 'invalid_token', fail: 'bad_signature' },
    { label: 'unknown kid', code: 'invalid_token', fail: 'unknown_kid' },
    { label: 'alg none', code: 'invalid_token', fail: 'alg_none' },
    { label: 'alg other than RS256', code: 'invalid_token', fail: 'wrong_alg' },
    { label: 'wrong aud', code: 'invalid_token', fail: 'wrong_aud' },
    { label: 'wrong iss', code: 'invalid_token', fail: 'wrong_iss' },
    { label: 'expired id token', code: 'invalid_token', fail: 'expired' },
    { label: 'iat in the future', code: 'invalid_token', fail: 'future_iat' },
    { label: 'nonce mismatch', code: 'invalid_token', fail: 'bad_nonce' },
    { label: 'aud array without our azp', code: 'invalid_token', user: { aud: [CLIENT_ID, 'other-client'], azp: 'other-client' } },
    { label: 'email not verified', code: 'email_unverified', user: { email_verified: false } },
    { label: 'email_verified as a string', code: 'email_unverified', user: { email_verified: 'true' } },
    { label: 'not on the allowlist', code: 'not_allowed', user: { email: 'Intruder@Gmail.com' } },
  ];
  for (const item of cases) {
    ctx.google.fail(item.fail || null);
    ctx.google.setUser({ email: 'streamer@example.com', email_verified: true, aud: undefined, azp: undefined, ...item.user });
    const flow = await login(ctx, { mutateCallback: item.mutate });
    assertLoginFailed(flow.callback, item.code, item.label);
  }
  const notAllowed = new URL((await login(ctx)).callback.headers.location, 'http://app.invalid');
  assert.equal(notAllowed.search, '?error=not_allowed&email=intruder%40gmail.com');
  assert.ok(ctx.logs.includes('[auth] login denied not_allowed intruder@gmail.com'));
  assert.ok(ctx.logs.includes('[auth] google token error 400 invalid_grant'));
  assert.ok(ctx.logs.includes('[auth] login cancelled'));
  assert.ok(ctx.logs.some(line => line.startsWith('[auth] login failed invalid_token (wrong aud)')));

  // An aud array is fine when azp is our client; a replayed callback is refused by Google.
  ctx.google.fail(null);
  ctx.google.setUser({ email: 'streamer@example.com', aud: [CLIENT_ID, 'other-client'], azp: CLIENT_ID });
  const ok = await login(ctx);
  assert.ok(ok.cookie, ok.callback.headers.location);
  const replay = await request(ctx.port, ok.back.pathname + ok.back.search, { cookie: `virtually_oauth=${ok.oauth.value}` });
  assertLoginFailed(replay, 'google_error', 'replayed code');

  // A Google error other than access_denied.
  assertLoginFailed(await request(ctx.port, '/auth/google/callback?error=server_error&state=x'), 'google_error', 'google error');
  assertLoginFailed(await request(ctx.port, `/auth/google/callback?state=${ok.authorizeUrl.searchParams.get('state')}`, { cookie: `virtually_oauth=${ok.oauth.value}` }), 'google_error', 'no code');
});

test('allowlist: @domain entries, case-insensitive match, edits log accounts out', async t => {
  const ctx = await setup(t, { authConfig: config({ allowedEmails: ['@example.com', '  VIP@Gmail.com  '] }) });
  for (const [email, allowed] of [
    ['anyone@example.com', true], ['Mixed.Case@EXAMPLE.com', true], ['vip@gmail.com', true],
    ['someone@sub.example.com', false], ['someone@notexample.com', false], ['other@gmail.com', false],
  ]) {
    ctx.google.setUser({ email });
    const flow = await login(ctx);
    if (allowed) assert.ok(flow.cookie, `${email} allowed`);
    else assertLoginFailed(flow.callback, 'not_allowed', email);
  }
  assert.equal(isEmailAllowed(['@example.com'], 'a@example.com'), true);
  assert.equal(isEmailAllowed(['@example.com'], 'example.com'), false);

  ctx.google.setUser({ email: 'anyone@example.com' });
  const cookie = await signIn(ctx);
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie })).status, 200);
  await writeConfig(ctx.dataDir, config({ allowedEmails: ['vip@gmail.com'] }));
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie })).status, 401);
  assert.equal((await request(ctx.port, '/', { cookie })).status, 302);
  assert.equal((await request(ctx.port, '/api/auth/status', { cookie })).json.loggedIn, false);
  await writeConfig(ctx.dataDir, config({ allowedEmails: ['vip@gmail.com', '@example.com'] }));
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie })).status, 200);
});

test('sessions: tampered and expired cookies are refused, renewal slides after 24 h', async t => {
  const ctx = await setup(t);
  const cookie = await signIn(ctx);
  const value = cookie.slice('virtually_session='.length);
  const [body, mac] = value.split('.');
  const payload = decodeSigned(value);
  const { sessionSecret, overlayKey } = await readState(ctx.dataDir);
  const forgedBody = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 10 * 365 * 86400 })).toString('base64url');
  for (const [label, bad] of [
    ['payload changed', `${forgedBody}.${mac}`],
    ['mac changed', `${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`],
    ['no mac', body],
    ['other secret', sign(payload, 'not-the-session-secret')],
    ['garbage', 'abc.def'],
    ['not a session payload', sign({ state: 's', nonce: 'n', verifier: 'v', next: '/', exp: payload.exp }, sessionSecret)],
  ]) {
    assert.equal((await request(ctx.port, '/api/auth/me', { cookie: `virtually_session=${bad}` })).status, 401, label);
  }
  // A forged cookie next to a real one does not hide the real one.
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie: `virtually_session=abc.def; ${cookie}` })).status, 200);

  ctx.clock.advance(23 * 60 * 60 * 1000);
  const early = await request(ctx.port, '/api/library', { cookie });
  assert.equal(early.status, 200);
  assert.equal(cookieFrom(early, 'virtually_session'), null, 'no renewal before 24 h');

  ctx.clock.advance(60 * 60 * 1000 + 1000);
  const renewedAt = Math.floor(ctx.clock.now() / 1000);
  const late = await request(ctx.port, `/overlay?key=${overlayKey}`, { cookie });
  assert.equal(late.status, 200);
  const renewed = cookieFrom(late, 'virtually_session');
  assert.ok(renewed, 'renewed after 24 h');
  assert.deepEqual(renewed.attrs, { httponly: true, samesite: 'Lax', path: '/', 'max-age': '2592000' });
  assert.deepEqual(decodeSigned(renewed.value), { ...payload, iat: renewedAt, exp: renewedAt + 2592000 });
  assert.ok(cookieFrom(late, 'virtually_overlay'), 'both Set-Cookie values arrive');
  const renewedCookie = `virtually_session=${renewed.value}`;

  // 30 days after the first login: the old cookie is expired, the renewed one is not.
  ctx.clock.t = START + 30 * DAY + 1000;
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie })).status, 401);
  assert.equal((await request(ctx.port, '/animate', { cookie })).status, 302);
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie: renewedCookie })).status, 200);
  ctx.clock.t = (renewedAt + 2592000) * 1000;
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie: renewedCookie })).status, 401);
});

test('next validation keeps every post-login redirect on this site', async t => {
  const bad = [
    undefined, '', 'animate', '//evil.com', '//evil.com/animate', 'https://evil.com', '/\\evil.com', '/login', '/login?next=%2F',
    '/login/', '/auth/x', '/auth/google/login', '/auth', '/a\r\nSet-Cookie: x=1', '/a\nb', '/\t/evil.com', '/a\u0000b', '/a\u0085b',
    `/${'a'.repeat(2000)}`, `/${'한'.repeat(300)}`,
  ];
  for (const value of bad) assert.equal(safeNext(value), '/', JSON.stringify(value));
  for (const value of ['/', '/animate', '/animate?tab=jobs#top', '/%ED%95%9C', '/.//evil.com', `/${'a'.repeat(1999)}`]) {
    assert.equal(safeNext(value), value, value);
  }
  assert.equal(safeNext('/한글 이름'), '/%ED%95%9C%EA%B8%80%20%EC%9D%B4%EB%A6%84');

  const ctx = await setup(t);
  const cookie = await signIn(ctx);
  for (const value of bad.filter(item => item !== undefined)) {
    const start = await request(ctx.port, `/auth/google/login?next=${encodeURIComponent(value)}`);
    assert.equal(decodeSigned(cookieFrom(start, 'virtually_oauth').value).next, '/', JSON.stringify(value));
    assert.equal((await request(ctx.port, `/login?next=${encodeURIComponent(value)}`, { cookie })).headers.location, '/', JSON.stringify(value));
  }
  const flow = await login(ctx, { next: '//evil.com' });
  assert.equal(flow.callback.headers.location, '/');
});

test('overlay key rotation: the old key stops at once, its streams close, session streams stay', async t => {
  const ctx = await setup(t);
  const cookie = await signIn(ctx);
  const oldKey = (await request(ctx.port, '/api/auth/me', { cookie })).json.overlayKey;
  const overlayStream = await openStream(ctx.port, '/api/events', `virtually_overlay=${oldKey}`);
  const sessionStream = await openStream(ctx.port, '/api/events', cookie);
  t.after(() => { overlayStream.close(); sessionStream.close(); });
  assert.equal(overlayStream.status, 200);
  assert.equal(sessionStream.status, 200);
  await overlayStream.waitFor(/"type":"obs-source"/);
  await sessionStream.waitFor(/"type":"obs-source"/);

  assert.equal((await request(ctx.port, '/api/auth/overlay-key', { method: 'POST', cookie, body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const rotated = await request(ctx.port, '/api/auth/overlay-key', { method: 'POST', cookie, ...json({}) });
  assert.equal(rotated.status, 200);
  const newKey = rotated.json.overlayKey;
  assert.match(newKey, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(newKey, oldKey);
  assert.equal((await readState(ctx.dataDir)).overlayKey, newKey);
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie })).json.overlayKey, newKey);

  await within(overlayStream.ended, 5000, 'the stream admitted by the old key was not closed');
  const played = await request(ctx.port, '/api/trigger', { method: 'POST', cookie, ...json({ id: 'demo' }) });
  assert.equal(played.status, 200);
  await sessionStream.waitFor(/"type":"play"/);

  assert.equal((await request(ctx.port, `/overlay?key=${oldKey}`)).status, 401);
  assert.equal((await request(ctx.port, '/api/library', { cookie: `virtually_overlay=${oldKey}` })).status, 401);
  assert.equal((await request(ctx.port, `/overlay?key=${newKey}`)).status, 200);
  assert.equal((await request(ctx.port, '/api/library', { cookie: `virtually_overlay=${newKey}` })).status, 200);
});

test('invalid config fails closed, reports each problem, and recovers when fixed', async t => {
  const problems = [
    ['{"google": {', 'invalid_json'], ['not json', 'invalid_json'], ['[]', 'invalid_json'], ['null', 'invalid_json'],
    [{ allowedEmails: ['a@example.com'] }, 'missing_client'],
    [config({ google: { clientId: CLIENT_ID } }), 'missing_client'],
    [config({ google: { clientId: '  ', clientSecret: CLIENT_SECRET } }), 'missing_client'],
    [config({ google: 'id:secret' }), 'missing_client'],
    [config({ allowedEmails: undefined }), 'no_allowed_emails'],
    [config({ allowedEmails: [] }), 'no_allowed_emails'],
    [config({ allowedEmails: ['', '   ', 42] }), 'no_allowed_emails'],
    [config({ allowedEmails: 'a@example.com' }), 'no_allowed_emails'],
    [config({ publicUrl: 'https://virtually.example.com/app' }), 'bad_public_url'],
    [config({ publicUrl: 'https://virtually.example.com/?x=1' }), 'bad_public_url'],
    [config({ publicUrl: 'https://virtually.example.com/#top' }), 'bad_public_url'],
    [config({ publicUrl: 'https://virtually.example.com?' }), 'bad_public_url'],
    [config({ publicUrl: 'ftp://virtually.example.com' }), 'bad_public_url'],
    [config({ publicUrl: 'https://user:pw@virtually.example.com' }), 'bad_public_url'],
    [config({ publicUrl: 'virtually.example.com' }), 'bad_public_url'],
    [config({ publicUrl: 42 }), 'bad_public_url'],
  ];
  for (const [value, problem] of problems) {
    assert.equal(parseAuthConfig(typeof value === 'string' ? value : JSON.stringify(value)).problem, problem, JSON.stringify(value));
  }
  for (const publicUrl of ['https://virtually.example.com', 'https://virtually.example.com/', 'http://192.168.0.10:8787', '', null]) {
    assert.equal(parseAuthConfig(JSON.stringify(config({ publicUrl }))).mode, 'enabled', String(publicUrl));
  }
  assert.equal(parseAuthConfig(`\uFEFF${JSON.stringify(config())}`).mode, 'enabled', 'a UTF-8 BOM is fine');

  const ctx = await setup(t);
  const cookie = await signIn(ctx);
  const { overlayKey } = await readState(ctx.dataDir);
  for (const [value, problem] of problems) {
    await writeConfig(ctx.dataDir, value);
    const status = await request(ctx.port, '/api/auth/status', { cookie });
    assert.deepEqual(status.json, {
      mode: 'invalid', problem, loggedIn: false, redirectUri: `http://${ctx.host}/auth/google/callback`, configPath: 'data/auth/config.json',
    }, JSON.stringify(value));
  }

  // Locked: even a valid session or overlay key gets nothing but the public routes.
  for (const pathname of ['/', '/animate?tab=jobs', '/nope']) {
    const response = await request(ctx.port, pathname, { cookie });
    assert.equal(response.status, 302, pathname);
    assert.equal(response.headers.location, '/login', pathname);
  }
  for (const [method, pathname] of [['GET', '/api/library'], ['GET', '/api/auth/me'], ['POST', '/api/trigger'], ['POST', '/api/auth/overlay-key'], ['GET', '/api/events']]) {
    const response = await request(ctx.port, pathname, { method, cookie: `${cookie}; virtually_overlay=${overlayKey}`, ...(method === 'POST' ? json({ id: 'demo' }) : {}) });
    assert.equal(response.status, 503, `${method} ${pathname}`);
    assert.deepEqual(response.json, MISCONFIGURED, `${method} ${pathname}`);
  }
  const overlay = await request(ctx.port, `/overlay?key=${overlayKey}`, { cookie });
  assert.equal(overlay.status, 503);
  assert.match(overlay.headers['content-type'], /^text\/html/);
  assert.equal(cookieFrom(overlay, 'virtually_overlay'), null);
  for (const pathname of ['/login', '/app.js', '/login.js', '/auth.css']) {
    assert.equal((await request(ctx.port, pathname)).status, 200, pathname);
  }
  assert.equal((await request(ctx.port, '/auth/google/login')).headers.location, '/login?error=config_invalid');
  assertLoginFailed(await request(ctx.port, '/auth/google/callback?code=x&state=y'), 'config_invalid');
  assert.equal((await request(ctx.port, '/auth/logout', { method: 'POST', ...json({}) })).status, 200);
  assert.ok(ctx.logs.includes('[auth] Google login config problem: bad_public_url (data/auth/config.json) - the app stays locked until it is fixed'), ctx.logs.join('\n'));

  // An editor saving in two steps: partial JSON stays locked until the write completes.
  const full = JSON.stringify(config(), null, 2);
  await writeConfig(ctx.dataDir, full.slice(0, 20));
  assert.equal((await request(ctx.port, '/api/auth/status')).json.problem, 'invalid_json');
  await writeConfig(ctx.dataDir, full);
  assert.equal((await request(ctx.port, '/api/auth/status')).json.mode, 'enabled');
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie })).status, 200, 'the session works again once fixed');
});

test('config hot reload: created, removed, and checked at most once per configCheckIntervalMs', async t => {
  const ctx = await setup(t, { authConfig: null });
  assert.equal((await request(ctx.port, '/api/library')).status, 200);
  await writeConfig(ctx.dataDir, config());
  assert.equal((await request(ctx.port, '/api/library')).status, 401);
  assert.ok(ctx.logs.includes('[auth] Google login: on (1 allowed entry)'), ctx.logs.join('\n'));
  await fs.rm(path.join(ctx.dataDir, 'auth', 'config.json'));
  assert.equal((await request(ctx.port, '/api/library')).status, 200);
  assert.equal((await request(ctx.port, '/api/auth/status')).json.mode, 'disabled');

  // Throttled: an edit is picked up only once the interval has passed.
  await stopApp(ctx);
  ctx.interval = 60000;
  await startApp(ctx);
  assert.equal((await request(ctx.port, '/api/library')).status, 200);
  await writeConfig(ctx.dataDir, config({ allowedEmails: ['a@example.com', '@example.org'] }));
  assert.equal((await request(ctx.port, '/api/library')).status, 200);
  ctx.clock.advance(59000);
  assert.equal((await request(ctx.port, '/api/library')).status, 200);
  ctx.clock.advance(1000);
  assert.equal((await request(ctx.port, '/api/library')).status, 401);
  assert.equal(ctx.server.auth.summary().allowedCount, 2);
});

test('publicUrl: its Host and Origin are accepted, https redirect URI, Secure cookies', async t => {
  const ctx = await setup(t, { authConfig: config({ publicUrl: `https://${PUBLIC_HOST}/` }) });
  const onPublic = { Host: PUBLIC_HOST };
  const status = await request(ctx.port, '/api/auth/status', { headers: onPublic });
  assert.equal(status.status, 200, 'the public Host passes the loopback Host check');
  assert.equal(status.json.redirectUri, `https://${PUBLIC_HOST}/auth/google/callback`);
  assert.equal((await request(ctx.port, '/api/auth/status')).json.redirectUri, `http://${ctx.host}/auth/google/callback`);
  assert.equal((await request(ctx.port, '/api/auth/status', { headers: { Host: 'evil.example.com' } })).status, 403);
  assert.equal((await request(ctx.port, '/api/auth/status', { headers: { Host: `${PUBLIC_HOST}:8443` } })).status, 403);

  const flow = await login(ctx, { host: PUBLIC_HOST, next: '/animate' });
  assert.equal(flow.authorizeUrl.searchParams.get('redirect_uri'), `https://${PUBLIC_HOST}/auth/google/callback`);
  assert.equal(flow.oauth.attrs.secure, true);
  assert.equal(`${flow.back.origin}${flow.back.pathname}`, `https://${PUBLIC_HOST}/auth/google/callback`);
  assert.equal(flow.callback.headers.location, '/animate');
  assert.equal(flow.session.attrs.secure, true);
  assert.equal(cookieFrom(flow.callback, 'virtually_oauth').attrs.secure, true);
  const cookie = flow.cookie;
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie, headers: onPublic })).status, 200);

  // On the loopback host the cookies are not Secure (plain http).
  const local = await login(ctx);
  assert.equal(local.session.attrs.secure, undefined);
  assert.equal(local.oauth.attrs.secure, undefined);

  const { overlayKey } = await readState(ctx.dataDir);
  assert.equal(cookieFrom(await request(ctx.port, `/overlay?key=${overlayKey}`, { headers: onPublic }), 'virtually_overlay').attrs.secure, true);

  const publicOrigin = { Host: PUBLIC_HOST, Origin: `https://${PUBLIC_HOST}`, 'Sec-Fetch-Site': 'same-origin' };
  const trigger = await request(ctx.port, '/api/trigger', { method: 'POST', cookie, headers: { ...publicOrigin, 'Content-Type': 'application/json' }, body: '{"id":"demo"}' });
  assert.equal(trigger.status, 200);
  const crossHost = await request(ctx.port, '/auth/logout', { method: 'POST', cookie, headers: { Origin: `https://${PUBLIC_HOST}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossHost.status, 403, 'the public origin only counts on the public host');
  const foreign = await request(ctx.port, '/auth/logout', { method: 'POST', cookie, headers: { Host: PUBLIC_HOST, Origin: 'https://evil.example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const logout = await request(ctx.port, '/auth/logout', { method: 'POST', cookie, headers: { ...publicOrigin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.deepEqual(cookieFrom(logout, 'virtually_session').attrs, { httponly: true, samesite: 'Lax', path: '/', 'max-age': '0', secure: true });
});

test('state.json: 0600 in a 0700 dir, and the overlay key and sessions survive a restart', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-auth-state-'));
  const ctx = { dataDir, clock: makeClock(), interval: 0, logs: [] };
  ctx.google = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: ctx.clock.now });
  t.after(async () => {
    await stopApp(ctx);
    await ctx.google.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  // A loose directory made by hand is tightened on startup.
  await fs.mkdir(path.join(dataDir, 'auth'), { mode: 0o755 });
  await fs.chmod(path.join(dataDir, 'auth'), 0o755);
  await writeConfig(dataDir, config());
  await startApp(ctx);
  const statePath = path.join(dataDir, 'auth', 'state.json');
  assert.equal((await fs.stat(path.join(dataDir, 'auth'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  const before = await fs.readFile(statePath, 'utf8');

  const cookie = await signIn(ctx);
  const { overlayKey } = (await request(ctx.port, '/api/auth/me', { cookie })).json;
  await stopApp(ctx);
  await fs.chmod(statePath, 0o644);

  await startApp(ctx);
  assert.equal(await fs.readFile(statePath, 'utf8'), before, 'secrets kept across restarts');
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  const me = await request(ctx.port, '/api/auth/me', { cookie });
  assert.equal(me.status, 200, 'the session survives a restart');
  assert.equal(me.json.overlayKey, overlayKey);
  assert.equal((await request(ctx.port, `/overlay?key=${overlayKey}`)).status, 200);
  await stopApp(ctx);

  // A broken state file is replaced (which signs everyone out and changes the key).
  await fs.writeFile(statePath, '{"sessionSecret": 1');
  await startApp(ctx);
  const replaced = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.notEqual(replaced.overlayKey, overlayKey);
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await request(ctx.port, '/api/auth/me', { cookie })).status, 401);
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'auth'))).filter(name => name.endsWith('.tmp')), []);
});

test('JWKS: cached by max-age, an unknown kid refetches at most once per 60 s', async t => {
  const ctx = await setup(t);
  await signIn(ctx);
  await signIn(ctx);
  assert.equal(ctx.google.requests.jwks, 1, 'the second login uses the cached keys');

  ctx.google.rotateKey();
  ctx.clock.advance(30 * 1000);
  assertLoginFailed((await login(ctx)).callback, 'invalid_token', 'new kid within 60 s of the last fetch');
  assert.equal(ctx.google.requests.jwks, 1);
  ctx.clock.advance(31 * 1000);
  await signIn(ctx);
  assert.equal(ctx.google.requests.jwks, 2, 'refetched for the new kid');

  ctx.clock.advance(3601 * 1000);
  await signIn(ctx);
  assert.equal(ctx.google.requests.jwks, 3, 'refetched after max-age');
});
