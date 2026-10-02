'use strict';

// '다시 받기' (POST /api/animate/jobs/<id>/refetch): a failed or canceled job whose
// provider task was saved fetches that task's result again (poll -> download ->
// key) without uploading or submitting again, so it costs nothing more.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const { createAppServer } = require('../server');
const { Pipeline } = require('../lib/animate/pipeline');
const { ProviderError } = require('../lib/animate/http');
const mockProvider = require('../lib/animate/providers/mock');
const H = require('../public/animate.js');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const skip = spawnSync(FFMPEG, ['-version']).status === 0 ? false : 'ffmpeg not available';
const ffmpeg = args => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
const FINISHED = ['succeeded', 'failed', 'canceled'];
const MOCK_ROUTE = 'mock/local-demo';

// A data dir plus a character (red body on a transparent canvas, keyed cleanly on
// the green key canvas) and a 2 s driving clip.
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-refetch-'));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const manifestPath = path.join(dir, 'no-examples.json');
  await fs.writeFile(manifestPath, JSON.stringify({ version: 1, examples: [] }));
  const character = path.join(dir, 'c.png');
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'", '-frames:v', '1', character]);
  const clip = path.join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
  return { dir, dataDir, manifestPath, character, clip };
}

async function startApp(env) {
  const server = await createAppServer({ dataDir: env.dataDir, examplesManifestPath: env.manifestPath, animateMock: true, animatePollIntervalMs: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, providers: server.animate.configStore.providers };
}

async function stopApp(app) {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
}

// Create a character from the test image and upload the driving clip; resolves the driving id.
// The character's base photo id is kept on `app` for createJob.
async function addInputs(app, env) {
  let response = await fetch(`${app.base}/api/characters?name=${encodeURIComponent('캐릭터')}&filename=c.png`, { method: 'POST', body: fsSync.readFileSync(env.character) });
  assert.equal(response.status, 201);
  app.photoId = (await response.json()).character.basePhotoId;
  response = await fetch(`${app.base}/api/animate/drivings?name=clip.mp4`, { method: 'POST', body: fsSync.readFileSync(env.clip) });
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

const post = (app, pathname, body = {}) => fetch(`${app.base}${pathname}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const refetch = (app, id) => post(app, `/api/animate/jobs/${id}/refetch`);
const getJob = async (app, id) => (await fetch(`${app.base}/api/animate/jobs/${id}`)).json();
const storedJob = async (env, id) => JSON.parse(await fs.readFile(path.join(env.dataDir, 'animate', 'jobs', id, 'job.json'), 'utf8'));

async function createJob(app, drivingId, options = {}) {
  const response = await post(app, '/api/animate/jobs', { drivingId, routeId: MOCK_ROUTE, photoId: app.photoId, options });
  assert.equal(response.status, 202);
  return (await response.json()).job;
}

async function waitForJob(app, id, states, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(app, id);
    if (states.includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}: ${JSON.stringify(job.error)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Replace some of this server's mock adapter functions; returns restore().
function patchMock(app, patch) {
  const original = app.providers.mock;
  app.providers.mock = { ...original, ...patch };
  return () => { app.providers.mock = original; };
}

// Count this server's mock upload/submit calls from now on; a re-fetch makes neither.
function countSends(app) {
  const counts = { upload: 0, submit: 0 };
  const original = app.providers.mock;
  app.providers.mock = {
    ...original,
    upload: (...args) => { counts.upload += 1; return original.upload(...args); },
    submit: (...args) => { counts.submit += 1; return original.submit(...args); },
  };
  return counts;
}

async function assertSucceededWithResult(app, job) {
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.error, null);
  assert.equal(job.canRefetch, false);
  assert.equal(job.result.url, `/api/animate/jobs/${job.id}/result`);
  assert.ok(job.result.keyedUrl, 'keyed again');
  const response = await fetch(`${app.base}${job.result.url}`);
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 4, 8), 'ftyp');
}

test('canRefetch: failed or canceled with a saved task, not the provider\'s own verdict, on a route that can still poll', () => {
  const pollOnly = { meta: { id: 'p' }, poll: async () => ({ state: 'running' }), cancel: null };
  const routes = {
    'p/route': { id: 'p/route', provider: 'p' },
    'c/route': { id: 'c/route', provider: 'c' }, // adapter with a remote cancel
    'x/route': { id: 'x/route', provider: 'x' }, // adapter gone
    'n/route': { id: 'n/route', provider: 'n' }, // adapter cannot poll
  };
  const pipeline = new Pipeline({
    dataDir: os.tmpdir(),
    registry: { get: id => routes[id] || null },
    configStore: { config: {}, providers: { p: pollOnly, c: { ...pollOnly, cancel: async () => {} }, n: { ...pollOnly, poll: null } } },
  });
  const can = (over = {}) => pipeline.canRefetch({
    state: 'failed', routeId: 'p/route', task: { id: 't-1' }, error: { code: 'generation_failed', message: 'x' }, ...over,
  });

  // Our side gave up (poll errors, our 60-minute deadline, a failed download, a restart): the task is still there.
  for (const code of ['generation_failed', 'timeout', 'download_failed', 'interrupted']) {
    assert.equal(can({ error: { code, message: 'x' } }), true, code);
  }
  assert.equal(can({ routeId: 'c/route' }), true, 'failed on a provider that has a remote cancel');
  // Canceled locally: only when the provider task was left running (no remote cancel).
  assert.equal(can({ state: 'canceled', error: { code: 'canceled', message: 'Canceled.' } }), true);
  assert.equal(can({ state: 'canceled', routeId: 'c/route', error: { code: 'canceled', message: 'Canceled.' } }), false);
  // Nothing was submitted.
  assert.equal(can({ task: null }), false);
  assert.equal(can({ state: 'canceled', task: null, error: { code: 'canceled', message: 'Canceled.' } }), false);
  // The provider's own verdict, moderation, a result the provider deleted.
  assert.equal(can({ error: { code: 'generation_failed', message: 'x', provider: true } }), false);
  assert.equal(can({ state: 'canceled', error: { code: 'canceled', message: 'Canceled.', provider: true } }), false);
  assert.equal(can({ error: { code: 'moderation', message: 'x' } }), false);
  assert.equal(can({ error: { code: 'result_expired', message: 'x' } }), false);
  // The route or its adapter is gone, or cannot poll.
  assert.equal(can({ routeId: 'gone/route' }), false);
  assert.equal(can({ routeId: 'x/route' }), false);
  assert.equal(can({ routeId: 'n/route' }), false);
  // Any other state.
  for (const state of ['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying', 'succeeded']) {
    assert.equal(can({ state }), false, state);
  }
  assert.equal(pipeline.canRefetch(null), false);
});

test('a download refused with 403, 404 or 410 is result_expired; other download failures stay download_failed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-refetch-dl-'));
  try {
    let status = null;
    const adapter = {
      meta: { id: 'p' },
      poll: async () => ({ state: 'succeeded' }),
      cancel: null,
      download: async () => {
        if (status == null) throw new ProviderError('Download failed: network error.', { retryable: true, code: 'network' });
        throw new ProviderError(`Download failed with HTTP ${status}.`, { status, retryable: status >= 500, code: 'download_status' });
      },
    };
    const pipeline = new Pipeline({
      dataDir: dir,
      registry: { get: () => ({ id: 'p/route', provider: 'p' }) },
      configStore: {
        config: {}, providers: { p: adapter },
        resolvedCredentials: () => ({}), resolvedSettings: () => ({}), baseUrl: () => null, allowInsecure: () => false,
      },
    });
    const downloadError = async value => {
      status = value;
      // Not registered in pipeline.jobs, so nothing is written to disk.
      const job = { id: crypto.randomUUID(), state: 'running', routeId: 'p/route', task: { id: 't' }, outputUrl: 'https://cdn.example/out.mp4' };
      const error = await pipeline._download(job, new AbortController().signal).then(() => null, e => e);
      assert.ok(error, `HTTP ${value} must fail the download`);
      return { code: error.code, message: error.message };
    };
    for (const value of [403, 404, 410]) {
      assert.deepEqual(await downloadError(value), { code: 'result_expired', message: 'The result has expired at the provider.' }, `HTTP ${value}`);
    }
    for (const value of [401, 500, 503, null]) assert.equal((await downloadError(value)).code, 'download_failed', `HTTP ${value}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('poll errors until generation_failed, then 다시 받기 polls the same task again and succeeds without a new submit', { skip }, async () => {
  const env = await setup();
  const app = await startApp(env);
  try {
    const drivingId = await addInputs(app, env);
    let polls = 0;
    const restore = patchMock(app, {
      poll: async () => { polls += 1; throw new ProviderError('The poll was rejected with HTTP 503.', { status: 503, retryable: true }); },
    });
    const created = await createJob(app, drivingId);
    const failed = await waitForJob(app, created.id, FINISHED);
    restore();
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error.code, 'generation_failed');
    assert.equal(polls, 10, 'gave up after 10 retryable poll errors');
    assert.equal(failed.canRefetch, true);
    const { task } = await storedJob(env, created.id);
    assert.ok(task && task.id, 'the provider task was saved');

    const submits = mockProvider._submitCount();
    const sends = countSends(app);
    const response = await refetch(app, created.id);
    assert.equal(response.status, 200);
    const running = await response.json();
    assert.equal(running.state, 'running', 'running, never queued');
    assert.equal(running.error, null);
    assert.equal(running.result, null);
    assert.equal(running.finishedAt, null);
    assert.equal(running.canRefetch, false);

    const done = await waitForJob(app, created.id, FINISHED);
    await assertSucceededWithResult(app, done);
    assert.equal(mockProvider._submitCount(), submits, 'the mock submit counter is unchanged');
    assert.deepEqual(sends, { upload: 0, submit: 0 });
    assert.equal((await storedJob(env, created.id)).task.id, task.id, 'the same provider task');
  } finally {
    await stopApp(app);
    await fs.rm(env.dir, { recursive: true, force: true });
  }
});

test('a timed-out job with a saved task is fetched again (after a restart) and succeeds', { skip }, async () => {
  const env = await setup();
  let app = await startApp(env);
  let id;
  try {
    const drivingId = await addInputs(app, env);
    const done = await waitForJob(app, (await createJob(app, drivingId)).id, FINISHED);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    id = done.id;
  } finally {
    await stopApp(app);
  }
  // Rewrite it as a job whose generation timed out on our side: no result, the task kept.
  const jobDir = path.join(env.dataDir, 'animate', 'jobs', id);
  for (const file of ['result.mp4', 'result.webm', 'poster.jpg']) await fs.rm(path.join(jobDir, file), { force: true });
  const stored = await storedJob(env, id);
  assert.ok(stored.task && stored.task.id);
  await fs.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({
    ...stored, state: 'failed', progress: null, result: null, error: { code: 'timeout', message: 'Generation timed out.' },
  }));

  app = await startApp(env);
  try {
    const failed = await getJob(app, id);
    assert.equal(failed.state, 'failed', 'a failed job stays failed after a restart');
    assert.deepEqual(failed.error, { code: 'timeout', message: 'Generation timed out.' });
    assert.equal(failed.canRefetch, true);

    const submits = mockProvider._submitCount();
    const sends = countSends(app);
    const startedAt = Date.now();
    const response = await refetch(app, id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'running');
    const again = await waitForJob(app, id, FINISHED);
    await assertSucceededWithResult(app, again);
    assert.ok(fsSync.existsSync(path.join(jobDir, 'result.mp4')), 'downloaded again');
    assert.ok(Date.parse(again.finishedAt) >= startedAt, 'finishedAt is the new finish');
    assert.equal(mockProvider._submitCount(), submits);
    assert.deepEqual(sends, { upload: 0, submit: 0 });
    assert.equal((await storedJob(env, id)).task.id, stored.task.id);
  } finally {
    await stopApp(app);
    await fs.rm(env.dir, { recursive: true, force: true });
  }
});

test('a failure or cancel the provider itself reported is not fetched again: canRefetch false, POST 409 not_refetchable', { skip }, async () => {
  const env = await setup();
  const app = await startApp(env);
  try {
    const drivingId = await addInputs(app, env);
    let restore = patchMock(app, { poll: async () => ({ state: 'failed', error: 'The model could not animate this image.', providerStatus: 'failed' }) });
    const failed = await waitForJob(app, (await createJob(app, drivingId)).id, FINISHED);
    restore();
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.error, { code: 'generation_failed', message: 'The model could not animate this image.' });
    assert.equal(failed.canRefetch, false);
    let stored = await storedJob(env, failed.id);
    assert.equal(stored.error.provider, true);
    assert.ok(stored.task, 'the task was saved; the provider verdict alone blocks it');

    restore = patchMock(app, { poll: async () => ({ state: 'canceled', providerStatus: 'cancelled' }) });
    const canceled = await waitForJob(app, (await createJob(app, drivingId)).id, FINISHED);
    restore();
    assert.equal(canceled.state, 'canceled');
    assert.deepEqual(canceled.error, { code: 'canceled', message: 'Canceled.' });
    assert.equal(canceled.canRefetch, false, 'even though the mock has no remote cancel');
    stored = await storedJob(env, canceled.id);
    assert.equal(stored.error.provider, true);

    const submits = mockProvider._submitCount();
    for (const job of [failed, canceled]) {
      const response = await refetch(app, job.id);
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'This job cannot be fetched again.', code: 'not_refetchable' });
      const after = await getJob(app, job.id);
      assert.equal(after.state, job.state, 'left as it was');
      assert.deepEqual(after.error, job.error);
    }
    assert.equal(mockProvider._submitCount(), submits);

    const response = await refetch(app, '00000000-0000-4000-8000-000000000000');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'job_missing');
  } finally {
    await stopApp(app);
    await fs.rm(env.dir, { recursive: true, force: true });
  }
});

