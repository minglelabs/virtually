'use strict';

// Admin top-up (server): the three /api/billing/admin/* routes, pending
// credits for addresses that never signed in and their claiming (on the
// first billing request, and right before a job charge), deduct limits,
// requestId dedupe, the `by` audit kept out of user history, loginAllowed,
// and the ledger file itself.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');

const H = require('./helpers/billing-server');

const CAROL = Object.freeze({ sub: '200000000000000000004', email: 'carol@example.com', name: 'Carol Choi' });
const OUTSIDER = 'erin@other.org';

async function listUsers(ctx, cookie, q) {
  const response = await H.get(ctx, `/api/billing/admin/users${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`, cookie);
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function historyOf(ctx, cookie, email) {
  const response = await H.get(ctx, `/api/billing/admin/history?email=${encodeURIComponent(email)}`, cookie);
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function adjustOk(ctx, cookie, email, credits, extra) {
  const response = await H.adjust(ctx, cookie, email, credits, extra);
  assert.equal(response.status, 200, response.text);
  return response.json;
}

function assertBadField(response, field) {
  assert.equal(response.status, 400, response.text);
  assert.equal(response.json.code, 'bad_request', response.text);
  assert.deepEqual(response.json.detail, { field });
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('admin routes: session required, admins only (403 admin_only)', async t => {
  const ctx = await H.startApp(t);
  const routes = [
    ['GET', '/api/billing/admin/users'],
    ['GET', '/api/billing/admin/history?email=alice%40example.com'],
    ['POST', '/api/billing/admin/adjust'],
  ];
  for (const [method, route] of routes) {
    const response = await H.request(ctx, route, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 401, `${route} signed out`);
    assert.equal(response.json.code, 'auth_required');
  }
  const alice = await H.signIn(ctx, H.ALICE);
  for (const [method, route] of routes) {
    const body = method === 'POST' ? { email: H.BOB.email, credits: 100, requestId: H.newRequestId() } : undefined;
    const response = await H.request(ctx, route, { method, body, cookie: alice });
    assert.equal(response.status, 403, `${route}: ${response.text}`);
    assert.equal(response.json.code, 'admin_only');
  }
  // Nothing was added for the refused adjust.
  const admin = await H.signIn(ctx, H.ADMIN);
  assert.deepEqual((await historyOf(ctx, admin, H.BOB.email)).entries, []);
  assert.equal((await H.billingOf(ctx, alice)).isAdmin, false);
  assert.equal((await H.billingOf(ctx, admin)).isAdmin, true);
});

test('adjust validation: 400 bad_request naming the field, checked in order', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const send = body => H.post(ctx, '/api/billing/admin/adjust', body, admin);
  const good = { email: H.ALICE.email, credits: 1000, memo: '메모', requestId: 'request-0001' };
  assertBadField(await send({ ...good, email: undefined }), 'email');
  for (const email of ['', 'alice', '@example.com', 'alice@', 'a@b@example.com', 'al ice@example.com', 7, `${'a'.repeat(243)}@example.com`]) {
    assertBadField(await send({ ...good, email }), 'email');
  }
  for (const credits of [undefined, 0, 1.5, '1000', null, 100000001, -100000001, Number.MAX_SAFE_INTEGER]) {
    assertBadField(await send({ ...good, credits }), 'credits');
  }
  for (const memo of [5, ['memo'], 'm'.repeat(201)]) {
    assertBadField(await send({ ...good, memo }), 'memo');
  }
  for (const requestId of [undefined, 'short', 'has space 123', 'ünïcode-123', 'r'.repeat(101), 12345678]) {
    assertBadField(await send({ ...good, requestId }), 'requestId');
  }
  // Every field wrong: the first one is named.
  assertBadField(await send({ email: 'x', credits: 0, memo: 1, requestId: '' }), 'email');
  assertBadField(await send({ email: H.ALICE.email, credits: 0, memo: 1, requestId: '' }), 'credits');
  let response = await H.request(ctx, '/api/billing/admin/adjust', { method: 'POST', body: '{"email":', cookie: admin });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'bad_request');
  response = await H.request(ctx, '/api/billing/admin/adjust', { method: 'POST', body: '[]', cookie: admin });
  assert.equal(response.status, 400);
  response = await H.request(ctx, '/api/billing/admin/adjust', { method: 'POST', body: JSON.stringify(good), contentType: 'text/plain', cookie: admin });
  assert.equal(response.status, 400);
  // The limits themselves are fine: 100000000 either way, a 200-character memo, 8 and 100 character ids.
  await adjustOk(ctx, admin, H.ALICE.email, 100000000, { memo: 'm'.repeat(200), requestId: 'r'.repeat(100) });
  await adjustOk(ctx, admin, H.ALICE.email, -100000000, { requestId: 'Ab_-1234' });
  assertBadField(await H.get(ctx, '/api/billing/admin/history?email=nope', admin), 'email');
  assertBadField(await H.get(ctx, '/api/billing/admin/history', admin), 'email');
  assertBadField(await H.get(ctx, `/api/billing/admin/users?q=${'q'.repeat(101)}`, admin), 'q');
  assert.equal((await H.get(ctx, `/api/billing/admin/users?q=${'q'.repeat(100)}`, admin)).status, 200);
});

test('top-up and deduct a signed-in user: labels, kinds, balance, 409 insufficient_balance, log without memo', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  await H.billingOf(ctx, alice); // Alice is a ledger user now

  const memo = '  9/30 계좌이체 50,000원, 입금자 김앨리스  ';
  const topup = await adjustOk(ctx, admin, ` ${H.ALICE.email.toUpperCase()} `, 50000, { memo });
  assert.deepEqual(Object.keys(topup).sort(), ['entry', 'loginAllowed', 'user']);
  assert.deepEqual(topup.user, { email: H.ALICE.email, sub: H.ALICE.sub, balance: 50000, pending: false });
  assert.equal(topup.loginAllowed, true);
  assert.match(topup.entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(topup.entry.at, new Date(H.START).toISOString());
  assert.deepEqual({ ...topup.entry, id: null, at: null },
    { id: null, at: null, delta: 50000, kind: 'topup', label: '관리자 충전 · 9/30 계좌이체 50,000원, 입금자 김앨리스' });
  assert.ok(ctx.logs.includes(`[billing] admin ${H.ADMIN.email} topup ${H.ALICE.email} +50000`), ctx.logs.join('\n'));
  assert.ok(!ctx.logs.some(line => line.includes('입금자')), 'the memo never reaches the log');

  ctx.clock.advance(H.MINUTE);
  const deduct = await adjustOk(ctx, admin, H.ALICE.email, -20000);
  assert.deepEqual(deduct.user, { email: H.ALICE.email, sub: H.ALICE.sub, balance: 30000, pending: false });
  assert.equal(deduct.entry.kind, 'deduct');
  assert.equal(deduct.entry.delta, -20000);
  assert.equal(deduct.entry.label, '관리자 차감');
  assert.ok(ctx.logs.includes(`[billing] admin ${H.ADMIN.email} deduct ${H.ALICE.email} -20000`));
  // A blank memo adds nothing to the label.
  const blank = await adjustOk(ctx, admin, H.ALICE.email, 1, { memo: '   ' });
  assert.equal(blank.entry.label, '관리자 충전');
  await adjustOk(ctx, admin, H.ALICE.email, -1, { memo: null });

  let response = await H.adjust(ctx, admin, H.ALICE.email, -30001);
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.code, 'insufficient_balance');
  assert.deepEqual(response.json.detail, { balance: 30000 });
  // Deducting exactly the balance is allowed.
  assert.equal((await adjustOk(ctx, admin, H.ALICE.email, -30000)).user.balance, 0);
  response = await H.adjust(ctx, admin, H.ALICE.email, -1);
  assert.equal(response.status, 409);
  assert.deepEqual(response.json.detail, { balance: 0 });

  // The customer's own view: kinds topup/deduct, newest first, never `by`.
  const billing = await H.billingOf(ctx, alice);
  assert.equal(billing.balance, 0);
  assert.deepEqual(billing.history.map(entry => [entry.kind, entry.delta]),
    [['deduct', -30000], ['deduct', -1], ['topup', 1], ['deduct', -20000], ['topup', 50000]]);
  for (const entry of billing.history) assert.deepEqual(Object.keys(entry).sort(), ['at', 'delta', 'id', 'kind', 'label']);
  assert.equal(billing.history[4].id, topup.entry.id);
  assert.equal(billing.history[4].label, topup.entry.label);

  // The admin's view of the same account carries `by`.
  const history = await historyOf(ctx, admin, H.ALICE.email);
  assert.equal(history.email, H.ALICE.email);
  assert.equal(history.balance, 0);
  assert.equal(history.pending, false);
  assert.equal(history.entries.length, 5);
  assert.deepEqual(history.entries[4], { ...topup.entry, by: H.ADMIN.email });
  assert.ok(history.entries.every(entry => entry.by === H.ADMIN.email));
  // Stored in the ledger too, with the address and the dedupe key.
  const stored = (await H.readLedger(ctx)).entries.find(entry => entry.id === topup.entry.id);
  assert.equal(stored.by, H.ADMIN.email);
  assert.equal(stored.email, H.ALICE.email);
  assert.equal(stored.sub, H.ALICE.sub);
  assert.match(stored.requestId, /^req-/);
});

