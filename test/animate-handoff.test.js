'use strict';

// Two servers on one store (a redeploy's overlap): a job runs on the server that
// holds its lease; the other one watches it and takes it over once the lease is
// released or runs out, and picks up jobs created elsewhere.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { Pipeline } = require('../lib/animate/pipeline');

function stubDeps(dataDir, polls) {
  const adapter = {
    meta: { pollIntervalMs: 10 },
    // Never finishes: the test only needs to see who polls.
    async poll(ctx) { polls.count += 1; await new Promise(resolve => setTimeout(resolve, 5)); if (ctx.signal?.aborted) throw Object.assign(new Error('Canceled.'), { name: 'AbortError' }); return { status: 'running' }; },
  };
  return {
    dataDir,
    leases: true,
    watchMs: 60 * 60 * 1000, // driven by hand with watch()
    registry: { get: () => ({ id: 'stub/route', provider: 'stub' }), estimateUsd: () => null },
    configStore: {
      config: { concurrency: 2 },
      providers: { stub: adapter },
      resolvedCredentials: () => ({}), resolvedSettings: () => ({}), baseUrl: () => null, allowInsecure: () => false,
    },
  };
}

async function writeJob(dataDir, id, patch) {
  const dir = path.join(dataDir, 'animate', 'jobs', id);
  await fs.mkdir(dir, { recursive: true });
  const job = { id, state: 'running', routeId: 'stub/route', task: { id: 'task-1' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch };
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
}

async function readJob(dataDir, id) {
  return JSON.parse(await fs.readFile(path.join(dataDir, 'animate', 'jobs', id, 'job.json'), 'utf8'));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a job leased by a live server is watched, not run, and taken over when released', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-handoff-'));
  const id = '11111111-2222-4333-8444-555555555555';
  await writeJob(dataDir, id, { lease: { owner: 'old-server', until: Date.now() + 60000 } });
  const polls = { count: 0 };
  const changes = [];
  const pipeline = await new Pipeline({ ...stubDeps(dataDir, polls), instanceId: 'new-server', onChange: (job, info) => changes.push({ state: job.state, foreign: !!info?.foreign }) }).init();
  try {
    await wait(50);
    assert.equal(polls.count, 0, 'the other server runs it');
    assert.ok(pipeline.foreign.has(id));
    assert.equal(pipeline.get(id).state, 'running', 'still listed for the pages');

    // The old server writes progress: it reaches this server's pages, still not run here.
    await writeJob(dataDir, id, { progress: 0.5, updatedAt: new Date(Date.now() + 1000).toISOString(), lease: { owner: 'old-server', until: Date.now() + 60000 } });
    await pipeline.watch();
    assert.equal(pipeline.get(id).progress, 0.5);
    assert.deepEqual(changes.at(-1), { state: 'running', foreign: true });
    assert.equal(polls.count, 0);

    // Released (the old server's handoff): taken over and polled, never submitted again.
    await writeJob(dataDir, id, { lease: { owner: 'old-server', until: 0 } });
    await pipeline.watch();
    await wait(50);
    assert.ok(!pipeline.foreign.has(id));
    assert.ok(polls.count > 0, 'polling resumed here');
    assert.equal((await readJob(dataDir, id)).lease.owner, 'new-server');
  } finally {
    await pipeline.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('a job created by another server is picked up; an expired lease is taken over at once', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-handoff-'));
  const polls = { count: 0 };
  const pipeline = await new Pipeline({ ...stubDeps(dataDir, polls), instanceId: 'new-server' }).init();
  try {
    const live = 'aaaaaaaa-2222-4333-8444-555555555555';
    const dead = 'bbbbbbbb-2222-4333-8444-555555555555';
    await writeJob(dataDir, live, { lease: { owner: 'old-server', until: Date.now() + 60000 } });
    await writeJob(dataDir, dead, { lease: { owner: 'crashed-server', until: Date.now() - 1 } });
    await pipeline.watch();
    assert.ok(pipeline.get(live) && pipeline.foreign.has(live));
    assert.ok(pipeline.get(dead) && !pipeline.foreign.has(dead));
    await wait(50);
    assert.ok(polls.count > 0);
    assert.equal((await readJob(dataDir, dead)).lease.owner, 'new-server');
  } finally {
    await pipeline.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('handoff stops the jobs and releases their leases for the next server', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-handoff-'));
  const id = 'cccccccc-2222-4333-8444-555555555555';
  await writeJob(dataDir, id, {});
  const polls = { count: 0 };
  const pipeline = await new Pipeline({ ...stubDeps(dataDir, polls), instanceId: 'old-server' }).init();
  await wait(50);
  assert.ok(polls.count > 0);
  await pipeline.handoff();
  const stored = await readJob(dataDir, id);
  assert.equal(stored.state, 'running', 'left where it was');
  assert.deepEqual(stored.lease, { owner: 'old-server', until: 0 });

  const next = await new Pipeline({ ...stubDeps(dataDir, polls), instanceId: 'new-server' }).init();
  try {
    assert.ok(!next.foreign.has(id), 'a released job is run by the next server at once');
  } finally {
    await next.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
