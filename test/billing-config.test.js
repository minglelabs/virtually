'use strict';

// Billing config (server): validation and problem order, modes (disabled /
// enabled / invalid incl. login_required), hot reload of config.json, fail
// closed routes, and that billing off leaves the app as it was.

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const { PROBLEMS, fullEmail, parseBillingConfig, validateBillingConfig } = require('../lib/billing/config');
const { signPayload } = require('../lib/billing/webhook');
const H = require('./helpers/billing-server');

const WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const POLAR = Object.freeze({ server: 'sandbox', accessToken: 'polar_oat_test', webhookSecret: WEBHOOK_SECRET });

const problemOf = raw => validateBillingConfig(raw).problem;

test('problem codes are checked in the v2 order', () => {
  assert.deepEqual(PROBLEMS, [
    'invalid_json', 'bad_admin_emails', 'bad_server', 'missing_token', 'bad_webhook_secret', 'bad_api_version',
    'bad_credits_per_usd', 'bad_free_emails', 'bad_transfer_note', 'login_required',
  ]);
  // Everything wrong at once, then fixed one field at a time: each step reports the next code.
  const raw = {
    adminEmails: ['@example.com'],
    polar: { server: 'staging', accessToken: '  ', webhookSecret: 'secret', apiVersion: 'v1' },
    creditsPerUsd: 0,
    freeEmails: [''],
    transferNote: 'x'.repeat(1001),
  };
  const steps = [
    ['bad_admin_emails', () => { raw.adminEmails = ['owner@example.com']; }],
    ['bad_server', () => { raw.polar.server = 'sandbox'; }],
    ['missing_token', () => { raw.polar.accessToken = 'polar_oat_x'; }],
    ['bad_webhook_secret', () => { raw.polar.webhookSecret = WEBHOOK_SECRET; }],
    ['bad_api_version', () => { raw.polar.apiVersion = '2026-10'; }],
    ['bad_credits_per_usd', () => { raw.creditsPerUsd = 1500; }],
    ['bad_free_emails', () => { raw.freeEmails = ['@example.com']; }],
    ['bad_transfer_note', () => { raw.transferNote = 'x'.repeat(1000); }],
  ];
  for (const [problem, fix] of steps) {
    assert.equal(problemOf(raw), problem);
    fix();
  }
  const valid = validateBillingConfig(raw);
  assert.equal(valid.mode, 'enabled');
  assert.equal(valid.problem, null);
  assert.equal(parseBillingConfig('{"adminEmails": [').problem, 'invalid_json');
  assert.equal(parseBillingConfig('[]').problem, 'invalid_json');
  assert.equal(parseBillingConfig('\uFEFF{"adminEmails":["a@example.com"]}').mode, 'enabled', 'a UTF-8 BOM is fine');
});

test('adminEmails: required, non-empty, full addresses only, normalized', () => {
  for (const adminEmails of [undefined, null, [], 'owner@example.com', [42], ['@example.com'], ['owner@'], ['a@b@c.com'],
    ['own er@example.com'], ['  '], [`${'a'.repeat(250)}@x.com`]]) {
    assert.equal(problemOf({ adminEmails }), 'bad_admin_emails', JSON.stringify(adminEmails));
  }
  const { config } = validateBillingConfig({ adminEmails: [' Owner@Example.COM ', 'owner@example.com', 'second@example.com'] });
  assert.deepEqual(config.adminEmails, ['owner@example.com', 'second@example.com']);
  assert.equal(fullEmail(' Kim@Gmail.com '), 'kim@gmail.com');
  assert.equal(fullEmail('kim@gmail'), 'kim@gmail');
  for (const bad of ['', 'kim', '@gmail.com', 'kim@', 'k@m@gmail.com', 'kim\n@gmail.com', 'k im@gmail.com', null, 7]) {
    assert.equal(fullEmail(bad), null, JSON.stringify(bad));
  }
});

