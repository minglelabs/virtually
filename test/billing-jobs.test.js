'use strict';

// Paid jobs (server): charges on POST /api/animate/jobs (402 / price_unknown /
// free accounts / parallel creates), refunds (failed; canceled by the provider;
// canceled by the user only before a provider task exists; never succeeded),
// 다시 받기 charges (a refunded job is charged again before its re-fetch, once),
// view.billing incl. cancelRefund and refetchCredits, the startup reconcile,
// and billing off / invalid. Uses the mock provider with priced custom routes
// (lib/animate/providers/mock.js, ffmpeg required).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const H = require('./helpers/billing-server');

const skip = H.ffmpegSkip;
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

// A job lives in its account's workspace (users/<sub>/animate/jobs/<id>/).
function jobFile(ctx, id, name = 'job.json') {
  const users = path.join(ctx.dataDir, 'users');
  for (const dir of fsSync.existsSync(users) ? fsSync.readdirSync(users) : []) {
    const folder = path.join(users, dir, 'animate', 'jobs', id);
    if (fsSync.existsSync(folder)) return path.join(folder, name);
  }
  return path.join(ctx.dataDir, 'animate', 'jobs', id, name);
}

async function editJob(ctx, id, patch) {
  const file = jobFile(ctx, id);
  const job = JSON.parse(await fs.readFile(file, 'utf8'));
  patch(job);
  await fs.writeFile(file, JSON.stringify(job, null, 2));
}

async function view(ctx, cookie, id) {
  const response = await H.get(ctx, `/api/animate/jobs/${id}`, cookie);
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function created(ctx, cookie, drivingId, options) {
  const response = await H.createJob(ctx, cookie, drivingId, options);
  assert.equal(response.status, 202, response.text);
  return response.json.job;
}

async function cancel(ctx, cookie, id) {
  const response = await H.post(ctx, `/api/animate/jobs/${id}/cancel`, {}, cookie);
  assert.equal(response.status, 200, response.text);
  return response.json;
}

// The kinds of this job's ledger entries, in order.
async function entriesFor(ctx, jobId) {
  return (await H.readLedger(ctx)).entries.filter(entry => entry.jobId === jobId).map(entry => entry.kind);
}

// Cancels every unfinished job and waits for it, so no job works past the test.
async function settleJobs(ctx, cookie) {
  const { jobs } = (await H.get(ctx, '/api/animate/jobs', cookie)).json;
  for (const job of jobs) if (!TERMINAL.has(job.state)) await cancel(ctx, cookie, job.id);
  for (const job of jobs) await H.waitForJob(ctx, cookie, job.id, current => TERMINAL.has(current.state));
}

async function topUp(ctx, admin, email, credits) {
  const response = await H.adjust(ctx, admin, email, credits);
  assert.equal(response.status, 200, response.text);
  return response.json.user.balance;
}

test('billing off: paid jobs are created as before, without a charge or view.billing', { skip }, async t => {
  const ctx = await H.startApp(t, { billing: null, animate: { concurrency: 1 } });
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  const job = await created(ctx, alice, driving.id, { options: H.LONG });
  assert.equal('billing' in job, false);
  assert.equal(job.estimate.usd, 0.3);
  const listed = (await H.get(ctx, '/api/animate/jobs', alice)).json.jobs;
  assert.equal('billing' in listed[0], false);
  await settleJobs(ctx, alice);
  assert.equal('billing' in (await view(ctx, alice, job.id)), false);
  await assert.rejects(fs.stat(H.ledgerPath(ctx.dataDir)), { code: 'ENOENT' });
  const stored = JSON.parse(await fs.readFile(jobFile(ctx, job.id), 'utf8'));
  assert.equal('billing' in stored, false);
});

test('invalid billing fails closed: 503 billing_misconfigured and no job; the mock route stays free', { skip }, async t => {
  const ctx = await H.startApp(t, { billing: { adminEmails: [] }, animate: { concurrency: 1 } });
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  let response = await H.createJob(ctx, alice, driving.id);
  assert.equal(response.status, 503, response.text);
  assert.equal(response.json.code, 'billing_misconfigured');
  assert.deepEqual(response.json.detail, { problem: 'bad_admin_emails' });
  // The price is irrelevant while locked: an unpriced route is refused the same way.
  response = await H.createJob(ctx, alice, driving.id, { routeId: H.UNPRICED_ROUTE.id });
  assert.equal(response.status, 503);
  assert.deepEqual((await H.get(ctx, '/api/animate/jobs', alice)).json.jobs, []);
  // The earlier checks still come first (an unconfirmed job is not_confirmed, not 503).
  response = await H.post(ctx, '/api/animate/jobs', { drivingId: driving.id, photoId: ctx.photoId, routeId: H.PRICED_ROUTE.id }, alice);
  assert.equal(response.json.code, 'not_confirmed');

  // The local mock route is never billed.
  const mock = await created(ctx, alice, driving.id, { routeId: 'mock/local-demo', options: { delayMs: 60000 } });
  assert.equal('billing' in mock, false);
  await settleJobs(ctx, alice);

  // Login off with a billing file (login_required): locked the same way, signed out.
  await H.setBillingConfig(ctx, H.billingConfig());
  await H.setAuthConfig(ctx, null);
  const open = await H.prepareInputs(ctx, undefined); // login off: one shared workspace
  response = await H.createJob(ctx, undefined, open.id);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json.detail, { problem: 'login_required' });
});