test('requestId dedupe: a repeated id returns the first result with duplicate: true and adds nothing', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  await H.billingOf(ctx, alice);
  const requestId = 'f7d2f0c4-6c1e-4d7e-9d3a-1b2c3d4e5f60';
  const first = await adjustOk(ctx, admin, H.ALICE.email, 5000, { requestId, memo: '첫 요청' });
  assert.equal(first.duplicate, undefined);
  ctx.clock.advance(H.MINUTE);
  // A retry of the same submit (say after a network error), even with other values.
  for (const body of [{ credits: 5000, memo: '첫 요청' }, { credits: 999 }, { credits: -5000 }]) {
    const again = await adjustOk(ctx, admin, H.ALICE.email, body.credits, { requestId, memo: body.memo });
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.entry, first.entry);
    assert.deepEqual(again.user, first.user);
  }
  assert.equal((await H.billingOf(ctx, alice)).balance, 5000);
  assert.equal((await historyOf(ctx, admin, H.ALICE.email)).entries.length, 1);
  assert.equal(ctx.logs.filter(line => line.startsWith('[billing] admin ')).length, 1, 'only the real change is logged');

  // A deduct retried after the balance moved is still the first result, not a 409.
  const deductId = 'deduct-request-1';
  const deduct = await adjustOk(ctx, admin, H.ALICE.email, -5000, { requestId: deductId });
  assert.equal(deduct.user.balance, 0);
  const retried = await adjustOk(ctx, admin, H.ALICE.email, -5000, { requestId: deductId });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.entry.id, deduct.entry.id);
  // A refused deduct uses up nothing: the same id works once the balance allows it.
  const laterId = 'deduct-request-2';
  assert.equal((await H.adjust(ctx, admin, H.ALICE.email, -10, { requestId: laterId })).status, 409);
  await adjustOk(ctx, admin, H.ALICE.email, 10);
  const later = await adjustOk(ctx, admin, H.ALICE.email, -10, { requestId: laterId });
  assert.equal(later.duplicate, undefined);
  assert.equal(later.user.balance, 0);
});

