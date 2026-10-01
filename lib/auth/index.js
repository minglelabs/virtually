'use strict';

// Optional Google login for the controller. createAuth() owns the auth routes,
// the per-request access gate, the session and overlay-key cookies, and the
// hot-reloaded config. server.js calls, in order: refresh() (config), its Host
// and Origin checks (publicHost()/isPublicOrigin()), handleRoute(), gate(), and
// handleApi(), then its own routes.
//
// Modes: disabled (no config.json) -> no login at all; enabled -> login
// required; invalid -> fail closed until the file is fixed.
//
// Every request the gate admits carries `userId`: the Google sub whose data it
// may touch (the session's account, or the account an OBS overlay key belongs
// to), or null with login off (one shared workspace).

const path = require('node:path');

const { DISPLAY_CONFIG_PATH, createConfigWatcher, isEmailAllowed } = require('./config');
const { openStateStore } = require('./state');
const { LoginError, createGoogleClient, logSafe, randomToken } = require('./google');
const {
  OAUTH_COOKIE, OAUTH_MAX_AGE, OAUTH_PATH, OVERLAY_COOKIE, OVERLAY_MAX_AGE, SESSION_COOKIE, SESSION_MAX_AGE,
  SESSION_RENEW_AFTER, appendSetCookie, checkOauthPayload, checkSessionPayload, clearCookie, cookieValues,
  safeEqual, safeNext, serializeCookie, sessionPayload, sign, unixSeconds, verify,
} = require('./session');

const AUTH_REQUIRED = Object.freeze({ error: '로그인이 필요합니다.', code: 'auth_required' });
const AUTH_MISCONFIGURED = Object.freeze({ error: '로그인 설정 파일에 문제가 있습니다.', code: 'auth_misconfigured' });
const AUTH_DISABLED = Object.freeze({ error: 'Google 로그인이 꺼져 있어서 OBS 주소 키를 쓰지 않습니다.', code: 'auth_disabled' });
const OVERLAY_DENIED_TEXT = 'Virtually: OBS 주소의 키가 없거나 바뀌었습니다. 컨트롤러에서 OBS 주소를 다시 복사하세요.';
const OVERLAY_MISCONFIGURED_TEXT = 'Virtually: 로그인 설정 파일에 문제가 있습니다. data/auth/config.json을 확인하세요.';
const CALLBACK_PATH = '/auth/google/callback';

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// A tiny transparent page for the OBS browser source: one readable line.
function noticeHtml(text) {
  return '<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><title>Virtually</title>'
    + '<style>html,body{margin:0;background:transparent}'
    + 'p{margin:8px;font:13px/1.4 system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px #000}</style>'
    + `</head><body><p>${text}</p></body></html>\n`;
}

function describeMode(state) {
  if (state.mode === 'enabled') {
    const count = state.config.allowedEmails.length;
    return `Google login: on (${count} allowed ${count === 1 ? 'entry' : 'entries'})`;
  }
  if (state.mode === 'invalid') {
    return `Google login config problem: ${state.problem} (${DISPLAY_CONFIG_PATH}) - the app stays locked until it is fixed`;
  }
  return `Google login: off (no ${DISPLAY_CONFIG_PATH})`;
}