test('route view: free only for the local demo route; mock-provider custom routes, and one taking the demo id, are paid', async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const alice = await H.signIn(ctx, H.ALICE);
  const routesOf = async () => {
    const response = await H.get(ctx, '/api/animate/status', alice);
    assert.equal(response.status, 200, response.text);
    return response.json.routes;
  };
  let routes = await routesOf();
  const byId = Object.fromEntries(routes.map(route => [route.id, route]));
  assert.equal(byId['mock/local-demo'].free, true);
  assert.equal(byId[H.PRICED_ROUTE.id].free, false);
  assert.equal(byId[H.PRICED_ROUTE.id].provider, 'mock');
  assert.equal(byId[H.UNPRICED_ROUTE.id].free, false);
  assert.deepEqual(routes.filter(route => route.free !== false).map(route => route.id), ['mock/local-demo'], 'every other route says free: false');

  // Without the mock provider, a custom route that takes the demo's id is an ordinary paid route.
  await H.stopApp(ctx);
  const impostor = { ...H.PRICED_ROUTE, id: 'mock/local-demo', provider: 'wavespeed', label: '데모 이름을 쓴 경로' };
  await fs.writeFile(path.join(ctx.dataDir, 'animate', 'custom-routes.json'), JSON.stringify([impostor], null, 2));
  ctx.mock = false;
  await H.restartApp(ctx);
  routes = await routesOf();
  const taken = routes.find(route => route.id === 'mock/local-demo');
  assert.equal(taken.label, impostor.label);
  assert.equal(taken.free, false);
  assert.equal(routes.some(route => route.free === true), false);
});

test('charges: debit + view.billing, 402 with needed/balance, price_unknown, free accounts, two parallel creates', { skip }, async t => {
  const ctx = await H.startApp(t, { billing: H.billingConfig({ freeEmails: [H.BOB.email] }), animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  assert.equal(await topUp(ctx, admin, H.ALICE.email, 1000), 1000);

  const first = await created(ctx, alice, driving.id, { options: H.LONG });
  assert.deepEqual(first.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: true, refetchCredits: 0 });
  let billing = await H.billingOf(ctx, alice);
  assert.equal(billing.balance, 400);
  assert.deepEqual(billing.history[0], {
    id: billing.history[0].id, at: billing.history[0].at, delta: -H.JOB_CREDITS, kind: 'charge', label: `${H.PRICED_ROUTE.label} · ${driving.label}`,
  });
  assert.ok(ctx.logs.includes(`[billing] charge job ${first.id} -${H.JOB_CREDITS} ${H.ALICE.email}`));
  // The stored record names the account and the charge; the view never does.
  const stored = JSON.parse(await fs.readFile(jobFile(ctx, first.id), 'utf8')).billing;
  assert.deepEqual(Object.keys(stored).sort(), ['chargeId', 'credits', 'email', 'free', 'refunded', 'sub']);
  assert.equal(stored.sub, H.ALICE.sub);
  assert.equal(stored.email, H.ALICE.email);
  assert.match(stored.chargeId, /^[0-9a-f-]{36}$/);

  let response = await H.createJob(ctx, alice, driving.id);
  assert.equal(response.status, 402, response.text);
  assert.equal(response.json.code, 'insufficient_credits');
  assert.deepEqual(response.json.detail, { needed: H.JOB_CREDITS, balance: 400 });
  response = await H.createJob(ctx, alice, driving.id, { routeId: H.UNPRICED_ROUTE.id });
  assert.equal(response.status, 400, response.text);
  assert.equal(response.json.code, 'price_unknown');
  assert.equal((await H.billingOf(ctx, alice)).balance, 400, 'refusals cost nothing');

  // A free account: no debit, even with no credits at all, and on an unpriced route.
  const bobDriving = await H.prepareInputs(ctx, bob);
  const free = await created(ctx, bob, bobDriving.id, { options: H.LONG });
  assert.deepEqual(free.billing, { credits: H.JOB_CREDITS, free: true, refunded: false, cancelRefund: false, refetchCredits: 0 });
  const freeUnpriced = await created(ctx, bob, bobDriving.id, { routeId: H.UNPRICED_ROUTE.id, options: H.LONG });
  assert.deepEqual(freeUnpriced.billing, { credits: null, free: true, refunded: false, cancelRefund: false, refetchCredits: 0 });
  billing = await H.billingOf(ctx, bob);
  assert.equal(billing.balance, 0);
  assert.deepEqual(billing.history, []);

  // Credit for exactly one job, two creates at once: one wins, the other is refused.
  assert.equal(await topUp(ctx, admin, H.ALICE.email, 200), 600);
  const results = await Promise.all([H.createJob(ctx, alice, driving.id, { options: H.LONG }), H.createJob(ctx, alice, driving.id, { options: H.LONG })]);
  assert.deepEqual(results.map(result => result.status).sort(), [202, 402], results.map(result => result.text).join('\n'));
  const refused = results.find(result => result.status === 402);
  assert.deepEqual(refused.json.detail, { needed: H.JOB_CREDITS, balance: 0 });
  assert.equal((await H.billingOf(ctx, alice)).balance, 0);
  const charges = (await H.readLedger(ctx)).entries.filter(entry => entry.sub === H.ALICE.sub && entry.kind === 'charge');
  assert.equal(charges.length, 2);
  // Each account lists its own jobs only: Alice's two, Bob's two.
  assert.equal((await H.get(ctx, '/api/animate/jobs', alice)).json.jobs.length, 2);
  assert.equal((await H.get(ctx, '/api/animate/jobs', bob)).json.jobs.length, 2);
  await settleJobs(ctx, alice);
  await settleJobs(ctx, bob);
});

test('a job that cannot be created gives its credits straight back', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, H.JOB_CREDITS);
  const { pipeline } = (await ctx.server.workspaceFor(H.ALICE.sub)).animate;
  const original = pipeline.create;
  pipeline.create = async () => { throw Object.assign(new Error('disk full'), { status: 500 }); };
  let response;
  try {
    response = await H.createJob(ctx, alice, driving.id);
  } finally {
    pipeline.create = original;
  }
  assert.equal(response.status, 500);
  const billing = await H.billingOf(ctx, alice);
  assert.equal(billing.balance, H.JOB_CREDITS);
  assert.deepEqual(billing.history.map(entry => entry.kind), ['refund', 'charge', 'topup']);
  assert.equal(billing.history[0].label, billing.history[1].label);
  assert.deepEqual((await H.get(ctx, '/api/animate/jobs', alice)).json.jobs, []);
});

