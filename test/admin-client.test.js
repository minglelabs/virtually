'use strict';

// Client side of the admin page (/admin, 크레딧 관리): admin.js helpers (the adjust
// form's rules and requestId reuse, the users table, one account's history) and its
// page glue, which runs in a vm context against a small fake DOM built from
// admin.html's ids (auth.js and billing.js are loaded first, as on the real page).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const A = require('../public/admin.js');
const billing = require('../public/billing.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = file => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

// ---- The adjust form ----

test('emails are trimmed and lower-cased; one address with text on both sides of one @', () => {
  assert.equal(A.normalizeEmail('  Some.One@Gmail.COM '), 'some.one@gmail.com');
  for (const bad of [null, undefined, 42, {}]) assert.equal(A.normalizeEmail(bad), '');
  for (const email of ['a@b', 'some.one@gmail.com', 'x+tag@example.co.kr', `${'a'.repeat(240)}@example.com`]) {
    assert.equal(A.isValidEmail(email), true, email);
  }
  for (const email of ['', 'no-at-sign', '@example.com', 'someone@', 'a@b@c', 'a b@c.com', 'a@b.com\n', 'a\u0000@b.com',
    `${'a'.repeat(250)}@b.com`, null, 42]) {
    assert.equal(A.isValidEmail(email), false, JSON.stringify(email));
  }
  assert.equal(A.MAX_EMAIL_LENGTH, 254);
});

test('parseCredits takes whole credits 1..100,000,000, with commas and spaces as typed', () => {
  assert.equal(A.parseCredits('50000'), 50000);
  assert.equal(A.parseCredits(' 50,000 '), 50000);
  assert.equal(A.parseCredits('1'), 1);
  assert.equal(A.parseCredits('100,000,000'), 100000000);
  assert.equal(A.parseCredits('1 000'), 1000);
  assert.equal(A.parseCredits(7), 7);
  for (const bad of ['', '0', '-500', '+500', '12.5', '1e3', '100000001', '999999999', '1234567890', 'abc', '５００', null, undefined]) {
    assert.equal(A.parseCredits(bad), null, JSON.stringify(bad));
  }
  assert.equal(A.MAX_CREDITS, 100000000);
});

test('the memo is trimmed and at most 200 characters', () => {
  assert.equal(A.normalizeMemo('  9/30 계좌이체 50,000원, 입금자 홍길동 '), '9/30 계좌이체 50,000원, 입금자 홍길동');
  assert.equal(A.normalizeMemo(''), '');
  assert.equal(A.normalizeMemo(undefined), '');
  assert.equal(A.normalizeMemo('가'.repeat(200)), '가'.repeat(200));
  assert.equal(A.normalizeMemo(` ${'가'.repeat(200)} `), '가'.repeat(200));
  assert.equal(A.normalizeMemo('가'.repeat(201)), null);
});

test('adjustRequest: the signed body for 충전 / 차감, the confirmation, and the first field to fix', () => {
  const fields = { email: ' Customer@Gmail.com ', credits: '50,000', memo: ' 9/30 계좌이체 ' };
  assert.deepEqual(A.adjustRequest(fields, 'topup'), {
    ok: true,
    body: { email: 'customer@gmail.com', credits: 50000, memo: '9/30 계좌이체' },
    question: 'customer@gmail.com에 50,000 크레딧을 충전할까요?',
  });
  assert.deepEqual(A.adjustRequest(fields, 'deduct'), {
    ok: true,
    body: { email: 'customer@gmail.com', credits: -50000, memo: '9/30 계좌이체' },
    question: 'customer@gmail.com에 50,000 크레딧을 차감할까요?',
  });
  // No memo: no memo field at all.
  assert.deepEqual(A.adjustRequest({ ...fields, memo: '   ' }, 'topup').body, { email: 'customer@gmail.com', credits: 50000 });
  assert.deepEqual(A.adjustRequest({ ...fields, email: 'nope' }, 'topup'),
    { ok: false, field: 'email', text: '이메일 주소를 확인해 주세요.' });
  assert.deepEqual(A.adjustRequest({ ...fields, email: 'nope', credits: '' }, 'topup').field, 'email');
  assert.deepEqual(A.adjustRequest({ ...fields, credits: '0' }, 'deduct'),
    { ok: false, field: 'credits', text: '크레딧은 1부터 100,000,000까지의 정수로 적어 주세요.' });
  assert.deepEqual(A.adjustRequest({ ...fields, memo: 'x'.repeat(201) }, 'topup'),
    { ok: false, field: 'memo', text: '메모는 200자까지 쓸 수 있습니다.' });
  assert.equal(A.adjustRequest(null, 'topup').field, 'email');
  assert.equal(A.confirmText('a@b.com', 1500), 'a@b.com에 1,500 크레딧을 충전할까요?');
  assert.equal(A.confirmText('a@b.com', -1500), 'a@b.com에 1,500 크레딧을 차감할까요?');
});

test('requestId: a new one per submit, the same one when retrying a submit that got no definite answer', () => {
  let n = 0;
  const makeId = () => `req-new-${n += 1}`;
  const body = { email: 'a@b.com', credits: 50000, memo: '9/30' };
  assert.equal(A.requestIdFor(null, body, makeId), 'req-new-1');
  const retry = { key: A.submitKey(body), requestId: 'req-first-1' };
  assert.equal(A.requestIdFor(retry, body, makeId), 'req-first-1');
  assert.equal(A.requestIdFor(retry, { ...body }, makeId), 'req-first-1');
  // Any change makes it another submit.
  for (const other of [{ ...body, credits: -50000 }, { ...body, credits: 5000 }, { ...body, email: 'c@d.com' },
    { ...body, memo: '9/31' }, { email: 'a@b.com', credits: 50000 }]) {
    assert.notEqual(A.requestIdFor(retry, other, makeId), 'req-first-1', JSON.stringify(other));
  }
  assert.equal(A.submitKey({ email: 'a@b.com', credits: 1 }), A.submitKey({ email: 'a@b.com', credits: 1, memo: '' }));
  // A stored id the server would refuse is not reused.
  assert.equal(A.requestIdFor({ key: A.submitKey(body), requestId: 'short' }, body, makeId), `req-new-${n}`);

  // Unknown outcome = no answer at all, or a server error; a 4xx is a definite "not applied".
  assert.equal(A.outcomeUnknown({ ok: false, status: 0, code: 'network' }), true);
  assert.equal(A.outcomeUnknown({ ok: false, status: 500, code: null }), true);
  assert.equal(A.outcomeUnknown({ ok: false, status: 502, code: null }), true);
  for (const definite of [{ ok: false, status: 400, code: 'bad_request' }, { ok: false, status: 409, code: 'insufficient_balance' },
    { ok: false, status: 403, code: 'admin_only' }, { ok: true, status: 200, body: {} }, null]) {
    assert.equal(A.outcomeUnknown(definite), false, JSON.stringify(definite));
  }
});

test('newRequestId: crypto.randomUUID, else 32 hex characters; always a valid requestId', () => {
  assert.equal(A.newRequestId({ randomUUID: () => '0b9d5a3e-7c1f-4c1e-9f3a-2d4b6c8e0f12' }), '0b9d5a3e-7c1f-4c1e-9f3a-2d4b6c8e0f12');
  const fromBytes = A.newRequestId({ getRandomValues: (bytes) => { bytes.fill(171); return bytes; } });
  assert.equal(fromBytes, 'ab'.repeat(16));
  const fallback = A.newRequestId(undefined);
  assert.match(fallback, /^[0-9a-f]{32}$/);
  for (const id of [A.newRequestId(globalThis.crypto), fromBytes, fallback]) assert.match(id, A.REQUEST_ID_PATTERN);
  assert.notEqual(A.newRequestId(globalThis.crypto), A.newRequestId(globalThis.crypto));
});

test('adjustMessages: the new balance, then why the customer may not see it yet', () => {
  const answer = (user, loginAllowed = true) => ({ user: { email: 'a@b.com', sub: 'sub-1', balance: 51234, pending: false, ...user },
    entry: { id: 'e1', at: '2026-09-30T07:00:00.000Z', delta: 50000, kind: 'topup', label: '관리자 충전' }, loginAllowed });
  assert.deepEqual(A.adjustMessages(answer({})), [{ kind: 'success', text: 'a@b.com 잔액 51,234 크레딧' }]);
  assert.deepEqual(A.adjustMessages(answer({ sub: null, pending: true, balance: 50000 }, false)), [
    { kind: 'success', text: 'a@b.com 잔액 50,000 크레딧' },
    { kind: 'warn', text: '아직 로그인한 적 없는 이메일입니다. 처음 로그인하면 반영됩니다.' },
    { kind: 'warn', text: '이 이메일은 로그인 허용 목록(data/auth/config.json의 allowedEmails)에 없어 아직 로그인할 수 없습니다.' },
  ]);
  assert.equal(A.adjustMessages(answer({ balance: -5 }, false)).length, 2);
  // A duplicate answer is the first result again: the same messages.
  assert.deepEqual(A.adjustMessages({ ...answer({}), duplicate: true }), A.adjustMessages(answer({})));
});

test('adminErrorText: bad_request names its field; other codes use the billing page texts', () => {
  const failure = (code, detail = null, status = 400) => ({ ok: false, status, code, error: 'English text', detail });
  assert.equal(A.adminErrorText(failure('bad_request', { field: 'email' })), '이메일 주소를 확인해 주세요.');
  assert.equal(A.adminErrorText(failure('bad_request', { field: 'credits' })), '크레딧은 1부터 100,000,000까지의 정수로 적어 주세요.');
  assert.equal(A.adminErrorText(failure('bad_request', { field: 'memo' })), '메모는 200자까지 쓸 수 있습니다.');
  assert.equal(A.adminErrorText(failure('bad_request', { field: 'requestId' })), '입력한 내용을 확인해 주세요.');
  assert.equal(A.adminErrorText(failure('bad_request')), '입력한 내용을 확인해 주세요.');
  assert.equal(A.adminErrorText(failure('insufficient_balance', { balance: 3000 }, 409)), '잔액보다 많이 차감할 수 없습니다 (잔액 3,000)');
  assert.equal(A.adminErrorText(failure('admin_only', null, 403)), '관리자만 쓸 수 있습니다.');
  assert.equal(A.adminErrorText(failure('billing_disabled', null, 409)), '크레딧 결제가 꺼져 있습니다.');
  assert.equal(A.adminErrorText({ ok: false, status: 0, code: 'network' }), '서버에 연결하지 못했습니다.');
  assert.equal(A.adminErrorText({ ok: false, status: 500, code: null, error: null }), 'HTTP 500');
});

test('refusalMessage: not an admin, billing off or misconfigured, and no server', () => {
  assert.deepEqual(A.refusalMessage({ ok: false, status: 403, code: 'admin_only' }), { kind: 'error', text: '관리자만 볼 수 있습니다.' });
  assert.deepEqual(A.refusalMessage({ ok: false, status: 409, code: 'billing_disabled' }), { kind: 'info', text: billing.TEXT.disabled });
  assert.deepEqual(A.refusalMessage({ ok: false, status: 503, code: 'billing_misconfigured', detail: { problem: 'bad_admin_emails' } }),
    { kind: 'error', text: '결제 설정에 문제가 있습니다: adminEmails에 관리자 이메일을 넣어 주세요.' });
  assert.deepEqual(A.refusalMessage({ ok: false, status: 503, code: 'billing_misconfigured', detail: null }),
    { kind: 'error', text: '결제 설정에 문제가 있습니다.' });
  assert.deepEqual(A.refusalMessage({ ok: false, status: 0, code: 'network' }), { kind: 'error', text: '서버에 연결하지 못했습니다.' });
  assert.equal(A.refusalMessage({ ok: true, status: 200, body: {} }), null);
  assert.equal(A.refusalMessage(null), null);
  for (const code of ['admin_only', 'billing_disabled', 'billing_misconfigured']) assert.equal(A.isPageRefusal({ ok: false, code }), true);
  for (const code of ['network', 'bad_request', null]) assert.equal(A.isPageRefusal({ ok: false, code }), false);
});

// ---- Users and history ----

test('rateText, search and paths', () => {
  assert.equal(A.rateText(2000), '1크레딧 = 1원 · 원가 1달러 = 2,000 크레딧');
  assert.equal(A.rateText(1500), '1크레딧 = 1원 · 원가 1달러 = 1,500 크레딧');
  for (const bad of [undefined, null, 0, 1.5, '2000']) assert.equal(A.rateText(bad), '1크레딧 = 1원');
  assert.equal(A.searchQuery('  홍길동 '), '홍길동');
  assert.equal(A.searchQuery('x'.repeat(150)), 'x'.repeat(100));
  assert.equal(A.searchQuery(null), '');
  assert.equal(A.usersPath(''), '/api/billing/admin/users');
  assert.equal(A.usersPath('   '), '/api/billing/admin/users');
  assert.equal(A.usersPath(' Kim & Lee '), '/api/billing/admin/users?q=Kim%20%26%20Lee');
  assert.equal(A.historyPath('a+b@c.com'), '/api/billing/admin/history?email=a%2Bb%40c.com');
});

test('userRow and usersView: email, name, balance, last activity and the 상태 column', () => {
  const at = new Date(2026, 8, 30, 14, 5).toISOString();
  const payload = {
    creditsPerUsd: 2000,
    users: [
      { email: 'a@b.com', name: 'Some One', sub: 'sub-1', balance: 51234, pending: false, lastAt: at, loginAllowed: true },
      { email: 'new@b.com', name: null, sub: null, balance: 50000, pending: true, lastAt: null, loginAllowed: false },
      { email: 'minus@b.com', name: '<b>x</b>', sub: 'sub-3', balance: -600, pending: false, lastAt: at, loginAllowed: false },
      { name: 'no email' },
      null,
    ],
  };
  const view = A.usersView(payload, '');
  assert.equal(view.rate, '1크레딧 = 1원 · 원가 1달러 = 2,000 크레딧');
  assert.equal(view.empty, null);
  assert.deepEqual(view.rows, [
    { email: 'a@b.com', name: 'Some One', balance: '51,234', negative: false, lastAt: '9월 30일 14:05', at, status: '' },
    { email: 'new@b.com', name: '', balance: '50,000', negative: false, lastAt: '', at: '', status: '로그인 전 · 로그인 불가' },
    { email: 'minus@b.com', name: '<b>x</b>', balance: '-600', negative: true, lastAt: '9월 30일 14:05', at, status: '로그인 불가' },
  ]);
  assert.equal(A.userStatusText({ pending: true, loginAllowed: true }), '로그인 전');
  assert.equal(A.usersView({ creditsPerUsd: 2000, users: [] }, '').empty, '아직 사용자가 없습니다.');
  assert.equal(A.usersView({ creditsPerUsd: 2000, users: [] }, ' kim ').empty, '찾는 사용자가 없습니다.');
  assert.equal(A.usersView(null, '').rate, '1크레딧 = 1원');
});

test('historyView: the billing page rows plus who adjusted, and a summary line', () => {
  const payload = {
    email: 'a@b.com',
    balance: 49000,
    pending: false,
    entries: [
      { id: 'e3', at: new Date(2026, 8, 30, 16, 20).toISOString(), delta: -1000, kind: 'deduct', label: '관리자 차감 · 잘못 충전', by: 'owner@gmail.com' },
      { id: 'e2', at: new Date(2026, 8, 30, 16, 10).toISOString(), delta: 50000, kind: 'topup', label: '관리자 충전', by: 'owner@gmail.com' },
      { id: 'e1', at: new Date(2026, 8, 30, 16, 30).toISOString(), delta: -600, kind: 'charge', label: 'Wan 2.2 Animate 2 · 인사 (Hi)', by: null },
      'junk',
    ],
  };
  const view = A.historyView(payload);
  assert.equal(view.email, 'a@b.com');
  assert.equal(view.summary, 'a@b.com · 잔액 49,000 크레딧');
  assert.equal(view.empty, null);
  assert.deepEqual(view.entries.map(e => [e.time, e.label, e.kind, e.delta, e.sign, e.by]), [
    ['9월 30일 16:20', '관리자 차감 · 잘못 충전', '차감', '-1,000', 'minus', 'owner@gmail.com'],
    ['9월 30일 16:10', '관리자 충전', '충전', '+50,000', 'plus', 'owner@gmail.com'],
    ['9월 30일 16:30', 'Wan 2.2 Animate 2 · 인사 (Hi)', '사용', '-600', 'minus', ''],
  ]);
  assert.deepEqual(A.historyView({ email: 'new@b.com', balance: 0, pending: true, entries: [] }),
    { email: 'new@b.com', summary: 'new@b.com · 잔액 0 크레딧 · 로그인 전', entries: [], empty: '아직 내역이 없습니다.' });
  assert.equal(A.historyView(null).summary, '');
});

// ---- Static wiring ----

test('admin page: header like /billing, billing.css + admin.css, auth.js then billing.js then admin.js', () => {
  const html = readPublic('admin.html');
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /<title>크레딧 관리 · Virtually<\/title>/);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(styles, ['billing.css', 'admin.css', 'auth.css']);
  const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['auth.js', 'billing.js', 'admin.js']);
  assert.doesNotMatch(html, /<script>|animate\.js|app\.js|credits\.js/);
  assert.match(html,
    /<header class="page-header">\s*<nav class="page-links" aria-label="[^"]+">\s*<a href="\/" class="back-link">컨트롤러<\/a>\s*<a href="\/animate" class="back-link">동작 만들기<\/a>\s*<a href="\/billing" class="back-link">크레딧<\/a>\s*<a href="\/admin\/activity" class="back-link">활동 · 자료<\/a>\s*<\/nav>\s*<h1>크레딧 관리<\/h1>\s*<div id="authSlot" class="auth-slot" hidden><\/div>\s*<\/header>/);
  // The form: labels, hints and the placeholder from the spec.
  assert.match(html, /<label for="emailInput">이메일<\/label>/);
  assert.match(html, /<label for="creditsInput">크레딧<\/label>/);
  assert.match(html, /<p id="creditsHint" class="hint">입금액\(원\) = 크레딧<\/p>/);
  assert.match(html, /<label for="memoInput">메모<\/label>/);
  assert.match(html, /placeholder="예: 9\/30 계좌이체 50,000원, 입금자 홍길동"/);
  assert.match(html, /<p id="memoHint" class="hint">고객의 사용 내역에도 보입니다<\/p>/);
  // type="button": pressing Enter in a field never tops anything up.
  assert.match(html, /<button type="button" id="topupBtn" class="btn">충전<\/button>/);
  assert.match(html, /<button type="button" id="deductBtn" class="btn btn-ghost">차감<\/button>/);
  assert.doesNotMatch(html, /type="submit"/);
  const headers = [...html.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(headers, ['이메일', '이름', '잔액', '최근 활동', '상태']);
  assert.match(html, /<h2 id="historyTitle">사용 내역<\/h2>/);
  assert.match(html, /<div id="adminMessage" class="messages" role="alert"><\/div>/);
  assert.match(html, /<div id="adjustResult" class="messages adjust-result" role="status" aria-live="polite"><\/div>/);
});