async function createAuth({
  dataDir,
  endpoints,
  now = Date.now,
  configCheckIntervalMs = 1000,
  log = message => console.log(message),
  sendJson,
  readBody,
  // (pathname) -> true for the static assets anyone may load (*.css, *.js).
  isPublicStatic = () => false,
} = {}) {
  if (!dataDir) throw new Error('createAuth needs dataDir.');
  const intervalMs = Number.isFinite(configCheckIntervalMs) && configCheckIntervalMs >= 0 ? configCheckIntervalMs : 1000;
  const authDir = path.join(dataDir, 'auth');
  const store = await openStateStore(authDir, { log });
  const google = createGoogleClient({ endpoints, now });

  let described = null;
  const watcher = createConfigWatcher(path.join(authDir, 'config.json'), {
    now,
    intervalMs,
    onChange(state) {
      // The startup state is printed by server.js; later edits are logged here.
      const text = describeMode(state);
      if (described !== null && text !== described) log(`[auth] ${text}`);
      described = text;
    },
  });
  await watcher.refresh();
  described = describeMode(watcher.current());

  // /api/events responses admitted by an overlay key alone, per account (closed on rotation).
  const overlayStreams = new Map(); // sub -> Set<res>

  const current = () => watcher.current();
  const secret = () => store.get().sessionSecret;
  const requestHost = req => String(req.headers.host || '').toLowerCase();

  function publicHost() {
    const { publicUrl } = current();
    return publicUrl ? publicUrl.host : null;
  }

  function viaPublicHost(req) {
    const host = publicHost();
    return host !== null && requestHost(req) === host;
  }

  // Cookies get Secure only when the request came in through an https publicUrl host.
  function secureRequest(req) {
    const { publicUrl } = current();
    return !!publicUrl && publicUrl.protocol === 'https:' && viaPublicHost(req);
  }

  // The non-GET Origin check also accepts publicUrl's origin, on that host only.
  function isPublicOrigin(req) {
    const { publicUrl } = current();
    return !!publicUrl && viaPublicHost(req) && String(req.headers.origin || '').toLowerCase() === publicUrl.origin;
  }

  function redirectUri(req) {
    const { publicUrl } = current();
    if (publicUrl && viaPublicHost(req)) return `${publicUrl.origin}${CALLBACK_PATH}`;
    return `http://${requestHost(req) || 'localhost'}${CALLBACK_PATH}`;
  }

  // The request's session payload when it is signed, unexpired and still allowed.
  function readSession(req) {
    const state = current();
    if (state.mode !== 'enabled') return null;
    const nowSec = unixSeconds(now());
    for (const value of cookieValues(req, SESSION_COOKIE)) {
      const payload = checkSessionPayload(verify(value, secret()), nowSec);
      if (payload && isEmailAllowed(state.config.allowedEmails, payload.email)) return payload;
    }
    return null;
  }

  function sessionCookie(req, payload) {
    return serializeCookie(SESSION_COOKIE, sign(payload, secret()), { path: '/', maxAge: SESSION_MAX_AGE, secure: secureRequest(req) });
  }

  // The account an overlay key belongs to, or null.
  function overlaySubFor(value) {
    return store.subForKey(value);
  }

  // The account of the first valid overlay-key cookie.
  function overlaySubFromCookie(req) {
    for (const value of cookieValues(req, OVERLAY_COOKIE)) {
      const sub = overlaySubFor(value);
      if (sub) return sub;
    }
    return null;
  }

  function redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  function sendNotice(req, res, status, text, headers = {}) {
    const body = Buffer.from(noticeHtml(text), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // public | overlay | session, per the access table (enabled mode).
  function accessClass(method, pathname) {
    const isRead = method === 'GET' || method === 'HEAD';
    if (isRead && pathname === '/login') return 'public';
    if (method === 'GET' && (pathname === '/auth/google/login' || pathname === CALLBACK_PATH)) return 'public';
    if (method === 'POST' && pathname === '/auth/logout') return 'public';
    if (method === 'GET' && pathname === '/api/auth/status') return 'public';
    if (isRead && isPublicStatic(pathname)) return 'public';
    if (isRead && pathname === '/overlay') return 'overlay';
    if (method === 'GET' && (pathname === '/api/library' || pathname === '/api/events')) return 'overlay';
    if (isRead && /^\/api\/media\/[^/]+$/.test(pathname)) return 'overlay';
    if ((method === 'GET' || method === 'POST') && pathname === '/api/obs-source') return 'overlay';
    return 'session';
  }

  function refuseSignedOut(req, res, url) {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && url.pathname === '/overlay') {
      return sendNotice(req, res, 401, OVERLAY_DENIED_TEXT, { 'X-Virtually-Auth': 'required' });
    }
    if (isRead && !isApiPath(url.pathname)) {
      return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    res.setHeader('X-Virtually-Auth', 'required');
    return sendJson(res, 401, AUTH_REQUIRED);
  }

  function refuseMisconfigured(req, res, url) {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && url.pathname === '/overlay') return sendNotice(req, res, 503, OVERLAY_MISCONFIGURED_TEXT);
    if (isRead && !isApiPath(url.pathname)) return redirect(res, '/login');
    return sendJson(res, 503, AUTH_MISCONFIGURED);
  }

  function trackOverlayStream(sub, res) {
    if (!overlayStreams.has(sub)) overlayStreams.set(sub, new Set());
    const streams = overlayStreams.get(sub);
    streams.add(res);
    res.on('close', () => {
      streams.delete(res);
      if (!streams.size && overlayStreams.get(sub) === streams) overlayStreams.delete(sub);
    });
  }

  // --- routes that run before the gate --------------------------------------

  function startLogin(req, res, url) {
    const state = current();
    if (state.mode === 'disabled') return redirect(res, '/login?error=not_configured');
    if (state.mode === 'invalid') return redirect(res, '/login?error=config_invalid');
    const attempt = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(),
      next: safeNext(url.searchParams.get('next')),
      exp: unixSeconds(now()) + OAUTH_MAX_AGE,
    };
    appendSetCookie(res, serializeCookie(OAUTH_COOKIE, sign(attempt, secret()), {
      path: OAUTH_PATH, maxAge: OAUTH_MAX_AGE, secure: secureRequest(req),
    }));
    return redirect(res, google.authorizeUrl({
      clientId: state.config.clientId, redirectUri: redirectUri(req),
      state: attempt.state, nonce: attempt.nonce, verifier: attempt.verifier,
    }));
  }

  async function finishLogin(req, res, url) {
    // Whatever happens next, this login attempt is over.
    appendSetCookie(res, clearCookie(OAUTH_COOKIE, { path: OAUTH_PATH, secure: secureRequest(req) }));
    const state = current();
    const fail = (code, line, email) => {
      log(`[auth] ${line}`);
      redirect(res, `/login?error=${code}${email ? `&email=${encodeURIComponent(email)}` : ''}`);
    };
    if (state.mode === 'disabled') return fail('not_configured', 'login failed not_configured');
    if (state.mode === 'invalid') return fail('config_invalid', `login failed config_invalid (${state.problem})`);
    const { clientId, clientSecret, allowedEmails } = state.config;
    try {
      const params = url.searchParams;
      const googleError = params.get('error');
      if (googleError === 'access_denied') throw new LoginError('cancelled', 'login cancelled');
      if (googleError) throw new LoginError('google_error', `google error ${logSafe(googleError)}`);
      const nowSec = unixSeconds(now());
      const attempts = cookieValues(req, OAUTH_COOKIE).map(value => checkOauthPayload(verify(value, secret()), nowSec)).filter(Boolean);
      if (!attempts.length) throw new LoginError('state_mismatch', 'login failed state_mismatch (no valid login cookie)');
      const attempt = attempts.find(candidate => safeEqual(params.get('state') || '', candidate.state));
      if (!attempt) throw new LoginError('state_mismatch', 'login failed state_mismatch (state differs)');
      const code = params.get('code');
      if (!code) throw new LoginError('google_error', 'google callback had no code');
      const idToken = await google.exchangeCode({ code, verifier: attempt.verifier, redirectUri: redirectUri(req), clientId, clientSecret });
      const user = await google.verifyIdToken(idToken, { clientId, nonce: attempt.nonce });
      if (!isEmailAllowed(allowedEmails, user.email)) throw Object.assign(new LoginError('not_allowed'), { email: user.email });
      appendSetCookie(res, sessionCookie(req, sessionPayload(user, unixSeconds(now()))));
      log(`[auth] login ok ${user.email}`);
      return redirect(res, safeNext(attempt.next));
    } catch (error) {
      if (!(error instanceof LoginError)) {
        return fail('google_error', `login failed google_error (unexpected ${logSafe(error.name)}: ${String(error.message).slice(0, 200)})`);
      }
      if (error.code === 'not_allowed') return fail('not_allowed', `login denied not_allowed ${error.email}`, error.email);
      if (error.code === 'email_unverified') return fail('email_unverified', `login denied email_unverified ${error.detail}`);
      if (error.code === 'invalid_token') return fail('invalid_token', `login failed invalid_token (${error.detail})`);
      return fail(error.code, error.detail || `login failed ${error.code}`);
    }
  }

  async function logout(req, res) {
    // The body (usually {}) is drained and ignored.
    await readBody(req).catch(error => { if (error.status !== 400) throw error; });
    const signedIn = readSession(req);
    appendSetCookie(res, clearCookie(SESSION_COOKIE, { path: '/', secure: secureRequest(req) }));
    if (signedIn) log(`[auth] logout ${signedIn.email}`);
    return sendJson(res, 200, { ok: true });
  }

  function status(req, res) {
    const state = current();
    return sendJson(res, 200, {
      mode: state.mode,
      problem: state.problem,
      loggedIn: !!readSession(req),
      redirectUri: redirectUri(req),
      configPath: DISPLAY_CONFIG_PATH,
    });
  }

  // Public auth routes. Returns true when the request was handled.
  async function handleRoute(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (method === 'GET' && pathname === '/auth/google/login') {
      startLogin(req, res, url);
    } else if (method === 'GET' && pathname === CALLBACK_PATH) {
      await finishLogin(req, res, url);
    } else if (method === 'POST' && pathname === '/auth/logout') {
      await logout(req, res);
    } else if (method === 'GET' && pathname === '/api/auth/status') {
      status(req, res);
    } else if ((method === 'GET' || method === 'HEAD') && pathname === '/login' && readSession(req)) {
      // Already signed in: skip the login page.
      redirect(res, safeNext(url.searchParams.get('next')));
    } else {
      return false;
    }
    return true;
  }

  // --- the access gate -------------------------------------------------------

  // Returns { mode, via: 'open'|'public'|'session'|'overlay', session } when the
  // request may continue, or null after sending the refusal.
  function gate(req, res, url) {
    const state = current();
    if (state.mode === 'disabled') return { mode: 'disabled', via: 'open', session: null, userId: null };
    const { pathname } = url;
    const kind = accessClass(req.method, pathname);
    if (state.mode === 'invalid') {
      if (kind === 'public') return { mode: 'invalid', via: 'public', session: null, userId: null };
      refuseMisconfigured(req, res, url);
      return null;
    }

    const signedIn = readSession(req);
    // Sliding lifetime: a session older than 24 h is re-issued (new iat/exp).
    if (signedIn && unixSeconds(now()) - signedIn.iat > SESSION_RENEW_AFTER) {
      appendSetCookie(res, sessionCookie(req, sessionPayload(signedIn, unixSeconds(now()))));
    }
    let keyedSub = null;
    if (kind === 'overlay' && pathname === '/overlay') {
      const key = url.searchParams.get('key');
      keyedSub = overlaySubFor(key);
      if (keyedSub) {
        appendSetCookie(res, serializeCookie(OVERLAY_COOKIE, key, {
          path: '/', maxAge: OVERLAY_MAX_AGE, secure: secureRequest(req),
        }));
      }
    }
    if (kind === 'public') return { mode: 'enabled', via: signedIn ? 'session' : 'public', session: signedIn, userId: signedIn ? signedIn.sub : null };
    if (signedIn) return { mode: 'enabled', via: 'session', session: signedIn, userId: signedIn.sub };
    const overlaySub = kind === 'overlay' ? (keyedSub || overlaySubFromCookie(req)) : null;
    if (overlaySub) {
      if (req.method === 'GET' && pathname === '/api/events') trackOverlayStream(overlaySub, res);
      return { mode: 'enabled', via: 'overlay', session: null, userId: overlaySub };
    }
    refuseSignedOut(req, res, url);
    return null;
  }

  // --- session routes that run after the gate --------------------------------

  async function me(res, access) {
    if (access.mode !== 'enabled') return sendJson(res, 200, { enabled: false, user: null, overlayKey: null });
    const user = access.session;
    return sendJson(res, 200, {
      enabled: true,
      user: { email: user.email, name: user.name ?? null, picture: user.picture ?? null },
      overlayKey: await store.overlayKeyOf(user.sub),
    });
  }

  async function rotateOverlayKey(req, res, access) {
    if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') {
      return sendJson(res, 415, { error: 'Expected application/json.' });
    }
    // The body (usually {}) is drained and ignored.
    await readBody(req).catch(error => { if (error.status !== 400) throw error; });
    if (access.mode !== 'enabled') return sendJson(res, 409, AUTH_DISABLED);
    let admittedByOldKey = [];
    const sub = access.session.sub;
    const overlayKey = await store.rotateOverlayKey(sub, () => {
      admittedByOldKey = [...(overlayStreams.get(sub) || [])];
      overlayStreams.delete(sub);
    });
    for (const stream of admittedByOldKey) {
      try { stream.end(); } catch { /* already gone */ }
    }
    log(`[auth] OBS overlay key rotated by ${access.session.email} (${admittedByOldKey.length} overlay stream(s) closed)`);
    return sendJson(res, 200, { overlayKey });
  }

  // Session routes (the gate already admitted the request). Returns true when handled.
  async function handleApi(req, res, url, access) {
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      await me(res, access);
    } else if (req.method === 'POST' && url.pathname === '/api/auth/overlay-key') {
      await rotateOverlayKey(req, res, access);
    } else {
      return false;
    }
    return true;
  }

  function summary() {
    const state = current();
    return {
      mode: state.mode,
      problem: state.problem,
      allowedCount: state.mode === 'enabled' ? state.config.allowedEmails.length : 0,
      publicUrl: state.publicUrl ? state.publicUrl.origin : null,
      text: describeMode(state),
    };
  }

  // Whether the CURRENT allowlist lets this address sign in (false unless login is on).
  function loginAllowed(email) {
    const state = current();
    return state.mode === 'enabled' && isEmailAllowed(state.config.allowedEmails, email);
  }

  return {
    refresh: () => watcher.refresh(),
    publicHost,
    isPublicOrigin,
    handleRoute,
    gate,
    handleApi,
    summary,
    loginAllowed,
  };
}

module.exports = { createAuth, describeMode };