test('refunds: canceled before a provider task -> refund; canceled with a task -> none; failed -> refund; succeeded -> none', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, 4 * H.JOB_CREDITS);

  // A holds the only slot until canceled; B and C wait behind it (no provider task yet).
  const a = await created(ctx, alice, driving.id, { options: H.LONG });
  const running = await H.waitForJob(ctx, alice, a.id, job => job.state === 'running');
  assert.deepEqual(running.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false, refetchCredits: 0 }, 'a provider task exists');
  const b = await created(ctx, alice, driving.id, { options: H.LONG });
  const c = await created(ctx, alice, driving.id, { options: H.LONG });
  assert.equal((await view(ctx, alice, b.id)).state, 'queued');
  assert.equal((await view(ctx, alice, b.id)).billing.cancelRefund, true);
  assert.equal((await H.billingOf(ctx, alice)).balance, H.JOB_CREDITS);

  // B: canceled while queued -> refunded once, with the charge's label.
  assert.equal((await cancel(ctx, alice, b.id)).state, 'canceled');
  const refundedB = await H.waitForJob(ctx, alice, b.id, job => job.billing.refunded);
  assert.deepEqual(refundedB.billing, { credits: H.JOB_CREDITS, free: false, refunded: true, cancelRefund: false, refetchCredits: 0 });
  assert.deepEqual(await entriesFor(ctx, b.id), ['charge', 'refund']);
  const ledger = await H.readLedger(ctx);
  const [chargeB, refundB] = ledger.entries.filter(entry => entry.jobId === b.id);
  assert.equal(refundB.label, chargeB.label);
  assert.equal(refundB.delta, H.JOB_CREDITS);
  assert.equal(refundB.chargeId, chargeB.id, 'a refund names the charge it gives back');
  assert.ok(ctx.logs.includes(`[billing] refund job ${b.id} +${H.JOB_CREDITS} ${H.ALICE.email}`));
  // Canceling again changes nothing.
  await cancel(ctx, alice, b.id);
  assert.deepEqual(await entriesFor(ctx, b.id), ['charge', 'refund']);

  // C fails in preparing (its character copy is gone) once A is canceled; A had a task: no refund.
  await fs.rm(jobFile(ctx, c.id, 'character-source.png'));
  await cancel(ctx, alice, a.id);
  const failedC = await H.waitForJob(ctx, alice, c.id, job => job.state === 'failed' && job.billing.refunded);
  assert.equal(failedC.error.code, 'character_missing');
  assert.deepEqual(await entriesFor(ctx, c.id), ['charge', 'refund']);
  const canceledA = await view(ctx, alice, a.id);
  assert.equal(canceledA.state, 'canceled');
  assert.deepEqual(canceledA.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false, refetchCredits: 0 });
  assert.deepEqual(await entriesFor(ctx, a.id), ['charge']);

  // D succeeds: charged, never refunded.
  const d = await created(ctx, alice, driving.id);
  const succeeded = await H.waitForJob(ctx, alice, d.id, job => TERMINAL.has(job.state));
  assert.equal(succeeded.state, 'succeeded', JSON.stringify(succeeded.error));
  assert.deepEqual(succeeded.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false, refetchCredits: 0 });
  assert.deepEqual(await entriesFor(ctx, d.id), ['charge']);
  // 4 charged, B and C refunded.
  assert.equal((await H.billingOf(ctx, alice)).balance, 2 * H.JOB_CREDITS);
});

