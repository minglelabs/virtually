'use strict';

// Login page: shows the login state the server reports (GET /api/auth/status)
// and the "Google 계정으로 로그인" button. ?error, ?email and ?next come from the
// address bar, so they are data: the DOM is built with createElement/textContent
// only. The DOM-free helpers are require()-able from node tests (like motions.js).
(function (root) {
  const DEFAULT_NEXT = '/';
  const MAX_NEXT_LENGTH = 2000;
  const MAX_EMAIL_LENGTH = 254;
  const DEFAULT_CONFIG_PATH = 'data/auth/config.json';
  const MODES = new Set(['enabled', 'disabled', 'invalid']);

  const TEXT = Object.freeze({
    generic: '로그인하지 못했습니다. 다시 시도해 주세요.',
    notAllowedAnon: '이 계정은 허용 목록에 없습니다.',
    loggedOut: '로그아웃했습니다.',
    disabled: 'Google 로그인이 꺼져 있습니다. 지금은 로그인 없이 쓸 수 있습니다.',
    invalid: 'Google 로그인 설정 파일에 문제가 있습니다',
    offline: '서버에 연결하지 못했습니다.',
    configLabel: '설정 파일',
    redirectLabel: '리디렉션 URI',
  });

  // ?error=<code> from /auth/google/callback and /auth/google/login.
  // not_allowed is built by messageFor (it names the account).
  const ERROR_MESSAGES = new Map([
    ['cancelled', '로그인을 취소했습니다.'],
    ['state_mismatch', '로그인 시간이 지났거나 다른 창에서 로그인을 다시 시작했습니다. 다시 시도해 주세요.'],
    ['google_error', 'Google과 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
    ['invalid_token', 'Google 로그인 응답을 확인하지 못했습니다. 다시 시도해 주세요.'],
    ['email_unverified', '이메일 인증을 마친 Google 계정만 쓸 수 있습니다.'],
    ['not_configured', 'Google 로그인이 아직 설정되지 않았습니다.'],
    ['config_invalid', 'Google 로그인 설정 파일에 문제가 있습니다.'],
  ]);

  // /api/auth/status `problem` codes (mode 'invalid').
  const PROBLEM_TEXTS = new Map([
    ['invalid_json', 'JSON 형식이 올바르지 않습니다.'],
    ['missing_client', 'google.clientId와 google.clientSecret이 필요합니다.'],
    ['no_allowed_emails', 'allowedEmails에 로그인할 이메일을 하나 이상 넣어 주세요.'],
    ['bad_public_url', 'publicUrl은 https://example.com 처럼 주소만 적어 주세요.'],
  ]);

  const SAME_ORIGIN_PROBE = 'http://virtually.invalid';

  /**
   * The page to return to after login: a same-origin path from ?next, or '/'.
   * Mirrors the server's rule: starts with '/', not '//' or '/\', no control
   * characters, at most 2000 characters, never /login or /auth/*.
   */
  function safeNext(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NEXT_LENGTH) return DEFAULT_NEXT;
    if (value[0] !== '/' || value[1] === '/' || value[1] === '\\') return DEFAULT_NEXT;
    if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_NEXT;
    let url;
    try {
      url = new URL(value, SAME_ORIGIN_PROBE);
    } catch {
      return DEFAULT_NEXT;
    }
    if (url.origin !== SAME_ORIGIN_PROBE) return DEFAULT_NEXT;
    const pathname = url.pathname.toLowerCase();
    if (pathname === '/login' || pathname === '/auth' || pathname.startsWith('/auth/')) return DEFAULT_NEXT;
    return value;
  }

  /** href of the Google button: starts the OAuth flow and comes back to `next`. */
  function googleLoginHref(next) {
    return `/auth/google/login?next=${encodeURIComponent(safeNext(next))}`;
  }

  /** The ?email value when it looks like one address, else null (the text then names no account). */
  function displayEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim();
    if (!email || email.length > MAX_EMAIL_LENGTH) return null;
    return /^[^\s@\p{C}]+@[^\s@\p{C}]+$/u.test(email) ? email : null;
  }

  /** Korean text for an ?error code; null when there is no code. Unknown codes get a generic text. */
  function messageFor(code, email) {
    if (typeof code !== 'string' || code === '') return null;
    if (code === 'not_allowed') {
      const account = displayEmail(email);
      return account ? `${account} 계정은 허용 목록에 없습니다.` : TEXT.notAllowedAnon;
    }
    return ERROR_MESSAGES.get(code) || TEXT.generic;
  }

  /** Korean text for a config problem code, or null when it is unknown. */
  function problemText(code) {
    return PROBLEM_TEXTS.get(code) || null;
  }

  /** The mode 'invalid' message, with the problem when it is known. */
  function invalidText(problem) {
    const detail = problemText(problem);
    return detail ? `${TEXT.invalid}: ${detail}` : `${TEXT.invalid}.`;
  }

  /** The login-related query parameters of this page. */
  function readQuery(search) {
    const params = new URLSearchParams(typeof search === 'string' ? search : '');
    return {
      error: params.get('error'),
      email: params.get('email'),
      next: safeNext(params.get('next')),
      loggedOut: params.get('logged_out') === '1',
    };
  }

  /**
   * What the page shows for a status payload (null when GET /api/auth/status failed):
   * { redirect, showButton, buttonHref, messages: [{ kind: 'error'|'info', text }],
   *   controllerLink, help: [{ label, value }] }. `redirect` set means leave the page.
   */
  function loginView(status, query) {
    const q = query || {};
    const next = safeNext(q.next);
    const view = {
      redirect: null,
      showButton: true,
      buttonHref: googleLoginHref(next),
      messages: [],
      controllerLink: false,
      help: [],
    };
    const errorText = messageFor(q.error, q.email);

    if (!status || typeof status !== 'object' || !MODES.has(status.mode)) {
      // The server did not answer: keep the button, it may work again shortly.
      if (errorText) view.messages.push({ kind: 'error', text: errorText });
      view.messages.push({ kind: 'error', text: TEXT.offline });
      return view;
    }
    if (status.loggedIn === true) {
      view.redirect = next;
      return view;
    }
    const configPath = typeof status.configPath === 'string' && status.configPath ? status.configPath : DEFAULT_CONFIG_PATH;

    if (status.mode === 'enabled') {
      if (errorText) view.messages.push({ kind: 'error', text: errorText });
      if (q.loggedOut) view.messages.push({ kind: 'info', text: TEXT.loggedOut });
      return view;
    }

    view.showButton = false;
    if (status.mode === 'disabled') {
      view.messages.push({ kind: 'info', text: TEXT.disabled });
      view.controllerLink = true;
      view.help.push({ label: TEXT.configLabel, value: configPath });
      if (typeof status.redirectUri === 'string' && status.redirectUri) {
        view.help.push({ label: TEXT.redirectLabel, value: status.redirectUri });
      }
      return view;
    }

    // mode 'invalid': the app stays locked until the file is fixed.
    view.messages.push({ kind: 'error', text: invalidText(status.problem) });
    view.help.push({ label: TEXT.configLabel, value: configPath });
    return view;
  }

  const api = Object.freeze({
    DEFAULT_CONFIG_PATH,
    TEXT,
    safeNext,
    googleLoginHref,
    displayEmail,
    messageFor,
    problemText,
    invalidText,
    readQuery,
    loginView,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;

  // ---- Page ----
  const document = root.document;
  const button = document.getElementById('googleLoginBtn');
  const message = document.getElementById('loginMessage');
  const controllerLink = document.getElementById('controllerLink');
  const help = document.getElementById('loginHelp');
  const query = readQuery(root.location.search);

  function paragraph(kind, text) {
    const p = document.createElement('p');
    if (kind) p.dataset.kind = kind;
    p.textContent = text;
    return p;
  }

  function render(view) {
    button.setAttribute('href', view.buttonHref);
    button.hidden = !view.showButton;
    message.replaceChildren(...view.messages.map(item => paragraph(item.kind, item.text)));
    controllerLink.hidden = !view.controllerLink;
    help.replaceChildren(...view.help.map((item) => {
      const p = paragraph(null, `${item.label}: `);
      const code = document.createElement('code');
      code.textContent = item.value;
      p.append(code);
      return p;
    }));
    help.hidden = view.help.length === 0;
  }

  async function loadStatus() {
    try {
      const response = await root.fetch('/api/auth/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  // The button works before the status arrives (and without it).
  button.setAttribute('href', googleLoginHref(query.next));
  loadStatus().then((status) => {
    const view = loginView(status, query);
    if (view.redirect) {
      root.location.replace(view.redirect);
      return;
    }
    render(view);
  });
})(typeof window !== 'undefined' ? window : null);
