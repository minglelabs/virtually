'use strict';

// Client side of the Google login: login.js (login page) and auth.js (signed-in
// chip, fetch guard, window.VirtuallyAuth). The DOM-free helpers are required
// directly; the page glue runs in a vm context against a small fake DOM.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const login = require('../public/login.js');
const auth = require('../public/auth.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = file => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

// ---- login.js helpers ----

test('messageFor maps every callback error code to its Korean message', () => {
  const expected = {
    cancelled: '로그인을 취소했습니다.',
    state_mismatch: '로그인 시간이 지났거나 다른 창에서 로그인을 다시 시작했습니다. 다시 시도해 주세요.',
    google_error: 'Google과 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    invalid_token: 'Google 로그인 응답을 확인하지 못했습니다. 다시 시도해 주세요.',
    email_unverified: '이메일 인증을 마친 Google 계정만 쓸 수 있습니다.',
    not_allowed: '이 계정은 허용 목록에 없습니다.',
    not_configured: 'Google 로그인이 아직 설정되지 않았습니다.',
    config_invalid: 'Google 로그인 설정 파일에 문제가 있습니다.',
  };
  for (const [code, text] of Object.entries(expected)) assert.equal(login.messageFor(code), text, code);
});

test('messageFor names the refused account for not_allowed only when ?email is one address', () => {
  assert.equal(login.messageFor('not_allowed', 'someone@gmail.com'), 'someone@gmail.com 계정은 허용 목록에 없습니다.');
  assert.equal(login.messageFor('not_allowed', '  Someone@Example.com '), 'Someone@Example.com 계정은 허용 목록에 없습니다.');
  // Shown as text (login.js uses textContent), so markup-like characters are harmless.
  assert.equal(login.messageFor('not_allowed', '<b>x</b>@example.com'), '<b>x</b>@example.com 계정은 허용 목록에 없습니다.');
  for (const email of [undefined, null, '', '   ', 'not an email', 'a@b c', 'no-at-sign', 'two@@example.com',
    'a@b@c', '\u202Eevil@example.com', `${'a'.repeat(250)}@b.com`, 42]) {
    assert.equal(login.messageFor('not_allowed', email), '이 계정은 허용 목록에 없습니다.', String(email));
  }
  // Other codes ignore ?email.
  assert.equal(login.messageFor('cancelled', 'someone@gmail.com'), '로그인을 취소했습니다.');
});

test('messageFor: no code means no message; an unknown code gets the generic message', () => {
  for (const code of [undefined, null, '']) assert.equal(login.messageFor(code), null);
  for (const code of ['weird', 'constructor', '__proto__', 'toString', 'CANCELLED']) {
    assert.equal(login.messageFor(code), '로그인하지 못했습니다. 다시 시도해 주세요.', code);
  }
});

test('problemText maps every config problem code; invalidText wraps it', () => {
  assert.equal(login.problemText('invalid_json'), 'JSON 형식이 올바르지 않습니다.');
  assert.equal(login.problemText('missing_client'), 'google.clientId와 google.clientSecret이 필요합니다.');
  assert.equal(login.problemText('no_allowed_emails'), 'allowedEmails에 로그인할 이메일을 하나 이상 넣어 주세요.');
  assert.equal(login.problemText('bad_public_url'), 'publicUrl은 https://example.com 처럼 주소만 적어 주세요.');
  for (const code of [null, undefined, '', 'weird', 'constructor']) assert.equal(login.problemText(code), null, String(code));
  assert.equal(login.invalidText('invalid_json'), 'Google 로그인 설정 파일에 문제가 있습니다: JSON 형식이 올바르지 않습니다.');
  assert.equal(login.invalidText('bad_public_url'), 'Google 로그인 설정 파일에 문제가 있습니다: publicUrl은 https://example.com 처럼 주소만 적어 주세요.');
  assert.equal(login.invalidText(null), 'Google 로그인 설정 파일에 문제가 있습니다.');
  assert.equal(login.invalidText('weird'), 'Google 로그인 설정 파일에 문제가 있습니다.');
});

test('safeNext keeps same-origin paths and falls back to / for anything else', () => {
  for (const next of ['/', '/animate', '/animate?x=1&y=%2F', '/overlay#top', '/a/b/c', '/login.css', '/logins', '/authx',
    '/%2F%2Fevil.com', `/${'a'.repeat(1999)}`]) {
    assert.equal(login.safeNext(next), next, next);
  }
  for (const next of [undefined, null, '', 42, {}, 'animate', 'https://evil.com', 'http://evil.com/', '//evil.com',
    '/\\evil.com', '\\\\evil.com', ' /animate', '/animate\n', '/an\rimate', '/a\u0000b', '/tab\there', '/a\u007fb',
    `/${'a'.repeat(2000)}`, '/login', '/login?next=/', '/LOGIN', '/auth', '/auth/google/login', '/auth/google/callback?code=1',
    '/Auth/x']) {
    assert.equal(login.safeNext(next), '/', JSON.stringify(next));
  }
});

test('googleLoginHref and readQuery', () => {
  assert.equal(login.googleLoginHref('/'), '/auth/google/login?next=%2F');
  assert.equal(login.googleLoginHref('/animate?x=1'), '/auth/google/login?next=%2Fanimate%3Fx%3D1');
  assert.equal(login.googleLoginHref('//evil.com'), '/auth/google/login?next=%2F');
  assert.deepEqual(login.readQuery('?error=not_allowed&email=a%40b.com&next=%2Fanimate&logged_out=1'),
    { error: 'not_allowed', email: 'a@b.com', next: '/animate', loggedOut: true });
  assert.deepEqual(login.readQuery(''), { error: null, email: null, next: '/', loggedOut: false });
  assert.deepEqual(login.readQuery('?next=https%3A%2F%2Fevil.com&logged_out=yes'),
    { error: null, email: null, next: '/', loggedOut: false });
});

const status = (over = {}) => ({
  mode: 'enabled', problem: null, loggedIn: false,
  redirectUri: 'http://127.0.0.1:8787/auth/google/callback', configPath: 'data/auth/config.json',
  ...over,
});

test('loginView, login on: the button, the mapped error and the logged-out note', () => {
  assert.deepEqual(login.loginView(status(), { next: '/animate' }), {
    redirect: null, showButton: true, buttonHref: '/auth/google/login?next=%2Fanimate',
    messages: [], controllerLink: false, help: [],
  });
  const refused = login.loginView(status(), { error: 'not_allowed', email: 'someone@gmail.com' });
  assert.equal(refused.showButton, true);
  assert.deepEqual(refused.messages, [{ kind: 'error', text: 'someone@gmail.com 계정은 허용 목록에 없습니다.' }]);
  assert.deepEqual(login.loginView(status(), { loggedOut: true }).messages, [{ kind: 'info', text: '로그아웃했습니다.' }]);
  assert.deepEqual(login.loginView(status(), { error: 'mystery' }).messages,
    [{ kind: 'error', text: '로그인하지 못했습니다. 다시 시도해 주세요.' }]);
  // An unsafe next never reaches the button.
  assert.equal(login.loginView(status(), { next: '//evil.com' }).buttonHref, '/auth/google/login?next=%2F');
});

test('loginView, logged in: leaves for the validated next', () => {
  assert.equal(login.loginView(status({ loggedIn: true }), { next: '/animate?x=1' }).redirect, '/animate?x=1');
  assert.equal(login.loginView(status({ loggedIn: true }), { next: '/login' }).redirect, '/');
  assert.equal(login.loginView(status({ loggedIn: true }), {}).redirect, '/');
});

test('loginView, login off: no button, the controller link and the setup hint', () => {
  assert.deepEqual(login.loginView(status({ mode: 'disabled', redirectUri: 'http://localhost:8790/auth/google/callback' }), { error: 'not_configured' }), {
    redirect: null,
    showButton: false,
    buttonHref: '/auth/google/login?next=%2F',
    messages: [{ kind: 'info', text: 'Google 로그인이 꺼져 있습니다. 지금은 로그인 없이 쓸 수 있습니다.' }],
    controllerLink: true,
    help: [
      { label: '설정 파일', value: 'data/auth/config.json' },
      { label: '리디렉션 URI', value: 'http://localhost:8790/auth/google/callback' },
    ],
  });
  // A payload without the optional fields still shows the default config path.
  assert.deepEqual(login.loginView({ mode: 'disabled' }, {}).help, [{ label: '설정 파일', value: 'data/auth/config.json' }]);
});

test('loginView, config problem: no button, the problem and the config path', () => {
  for (const [problem, text] of [
    ['invalid_json', 'Google 로그인 설정 파일에 문제가 있습니다: JSON 형식이 올바르지 않습니다.'],
    ['missing_client', 'Google 로그인 설정 파일에 문제가 있습니다: google.clientId와 google.clientSecret이 필요합니다.'],
    ['no_allowed_emails', 'Google 로그인 설정 파일에 문제가 있습니다: allowedEmails에 로그인할 이메일을 하나 이상 넣어 주세요.'],
    ['bad_public_url', 'Google 로그인 설정 파일에 문제가 있습니다: publicUrl은 https://example.com 처럼 주소만 적어 주세요.'],
    [null, 'Google 로그인 설정 파일에 문제가 있습니다.'],
  ]) {
    const view = login.loginView(status({ mode: 'invalid', problem }), { error: 'config_invalid' });
    assert.equal(view.showButton, false, String(problem));
    assert.equal(view.controllerLink, false);
    assert.deepEqual(view.messages, [{ kind: 'error', text }]);
    assert.deepEqual(view.help, [{ label: '설정 파일', value: 'data/auth/config.json' }]);
  }
});

test('loginView, no status: keeps the button and says the server did not answer', () => {
  for (const failed of [null, undefined, 'x', {}, { mode: 'something-new' }]) {
    const view = login.loginView(failed, {});
    assert.equal(view.showButton, true);
    assert.equal(view.redirect, null);
    assert.deepEqual(view.messages, [{ kind: 'error', text: '서버에 연결하지 못했습니다.' }]);
  }
  assert.deepEqual(login.loginView(null, { error: 'cancelled' }).messages, [
    { kind: 'error', text: '로그인을 취소했습니다.' },
    { kind: 'error', text: '서버에 연결하지 못했습니다.' },
  ]);
});

// ---- auth.js helpers ----

test('loginUrlFor sends the current path and query as an encoded next', () => {
  assert.equal(auth.loginUrlFor('/', ''), '/login?next=%2F');
  assert.equal(auth.loginUrlFor('/animate', '?x=1&y=2'), '/login?next=%2Fanimate%3Fx%3D1%26y%3D2');
  assert.equal(auth.loginUrlFor('/a b/c', '?q=한글#'), `/login?next=${encodeURIComponent('/a b/c?q=한글#')}`);
  assert.equal(auth.loginUrlFor('', undefined), '/login?next=%2F');
  assert.equal(auth.loginUrlFor(null, null), '/login?next=%2F');
});

test('overlayUrlFor adds the encoded key only when there is one', () => {
  assert.equal(auth.overlayUrlFor('http://127.0.0.1:8787', null), 'http://127.0.0.1:8787/overlay');
  assert.equal(auth.overlayUrlFor('http://127.0.0.1:8787', ''), 'http://127.0.0.1:8787/overlay');
  assert.equal(auth.overlayUrlFor('http://127.0.0.1:8787', undefined), 'http://127.0.0.1:8787/overlay');
  assert.equal(auth.overlayUrlFor('http://127.0.0.1:8787', 'AbC-_09xyz'), 'http://127.0.0.1:8787/overlay?key=AbC-_09xyz');
  assert.equal(auth.overlayUrlFor('https://virtually.example.com/', 'a+b/c=d&e f'),
    'https://virtually.example.com/overlay?key=a%2Bb%2Fc%3Dd%26e%20f');
});

const authResponse = (statusCode, headers = {}) => new Response(JSON.stringify({ error: '로그인이 필요합니다.', code: 'auth_required' }), {
  status: statusCode, headers: { 'Content-Type': 'application/json', ...headers },
});

test('isAuthRequired needs both the 401 and X-Virtually-Auth: required', () => {
  assert.equal(auth.AUTH_HEADER, 'X-Virtually-Auth');
  assert.equal(auth.isAuthRequired(authResponse(401, { 'X-Virtually-Auth': 'required' })), true);
  assert.equal(auth.isAuthRequired(authResponse(401, { 'x-virtually-auth': ' Required ' })), true);
  assert.equal(auth.isAuthRequired(authResponse(401)), false);
  assert.equal(auth.isAuthRequired(authResponse(403, { 'X-Virtually-Auth': 'required' })), false);
  assert.equal(auth.isAuthRequired(authResponse(503, { 'X-Virtually-Auth': 'required' })), false);
  assert.equal(auth.isAuthRequired(null), false);
  assert.equal(auth.isAuthRequired({ status: 401, headers: { get() { throw new Error('boom'); } } }), false);
});

test('guardFetch reports a refused request and still returns the response; it never throws itself', async () => {
  const calls = [];
  let answer = authResponse(401, { 'X-Virtually-Auth': 'required' });
  const nativeFetch = async (...args) => { calls.push(args); return answer; };
  const refused = [];
  const guarded = auth.guardFetch(nativeFetch, response => refused.push(response.status));

  const first = await guarded('/api/trigger', { method: 'POST' });
  assert.equal(first, answer);
  assert.deepEqual(calls, [['/api/trigger', { method: 'POST' }]]);
  assert.deepEqual(refused, [401]);

  answer = authResponse(401);
  assert.equal(await guarded('/api/x'), answer);
  answer = new Response('{}', { status: 200 });
  assert.equal(await guarded('/api/y'), answer);
  assert.deepEqual(refused, [401]);

  // A throwing callback stays inside the guard.
  answer = authResponse(401, { 'X-Virtually-Auth': 'required' });
  const throwing = auth.guardFetch(nativeFetch, () => { throw new Error('callback broke'); });
  assert.equal(await throwing('/api/z'), answer);

  // Network errors reject exactly as fetch does.
  const offline = auth.guardFetch(async () => { throw new TypeError('Failed to fetch'); }, () => assert.fail('not refused'));
  await assert.rejects(offline('/api/q'), { name: 'TypeError', message: 'Failed to fetch' });
});

test('chipUser: name or email, https/http pictures only, nothing when login is off', () => {
  assert.deepEqual(auth.chipUser({ enabled: true, user: { email: 'someone@gmail.com', name: 'Some One', picture: 'https://lh3.googleusercontent.com/a/x' } }),
    { label: 'Some One', email: 'someone@gmail.com', picture: 'https://lh3.googleusercontent.com/a/x' });
  assert.deepEqual(auth.chipUser({ enabled: true, user: { email: 'someone@gmail.com', name: null, picture: null } }),
    { label: 'someone@gmail.com', email: 'someone@gmail.com', picture: null });
  assert.equal(auth.chipUser({ enabled: true, user: { email: 'a@b.com', name: '  ', picture: 'javascript:alert(1)' } }).picture, null);
  assert.equal(auth.chipUser({ enabled: true, user: { email: 'a@b.com', picture: 'data:image/png;base64,AAAA' } }).picture, null);
  assert.equal(auth.chipUser({ enabled: false, user: null, overlayKey: null }), null);
  assert.equal(auth.chipUser({ enabled: true, user: null }), null);
  assert.equal(auth.chipUser({ enabled: true, user: {} }), null);
  assert.equal(auth.chipUser(null), null);
});

// ---- Static wiring ----

test('controller and animate pages hold #authSlot and load auth.css and auth.js before their page script', () => {
  const pages = {
    'index.html': { script: 'app.js', css: 'app.css' },
    'animate.html': { script: 'animate.js', css: 'animate.css' },
  };
  for (const [page, { script, css }] of Object.entries(pages)) {
    const html = readPublic(page);
    assert.equal((html.match(/id="authSlot"/g) || []).length, 1, `${page} has one #authSlot`);
    const ownCss = html.indexOf(`<link rel="stylesheet" href="./${css}">`);
    const authCss = html.indexOf('<link rel="stylesheet" href="./auth.css">');
    assert.ok(ownCss > 0 && authCss > ownCss, `${page} loads auth.css after ${css}`);
    const authJs = html.indexOf('<script src="./auth.js"></script>');
    const motionsJs = html.indexOf('<script src="./motions.js"></script>');
    const own = html.indexOf(`<script src="./${script}"></script>`);
    assert.ok(authJs > 0 && own > authJs, `${page} loads auth.js before ${script}`);
    assert.ok(motionsJs > 0 && own > motionsJs, `${page} loads motions.js before ${script}`);
  }
  assert.match(readPublic('index.html'),
    /<div class="brand-row">\s*<h1 class="brand"><a href="\/" class="brand-link">Virtually<\/a><\/h1>\s*<div id="authSlot" class="auth-slot" hidden><\/div>\s*<\/div>/);
  assert.match(readPublic('animate.html'),
    /<header class="page-header">\s*<a href="\/" class="brand-link brand-mark">Virtually<\/a>\s*<nav class="page-links" aria-label="다른 화면">\s*<a href="\/" class="back-link">← 캐릭터 목록<\/a>\s*<a href="\/broadcast" class="back-link">방송 화면<\/a>\s*<\/nav>\s*<h1>동작 만들기<\/h1>\s*<div id="authSlot" class="auth-slot" hidden><\/div>\s*<\/header>/);
  // A plain [hidden] must win over the chip's display: flex (app.css has no [hidden] rule).
  assert.match(readPublic('auth.css'), /\.auth-slot\[hidden\] \{ display: none; \}/);
});

test('controller OBS section: login-only key note, 주소 새로 만들기, preview stays on ./overlay', () => {
  const html = readPublic('index.html');
  assert.match(html, /<div class="url-box">[\s\S]*?<\/div>\s*(<!--[^>]*-->\s*)?<div id="overlayKeyBox" class="overlay-key" hidden>/);
  assert.match(html, /<p class="overlay-key-note">로그인이 켜져 있어 이 주소에 비밀 키가 들어 있습니다\. 방송 화면이나 다른 사람에게 보이지 않게 해 주세요\.<\/p>/);
  assert.match(html, /<button type="button" id="rotateKeyBtn" class="btn btn-ghost">주소 새로 만들기<\/button>/);
  assert.match(html, /<p id="overlayKeyStatus" class="overlay-key-status" aria-live="polite"><\/p>/);
  assert.match(html, /<iframe id="overlayPreviewFrame" src="\.\/overlay" /);
  assert.match(html, /<a href="\.\/overlay" target="_blank" rel="noopener noreferrer" class="link">오버레이 새 창으로 열기<\/a>/);
  const app = readPublic('app.js');
  assert.match(app, /새 주소를 만들면 지금 OBS에 넣은 주소는 바로 멈춥니다\. OBS 브라우저 소스의 URL도 새 주소로 바꿔야 합니다\. 계속할까요\?/);
  assert.match(app, /새 주소를 만들었습니다\. OBS 브라우저 소스의 URL을 바꿔 주세요\./);
  assert.match(app, /window\.VirtuallyAuth \|\| null/);
  assert.match(app, /auth\.overlayUrlFor\(window\.location\.origin, overlayKey\)/);
});

test('login page: its own CSS and script, the Google button and the message areas', () => {
  const html = readPublic('login.html');
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /<link rel="stylesheet" href="\.\/login\.css">/);
  assert.match(html, /<script src="\.\/login\.js"><\/script>/);
  assert.doesNotMatch(html, /app\.css|app\.js|auth\.js|<script>/);
  assert.match(html, /<h1 class="brand"><a href="\/" class="brand-link">Virtually<\/a><\/h1>/);
  assert.match(html, /<p class="subtitle">OBS 캐릭터 오버레이<\/p>/);
  assert.match(html, /<h2 id="loginTitle" class="login-title">로그인<\/h2>/);
  assert.match(html, /<a id="googleLoginBtn" class="gsi-button" href="\/auth\/google\/login\?next=%2F">/);
  assert.match(html, /<span class="gsi-label">Google 계정으로 로그인<\/span>/);
  for (const fill of ['#EA4335', '#4285F4', '#FBBC05', '#34A853']) assert.ok(html.includes(`fill="${fill}"`), fill);
  assert.match(html, /<div id="loginMessage" class="login-message" role="alert"><\/div>/);
  assert.match(html, /<a id="controllerLink" class="login-link" href="\/" hidden>캐릭터 목록으로 가기<\/a>/);
  assert.doesNotMatch(html, /컨트롤러/);
  assert.match(html, /<div id="loginHelp" class="login-help" hidden><\/div>/);

  const css = readPublic('login.css');
  // The controller palette, copied (app.css is not loaded).
  for (const token of ['--bg: #0f1115;', '--panel: #171a21;', '--text: #e6e8ee;', '--muted: #9aa3b2;', '--accent: #6c8cff;']) {
    assert.ok(css.includes(token), token);
  }
  const button = css.match(/\.gsi-button \{([^}]*)\}/);
  assert.ok(button, 'login.css has a .gsi-button rule');
  for (const decl of ['background: #131314;', 'border: 1px solid #8E918F;', 'color: #E3E3E3;', 'height: 40px;',
    'border-radius: 20px;', 'padding: 0 12px;', 'gap: 10px;', 'font-size: 14px;', 'font-weight: 500;']) {
    assert.ok(button[1].includes(decl), decl);
  }
  assert.match(css, /\.gsi-icon \{[^}]*width: 18px; height: 18px;/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
});