test('startup reconcile: jobs that ended while the server was down follow the same refund rules', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 2 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, 6 * H.JOB_CREDITS);
  // A and C run (provider tasks exist); B, D, E and F wait.
  const a = await created(ctx, alice, driving.id, { options: H.LONG });
  const c = await created(ctx, alice, driving.id, { options: H.LONG });
  const b = await created(ctx, alice, driving.id, { options: H.LONG });
  const d = await created(ctx, alice, driving.id, { options: H.LONG });
  const e = await created(ctx, alice, driving.id, { options: H.LONG });
  const f = await created(ctx, alice, driving.id, { options: H.LONG });
  for (const job of [a, c]) await H.waitForJob(ctx, alice, job.id, current => current.providerStatus === 'generating');
  await cancel(ctx, alice, d.id);
  await H.waitForJob(ctx, alice, d.id, current => current.billing.refunded);
  assert.equal((await H.billingOf(ctx, alice)).balance, H.JOB_CREDITS);
  await H.stopApp(ctx);

  const ended = { state: 'failed', error: { code: 'generation_failed', message: 'Generation failed.' } };
  await editJob(ctx, a.id, job => Object.assign(job, ended)); // failed -> refund
  await editJob(ctx, b.id, job => Object.assign(job, { state: 'canceled' })); // canceled, no task -> refund
  await editJob(ctx, c.id, job => { // canceled with a provider task -> billed, no refund
    assert.ok(job.task, 'C has its task on disk');
    Object.assign(job, { state: 'canceled' });
  });
  await editJob(ctx, d.id, job => { job.billing.refunded = false; }); // refunded, but the flag write was cut short
  await editJob(ctx, e.id, job => { // canceled after its submit request went out -> no refund
    Object.assign(job, { state: 'canceled', submitStartedAt: new Date(H.START).toISOString() });
  });
  await editJob(ctx, f.id, job => { // the provider canceled its task -> refund
    Object.assign(job, { state: 'canceled', task: { id: 'provider-task' }, error: { code: 'canceled', message: 'Canceled.', provider: true } });
  });
  await H.restartApp(ctx);

  // The reconcile runs before the server listens.
  const views = {};
  for (const job of [a, b, c, d, e, f]) views[job.id] = await view(ctx, alice, job.id);
  assert.equal(views[a.id].billing.refunded, true);
  assert.equal(views[b.id].billing.refunded, true);
  assert.equal(views[c.id].billing.refunded, false);
  assert.equal(views[d.id].billing.refunded, true);
  assert.equal(views[e.id].billing.refunded, false);
  assert.equal(views[f.id].billing.refunded, true);
  assert.deepEqual(await entriesFor(ctx, a.id), ['charge', 'refund']);
  assert.deepEqual(await entriesFor(ctx, b.id), ['charge', 'refund']);
  assert.deepEqual(await entriesFor(ctx, c.id), ['charge']);
  assert.deepEqual(await entriesFor(ctx, d.id), ['charge', 'refund'], 'no second refund');
  assert.deepEqual(await entriesFor(ctx, e.id), ['charge']);
  assert.deepEqual(await entriesFor(ctx, f.id), ['charge', 'refund']);
  assert.equal((await H.billingOf(ctx, alice)).balance, 4 * H.JOB_CREDITS);
  const persisted = JSON.parse(await fs.readFile(jobFile(ctx, d.id), 'utf8'));
  assert.equal(persisted.billing.refunded, true, 'the flag is persisted');
  // A restart with nothing left to do changes nothing.
  await H.restartApp(ctx);
  assert.equal((await H.billingOf(ctx, alice)).balance, 4 * H.JOB_CREDITS);
});