test('pending: credits for an address that never signed in wait, then move to it on its first billing request', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const topup = await adjustOk(ctx, admin, CAROL.email, 10000, { memo: '선입금' });
  assert.deepEqual(topup.user, { email: CAROL.email, sub: null, balance: 10000, pending: true });
  assert.equal(topup.loginAllowed, true);
  ctx.clock.advance(H.MINUTE);
  const deduct = await adjustOk(ctx, admin, CAROL.email, -4000);
  assert.deepEqual(deduct.user, { email: CAROL.email, sub: null, balance: 6000, pending: true });
  // The pending total is the limit for a deduct.
  const refused = await H.adjust(ctx, admin, CAROL.email, -6001);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json.detail, { balance: 6000 });

  let listed = await listUsers(ctx, admin);
  const pendingRow = listed.users.find(row => row.email === CAROL.email);
  assert.deepEqual(pendingRow, {
    email: CAROL.email, name: null, sub: null, balance: 6000, pending: true,
    lastAt: new Date(H.START + H.MINUTE).toISOString(), loginAllowed: true,
  });
  let history = await historyOf(ctx, admin, CAROL.email);
  assert.equal(history.pending, true);
  assert.equal(history.balance, 6000);
  assert.deepEqual(history.entries.map(entry => [entry.id, entry.delta, entry.by]),
    [[deduct.entry.id, -4000, H.ADMIN.email], [topup.entry.id, 10000, H.ADMIN.email]]);

  // Signing in is not a billing request; the first billing request claims.
  ctx.clock.advance(H.MINUTE);
  const carol = await H.signIn(ctx, { ...CAROL, email: 'Carol@Example.com' });
  const billing = await H.billingOf(ctx, carol);
  assert.equal(billing.balance, 6000);
  assert.deepEqual(billing.history, [
    { id: deduct.entry.id, at: deduct.entry.at, delta: -4000, kind: 'deduct', label: '관리자 차감' },
    { id: topup.entry.id, at: topup.entry.at, delta: 10000, kind: 'topup', label: '관리자 충전 · 선입금' },
  ]);
  assert.ok(ctx.logs.includes(`[billing] 2 pending admin entries claimed by ${CAROL.email}`), ctx.logs.join('\n'));

  listed = await listUsers(ctx, admin);
  const rows = listed.users.filter(row => row.email === CAROL.email);
  assert.deepEqual(rows, [{
    email: CAROL.email, name: CAROL.name, sub: CAROL.sub, balance: 6000, pending: false,
    lastAt: new Date(H.START + 2 * H.MINUTE).toISOString(), loginAllowed: true,
  }]);
  history = await historyOf(ctx, admin, CAROL.email);
  assert.equal(history.pending, false);
  assert.equal(history.entries.length, 2);
  // From now on a top-up goes straight to the account.
  const direct = await adjustOk(ctx, admin, CAROL.email, 500);
  assert.deepEqual(direct.user, { email: CAROL.email, sub: CAROL.sub, balance: 6500, pending: false });
  // An unknown address: nothing yet.
  assert.deepEqual(await historyOf(ctx, admin, 'nobody@example.com'), { email: 'nobody@example.com', balance: 0, pending: false, entries: [] });
});

