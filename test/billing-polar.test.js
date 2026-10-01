'use strict';

// Polar billing, server side, written from the contract (.kiro/tmp/spec-v2.md,
// spec-shared.md, spec-server.md) rather than from the code: the webhook
// signature check, orders -> credits, the credit product list, checkout, sync,
// the customer portal, and Polar switched off (no `polar` in config.json).
// Everything runs against the fake Google and the fake Polar on loopback.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const { verifyWebhook } = require('../lib/billing/webhook');
const { startFakeGoogle } = require('./helpers/fake-google');
const { startFakePolar } = require('./helpers/fake-polar');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-client-secret';
const TOKEN = 'polar_oat_test_token_d0n0tl0g';
// The Standard Webhooks known-answer secret (spec-server.md), used by the whole file.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const OTHER_SECRET = `whsec_${Buffer.alloc(24, 7).toString('base64')}`;
const WEBHOOK = '/api/billing/polar/webhook';
const START = Date.parse('2026-09-01T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PUBLIC_HOST = 'virtually.example.com';
const ADMIN = { sub: '100000000000000000001', email: 'admin@example.com', name: 'Admin' };
const ALICE = { sub: '111111111111111111111', email: 'alice@example.com', name: 'Alice Kim' };
const BOB = { sub: '222222222222222222222', email: 'bob@example.com', name: 'Bob Lee' };
const CAROL = { sub: '333333333333333333333', email: 'carol@example.com', name: 'Carol Park' };
const INVALID_SIGNATURE = { error: 'Invalid signature.' };

function authConfig(overrides = {}) {
  return { google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, allowedEmails: ['@example.com'], ...overrides };
}

// A v2 billing config with Polar on. `polar: null` leaves Polar out; a `polar`
// object is merged into the default one.
function billingConfig({ polar = {}, ...rest } = {}) {
  const config = { adminEmails: [ADMIN.email], welcomeCredits: 0, ...rest };
  if (polar !== null) config.polar = { server: 'sandbox', accessToken: TOKEN, webhookSecret: SECRET, ...polar };
  return config;
}

function makeClock(start = START) {
  const clock = { t: start, now: () => clock.t, advance: ms => { clock.t += ms; } };
  return clock;
}

let stampCounter = 0;
// Writes a JSON config file with a fresh mtime, so the hot reload sees every write.
async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  stampCounter += 1;
  const stamp = new Date(Date.now() + stampCounter * 1000);
  await fs.utimes(file, stamp, stamp);
}

const writeAuthConfig = (ctx, value) => writeJsonFile(path.join(ctx.dataDir, 'auth', 'config.json'), value);
const writeBillingConfig = (ctx, value) => writeJsonFile(path.join(ctx.dataDir, 'billing', 'config.json'), value);

async function stopApp(ctx) {
  if (!ctx.server || !ctx.server.listening) return;
  ctx.server.closeAllConnections();
  await new Promise(resolve => ctx.server.close(resolve));
  // Let pending ledger writes land before the data directory goes.
  if (ctx.server.billing && typeof ctx.server.billing.close === 'function') await ctx.server.billing.close().catch(() => {});
}

// A running app + fake Google + fake Polar on a fresh dataDir. `auth: null` =
// no auth config.json (login off), `billing: null` = no billing config.json.
// `webhooks: false` = the fake Polar sends no webhooks. `seed(dataDir)` runs
// before the app starts; `appOptions` go to createAppServer.
async function setup(t, { auth = authConfig(), billing = billingConfig(), webhooks = true, pageLimit, seed, appOptions = {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-polar-'));
  const ctx = { dataDir, clock: makeClock(), logs: [], appOptions, webhooks };
  ctx.google = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: ctx.clock.now });
  ctx.polar = await startFakePolar({ token: TOKEN, webhookSecret: SECRET, now: ctx.clock.now, ...(pageLimit ? { pageLimit } : {}) });
  t.after(async () => {
    await stopApp(ctx);
    await ctx.polar.close();
    await ctx.google.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (auth !== null) await writeAuthConfig(ctx, auth);
  if (billing !== null) await writeBillingConfig(ctx, billing);
  if (seed) await seed(dataDir);
  return startApp(ctx);
}

// Starts (or, after stopApp, restarts) the app on ctx.dataDir; the port changes.
async function startApp(ctx) {
  const log = line => ctx.logs.push(String(line));
  ctx.server = await createAppServer({
    dataDir: ctx.dataDir,
    auth: { endpoints: ctx.google.endpoints, now: ctx.clock.now, configCheckIntervalMs: 0, log },
    billing: { apiBase: ctx.polar.apiBase, now: ctx.clock.now, configCheckIntervalMs: 0, log },
    ...ctx.appOptions,
  });
  await new Promise(resolve => ctx.server.listen(0, '127.0.0.1', resolve));
  ctx.port = ctx.server.address().port;
  ctx.host = `127.0.0.1:${ctx.port}`;
  ctx.origin = `http://${ctx.host}`;
  ctx.webhookUrl = `${ctx.origin}${WEBHOOK}`;
  ctx.polar.setWebhookUrl(ctx.webhooks ? ctx.webhookUrl : null);
  return ctx;
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

function cookieFrom(response, name) {
  for (const line of response.setCookies) {
    const pair = line.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}

// Walks the Google login as `user` and returns the session Cookie header.
async function signIn(ctx, user) {
  ctx.google.setUser({ sub: user.sub, email: user.email, name: user.name });
  const start = await request(ctx.port, '/auth/google/login?next=%2Fbilling');
  assert.equal(start.status, 302, 'login start redirects to Google');
  const oauth = cookieFrom(start, 'virtually_oauth');
  const authorizeUrl = new URL(start.headers.location);
  const approved = await request(Number(authorizeUrl.port), authorizeUrl.pathname + authorizeUrl.search);
  assert.equal(approved.status, 302, 'fake Google approves');
  const back = new URL(approved.headers.location);
  const callback = await request(ctx.port, back.pathname + back.search, { cookie: `virtually_oauth=${oauth}` });
  const session = cookieFrom(callback, 'virtually_session');
  assert.ok(session, `signed in as ${user.email} (got ${callback.headers.location})`);
  return `virtually_session=${session}`;
}

function post(ctx, pathname, body = {}, { cookie, headers } = {}) {
  return request(ctx.port, pathname, { method: 'POST', body, cookie, headers });
}

// GET /api/billing as a signed-in user (asserts 200).
async function billingOf(ctx, cookie) {
  const response = await request(ctx.port, '/api/billing', { cookie });
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function balanceOf(ctx, cookie) {
  return (await billingOf(ctx, cookie)).balance;
}

// Signs in and opens the billing page once (the user's first billing request).
async function customer(ctx, user) {
  const cookie = await signIn(ctx, user);
  await billingOf(ctx, cookie);
  return cookie;
}

function checkoutIdOf(url) {
  const match = /\/checkout\/([^/?#]+)$/.exec(String(url));
  assert.ok(match, `a fake Polar checkout URL: ${url}`);
  return match[1];
}

async function startCheckout(ctx, cookie, productId, headers) {
  const response = await post(ctx, '/api/billing/checkout', { productId }, { cookie, headers });
  assert.equal(response.status, 200, response.text);
  return checkoutIdOf(response.json.url);
}

// Checkout + payment on the fake Polar (its webhook, when on, is handled before this returns).
async function buy(ctx, cookie, productId, payOptions) {
  const checkoutId = await startCheckout(ctx, cookie, productId);
  const order = await ctx.polar.pay(checkoutId, payOptions);
  return { checkoutId, order };
}

function fixedPrice(amount, currency = 'usd', extra = {}) {
  return {
    id: crypto.randomUUID(), amount_type: 'fixed', price_amount: amount, price_currency: currency,
    is_archived: false, type: 'one_time', recurring_interval: null, ...extra,
  };
}

function creditPack(ctx, credits, { price = 1000, ...fields } = {}) {
  return ctx.polar.addProduct({
    name: `크레딧 ${credits}`, metadata: { virtually_credits: credits }, prices: [fixedPrice(price)], ...fields,
  });
}

function subscription(ctx, credits, { price = 900, interval = 'month', ...fields } = {}) {
  return ctx.polar.addProduct({
    name: `월 ${credits} 크레딧`, is_recurring: true, recurring_interval: interval, metadata: { virtually_credits: credits },
    prices: [fixedPrice(price, 'usd', { type: 'recurring', recurring_interval: interval })], ...fields,
  });
}

// A Polar-shaped order for a crafted webhook. `customer` fields merge into the default customer.
function craftOrder(product, { customer: customerFields = {}, ...fields } = {}) {
  const customerRecord = { id: crypto.randomUUID(), email: 'buyer@example.com', external_id: null, ...customerFields };
  return {
    id: crypto.randomUUID(),
    created_at: new Date(START).toISOString(),
    status: 'paid',
    paid: true,
    billing_reason: 'purchase',
    subtotal_amount: 1000,
    net_amount: 1000,
    total_amount: 1000,
    refunded_amount: 0,
    currency: 'usd',
    customer_id: customerRecord.id,
    product_id: product.id,
    checkout_id: null,
    subscription_id: null,
    metadata: {},
    customer: customerRecord,
    product: {
      id: product.id, name: product.name, is_recurring: product.is_recurring, metadata: { ...product.metadata },
    },
    ...fields,
  };
}

function event(type, data) {
  return { type, timestamp: new Date(START).toISOString(), data };
}

function rawOf(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  return Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
}

// Standard Webhooks signature with the base64 key after "whsec_" (or, legacy, the secret's UTF-8 bytes).
function signatureOf(secret, id, ts, raw, { legacy = false } = {}) {
  const key = legacy ? Buffer.from(secret, 'utf8') : Buffer.from(secret.slice('whsec_'.length), 'base64');
  return crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), rawOf(raw)])).digest('base64');
}

let webhookCounter = 0;
function nextWebhookId() {
  webhookCounter += 1;
  return `msg_test_${webhookCounter}_${crypto.randomBytes(6).toString('hex')}`;
}

// POSTs a webhook delivery, signed by default like the fake Polar (Standard
// Webhooks) at the shared clock. `headers` override/add headers; `drop` removes some.
function sendWebhook(ctx, payload, { id = nextWebhookId(), ts, scheme, headers = {}, drop = [], signed = true } = {}) {
  const raw = rawOf(payload);
  const all = { 'Content-Type': 'application/json', ...(signed ? ctx.polar.sign(raw, { id, ts, scheme }) : {}), ...headers };
  for (const name of drop) delete all[name];
  return request(ctx.port, WEBHOOK, { method: 'POST', headers: all, body: raw });
}

function nowSec(ctx) {
  return Math.floor(ctx.clock.now() / 1000);
}

async function readLedger(ctx) {
  return JSON.parse(await fs.readFile(path.join(ctx.dataDir, 'billing', 'ledger.json'), 'utf8'));
}

async function entriesFor(ctx, orderId) {
  return (await readLedger(ctx)).entries.filter(entry => entry && entry.orderId === orderId);
}

function polarCalls(ctx, method, pathname) {
  return ctx.polar.requests.filter(entry => entry.method === method && entry.path === pathname);
}

function assertNoSecretsLogged(ctx) {
  const text = ctx.logs.join('\n');
  assert.ok(!text.includes(TOKEN), 'the Polar token is never logged');
  assert.ok(!text.includes(SECRET), 'the webhook secret is never logged');
}

// An order.paid payload for `user`, as the app's own checkouts produce them.
function paidOrderFor(product, user, fields = {}) {
  const { customer: customerFields = {}, ...rest } = fields;
  return craftOrder(product, {
    metadata: { virtually_user: user.sub, virtually_email: user.email },
    customer: { email: user.email, external_id: `google:${user.sub}`, ...customerFields },
    ...rest,
  });
}

// --- webhook -----------------------------------------------------------------

const KAT = {
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  ts: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  now: 1614265330000,
};

test('webhook: the Standard Webhooks known-answer vector verifies, over HTTP too', async t => {
  const headers = { 'webhook-id': KAT.id, 'webhook-timestamp': KAT.ts, 'webhook-signature': KAT.signature };
  assert.equal(verifyWebhook({ secret: SECRET, headers, rawBody: Buffer.from(KAT.body), nowMs: KAT.now }).ok, true);
  assert.equal(`v1,${signatureOf(SECRET, KAT.id, KAT.ts, KAT.body)}`, KAT.signature, 'the test signer agrees with the vector');

  const ctx = await setup(t);
  ctx.clock.t = KAT.now;
  const send = (body, extra = {}) => request(ctx.port, WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...extra }, body,
  });
  const accepted = await send(KAT.body);
  assert.equal(accepted.status, 200, accepted.text);
  // The event has no type this app handles.
  assert.deepEqual(accepted.json, { ok: true, ignored: true });
  // One byte of body, id or timestamp changed: the same signature no longer holds.
  for (const [body, extra, label] of [
    ['{"test": 2432232315}', {}, 'body'],
    [KAT.body, { 'webhook-id': `${KAT.id}x` }, 'id'],
    [KAT.body, { 'webhook-timestamp': String(Number(KAT.ts) + 1) }, 'timestamp'],
  ]) {
    const rejected = await send(body, extra);
    assert.equal(rejected.status, 403, label);
    assert.deepEqual(rejected.json, INVALID_SIGNATURE, label);
  }
  assert.ok(ctx.logs.some(line => line.startsWith('[billing] webhook rejected')), 'rejections are logged');
});

test('webhook: the legacy key (the secret\'s UTF-8 bytes) is accepted; another secret or a changed body is not', async t => {
  const ctx = await setup(t);
  const cookie = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 40);

  const legacy = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)), { scheme: 'legacy' });
  assert.equal(legacy.status, 200, legacy.text);
  assert.deepEqual(legacy.json, { ok: true });
  const standard = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)), { scheme: 'standard' });
  assert.equal(standard.status, 200, standard.text);
  assert.equal(await balanceOf(ctx, cookie), 80);

  const foreign = paidOrderFor(pack, ALICE);
  const raw = rawOf(event('order.paid', foreign));
  const ts = String(nowSec(ctx));
  for (const [signature, label] of [
    [signatureOf(OTHER_SECRET, 'msg_wrong_1', ts, raw), 'another secret, standard key'],
    [signatureOf(OTHER_SECRET, 'msg_wrong_1', ts, raw, { legacy: true }), 'another secret, legacy key'],
    [signatureOf(SECRET, 'msg_wrong_1', ts, rawOf(event('order.paid', { ...foreign, id: 'other' }))), 'signed for another body'],
  ]) {
    const response = await sendWebhook(ctx, raw, {
      signed: false, headers: { 'webhook-id': 'msg_wrong_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${signature}` },
    });
    assert.equal(response.status, 403, label);
    assert.deepEqual(response.json, INVALID_SIGNATURE, label);
  }
  assert.equal(await balanceOf(ctx, cookie), 80, 'rejected deliveries grant nothing');
  assert.ok(ctx.logs.some(line => line.startsWith('[billing] webhook rejected')));
  assertNoSecretsLogged(ctx);
});