test('view.billing.cancelRefund: only a charged, unrefunded job without a provider task', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const { pipeline } = ctx.server.animate;
  const base = { id: '00000000-0000-4000-8000-000000000000', state: 'queued', task: null };
  const charged = { credits: 600, free: false, chargeId: 'charge-1', refunded: false, sub: 's', email: 'e@example.com' };
  const cases = [
    [{ billing: charged }, true],
    [{ state: 'preparing', billing: charged }, true],
    [{ state: 'submitting', billing: charged }, true],
    [{ state: 'submitting', submitStartedAt: '2026-09-30T00:00:00.000Z', billing: charged }, false],
    [{ state: 'running', task: { id: 't' }, billing: charged }, false],
    [{ billing: { ...charged, refunded: true } }, false],
    [{ billing: { ...charged, free: true, chargeId: null } }, false],
    [{ billing: { ...charged, credits: 0, chargeId: null } }, false],
  ];
  for (const [fields, expected] of cases) {
    const shown = pipeline.view({ ...base, ...fields }).billing;
    assert.equal(shown.cancelRefund, expected, JSON.stringify(fields));
    assert.deepEqual(Object.keys(shown).sort(), ['cancelRefund', 'credits', 'free', 'refetchCredits', 'refunded']);
  }
  assert.equal('billing' in pipeline.view(base), false);
});

// --- v2.1: provider-reported cancels, 다시 받기 charges ----------------------------

const { ProviderError } = require('../lib/animate/http');

// Replaces some of this server's mock adapter functions; returns restore().
function patchMock(ctx, patch) {
  const { providers } = ctx.server.animate.configStore;
  const original = providers.mock;
  providers.mock = { ...original, ...patch };
  return () => { providers.mock = original; };
}

// The provider made the result, but our download of it hiccuped (HTTP 503): the job
// fails without the provider's verdict, so it is refunded and 다시 받기 is offered.
const downloadHiccup = ctx => patchMock(ctx, {
  download: async () => { throw new ProviderError('Download failed with HTTP 503.', { status: 503, retryable: true, code: 'download_status' }); },
});

const refetch = (ctx, cookie, id) => H.post(ctx, `/api/animate/jobs/${id}/refetch`, {}, cookie);

// This job's ledger entries, in order.
async function jobEntries(ctx, jobId) {
  return (await H.readLedger(ctx)).entries.filter(entry => entry.jobId === jobId);
}

async function balanceOf(ctx, cookie) {
  return (await H.billingOf(ctx, cookie)).balance;
}

// Waits until the job's latest run has unwound (its refund, if any, has been asked for).
async function unwound(ctx, id) {
  for (const workspace of await Promise.all([...ctx.server.workspaces.values()])) {
    const run = workspace.animate.pipeline.runs.get(id);
    if (run) await run.catch(() => {});
  }
  await sleep(100);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A charged job that failed and got its credits back, with 다시 받기 offered.
async function refundedFailedJob(ctx, cookie, drivingId) {
  const restore = downloadHiccup(ctx);
  try {
    const job = await created(ctx, cookie, drivingId);
    const failed = await H.waitForJob(ctx, cookie, job.id, view => view.state === 'failed' && view.billing.refunded);
    assert.equal(failed.error.code, 'download_failed');
    assert.equal(failed.canRefetch, true);
    return failed;
  } finally {
    restore();
  }
}

test('a cancel the provider reported gives the credits back; the user\'s own cancel after the task does not', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, 2 * H.JOB_CREDITS);

  const restore = patchMock(ctx, { poll: async () => ({ state: 'canceled', providerStatus: 'cancelled' }) });
  const byProvider = await created(ctx, alice, driving.id);
  const ended = await H.waitForJob(ctx, alice, byProvider.id, job => job.state === 'canceled' && job.billing.refunded);
  restore();
  assert.deepEqual(ended.error, { code: 'canceled', message: 'Canceled.' });
  assert.equal(ended.canRefetch, false, 'the provider\'s own verdict');
  assert.deepEqual(ended.billing, { credits: H.JOB_CREDITS, free: false, refunded: true, cancelRefund: false, refetchCredits: 0 });
  const stored = JSON.parse(await fs.readFile(jobFile(ctx, byProvider.id), 'utf8'));
  assert.equal(stored.error.provider, true);
  assert.ok(stored.task, 'its provider task existed');
  assert.deepEqual((await jobEntries(ctx, byProvider.id)).map(entry => entry.kind), ['charge', 'refund']);
  assert.equal(await balanceOf(ctx, alice), 2 * H.JOB_CREDITS);

  // The user cancels once the task exists: the local cancel does not stop it, so it stays paid.
  const mine = await created(ctx, alice, driving.id, { options: H.LONG });
  const running = await H.waitForJob(ctx, alice, mine.id, job => job.providerStatus === 'generating');
  assert.equal(running.billing.cancelRefund, false);
  const canceled = await cancel(ctx, alice, mine.id);
  assert.equal(canceled.state, 'canceled');
  await unwound(ctx, mine.id);
  const after = await view(ctx, alice, mine.id);
  assert.equal(after.billing.refunded, false);
  assert.deepEqual((await jobEntries(ctx, mine.id)).map(entry => entry.kind), ['charge']);
  assert.equal(JSON.parse(await fs.readFile(jobFile(ctx, mine.id), 'utf8')).error.provider, undefined);
  assert.equal(await balanceOf(ctx, alice), H.JOB_CREDITS);
});