test('a download 404 is result_expired and cannot be fetched again; a 503 can, and then succeeds', { skip }, async () => {
  const env = await setup();
  const app = await startApp(env);
  try {
    const drivingId = await addInputs(app, env);
    const refuse = status => patchMock(app, {
      download: async () => { throw new ProviderError(`Download failed with HTTP ${status}.`, { status, retryable: status >= 500, code: 'download_status' }); },
    });

    let restore = refuse(404);
    const expired = await waitForJob(app, (await createJob(app, drivingId)).id, FINISHED);
    restore();
    assert.equal(expired.state, 'failed');
    assert.deepEqual(expired.error, { code: 'result_expired', message: 'The result has expired at the provider.' });
    assert.equal(expired.canRefetch, false);
    let response = await refetch(app, expired.id);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'not_refetchable');

    restore = refuse(503);
    const hiccup = await waitForJob(app, (await createJob(app, drivingId)).id, FINISHED);
    restore();
    assert.equal(hiccup.state, 'failed');
    assert.equal(hiccup.error.code, 'download_failed');
    assert.equal(hiccup.canRefetch, true);
    const submits = mockProvider._submitCount();
    const sends = countSends(app);
    response = await refetch(app, hiccup.id);
    assert.equal(response.status, 200);
    await assertSucceededWithResult(app, await waitForJob(app, hiccup.id, FINISHED));
    assert.equal(mockProvider._submitCount(), submits);
    assert.deepEqual(sends, { upload: 0, submit: 0 });
  } finally {
    await stopApp(app);
    await fs.rm(env.dir, { recursive: true, force: true });
  }
});