test('users table on a phone: values stay on one line and the table scrolls sideways inside its card', () => {
  const html = readPublic('admin.html');
  // The table is the only child of its scroll box, inside the card.
  assert.match(html, /<section id="usersCard" class="card"[\s\S]*<div class="table-wrap">\s*<table id="usersTable" class="users-table" hidden>[\s\S]*<\/table>\s*<\/div>[\s\S]*<\/section>/);
  const css = readPublic('admin.css');
  const rule = selector => {
    const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
    assert.ok(match, selector);
    return match[1];
  };
  assert.match(rule('.table-wrap'), /overflow-x: auto;/);
  assert.match(rule('.users-table th, .users-table td'), /white-space: nowrap;/);
  assert.match(rule('.user-pick'), /white-space: nowrap;/);
  // Emails and names are never broken mid-word (the page scrolls the table instead).
  for (const selector of ['.users-table th, .users-table td', '.user-pick', '.users-table .user-name']) {
    assert.doesNotMatch(rule(selector), /overflow-wrap|word-break/, selector);
  }
});

test('every element admin.js looks up exists once in admin.html; no HTML strings', () => {
  const html = readPublic('admin.html');
  const js = readPublic('admin.js');
  const ids = [...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(ids.length >= 20);
  for (const id of ids) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // The shared texts come from billing.js, not copies (comments may quote them).
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const text of ['크레딧 결제가 꺼져 있습니다', '결제 설정에 문제가 있습니다', '서버에 연결하지 못했습니다', '1크레딧 = 1원']) {
    assert.ok(!code.includes(text), text);
  }
  assert.match(code, /B\.TEXT\.rate/);
});