test('다시 받기 of a refunded failed job charges it again once: short balance 402 leaves it, a second failure refunds again, success keeps it', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, 1000);
  const failed = await refundedFailedJob(ctx, alice, driving.id);
  const { id } = failed;
  assert.deepEqual(failed.billing, { credits: H.JOB_CREDITS, free: false, refunded: true, cancelRefund: false, refetchCredits: H.JOB_CREDITS });
  assert.equal(await balanceOf(ctx, alice), 1000);
  const firstCharge = JSON.parse(await fs.readFile(jobFile(ctx, id), 'utf8')).billing.chargeId;

  // Short balance: the same refusal as a new job, and the job stays as it was.
  await H.adjust(ctx, admin, H.ALICE.email, -500);
  let response = await refetch(ctx, alice, id);
  assert.equal(response.status, 402, response.text);
  assert.equal(response.json.code, 'insufficient_credits');
  assert.deepEqual(response.json.detail, { needed: H.JOB_CREDITS, balance: 500 });
  const unchanged = await view(ctx, alice, id);
  assert.equal(unchanged.state, 'failed');
  assert.deepEqual(unchanged.error, failed.error);
  assert.deepEqual(unchanged.billing, failed.billing);
  assert.equal(JSON.parse(await fs.readFile(jobFile(ctx, id), 'utf8')).billing.chargeId, firstCharge);
  assert.equal(await balanceOf(ctx, alice), 500);
  await topUp(ctx, admin, H.ALICE.email, 700);

  // Charged again before the re-fetch starts; it fails again and that charge comes back too.
  const restore = downloadHiccup(ctx);
  response = await refetch(ctx, alice, id);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.state, 'running');
  assert.deepEqual(response.json.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false, refetchCredits: 0 });
  assert.equal(await balanceOf(ctx, alice), 1200 - H.JOB_CREDITS);
  const again = await H.waitForJob(ctx, alice, id, job => job.state === 'failed' && job.billing.refunded);
  restore();
  assert.equal(again.billing.refetchCredits, H.JOB_CREDITS);
  assert.equal(await balanceOf(ctx, alice), 1200);
  const entries = await jobEntries(ctx, id);
  assert.deepEqual(entries.map(entry => entry.kind), ['charge', 'refund', 'charge', 'refund']);
  const [charge1, refund1, charge2, refund2] = entries;
  const label = `${H.PRICED_ROUTE.label} · ${driving.label}`;
  assert.equal(charge1.label, label);
  assert.equal(charge2.label, `${label} · 다시 받기`);
  assert.equal(refund2.label, charge2.label);
  assert.equal(refund1.chargeId, charge1.id);
  assert.equal(refund2.chargeId, charge2.id, 'each charge is refunded on its own');
  assert.notEqual(charge2.id, charge1.id);
  assert.equal(JSON.parse(await fs.readFile(jobFile(ctx, id), 'utf8')).billing.chargeId, charge2.id);
  assert.ok(ctx.logs.includes(`[billing] charge job ${id} -${H.JOB_CREDITS} ${H.ALICE.email} (refetch)`), ctx.logs.join('\n'));
  const history = (await H.billingOf(ctx, alice)).history;
  assert.deepEqual(history.slice(0, 2).map(entry => [entry.kind, entry.label]), [['refund', charge2.label], ['charge', charge2.label]]);

  // The result arrives this time: charged a third time, and a delivered result keeps it.
  response = await refetch(ctx, alice, id);
  assert.equal(response.status, 200, response.text);
  const done = await H.waitForJob(ctx, alice, id, job => TERMINAL.has(job.state));
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(done.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false, refetchCredits: 0 });
  assert.equal(await balanceOf(ctx, alice), 1200 - H.JOB_CREDITS);
  assert.deepEqual((await jobEntries(ctx, id)).map(entry => entry.kind), ['charge', 'refund', 'charge', 'refund', 'charge']);
  // A restart settles nothing more: no refund for the delivered result, none twice for the others.
  await H.restartApp(ctx);
  assert.equal(await balanceOf(ctx, alice), 1200 - H.JOB_CREDITS);
  assert.equal((await jobEntries(ctx, id)).length, 5);
});