test('webhook: timestamps more than 300 s from now are refused, either way', async t => {
  const ctx = await setup(t);
  const payload = event('checkout.updated', { id: 'chk_1' });
  const now = nowSec(ctx);
  for (const [ts, status] of [[now - 300, 200], [now + 300, 200], [now - 301, 403], [now + 301, 403], [now - 86400, 403]]) {
    const response = await sendWebhook(ctx, payload, { ts });
    assert.equal(response.status, status, `timestamp ${ts - now} s from now`);
  }
  for (const ts of ['abc', `${now}abc`]) {
    const raw = rawOf(payload);
    const response = await sendWebhook(ctx, raw, {
      signed: false, headers: { 'webhook-id': 'msg_ts', 'webhook-timestamp': ts, 'webhook-signature': `v1,${signatureOf(SECRET, 'msg_ts', ts, raw)}` },
    });
    assert.equal(response.status, 403, `timestamp ${JSON.stringify(ts)}`);
  }
});

test('webhook: a missing webhook-id, webhook-timestamp or webhook-signature header is 403', async t => {
  const ctx = await setup(t);
  const cookie = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 40);
  for (const header of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const response = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)), { drop: [header] });
    assert.equal(response.status, 403, header);
    assert.deepEqual(response.json, INVALID_SIGNATURE, header);
  }
  const unsigned = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)), { signed: false });
  assert.equal(unsigned.status, 403);
  const empty = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)), { headers: { 'webhook-signature': '' } });
  assert.equal(empty.status, 403);
  assert.equal(await balanceOf(ctx, cookie), 0);
});

test('webhook: one valid v1 signature among several is enough; entries other than v1 are ignored', async t => {
  const ctx = await setup(t);
  const cookie = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 10);
  const deliver = async (makeHeader, label) => {
    const id = nextWebhookId();
    const ts = String(nowSec(ctx));
    const raw = rawOf(event('order.paid', paidOrderFor(pack, ALICE)));
    const valid = signatureOf(SECRET, id, ts, raw);
    const bogus = signatureOf(OTHER_SECRET, id, ts, raw);
    const response = await sendWebhook(ctx, raw, {
      signed: false, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': makeHeader(valid, bogus) },
    });
    return [response.status, label];
  };
  const cases = [
    [(valid, bogus) => `v1,${bogus} v1,${valid}`, 200, 'valid second'],
    [(valid, bogus) => `v1,${valid} v1,${bogus}`, 200, 'valid first'],
    [(valid, bogus) => `v1,${bogus} v1,AAAA v1,${valid} v1,${bogus}`, 200, 'valid among many'],
    [(valid, bogus) => `v2,${bogus} v1,${valid}`, 200, 'non-v1 entry beside a valid v1'],
    [(valid, bogus) => `v1,${bogus} v1,AAAA`, 403, 'no valid entry'],
    [valid => `v2,${valid}`, 403, 'the valid value under v2'],
    [valid => `v1a,${valid}`, 403, 'the valid value under v1a'],
    [valid => `V1,${valid}`, 403, 'the valid value under V1'],
    [valid => valid, 403, 'the valid value without a version'],
  ];
  let granted = 0;
  for (const [makeHeader, expected, label] of cases) {
    const [status] = await deliver(makeHeader, label);
    assert.equal(status, expected, label);
    if (status === 200) granted += 10;
  }
  assert.equal(await balanceOf(ctx, cookie), granted);
});

test('webhook: a repeated webhook-id is a duplicate for 30 days and grants nothing twice', async t => {
  const ctx = await setup(t);
  let cookie = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 25);
  const order = paidOrderFor(pack, ALICE);
  const id = 'msg_duplicate_check_1';

  const first = await sendWebhook(ctx, event('order.paid', order), { id });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json, { ok: true });
  const again = await sendWebhook(ctx, event('order.paid', order), { id });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { ok: true, duplicate: true });
  // Dedupe is by id: another body under a handled id is not looked at.
  const refunded = { ...order, status: 'refunded', refunded_amount: order.net_amount };
  assert.deepEqual((await sendWebhook(ctx, event('order.refunded', refunded), { id })).json, { ok: true, duplicate: true });
  assert.equal(await balanceOf(ctx, cookie), 25);

  ctx.clock.advance(29 * DAY);
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', order), { id })).json, { ok: true, duplicate: true }, 'still known after 29 days');
  ctx.clock.advance(2 * DAY);
  const late = await sendWebhook(ctx, event('order.paid', order), { id });
  assert.equal(late.status, 200);
  assert.deepEqual(late.json, { ok: true }, 'forgotten after 30 days');
  cookie = await signIn(ctx, ALICE);
  assert.equal(await balanceOf(ctx, cookie), 25, 'the order itself still grants once');
});