test('claiming happens at the start of every signed-in billing request, admin and Polar routes too', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  await adjustOk(ctx, admin, H.ALICE.email, 700);
  await adjustOk(ctx, admin, H.BOB.email, 300);
  await adjustOk(ctx, admin, H.ADMIN.email, 100);
  // Refused requests still claim first: a 409 polar_disabled for Alice, a 403 admin_only for Bob.
  assert.equal((await H.post(ctx, '/api/billing/sync', {}, alice)).json.code, 'polar_disabled');
  assert.equal((await H.get(ctx, '/api/billing/admin/users', bob)).json.code, 'admin_only');
  // The admin's own pending credits move on its admin request.
  const listed = await listUsers(ctx, admin);
  const bySub = Object.fromEntries(listed.users.map(row => [row.sub, row]));
  assert.equal(bySub[H.ALICE.sub].balance, 700);
  assert.equal(bySub[H.BOB.sub].balance, 300);
  assert.equal(bySub[H.ADMIN.sub].balance, 100);
  assert.ok(listed.users.every(row => row.pending === false), JSON.stringify(listed.users));
  const ledger = await H.readLedger(ctx);
  assert.ok(ledger.entries.every(entry => entry.sub !== null), 'no pending entry left');
});

test('loginAllowed follows the CURRENT Google allowlist', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  let result = await adjustOk(ctx, admin, OUTSIDER, 20000);
  assert.equal(result.loginAllowed, false);
  assert.deepEqual(result.user, { email: OUTSIDER, sub: null, balance: 20000, pending: true });
  let row = (await listUsers(ctx, admin)).users.find(entry => entry.email === OUTSIDER);
  assert.equal(row.loginAllowed, false);
  // The operator adds the customer to data/auth/config.json: allowed at once.
  await H.setAuthConfig(ctx, H.authConfig({ allowedEmails: ['@example.com', OUTSIDER] }));
  row = (await listUsers(ctx, admin)).users.find(entry => entry.email === OUTSIDER);
  assert.equal(row.loginAllowed, true);
  result = await adjustOk(ctx, admin, OUTSIDER, 1);
  assert.equal(result.loginAllowed, true);
  assert.equal(ctx.server.auth.loginAllowed(OUTSIDER.toUpperCase()), true);
  assert.equal(ctx.server.auth.loginAllowed('someone@elsewhere.net'), false);
  // Login off: nobody can sign in (any request picks up the change).
  await H.setAuthConfig(ctx, null);
  await H.get(ctx, '/api/auth/status');
  assert.equal(ctx.server.auth.loginAllowed(H.ALICE.email), false);
});

// Stops the app, replaces the ledger file with `ledger`, starts again (same data dir, sessions kept).
async function withLedger(ctx, ledger) {
  await H.stopApp(ctx);
  await fs.mkdir(path.dirname(H.ledgerPath(ctx.dataDir)), { recursive: true });
  await fs.writeFile(H.ledgerPath(ctx.dataDir), JSON.stringify({ version: 1, entries: [], orders: {}, webhooks: {}, ...ledger }, null, 2));
  await H.restartApp(ctx);
}