// ---- Page glue in a fake DOM ----

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.value = '';
    this.focused = 0;
  }

  get children() { return this.childNodes.filter(node => typeof node !== 'string'); }

  get textContent() {
    return this.childNodes.map(node => (typeof node === 'string' ? node : node.textContent)).join('');
  }

  set textContent(value) { this.childNodes = [String(value)]; }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, event = {}) {
    return Promise.all((this.listeners.get(type) || []).map(listener => listener({ type, target: this, ...event })));
  }

  click() { return this.dispatch('click'); }

  focus() { this.focused += 1; }

  adopt(node) {
    // A real DOM renders null as the text "null": fail loudly instead.
    if (node == null) throw new Error(`null child appended to <${this.tagName}>`);
    if (typeof node !== 'string') {
      node.remove();
      node.parentNode = this;
    }
    return node;
  }

  append(...nodes) { for (const node of nodes) this.childNodes.push(this.adopt(node)); }

  prepend(...nodes) { this.childNodes.unshift(...nodes.map(node => this.adopt(node))); }

  replaceChildren(...nodes) {
    for (const node of this.children) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    parent.adopt(node);
    parent.childNodes[parent.childNodes.indexOf(this)] = node;
    this.parentNode = null;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this);
    this.parentNode = null;
  }
}