test('webhook: a failed ledger write answers 500 and the retried delivery is processed', async t => {
  const ctx = await setup(t);
  const cookie = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 60);
  const ledgerPath = path.join(ctx.dataDir, 'billing', 'ledger.json');
  // A directory where the ledger file goes: the atomic rename fails.
  await fs.rename(ledgerPath, `${ledgerPath}.saved`);
  await fs.mkdir(ledgerPath);
  const order = paidOrderFor(pack, ALICE);
  const id = 'msg_retry_after_500';
  const failed = await sendWebhook(ctx, event('order.paid', order), { id });
  assert.equal(failed.status, 500, failed.text);
  await fs.rmdir(ledgerPath);
  await fs.rename(`${ledgerPath}.saved`, ledgerPath);

  const retried = await sendWebhook(ctx, event('order.paid', order), { id });
  assert.equal(retried.status, 200, retried.text);
  assert.deepEqual(retried.json, { ok: true }, 'the failed delivery was not recorded as handled');
  assert.equal(await balanceOf(ctx, cookie), 60);
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', order), { id })).json, { ok: true, duplicate: true });
  assert.equal(await balanceOf(ctx, cookie), 60);
});

test('webhook: an unreadable ledger answers 500 (never a silent 200), so Polar keeps retrying', async t => {
  const ctx = await setup(t, {
    seed: async dataDir => {
      await fs.mkdir(path.join(dataDir, 'billing'), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dataDir, 'billing', 'ledger.json'), '{ "entries": [', { mode: 0o600 });
    },
  });
  const pack = creditPack(ctx, 60);
  const response = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)));
  assert.equal(response.status, 500, response.text);
  assert.equal(await fs.readFile(path.join(ctx.dataDir, 'billing', 'ledger.json'), 'utf8'), '{ "entries": [', 'the broken ledger is left alone');
});

test('webhook: a signed body that is not JSON is 400; the signature is checked first', async t => {
  const ctx = await setup(t);
  for (const body of ['not json', '{"type": "order.paid",', '']) {
    const response = await sendWebhook(ctx, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const unsigned = await sendWebhook(ctx, 'not json', { signed: false, headers: { 'webhook-id': 'msg_x', 'webhook-timestamp': String(nowSec(ctx)), 'webhook-signature': 'v1,AAAA' } });
  assert.equal(unsigned.status, 403);
});

test('webhook: a body over 1 MiB is 413 whatever its signature; exactly 1 MiB is read', async t => {
  const ctx = await setup(t);
  const prefix = '{"type":"test.padding","pad":"';
  const suffix = '"}';
  const oneMiB = prefix + 'a'.repeat(1024 * 1024 - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(oneMiB), 1024 * 1024);
  const fits = await sendWebhook(ctx, oneMiB);
  assert.equal(fits.status, 200, fits.text);
  assert.deepEqual(fits.json, { ok: true, ignored: true });

  const tooBig = prefix + 'a'.repeat(1024 * 1024 - prefix.length - suffix.length + 1) + suffix;
  assert.equal((await sendWebhook(ctx, tooBig)).status, 413);
  assert.equal((await sendWebhook(ctx, tooBig, { signed: false })).status, 413);
});

test('webhook: event types other than order.paid / order.updated / order.refunded are 200 ignored', async t => {
  const ctx = await setup(t);
  const cookie = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 30);
  const order = paidOrderFor(pack, ALICE);
  for (const type of ['order.created', 'checkout.updated', 'subscription.active', 'customer.updated', 'benefit_grant.created']) {
    const response = await sendWebhook(ctx, event(type, order));
    assert.equal(response.status, 200, type);
    assert.deepEqual(response.json, { ok: true, ignored: true }, type);
  }
  assert.equal(await balanceOf(ctx, cookie), 0, 'ignored events grant nothing');
  for (const type of ['order.paid', 'order.updated']) {
    assert.deepEqual((await sendWebhook(ctx, event(type, order))).json, { ok: true }, type);
  }
  assert.equal(await balanceOf(ctx, cookie), 30);
  assert.ok(ctx.logs.some(line => line.startsWith('[billing] webhook order.paid ')), 'handled events are logged');
});

test('webhook: works signed out while every other billing route needs a session', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 15);
  assert.equal((await request(ctx.port, '/api/billing')).status, 401);
  assert.equal((await post(ctx, '/api/billing/sync', {})).status, 401);
  const plain = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)));
  assert.equal(plain.status, 200, plain.text);
  const junkCookie = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)), { headers: { Cookie: 'virtually_session=forged.value' } });
  assert.equal(junkCookie.status, 200, junkCookie.text);
  // The Host / Origin / Sec-Fetch checks still come first.
  for (const headers of [{ Host: 'evil.example.com' }, { Origin: 'https://evil.example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const refused = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)), { headers });
    assert.equal(refused.status, 403, JSON.stringify(headers));
    assert.notDeepEqual(refused.json, INVALID_SIGNATURE, JSON.stringify(headers));
  }
  const cookie = await signIn(ctx, ALICE);
  assert.equal(await balanceOf(ctx, cookie), 30);
});

test('webhook: payments are taken while login is off or broken, and show up once the user signs in', async t => {
  const ctx = await setup(t, { auth: null });
  const pack = creditPack(ctx, 40);
  const state = await request(ctx.port, '/api/billing');
  assert.equal(state.status, 200);
  assert.equal(state.json.mode, 'invalid');
  assert.equal(state.json.problem, 'login_required');

  const offline = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)));
  assert.equal(offline.status, 200, offline.text);
  assert.deepEqual(offline.json, { ok: true });
  await writeAuthConfig(ctx, '{ "google": ');
  const broken = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)));
  assert.equal(broken.status, 200, broken.text);

  await writeAuthConfig(ctx, authConfig());
  const cookie = await signIn(ctx, ALICE);
  assert.equal(await balanceOf(ctx, cookie), 80);
});

test('webhook: keeps working while another config field is wrong, as long as polar.webhookSecret is valid', async t => {
  const ctx = await setup(t, { billing: billingConfig({ creditsPerUsd: 0 }) });
  const pack = creditPack(ctx, 5);
  const cookie = await signIn(ctx, ALICE);
  assert.equal((await billingOf(ctx, cookie)).problem, 'bad_credits_per_usd');
  assert.equal((await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)))).status, 200);
  const { adminEmails, ...withoutAdmins } = billingConfig();
  assert.ok(adminEmails);
  await writeBillingConfig(ctx, withoutAdmins);
  assert.equal((await billingOf(ctx, cookie)).mode, 'invalid');
  assert.equal((await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)))).status, 200);
  await writeBillingConfig(ctx, billingConfig());
  assert.equal(await balanceOf(ctx, cookie), 10);
});

test('webhook: 503 while config.json is broken or its webhook secret unusable (Polar retries), then processed', async t => {
  const ctx = await setup(t, { billing: '{ "polar": ' });
  const pack = creditPack(ctx, 70);
  const order = paidOrderFor(pack, ALICE);
  const id = 'msg_retried_after_503';
  assert.equal((await sendWebhook(ctx, event('order.paid', order), { id })).status, 503);
  for (const webhookSecret of ['not-a-secret', 42, 'whsec']) {
    await writeBillingConfig(ctx, billingConfig({ polar: { webhookSecret } }));
    assert.equal((await sendWebhook(ctx, event('order.paid', order), { id })).status, 503, String(webhookSecret));
  }
  await writeBillingConfig(ctx, billingConfig());
  const processed = await sendWebhook(ctx, event('order.paid', order), { id });
  assert.equal(processed.status, 200, processed.text);
  assert.deepEqual(processed.json, { ok: true });
  const cookie = await signIn(ctx, ALICE);
  assert.equal(await balanceOf(ctx, cookie), 70);
});

test('webhook: 404 when config.json has no polar block, and when billing is off', async t => {
  const ctx = await setup(t, { billing: billingConfig({ polar: null }) });
  const pack = creditPack(ctx, 70);
  const withoutPolar = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)));
  assert.equal(withoutPolar.status, 404, withoutPolar.text);
  await fs.rm(path.join(ctx.dataDir, 'billing', 'config.json'));
  const disabled = await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)));
  assert.equal(disabled.status, 404, disabled.text);
  assert.equal((await request(ctx.port, '/api/billing', { cookie: await signIn(ctx, ALICE) })).json.enabled, false);
});

// --- orders -> credits ---------------------------------------------------------

function sync(ctx, cookie, body = {}) {
  return post(ctx, '/api/billing/sync', body, { cookie });
}

test('orders: a paid order grants once across order.paid, order.updated, a duplicate delivery and syncs', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 250);
  const cookie = await customer(ctx, ALICE);
  const { checkoutId, order } = await buy(ctx, cookie, pack.id);
  assert.equal(order.billing_reason, 'purchase');
  assert.equal(await balanceOf(ctx, cookie), 250);
  assert.ok(ctx.logs.includes(`[billing] order ${order.id} +250 credits to ${ALICE.email}`), ctx.logs.join('\n'));

  assert.deepEqual((await sendWebhook(ctx, event('order.updated', ctx.polar.orders.get(order.id)))).json, { ok: true });
  const id = nextWebhookId();
  const polarCallsBefore = ctx.polar.requests.length;
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', order), { id })).json, { ok: true });
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', order), { id })).json, { ok: true, duplicate: true });
  assert.equal(ctx.polar.requests.length, polarCallsBefore, 'the webhook makes no Polar call');
  let response = await sync(ctx, cookie, { checkoutId });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { balance: 250, applied: 0, checkout: { status: 'succeeded', granted: 250 } });
  response = await sync(ctx, cookie);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { balance: 250, applied: 0, checkout: null });

  const { balance, history } = await billingOf(ctx, cookie);
  assert.equal(balance, 250);
  assert.equal(history.length, 1);
  assert.deepEqual(Object.keys(history[0]).sort(), ['at', 'delta', 'id', 'kind', 'label']);
  assert.equal(history[0].kind, 'grant');
  assert.equal(history[0].delta, 250);
  assert.equal(history[0].at, new Date(START).toISOString());
  assert.equal(typeof history[0].label, 'string');
  const entries = await entriesFor(ctx, order.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sub, ALICE.sub);
  assertNoSecretsLogged(ctx);
});