const at = offsetMs => new Date(H.START + offsetMs).toISOString();

test('users list: every user and pending address, q on email or name, newest activity first, at most 500', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const users = {
    'sub-kim': { email: 'kim@example.com', name: 'Minji Kim', seenAt: at(-60 * H.MINUTE) },
    'sub-lee': { email: 'lee@example.com', name: 'Joon Lee', seenAt: at(-120 * H.MINUTE) },
    'sub-quiet': { email: 'quiet@example.com' },
    'sub-noemail': { email: null },
  };
  const entries = [
    // An entry newer than the last visit counts as activity.
    { id: 'e-1', at: at(-10 * H.MINUTE), sub: 'sub-lee', delta: 300, kind: 'topup', label: '관리자 충전', email: 'lee@example.com', by: H.ADMIN.email, requestId: 'seed-0001' },
    { id: 'e-2', at: at(-30 * H.MINUTE), sub: null, delta: 900, kind: 'topup', label: '관리자 충전', email: 'new@example.com', by: H.ADMIN.email, requestId: 'seed-0002' },
  ];
  await withLedger(ctx, { users, entries });
  let listed = await listUsers(ctx, admin);
  assert.equal(listed.creditsPerUsd, 2000);
  assert.deepEqual(listed.users.map(row => [row.email, row.lastAt]), [
    [H.ADMIN.email, at(0)],
    ['lee@example.com', at(-10 * H.MINUTE)],
    ['new@example.com', at(-30 * H.MINUTE)],
    ['kim@example.com', at(-60 * H.MINUTE)],
    ['quiet@example.com', null],
  ]);
  assert.deepEqual(listed.users[1], {
    email: 'lee@example.com', name: 'Joon Lee', sub: 'sub-lee', balance: 300, pending: false, lastAt: at(-10 * H.MINUTE), loginAllowed: true,
  });
  assert.deepEqual(listed.users[2], {
    email: 'new@example.com', name: null, sub: null, balance: 900, pending: true, lastAt: at(-30 * H.MINUTE), loginAllowed: true,
  });
  assert.deepEqual((await listUsers(ctx, admin, 'KIM')).users.map(row => row.email), ['kim@example.com'], 'name or email, any case');
  assert.deepEqual((await listUsers(ctx, admin, ' joon ')).users.map(row => row.email), ['lee@example.com']);
  assert.deepEqual((await listUsers(ctx, admin, 'new@')).users.map(row => row.email), ['new@example.com']);
  assert.deepEqual((await listUsers(ctx, admin, 'nothing-matches')).users, []);
  assert.equal((await listUsers(ctx, admin, '')).users.length, 5);

  const many = {};
  for (let i = 0; i < 505; i += 1) many[`sub-${i}`] = { email: `user${String(i).padStart(3, '0')}@example.com`, seenAt: at(-(i + 1) * 1000) };
  await withLedger(ctx, { users: many });
  listed = await listUsers(ctx, admin);
  assert.equal(listed.users.length, 500);
  assert.equal(listed.users[0].email, H.ADMIN.email);
  assert.equal(listed.users[1].email, 'user000@example.com');
  assert.equal(listed.users[499].email, 'user498@example.com');
});

test('history: newest first, at most 200; the target is the most recently seen user with that email', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const entries = [];
  for (let i = 0; i < 205; i += 1) {
    entries.push({ id: `e-${i}`, at: at(-(205 - i) * 1000), sub: 'sub-old', delta: 1, kind: 'grant', label: 'Polar order', orderId: `o-${i}` });
  }
  const users = {
    'sub-old': { email: 'twin@example.com', seenAt: at(-120 * H.MINUTE) },
    'sub-new': { email: 'twin@example.com', seenAt: at(-5 * H.MINUTE) },
  };
  await withLedger(ctx, { users, entries });
  // Two accounts with one address (say a re-created Google account): the one seen last wins.
  let history = await historyOf(ctx, admin, 'twin@example.com');
  assert.deepEqual(history, { email: 'twin@example.com', balance: 0, pending: false, entries: [] });
  const result = await adjustOk(ctx, admin, 'twin@example.com', 50);
  assert.deepEqual(result.user, { email: 'twin@example.com', sub: 'sub-new', balance: 50, pending: false });
  const rows = (await listUsers(ctx, admin, 'twin')).users;
  assert.deepEqual(rows.map(row => [row.sub, row.balance]), [['sub-new', 50], ['sub-old', 205]]);

  users['sub-old'].seenAt = at(-1 * H.MINUTE);
  await withLedger(ctx, { users, entries });
  history = await historyOf(ctx, admin, 'twin@example.com');
  assert.equal(history.balance, 205);
  assert.equal(history.entries.length, 200);
  assert.equal(history.entries[0].id, 'e-204');
  assert.equal(history.entries[199].id, 'e-5');
  assert.deepEqual(history.entries[0], { id: 'e-204', at: at(-1000), delta: 1, kind: 'grant', label: 'Polar order', by: null });
});