/** Every element with an id in a public page, as { id: { tag, hidden } }. */
function pageElements(file) {
  const elements = {};
  for (const [, tag, attrs] of readPublic(file).matchAll(/<([a-z0-9]+)\s([^>]*\bid="[^"]+"[^>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(attrs)[1];
    elements[id] = { tag, hidden: /\shidden(\s|$)/.test(` ${attrs} `) };
  }
  return elements;
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const signedIn = () => jsonResponse(200, {
  enabled: true,
  user: { email: 'owner@gmail.com', name: 'Owner', picture: null },
  overlayKey: 'key-1',
});

const adminBilling = (over = {}) => ({
  enabled: true, mode: 'enabled', problem: null, server: null, creditsPerUsd: 2000, free: true, balance: 0,
  products: [], productsError: null, history: [], canManage: false, isAdmin: true, polar: false, transferNote: null, ...over,
});

/**
 * admin.html with auth.js, billing.js and admin.js in one fresh vm context (no
 * `module`, so their browser branch runs). `routes` maps 'METHOD /path' (the query
 * included) to (body) => Response | Promise<Response>. Timers wait for page.flushTimers().
 */
function adminPage({ routes = {}, confirmAnswer = true } = {}) {
  const document = {
    readyState: 'complete',
    byId: new Map(),
    getElementById(id) { return this.byId.get(id) || null; },
    createElement: tag => new FakeElement(tag),
    addEventListener() {},
  };
  for (const [id, { tag, hidden }] of Object.entries(pageElements('admin.html'))) {
    const element = new FakeElement(tag);
    element.hidden = hidden;
    document.byId.set(id, element);
  }
  const requests = [];
  const confirms = [];
  const timers = new Map();
  let timerId = 0;
  let uuid = 0;
  const window = {
    document,
    location: { pathname: '/admin', search: '', hash: '', assigned: [], assign(url) { this.assigned.push(url); } },
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      requests.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: { ...(init.headers || {}) } });
      const route = routes[`${method} ${url}`];
      if (!route) return jsonResponse(404, { error: 'Not found.', code: 'not_found' });
      return route(init.body === undefined ? undefined : JSON.parse(init.body));
    },
    setTimeout(callback, ms) {
      timerId += 1;
      timers.set(timerId, { callback, ms });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    confirm(text) {
      confirms.push(text);
      return typeof confirmAnswer === 'function' ? confirmAnswer(text) : confirmAnswer;
    },
    crypto: { randomUUID: () => `uuid-${String(uuid += 1).padStart(8, '0')}` },
    alert() {},
    URL,
    URLSearchParams,
    console,
  };
  window.window = window;
  const context = vm.createContext(window);
  for (const file of ['auth.js', 'billing.js', 'admin.js']) vm.runInContext(readPublic(file), context, { filename: file });
  return {
    window,
    el: id => document.byId.get(id),
    requests,
    confirms,
    timers,
    flushTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const { callback } of due) callback();
    },
    posts: () => requests.filter(r => r.method === 'POST' && r.url === '/api/billing/admin/adjust'),
    gets: prefix => requests.filter(r => r.method === 'GET' && r.url.startsWith(prefix)),
  };
}