test('orders: only paid orders grant (paid flag or a paid/refunded status)', async t => {
  const ctx = await setup(t);
  const cookie = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 20);
  const pending = paidOrderFor(pack, ALICE, { status: 'pending', paid: false });
  assert.deepEqual((await sendWebhook(ctx, event('order.updated', pending))).json, { ok: true });
  assert.equal(await balanceOf(ctx, cookie), 0, 'a pending order grants nothing');
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', { ...pending, status: 'paid', paid: true }))).json, { ok: true });
  assert.equal(await balanceOf(ctx, cookie), 20);
  // paid status without the flag, and the flag without a status, both count.
  await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE, { paid: false, status: 'paid' })));
  await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE, { paid: true, status: 'pending' })));
  assert.equal(await balanceOf(ctx, cookie), 60);
  // Seen for the first time already partially refunded: granted, then the refunded share revoked.
  await sendWebhook(ctx, event('order.refunded', paidOrderFor(pack, ALICE, { paid: false, status: 'partially_refunded', refunded_amount: 500 })));
  assert.equal(await balanceOf(ctx, cookie), 70);
  // An order that is not paid at all.
  await sendWebhook(ctx, event('order.updated', paidOrderFor(pack, ALICE, { paid: false, status: 'void' })));
  assert.equal(await balanceOf(ctx, cookie), 70);
});

test('orders: units multiply the credits, renewals grant again, plan changes grant nothing', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 100);
  const plan = subscription(ctx, 500);
  const cookie = await customer(ctx, ALICE);
  const { order: three } = await buy(ctx, cookie, pack.id, { units: 3 });
  assert.equal(three.units, 3);
  assert.equal(await balanceOf(ctx, cookie), 300);
  for (const units of [0, 1, null, undefined]) {
    await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE, { units })));
  }
  assert.equal(await balanceOf(ctx, cookie), 700, 'units 0, 1 or missing count once');

  const { order: first } = await buy(ctx, cookie, plan.id);
  assert.equal(first.billing_reason, 'subscription_create');
  assert.equal(await balanceOf(ctx, cookie), 1200);
  const renewal = await ctx.polar.renew(first.id);
  assert.equal(renewal.billing_reason, 'subscription_cycle');
  assert.equal(await balanceOf(ctx, cookie), 1700);
  await ctx.polar.renew(first.id);
  assert.equal(await balanceOf(ctx, cookie), 2200);
  // The same renewal again is still one grant.
  await sendWebhook(ctx, event('order.updated', ctx.polar.orders.get(renewal.id)));
  assert.equal(await balanceOf(ctx, cookie), 2200);

  for (const reason of ['subscription_update', 'subscription_meter_cycle']) {
    const change = paidOrderFor(plan, ALICE, { billing_reason: reason, subscription_id: first.subscription_id });
    assert.deepEqual((await sendWebhook(ctx, event('order.paid', change))).json, { ok: true }, reason);
    assert.equal(await balanceOf(ctx, cookie), 2200, `${reason} grants nothing`);
    // Refunding it later has nothing to take back either.
    await sendWebhook(ctx, event('order.refunded', { ...change, status: 'refunded', refunded_amount: change.net_amount }));
    assert.equal(await balanceOf(ctx, cookie), 2200, `${reason} refund revokes nothing`);
  }
  // An order for a product without credits (sold some other way) grants nothing.
  const shirt = { id: crypto.randomUUID(), name: 'T-shirt', is_recurring: false, metadata: {} };
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', paidOrderFor(shirt, ALICE)))).json, { ok: true });
  assert.equal(await balanceOf(ctx, cookie), 2200);
});

test('orders: refunds revoke monotonically, partial refunds rounded up; a full refund or void takes all', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 333, { price: 1000 });
  const other = creditPack(ctx, 90, { price: 700 });
  const cookie = await customer(ctx, ALICE);
  const { order } = await buy(ctx, cookie, pack.id);
  assert.equal(order.net_amount, 1000);
  assert.equal(await balanceOf(ctx, cookie), 333);

  const steps = [
    [100, 333 - 34], // ceil(333 * 100 / 1000) = ceil(33.3) = 34
    [1, 333 - 34], // ceil(333 * 101 / 1000) = ceil(33.633) = 34: nothing more
    [399, 333 - 167], // ceil(333 * 500 / 1000) = ceil(166.5) = 167
  ];
  for (const [cents, balance] of steps) {
    const refunded = await ctx.polar.refund(order.id, cents);
    assert.equal(refunded.status, 'partially_refunded');
    assert.equal(await balanceOf(ctx, cookie), balance, `after refunding ${refunded.refunded_amount} cents`);
  }
  // An older state arriving late never gives revoked credits back.
  const stale = { ...ctx.polar.orders.get(order.id), status: 'partially_refunded', refunded_amount: 100 };
  await sendWebhook(ctx, event('order.updated', stale));
  await sendWebhook(ctx, event('order.updated', { ...stale, status: 'paid', refunded_amount: 0 }));
  assert.equal(await balanceOf(ctx, cookie), 166);
  const full = await ctx.polar.refund(order.id, null);
  assert.equal(full.status, 'refunded');
  assert.equal(await balanceOf(ctx, cookie), 0);
  // Refunded again: nothing further.
  await sendWebhook(ctx, event('order.refunded', ctx.polar.orders.get(order.id)));
  assert.equal(await balanceOf(ctx, cookie), 0);
  const kinds = (await billingOf(ctx, cookie)).history.map(entry => [entry.kind, entry.delta]);
  assert.deepEqual(kinds, [['revoke', -166], ['revoke', -133], ['revoke', -34], ['grant', 333]], 'history newest first');

  // A full refund in one go, and a voided order.
  const { order: refundedAtOnce } = await buy(ctx, cookie, other.id);
  assert.equal(await balanceOf(ctx, cookie), 90);
  await ctx.polar.refund(refundedAtOnce.id, null);
  assert.equal(await balanceOf(ctx, cookie), 0);
  const { order: voided } = await buy(ctx, cookie, other.id);
  assert.equal(await balanceOf(ctx, cookie), 90);
  await sendWebhook(ctx, event('order.updated', { ...ctx.polar.orders.get(voided.id), status: 'void' }));
  assert.equal(await balanceOf(ctx, cookie), 0);
});

test('orders: the owner is metadata.virtually_user, then customer.external_id, then a unique email, else unclaimed', async t => {
  const ctx = await setup(t);
  const alice = await customer(ctx, ALICE);
  const bob = await customer(ctx, BOB);
  const pack = creditPack(ctx, 10);
  const deliver = async fields => {
    const order = craftOrder(pack, fields);
    const response = await sendWebhook(ctx, event('order.paid', order));
    assert.equal(response.status, 200, response.text);
    return order;
  };

  // (1) metadata beats external_id and email.
  await deliver({ metadata: { virtually_user: ALICE.sub }, customer: { external_id: `google:${BOB.sub}`, email: BOB.email } });
  // (2) external_id beats email.
  await deliver({ customer: { external_id: `google:${BOB.sub}`, email: ALICE.email } });
  // (3) the email, case-insensitively, of exactly one ledger user; an external id of another form is no owner.
  await deliver({ customer: { external_id: null, email: 'Alice@Example.COM' } });
  await deliver({ customer: { external_id: 'crm:bob', email: BOB.email } });
  assert.equal(await balanceOf(ctx, alice), 20);
  assert.equal(await balanceOf(ctx, bob), 20);

  // (4) nobody in the ledger has the email: unclaimed until that email opens the billing page.
  const unclaimed = await deliver({ customer: { external_id: null, email: 'Carol@Example.com' } });
  assert.deepEqual(await entriesFor(ctx, unclaimed.id), [], 'not credited to anyone yet');
  // Refunded while unclaimed: the claim applies the latest state.
  const refundedWhileUnclaimed = craftOrder(pack, { customer: { external_id: null, email: CAROL.email } });
  await sendWebhook(ctx, event('order.paid', refundedWhileUnclaimed));
  await sendWebhook(ctx, event('order.refunded', { ...refundedWhileUnclaimed, status: 'refunded', refunded_amount: 1000 }));
  assert.equal(await balanceOf(ctx, alice), 20);
  assert.equal(await balanceOf(ctx, bob), 20);
  const carol = await signIn(ctx, CAROL);
  assert.equal(await balanceOf(ctx, carol), 10, 'claimed on GET /api/billing');
  assert.ok((await entriesFor(ctx, unclaimed.id)).every(entry => entry.sub === CAROL.sub));
  assert.equal(await balanceOf(ctx, carol), 10, 'claimed once');

  // Two ledger users share an email: the email names no single owner.
  await customer(ctx, { sub: '555555555555555555551', email: 'shared@example.com', name: 'Twin A' });
  await customer(ctx, { sub: '555555555555555555552', email: 'shared@example.com', name: 'Twin B' });
  const ambiguous = await deliver({ customer: { external_id: null, email: 'shared@example.com' } });
  assert.deepEqual(await entriesFor(ctx, ambiguous.id), [], 'an email two users share credits nobody at once');
  assert.equal(await balanceOf(ctx, alice), 20);
  assert.equal(await balanceOf(ctx, bob), 20);
});