test('polar is optional; present means validated as before', () => {
  const base = { adminEmails: ['owner@example.com'] };
  const off = validateBillingConfig(base);
  assert.equal(off.mode, 'enabled');
  assert.equal(off.polar, false);
  assert.equal(off.config.polar, null);
  assert.equal(off.webhookSecret, null);
  assert.equal(validateBillingConfig({ ...base, polar: null }).config.polar, null, 'null = absent');
  for (const polar of [{}, 'sandbox', [], false, { ...POLAR, server: 'Sandbox' }]) {
    const state = validateBillingConfig({ ...base, polar });
    assert.equal(state.problem, 'bad_server', JSON.stringify(polar));
    assert.equal(state.polar, true);
  }
  assert.equal(problemOf({ ...base, polar: { ...POLAR, accessToken: undefined } }), 'missing_token');
  assert.equal(problemOf({ ...base, polar: { ...POLAR, webhookSecret: 'whsec_' } }), 'bad_webhook_secret');
  assert.equal(problemOf({ ...base, polar: { ...POLAR, apiVersion: '2026-1' } }), 'bad_api_version');
  const on = validateBillingConfig({ ...base, polar: { ...POLAR, server: 'production' } });
  assert.deepEqual(on.config.polar, {
    server: 'production', apiBase: 'https://api.polar.sh/v1', accessToken: 'polar_oat_test', webhookSecret: WEBHOOK_SECRET, apiVersion: '2026-10',
  });
  // The webhook secret is reported on its own while another field is wrong (payments are never lost).
  const broken = validateBillingConfig({ adminEmails: [], polar: POLAR });
  assert.equal(broken.problem, 'bad_admin_emails');
  assert.equal(broken.polar, true);
  assert.equal(broken.webhookSecret, WEBHOOK_SECRET);
  assert.equal(validateBillingConfig({ adminEmails: [] }).polar, false);
  assert.equal(parseBillingConfig('nope').polar, null, 'unparseable: unknown whether Polar is on');
});

test('creditsPerUsd, freeEmails and transferNote', () => {
  const base = { adminEmails: ['owner@example.com'] };
  const defaults = validateBillingConfig(base);
  assert.equal(defaults.config.creditsPerUsd, 2000);
  assert.deepEqual(defaults.config.freeEmails, []);
  assert.equal(defaults.config.transferNote, null);
  for (const creditsPerUsd of [0, -1, 1.5, '2000', 100001]) {
    const state = validateBillingConfig({ ...base, creditsPerUsd });
    assert.equal(state.problem, 'bad_credits_per_usd', String(creditsPerUsd));
    assert.equal(state.creditsPerUsd, 2000, 'an unusable rate shows the default');
  }
  assert.equal(validateBillingConfig({ ...base, creditsPerUsd: 100000 }).config.creditsPerUsd, 100000);
  // An invalid file still reports its own usable rate.
  assert.equal(validateBillingConfig({ adminEmails: [], creditsPerUsd: 1234 }).creditsPerUsd, 1234);
  for (const freeEmails of ['a@example.com', [''], [' '], [1]]) {
    assert.equal(problemOf({ ...base, freeEmails }), 'bad_free_emails', JSON.stringify(freeEmails));
  }
  assert.deepEqual(validateBillingConfig({ ...base, freeEmails: [' VIP@Example.com', '@Free.org'] }).config.freeEmails, ['vip@example.com', '@free.org']);
  for (const transferNote of ['', '   ', 7, ['note'], 'x'.repeat(1001), `  ${'y'.repeat(1001)}  `]) {
    assert.equal(problemOf({ ...base, transferNote }), 'bad_transfer_note', JSON.stringify(transferNote).slice(0, 30));
  }
  assert.equal(validateBillingConfig({ ...base, transferNote: null }).config.transferNote, null);
  const note = '입금 계좌: OO은행 000-000000-00 (예금주)\n입금 후 로그인 이메일을 알려 주세요.';
  assert.equal(validateBillingConfig({ ...base, transferNote: `\n  ${note}  \n` }).config.transferNote, note);
  assert.equal(validateBillingConfig({ ...base, transferNote: `  ${'z'.repeat(1000)}  ` }).config.transferNote.length, 1000);
});

