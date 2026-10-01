'use strict';

// Client side of credit billing: billing.js (the /billing page), the credits chip
// in auth.js (window.VirtuallyBilling) and the credit prices on the animate page
// (animate.js helpers). 1 credit = 1 KRW; prices come from creditsPerUsd (default
// 2000: $0.30 -> 600 credits). The DOM-free helpers are required directly; the page
// glue runs in a vm context against a small fake DOM built from billing.html's ids.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const billing = require('../public/billing.js');
const auth = require('../public/auth.js');
const H = require('../public/animate.js');
const credits = require('../public/credits.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = file => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

const enabledPayload = (over = {}) => ({
  enabled: true,
  mode: 'enabled',
  problem: null,
  server: 'sandbox',
  creditsPerUsd: 2000,
  free: false,
  balance: 1234,
  products: [],
  productsError: null,
  history: [],
  canManage: false,
  isAdmin: false,
  polar: true,
  transferNote: null,
  ...over,
});
const disabledPayload = (over = {}) => ({ enabled: false, creditsPerUsd: 2000, ...over });
const invalidPayload = problem => ({ enabled: true, mode: 'invalid', problem, creditsPerUsd: 2000, balance: null, products: [], history: [] });
const product = (over = {}) => ({
  id: 'prod_1',
  name: '크레딧 500',
  description: null,
  credits: 500,
  recurring: false,
  interval: null,
  price: { type: 'fixed', amount: 999, currency: 'usd' },
  ...over,
});

// ---- billing.js: price, rate and history texts ----

test('priceText: fixed prices in the currency minor unit, en-US currency format', () => {
  assert.equal(billing.priceText(product()), '$9.99');
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: 10000, currency: 'krw' } })), '₩10,000');
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: 1500, currency: 'KRW' } })), '₩1,500');
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: 500, currency: 'jpy' } })), '¥500');
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: 1250, currency: 'eur' } })), '€12.50');
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: 0, currency: 'usd' } })), '$0.00');
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: 123456, currency: 'usd' } })), '$1,234.56');
  assert.equal(billing.formatMoney(999, 'usd'), '$9.99');
  assert.equal(billing.formatMoney(10000, 'krw'), '₩10,000');
  for (const bad of [[999, 'zz'], [999, ''], [999, null], [Number.NaN, 'usd'], ['999', 'usd']]) {
    assert.equal(billing.formatMoney(...bad), null, JSON.stringify(bad));
  }
  // A fixed price without a usable amount or currency shows no price.
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: null, currency: 'usd' } })), '');
  assert.equal(billing.priceText(product({ price: { type: 'fixed', amount: 999, currency: 'not-a-code' } })), '');
  assert.equal(billing.priceText(product({ price: { type: 'metered_unit', amount: 5, currency: 'usd' } })), '');
  assert.equal(billing.priceText(product({ price: null })), '');
  assert.equal(billing.priceText(null), '');
});

test('priceText: subscription suffixes, custom and free prices', () => {
  const sub = (interval, price = { type: 'fixed', amount: 999, currency: 'usd' }) => product({ recurring: true, interval, price });
  assert.equal(billing.priceText(sub('day')), '$9.99/일');
  assert.equal(billing.priceText(sub('week')), '$9.99/주');
  assert.equal(billing.priceText(sub('month')), '$9.99/월');
  assert.equal(billing.priceText(sub('year')), '$9.99/년');
  assert.equal(billing.priceText(sub(null)), '$9.99');
  assert.equal(billing.priceText(sub('fortnight')), '$9.99');
  // The interval only counts for a recurring product.
  assert.equal(billing.priceText(product({ recurring: false, interval: 'month' })), '$9.99');
  assert.deepEqual(['day', 'week', 'month', 'year', null, 'x'].map(billing.intervalSuffix), ['/일', '/주', '/월', '/년', '', '']);

  assert.equal(billing.priceText(product({ price: { type: 'custom', amount: 500, currency: 'usd' } })), '$5.00 · 금액 변경 가능');
  assert.equal(billing.priceText(product({ price: { type: 'custom', amount: 5000, currency: 'krw' } })), '₩5,000 · 금액 변경 가능');
  assert.equal(billing.priceText(sub('month', { type: 'custom', amount: 500, currency: 'usd' })), '$5.00/월 · 금액 변경 가능');
  assert.equal(billing.priceText(product({ price: { type: 'custom', amount: null, currency: 'usd' } })), '금액 직접 입력');
  assert.equal(billing.priceText(product({ price: { type: 'free', amount: 0, currency: 'usd' } })), '무료');
  assert.equal(billing.priceText(sub('month', { type: 'free', amount: 0, currency: 'usd' })), '무료');

  assert.equal(billing.buyLabel(product()), '구매');
  assert.equal(billing.buyLabel(sub('month')), '구독');
  assert.equal(billing.buyLabel(null), '구매');
});

test('the rate is the fixed 1크레딧 = 1원; the transfer note falls back to asking the admin', () => {
  assert.equal(billing.TEXT.rate, '1크레딧 = 1원');
  assert.equal(billing.rateText, undefined, 'no dollar rate on the billing page');
  assert.equal(billing.transferText('입금 계좌: OO은행 000-000000-00 (예금주)\n입금 후 로그인 이메일을 알려 주세요.'),
    '입금 계좌: OO은행 000-000000-00 (예금주)\n입금 후 로그인 이메일을 알려 주세요.');
  for (const none of [null, undefined, '', '   \n ', 42, {}]) {
    assert.equal(billing.transferText(none), '충전은 관리자에게 문의해 주세요.', JSON.stringify(none));
  }
});

test('balance, delta, time, kind and granted texts', () => {
  assert.equal(billing.balanceText(1234), '보유 크레딧 1,234');
  assert.equal(billing.balanceText(0), '보유 크레딧 0');
  assert.equal(billing.balanceText(-50), '보유 크레딧 -50');
  assert.equal(billing.balanceText(-12345), '보유 크레딧 -12,345');
  assert.equal(billing.balanceText(null), '');
  assert.equal(billing.deltaText(500), '+500');
  assert.equal(billing.deltaText(-24), '-24');
  assert.equal(billing.deltaText(12000), '+12,000');
  assert.equal(billing.deltaText(0), '0');
  assert.equal(billing.deltaText(null), '');
  assert.equal(billing.formatHistoryTime(new Date(2026, 8, 30, 9, 5).toISOString()), '9월 30일 09:05');
  assert.equal(billing.formatHistoryTime(new Date(2026, 0, 3, 23, 59).getTime()), '1월 3일 23:59');
  for (const bad of ['nope', null, undefined, '']) assert.equal(billing.formatHistoryTime(bad), '', String(bad));
  assert.deepEqual(['grant', 'revoke', 'charge', 'refund', 'topup', 'deduct'].map(billing.kindText),
    ['충전', '환불로 회수', '사용', '돌려받음', '충전', '차감']);
  for (const bad of ['GRANT', 'x', null, undefined, '__proto__']) assert.equal(billing.kindText(bad), '', String(bad));
  assert.equal(billing.grantedText(500), '크레딧 500개가 충전되었습니다.');
  assert.equal(billing.grantedText(1500), '크레딧 1,500개가 충전되었습니다.');
});

// ---- billing.js: problem and error texts ----

test('problemText maps every config problem code; invalidText wraps it', () => {
  const expected = {
    invalid_json: '결제 설정 파일의 JSON 형식이 올바르지 않습니다.',
    bad_admin_emails: 'adminEmails에 관리자 이메일을 넣어 주세요.',
    bad_server: 'polar.server는 sandbox 또는 production이어야 합니다.',
    missing_token: 'polar.accessToken이 필요합니다.',
    bad_webhook_secret: 'polar.webhookSecret은 whsec_로 시작해야 합니다.',
    bad_api_version: 'polar.apiVersion은 2026-10 같은 형식이어야 합니다.',
    bad_credits_per_usd: 'creditsPerUsd는 1 이상의 정수여야 합니다.',
    bad_free_emails: 'freeEmails는 이메일 목록이어야 합니다.',
    bad_transfer_note: 'transferNote는 1000자 이하의 글이어야 합니다.',
    login_required: '크레딧 결제를 쓰려면 Google 로그인을 먼저 켜야 합니다.',
  };
  for (const [code, text] of Object.entries(expected)) {
    assert.equal(billing.problemText(code), text, code);
    assert.equal(billing.invalidText(code), `결제 설정에 문제가 있습니다: ${text}`, code);
  }
  for (const code of [null, undefined, '', 'weird', 'constructor', '__proto__']) {
    assert.equal(billing.problemText(code), null, String(code));
    assert.equal(billing.invalidText(code), '결제 설정에 문제가 있습니다.', String(code));
  }
});