// The mock's saved task finishes at once (a LONG task would still be generating).
const finishAtOnce = ctx => patchMock(ctx, {
  poll: async (runCtx, route, task) => ({ state: 'succeeded', outputUrl: `mock://${task.id}`, providerStatus: 'succeeded' }),
});

test('다시 받기 takes nothing for a charge that was kept, a free account or a free job', { skip }, async t => {
  const ctx = await H.startApp(t, { billing: H.billingConfig({ freeEmails: [H.BOB.email] }), animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, 3 * H.JOB_CREDITS);

  // Canceled by Alice after its task existed: still paid, so its 다시 받기 is free.
  const kept = await created(ctx, alice, driving.id, { options: H.LONG });
  await H.waitForJob(ctx, alice, kept.id, job => job.providerStatus === 'generating');
  await cancel(ctx, alice, kept.id);
  await unwound(ctx, kept.id);
  const keptView = await view(ctx, alice, kept.id);
  assert.equal(keptView.canRefetch, true, 'the mock, like WaveSpeed, has no remote cancel');
  assert.deepEqual(keptView.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false, refetchCredits: 0 });
  let restore = finishAtOnce(ctx);
  let response = await refetch(ctx, alice, kept.id);
  assert.equal(response.status, 200, response.text);
  let done = await H.waitForJob(ctx, alice, kept.id, job => TERMINAL.has(job.state));
  restore();
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual((await jobEntries(ctx, kept.id)).map(entry => entry.kind), ['charge']);
  assert.equal(await balanceOf(ctx, alice), 2 * H.JOB_CREDITS);

  // Alice's refunded job is hers alone: Bob (a free account) cannot fetch it again, see it
  // or move her credits; the view tells Alice what the re-fetch would take.
  const refunded = await refundedFailedJob(ctx, alice, driving.id);
  assert.equal(refunded.billing.refetchCredits, H.JOB_CREDITS);
  response = await refetch(ctx, bob, refunded.id);
  assert.equal(response.status, 404, response.text);
  assert.equal(response.json.code, 'job_missing');
  assert.equal((await view(ctx, alice, refunded.id)).state, 'failed', 'Bob did not restart it');
  assert.deepEqual((await jobEntries(ctx, refunded.id)).map(entry => entry.kind), ['charge', 'refund']);
  assert.equal(await balanceOf(ctx, alice), 2 * H.JOB_CREDITS);
  assert.deepEqual((await H.billingOf(ctx, bob)).history, []);

  // A job Bob made for free has nothing to take again.
  const bobDriving = await H.prepareInputs(ctx, bob);
  const freeJob = await refundedFailedJobOf(ctx, bob, bobDriving.id);
  assert.deepEqual(freeJob.billing, { credits: H.JOB_CREDITS, free: true, refunded: false, cancelRefund: false, refetchCredits: 0 });
  response = await refetch(ctx, bob, freeJob.id);
  assert.equal(response.status, 200, response.text);
  done = await H.waitForJob(ctx, bob, freeJob.id, job => TERMINAL.has(job.state));
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(await jobEntries(ctx, freeJob.id), []);
  assert.deepEqual((await H.billingOf(ctx, bob)).history, []);
  assert.equal(await balanceOf(ctx, alice), 2 * H.JOB_CREDITS);
});

// A job that failed on the download hiccup, for any account (free ones have no refund to wait for).
async function refundedFailedJobOf(ctx, cookie, drivingId) {
  const restore = downloadHiccup(ctx);
  try {
    const job = await created(ctx, cookie, drivingId);
    return await H.waitForJob(ctx, cookie, job.id, view => view.state === 'failed');
  } finally {
    restore();
  }
}

test('다시 받기 with credits off takes nothing; with a broken config it is refused like a new paid job', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, H.JOB_CREDITS);
  const refunded = await refundedFailedJob(ctx, alice, driving.id);
  const before = await jobEntries(ctx, refunded.id);

  // Broken config: fail closed, the job as it was.
  await H.setBillingConfig(ctx, { adminEmails: [] });
  assert.equal((await view(ctx, alice, refunded.id)).billing.refetchCredits, 0);
  let response = await refetch(ctx, alice, refunded.id);
  assert.equal(response.status, 503, response.text);
  assert.equal(response.json.code, 'billing_misconfigured');
  assert.deepEqual(response.json.detail, { problem: 'bad_admin_emails' });
  assert.equal((await view(ctx, alice, refunded.id)).state, 'failed');

  // Credits off: the re-fetch is free, as before credits existed.
  await H.setBillingConfig(ctx, null);
  assert.equal((await view(ctx, alice, refunded.id)).billing.refetchCredits, 0);
  response = await refetch(ctx, alice, refunded.id);
  assert.equal(response.status, 200, response.text);
  const done = await H.waitForJob(ctx, alice, refunded.id, job => TERMINAL.has(job.state));
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(await jobEntries(ctx, refunded.id), before);
  await H.setBillingConfig(ctx, H.billingConfig());
  assert.equal(await balanceOf(ctx, alice), H.JOB_CREDITS);
});