// A Standard Webhooks delivery signed with `secret`, timestamped on the app's clock.
function sendWebhook(ctx, event, { secret = WEBHOOK_SECRET, signed = true } = {}) {
  const body = JSON.stringify(event);
  const id = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const ts = String(Math.floor(ctx.clock.now() / 1000));
  const signature = signPayload(Buffer.from(secret.slice('whsec_'.length), 'base64'), id, ts, Buffer.from(body));
  const headers = signed ? { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${signature}` } : {};
  return H.request(ctx, '/api/billing/polar/webhook', { method: 'POST', body, headers });
}

const IGNORED_EVENT = Object.freeze({ type: 'checkout.created', data: { id: 'co_1' } });

async function assertCode(responsePromise, status, code, detail) {
  const response = await responsePromise;
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.code, code, response.text);
  if (detail !== undefined) assert.deepEqual(response.json.detail, detail);
  return response;
}

test('disabled: no config.json means no billing and the app as it was', async t => {
  const ctx = await H.startApp(t, { billing: null });
  const alice = await H.signIn(ctx, H.ALICE);
  const admin = await H.signIn(ctx, H.ADMIN);
  assert.deepEqual(await H.billingOf(ctx, alice), { enabled: false, creditsPerUsd: 2000 });
  for (const route of ['/api/billing/checkout', '/api/billing/sync', '/api/billing/portal']) {
    await assertCode(H.post(ctx, route, {}, alice), 409, 'billing_disabled');
  }
  for (const route of ['/api/billing/admin/users', '/api/billing/admin/history?email=alice%40example.com']) {
    await assertCode(H.get(ctx, route, admin), 409, 'billing_disabled');
  }
  await assertCode(H.adjust(ctx, admin, H.ALICE.email, 100), 409, 'billing_disabled');
  await assertCode(sendWebhook(ctx, IGNORED_EVENT), 404, 'billing_disabled');
  assert.equal(ctx.server.billing.summary().mode, 'disabled');
  await assert.rejects(fs.stat(H.ledgerPath(ctx.dataDir)), { code: 'ENOENT' }, 'no ledger is written');
  // Login off too: the billing answer needs no session.
  await H.setAuthConfig(ctx, null);
  assert.deepEqual(await H.billingOf(ctx), { enabled: false, creditsPerUsd: 2000 });
  // Unknown billing paths fall through to the usual 404.
  assert.equal((await H.get(ctx, '/api/billing/nope')).status, 404);
});

test('enabled without polar: credits, admin flag and transfer note; Polar routes answer 409 polar_disabled', async t => {
  const transferNote = '입금 계좌: OO은행 000-000000-00 (예금주)\n입금 후 로그인 이메일을 알려 주세요.';
  const ctx = await H.startApp(t, { billing: H.billingConfig({ freeEmails: [H.BOB.email], transferNote }) });
  const alice = await H.signIn(ctx, H.ALICE);
  const admin = await H.signIn(ctx, H.ADMIN);
  const bob = await H.signIn(ctx, H.BOB);
  const expected = {
    enabled: true, mode: 'enabled', problem: null, server: null, creditsPerUsd: 2000, free: false, isAdmin: false,
    polar: false, transferNote, balance: 0, products: [], productsError: null, history: [], canManage: false,
  };
  assert.deepEqual(await H.billingOf(ctx, alice), expected);
  assert.deepEqual(await H.billingOf(ctx, admin), { ...expected, isAdmin: true });
  assert.deepEqual(await H.billingOf(ctx, bob), { ...expected, free: true });
  await assertCode(H.post(ctx, '/api/billing/checkout', { productId: 'prod_1' }, alice), 409, 'polar_disabled');
  await assertCode(H.post(ctx, '/api/billing/sync', {}, alice), 409, 'polar_disabled');
  await assertCode(H.post(ctx, '/api/billing/portal', {}, alice), 409, 'polar_disabled');
  await assertCode(sendWebhook(ctx, IGNORED_EVENT), 404, 'polar_disabled');
  const summary = ctx.server.billing.summary();
  assert.deepEqual(summary, { mode: 'enabled', problem: null, polar: false, server: null, text: 'Billing: on (admin top-ups; Polar off)' });
  // Without a transfer note the page shows its own fallback text.
  await H.setBillingConfig(ctx, H.billingConfig());
  assert.equal((await H.billingOf(ctx, alice)).transferNote, null);
});

test('enabled with polar: polar true and its server; a Polar outage only sets productsError', async t => {
  // Nothing listens on the discard port: every Polar call fails fast.
  const ctx = await H.startApp(t, {
    billing: H.billingConfig({ polar: POLAR, creditsPerUsd: 1000 }),
    billingOptions: { apiBase: 'http://127.0.0.1:9/v1' },
  });
  const alice = await H.signIn(ctx, H.ALICE);
  const billing = await H.billingOf(ctx, alice);
  assert.equal(billing.mode, 'enabled');
  assert.equal(billing.polar, true);
  assert.equal(billing.server, 'sandbox');
  assert.equal(billing.creditsPerUsd, 1000);
  assert.deepEqual(billing.products, []);
  assert.equal(billing.productsError, 'polar_unreachable');
  assert.equal(billing.canManage, false);
  assert.equal(ctx.server.billing.summary().text, 'Billing (Polar): on (sandbox)');
  // Polar is reached (and fails) instead of being refused as off.
  await assertCode(H.post(ctx, '/api/billing/portal', {}, alice), 502, 'polar_error');
});

test('invalid: every problem code over HTTP as config.json is edited, fail closed with 503', async t => {
  const ctx = await H.startApp(t, { billing: '{"adminEmails": [' });
  const alice = await H.signIn(ctx, H.ALICE);
  const admin = await H.signIn(ctx, H.ADMIN);
  const invalid = (problem, creditsPerUsd = 2000) => ({
    enabled: true, mode: 'invalid', problem, creditsPerUsd, balance: null, products: [], history: [],
  });
  const assertLocked = async (problem, rate) => {
    assert.deepEqual(await H.billingOf(ctx, alice), invalid(problem, rate));
    await assertCode(H.post(ctx, '/api/billing/checkout', { productId: 'prod_1' }, alice), 503, 'billing_misconfigured', { problem });
    await assertCode(H.post(ctx, '/api/billing/sync', {}, alice), 503, 'billing_misconfigured', { problem });
    await assertCode(H.post(ctx, '/api/billing/portal', {}, alice), 503, 'billing_misconfigured', { problem });
    await assertCode(H.get(ctx, '/api/billing/admin/users', admin), 503, 'billing_misconfigured', { problem });
    await assertCode(H.get(ctx, '/api/billing/admin/history?email=alice%40example.com', admin), 503, 'billing_misconfigured', { problem });
    await assertCode(H.adjust(ctx, admin, H.ALICE.email, 100), 503, 'billing_misconfigured', { problem });
  };
  assert.deepEqual(await H.billingOf(ctx, alice), invalid('invalid_json'));
  await assertLocked('invalid_json', 2000);
  assert.equal(ctx.server.billing.summary().text,
    'Billing config problem: invalid_json (data/billing/config.json) - paid generation stays locked until it is fixed');

  const raw = {
    adminEmails: ['@example.com'],
    polar: { server: 'staging', accessToken: '', webhookSecret: 'secret', apiVersion: 'v1' },
    creditsPerUsd: 0,
    freeEmails: [3],
    transferNote: '',
  };
  const steps = [
    ['bad_admin_emails', () => { raw.adminEmails = [H.ADMIN.email]; }],
    ['bad_server', () => { raw.polar.server = 'sandbox'; }],
    ['missing_token', () => { raw.polar.accessToken = 'polar_oat_test'; }],
    ['bad_webhook_secret', () => { raw.polar.webhookSecret = WEBHOOK_SECRET; }],
    ['bad_api_version', () => { raw.polar.apiVersion = '2026-10'; }],
    ['bad_credits_per_usd', () => { raw.creditsPerUsd = 1500; }],
    ['bad_free_emails', () => { raw.freeEmails = []; }],
    ['bad_transfer_note', () => { raw.transferNote = '계좌 안내'; delete raw.polar; }],
  ];
  for (const [problem, fix] of steps) {
    await H.setBillingConfig(ctx, raw);
    const body = await H.billingOf(ctx, alice);
    // The file's rate shows as soon as it is usable, the default before.
    assert.deepEqual(body, invalid(problem, raw.creditsPerUsd === 1500 ? 1500 : 2000), problem);
    fix();
  }
  await assertLocked('bad_transfer_note', 1500);
  await H.setBillingConfig(ctx, raw);
  const enabled = await H.billingOf(ctx, alice);
  assert.equal(enabled.mode, 'enabled');
  assert.equal(enabled.creditsPerUsd, 1500);
  assert.equal(enabled.transferNote, '계좌 안내');

  // Login off with a billing file: login_required, the file's rate still shown, no session needed.
  await H.setAuthConfig(ctx, null);
  assert.deepEqual(await H.billingOf(ctx), invalid('login_required', 1500));
  await assertCode(H.post(ctx, '/api/billing/sync', {}), 503, 'billing_misconfigured', { problem: 'login_required' });
  await assertCode(H.get(ctx, '/api/billing/admin/users'), 503, 'billing_misconfigured', { problem: 'login_required' });
  assert.equal(ctx.server.billing.summary().problem, 'login_required');

  // Every mode change after startup is logged once.
  const changes = ctx.logs.filter(line => line.startsWith('[billing] Billing'));
  assert.ok(changes.includes('[billing] Billing config problem: bad_server (data/billing/config.json) - paid generation stays locked until it is fixed'), changes.join('\n'));
  assert.ok(changes.includes('[billing] Billing: on (admin top-ups; Polar off)'), changes.join('\n'));
  assert.ok(changes.includes('[billing] Billing config problem: login_required (data/billing/config.json) - paid generation stays locked until it is fixed'));
  assert.equal(changes.filter(line => line.includes('bad_server')).length, 1);
});

test('webhook by mode: 404 without polar, handled while invalid when the secret is usable, else 503', async t => {
  const ctx = await H.startApp(t, { billing: { adminEmails: [], polar: POLAR } });
  // bad_admin_emails, but polar and its secret are fine: deliveries are still verified and handled.
  let response = await sendWebhook(ctx, IGNORED_EVENT);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { ok: true, ignored: true });
  assert.equal((await sendWebhook(ctx, IGNORED_EVENT, { signed: false })).status, 403);
  assert.equal((await sendWebhook(ctx, IGNORED_EVENT, { secret: 'whsec_c29tZXRoaW5nIGVsc2U=' })).status, 403);

  // Login off (login_required) with a usable secret: still handled, signed out.
  await H.setAuthConfig(ctx, null);
  await H.setBillingConfig(ctx, H.billingConfig({ polar: POLAR }));
  response = await sendWebhook(ctx, IGNORED_EVENT);
  assert.equal(response.status, 200, response.text);

  await H.setBillingConfig(ctx, { adminEmails: [], polar: { ...POLAR, webhookSecret: 'not-a-secret' } });
  await assertCode(sendWebhook(ctx, IGNORED_EVENT), 503, 'billing_misconfigured', { problem: 'bad_admin_emails' });
  await H.setBillingConfig(ctx, '{ broken');
  await assertCode(sendWebhook(ctx, IGNORED_EVENT), 503, 'billing_misconfigured', { problem: 'invalid_json' });
  // A file without polar: Polar is off, even when another field is wrong.
  await H.setBillingConfig(ctx, { adminEmails: [] });
  await assertCode(sendWebhook(ctx, IGNORED_EVENT), 404, 'polar_disabled');
  await H.setBillingConfig(ctx, null);
  await assertCode(sendWebhook(ctx, IGNORED_EVENT), 404, 'billing_disabled');
});

test('hot reload: admins, rate and note apply on the next request; removing the file turns billing off', async t => {
  const ctx = await H.startApp(t);
  const alice = await H.signIn(ctx, H.ALICE);
  let billing = await H.billingOf(ctx, alice);
  assert.equal(billing.isAdmin, false);
  await assertCode(H.get(ctx, '/api/billing/admin/users', alice), 403, 'admin_only');

  await H.setBillingConfig(ctx, H.billingConfig({ adminEmails: [H.ADMIN.email, ' ALICE@example.com'], creditsPerUsd: 1000, transferNote: '새 안내' }));
  billing = await H.billingOf(ctx, alice);
  assert.equal(billing.isAdmin, true);
  assert.equal(billing.creditsPerUsd, 1000);
  assert.equal(billing.transferNote, '새 안내');
  const users = await H.get(ctx, '/api/billing/admin/users', alice);
  assert.equal(users.status, 200, users.text);
  assert.equal(users.json.creditsPerUsd, 1000);

  await H.setBillingConfig(ctx, H.billingConfig());
  assert.equal((await H.billingOf(ctx, alice)).isAdmin, false);
  await assertCode(H.adjust(ctx, alice, H.BOB.email, 100), 403, 'admin_only');

  await H.setBillingConfig(ctx, null);
  assert.deepEqual(await H.billingOf(ctx, alice), { enabled: false, creditsPerUsd: 2000 });
  assert.ok(ctx.logs.includes('[billing] Billing: off (no data/billing/config.json)'), ctx.logs.join('\n'));
  // A partial write (an editor saving) is invalid until the next change: fail closed.
  await H.setBillingConfig(ctx, '{"adminEmails": ["owner@exa');
  assert.equal((await H.billingOf(ctx, alice)).problem, 'invalid_json');
  await H.setBillingConfig(ctx, H.billingConfig());
  assert.equal((await H.billingOf(ctx, alice)).mode, 'enabled');
});