async function waitFor(predicate, what) {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const texts = node => node.children.map(child => child.textContent);
const messageOf = node => node.children.map(p => [p.dataset.kind, p.textContent]);
const rowTexts = body => body.children.map(tr => tr.children.map(cell => cell.textContent));

const AT = new Date(2026, 8, 30, 14, 5).toISOString();
const USERS = [
  { email: 'a@b.com', name: '<img src=x onerror=alert(1)>', sub: 'sub-1', balance: 51234, pending: false, lastAt: AT, loginAllowed: true },
  { email: 'new@b.com', name: null, sub: null, balance: 50000, pending: true, lastAt: null, loginAllowed: false },
];
const HISTORY = {
  email: 'a@b.com',
  balance: 49000,
  pending: false,
  entries: [
    { id: 'e3', at: new Date(2026, 8, 30, 16, 20).toISOString(), delta: -1000, kind: 'deduct', label: '관리자 차감 · 잘못 충전', by: 'owner@gmail.com' },
    { id: 'e1', at: new Date(2026, 8, 30, 16, 30).toISOString(), delta: -600, kind: 'charge', label: 'Wan 2.2 Animate 2 · 인사 (Hi)', by: null },
  ],
};

function baseRoutes(over = {}) {
  return {
    'GET /api/auth/me': signedIn,
    'GET /api/billing': () => jsonResponse(200, adminBilling()),
    'GET /api/billing/admin/users': () => jsonResponse(200, { creditsPerUsd: 2000, users: USERS }),
    'GET /api/billing/admin/history?email=a%40b.com': () => jsonResponse(200, HISTORY),
    ...over,
  };
}

test('admin page glue: an admin sees the rate, the form and every account; user data stays text', async () => {
  const page = adminPage({ routes: baseRoutes() });
  await waitFor(() => page.el('usersCard').hidden === false, 'the users');
  assert.equal(page.el('rateText').hidden, false);
  assert.equal(page.el('rateText').textContent, '1크레딧 = 1원 · 원가 1달러 = 2,000 크레딧');
  assert.equal(page.el('adjustCard').hidden, false);
  assert.equal(page.el('historyCard').hidden, true);
  assert.deepEqual(page.el('adminMessage').children, []);
  assert.equal(page.el('usersTable').hidden, false);
  assert.equal(page.el('usersEmpty').hidden, true);
  assert.deepEqual(rowTexts(page.el('usersBody')), [
    ['a@b.com', '<img src=x onerror=alert(1)>', '51,234', '9월 30일 14:05', ''],
    ['new@b.com', '', '50,000', '', '로그인 전 · 로그인 불가'],
  ]);
  const first = page.el('usersBody').children[0];
  assert.deepEqual(first.children[1].childNodes, ['<img src=x onerror=alert(1)>']);
  assert.equal(first.children[0].children[0].tagName, 'BUTTON');
  assert.equal(first.children[0].children[0].getAttribute('type'), 'button');
  assert.equal(first.children[3].children[0].getAttribute('datetime'), AT);
  assert.deepEqual(page.gets('/api/billing/admin/users').map(r => r.url), ['/api/billing/admin/users']);
  // The header chip: credits plus 관리, the current page.
  await page.window.VirtuallyBilling.ready;
  const links = page.el('authSlot').children[0].children;
  assert.deepEqual(links.map(link => [link.textContent, link.getAttribute('aria-current')]), [['크레딧 무료', null], ['관리', 'page']]);
});

test('admin page glue: not an admin, billing off or misconfigured, or no server leaves only the message', async () => {
  const cases = [
    [() => jsonResponse(403, { error: 'Admins only.', code: 'admin_only' }), ['error', '관리자만 볼 수 있습니다.']],
    [() => jsonResponse(409, { error: 'Billing is off.', code: 'billing_disabled' }), ['info', billing.TEXT.disabled]],
    [() => jsonResponse(503, { error: 'Misconfigured.', code: 'billing_misconfigured', detail: { problem: 'bad_transfer_note' } }),
      ['error', '결제 설정에 문제가 있습니다: transferNote는 1000자 이하의 글이어야 합니다.']],
    [() => { throw new TypeError('Failed to fetch'); }, ['error', '서버에 연결하지 못했습니다.']],
  ];
  for (const [answer, message] of cases) {
    const page = adminPage({ routes: baseRoutes({ 'GET /api/billing/admin/users': answer }) });
    await waitFor(() => page.el('adminMessage').children.length > 0, message[1]);
    assert.deepEqual(messageOf(page.el('adminMessage')), [message]);
    for (const id of ['adjustCard', 'usersCard', 'historyCard', 'rateText']) assert.equal(page.el(id).hidden, true, `${id}: ${message[1]}`);
  }
});

test('admin page glue: search waits for typing to pause, asks with q, and only the newest answer draws', async () => {
  const answers = new Map();
  const routes = baseRoutes();
  for (const q of ['kim', 'kimm', 'nobody']) {
    routes[`GET /api/billing/admin/users?q=${q}`] = () => {
      const next = deferred();
      answers.set(q, next);
      return next.promise;
    };
  }
  const page = adminPage({ routes });
  await waitFor(() => page.el('usersCard').hidden === false, 'the users');
  const search = page.el('searchInput');
  for (const value of ['k', 'ki', ' kim ']) {
    search.value = value;
    await search.dispatch('input');
  }
  // One pending search: typing restarts the wait.
  assert.equal(page.timers.size, 1);
  assert.equal([...page.timers.values()][0].ms, 250);
  assert.equal(A.SEARCH_DELAY_MS, 250);
  page.flushTimers();
  await waitFor(() => answers.has('kim'), 'the kim search');
  search.value = 'kimm';
  await search.dispatch('input');
  page.flushTimers();
  await waitFor(() => answers.has('kimm'), 'the kimm search');
  assert.deepEqual(page.gets('/api/billing/admin/users').map(r => r.url),
    ['/api/billing/admin/users', '/api/billing/admin/users?q=kim', '/api/billing/admin/users?q=kimm']);
  answers.get('kimm').resolve(jsonResponse(200, { creditsPerUsd: 2000, users: [USERS[0]] }));
  await waitFor(() => page.el('usersBody').children.length === 1, 'the kimm result');
  // The older, slower answer arrives last and changes nothing.
  answers.get('kim').resolve(jsonResponse(200, { creditsPerUsd: 2000, users: USERS }));
  await settle();
  assert.deepEqual(rowTexts(page.el('usersBody')).map(row => row[0]), ['a@b.com']);

  search.value = 'nobody';
  await search.dispatch('input');
  page.flushTimers();
  await waitFor(() => answers.has('nobody'), 'the nobody search');
  answers.get('nobody').resolve(jsonResponse(200, { creditsPerUsd: 2000, users: [] }));
  await waitFor(() => page.el('usersEmpty').hidden === false, 'the empty result');
  assert.equal(page.el('usersEmpty').textContent, '찾는 사용자가 없습니다.');
  assert.equal(page.el('usersTable').hidden, true);
});

test('admin page glue: a row click fills the email and shows that account history with who adjusted', async () => {
  const page = adminPage({ routes: baseRoutes({
    'GET /api/billing/admin/history?email=new%40b.com': () => new Response('oops', { status: 500 }),
  }) });
  await waitFor(() => page.el('usersBody').children.length === 2, 'the users');
  const row = page.el('usersBody').children[0];
  await row.click();
  assert.equal(page.el('emailInput').value, 'a@b.com');
  assert.equal(row.className, 'is-selected');
  assert.equal(page.el('usersBody').children[1].className, '');
  assert.equal(page.el('historyCard').hidden, false);
  await waitFor(() => page.el('historyList').hidden === false, 'the history');
  assert.deepEqual(page.gets('/api/billing/admin/history').map(r => r.url), ['/api/billing/admin/history?email=a%40b.com']);
  assert.equal(page.el('historySummary').textContent, 'a@b.com · 잔액 49,000 크레딧');
  assert.equal(page.el('historyStatus').textContent, '');
  assert.equal(page.el('historyEmpty').hidden, true);
  assert.deepEqual(page.el('historyList').children.map(texts), [
    ['9월 30일 16:20', '관리자 차감 · 잘못 충전', '차감', '-1,000', 'owner@gmail.com'],
    ['9월 30일 16:30', 'Wan 2.2 Animate 2 · 인사 (Hi)', '사용', '-600'],
  ]);

  // A history request that fails keeps the email and says why.
  const pendingRow = page.el('usersBody').children[1];
  await pendingRow.click();
  await waitFor(() => page.el('historyStatus').textContent !== '불러오는 중…', 'the second history');
  assert.equal(page.el('emailInput').value, 'new@b.com');
  assert.equal(page.el('historyStatus').textContent, 'HTTP 500');
  assert.equal(page.el('historyStatus').dataset.kind, 'error');
  assert.equal(page.el('historyList').hidden, true);
});

function fill(page, { email = 'new@b.com', credits = '50,000', memo = '' } = {}) {
  page.el('emailInput').value = email;
  page.el('creditsInput').value = credits;
  page.el('memoInput').value = memo;
}

const adjusted = (user, loginAllowed = true, extra = {}) => jsonResponse(200, {
  user: { email: 'new@b.com', sub: null, balance: 50000, pending: true, ...user },
  entry: { id: 'e9', at: '2026-09-30T07:10:00.000Z', delta: 50000, kind: 'topup', label: '관리자 충전' },
  loginAllowed,
  ...extra,
});

test('admin page glue: 충전 asks first, posts the signed body with a requestId, and shows the balance and warnings', async () => {
  const answer = deferred();
  const page = adminPage({ routes: baseRoutes({
    'POST /api/billing/admin/adjust': () => answer.promise,
    'GET /api/billing/admin/history?email=new%40b.com': () => jsonResponse(200, { email: 'new@b.com', balance: 50000, pending: true, entries: [] }),
  }) });
  await waitFor(() => page.el('usersCard').hidden === false, 'the users');
  fill(page, { email: ' New@B.com ', credits: '50,000', memo: ' 9/30 계좌이체 50,000원, 입금자 홍길동 ' });
  const clicked = page.el('topupBtn').click();
  await waitFor(() => page.posts().length === 1, 'the adjust request');
  assert.deepEqual(page.confirms, ['new@b.com에 50,000 크레딧을 충전할까요?']);
  const post = page.posts()[0];
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.deepEqual(post.body, { email: 'new@b.com', credits: 50000, memo: '9/30 계좌이체 50,000원, 입금자 홍길동', requestId: 'uuid-00000001' });
  assert.match(post.body.requestId, A.REQUEST_ID_PATTERN);
  // Both buttons wait for the answer.
  assert.equal(page.el('topupBtn').disabled, true);
  assert.equal(page.el('deductBtn').disabled, true);
  assert.deepEqual(messageOf(page.el('adjustResult')), [['pending', '처리하고 있습니다…']]);
  // A second press while pending does nothing.
  await page.el('topupBtn').click();
  assert.equal(page.posts().length, 1);

  answer.resolve(adjusted({}, false));
  await clicked;
  assert.equal(page.el('topupBtn').disabled, false);
  assert.equal(page.el('deductBtn').disabled, false);
  assert.deepEqual(messageOf(page.el('adjustResult')), [
    ['success', 'new@b.com 잔액 50,000 크레딧'],
    ['warn', '아직 로그인한 적 없는 이메일입니다. 처음 로그인하면 반영됩니다.'],
    ['warn', '이 이메일은 로그인 허용 목록(data/auth/config.json의 allowedEmails)에 없어 아직 로그인할 수 없습니다.'],
  ]);
  // Ready for the next transfer: the amount and memo are cleared, the email stays.
  assert.equal(page.el('creditsInput').value, '');
  assert.equal(page.el('memoInput').value, '');
  assert.equal(page.el('emailInput').value, ' New@B.com ');
  // The table, that account's history and the header chip are read again.
  await waitFor(() => page.gets('/api/billing/admin/history').length === 1, 'the history');
  assert.equal(page.gets('/api/billing/admin/history')[0].url, '/api/billing/admin/history?email=new%40b.com');
  await waitFor(() => page.gets('/api/billing/admin/users').length === 2, 'the users again');
  await waitFor(() => page.requests.filter(r => r.url === '/api/billing').length === 2, 'the chip again');
  await waitFor(() => page.el('historyEmpty').hidden === false, 'the empty history');
  assert.equal(page.el('historySummary').textContent, 'new@b.com · 잔액 50,000 크레딧 · 로그인 전');
  assert.equal(page.el('historyEmpty').textContent, '아직 내역이 없습니다.');
});

test('admin page glue: 차감 posts negative credits; a deduct above the balance says the balance', async () => {
  const page = adminPage({ routes: baseRoutes({
    'POST /api/billing/admin/adjust': body => (body.credits < -50000
      ? jsonResponse(409, { error: 'Not enough credits.', code: 'insufficient_balance', detail: { balance: 50000 } })
      : adjusted({ email: 'a@b.com', sub: 'sub-1', balance: 1234, pending: false }, true, { duplicate: true })),
  }) });
  await waitFor(() => page.el('usersCard').hidden === false, 'the users');
  fill(page, { email: 'a@b.com', credits: '60000', memo: '잘못 충전' });
  await page.el('deductBtn').click();
  assert.deepEqual(page.confirms, ['a@b.com에 60,000 크레딧을 차감할까요?']);
  assert.deepEqual(page.posts()[0].body, { email: 'a@b.com', credits: -60000, memo: '잘못 충전', requestId: 'uuid-00000001' });
  assert.deepEqual(messageOf(page.el('adjustResult')), [['error', '잔액보다 많이 차감할 수 없습니다 (잔액 50,000)']]);
  // A refused adjust keeps the fields for a fix.
  assert.equal(page.el('creditsInput').value, '60000');
  assert.equal(page.el('memoInput').value, '잘못 충전');

  page.el('creditsInput').value = '1,000';
  await page.el('deductBtn').click();
  // The definite 409 did not keep its requestId.
  assert.deepEqual(page.posts()[1].body, { email: 'a@b.com', credits: -1000, memo: '잘못 충전', requestId: 'uuid-00000002' });
  assert.deepEqual(messageOf(page.el('adjustResult')), [['success', 'a@b.com 잔액 1,234 크레딧']]);
});

test('admin page glue: a bad field is named before anything is asked; declining the question sends nothing', async () => {
  const page = adminPage({ routes: baseRoutes({
    'POST /api/billing/admin/adjust': () => jsonResponse(400, { error: 'Bad email.', code: 'bad_request', detail: { field: 'email' } }),
  }), confirmAnswer: text => !text.startsWith('decline') && !text.includes('9,999') });
  await waitFor(() => page.el('usersCard').hidden === false, 'the users');
  const cases = [
    [{ email: 'not-an-email' }, 'emailInput', '이메일 주소를 확인해 주세요.'],
    [{ credits: '0' }, 'creditsInput', '크레딧은 1부터 100,000,000까지의 정수로 적어 주세요.'],
    [{ credits: '1.5' }, 'creditsInput', '크레딧은 1부터 100,000,000까지의 정수로 적어 주세요.'],
    [{ memo: 'x'.repeat(201) }, 'memoInput', '메모는 200자까지 쓸 수 있습니다.'],
  ];
  for (const [fields, focused, text] of cases) {
    fill(page, fields);
    const before = page.el(focused).focused;
    await page.el('topupBtn').click();
    assert.deepEqual(messageOf(page.el('adjustResult')), [['error', text]], text);
    assert.equal(page.el(focused).focused, before + 1, focused);
  }
  assert.deepEqual(page.confirms, []);
  // Declined: no request, nothing changes.
  fill(page, { credits: '9,999' });
  await page.el('topupBtn').click();
  assert.deepEqual(page.confirms, ['new@b.com에 9,999 크레딧을 충전할까요?']);
  assert.equal(page.posts().length, 0);
  // The server's own field check is named too.
  fill(page, { credits: '10' });
  await page.el('topupBtn').click();
  assert.equal(page.posts().length, 1);
  assert.deepEqual(messageOf(page.el('adjustResult')), [['error', '이메일 주소를 확인해 주세요.']]);
  // Enter in a field submits nothing (both buttons are type="button"; the form's submit is stopped).
  let prevented = false;
  await page.el('adjustForm').dispatch('submit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.posts().length, 1);
});

test('admin page glue: after a network error the same submit reuses its requestId, a changed one gets a new id', async () => {
  const answers = [
    () => { throw new TypeError('Failed to fetch'); },
    () => new Response('Bad gateway', { status: 502 }),
    () => adjusted({ email: 'a@b.com', sub: 'sub-1', balance: 51234, pending: false }, true, { duplicate: true }),
    () => adjusted({ email: 'a@b.com', sub: 'sub-1', balance: 101234, pending: false }),
    () => { throw new TypeError('Failed to fetch'); },
    () => adjusted({ email: 'a@b.com', sub: 'sub-1', balance: 101334, pending: false }),
  ];
  const page = adminPage({ routes: baseRoutes({ 'POST /api/billing/admin/adjust': () => answers.shift()() }) });
  await waitFor(() => page.el('usersCard').hidden === false, 'the users');
  fill(page, { email: 'a@b.com', credits: '50000', memo: '9/30' });
  await page.el('topupBtn').click();
  assert.deepEqual(messageOf(page.el('adjustResult')), [
    ['error', '서버에 연결하지 못했습니다.'],
    ['info', '같은 내용으로 다시 누르면 한 번만 반영됩니다.'],
  ]);
  // The fields stay for the retry.
  assert.equal(page.el('creditsInput').value, '50000');
  await page.el('topupBtn').click();
  assert.deepEqual(messageOf(page.el('adjustResult'))[0], ['error', 'HTTP 502']);
  await page.el('topupBtn').click();
  assert.deepEqual(messageOf(page.el('adjustResult')), [['success', 'a@b.com 잔액 51,234 크레딧']]);
  // Three tries of one submit, one requestId: the server applies it once.
  assert.deepEqual(page.posts().map(p => p.body.requestId), ['uuid-00000001', 'uuid-00000001', 'uuid-00000001']);
  assert.equal(page.confirms.length, 3);

  // The next transfer with the same amount is a new submit.
  fill(page, { email: 'a@b.com', credits: '50000', memo: '9/30' });
  await page.el('topupBtn').click();
  assert.equal(page.posts()[3].body.requestId, 'uuid-00000002');
  // A network error, then a changed memo: another submit, another id.
  fill(page, { email: 'a@b.com', credits: '100', memo: 'first' });
  await page.el('topupBtn').click();
  fill(page, { email: 'a@b.com', credits: '100', memo: 'second' });
  await page.el('topupBtn').click();
  assert.deepEqual(page.posts().slice(4).map(p => [p.body.memo, p.body.requestId]), [['first', 'uuid-00000003'], ['second', 'uuid-00000004']]);
  assert.deepEqual(messageOf(page.el('adjustResult')), [['success', 'a@b.com 잔액 101,334 크레딧']]);
});