test('orders: foreign users are never credited', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 45);
  const alice = await customer(ctx, ALICE);
  const bob = await customer(ctx, BOB);
  const { checkoutId } = await buy(ctx, bob, pack.id);
  assert.equal(await balanceOf(ctx, bob), 45);
  assert.equal(await balanceOf(ctx, alice), 0);
  // Alice can neither sync Bob's checkout nor find Bob's orders with a full sync.
  assert.equal((await sync(ctx, alice, { checkoutId })).status, 404);
  const full = await sync(ctx, alice);
  assert.equal(full.status, 200, full.text);
  assert.deepEqual(full.json, { balance: 0, applied: 0, checkout: null });
  // Bob's order with Alice's email on the Polar customer stays Bob's.
  await sendWebhook(ctx, event('order.paid', craftOrder(pack, {
    metadata: { virtually_user: BOB.sub }, customer: { email: ALICE.email, external_id: null },
  })));
  // A user this app never saw is not Alice either.
  await sendWebhook(ctx, event('order.paid', craftOrder(pack, { metadata: { virtually_user: '999999999999999999999' }, customer: { email: 'eve@example.com' } })));
  assert.equal(await balanceOf(ctx, alice), 0);
  assert.equal(await balanceOf(ctx, bob), 90);
  // An unclaimed order for another address is not claimed by Alice's billing page.
  const other = craftOrder(pack, { customer: { email: 'dave@example.com', external_id: null } });
  await sendWebhook(ctx, event('order.paid', other));
  assert.equal(await balanceOf(ctx, alice), 0);
  assert.deepEqual(await entriesFor(ctx, other.id), []);
});

// --- GET /api/billing: credit products -------------------------------------------

function productView(product, credits, price, { recurring = false, interval = null } = {}) {
  return {
    id: product.id, name: product.name, description: product.description ?? null, credits, recurring, interval, price,
  };
}

test('products: only credit products are listed, with their price shape, one-time packs first, then credits ascending', async t => {
  const ctx = await setup(t);
  const add = fields => ctx.polar.addProduct(fields);
  const usd = amount => ({ type: 'fixed', amount, currency: 'usd' });
  const listed = [];
  // One-time packs, added out of order.
  const pack100 = add({ name: '크레딧 100', description: '기본 팩', metadata: { virtually_credits: 100 }, prices: [fixedPrice(1000)] });
  const digits500 = add({ name: '크레딧 500', metadata: { virtually_credits: '500' }, prices: [fixedPrice(4000)] });
  const custom = add({
    name: '원하는 만큼', metadata: { virtually_credits: 200 },
    prices: [{ id: crypto.randomUUID(), amount_type: 'custom', preset_amount: 2500, minimum_amount: 500, maximum_amount: null, price_currency: 'eur', is_archived: false, type: 'one_time' }],
  });
  const customNoPreset = add({
    name: '원하는 만큼 (기본값 없음)', metadata: { virtually_credits: 300 },
    prices: [{ id: crypto.randomUUID(), amount_type: 'custom', preset_amount: null, minimum_amount: 500, maximum_amount: null, price_currency: 'usd', is_archived: false, type: 'one_time' }],
  });
  const free = add({
    name: '체험', metadata: { virtually_credits: 10 },
    prices: [{ id: crypto.randomUUID(), amount_type: 'free', price_currency: 'usd', is_archived: false, type: 'one_time' }],
  });
  const secondPrice = add({ name: '크레딧 150', metadata: { virtually_credits: 150 }, prices: [fixedPrice(500, 'usd', { is_archived: true }), fixedPrice(700)] });
  const hidden = add({ name: '비공개 팩', visibility: 'private', metadata: { virtually_credits: 50 }, prices: [fixedPrice(450)] });
  const padded = add({ name: '크레딧 70', metadata: { virtually_credits: '0070' }, prices: [fixedPrice(650)] });
  const largest = add({ name: '최대', metadata: { virtually_credits: 10000000 }, prices: [fixedPrice(9000000)] });
  // Subscriptions, listed after every one-time pack.
  const yearly = subscription(ctx, 1000, { price: 9000, interval: 'year' });
  const monthly = subscription(ctx, 30, { price: 500, interval: 'month', description: '매달 30 크레딧' });
  listed.push(
    productView(free, 10, { type: 'free', amount: 0, currency: 'usd' }),
    productView(hidden, 50, usd(450)),
    productView(padded, 70, usd(650)),
    productView(pack100, 100, usd(1000)),
    productView(secondPrice, 150, usd(700)),
    productView(custom, 200, { type: 'custom', amount: 2500, currency: 'eur' }),
    productView(customNoPreset, 300, { type: 'custom', amount: null, currency: 'usd' }),
    productView(digits500, 500, usd(4000)),
    productView(largest, 10000000, usd(9000000)),
    productView(monthly, 30, usd(500), { recurring: true, interval: 'month' }),
    productView(yearly, 1000, usd(9000), { recurring: true, interval: 'year' }),
  );
  // Not credit products, or not for sale.
  add({ name: 'archived', is_archived: true, metadata: { virtually_credits: 100 } });
  add({ name: 'draft', visibility: 'draft', metadata: { virtually_credits: 100 } });
  add({ name: 'T-shirt' });
  for (const value of [0, -5, 12.5, 'abc', '', '1e3', ' 100', '12.5', 10000001, '10000001', true, null, { n: 1 }, [100]]) {
    add({ name: `bad ${JSON.stringify(value)}`, metadata: { virtually_credits: value } });
  }
  add({ name: 'other key', metadata: { credits: 100 } });
  add({
    name: 'metered', metadata: { virtually_credits: 100 },
    prices: [{ id: crypto.randomUUID(), amount_type: 'metered_unit', unit_amount: '0.5', price_currency: 'usd', is_archived: false, type: 'recurring' }],
  });
  add({
    name: 'seats', metadata: { virtually_credits: 100 },
    prices: [{ id: crypto.randomUUID(), amount_type: 'seat_based', price_currency: 'usd', is_archived: false, type: 'one_time' }],
  });

  const cookie = await signIn(ctx, ALICE);
  const state = await billingOf(ctx, cookie);
  assert.equal(state.enabled, true);
  assert.equal(state.mode, 'enabled');
  assert.equal(state.server, 'sandbox');
  assert.equal(state.polar, true);
  assert.equal(state.productsError, null);
  assert.deepEqual(state.products, listed);
  const calls = polarCalls(ctx, 'GET', '/v1/products/');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.is_archived, 'false');
  assert.equal(calls[0].query.limit, '100');
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers['polar-version'], '2026-10');
  assert.equal(calls[0].headers.accept, 'application/json');
});

test('products: the list is cached for 60 s', async t => {
  const ctx = await setup(t);
  const first = creditPack(ctx, 100);
  const cookie = await signIn(ctx, ALICE);
  assert.deepEqual((await billingOf(ctx, cookie)).products.map(product => product.id), [first.id]);
  const second = creditPack(ctx, 200);
  ctx.clock.advance(59 * 1000);
  assert.deepEqual((await billingOf(ctx, cookie)).products.map(product => product.id), [first.id], 'still cached after 59 s');
  assert.equal(polarCalls(ctx, 'GET', '/v1/products/').length, 1);
  ctx.clock.advance(1001);
  assert.deepEqual((await billingOf(ctx, cookie)).products.map(product => product.id), [first.id, second.id], 'refreshed after 60 s');
  assert.equal(polarCalls(ctx, 'GET', '/v1/products/').length, 2);
  // Every signed-in user shares the cached list.
  const bob = await signIn(ctx, BOB);
  assert.equal((await billingOf(ctx, bob)).products.length, 2);
  assert.equal(polarCalls(ctx, 'GET', '/v1/products/').length, 2);
});

test('products: a Polar failure keeps the last good list and names the failure', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 100);
  const cookie = await signIn(ctx, ALICE);
  const later = () => ctx.clock.advance(61 * 1000);

  ctx.polar.fail('unauthorized');
  let state = await billingOf(ctx, cookie);
  assert.deepEqual([state.products, state.productsError], [[], 'polar_unauthorized'], 'no good list yet');
  assert.equal(state.balance, 0);

  ctx.polar.fail(null);
  later();
  state = await billingOf(ctx, cookie);
  assert.deepEqual([state.products.map(product => product.id), state.productsError], [[pack.id], null]);

  for (const [kind, error] of [['unauthorized', 'polar_unauthorized'], ['forbidden', 'polar_unauthorized'], ['down', 'polar_unreachable'], ['server_error', 'polar_unreachable']]) {
    ctx.polar.fail(kind);
    later();
    state = await billingOf(ctx, cookie);
    assert.equal(state.productsError, error, kind);
    assert.deepEqual(state.products.map(product => product.id), [pack.id], `${kind}: the last good list`);
  }
  ctx.polar.fail(null);
  later();
  state = await billingOf(ctx, cookie);
  assert.equal(state.productsError, null);
  assert.deepEqual(state.products.map(product => product.id), [pack.id]);
});

// --- POST /api/billing/checkout ------------------------------------------------------

function lastCall(ctx, method, pathname) {
  const calls = polarCalls(ctx, method, pathname);
  assert.ok(calls.length, `a ${method} ${pathname} request reached Polar`);
  return calls[calls.length - 1];
}

