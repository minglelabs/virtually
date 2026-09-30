'use strict';

// Paid jobs (server): charges on POST /api/animate/jobs (402 / price_unknown /
// free accounts / parallel creates), refunds (failed; canceled only before a
// provider task exists; never succeeded), view.billing incl. cancelRefund,
// the startup reconcile, and billing off / invalid. Uses the mock provider
// with priced custom routes (lib/animate/providers/mock.js, ffmpeg required).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');

const H = require('./helpers/billing-server');

const skip = H.ffmpegSkip;
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

function jobFile(ctx, id, name = 'job.json') {
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
  response = await H.post(ctx, '/api/animate/jobs', { drivingId: driving.id, routeId: H.PRICED_ROUTE.id }, alice);
  assert.equal(response.json.code, 'not_confirmed');

  // The local mock route is never billed.
  const mock = await created(ctx, alice, driving.id, { routeId: 'mock/local-demo', options: { delayMs: 60000 } });
  assert.equal('billing' in mock, false);
  await settleJobs(ctx, alice);

  // Login off with a billing file (login_required): locked the same way, signed out.
  await H.setBillingConfig(ctx, H.billingConfig());
  await H.setAuthConfig(ctx, null);
  response = await H.createJob(ctx, undefined, driving.id);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json.detail, { problem: 'login_required' });
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
  assert.deepEqual(first.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: true });
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
  const free = await created(ctx, bob, driving.id, { options: H.LONG });
  assert.deepEqual(free.billing, { credits: H.JOB_CREDITS, free: true, refunded: false, cancelRefund: false });
  const freeUnpriced = await created(ctx, bob, driving.id, { routeId: H.UNPRICED_ROUTE.id, options: H.LONG });
  assert.deepEqual(freeUnpriced.billing, { credits: null, free: true, refunded: false, cancelRefund: false });
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
  const jobs = (await H.get(ctx, '/api/animate/jobs', alice)).json.jobs;
  assert.equal(jobs.length, 4);
  await settleJobs(ctx, alice);
});

test('a job that cannot be created gives its credits straight back', { skip }, async t => {
  const ctx = await H.startApp(t, { animate: { concurrency: 1 } });
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const driving = await H.prepareInputs(ctx, alice);
  await H.billingOf(ctx, alice);
  await topUp(ctx, admin, H.ALICE.email, H.JOB_CREDITS);
  const { pipeline } = ctx.server.animate;
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
  assert.deepEqual(running.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false }, 'a provider task exists');
  const b = await created(ctx, alice, driving.id, { options: H.LONG });
  const c = await created(ctx, alice, driving.id, { options: H.LONG });
  assert.equal((await view(ctx, alice, b.id)).state, 'queued');
  assert.equal((await view(ctx, alice, b.id)).billing.cancelRefund, true);
  assert.equal((await H.billingOf(ctx, alice)).balance, H.JOB_CREDITS);

  // B: canceled while queued -> refunded once, with the charge's label.
  assert.equal((await cancel(ctx, alice, b.id)).state, 'canceled');
  const refundedB = await H.waitForJob(ctx, alice, b.id, job => job.billing.refunded);
  assert.deepEqual(refundedB.billing, { credits: H.JOB_CREDITS, free: false, refunded: true, cancelRefund: false });
  assert.deepEqual(await entriesFor(ctx, b.id), ['charge', 'refund']);
  const ledger = await H.readLedger(ctx);
  const [chargeB, refundB] = ledger.entries.filter(entry => entry.jobId === b.id);
  assert.equal(refundB.label, chargeB.label);
  assert.equal(refundB.delta, H.JOB_CREDITS);
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
  assert.deepEqual(canceledA.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false });
  assert.deepEqual(await entriesFor(ctx, a.id), ['charge']);

  // D succeeds: charged, never refunded.
  const d = await created(ctx, alice, driving.id);
  const succeeded = await H.waitForJob(ctx, alice, d.id, job => TERMINAL.has(job.state));
  assert.equal(succeeded.state, 'succeeded', JSON.stringify(succeeded.error));
  assert.deepEqual(succeeded.billing, { credits: H.JOB_CREDITS, free: false, refunded: false, cancelRefund: false });
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
  await topUp(ctx, admin, H.ALICE.email, 5 * H.JOB_CREDITS);
  // A and C run (provider tasks exist); B, D and E wait.
  const a = await created(ctx, alice, driving.id, { options: H.LONG });
  const c = await created(ctx, alice, driving.id, { options: H.LONG });
  const b = await created(ctx, alice, driving.id, { options: H.LONG });
  const d = await created(ctx, alice, driving.id, { options: H.LONG });
  const e = await created(ctx, alice, driving.id, { options: H.LONG });
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
  await H.restartApp(ctx);

  // The reconcile runs before the server listens.
  const views = {};
  for (const job of [a, b, c, d, e]) views[job.id] = await view(ctx, alice, job.id);
  assert.equal(views[a.id].billing.refunded, true);
  assert.equal(views[b.id].billing.refunded, true);
  assert.equal(views[c.id].billing.refunded, false);
  assert.equal(views[d.id].billing.refunded, true);
  assert.equal(views[e.id].billing.refunded, false);
  assert.deepEqual(await entriesFor(ctx, a.id), ['charge', 'refund']);
  assert.deepEqual(await entriesFor(ctx, b.id), ['charge', 'refund']);
  assert.deepEqual(await entriesFor(ctx, c.id), ['charge']);
  assert.deepEqual(await entriesFor(ctx, d.id), ['charge', 'refund'], 'no second refund');
  assert.deepEqual(await entriesFor(ctx, e.id), ['charge']);
  assert.equal((await H.billingOf(ctx, alice)).balance, 3 * H.JOB_CREDITS);
  const persisted = JSON.parse(await fs.readFile(jobFile(ctx, d.id), 'utf8'));
  assert.equal(persisted.billing.refunded, true, 'the flag is persisted');
  // A restart with nothing left to do changes nothing.
  await H.restartApp(ctx);
  assert.equal((await H.billingOf(ctx, alice)).balance, 3 * H.JOB_CREDITS);
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
    assert.deepEqual(Object.keys(shown).sort(), ['cancelRefund', 'credits', 'free', 'refunded']);
  }
  assert.equal('billing' in pipeline.view(base), false);
});