test('a re-fetch survives a restart: it resumes polling the same task and is never submitted again', { skip }, async () => {
  const env = await setup();
  let app = await startApp(env);
  let id;
  let submits;
  try {
    const drivingId = await addInputs(app, env);
    id = (await createJob(app, drivingId, { delayMs: 5000 })).id;
    await waitForJob(app, id, ['running']);
    // A local cancel leaves the provider task running: the mock, like WaveSpeed, has no remote cancel.
    let response = await post(app, `/api/animate/jobs/${id}/cancel`);
    const canceled = await response.json();
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.canRefetch, true);

    submits = mockProvider._submitCount();
    response = await refetch(app, id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'running');
    // Idempotent while active: the running job comes back unchanged.
    response = await refetch(app, id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'running');
  } finally {
    await stopApp(app);
  }
  const stored = await storedJob(env, id);
  assert.equal(stored.state, 'running', 'persisted as running, never queued');
  assert.equal(stored.error, null);
  assert.ok(Date.now() < stored.task.completeAt, 'stopped while the provider was still generating');

  app = await startApp(env);
  try {
    const sends = countSends(app);
    const done = await waitForJob(app, id, FINISHED);
    await assertSucceededWithResult(app, done);
    assert.equal(mockProvider._submitCount(), submits, 'not submitted again after the restart');
    assert.deepEqual(sends, { upload: 0, submit: 0 });
    assert.equal((await storedJob(env, id)).task.id, stored.task.id);
  } finally {
    await stopApp(app);
    await fs.rm(env.dir, { recursive: true, force: true });
  }
});