function assertPolarHeaders(call, { apiVersion = '2026-10' } = {}) {
  const label = `${call.method} ${call.path}`;
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`, label);
  assert.equal(call.headers['polar-version'], apiVersion, label);
  assert.equal(call.headers.accept, 'application/json', label);
  if (call.method === 'POST') assert.match(String(call.headers['content-type']), /^application\/json/, label);
}

test('checkout: Polar gets the contract body and headers, and the success URL keeps a literal {CHECKOUT_ID}', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 100);
  const cookie = await customer(ctx, ALICE);
  const response = await post(ctx, '/api/billing/checkout', { productId: pack.id }, { cookie });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(Object.keys(response.json), ['url']);
  const checkoutId = checkoutIdOf(response.json.url);
  assert.equal(response.json.url, `${ctx.polar.origin}/checkout/${checkoutId}`);

  const call = lastCall(ctx, 'POST', '/v1/checkouts/');
  assert.deepEqual(call.body, {
    products: [pack.id],
    external_customer_id: `google:${ALICE.sub}`,
    customer_email: ALICE.email,
    customer_name: ALICE.name,
    metadata: { virtually_user: ALICE.sub, virtually_email: ALICE.email },
    success_url: `${ctx.origin}/billing?checkout_id={CHECKOUT_ID}`,
    return_url: `${ctx.origin}/billing`,
  });
  assertPolarHeaders(call);
  assert.ok(ctx.logs.includes(`[billing] checkout ${checkoutId} created for ${ALICE.email}`), ctx.logs.join('\n'));

  // The hosted page pays and sends the browser back with the real id in place of the placeholder.
  const hosted = await request(Number(new URL(ctx.polar.origin).port), `/checkout/${checkoutId}`);
  assert.equal(hosted.status, 302);
  assert.equal(hosted.headers.location, `${ctx.origin}/billing?checkout_id=${checkoutId}`);
  assert.equal(await balanceOf(ctx, cookie), 100);
  assertNoSecretsLogged(ctx);
});

test('checkout: no name -> no customer_name; publicUrl -> https return URLs and a public forwarded IP only', async t => {
  const ctx = await setup(t, { auth: authConfig({ publicUrl: `https://${PUBLIC_HOST}` }) });
  const pack = creditPack(ctx, 100);
  const cookie = await customer(ctx, { sub: '444444444444444444444', email: 'noname@example.com' });

  await startCheckout(ctx, cookie, pack.id);
  let call = lastCall(ctx, 'POST', '/v1/checkouts/');
  assert.equal('customer_name' in call.body, false, 'no name, no customer_name');
  assert.equal('customer_ip_address' in call.body, false, 'a loopback socket is no customer address');
  assert.equal(call.body.success_url, `${ctx.origin}/billing?checkout_id={CHECKOUT_ID}`);

  const viaPublic = { Host: PUBLIC_HOST, 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' };
  await startCheckout(ctx, cookie, pack.id, viaPublic);
  call = lastCall(ctx, 'POST', '/v1/checkouts/');
  assert.equal(call.body.customer_ip_address, '203.0.113.7', 'the first forwarded entry');
  assert.equal(call.body.success_url, `https://${PUBLIC_HOST}/billing?checkout_id={CHECKOUT_ID}`);
  assert.equal(call.body.return_url, `https://${PUBLIC_HOST}/billing`);

  for (const forwarded of ['10.0.0.5', '172.16.3.4', '192.168.1.20', '127.0.0.1', '169.254.10.1', '::1', 'fe80::1', 'fd12:3456::1', 'not-an-ip', '']) {
    await startCheckout(ctx, cookie, pack.id, { Host: PUBLIC_HOST, 'X-Forwarded-For': forwarded });
    assert.equal('customer_ip_address' in lastCall(ctx, 'POST', '/v1/checkouts/').body, false, JSON.stringify(forwarded));
  }
  // On the loopback host the socket counts, not a forwarded header.
  await startCheckout(ctx, cookie, pack.id, { 'X-Forwarded-For': '203.0.113.7' });
  call = lastCall(ctx, 'POST', '/v1/checkouts/');
  assert.equal('customer_ip_address' in call.body, false);
  assert.equal(call.body.return_url, `${ctx.origin}/billing`);
  // Another local Host name is used as given.
  await startCheckout(ctx, cookie, pack.id, { Host: `localhost:${ctx.port}` });
  call = lastCall(ctx, 'POST', '/v1/checkouts/');
  assert.equal(call.body.success_url, `http://localhost:${ctx.port}/billing?checkout_id={CHECKOUT_ID}`);
  assert.equal(call.body.return_url, `http://localhost:${ctx.port}/billing`);
  // The customer portal returns to the same origin.
  await post(ctx, '/api/billing/portal', {}, { cookie, headers: { Host: PUBLIC_HOST } });
  assert.equal(lastCall(ctx, 'POST', '/v1/customer-sessions/').body.return_url, `https://${PUBLIC_HOST}/billing`);
});

test('checkout: products that are not listed are unknown_product without a Polar checkout; a Polar 422 is 502 polar_error', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 100);
  const draft = ctx.polar.addProduct({ name: 'draft', visibility: 'draft', metadata: { virtually_credits: 100 } });
  const plain = ctx.polar.addProduct({ name: 'T-shirt' });
  const archived = ctx.polar.addProduct({ name: 'old', is_archived: true, metadata: { virtually_credits: 100 } });
  const cookie = await customer(ctx, ALICE);

  for (const productId of [crypto.randomUUID(), draft.id, plain.id, archived.id]) {
    const response = await post(ctx, '/api/billing/checkout', { productId }, { cookie });
    assert.equal(response.status, 400, productId);
    assert.equal(response.json.code, 'unknown_product', productId);
  }
  for (const body of [{}, { productId: 42 }, { productId: '' }, { productId: null }, { productId: [pack.id] }]) {
    const response = await post(ctx, '/api/billing/checkout', body, { cookie });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.code, 'bad_request', JSON.stringify(body));
  }
  assert.equal(polarCalls(ctx, 'POST', '/v1/checkouts/').length, 0, 'Polar never saw those');
  assert.equal((await post(ctx, '/api/billing/checkout', { productId: pack.id })).status, 401, 'signed out');

  ctx.polar.fail('checkout_422');
  const failed = await post(ctx, '/api/billing/checkout', { productId: pack.id }, { cookie });
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.json.code, 'polar_error');
  assert.deepEqual(failed.json.detail, { polarStatus: 422 });
  assert.equal(typeof failed.json.error, 'string');
  // No answer at all is a polar_error too.
  ctx.polar.fail('down');
  const down = await post(ctx, '/api/billing/checkout', { productId: pack.id }, { cookie });
  assert.equal(down.status, 502, down.text);
  assert.equal(down.json.code, 'polar_error');
  assert.ok(down.json.detail && 'polarStatus' in down.json.detail, down.text);
  ctx.polar.fail(null);
  assert.equal((await post(ctx, '/api/billing/checkout', { productId: pack.id }, { cookie })).status, 200);
});

test('checkout, sync and portal: every Polar call carries the configured Polar-Version and the token', async t => {
  const ctx = await setup(t, { billing: billingConfig({ polar: { apiVersion: '2025-11' } }), webhooks: false });
  const pack = creditPack(ctx, 10);
  const cookie = await customer(ctx, ALICE);
  const { checkoutId } = await buy(ctx, cookie, pack.id);
  assert.equal((await sync(ctx, cookie, { checkoutId })).status, 200);
  assert.equal((await sync(ctx, cookie)).status, 200);
  assert.equal((await post(ctx, '/api/billing/portal', {}, { cookie })).status, 200);
  const paths = new Set(ctx.polar.requests.map(call => `${call.method} ${call.path}`));
  for (const expected of ['GET /v1/products/', 'POST /v1/checkouts/', `GET /v1/checkouts/${checkoutId}`, 'GET /v1/orders/', 'POST /v1/customer-sessions/']) {
    assert.ok(paths.has(expected), expected);
  }
  for (const call of ctx.polar.requests) assertPolarHeaders(call, { apiVersion: '2025-11' });
  assertNoSecretsLogged(ctx);
});

// --- POST /api/billing/sync ------------------------------------------------------------

test('sync: a payment whose webhook never came is granted by syncing its checkout, once', async t => {
  const ctx = await setup(t, { webhooks: false });
  const pack = creditPack(ctx, 120);
  const cookie = await customer(ctx, ALICE);
  const checkoutId = await startCheckout(ctx, cookie, pack.id);

  let response = await sync(ctx, cookie, { checkoutId });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { balance: 0, applied: 0, checkout: { status: 'open', granted: 0 } }, 'not paid yet');

  const order = await ctx.polar.pay(checkoutId);
  assert.equal(await balanceOf(ctx, cookie), 0, 'no webhook: nothing until a sync');
  response = await sync(ctx, cookie, { checkoutId });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { balance: 120, applied: 1, checkout: { status: 'succeeded', granted: 120 } });
  assert.ok(polarCalls(ctx, 'GET', `/v1/checkouts/${checkoutId}`).length >= 1);
  const ordersCall = lastCall(ctx, 'GET', '/v1/orders/');
  assert.equal(ordersCall.query.checkout_id, checkoutId);
  assert.equal(ordersCall.query.limit, '100');

  response = await sync(ctx, cookie, { checkoutId });
  assert.deepEqual(response.json, { balance: 120, applied: 0, checkout: { status: 'succeeded', granted: 120 } });
  // The webhook arriving late changes nothing.
  ctx.polar.setWebhookUrl(ctx.webhookUrl);
  assert.equal(await ctx.polar.deliver('order.paid', ctx.polar.orders.get(order.id)), 200);
  assert.equal(await balanceOf(ctx, cookie), 120);
  assert.equal((await billingOf(ctx, cookie)).history.length, 1);
});