test('ledger: file 0600 in a 0700 directory, and credits survive a restart', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  await H.billingOf(ctx, alice);
  await adjustOk(ctx, admin, H.ALICE.email, 1234);
  await adjustOk(ctx, admin, CAROL.email, 99);
  const file = await fs.stat(H.ledgerPath(ctx.dataDir));
  const dir = await fs.stat(path.dirname(H.ledgerPath(ctx.dataDir)));
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(dir.mode & 0o777, 0o700);
  const leftovers = (await fs.readdir(path.dirname(H.ledgerPath(ctx.dataDir)))).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  await H.restartApp(ctx);
  assert.equal((await H.billingOf(ctx, alice)).balance, 1234);
  assert.equal((await historyOf(ctx, admin, CAROL.email)).balance, 99);
  // A touched user record keeps the Google name and when the user was last seen.
  const stored = (await H.readLedger(ctx)).users[H.ALICE.sub];
  assert.deepEqual(stored, { email: H.ALICE.email, name: H.ALICE.name, seenAt: at(0) });
});

test('pending credits are claimed right before a job charge (no billing request needed)', { skip: H.ffmpegSkip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const dave = { sub: '200000000000000000005', email: 'dave@example.com', name: 'Dave Jung' };
  const topup = await adjustOk(ctx, admin, dave.email, 1000, { memo: '계좌이체' });
  assert.equal(topup.user.pending, true);
  const cookie = await H.signIn(ctx, dave);
  const driving = await H.prepareInputs(ctx, cookie);
  const response = await H.createJob(ctx, cookie, driving.id, { options: H.LONG });
  assert.equal(response.status, 202, response.text);
  const { job } = response.json;
  assert.equal(job.billing.credits, H.JOB_CREDITS);
  assert.ok(ctx.logs.includes(`[billing] 1 pending admin entry claimed by ${dave.email}`), ctx.logs.join('\n'));
  assert.ok(ctx.logs.includes(`[billing] charge job ${job.id} -${H.JOB_CREDITS} ${dave.email}`));

  const history = await historyOf(ctx, admin, dave.email);
  assert.equal(history.pending, false);
  assert.equal(history.balance, 1000 - H.JOB_CREDITS);
  assert.deepEqual(history.entries.map(entry => [entry.kind, entry.delta, entry.by]),
    [['charge', -H.JOB_CREDITS, null], ['topup', 1000, H.ADMIN.email]]);
  const billing = await H.billingOf(ctx, cookie);
  assert.equal(billing.balance, 1000 - H.JOB_CREDITS);
  assert.equal(billing.history[1].id, topup.entry.id);

  // Stop the job before the test ends (canceled with a provider task: no refund).
  await H.waitForJob(ctx, cookie, job.id, view => view.state === 'running');
  assert.equal((await H.post(ctx, `/api/animate/jobs/${job.id}/cancel`, {}, cookie)).status, 200);
  await H.waitForJob(ctx, cookie, job.id, view => view.state === 'canceled');
});

const ADMIN_PAGE_READY = require('node:fs').existsSync(path.join(__dirname, '..', 'public', 'admin.html'));

test('/admin is a session page like /billing; /admin.css and /admin.js are public static files', {
  skip: ADMIN_PAGE_READY ? false : 'public/admin.html is not written yet',
}, async t => {
  const ctx = await H.startApp(t);
  let response = await H.get(ctx, '/admin');
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/login?next=%2Fadmin');
  for (const [file, type] of [['/admin.css', 'text/css; charset=utf-8'], ['/admin.js', 'text/javascript; charset=utf-8']]) {
    response = await H.get(ctx, file);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers['content-type'], type);
  }
  // Any signed-in user gets the page; the admin routes behind it decide (403 admin_only).
  const alice = await H.signIn(ctx, H.ALICE);
  response = await H.get(ctx, '/admin', alice);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(response.text, /admin\.js/);
});