test('다시 받기 right after a cancel mid-download waits for the canceled run to unwind instead of racing it', { skip }, async () => {
  const env = await setup();
  const app = await startApp(env);
  try {
    const drivingId = await addInputs(app, env);
    // A download that ignores the abort signal until released (like the mock's ffmpeg render).
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { download } = app.providers.mock;
    const restore = patchMock(app, { download: async (...args) => { await gate; return download(...args); } });
    const { id } = await createJob(app, drivingId);
    await waitForJob(app, id, ['downloading']);
    let response = await post(app, `/api/animate/jobs/${id}/cancel`);
    const canceled = await response.json();
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.canRefetch, true);

    const submits = mockProvider._submitCount();
    const pending = refetch(app, id);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await getJob(app, id)).state, 'canceled', 'not restarted while the canceled run is still downloading');
    release();
    response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'running');
    // Without the wait, the canceled run's unwinding would mark the re-fetched run canceled.
    const done = await waitForJob(app, id, FINISHED);
    restore();
    await assertSucceededWithResult(app, done);
    assert.equal(mockProvider._submitCount(), submits);
  } finally {
    await stopApp(app);
    await fs.rm(env.dir, { recursive: true, force: true });
  }
});

test('client: Korean text for the new codes, and 다시 받기 only where the server allows it', () => {
  assert.equal(H.errorText({ error: 'This job cannot be fetched again.', code: 'not_refetchable' }), '다시 받을 수 없는 작업입니다');
  assert.equal(H.errorText({ code: 'result_expired', message: 'The result has expired at the provider.' }), '결과 보관 기간이 지나 받을 수 없습니다');

  assert.equal(H.offersRefetch({ state: 'failed', canRefetch: true }), true);
  assert.equal(H.offersRefetch({ state: 'canceled', canRefetch: true }), true);
  assert.equal(H.offersRefetch({ state: 'failed', canRefetch: false }), false);
  assert.equal(H.offersRefetch({ state: 'failed' }), false, 'a server without canRefetch offers nothing');
  assert.equal(H.offersRefetch({ state: 'failed', canRefetch: 'true' }), false);
  for (const state of ['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying', 'succeeded']) {
    assert.equal(H.offersRefetch({ state, canRefetch: true }), false, state);
  }
  assert.equal(H.offersRefetch(null), false);
  assert.equal(H.refetchTitle({ providerLabel: 'WaveSpeed' }), 'WaveSpeed에 남아 있는 결과를 다시 받아 옵니다. 새로 만들지 않아 요금이 더 나가지 않습니다.');
  assert.equal(H.refetchTitle({ providerLabel: null }), 'AI 서비스에 남아 있는 결과를 다시 받아 옵니다. 새로 만들지 않아 요금이 더 나가지 않습니다.');
  // With credits on, a job whose credits were given back takes them again (billing.refetchCredits): the tooltip says so.
  const account = { enabled: true, mode: 'enabled', balance: 1234 };
  const refunded = (refetchCredits, over = {}) => ({
    providerLabel: 'WaveSpeed', billing: { credits: 600, refunded: true, cancelRefund: false, refetchCredits }, ...over,
  });
  assert.equal(H.refetchTitle(refunded(600), account), 'WaveSpeed에 남아 있는 결과를 다시 받아 옵니다. 돌려받은 600 크레딧이 다시 차감됩니다.');
  assert.equal(H.refetchTitle(refunded(1500), account), 'WaveSpeed에 남아 있는 결과를 다시 받아 옵니다. 돌려받은 1,500 크레딧이 다시 차감됩니다.');
  assert.equal(H.refetchTitle(refunded(600, { providerLabel: null }), account), 'AI 서비스에 남아 있는 결과를 다시 받아 옵니다. 돌려받은 600 크레딧이 다시 차감됩니다.');
  // Before GET /api/billing answers the account counts as paying (the server charges).
  assert.equal(H.refetchTitle(refunded(600)), 'WaveSpeed에 남아 있는 결과를 다시 받아 옵니다. 돌려받은 600 크레딧이 다시 차감됩니다.');
  // Nothing to take again: the text above.
  const unchanged = 'WaveSpeed에 남아 있는 결과를 다시 받아 옵니다. 새로 만들지 않아 요금이 더 나가지 않습니다.';
  for (const [job, viewer] of [[refunded(0), account], [refunded(undefined), account],
    [{ providerLabel: 'WaveSpeed', billing: null }, account]]) {
    assert.equal(H.refetchTitle(job, viewer), unchanged, JSON.stringify([job, viewer]));
  }
  // The tooltip and the 다시 받기 question share one rule.
  assert.equal(H.refetchChargeCredits(refunded(600), account), 600);
  assert.equal(H.refetchChargeCredits(refunded(0), account), 0);
  assert.equal(H.refetchChargeCredits(null, account), 0);

  // jobActions lives inside the page script (DOM only): check it is gated by the helper
  // and re-rendered when canRefetch or the request state changes.
  const js = fsSync.readFileSync(path.join(__dirname, '..', 'public', 'animate.js'), 'utf8');
  assert.match(js, /if \(!H\.offersRefetch\(job\)\) return \[\];/);
  assert.match(js, /text: refetchBusyNow \? '다시 받는 중…' : '다시 받기'/);
  assert.match(js, /job\.canRefetch === true, refetchBusy\.has\(job\.id\), refetchErrors\.get\(job\.id\) \|\| null\]/);
  // The tooltip follows the account and redraws when its text changes.
  assert.match(js, /title: H\.refetchTitle\(job, state\.billing\),/);
  assert.match(js, /H\.offersRefetch\(job\) \? H\.refetchTitle\(job, state\.billing\) : null,\s*job\.canRefetch === true/);
});