test('sync: granted counts a webhook\'s grant; a checkout that is not this user\'s is 404 checkout_missing', async t => {
  const ctx = await setup(t);
  const pack = creditPack(ctx, 80);
  const alice = await customer(ctx, ALICE);
  const bob = await customer(ctx, BOB);
  const { checkoutId } = await buy(ctx, alice, pack.id);
  let response = await sync(ctx, alice, { checkoutId });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { balance: 80, applied: 0, checkout: { status: 'succeeded', granted: 80 } });

  response = await sync(ctx, bob, { checkoutId });
  assert.equal(response.status, 404, response.text);
  assert.equal(response.json.code, 'checkout_missing');
  response = await sync(ctx, bob, { checkoutId: 'no_such_checkout' });
  assert.equal(response.status, 404, response.text);
  assert.equal(response.json.code, 'checkout_missing');
  assert.equal(await balanceOf(ctx, bob), 0);

  // Either marker names the owner: metadata.virtually_user or external_customer_id.
  const byExternalId = await startCheckout(ctx, bob, pack.id);
  ctx.polar.checkouts.get(byExternalId).metadata = {};
  response = await sync(ctx, bob, { checkoutId: byExternalId });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json.checkout, { status: 'open', granted: 0 });
  const byMetadata = await startCheckout(ctx, bob, pack.id);
  ctx.polar.checkouts.get(byMetadata).external_customer_id = null;
  response = await sync(ctx, bob, { checkoutId: byMetadata });
  assert.equal(response.status, 200, response.text);
  // Bob's checkout is not Alice's under either marker.
  assert.equal((await sync(ctx, alice, { checkoutId: byMetadata })).status, 404);
  assert.equal((await sync(ctx, alice, { checkoutId: byExternalId })).status, 404);
  // Paid by Bob, still never Alice's.
  await ctx.polar.pay(byExternalId);
  assert.equal((await sync(ctx, alice, { checkoutId: byExternalId })).status, 404);
  assert.equal(await balanceOf(ctx, alice), 80);
  assert.equal(await balanceOf(ctx, bob), 80);

  const before = ctx.polar.requests.length;
  for (const bad of ['../orders', 'a b', 'x'.repeat(101), 'id?x=1', 42, true, {}]) {
    response = await sync(ctx, alice, { checkoutId: bad });
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal(response.json.code, 'bad_request', JSON.stringify(bad));
  }
  assert.equal(ctx.polar.requests.length, before, 'malformed ids never reach Polar');
});

test('sync: a full sync reads every page of both order searches and applies each order once', async t => {
  const ctx = await setup(t, { webhooks: false, pageLimit: 2 });
  const pack = creditPack(ctx, 10);
  const alice = await customer(ctx, ALICE);
  const orders = [];
  for (let i = 0; i < 7; i += 1) orders.push((await buy(ctx, alice, pack.id)).order);
  // One order only the metadata search finds, one only the external id search finds.
  ctx.polar.orders.get(orders[0].id).customer.external_id = null;
  ctx.polar.orders.get(orders[1].id).metadata = {};
  const before = ctx.polar.requests.length;

  const response = await sync(ctx, alice);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { balance: 70, applied: 7, checkout: null });
  const calls = ctx.polar.requests.slice(before);
  assert.ok(calls.every(call => call.method === 'GET' && call.path === '/v1/orders/'), calls.map(call => call.path).join(', '));
  const pages = list => list.map(call => Number(call.query.page || 1)).sort((a, b) => a - b);
  const byMetadata = calls.filter(call => call.query['metadata[virtually_user]'] === ALICE.sub);
  const byExternal = calls.filter(call => call.query.external_customer_id === `google:${ALICE.sub}`);
  assert.deepEqual(pages(byMetadata), [1, 2, 3], 'six orders carry the metadata: three pages of two');
  assert.deepEqual(pages(byExternal), [1, 2, 3], 'six orders carry the external id: three pages of two');
  assert.equal(byMetadata.length + byExternal.length, calls.length);
  assert.ok(calls.every(call => call.query.limit === '100'));
  for (const order of orders) assert.equal((await entriesFor(ctx, order.id)).length, 1, `order ${order.id} granted once`);
});

test('sync: a full sync runs at most once per 5 s per user; inside the window Polar is not called', async t => {
  const ctx = await setup(t, { webhooks: false });
  const pack = creditPack(ctx, 10);
  const alice = await customer(ctx, ALICE);
  await buy(ctx, alice, pack.id);
  let response = await sync(ctx, alice);
  assert.deepEqual(response.json, { balance: 10, applied: 1, checkout: null });

  await buy(ctx, alice, pack.id);
  let mark = ctx.polar.requests.length;
  ctx.clock.advance(4999);
  response = await sync(ctx, alice);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { balance: 10, applied: 0, checkout: null });
  assert.equal(ctx.polar.requests.length, mark, 'no Polar request inside the window');
  // A checkout sync is not throttled.
  const checkoutId = await startCheckout(ctx, alice, pack.id);
  mark = ctx.polar.requests.length;
  assert.equal((await sync(ctx, alice, { checkoutId })).status, 200);
  assert.ok(ctx.polar.requests.length > mark);
  // Other users have their own window.
  const bob = await customer(ctx, BOB);
  mark = ctx.polar.requests.length;
  assert.deepEqual((await sync(ctx, bob)).json, { balance: 0, applied: 0, checkout: null });
  assert.ok(ctx.polar.requests.length > mark, 'Bob\'s first full sync asks Polar');

  ctx.clock.advance(2); // 5001 ms after Alice's full sync
  mark = ctx.polar.requests.length;
  response = await sync(ctx, alice);
  assert.deepEqual(response.json, { balance: 20, applied: 1, checkout: null });
  assert.ok(ctx.polar.requests.length > mark);
});

// --- POST /api/billing/portal ------------------------------------------------------------

test('portal: by customer_id once an order is applied, else by external id; no Polar customer -> 404 no_customer', async t => {
  const ctx = await setup(t, { webhooks: false });
  const pack = creditPack(ctx, 10);
  const alice = await customer(ctx, ALICE);
  const returnUrl = `${ctx.origin}/billing`;

  let response = await post(ctx, '/api/billing/portal', {}, { cookie: alice });
  assert.equal(response.status, 404, response.text);
  assert.equal(response.json.code, 'no_customer');
  let call = lastCall(ctx, 'POST', '/v1/customer-sessions/');
  assert.deepEqual(call.body, { external_customer_id: `google:${ALICE.sub}`, return_url: returnUrl });
  assertPolarHeaders(call);

  // Paid, but no order applied yet: Polar knows the customer by the external id.
  const { checkoutId, order } = await buy(ctx, alice, pack.id);
  assert.equal((await billingOf(ctx, alice)).canManage, false);
  response = await post(ctx, '/api/billing/portal', {}, { cookie: alice });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(Object.keys(response.json), ['url']);
  assert.ok(response.json.url.startsWith(`${ctx.polar.origin}/portal?customer_session_token=`), response.json.url);
  assert.deepEqual(lastCall(ctx, 'POST', '/v1/customer-sessions/').body, { external_customer_id: `google:${ALICE.sub}`, return_url: returnUrl });

  // After an applied order the customer id is known.
  assert.equal((await sync(ctx, alice, { checkoutId })).json.applied, 1);
  assert.equal((await billingOf(ctx, alice)).canManage, true);
  response = await post(ctx, '/api/billing/portal', {}, { cookie: alice });
  assert.equal(response.status, 200, response.text);
  call = lastCall(ctx, 'POST', '/v1/customer-sessions/');
  assert.deepEqual(call.body, { customer_id: order.customer_id, return_url: returnUrl });

  // A customer Polar no longer has.
  ctx.polar.customers.delete(order.customer_id);
  response = await post(ctx, '/api/billing/portal', {}, { cookie: alice });
  assert.equal(response.status, 404, response.text);
  assert.equal(response.json.code, 'no_customer');

  // The customer of the latest applied order is the one used.
  await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE, { customer: { id: 'cus_latest_order' } })));
  response = await post(ctx, '/api/billing/portal', {}, { cookie: alice });
  assert.deepEqual(lastCall(ctx, 'POST', '/v1/customer-sessions/').body, { customer_id: 'cus_latest_order', return_url: returnUrl });
  assert.equal(response.json.code, 'no_customer', 'Polar does not know that customer (422)');
});

// --- Polar left out of config.json --------------------------------------------------------

test('polar absent: billing is on without Polar; checkout, sync and portal are 409 polar_disabled', async t => {
  const ctx = await setup(t, { billing: billingConfig({ polar: null }) });
  creditPack(ctx, 100);
  const alice = await signIn(ctx, ALICE);
  const state = await billingOf(ctx, alice);
  assert.equal(state.enabled, true);
  assert.equal(state.mode, 'enabled');
  assert.equal(state.problem, null);
  assert.equal(state.polar, false);
  assert.deepEqual(state.products, []);
  assert.equal(state.productsError, null);
  assert.equal(state.canManage, false);
  assert.equal(state.balance, 0);

  for (const [pathname, body] of [
    ['/api/billing/checkout', { productId: 'prod_1' }],
    ['/api/billing/sync', {}],
    ['/api/billing/sync', { checkoutId: 'chk_1' }],
    ['/api/billing/portal', {}],
  ]) {
    const response = await post(ctx, pathname, body, { cookie: alice });
    assert.equal(response.status, 409, `${pathname} ${JSON.stringify(body)}: ${response.text}`);
    assert.equal(response.json.code, 'polar_disabled', pathname);
  }
  assert.equal((await sendWebhook(ctx, event('order.paid', paidOrderFor({ id: 'p', name: 'p', metadata: { virtually_credits: 5 } }, ALICE)))).status, 404);
  assert.equal(ctx.polar.requests.length, 0, 'Polar is never called');

  // Polar added to the file: on again (hot reload).
  await writeBillingConfig(ctx, billingConfig());
  const on = await billingOf(ctx, alice);
  assert.equal(on.polar, true);
  assert.equal(on.products.length, 1);
});

