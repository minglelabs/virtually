'use strict';

// Login support for the controller and the animate page, loaded before the page
// script. It wraps window.fetch once, so any request the server refuses for a
// missing login (401 + X-Virtually-Auth: required) sends the browser to /login and
// back here afterwards; it fills the signed-in chip (#authSlot) and exposes
// window.VirtuallyAuth = { ready, logout, rotateOverlayKey, loginUrlFor, overlayUrlFor }.
// Names and emails are user data: the chip is built with createElement/textContent only.
// With login off (or an older server) nothing is shown and fetch behaves as before.
(function (root) {
  const AUTH_HEADER = 'X-Virtually-Auth';
  const LOGGED_OUT_URL = '/login?logged_out=1';

  const TEXT = Object.freeze({
    logout: '로그아웃',
    offline: '서버에 연결하지 못했습니다.',
    noKey: '새 주소를 받지 못했습니다.',
    logoutFailed: '로그아웃하지 못했습니다.',
  });

  /** The login page that returns to `pathname + search` afterwards. */
  function loginUrlFor(pathname, search) {
    const path = typeof pathname === 'string' && pathname ? pathname : '/';
    const query = typeof search === 'string' ? search : '';
    return `/login?next=${encodeURIComponent(path + query)}`;
  }

  /** The OBS Browser Source URL: `<origin>/overlay`, with `?key=` when login is on. */
  function overlayUrlFor(origin, overlayKey) {
    const url = `${String(origin ?? '').replace(/\/+$/, '')}/overlay`;
    return typeof overlayKey === 'string' && overlayKey ? `${url}?key=${encodeURIComponent(overlayKey)}` : url;
  }

  /** True for the server's "log in first" answer: 401 with X-Virtually-Auth: required. */
  function isAuthRequired(response) {
    try {
      if (!response || response.status !== 401 || !response.headers) return false;
      const value = response.headers.get(AUTH_HEADER);
      return typeof value === 'string' && value.trim().toLowerCase() === 'required';
    } catch {
      return false;
    }
  }

  /**
   * A fetch that calls onAuthRequired(response) for the "log in first" answer and
   * still returns the response. Its own check never throws; a rejected fetch
   * (network error) rejects exactly as before.
   */
  function guardFetch(nativeFetch, onAuthRequired) {
    return async function guardedFetch(...args) {
      const response = await nativeFetch(...args);
      if (isAuthRequired(response)) {
        try {
          onAuthRequired(response);
        } catch { /* the guard must never break the caller */ }
      }
      return response;
    };
  }

  /** What the chip shows for a /api/auth/me payload, or null when there is no chip. */
  function chipUser(me) {
    if (!me || typeof me !== 'object' || me.enabled !== true || !me.user || typeof me.user !== 'object') return null;
    const email = typeof me.user.email === 'string' ? me.user.email.trim() : '';
    const name = typeof me.user.name === 'string' ? me.user.name.trim() : '';
    if (!email && !name) return null;
    const picture = typeof me.user.picture === 'string' && /^https?:\/\//i.test(me.user.picture) ? me.user.picture : null;
    return { label: name || email, email, picture };
  }

  /** The server's JSON `error` text, else `HTTP <status>`. */
  async function errorText(response) {
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string' && body.error) return body.error;
    } catch { /* keep the status text */ }
    return `HTTP ${response.status}`;
  }

  const helpers = Object.freeze({
    AUTH_HEADER,
    LOGGED_OUT_URL,
    TEXT,
    loginUrlFor,
    overlayUrlFor,
    isAuthRequired,
    guardFetch,
    chipUser,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  // Browser only, and only once per page.
  if (!root || !root.document || root.VirtuallyAuth || typeof root.fetch !== 'function') return;

  const document = root.document;
  const nativeFetch = root.fetch.bind(root);
  let redirecting = false;

  function goToLogin() {
    if (redirecting) return;
    redirecting = true;
    root.location.assign(loginUrlFor(root.location.pathname, root.location.search));
  }

  root.fetch = guardFetch(nativeFetch, goToLogin);

  function postJson(url) {
    return root.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {
      throw new Error(TEXT.offline);
    });
  }

  async function logout() {
    const response = await postJson('/auth/logout');
    if (!response.ok) throw new Error(await errorText(response));
    root.location.assign(LOGGED_OUT_URL);
  }

  /** New overlay key: resolves { overlayKey }, or throws with the server's error text. */
  async function rotateOverlayKey() {
    const response = await postJson('/api/auth/overlay-key');
    if (!response.ok) throw new Error(await errorText(response));
    let body = null;
    try {
      body = await response.json();
    } catch { /* reported below */ }
    if (!body || typeof body.overlayKey !== 'string' || !body.overlayKey) throw new Error(TEXT.noKey);
    return { overlayKey: body.overlayKey };
  }

  // The /api/auth/me payload, or null (request failed, not JSON, or sent to /login).
  const ready = (async () => {
    try {
      const response = await root.fetch('/api/auth/me', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body && typeof body === 'object' ? body : null;
    } catch {
      return null;
    }
  })();

  function renderChip(me) {
    const user = chipUser(me);
    const slot = document.getElementById('authSlot');
    if (!user || !slot) return;
    const parts = [];
    if (user.picture) {
      const avatar = document.createElement('img');
      avatar.className = 'auth-avatar';
      avatar.alt = '';
      avatar.width = 24;
      avatar.height = 24;
      avatar.setAttribute('referrerpolicy', 'no-referrer');
      avatar.addEventListener('error', () => avatar.remove(), { once: true });
      avatar.src = user.picture;
      parts.push(avatar);
    }
    const name = document.createElement('span');
    name.className = 'auth-name';
    name.textContent = user.label;
    if (user.email) name.title = user.email;
    parts.push(name);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost btn-sm auth-logout';
    button.textContent = TEXT.logout;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await logout();
      } catch (error) {
        button.disabled = false;
        if (typeof root.alert === 'function') root.alert(`${TEXT.logoutFailed} ${error.message}`);
      }
    });
    parts.push(button);
    slot.replaceChildren(...parts);
    slot.hidden = false;
  }

  function whenDomReady(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once: true });
    else callback();
  }

  ready.then(me => whenDomReady(() => renderChip(me))).catch(() => {});

  root.VirtuallyAuth = Object.freeze({ ready, logout, rotateOverlayKey, loginUrlFor, overlayUrlFor });
})(typeof window !== 'undefined' ? window : null);
