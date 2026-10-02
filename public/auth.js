'use strict';

// Login support for the controller, the animate page and the billing page, loaded
// before the page script. It wraps window.fetch once, so any request the server
// refuses for a missing login (401 + X-Virtually-Auth: required) sends the browser
// to /login and back here afterwards; it fills the signed-in chip (#authSlot) and exposes
// window.VirtuallyAuth = { ready, logout, rotateOverlayKey, loginUrlFor, overlayUrlFor }.
// It also puts the credits chip (GET /api/billing; admins also get a 관리 link to /admin)
// in the same slot and exposes window.VirtuallyBilling = { ready, refresh }, so a page
// reuses that payload instead of asking again. Names and emails are user data: the
// chips are built with createElement/textContent only. With login and billing off (or an
// older server) nothing is shown and fetch behaves as before.
(function (root) {
  const AUTH_HEADER = 'X-Virtually-Auth';
  const LOGGED_OUT_URL = '/login?logged_out=1';
  const BILLING_PATH = '/billing';
  const ADMIN_PATH = '/admin';

  const TEXT = Object.freeze({
    logout: '로그아웃',
    offline: '서버에 연결하지 못했습니다.',
    noKey: '새 주소를 받지 못했습니다.',
    logoutFailed: '로그아웃하지 못했습니다.',
    credits: '크레딧',
    creditsCheck: '크레딧 설정 확인',
    admin: '관리',
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

  /** A credit count as shown on every page: '1,234', '-50'; '' when it is not a number. */
  function formatCredits(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR') : '';
  }

  /**
   * What the credits chip shows for a GET /api/billing payload: { text, href, adminHref },
   * or null for no chip (billing off, request failed, unknown shape). The chip links to
   * the billing page; adminHref ('/admin', else null) adds the admins' 관리 link.
   */
  function creditChip(billing) {
    if (!billing || typeof billing !== 'object' || billing.enabled !== true) return null;
    if (billing.mode === 'invalid') return { text: TEXT.creditsCheck, href: BILLING_PATH, adminHref: null };
    if (billing.mode !== 'enabled') return null;
    const adminHref = billing.isAdmin === true ? ADMIN_PATH : null;
    const balance = formatCredits(billing.balance);
    return balance ? { text: `${TEXT.credits} ${balance}`, href: BILLING_PATH, adminHref } : null;
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
    BILLING_PATH,
    ADMIN_PATH,
    TEXT,
    loginUrlFor,
    overlayUrlFor,
    isAuthRequired,
    guardFetch,
    chipUser,
    formatCredits,
    creditChip,
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

  // ---- Credits chip (GET /api/billing) ----
  // renderChip replaces the slot's children, so the credits chip joins the slot only
  // after it: this reaction on `ready` is registered after renderChip's, so it runs
  // after it, and when both wait for DOMContentLoaded its listener comes second too.
  const slotSettled = ready.then(() => new Promise(resolve => whenDomReady(resolve)), () => {});
  let creditsNode = null;
  let billingSeq = 0;

  // The GET /api/billing payload, or null (request failed, not JSON, or sent to /login).
  async function fetchBilling() {
    try {
      const response = await root.fetch('/api/billing', {
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
  }

  function chipLink(className, href, text) {
    const link = document.createElement('a');
    link.className = className;
    link.setAttribute('href', href);
    if (root.location.pathname === href) link.setAttribute('aria-current', 'page');
    link.textContent = text;
    return link;
  }

  // One group, replaced as a unit: the credits link, and the admins' 관리 link.
  function creditsChipNode(chip) {
    const group = document.createElement('span');
    group.className = 'auth-billing';
    group.append(chipLink('auth-credits', chip.href, chip.text));
    if (chip.adminHref) group.append(chipLink('auth-admin', chip.adminHref, TEXT.admin));
    return group;
  }

  // Puts the chip first in #authSlot, replaces it, or removes it (no chip for this payload).
  function renderCredits(billing) {
    const slot = document.getElementById('authSlot');
    if (!slot) return;
    const chip = creditChip(billing);
    const node = chip ? creditsChipNode(chip) : null;
    if (node) {
      if (creditsNode && creditsNode.parentNode === slot) creditsNode.replaceWith(node);
      else slot.prepend(node);
      slot.hidden = false;
    } else if (creditsNode) {
      creditsNode.remove();
      if (slot.children.length === 0) slot.hidden = true;
    }
    creditsNode = node;
  }

  /** Re-reads GET /api/billing and redraws the chip; resolves the payload (null on failure). */
  function refreshBilling() {
    billingSeq += 1;
    const seq = billingSeq;
    return Promise.all([fetchBilling(), slotSettled]).then(([billing]) => {
      // Only the newest answer draws, so an older, slower one cannot undo it.
      if (seq === billingSeq) {
        try {
          renderCredits(billing);
        } catch { /* the chip must never break the page */ }
      }
      return billing;
    });
  }

  const billingReady = refreshBilling();

  root.VirtuallyAuth = Object.freeze({ ready, logout, rotateOverlayKey, loginUrlFor, overlayUrlFor });
  root.VirtuallyBilling = Object.freeze({ ready: billingReady, refresh: refreshBilling });
})(typeof window !== 'undefined' ? window : null);

// The top bar of a scrolling page (.page > .page-header / .brand-row; not the 방송 화면,
// whose panes scroll inside the window): it stays at the top, slides away while the page
// is scrolled down and comes back as soon as it is scrolled up a little.
if (typeof document !== 'undefined' && typeof window !== 'undefined' && typeof document.querySelector === 'function') (() => {
  const header = document.querySelector('.page > .page-header, .page > .brand-row');
  if (!header || !header.classList || typeof window.addEventListener !== 'function') return;
  header.classList.add('autohide-header');
  const NUDGE = 6; // px of scrolling that counts as a direction
  let lastY = window.scrollY;
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = window.scrollY;
      if (y <= header.offsetHeight) header.classList.remove('is-hidden');
      else if (y > lastY + NUDGE) header.classList.add('is-hidden');
      else if (y < lastY - NUDGE) header.classList.remove('is-hidden');
      else return; // too small to decide: keep the reference point
      lastY = y;
    });
  }, { passive: true });
  // Reaching it with the keyboard brings it back.
  header.addEventListener('focusin', () => header.classList.remove('is-hidden'));
})();