// --- a refund can leave the balance negative, which blocks paid jobs -----------------------

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function ffmpegAvailable() {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: 'ignore' });
}

// A paid route on the local mock provider (no network): $0.10/s, at least 10 s,
// so any short driving video costs $1.00 = 100 credits at 100 credits per USD.
const PRICED_ROUTE = {
  id: 'test/priced-mock',
  provider: 'mock',
  family: 'other',
  label: '유료 테스트 모델',
  endpoint: 'mock',
  fields: { image: 'image', video: 'video', prompt: 'prompt' },
  params: {},
  options: [{ key: 'delayMs', field: 'delayMs', label: '지연(ms)', values: [0, 60000], default: 0 }],
  limits: {
    videoMinSec: 1, videoMaxSec: 30, videoMaxSecByOrientation: null,
    imageMaxPx: 1920, imageMinPx: 64, aspectMin: 0.2, aspectMax: 5,
  },
  pricing: { usdPerSecond: 0.1, byOption: null, minSeconds: 10 },
  keepsImageBackground: true,
  verified: true,
};

async function waitForJob(ctx, cookie, id, states, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await request(ctx.port, `/api/animate/jobs/${id}`, { cookie })).json;
    if (job && states.includes(job.state)) return job;
    if (job && ['succeeded', 'failed', 'canceled'].includes(job.state)) {
      throw new Error(`job ${id} ended ${job.state}: ${JSON.stringify(job.error)}`);
    }
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job && job.state}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('orders: a full refund of spent credits leaves a negative balance, which blocks paid jobs', {
  skip: ffmpegAvailable() ? false : 'ffmpeg is not installed',
}, async t => {
  const ctx = await setup(t, {
    billing: billingConfig({ creditsPerUsd: 100 }),
    appOptions: { animateMock: true, animatePollIntervalMs: 40, animate: { customRoutes: [PRICED_ROUTE] } },
  });
  const pack = creditPack(ctx, 150);
  const alice = await customer(ctx, ALICE);
  const character = path.join(ctx.dataDir, 'fixture-character.png');
  const clip = path.join(ctx.dataDir, 'fixture-clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'", '-frames:v', '1', character]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
  const binary = { 'Content-Type': 'application/octet-stream' };
  let response = await request(ctx.port, '/api/characters?name=c&filename=c.png', { method: 'POST', cookie: alice, headers: binary, body: await fs.readFile(character) });
  assert.equal(response.status, 201, response.text);
  const photoId = response.json.character.basePhotoId;
  response = await request(ctx.port, '/api/animate/drivings?name=clip.mp4', { method: 'POST', cookie: alice, headers: binary, body: await fs.readFile(clip) });
  assert.equal(response.status, 201, response.text);
  const driving = response.json;
  const createJob = extra => post(ctx, '/api/animate/jobs', { drivingId: driving.id, photoId, routeId: PRICED_ROUTE.id, confirmed: true, ...extra }, { cookie: alice });

  const { order } = await buy(ctx, alice, pack.id);
  assert.equal(await balanceOf(ctx, alice), 150);
  // A paid job debits 100 and keeps running (its mock task finishes in 60 s).
  response = await createJob({ options: { delayMs: 60000 } });
  assert.equal(response.status, 202, response.text);
  const job = response.json.job;
  assert.equal(job.billing.credits, 100);
  assert.equal(job.billing.free, false);
  await waitForJob(ctx, alice, job.id, ['running']);
  assert.equal(await balanceOf(ctx, alice), 50);

  // The purchase is refunded in full: all 150 credits go, though 100 are spent.
  await ctx.polar.refund(order.id, null);
  assert.equal(await balanceOf(ctx, alice), -100);
  response = await createJob();
  assert.equal(response.status, 402, response.text);
  assert.equal(response.json.code, 'insufficient_credits');
  assert.deepEqual(response.json.detail, { needed: 100, balance: -100 });
  assert.equal(await balanceOf(ctx, alice), -100, 'nothing debited');

  // Another pack pays the debt off but does not cover a job yet.
  await buy(ctx, alice, pack.id);
  assert.equal(await balanceOf(ctx, alice), 50);
  response = await createJob();
  assert.equal(response.status, 402, response.text);
  assert.deepEqual(response.json.detail, { needed: 100, balance: 50 });
  assert.equal((await request(ctx.port, '/api/animate/jobs', { cookie: alice })).json.jobs.length, 1, 'no job was created');

  await post(ctx, `/api/animate/jobs/${job.id}/cancel`, {}, { cookie: alice });
});

// --- robustness ------------------------------------------------------------------------------

test('orders: a partial refund revokes at most the grant, and nothing while net_amount is 0', async t => {
  const ctx = await setup(t);
  const alice = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 333);
  // More refunded than the net amount (tax refunded too): capped at the credits granted.
  const over = paidOrderFor(pack, ALICE);
  await sendWebhook(ctx, event('order.paid', over));
  await sendWebhook(ctx, event('order.refunded', { ...over, status: 'partially_refunded', refunded_amount: 1500 }));
  assert.equal(await balanceOf(ctx, alice), 0);
  // A zero net amount: a partial refund takes nothing, a full refund everything.
  const zero = paidOrderFor(pack, ALICE, { subtotal_amount: 0, net_amount: 0, total_amount: 0 });
  await sendWebhook(ctx, event('order.paid', zero));
  await sendWebhook(ctx, event('order.refunded', { ...zero, status: 'partially_refunded', refunded_amount: 0 }));
  assert.equal(await balanceOf(ctx, alice), 333);
  await sendWebhook(ctx, event('order.refunded', { ...zero, status: 'refunded' }));
  assert.equal(await balanceOf(ctx, alice), 0);
});

test('orders: concurrent deliveries and syncs of one order grant it once', async t => {
  const ctx = await setup(t, { webhooks: false });
  const pack = creditPack(ctx, 55);
  const alice = await customer(ctx, ALICE);
  const { checkoutId, order } = await buy(ctx, alice, pack.id);
  const paid = ctx.polar.orders.get(order.id);
  const sameId = nextWebhookId();
  const results = await Promise.all([
    ...Array.from({ length: 4 }, () => sendWebhook(ctx, event('order.paid', paid))),
    sendWebhook(ctx, event('order.updated', paid), { id: sameId }),
    sendWebhook(ctx, event('order.updated', paid), { id: sameId }),
    sync(ctx, alice, { checkoutId }),
    sync(ctx, alice, { checkoutId }),
    sync(ctx, alice),
  ]);
  for (const response of results) assert.equal(response.status, 200, response.text);
  assert.equal(results.slice(4, 6).filter(response => response.json.duplicate === true).length, 1, 'one same-id delivery is the duplicate');
  assert.ok(results.slice(6).reduce((sum, response) => sum + response.json.applied, 0) <= 1);
  assert.equal(await balanceOf(ctx, alice), 55);
  assert.equal((await entriesFor(ctx, order.id)).length, 1);
});

test('webhook: handled ids, unclaimed orders and balances survive a restart', async t => {
  const ctx = await setup(t);
  const alice = await customer(ctx, ALICE);
  const pack = creditPack(ctx, 35);
  const order = paidOrderFor(pack, ALICE);
  const id = 'msg_survives_restart';
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', order), { id })).json, { ok: true });
  const unclaimed = craftOrder(pack, { customer: { email: CAROL.email, external_id: null } });
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', unclaimed))).json, { ok: true });

  await stopApp(ctx);
  await startApp(ctx);
  assert.deepEqual((await sendWebhook(ctx, event('order.paid', order), { id })).json, { ok: true, duplicate: true });
  assert.deepEqual((await sendWebhook(ctx, event('order.updated', order))).json, { ok: true });
  assert.equal(await balanceOf(ctx, alice), 35);
  const carol = await signIn(ctx, CAROL);
  assert.equal(await balanceOf(ctx, carol), 35);
});

test('checkout, sync and portal: 409 billing_disabled while billing is off, 503 billing_misconfigured while it is invalid', async t => {
  const ctx = await setup(t, { billing: null });
  const pack = creditPack(ctx, 10);
  const alice = await signIn(ctx, ALICE);
  const routes = [
    ['/api/billing/checkout', { productId: pack.id }],
    ['/api/billing/sync', {}],
    ['/api/billing/sync', { checkoutId: 'chk_1' }],
    ['/api/billing/portal', {}],
  ];
  for (const [pathname, body] of routes) {
    const response = await post(ctx, pathname, body, { cookie: alice });
    assert.equal(response.status, 409, `${pathname}: ${response.text}`);
    assert.equal(response.json.code, 'billing_disabled', pathname);
  }
  await writeBillingConfig(ctx, billingConfig({ polar: { apiVersion: 'v1' } }));
  for (const [pathname, body] of routes) {
    const response = await post(ctx, pathname, body, { cookie: alice });
    assert.equal(response.status, 503, `${pathname}: ${response.text}`);
    assert.equal(response.json.code, 'billing_misconfigured', pathname);
    assert.deepEqual(response.json.detail, { problem: 'bad_api_version' }, pathname);
  }
  // Login off: the Polar routes are locked (login_required), the webhook still takes payments.
  await writeBillingConfig(ctx, billingConfig());
  await fs.rm(path.join(ctx.dataDir, 'auth', 'config.json'));
  for (const [pathname, body] of routes) {
    const response = await post(ctx, pathname, body);
    assert.equal(response.status, 503, `${pathname}: ${response.text}`);
    assert.deepEqual(response.json.detail, { problem: 'login_required' }, pathname);
  }
  assert.equal(polarCalls(ctx, 'POST', '/v1/checkouts/').length + polarCalls(ctx, 'POST', '/v1/customer-sessions/').length, 0);
  assert.equal((await sendWebhook(ctx, event('order.paid', paidOrderFor(pack, ALICE)))).status, 200);
});