test('apiErrorText maps the billing error codes, then the server message, then the status', () => {
  const expected = {
    unknown_product: '이 상품은 지금 살 수 없습니다. 새로고침해 주세요.',
    polar_error: 'Polar 요청이 실패했습니다. 잠시 후 다시 시도해 주세요.',
    billing_misconfigured: '결제 설정에 문제가 있어 지금은 결제할 수 없습니다.',
    billing_disabled: '크레딧 결제가 꺼져 있습니다.',
    no_customer: '아직 결제 내역이 없습니다.',
    checkout_missing: '이 결제를 찾지 못했습니다.',
    polar_disabled: '카드 결제(Polar)는 아직 설정되지 않았습니다.',
    admin_only: '관리자만 쓸 수 있습니다.',
    network: '서버에 연결하지 못했습니다.',
  };
  for (const [code, text] of Object.entries(expected)) {
    assert.equal(billing.apiErrorText({ code, error: 'English text', status: 400 }), text, code);
  }
  assert.equal(billing.apiErrorText({ code: 'insufficient_balance', status: 409, detail: { balance: 12000 } }),
    '잔액보다 많이 차감할 수 없습니다 (잔액 12,000)');
  assert.equal(billing.apiErrorText({ code: 'insufficient_balance', status: 409, detail: { balance: 0 } }),
    '잔액보다 많이 차감할 수 없습니다 (잔액 0)');
  assert.equal(billing.apiErrorText({ code: 'insufficient_balance', status: 409, detail: null }), '잔액보다 많이 차감할 수 없습니다');
  assert.equal(billing.apiErrorText({ code: 'bad_request', error: 'Bad request.', status: 400 }), 'Bad request.');
  assert.equal(billing.apiErrorText({ code: null, error: '  ', status: 500 }), 'HTTP 500');
  assert.equal(billing.apiErrorText({ code: 'constructor', status: 418 }), 'HTTP 418');
  assert.equal(billing.apiErrorText({}), '서버에 연결하지 못했습니다.');
  assert.equal(billing.apiErrorText(null), '서버에 연결하지 못했습니다.');

  assert.equal(billing.productsErrorText('polar_unreachable'), 'Polar에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  assert.equal(billing.productsErrorText('polar_unauthorized'), 'Polar 액세스 토큰(polar.accessToken)을 확인해 주세요.');
  assert.equal(billing.productsErrorText(null), null);
  assert.equal(billing.productsErrorText('weird'), null);
});

// ---- billing.js: the page view per payload ----

test('billingView: request failed, billing off and a config problem show one message and nothing else', () => {
  for (const failed of [null, undefined, 'x']) {
    const view = billing.billingView(failed);
    assert.equal(view.mode, 'offline');
    assert.deepEqual(view.message, { kind: 'error', text: '서버에 연결하지 못했습니다.' });
    assert.deepEqual(view.products, []);
  }
  const off = billing.billingView({ enabled: false });
  assert.equal(off.mode, 'disabled');
  assert.deepEqual(off.message, {
    kind: 'info',
    text: '크레딧 결제가 꺼져 있습니다. data/billing/config.json을 만들면 켜집니다(README 참고).',
  });
  const invalid = billing.billingView(invalidPayload('login_required'));
  assert.equal(invalid.mode, 'invalid');
  assert.deepEqual(invalid.message, {
    kind: 'error',
    text: '결제 설정에 문제가 있습니다: 크레딧 결제를 쓰려면 Google 로그인을 먼저 켜야 합니다.',
  });
  assert.equal(invalid.balance, '');
  assert.equal(billing.billingView(invalidPayload('mystery')).message.text, '결제 설정에 문제가 있습니다.');
});

test('billingView: enabled shows balance, rate, sandbox, free, products and history', () => {
  const view = billing.billingView(enabledPayload({
    balance: -5,
    creditsPerUsd: 150,
    free: true,
    canManage: true,
    products: [
      product(),
      product({ id: 'prod_2', name: '월 3000', description: '  매달 3000 크레딧  ', credits: 3000, recurring: true, interval: 'month' }),
      { name: 'no id' },
      null,
    ],
    history: [
      { id: 'e2', at: new Date(2026, 8, 30, 14, 5).toISOString(), delta: -24, kind: 'charge', label: 'Wan 2.2 Animate 2 · 인사 (Hi)' },
      { id: 'e1', at: new Date(2026, 8, 29, 8, 0).toISOString(), delta: 500, kind: 'grant', label: '크레딧 500' },
      'junk',
    ],
  }));
  assert.equal(view.mode, 'enabled');
  assert.equal(view.message, null);
  assert.equal(view.balance, '보유 크레딧 -5');
  // Always 1 credit = 1 KRW, whatever creditsPerUsd prices the models at.
  assert.equal(view.rate, '1크레딧 = 1원');
  assert.equal(view.transfer, '충전은 관리자에게 문의해 주세요.');
  assert.equal(view.polar, true);
  assert.equal(view.isAdmin, false);
  assert.equal(view.sandbox, true);
  assert.equal(view.free, true);
  assert.equal(view.canManage, true);
  assert.equal(view.productsNote, null);
  assert.deepEqual(view.products, [
    { id: 'prod_1', name: '크레딧 500', description: null, credits: '크레딧 500', price: '$9.99', button: '구매' },
    { id: 'prod_2', name: '월 3000', description: '  매달 3000 크레딧  ', credits: '크레딧 3,000', price: '$9.99/월', button: '구독' },
  ]);
  assert.deepEqual(view.history.map(e => [e.time, e.label, e.kind, e.delta, e.sign]), [
    ['9월 30일 14:05', 'Wan 2.2 Animate 2 · 인사 (Hi)', '사용', '-24', 'minus'],
    ['9월 29일 08:00', '크레딧 500', '충전', '+500', 'plus'],
  ]);
  const production = billing.billingView(enabledPayload({ server: 'production' }));
  assert.equal(production.sandbox, false);
  assert.equal(production.free, false);
  assert.equal(production.canManage, false);
});

test('billingView: an empty product list explains the metadata; a Polar failure wins over it', () => {
  assert.deepEqual(billing.billingView(enabledPayload()).productsNote, {
    kind: 'info',
    text: '판매 중인 크레딧 상품이 없습니다. Polar에서 상품 메타데이터에 virtually_credits(예: 500)를 넣어 주세요.',
  });
  assert.deepEqual(billing.billingView(enabledPayload({ productsError: 'polar_unreachable' })).productsNote,
    { kind: 'error', text: 'Polar에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  // The last good list stays next to the error.
  const kept = billing.billingView(enabledPayload({ productsError: 'polar_unauthorized', products: [product()] }));
  assert.deepEqual(kept.productsNote, { kind: 'error', text: 'Polar 액세스 토큰(polar.accessToken)을 확인해 주세요.' });
  assert.equal(kept.products.length, 1);
});

test('billingView: without Polar there are no products, portal or sandbox; the transfer note and the admin link stay', () => {
  const note = '입금 계좌: OO은행 000-000000-00 (예금주)\n입금 후 로그인 이메일을 알려 주세요.';
  const view = billing.billingView(enabledPayload({
    polar: false,
    server: null,
    // A stale list or flag must not bring the Polar parts back.
    products: [product()],
    productsError: 'polar_unreachable',
    canManage: true,
    transferNote: note,
    isAdmin: true,
  }));
  assert.equal(view.polar, false);
  assert.deepEqual(view.products, []);
  assert.equal(view.productsNote, null);
  assert.equal(view.canManage, false);
  assert.equal(view.sandbox, false);
  assert.equal(view.transfer, note);
  assert.equal(view.isAdmin, true);
  assert.equal(view.rate, '1크레딧 = 1원');
  assert.equal(billing.billingView(enabledPayload({ polar: false, server: 'sandbox' })).sandbox, false);
  // An older server sends no `polar` field: Polar counts as on.
  const older = enabledPayload({ products: [product()] });
  delete older.polar;
  assert.equal(billing.billingView(older).polar, true);
  assert.equal(billing.billingView(older).products.length, 1);
  // Only a real admin flag shows the link.
  assert.equal(billing.billingView(enabledPayload({ isAdmin: 'yes' })).isAdmin, false);
});

// ---- billing.js: the return from Polar ----

test('readCheckoutParam and urlWithoutCheckout', () => {
  assert.deepEqual(billing.readCheckoutParam('?checkout_id=chk_AbC-123'), { present: true, id: 'chk_AbC-123' });
  assert.deepEqual(billing.readCheckoutParam(''), { present: false, id: null });
  assert.deepEqual(billing.readCheckoutParam('?x=1'), { present: false, id: null });
  // Polar left the placeholder, or the id is not one the server accepts.
  for (const search of ['?checkout_id=%7BCHECKOUT_ID%7D', '?checkout_id=', '?checkout_id=a%20b', `?checkout_id=${'a'.repeat(101)}`, '?checkout_id=a/b']) {
    assert.deepEqual(billing.readCheckoutParam(search), { present: true, id: null }, search);
  }
  assert.ok(billing.CHECKOUT_ID_PATTERN.test('a'.repeat(100)));
  assert.equal(billing.urlWithoutCheckout('/billing', '?checkout_id=chk_1', ''), '/billing');
  assert.equal(billing.urlWithoutCheckout('/billing', '?x=1&checkout_id=chk_1', '#top'), '/billing?x=1#top');
  assert.equal(billing.urlWithoutCheckout('', '', undefined), '/billing');
});

test('checkoutPoll: stops on granted credits, a failed checkout, a final error or 60 s', () => {
  const ok = checkout => ({ ok: true, body: { balance: 10, applied: 0, checkout } });
  const pending = { stop: false, kind: 'pending', text: '결제를 확인하고 있습니다…' };
  assert.equal(billing.POLL_INTERVAL_MS, 2000);
  assert.equal(billing.POLL_TIMEOUT_MS, 60000);

  assert.deepEqual(billing.checkoutPoll(ok({ status: 'succeeded', granted: 500 }), 0),
    { stop: true, kind: 'success', text: '크레딧 500개가 충전되었습니다.' });
  // Granted credits win even when they arrive at the deadline.
  assert.equal(billing.checkoutPoll(ok({ status: 'confirmed', granted: 1500 }), 61000).text, '크레딧 1,500개가 충전되었습니다.');
  for (const status of ['expired', 'failed']) {
    assert.deepEqual(billing.checkoutPoll(ok({ status, granted: 0 }), 4000), { stop: true, kind: 'error', text: '결제가 완료되지 않았습니다.' });
  }
  for (const status of ['open', 'confirmed', 'succeeded']) {
    assert.deepEqual(billing.checkoutPoll(ok({ status, granted: 0 }), 58000), pending, status);
  }
  assert.deepEqual(billing.checkoutPoll(ok(null), 2000), pending);
  assert.deepEqual(billing.checkoutPoll({ ok: true, body: null }, 2000), pending);

  assert.deepEqual(billing.checkoutPoll({ ok: false, status: 404, code: 'checkout_missing' }, 0),
    { stop: true, kind: 'error', text: '이 결제를 찾지 못했습니다.' });
  assert.deepEqual(billing.checkoutPoll({ ok: false, status: 409, code: 'billing_disabled' }, 0),
    { stop: true, kind: 'error', text: '크레딧 결제가 꺼져 있습니다.' });
  assert.deepEqual(billing.checkoutPoll({ ok: false, status: 503, code: 'billing_misconfigured' }, 0),
    { stop: true, kind: 'error', text: '결제 설정에 문제가 있어 지금은 결제할 수 없습니다.' });
  assert.deepEqual(billing.checkoutPoll({ ok: false, status: 409, code: 'polar_disabled' }, 0),
    { stop: true, kind: 'error', text: '카드 결제(Polar)는 아직 설정되지 않았습니다.' });
  assert.equal(billing.checkoutPoll({ ok: false, status: 400, code: 'bad_request', error: 'Bad request.' }, 0).stop, true);
  // Transient failures are retried until the deadline.
  for (const failure of [{ ok: false, status: 0, code: 'network' }, { ok: false, status: 502, code: 'polar_error' }, { ok: false, status: 500, code: null }]) {
    assert.deepEqual(billing.checkoutPoll(failure, 30000), pending, JSON.stringify(failure));
  }
  const slow = { stop: true, kind: 'warn', text: "결제 확인이 늦어지고 있습니다. 잠시 후 '결제 내역 다시 확인'을 눌러 주세요." };
  assert.deepEqual(billing.checkoutPoll(ok({ status: 'open', granted: 0 }), 60000), slow);
  assert.deepEqual(billing.checkoutPoll({ ok: false, status: 0, code: 'network' }, 75000), slow);
  assert.deepEqual(billing.checkoutPoll(ok({ status: 'open', granted: 0 }), Number.NaN), slow);
});

test('navigableUrl accepts http(s) URLs only', () => {
  assert.equal(billing.navigableUrl('https://sandbox.polar.sh/checkout/polar_c_1'), 'https://sandbox.polar.sh/checkout/polar_c_1');
  assert.equal(billing.navigableUrl('http://127.0.0.1:9999/checkout/x'), 'http://127.0.0.1:9999/checkout/x');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', '', null, 42]) {
    assert.equal(billing.navigableUrl(bad), null, String(bad));
  }
});

// ---- auth.js: the credits chip ----

test('creditChip: balance, free and problem chips link to /billing; admins also get /admin; billing off shows none', () => {
  assert.equal(auth.BILLING_PATH, '/billing');
  assert.equal(auth.ADMIN_PATH, '/admin');
  const chip = (text, adminHref = null) => ({ text, href: '/billing', adminHref });
  assert.deepEqual(auth.creditChip(enabledPayload()), chip('크레딧 1,234'));
  assert.deepEqual(auth.creditChip(enabledPayload({ balance: 0 })), chip('크레딧 0'));
  assert.deepEqual(auth.creditChip(enabledPayload({ balance: -40 })), chip('크레딧 -40'));
  assert.deepEqual(auth.creditChip(enabledPayload({ free: true, balance: 0 })), chip('크레딧 무료'));
  assert.deepEqual(auth.creditChip(enabledPayload({ isAdmin: true })), chip('크레딧 1,234', '/admin'));
  assert.deepEqual(auth.creditChip(enabledPayload({ isAdmin: true, free: true })), chip('크레딧 무료', '/admin'));
  assert.deepEqual(auth.creditChip(enabledPayload({ isAdmin: 1 })), chip('크레딧 1,234'));
  assert.deepEqual(auth.creditChip(invalidPayload('bad_server')), chip('크레딧 설정 확인'));
  assert.deepEqual(auth.creditChip(invalidPayload('login_required')), chip('크레딧 설정 확인'));
  assert.deepEqual(auth.creditChip({ ...invalidPayload('bad_admin_emails'), isAdmin: true }), chip('크레딧 설정 확인'));
  assert.equal(auth.TEXT.admin, '관리');
  for (const none of [{ enabled: false }, disabledPayload(), null, undefined, 'x', {}, { enabled: true, mode: 'future' },
    enabledPayload({ balance: null }), enabledPayload({ balance: '12' })]) {
    assert.equal(auth.creditChip(none), null, JSON.stringify(none));
  }
});

test('one credit number format on every page (auth.js, billing.js, animate.js)', () => {
  for (const value of [0, 7, 999, 1000, 1234567, -1, -12345]) {
    const expected = value.toLocaleString('ko-KR');
    assert.equal(auth.formatCredits(value), expected);
    assert.equal(billing.formatCredits(value), expected);
    assert.equal(H.formatCredits(value), expected);
  }
  for (const bad of [null, undefined, '12', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(auth.formatCredits(bad), '');
    assert.equal(billing.formatCredits(bad), '');
    assert.equal(H.formatCredits(bad), '');
  }
  assert.equal(auth.formatCredits(12345), '12,345');
});

// ---- animate.js: credit prices ----

const route = (over = {}) => ({
  id: 'wavespeed/wan-2.2-animate-2',
  provider: 'wavespeed',
  label: 'Wan 2.2 Animate 2',
  options: [{ key: 'resolution', values: ['480p', '720p'], default: '720p' }],
  pricing: { usdPerSecond: 0.08, byOption: { resolution: { '480p': 0.04, '720p': 0.08 } }, minSeconds: 3 },
  available: true,
  ...over,
});

test('billingActive: who pays', () => {
  assert.equal(H.billingActive(enabledPayload()), true);
  assert.equal(H.billingActive(enabledPayload({ balance: -3 })), true);
  assert.equal(H.billingActive(enabledPayload({ isAdmin: true })), true);
  for (const inactive of [enabledPayload({ free: true }), invalidPayload('bad_server'), disabledPayload(), { enabled: false }, null, undefined, {}]) {
    assert.equal(H.billingActive(inactive), false, JSON.stringify(inactive));
  }
});

test('priceText: "약 N 크레딧" in every mode, never the dollar model cost', () => {
  const customer = enabledPayload();
  const admin = enabledPayload({ isAdmin: true });
  // The spec's example: $0.30 of model cost is 600 credits at the default 2000 per dollar.
  assert.equal(H.priceText(0.3, customer), '약 600 크레딧');
  assert.equal(H.priceText(0.3, admin), '약 600 크레딧');
  assert.equal(H.priceText(0.3, disabledPayload()), '약 600 크레딧');
  assert.equal(H.priceText(0.3, enabledPayload({ free: true })), '약 600 크레딧');
  assert.equal(H.priceText(0.3, invalidPayload('login_required')), '약 600 크레딧');
  // Before (or without) GET /api/billing: credits.js's default rate, no model cost.
  assert.equal(H.priceText(0.3, null), '약 600 크레딧');
  // creditsPerUsd comes from the payload in every mode.
  assert.equal(H.priceText(0.3, enabledPayload({ creditsPerUsd: 1500 })), '약 450 크레딧');
  assert.equal(H.priceText(0.3, disabledPayload({ creditsPerUsd: 1000 })), '약 300 크레딧');
  assert.equal(H.priceText(0.3, { ...invalidPayload('bad_free_emails'), creditsPerUsd: 3000 }), '약 900 크레딧');
  assert.equal(H.priceText(12.34, customer), '약 24,680 크레딧');
  assert.equal(H.priceText(0.0001, customer), '약 1 크레딧');
  assert.equal(H.priceText(12.34, admin), '약 24,680 크레딧');
  for (const payload of [customer, admin, disabledPayload(), null]) {
    assert.equal(H.priceText(null, payload), '가격 정보 없음', JSON.stringify(payload));
  }
});

test('routeCostText: the route estimate in credits; 무료 for the free route; nothing until the length is known', () => {
  const r = route();
  const customer = enabledPayload();
  assert.equal(H.routeCostText(r, 5, { resolution: '720p' }, customer), '약 800 크레딧');
  assert.equal(H.routeCostText(r, 5, { resolution: '480p' }, customer), '약 400 크레딧');
  assert.equal(H.routeCostText(r, 1, { resolution: '720p' }, customer), '약 480 크레딧'); // min 3 s billed
  assert.equal(H.routeCostText(r, 5, { resolution: '720p' }, enabledPayload({ isAdmin: true })), '약 800 크레딧');
  assert.equal(H.routeCostText(r, 5, { resolution: '720p' }, disabledPayload()), '약 800 크레딧');
  assert.equal(H.routeCostText(r, 5, { resolution: '720p' }, null), '약 800 크레딧');
  assert.equal(H.routeCostText(route({ pricing: { usdPerSecond: 0.06 } }), 5, {}, customer), '약 600 크레딧');
  assert.equal(H.routeCostText(route({ pricing: null }), 5, {}, customer), '가격 정보 없음');
  assert.equal(H.routeCostText(route({ pricing: null }), 5, {}, disabledPayload()), '가격 정보 없음');
  assert.equal(H.routeCostText(r, undefined, {}, customer), '');
  assert.equal(H.routeCostText(r, Number.NaN, {}, disabledPayload()), '');
  for (const payload of [customer, enabledPayload({ isAdmin: true }), disabledPayload(), null]) {
    assert.equal(H.routeCostText({ id: 'mock/local-demo', provider: 'mock', free: true }, 5, {}, payload), '무료');
  }
  // No USD wording on the page.
  const js = readPublic('animate.js');
  assert.doesNotMatch(js, /약 \$(?!\{)|예상 모델 비용|원가/);
  assert.equal((js.match(/`\$\$\{/g) || []).length, 0, 'no dollar text');
});

test('jobCredits is the shared creditsFor on the page estimate (the price the server charges)', () => {
  const r = route({ pricing: { usdPerSecond: 0.11, minSeconds: 0 } });
  for (const rate of [1, 7, 100, 150, 2000, 100000]) {
    for (const seconds of [0.5, 3, 10, 12.3, 60]) {
      const usd = H.estimateUsd(r, seconds, {});
      assert.equal(H.jobCredits(r, seconds, {}, enabledPayload({ creditsPerUsd: rate })), credits.creditsFor(usd, rate), `${rate} ${seconds}`);
    }
  }
  assert.equal(H.jobCredits(r, 10, {}, enabledPayload({ isAdmin: true })), credits.creditsFor(1.1, 2000));
  // Nothing is taken from free accounts, or while billing is off or broken.
  for (const payload of [null, enabledPayload({ free: true }), disabledPayload(), invalidPayload('bad_server')]) {
    assert.equal(H.jobCredits(r, 10, {}, payload), null, JSON.stringify(payload));
  }
  assert.equal(H.jobCredits(route({ pricing: null }), 10, {}, enabledPayload()), null);
  assert.equal(H.jobCredits({ id: 'mock/local-demo', provider: 'mock', free: true, pricing: { usdPerSecond: 0.1 } }, 5, {}, enabledPayload()), null);
  // The formula lives in credits.js only.
  for (const file of ['animate.js', 'billing.js', 'auth.js', 'admin.js']) {
    assert.doesNotMatch(readPublic(file), /function creditsFor\b|1e-6/, file);
  }
  assert.match(readPublic('animate.js'), /credits\.creditsFor\(usd, /);
});

test('free route: only the server\'s verdict (route view free) is free; a priced mock-provider route is paid like any other', () => {
  const customer = enabledPayload();
  // The server's custom test routes: on the mock provider, but not its local demo route.
  const priced = route({ id: 'mock/priced', provider: 'mock', providerLabel: '로컬 테스트 (AI 아님)', free: false,
    pricing: { usdPerSecond: 0.1, minSeconds: 3 }, options: [] });
  const unpriced = route({ id: 'mock/unpriced', provider: 'mock', free: false, pricing: null, options: [] });
  const demo = route({ id: 'mock/local-demo', provider: 'mock', free: true, pricing: null, options: [] });

  // A 2 s driving on $0.10/s with a 3 s floor: $0.30 = 600 credits, the price the server charges.
  assert.equal(H.routeCostText(priced, 2, {}, customer), '약 600 크레딧');
  assert.equal(H.routeCostText(priced, 2, {}, enabledPayload({ isAdmin: true })), '약 600 크레딧');
  assert.equal(H.jobCredits(priced, 2, {}, customer), 600);
  // Its paid confirmation takes the credits, and the request says it was confirmed.
  assert.equal(H.confirmCreditsText(H.jobCredits(priced, 2, {}, customer), customer.balance), '600 크레딧이 차감됩니다 (보유 1,234).');
  assert.deepEqual(H.jobPayload({ drivingId: 'd1', photoId: 'ph-1', route: priced, options: {}, margin: null, margins: [] }),
    { drivingId: 'd1', photoId: 'ph-1', routeId: 'mock/priced', options: {}, confirmed: true });

  // Without a price it is not free either: the server answers price_unknown.
  assert.equal(H.routeCostText(unpriced, 2, {}, customer), '가격 정보 없음');
  assert.equal(H.jobCredits(unpriced, 2, {}, customer), null);
  assert.equal(H.jobPayload({ drivingId: 'd1', route: unpriced, options: {} }).confirmed, true);

  // The local demo route alone is free: no price, no credits, no confirmation.
  assert.equal(H.routeCostText(demo, 2, {}, customer), '무료');
  assert.equal(H.jobCredits(demo, 2, {}, customer), null);
  assert.equal('confirmed' in H.jobPayload({ drivingId: 'd1', route: demo, options: {} }), false);

  // The page asks the paid confirmation for every route but the free one, and never reads the provider for it.
  const js = readPublic('animate.js');
  assert.match(js, /const free = H\.isFreeRoute\(route\);\s*if \(!free && !\(await confirmCreate\(route, driving\)\)\) return;/);
  assert.doesNotMatch(js, /isMockRoute|provider === 'mock'/);
});

test('confirmation and error texts for credits (error map style: no trailing period)', () => {
  assert.equal(H.confirmCreditsText(600, 1234), '600 크레딧이 차감됩니다 (보유 1,234).');
  assert.equal(H.confirmCreditsText(1500, -5), '1,500 크레딧이 차감됩니다 (보유 -5).');
  assert.equal(H.confirmCreditsText(null, 10), '');
  assert.equal(H.confirmCreditsText(40, undefined), '');
  assert.equal(H.insufficientText(600, 12), '크레딧이 부족합니다 (필요 600, 보유 12)');
  assert.equal(H.insufficientText(40, null), '');

  assert.equal(H.errorText({ error: 'x', code: 'insufficient_credits', detail: { needed: 1500, balance: -3 } }),
    '크레딧이 부족합니다 (필요 1,500, 보유 -3)');
  assert.equal(H.errorText({ error: 'x', code: 'insufficient_credits' }), '크레딧이 부족합니다');
  assert.equal(H.errorText({ error: 'x', code: 'insufficient_credits', detail: { needed: 5 } }), '크레딧이 부족합니다');
  assert.equal(H.errorText({ error: 'x', code: 'price_unknown' }), '이 모델은 가격 정보가 없어 크레딧으로 만들 수 없습니다');
  assert.equal(H.errorText({ error: 'x', code: 'billing_misconfigured', detail: { problem: 'bad_server' } }),
    '결제 설정에 문제가 있어 지금은 만들 수 없습니다');
  for (const code of ['insufficient_credits', 'price_unknown', 'billing_misconfigured']) {
    assert.doesNotMatch(H.errorText({ code }), /\.$/, code);
  }
});

test('cancel confirmation: a charged job says whether its credits come back (billing.cancelRefund)', () => {
  const job = billingRecord => ({ id: 'j1', state: 'running', billing: billingRecord });
  const charged = over => job({ credits: 600, free: false, refunded: false, cancelRefund: true, ...over });
  assert.equal(H.cancelConfirmText(charged()), '취소하면 600 크레딧을 돌려받습니다. 취소할까요?');
  assert.equal(H.cancelConfirmText(charged({ credits: 1500 })), '취소하면 1,500 크레딧을 돌려받습니다. 취소할까요?');
  const kept = '이미 생성이 시작되어 취소해도 크레딧은 돌려받지 못합니다. 취소할까요?';
  assert.equal(H.cancelConfirmText(charged({ cancelRefund: false })), kept);
  assert.equal(H.cancelConfirmText(charged({ cancelRefund: undefined })), kept);
  // Nothing to lose or regain: no question.
  for (const none of [charged({ free: true }), charged({ refunded: true }), charged({ credits: null }), charged({ credits: 0 }),
    job(undefined), job(null), { id: 'j2', state: 'queued' }, null]) {
    assert.equal(H.cancelConfirmText(none), '', JSON.stringify(none));
    assert.equal(H.jobCharged(none), false);
  }
  assert.equal(H.jobCharged(charged({ cancelRefund: false })), true);
  // The cancel button asks with the newest view of the job before it posts.
  assert.match(readPublic('animate.js'),
    /const question = H\.cancelConfirmText\(state\.jobs\.find\(item => item\.id === job\.id\) \|\| job\);\s*if \(question && !window\.confirm\(question\)\) return;\s*cancel\.disabled = true;/);
});

test('다시 받기 confirmation: asks only when it takes credits again (billing.refetchCredits), in the paid confirmation\'s words', () => {
  const job = refetchCredits => ({ id: 'j1', state: 'failed', canRefetch: true,
    billing: { credits: 600, free: false, refunded: true, cancelRefund: false, refetchCredits } });
  assert.equal(H.refetchConfirmText(job(600), enabledPayload()), '다시 받으면 600 크레딧이 차감됩니다 (보유 1,234).');
  assert.equal(H.refetchConfirmText(job(1500), enabledPayload({ balance: 20000 })), '다시 받으면 1,500 크레딧이 차감됩니다 (보유 20,000).');
  assert.equal(`다시 받으면 ${H.confirmCreditsText(600, 1234)}`, H.refetchConfirmText(job(600), enabledPayload()), 'the paid confirmation\'s line');
  // Still asked when the balance is unknown (the chip's request failed): the credits are taken either way.
  assert.equal(H.refetchConfirmText(job(600), null), '다시 받으면 600 크레딧이 차감됩니다.');
  assert.equal(H.refetchConfirmText(job(600), enabledPayload({ balance: null })), '다시 받으면 600 크레딧이 차감됩니다.');
  // Nothing to take, or a free account: no question.
  for (const none of [job(0), job(undefined), job(null), job('600'), job(Number.NaN), { id: 'j2', state: 'failed' }, null]) {
    assert.equal(H.refetchConfirmText(none, enabledPayload()), '', JSON.stringify(none));
  }
  assert.equal(H.refetchConfirmText(job(600), enabledPayload({ free: true })), '');

  // A refused 다시 받기 says a short balance the way job creation does; other errors keep their prefix.
  const short = { message: H.errorText({ error: 'x', code: 'insufficient_credits', detail: { needed: 600, balance: 12 } }), code: 'insufficient_credits' };
  assert.equal(H.refetchErrorText(short), '크레딧이 부족합니다 (필요 600, 보유 12)');
  assert.equal(H.refetchErrorText({ message: '다시 받을 수 없는 작업입니다', code: 'not_refetchable' }), '다시 받기 실패: 다시 받을 수 없는 작업입니다');
  assert.equal(H.refetchErrorText({ message: '결제 설정에 문제가 있어 지금은 만들 수 없습니다', code: 'billing_misconfigured' }),
    '다시 받기 실패: 결제 설정에 문제가 있어 지금은 만들 수 없습니다');
  assert.equal(H.refetchErrorText(null), '다시 받기 실패: 알 수 없는 오류');

  // The button asks with the newest view of the job before it posts; the answer refreshes the chip.
  const js = readPublic('animate.js');
  assert.match(js,
    /const question = H\.refetchConfirmText\(state\.jobs\.find\(item => item\.id === job\.id\) \|\| job, state\.billing\);\s*if \(question && !window\.confirm\(question\)\) return;\s*refetch\(job\);/);
  assert.match(js, /refetchErrors\.set\(job\.id, H\.refetchErrorText\(error\)\);\s*\} finally \{\s*refetchBusy\.delete\(job\.id\);\s*renderJobs\(\);\s*\/\/[^\n]*\n\s*refreshBilling\(\);/);
});

test('job rows: credits, refunded credits, nothing for free or unbilled jobs; refunds wake the chip', () => {
  const job = (billingRecord, over = {}) => ({ id: 'j1', state: 'running', billing: billingRecord, ...over });
  assert.equal(H.jobCreditsText(job({ credits: 40, free: false, refunded: false })), '40 크레딧');
  assert.equal(H.jobCreditsText(job({ credits: 1500, free: false, refunded: true }, { state: 'failed' })), '1,500 크레딧 돌려받음');
  assert.equal(H.jobCreditsText(job({ credits: 40, free: true, refunded: false })), '');
  assert.equal(H.jobCreditsText(job({ credits: null, free: false, refunded: false })), '');
  assert.equal(H.jobCreditsText({ id: 'j1', state: 'succeeded' }), '');
  assert.equal(H.jobCreditsText(null), '');

  const refunded = job({ credits: 40, free: false, refunded: true }, { state: 'failed' });
  assert.equal(H.refundTurnedOn(job({ credits: 40, free: false, refunded: false }), refunded), true);
  assert.equal(H.refundTurnedOn(undefined, refunded), true);
  assert.equal(H.refundTurnedOn(refunded, refunded), false);
  assert.equal(H.refundTurnedOn(undefined, job({ credits: 40, free: false, refunded: false })), false);
  assert.equal(H.refundTurnedOn(refunded, { id: 'j1', state: 'failed' }), false);
});

// ---- Static wiring ----

test('billing page: header links, its own CSS, auth.js then credits.js then billing.js', () => {
  const html = readPublic('billing.html');
  assert.match(html, /<html lang="ko">/);
  const ownCss = html.indexOf('<link rel="stylesheet" href="./billing.css">');
  const authCss = html.indexOf('<link rel="stylesheet" href="./auth.css">');
  assert.ok(ownCss > 0 && authCss > ownCss, 'billing.css, then auth.css');
  assert.doesNotMatch(html, /animate\.css|app\.css|animate\.js|app\.js|<script>/);
  const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['auth.js', 'credits.js', 'billing.js']);
  assert.match(html,
    /<header class="page-header">\s*<a href="\/" class="brand-link brand-mark">Virtually<\/a>\s*<nav class="page-links" aria-label="[^"]+">\s*<a href="\/" class="back-link">컨트롤러<\/a>\s*<a href="\/animate" class="back-link">동작 만들기<\/a>\s*<\/nav>\s*<h1>크레딧<\/h1>\s*<div id="authSlot" class="auth-slot" hidden><\/div>\s*<\/header>/);
  assert.equal((html.match(/id="authSlot"/g) || []).length, 1);
  for (const text of ['<h2 id="productsTitle">충전</h2>', '<h2 id="historyTitle">사용 내역</h2>', '>아직 내역이 없습니다.<',
    '>테스트 결제(샌드박스)<', '>테스트 카드 4242 4242 4242 4242로 결제할 수 있습니다.<', '>이 계정은 크레딧 없이 동작을 만들 수 있습니다.<',
    '>결제 관리<', '>결제 내역 다시 확인<', '<h2 id="transferTitle">충전 안내</h2>']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /<a id="adminLink" href="\/admin" class="btn btn-ghost btn-sm" hidden>크레딧 관리<\/a>/);
  assert.match(html, /<div id="summaryActions" class="row summary-actions">/);
  // 충전 안내 comes before the Polar products.
  assert.ok(html.indexOf('id="transferCard"') < html.indexOf('id="productsCard"'));
  assert.match(html, /<p id="transferNote" class="transfer-note"><\/p>/);
  // The live regions stay rendered (empty) so the first message is announced.
  assert.match(html, /<div id="billingMessage" class="messages" role="alert"><\/div>/);
  assert.match(html, /<div id="checkoutMessage" class="messages" role="status" aria-live="polite"><\/div>/);
  const css = readPublic('billing.css');
  for (const token of ['--bg: #0f1115;', '--panel: #171a21;', '--text: #e6e8ee;', '--muted: #9aa3b2;', '--accent: #6c8cff;']) {
    assert.ok(css.includes(token), token);
  }
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /\.transfer-note \{[^}]*white-space: pre-line;/);
});

test('billing.js shares its helpers with the admin page and runs its page glue only on /billing', () => {
  const window = { document: { getElementById: () => null } };
  const context = vm.createContext({ window, URL, URLSearchParams, Intl });
  window.window = window;
  vm.runInContext(readPublic('billing.js'), context, { filename: 'billing.js' });
  const shared = window.VirtuallyBillingHelpers;
  assert.ok(shared, 'window.VirtuallyBillingHelpers');
  assert.deepEqual(Object.keys(shared).sort(), Object.keys(billing).sort());
  assert.equal(shared.TEXT.rate, '1크레딧 = 1원');
});

test('every element billing.js looks up exists in billing.html', () => {
  const html = readPublic('billing.html');
  const ids = [...readPublic('billing.js').matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(ids.length >= 15);
  for (const id of ids) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
});

test('animate page loads credits.js before animate.js and has the confirmation credit line', () => {
  const html = readPublic('animate.html');
  const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['auth.js', 'motions.js', 'credits.js', 'animate.js']);
  assert.match(html, /<\/dl>\s*<p id="confirmCredits" class="confirm-credits" hidden><\/p>/);
  // The controller keeps only auth.js for the chip.
  assert.doesNotMatch(readPublic('index.html'), /credits\.js|billing\.js/);
  const js = readPublic('animate.js');
  assert.match(js, /H\.routeCostText\(route, selectedDriving\(\)\?\.duration, routeOptionsFor\(route\), state\.billing\)/);
  assert.match(js, /el\('a', \{ className: 'link', href: '\/billing', text: '크레딧 충전' \}\)/);
  assert.match(js, /if \(H\.refundTurnedOn\(previous, data\.job\)\) refreshBilling\(\);/);
  // The create response (success or error) refreshes the chip.
  assert.match(js, /finally \{\s*state\.busy\.create = false;\s*renderCreate\(\);\s*\/\/[^\n]*\n\s*refreshBilling\(\);/);
});

test('billing.js never assigns innerHTML/outerHTML or uses insertAdjacentHTML', () => {
  assert.doesNotMatch(readPublic('billing.js'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
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
    this.title = '';
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

  click() {
    return Promise.all((this.listeners.get('click') || []).map(listener => listener({ type: 'click', target: this })));
  }

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

class FakeDocument {
  constructor(readyState) {
    this.readyState = readyState;
    this.byId = new Map();
    this.domReady = [];
  }

  getElementById(id) { return this.byId.get(id) || null; }

  createElement(tag) { return new FakeElement(tag); }

  addEventListener(type, listener) {
    if (type === 'DOMContentLoaded') this.domReady.push(listener);
  }

  finishParsing() {
    this.readyState = 'interactive';
    for (const listener of this.domReady.splice(0)) listener();
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
  user: { email: 'someone@gmail.com', name: 'Some One', picture: null },
  overlayKey: 'key-1',
});

/**
 * Run public/ scripts in one fresh vm context (no `module`, so their browser branch
 * runs). `routes` maps 'METHOD /path' to (body) => Response | Promise<Response>.
 * setTimeout runs its callback on the next turn and moves the fake clock forward.
 */
function runPage(files, { html = 'billing.html', pathname = '/billing', search = '', readyState = 'complete', routes = {} } = {}) {
  const document = new FakeDocument(readyState);
  for (const [id, { tag, hidden }] of Object.entries(pageElements(html))) {
    const element = new FakeElement(tag);
    element.hidden = hidden;
    document.byId.set(id, element);
  }
  const requests = [];
  const clock = { now: 1_000_000 };
  const delays = [];
  const location = {
    pathname,
    search,
    hash: '',
    assigned: [],
    assign(url) { this.assigned.push(url); },
    replace(url) { this.assigned.push(url); },
  };
  const replacedUrls = [];
  const windowListeners = new Map();
  const window = {
    document,
    location,
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
    history: { state: null, replaceState(state, title, url) { replacedUrls.push(url); } },
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      requests.push({ method, url, body: init.body, headers: { ...(init.headers || {}) } });
      const route = routes[`${method} ${url}`];
      if (!route) return jsonResponse(404, { error: 'Not found.', code: 'not_found' });
      return route(init.body === undefined ? undefined : JSON.parse(init.body));
    },
    setTimeout: (callback, ms) => {
      delays.push(ms);
      clock.now += ms;
      setImmediate(callback);
      return delays.length;
    },
    alert() {},
    URL,
    URLSearchParams,
    console,
    __clock: clock,
  };
  window.window = window;
  const context = vm.createContext(window);
  vm.runInContext('Date.now = () => __clock.now;', context);
  for (const file of files) vm.runInContext(readPublic(file), context, { filename: file });
  const el = id => document.byId.get(id);
  const fireWindow = (type, event) => {
    for (const listener of windowListeners.get(type) || []) listener(event);
  };
  return { window, document, el, requests, location, replacedUrls, delays, clock, fireWindow };
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
const billingGets = page => page.requests.filter(r => r.method === 'GET' && r.url === '/api/billing').length;

test('credits chip: first in #authSlot next to the signed-in chip; refresh() redraws it in place', async () => {
  let payload = enabledPayload();
  const page = runPage(['auth.js'], {
    html: 'animate.html',
    pathname: '/animate',
    routes: { 'GET /api/auth/me': signedIn, 'GET /api/billing': () => jsonResponse(200, payload) },
  });
  const slot = page.el('authSlot');
  const { VirtuallyAuth, VirtuallyBilling } = page.window;
  // The login API is unchanged; the billing payload has its own global.
  assert.deepEqual(Object.keys(VirtuallyAuth).sort(), ['loginUrlFor', 'logout', 'overlayUrlFor', 'ready', 'rotateOverlayKey']);
  assert.deepEqual(Object.keys(VirtuallyBilling).sort(), ['ready', 'refresh']);
  assert.equal((await VirtuallyBilling.ready).balance, 1234);
  assert.equal(slot.hidden, false);
  assert.deepEqual(slot.children.map(node => [node.tagName, node.className]), [
    ['SPAN', 'auth-billing'], ['SPAN', 'auth-name'], ['BUTTON', 'btn btn-ghost btn-sm auth-logout'],
  ]);
  const group = slot.children[0];
  assert.deepEqual(group.children.map(node => [node.tagName, node.className]), [['A', 'auth-credits']]);
  const chip = group.children[0];
  assert.equal(chip.textContent, '크레딧 1,234');
  assert.equal(chip.getAttribute('href'), '/billing');
  assert.equal(chip.getAttribute('aria-current'), null);
  const request = page.requests.find(r => r.url === '/api/billing');
  assert.equal(request.headers.Accept, 'application/json');

  payload = enabledPayload({ balance: 1194 });
  assert.equal((await VirtuallyBilling.refresh()).balance, 1194);
  assert.deepEqual(texts(slot), ['크레딧 1,194', 'Some One', '로그아웃']);
  payload = enabledPayload({ free: true });
  await VirtuallyBilling.refresh();
  assert.deepEqual(texts(slot), ['크레딧 무료', 'Some One', '로그아웃']);
  // Admins also get 관리 (-> /admin) inside the same group.
  payload = enabledPayload({ isAdmin: true, balance: 50000 });
  await VirtuallyBilling.refresh();
  assert.equal(slot.children.length, 3);
  assert.deepEqual(slot.children[0].children.map(node => [node.className, node.textContent, node.getAttribute('href')]), [
    ['auth-credits', '크레딧 50,000', '/billing'],
    ['auth-admin', '관리', '/admin'],
  ]);
  payload = enabledPayload({ balance: 49000 });
  await VirtuallyBilling.refresh();
  assert.deepEqual(slot.children[0].children.map(node => node.className), ['auth-credits']);
  // Billing turned off, or the request failing, removes the chip and keeps the rest.
  payload = disabledPayload();
  assert.deepEqual({ ...(await VirtuallyBilling.refresh()) }, { enabled: false, creditsPerUsd: 2000 });
  assert.deepEqual(texts(slot), ['Some One', '로그아웃']);
  assert.equal(slot.hidden, false);
  payload = enabledPayload({ balance: 5 });
  await VirtuallyBilling.refresh();
  assert.deepEqual(texts(slot), ['크레딧 5', 'Some One', '로그아웃']);
});

test('credits chip: on /admin the 관리 link, on /billing the credits link is the current page', async () => {
  for (const [pathname, html, current] of [['/admin', 'admin.html', 'auth-admin'], ['/billing', 'billing.html', 'auth-credits']]) {
    const page = runPage(['auth.js'], {
      html,
      pathname,
      routes: { 'GET /api/auth/me': signedIn, 'GET /api/billing': () => jsonResponse(200, enabledPayload({ isAdmin: true })) },
    });
    await page.window.VirtuallyBilling.ready;
    const links = page.el('authSlot').children[0].children;
    assert.deepEqual(links.map(link => [link.className, link.getAttribute('aria-current')]),
      [['auth-credits', current === 'auth-credits' ? 'page' : null], ['auth-admin', current === 'auth-admin' ? 'page' : null]], pathname);
  }
});

test('credits chip: login off with a billing file shows only 크레딧 설정 확인; a failed request shows nothing', async () => {
  let answer = () => jsonResponse(200, invalidPayload('login_required'));
  const page = runPage(['auth.js'], {
    html: 'index.html',
    pathname: '/',
    routes: {
      'GET /api/auth/me': () => jsonResponse(200, { enabled: false, user: null, overlayKey: null }),
      'GET /api/billing': () => answer(),
    },
  });
  const slot = page.el('authSlot');
  await page.window.VirtuallyBilling.ready;
  assert.equal(slot.hidden, false);
  assert.deepEqual(texts(slot), ['크레딧 설정 확인']);
  assert.equal(slot.children[0].children[0].getAttribute('href'), '/billing');

  answer = () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await page.window.VirtuallyBilling.refresh(), null);
  assert.deepEqual(slot.children, []);
  assert.equal(slot.hidden, true);
  answer = () => new Response('<html>', { status: 200 });
  assert.equal(await page.window.VirtuallyBilling.refresh(), null);
  assert.equal(slot.hidden, true);
});

test('credits chip: while the page is still parsing it lands after the signed-in chip, not under it', async () => {
  const page = runPage(['auth.js'], {
    html: 'animate.html',
    pathname: '/animate',
    readyState: 'loading',
    routes: { 'GET /api/auth/me': signedIn, 'GET /api/billing': () => jsonResponse(200, enabledPayload()) },
  });
  await page.window.VirtuallyAuth.ready;
  await settle();
  const slot = page.el('authSlot');
  assert.deepEqual(slot.children, []);
  page.document.finishParsing();
  await page.window.VirtuallyBilling.ready;
  assert.deepEqual(texts(slot), ['크레딧 1,234', 'Some One', '로그아웃']);
});

test('credits chip: an older, slower answer cannot overwrite a newer one', async () => {
  const answers = [];
  const page = runPage(['auth.js'], {
    html: 'animate.html',
    pathname: '/animate',
    routes: {
      'GET /api/auth/me': signedIn,
      'GET /api/billing': () => {
        const next = deferred();
        answers.push(next);
        return next.promise;
      },
    },
  });
  await waitFor(() => answers.length === 1, 'the first billing request');
  answers[0].resolve(jsonResponse(200, enabledPayload({ balance: 100 })));
  await page.window.VirtuallyBilling.ready;
  const slow = page.window.VirtuallyBilling.refresh();
  const fast = page.window.VirtuallyBilling.refresh();
  await waitFor(() => answers.length === 3, 'both refreshes');
  answers[2].resolve(jsonResponse(200, enabledPayload({ balance: 76 })));
  await fast;
  answers[1].resolve(jsonResponse(200, enabledPayload({ balance: 90 })));
  assert.equal((await slow).balance, 90);
  assert.equal(page.el('authSlot').children[0].textContent, '크레딧 76');
});

function billingPage({ payload = enabledPayload(), search = '', routes = {}, files = ['auth.js', 'credits.js', 'billing.js'] } = {}) {
  const state = { payload };
  const page = runPage(files, {
    search,
    routes: {
      'GET /api/auth/me': signedIn,
      'GET /api/billing': () => (typeof state.payload === 'function' ? state.payload() : jsonResponse(200, state.payload)),
      ...routes,
    },
  });
  page.state = state;
  return page;
}

test('billing page glue: enabled shows balance, rate, sandbox note, products and history; one GET feeds page and chip', async () => {
  const page = billingPage({
    payload: enabledPayload({
      products: [
        product({ name: '<img src=x onerror=alert(1)>', description: '처음 쓰는 분께' }),
        product({ id: 'prod_2', name: '월 3000', credits: 3000, recurring: true, interval: 'month', price: { type: 'fixed', amount: 2900, currency: 'usd' } }),
      ],
      history: [
        { id: 'e2', at: new Date(2026, 8, 30, 14, 5).toISOString(), delta: -24, kind: 'charge', label: 'Wan 2.2 Animate 2 · 인사 (Hi)' },
        { id: 'e1', at: new Date(2026, 8, 29, 8, 0).toISOString(), delta: 500, kind: 'grant', label: '크레딧 500' },
      ],
    }),
  });
  await waitFor(() => page.el('summaryCard').hidden === false, 'the summary');
  assert.equal(page.el('balanceText').textContent, '보유 크레딧 1,234');
  assert.equal(page.el('rateText').textContent, '1크레딧 = 1원');
  assert.equal(page.el('sandboxBadge').hidden, false);
  assert.equal(page.el('sandboxNote').hidden, false);
  assert.equal(page.el('freeNote').hidden, true);
  assert.equal(page.el('portalBtn').hidden, true);
  assert.equal(page.el('syncBtn').hidden, false);
  assert.equal(page.el('adminLink').hidden, true);
  assert.equal(page.el('summaryActions').hidden, false);
  assert.equal(page.el('transferCard').hidden, false);
  assert.equal(page.el('transferNote').textContent, '충전은 관리자에게 문의해 주세요.');
  assert.deepEqual(page.el('billingMessage').children, []);
  assert.deepEqual(page.el('checkoutMessage').children, []);

  assert.equal(page.el('productsCard').hidden, false);
  assert.equal(page.el('productsNote').hidden, true);
  const items = page.el('productList').children;
  assert.equal(items.length, 2);
  const [main, side] = items[0].children;
  assert.equal(main.children[0].tagName, 'H3');
  // Product data stays one text node.
  assert.deepEqual(main.children[0].childNodes, ['<img src=x onerror=alert(1)>']);
  assert.equal(main.children[1].textContent, '처음 쓰는 분께');
  assert.deepEqual(texts(side), ['크레딧 500', '$9.99', '구매']);
  assert.equal(items[1].children[0].children.length, 1, 'no description paragraph');
  assert.deepEqual(texts(items[1].children[1]), ['크레딧 3,000', '$29.00/월', '구독']);

  assert.equal(page.el('historyEmpty').hidden, true);
  assert.deepEqual(page.el('historyList').children.map(texts), [
    ['9월 30일 14:05', 'Wan 2.2 Animate 2 · 인사 (Hi)', '사용', '-24'],
    ['9월 29일 08:00', '크레딧 500', '충전', '+500'],
  ]);
  assert.equal(page.el('historyList').children[1].children[3].className, 'history-delta is-plus');

  const chip = page.el('authSlot').children[0].children[0];
  assert.equal(chip.textContent, '크레딧 1,234');
  assert.equal(chip.getAttribute('aria-current'), 'page');
  assert.equal(billingGets(page), 1);
});

test('billing page glue: without Polar, 충전 안내 with the transfer note and no products, portal or sync; admins get 크레딧 관리', async () => {
  const note = '입금 계좌: OO은행 000-000000-00 (예금주)\n입금 후 로그인 이메일을 알려 주세요.';
  const page = billingPage({
    payload: enabledPayload({
      polar: false,
      server: null,
      transferNote: note,
      isAdmin: true,
      history: [
        { id: 'e3', at: new Date(2026, 8, 30, 16, 20).toISOString(), delta: -1000, kind: 'deduct', label: '관리자 차감 · 잘못 충전' },
        { id: 'e2', at: new Date(2026, 8, 30, 16, 10).toISOString(), delta: 50000, kind: 'topup', label: '관리자 충전 · 9/30 계좌이체' },
      ],
    }),
  });
  await waitFor(() => page.el('summaryCard').hidden === false, 'the summary');
  assert.equal(page.el('rateText').textContent, '1크레딧 = 1원');
  assert.equal(page.el('productsCard').hidden, true);
  assert.equal(page.el('syncBtn').hidden, true);
  assert.equal(page.el('portalBtn').hidden, true);
  assert.equal(page.el('sandboxBadge').hidden, true);
  assert.equal(page.el('sandboxNote').hidden, true);
  assert.equal(page.el('adminLink').hidden, false);
  assert.equal(page.el('summaryActions').hidden, false);
  assert.equal(page.el('transferCard').hidden, false);
  // One text node: the line breaks are kept by CSS (white-space: pre-line), not markup.
  assert.deepEqual(page.el('transferNote').childNodes, [note]);
  assert.deepEqual(page.el('historyList').children.map(texts), [
    ['9월 30일 16:20', '관리자 차감 · 잘못 충전', '차감', '-1,000'],
    ['9월 30일 16:10', '관리자 충전 · 9/30 계좌이체', '충전', '+50,000'],
  ]);
  assert.deepEqual(page.el('authSlot').children[0].children.map(link => link.textContent), ['크레딧 1,234', '관리']);

  // A customer without Polar has no buttons at all: the actions row goes too.
  page.state.payload = enabledPayload({ polar: false, server: null });
  await page.window.VirtuallyBilling.refresh();
  page.fireWindow('pageshow', { persisted: true });
  await waitFor(() => page.el('adminLink').hidden === true, 'the customer view');
  assert.equal(page.el('summaryActions').hidden, true);
  assert.equal(page.el('transferNote').textContent, '충전은 관리자에게 문의해 주세요.');
});

test('billing page glue: back from a checkout while Polar is off stops at once and says so', async () => {
  const page = billingPage({
    payload: enabledPayload({ polar: false, server: null }),
    search: '?checkout_id=chk_9',
    routes: { 'POST /api/billing/sync': () => jsonResponse(409, { error: 'Polar is not configured.', code: 'polar_disabled' }) },
  });
  await waitFor(() => page.replacedUrls.length > 0, 'the end of polling');
  assert.equal(page.requests.filter(r => r.url === '/api/billing/sync').length, 1);
  assert.deepEqual(messageOf(page.el('checkoutMessage')), [['error', '카드 결제(Polar)는 아직 설정되지 않았습니다.']]);
});

test('billing page glue: 구매 posts the product, keeps the buttons disabled and goes to Polar', async () => {
  const checkout = deferred();
  const page = billingPage({
    payload: enabledPayload({ products: [product(), product({ id: 'prod_2' })] }),
    routes: { 'POST /api/billing/checkout': () => checkout.promise },
  });
  await waitFor(() => page.el('productList').children.length === 2, 'the products');
  const buyButton = page.el('productList').children[1].children[1].children.at(-1);
  const clicked = buyButton.click();
  await waitFor(() => page.requests.some(r => r.url === '/api/billing/checkout'), 'the checkout request');
  const post = page.requests.find(r => r.url === '/api/billing/checkout');
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), { productId: 'prod_2' });
  const buttons = () => [page.el('portalBtn'), page.el('syncBtn'), ...page.el('productList').children.map(li => li.children[1].children.at(-1))];
  assert.ok(buttons().every(button => button.disabled), 'every button is disabled while pending');
  checkout.resolve(jsonResponse(200, { url: 'https://sandbox.polar.sh/checkout/polar_c_1' }));
  await clicked;
  assert.deepEqual(page.location.assigned, ['https://sandbox.polar.sh/checkout/polar_c_1']);
  assert.ok(buttons().every(button => button.disabled), 'still disabled while the page is left');
  // An ordinary pageshow changes nothing; back from Polar through the back-forward cache frees the buttons.
  page.fireWindow('pageshow', { persisted: false });
  assert.ok(buttons().every(button => button.disabled));
  page.fireWindow('pageshow', { persisted: true });
  await waitFor(() => billingGets(page) === 2, 'the reload');
  await waitFor(() => buttons().every(button => !button.disabled), 'the freed buttons');
});

test('billing page glue: a refused checkout says why and re-enables the buttons', async () => {
  let answer = () => jsonResponse(400, { error: 'Unknown product.', code: 'unknown_product' });
  const page = billingPage({
    payload: enabledPayload({ products: [product()] }),
    routes: { 'POST /api/billing/checkout': () => answer() },
  });
  await waitFor(() => page.el('productList').children.length === 1, 'the product');
  const buyButton = () => page.el('productList').children[0].children[1].children.at(-1);
  await buyButton().click();
  assert.equal(page.el('productsStatus').textContent, '이 상품은 지금 살 수 없습니다. 새로고침해 주세요.');
  assert.equal(page.el('productsStatus').dataset.kind, 'error');
  assert.equal(buyButton().disabled, false);
  assert.deepEqual(page.location.assigned, []);
  for (const [response, text] of [
    [() => jsonResponse(502, { error: 'Polar failed.', code: 'polar_error', detail: { polarStatus: 500 } }), 'Polar 요청이 실패했습니다. 잠시 후 다시 시도해 주세요.'],
    [() => jsonResponse(503, { error: 'Misconfigured.', code: 'billing_misconfigured', detail: { problem: 'bad_server' } }), '결제 설정에 문제가 있어 지금은 결제할 수 없습니다.'],
    [() => jsonResponse(409, { error: 'Billing is off.', code: 'billing_disabled' }), '크레딧 결제가 꺼져 있습니다.'],
    [() => { throw new TypeError('Failed to fetch'); }, '서버에 연결하지 못했습니다.'],
    [() => jsonResponse(200, { url: 'javascript:alert(1)' }), 'Polar 요청이 실패했습니다. 잠시 후 다시 시도해 주세요.'],
  ]) {
    answer = response;
    await buyButton().click();
    assert.equal(page.el('productsStatus').textContent, text);
    assert.equal(buyButton().disabled, false);
  }
  assert.deepEqual(page.location.assigned, []);
});

test('billing page glue: 결제 관리 appears with canManage and opens the portal; no customer says so', async () => {
  let answer = () => jsonResponse(200, { url: 'https://sandbox.polar.sh/portal/x' });
  const page = billingPage({
    payload: enabledPayload({ canManage: true }),
    routes: { 'POST /api/billing/portal': () => answer() },
  });
  await waitFor(() => page.el('summaryCard').hidden === false, 'the summary');
  assert.equal(page.el('portalBtn').hidden, false);
  answer = () => jsonResponse(404, { error: 'No customer.', code: 'no_customer' });
  await page.el('portalBtn').click();
  assert.equal(page.el('summaryStatus').textContent, '아직 결제 내역이 없습니다.');
  assert.equal(page.el('portalBtn').disabled, false);
  answer = () => jsonResponse(200, { url: 'https://sandbox.polar.sh/portal/x' });
  await page.el('portalBtn').click();
  const post = page.requests.filter(r => r.url === '/api/billing/portal').at(-1);
  assert.equal(post.body, '{}');
  assert.deepEqual(page.location.assigned, ['https://sandbox.polar.sh/portal/x']);
});

test('billing page glue: 결제 내역 다시 확인 syncs, then reloads the page and the chip', async () => {
  const page = billingPage({
    payload: enabledPayload({ balance: 10 }),
    routes: { 'POST /api/billing/sync': () => jsonResponse(200, { balance: 510, applied: 1, checkout: null }) },
  });
  await waitFor(() => page.el('balanceText').textContent === '보유 크레딧 10', 'the first balance');
  page.state.payload = enabledPayload({ balance: 510, history: [{ id: 'e1', at: new Date().toISOString(), delta: 500, kind: 'grant', label: '크레딧 500' }] });
  await page.el('syncBtn').click();
  const post = page.requests.find(r => r.url === '/api/billing/sync');
  assert.equal(post.body, '{}');
  assert.equal(page.el('balanceText').textContent, '보유 크레딧 510');
  assert.equal(page.el('historyList').children.length, 1);
  assert.equal(page.el('authSlot').children[0].textContent, '크레딧 510');
  assert.equal(page.el('syncBtn').disabled, false);
  assert.equal(billingGets(page), 2);
});

test('billing page glue: back from Polar it polls every 2 s until the credits arrive, then cleans the URL', async () => {
  const answers = [
    () => jsonResponse(200, { balance: 10, applied: 0, checkout: { status: 'confirmed', granted: 0 } }),
    () => { throw new TypeError('Failed to fetch'); },
    () => jsonResponse(502, { error: 'Polar failed.', code: 'polar_error' }),
    () => jsonResponse(200, { balance: 510, applied: 1, checkout: { status: 'succeeded', granted: 500 } }),
  ];
  const page = billingPage({
    payload: enabledPayload({ balance: 10 }),
    search: '?checkout_id=chk_1',
    routes: { 'POST /api/billing/sync': () => answers.shift()() },
  });
  assert.deepEqual(messageOf(page.el('checkoutMessage')), [['pending', '결제를 확인하고 있습니다…']]);
  page.state.payload = enabledPayload({ balance: 510 });
  await waitFor(() => page.replacedUrls.length > 0, 'the end of polling');
  const syncs = page.requests.filter(r => r.url === '/api/billing/sync');
  assert.equal(syncs.length, 4);
  for (const sync of syncs) assert.deepEqual(JSON.parse(sync.body), { checkoutId: 'chk_1' });
  assert.deepEqual(page.delays, [2000, 2000, 2000]);
  assert.deepEqual(messageOf(page.el('checkoutMessage')), [['success', '크레딧 500개가 충전되었습니다.']]);
  assert.deepEqual(page.replacedUrls, ['/billing']);
  await waitFor(() => page.el('balanceText').textContent === '보유 크레딧 510', 'the reloaded balance');
  assert.equal(page.el('authSlot').children[0].textContent, '크레딧 510');
});

test('billing page glue: a checkout that did not complete, a missing one, and the 60 s limit', async () => {
  const expired = billingPage({
    search: '?checkout_id=chk_2',
    routes: { 'POST /api/billing/sync': () => jsonResponse(200, { balance: 0, applied: 0, checkout: { status: 'expired', granted: 0 } }) },
  });
  await waitFor(() => expired.replacedUrls.length > 0, 'the expired checkout');
  assert.deepEqual(messageOf(expired.el('checkoutMessage')), [['error', '결제가 완료되지 않았습니다.']]);

  const missing = billingPage({
    search: '?checkout_id=chk_3',
    routes: { 'POST /api/billing/sync': () => jsonResponse(404, { error: 'Checkout not found.', code: 'checkout_missing' }) },
  });
  await waitFor(() => missing.replacedUrls.length > 0, 'the missing checkout');
  assert.deepEqual(messageOf(missing.el('checkoutMessage')), [['error', '이 결제를 찾지 못했습니다.']]);
  assert.equal(missing.requests.filter(r => r.url === '/api/billing/sync').length, 1, 'no retry');

  // Polar left the placeholder: nothing is asked.
  const placeholder = billingPage({ search: '?checkout_id=%7BCHECKOUT_ID%7D' });
  await waitFor(() => placeholder.replacedUrls.length > 0, 'the placeholder');
  assert.deepEqual(messageOf(placeholder.el('checkoutMessage')), [['error', '이 결제를 찾지 못했습니다.']]);
  assert.equal(placeholder.requests.filter(r => r.url === '/api/billing/sync').length, 0);

  const slow = billingPage({
    search: '?checkout_id=chk_4&x=1',
    routes: { 'POST /api/billing/sync': () => jsonResponse(200, { balance: 0, applied: 0, checkout: { status: 'open', granted: 0 } }) },
  });
  await waitFor(() => slow.replacedUrls.length > 0, 'the time limit');
  // At once, then every 2 s of the fake clock: 0, 2, ..., 60 s.
  assert.equal(slow.requests.filter(r => r.url === '/api/billing/sync').length, 31);
  assert.deepEqual(messageOf(slow.el('checkoutMessage')),
    [['warn', "결제 확인이 늦어지고 있습니다. 잠시 후 '결제 내역 다시 확인'을 눌러 주세요."]]);
  assert.deepEqual(slow.replacedUrls, ['/billing?x=1']);
});

test('billing page glue: billing off, a config problem and no server show only their message', async () => {
  const off = billingPage({ payload: { enabled: false } });
  await waitFor(() => off.el('billingMessage').children.length > 0, 'the off message');
  assert.deepEqual(messageOf(off.el('billingMessage')),
    [['info', '크레딧 결제가 꺼져 있습니다. data/billing/config.json을 만들면 켜집니다(README 참고).']]);
  for (const id of ['summaryCard', 'productsCard', 'historyCard']) assert.equal(off.el(id).hidden, true, id);
  await off.window.VirtuallyBilling.ready;
  assert.deepEqual(texts(off.el('authSlot')), ['Some One', '로그아웃']);

  const invalid = billingPage({ payload: invalidPayload('bad_webhook_secret') });
  await waitFor(() => invalid.el('billingMessage').children.length > 0, 'the problem');
  assert.deepEqual(messageOf(invalid.el('billingMessage')),
    [['error', '결제 설정에 문제가 있습니다: polar.webhookSecret은 whsec_로 시작해야 합니다.']]);
  assert.equal(invalid.el('summaryCard').hidden, true);
  assert.equal(invalid.el('authSlot').children[0].textContent, '크레딧 설정 확인');

  const offline = billingPage({ payload: () => jsonResponse(500, { error: 'Internal error.' }) });
  await waitFor(() => offline.el('billingMessage').children.length > 0, 'the offline message');
  assert.deepEqual(messageOf(offline.el('billingMessage')), [['error', '서버에 연결하지 못했습니다.']]);
  assert.equal(offline.el('productsCard').hidden, true);
});

test('billing page glue: empty lists and a free account', async () => {
  const page = billingPage({ payload: enabledPayload({ free: true, balance: 0, server: 'production' }) });
  await waitFor(() => page.el('summaryCard').hidden === false, 'the summary');
  assert.equal(page.el('freeNote').hidden, false);
  assert.equal(page.el('sandboxBadge').hidden, true);
  assert.equal(page.el('sandboxNote').hidden, true);
  assert.equal(page.el('productsNote').hidden, false);
  assert.equal(page.el('productsNote').textContent,
    '판매 중인 크레딧 상품이 없습니다. Polar에서 상품 메타데이터에 virtually_credits(예: 500)를 넣어 주세요.');
  assert.equal(page.el('productList').hidden, true);
  assert.equal(page.el('historyEmpty').hidden, false);
  assert.equal(page.el('historyList').hidden, true);
  assert.equal(page.el('authSlot').children[0].textContent, '크레딧 무료');
});

test('billing page glue: without auth.js it reads GET /api/billing itself', async () => {
  const page = billingPage({ files: ['credits.js', 'billing.js'], payload: enabledPayload({ balance: 7 }) });
  await waitFor(() => page.el('balanceText').textContent === '보유 크레딧 7', 'the balance');
  assert.equal(billingGets(page), 1);
  assert.equal(page.window.VirtuallyBilling, undefined);
});