// ---- Page glue in a fake DOM ----

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.title = '';
  }

  get textContent() {
    return this.children.map(child => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(value) {
    this.children = [String(value)];
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type) {
    return Promise.all((this.listeners.get(type) || []).map(listener => listener({ type, target: this })));
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node !== 'string') node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

/** Run a public/ script in a fresh vm context with a fake window (no `module`, so its browser branch runs). */
function runInFakePage(file, { elements, hidden = [], pathname = '/', search = '', fetch }) {
  const byId = new Map(Object.entries(elements).map(([id, tag]) => [id, new FakeElement(tag)]));
  for (const id of hidden) byId.get(id).hidden = true;
  const location = {
    pathname,
    search,
    assigned: [],
    replaced: [],
    assign(url) { this.assigned.push(url); },
    replace(url) { this.replaced.push(url); },
  };
  const alerts = [];
  const window = {
    document: {
      readyState: 'complete',
      getElementById: id => byId.get(id) || null,
      createElement: tag => new FakeElement(tag),
      addEventListener() {},
    },
    location,
    fetch,
    alert: message => alerts.push(message),
    URL,
    URLSearchParams,
    console,
  };
  window.window = window;
  const context = vm.createContext(window);
  const source = readPublic(file);
  vm.runInContext(source, context, { filename: file });
  return { window, context, source, byId, location, alerts };
}

async function waitFor(predicate, what) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const jsonResponse = (statusCode, body, headers = {}) => new Response(JSON.stringify(body), {
  status: statusCode, headers: { 'Content-Type': 'application/json', ...headers },
});

const LOGIN_ELEMENTS = { googleLoginBtn: 'a', loginMessage: 'div', controllerLink: 'a', loginHelp: 'div' };

function loginPage(search, answer) {
  const requests = [];
  const page = runInFakePage('login.js', {
    elements: LOGIN_ELEMENTS,
    hidden: ['controllerLink', 'loginHelp'],
    pathname: '/login',
    search,
    fetch: async (url, init) => {
      requests.push([url, init]);
      return answer();
    },
  });
  page.requests = requests;
  page.el = id => page.byId.get(id);
  return page;
}

const messagesOf = element => element.children.map(p => [p.dataset.kind, p.textContent]);

test('login page glue: login on shows the button with next and the mapped error', async () => {
  const page = loginPage('?error=not_allowed&email=%3Cb%3Ex%3C%2Fb%3E%40example.com&next=%2Fanimate',
    () => jsonResponse(200, status()));
  // The href is set before the status arrives.
  assert.equal(page.el('googleLoginBtn').getAttribute('href'), '/auth/google/login?next=%2Fanimate');
  await waitFor(() => page.el('loginMessage').children.length > 0, 'the login message');
  assert.equal(page.requests[0][0], '/api/auth/status');
  assert.equal(page.requests[0][1].cache, 'no-store');
  assert.equal(page.el('googleLoginBtn').hidden, false);
  assert.deepEqual(messagesOf(page.el('loginMessage')), [['error', '<b>x</b>@example.com 계정은 허용 목록에 없습니다.']]);
  // The email is one text node inside a <p>, never parsed markup.
  assert.deepEqual(page.el('loginMessage').children[0].children, ['<b>x</b>@example.com 계정은 허용 목록에 없습니다.']);
  assert.equal(page.el('controllerLink').hidden, true);
  assert.equal(page.el('loginHelp').hidden, true);
  assert.deepEqual(page.location.replaced, []);
});

test('login page glue: login off hides the button and shows the link and the setup hint', async () => {
  const page = loginPage('', () => jsonResponse(200, status({ mode: 'disabled' })));
  await waitFor(() => page.el('loginHelp').hidden === false, 'the setup hint');
  assert.equal(page.el('googleLoginBtn').hidden, true);
  assert.equal(page.el('controllerLink').hidden, false);
  assert.deepEqual(messagesOf(page.el('loginMessage')), [['info', 'Google 로그인이 꺼져 있습니다. 지금은 로그인 없이 쓸 수 있습니다.']]);
  assert.deepEqual(page.el('loginHelp').children.map(p => p.textContent), [
    '설정 파일: data/auth/config.json',
    '리디렉션 URI: http://127.0.0.1:8787/auth/google/callback',
  ]);
  assert.equal(page.el('loginHelp').children[1].children[1].tagName, 'CODE');
});

test('login page glue: a signed-in visitor goes straight to next', async () => {
  const page = loginPage('?next=%2Fanimate%3Fx%3D1', () => jsonResponse(200, status({ loggedIn: true })));
  await waitFor(() => page.location.replaced.length > 0, 'the redirect');
  assert.deepEqual(page.location.replaced, ['/animate?x=1']);
  assert.equal(page.el('loginMessage').children.length, 0);
});

test('login page glue: a failed status request keeps the button', async () => {
  for (const answer of [() => jsonResponse(404, { error: 'Not found.' }), () => { throw new TypeError('Failed to fetch'); },
    () => new Response('not json', { status: 200 })]) {
    const page = loginPage('?logged_out=1', answer);
    await waitFor(() => page.el('loginMessage').children.length > 0, 'the offline message');
    assert.equal(page.el('googleLoginBtn').hidden, false);
    assert.deepEqual(messagesOf(page.el('loginMessage')), [['error', '서버에 연결하지 못했습니다.']]);
  }
});

function authPage({ me, routes = {}, pathname = '/animate', search = '?x=1' }) {
  const requests = [];
  const page = runInFakePage('auth.js', {
    elements: { authSlot: 'div' },
    hidden: ['authSlot'],
    pathname,
    search,
    fetch: async (url, init = {}) => {
      // Copied: objects made inside the vm context have another realm's prototypes.
      requests.push({ url, method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body });
      const route = url === '/api/auth/me' ? me : routes[url];
      if (!route) return jsonResponse(404, { error: 'Not found.' });
      return route();
    },
  });
  page.requests = requests;
  page.slot = page.byId.get('authSlot');
  return page;
}

const signedIn = (user = {}) => () => jsonResponse(200, {
  enabled: true,
  user: { email: 'someone@gmail.com', name: 'Some One', picture: 'https://lh3.googleusercontent.com/a/pic', ...user },
  overlayKey: 'key-1',
});

test('auth.js glue: login on fills the chip; 로그아웃 posts {} and goes to /login?logged_out=1', async () => {
  const page = authPage({ me: signedIn(), routes: { '/auth/logout': () => jsonResponse(200, { ok: true }) } });
  const { VirtuallyAuth } = page.window;
  assert.deepEqual(Object.keys(VirtuallyAuth).sort(), ['loginUrlFor', 'logout', 'overlayUrlFor', 'ready', 'rotateOverlayKey']);
  const me = await VirtuallyAuth.ready;
  assert.equal(me.overlayKey, 'key-1');
  await waitFor(() => page.slot.hidden === false, 'the chip');
  const [avatar, name, button] = page.slot.children;
  assert.equal(avatar.tagName, 'IMG');
  assert.equal(avatar.className, 'auth-avatar');
  assert.equal(avatar.alt, '');
  assert.equal(avatar.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(avatar.src, 'https://lh3.googleusercontent.com/a/pic');
  assert.equal(name.textContent, 'Some One');
  assert.equal(name.title, 'someone@gmail.com');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.textContent, '로그아웃');
  // A broken picture is dropped instead of showing a broken image.
  await avatar.dispatch('error');
  assert.deepEqual(page.slot.children, [name, button]);

  await button.dispatch('click');
  const logout = page.requests.find(r => r.url === '/auth/logout');
  assert.deepEqual(logout, { url: '/auth/logout', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.deepEqual(page.location.assigned, ['/login?logged_out=1']);
});

test('auth.js glue: no picture -> no avatar; no name -> the email', async () => {
  const page = authPage({ me: signedIn({ name: null, picture: null }) });
  await page.window.VirtuallyAuth.ready;
  await waitFor(() => page.slot.hidden === false, 'the chip');
  assert.deepEqual(page.slot.children.map(el => el.tagName), ['SPAN', 'BUTTON']);
  assert.equal(page.slot.children[0].textContent, 'someone@gmail.com');
});

test('auth.js glue: login off, an older server or no server leaves the chip hidden', async () => {
  for (const me of [
    () => jsonResponse(200, { enabled: false, user: null, overlayKey: null }),
    () => jsonResponse(404, { error: 'Not found.' }),
    () => { throw new TypeError('Failed to fetch'); },
    () => new Response('<html>', { status: 200 }),
  ]) {
    const page = authPage({ me });
    const ready = await page.window.VirtuallyAuth.ready;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(page.slot.hidden, true);
    assert.deepEqual(page.slot.children, []);
    assert.deepEqual(page.location.assigned, []);
    if (ready) assert.deepEqual({ ...ready }, { enabled: false, user: null, overlayKey: null });
  }
});

test('auth.js glue: a refused request sends the browser to /login once, with the page as next', async () => {
  const required = () => jsonResponse(401, { error: '로그인이 필요합니다.', code: 'auth_required' }, { 'X-Virtually-Auth': 'required' });
  const page = authPage({ me: required, routes: { '/api/trigger': required, '/api/plain401': () => jsonResponse(401, {}) } });
  assert.equal(await page.window.VirtuallyAuth.ready, null);
  assert.deepEqual(page.location.assigned, ['/login?next=%2Fanimate%3Fx%3D1']);
  // Later refusals keep returning the response and do not navigate again.
  const response = await page.window.fetch('/api/trigger', { method: 'POST' });
  assert.equal(response.status, 401);
  assert.equal((await page.window.fetch('/api/plain401')).status, 401);
  assert.deepEqual(page.location.assigned, ['/login?next=%2Fanimate%3Fx%3D1']);
  assert.equal(page.slot.hidden, true);
});

test('auth.js glue: rotateOverlayKey posts {} and returns the key or the server error text', async () => {
  let answer = () => jsonResponse(200, { overlayKey: 'key-2' });
  const page = authPage({ me: signedIn(), routes: { '/api/auth/overlay-key': () => answer() } });
  const { VirtuallyAuth } = page.window;
  assert.deepEqual({ ...(await VirtuallyAuth.rotateOverlayKey()) }, { overlayKey: 'key-2' });
  const post = page.requests.find(r => r.url === '/api/auth/overlay-key');
  assert.deepEqual(post, { url: '/api/auth/overlay-key', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  answer = () => jsonResponse(409, { error: 'Google 로그인이 꺼져 있습니다.', code: 'auth_disabled' });
  await assert.rejects(VirtuallyAuth.rotateOverlayKey(), { message: 'Google 로그인이 꺼져 있습니다.' });
  answer = () => new Response('oops', { status: 500 });
  await assert.rejects(VirtuallyAuth.rotateOverlayKey(), { message: 'HTTP 500' });
  answer = () => jsonResponse(200, { overlayKey: '' });
  await assert.rejects(VirtuallyAuth.rotateOverlayKey(), { message: '새 주소를 받지 못했습니다.' });
  answer = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(VirtuallyAuth.rotateOverlayKey(), { message: '서버에 연결하지 못했습니다.' });
  assert.equal(VirtuallyAuth.overlayUrlFor('http://127.0.0.1:8787', 'key-2'), 'http://127.0.0.1:8787/overlay?key=key-2');
});

test('auth.js glue: a failed logout re-enables the button and says so', async () => {
  const page = authPage({ me: signedIn(), routes: { '/auth/logout': () => { throw new TypeError('Failed to fetch'); } } });
  await page.window.VirtuallyAuth.ready;
  await waitFor(() => page.slot.hidden === false, 'the chip');
  const button = page.slot.children.at(-1);
  await button.dispatch('click');
  assert.equal(button.disabled, false);
  assert.deepEqual(page.alerts, ['로그아웃하지 못했습니다. 서버에 연결하지 못했습니다.']);
  assert.deepEqual(page.location.assigned, []);
});

test('auth.js wraps fetch once, even when the script runs twice', async () => {
  const page = authPage({ me: () => jsonResponse(200, { enabled: false, user: null, overlayKey: null }) });
  const wrapped = page.window.fetch;
  const api = page.window.VirtuallyAuth;
  vm.runInContext(page.source, page.context, { filename: 'auth.js' });
  assert.equal(page.window.fetch, wrapped);
  assert.equal(page.window.VirtuallyAuth, api);
  await api.ready;
  assert.equal(page.requests.filter(r => r.url === '/api/auth/me').length, 1);
});