test('two 다시 받기 at once (a double click) take the credits once', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, 3 * H.JOB_CREDITS);
  const { id } = await refundedFailedJob(ctx, alice, driving.id);
  const responses = await Promise.all([refetch(ctx, alice, id), refetch(ctx, alice, id), refetch(ctx, alice, id)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200], responses.map(response => response.text).join('\n'));
  for (const response of responses) assert.equal(response.json.state, 'running');
  assert.deepEqual((await jobEntries(ctx, id)).map(entry => entry.kind), ['charge', 'refund', 'charge']);
  assert.equal(await balanceOf(ctx, alice), 2 * H.JOB_CREDITS);
  const done = await H.waitForJob(ctx, alice, id, job => TERMINAL.has(job.state));
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.equal(await balanceOf(ctx, alice), 2 * H.JOB_CREDITS);
});

test('a 다시 받기 right after the failure waits for its refund to land, then charges again (no free result)', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, 2 * H.JOB_CREDITS);
  // Refunds are held back until released.
  const { billing } = ctx.server;
  const refundJob = billing.refundJob;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  billing.refundJob = async (...args) => { await gate; return refundJob(...args); };
  t.after(() => { billing.refundJob = refundJob; });

  const restore = downloadHiccup(ctx);
  const job = await created(ctx, alice, driving.id);
  const failed = await H.waitForJob(ctx, alice, job.id, view => view.state === 'failed');
  restore();
  assert.equal(failed.billing.refunded, false, 'the refund has not landed yet');
  assert.equal(failed.billing.refetchCredits, H.JOB_CREDITS, 'a re-fetch will still take the credits again');
  const pending = refetch(ctx, alice, job.id);
  await sleep(200);
  assert.equal((await view(ctx, alice, job.id)).state, 'failed', 'not restarted before the refund landed');
  release();
  const response = await pending;
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.state, 'running');
  assert.equal(response.json.billing.refunded, false);
  assert.deepEqual((await jobEntries(ctx, job.id)).map(entry => entry.kind), ['charge', 'refund', 'charge']);
  const done = await H.waitForJob(ctx, alice, job.id, view => TERMINAL.has(view.state));
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.billing.refunded, false, 'the late refund did not mark the new charge');
  assert.equal(await balanceOf(ctx, alice), H.JOB_CREDITS);
});

test('ledger: each job charge is refunded once on its own; an older refund without chargeId counts for the first charge', () => {
  const ledgers = require('../lib/billing/ledger');
  const at = new Date(H.START).toISOString();
  const entry = (id, kind, delta, extra = {}) => ({ id, at, sub: 's1', delta, kind, label: 'L', jobId: 'job-1', ...extra });
  const ledger = {
    version: 1, users: { s1: { email: 'a@example.com' } }, orders: {}, webhooks: {},
    entries: [
      entry('c1', 'charge', -600),
      entry('r1', 'refund', 600), // written before refunds named their charge
      entry('c2', 'charge', -600, { label: 'L · 다시 받기' }),
      entry('other', 'refund', 600, { jobId: 'job-2', sub: 's2' }),
    ],
  };
  assert.equal(ledgers.chargeRefunded(ledger, ledger.entries[0]), true);
  assert.equal(ledgers.chargeRefunded(ledger, ledger.entries[2]), false, 'a later charge is not covered by the old refund');
  assert.deepEqual(ledgers.refundCharge(ledger, { chargeId: 'c1', nowIso: at }), { refunded: true, now: false, credits: 600, sub: 's1', email: 'a@example.com' });
  assert.deepEqual(ledgers.refundCharge(ledger, { chargeId: 'c2', nowIso: at }), { refunded: true, now: true, credits: 600, sub: 's1', email: 'a@example.com' });
  const added = ledger.entries[ledger.entries.length - 1];
  assert.deepEqual({ ...added, id: null }, { id: null, at, sub: 's1', delta: 600, kind: 'refund', label: 'L · 다시 받기', jobId: 'job-1', chargeId: 'c2' });
  assert.equal(ledgers.refundCharge(ledger, { chargeId: 'c2', nowIso: at }).now, false, 'at most once');
  assert.equal(ledger.entries.length, 5);
  assert.deepEqual(ledgers.refundCharge(ledger, { chargeId: 'nope', nowIso: at }), { refunded: false });
  assert.equal(ledgers.balanceOf(ledger, 's1'), 0);
});
