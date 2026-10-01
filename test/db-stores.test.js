'use strict';

// The database-backed stores: the credit ledger tables, the activity table, and the one-time
// import of what an earlier file-based server left behind (a Railway volume). Needs Postgres:
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/vtest node --test --test-concurrency=1 test/db-stores.test.js
// (one at a time: the test files share one database and empty its tables.)

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { openDocs } = require('../lib/docs');
const ledgers = require('../lib/billing/ledger');
const { createActivityLog } = require('../lib/activity');
const { createAppServer } = require('../server');

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-db-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function freshDatabase() {
  const docs = await openDocs({ databaseUrl: DATABASE_URL, root: os.tmpdir() });
  await docs.pool.query(`drop table if exists virtually.ledger_users, virtually.ledger_entries, virtually.ledger_orders,
    virtually.ledger_webhooks, virtually.activity_events`);
  await docs.pool.query('truncate virtually.documents, virtually.meta');
  await docs.close();
}

async function open(root) {
  const docs = await openDocs({ databaseUrl: DATABASE_URL, root });
  cleanups.push(() => docs.close().catch(() => {}));
  return docs;
}

const NOW = '2026-10-01T00:00:00.000Z';

test('ledger: a charge, a refund and an admin top-up are rows, and survive a restart on an empty disk', { skip }, async () => {
  await freshDatabase();
  const dir1 = await tempDir();
  const docs1 = await open(dir1);
  const ledger1 = await ledgers.openLedger(path.join(dir1, 'billing'), { docs: docs1 });
  await ledger1.mutate(draft => {
    ledgers.touchUser(draft, 'u1', 'a@x.com', { name: 'A', nowIso: NOW });
    ledgers.adjustCredits(draft, { email: 'a@x.com', credits: 100, label: 'top', by: 'admin', requestId: 'r1', nowIso: NOW });
  });
  let chargeId;
  await ledger1.mutate(draft => {
    const result = ledgers.chargeCredits(draft, { sub: 'u1', email: 'a@x.com', credits: 30, label: 'job', jobId: 'j1', nowIso: NOW });
    chargeId = result.chargeId;
    assert.equal(result.ok, true);
  });
  await ledger1.mutate(draft => { ledgers.refundCharge(draft, { chargeId, nowIso: NOW }); });
  await ledger1.mutate(draft => { ledgers.recordWebhook(draft, 'wh1', Date.parse(NOW)); });
  await ledger1.close();

  const rows = (await docs1.pool.query('select kind, delta, sub from virtually.ledger_entries order by seq')).rows;
  assert.deepEqual(rows.map(r => [r.kind, Number(r.delta), r.sub]), [['topup', 100, 'u1'], ['charge', -30, 'u1'], ['refund', 30, 'u1']]);
  assert.equal((await docs1.pool.query('select count(*)::int n from virtually.ledger_users')).rows[0].n, 1);
  assert.equal((await docs1.pool.query('select count(*)::int n from virtually.ledger_webhooks')).rows[0].n, 1);

  const dir2 = await tempDir(); // a new container
  const docs2 = await open(dir2);
  const ledger2 = await ledgers.openLedger(path.join(dir2, 'billing'), { docs: docs2 });
  const state = ledger2.read();
  assert.equal(ledgers.balanceOf(state, 'u1'), 100);
  assert.deepEqual(ledgers.historyOf(state, 'u1').map(e => e.kind), ['refund', 'charge', 'topup']);
  assert.equal(state.users.u1.email, 'a@x.com');
  await ledger2.close();
});

test('ledger: claiming a pending admin entry edits it in place and keeps the order', { skip }, async () => {
  await freshDatabase();
  const dir = await tempDir();
  const docs = await open(dir);
  const ledger = await ledgers.openLedger(path.join(dir, 'billing'), { docs });
  await ledger.mutate(draft => {
    ledgers.adjustCredits(draft, { email: 'new@x.com', credits: 50, label: 'pending', by: 'admin', requestId: 'r1', nowIso: NOW });
    ledgers.adjustCredits(draft, { email: 'other@x.com', credits: 5, label: 'other', by: 'admin', requestId: 'r2', nowIso: NOW });
  });
  await ledger.mutate(draft => { ledgers.claimAdminEntries(draft, 'u9', 'new@x.com'); });
  await ledger.close();
  const rows = (await docs.pool.query('select sub, data->>\'email\' email from virtually.ledger_entries order by seq')).rows;
  assert.deepEqual(rows.map(r => [r.sub, r.email]), [['u9', 'new@x.com'], [null, 'other@x.com']]);
});

test('ledger: a save that fails changes nothing and billing keeps its balance', { skip }, async () => {
  await freshDatabase();
  const dir = await tempDir();
  const docs = await open(dir);
  const ledger = await ledgers.openLedger(path.join(dir, 'billing'), { docs });
  await ledger.mutate(draft => { ledgers.adjustCredits(draft, { email: 'a@x.com', credits: 10, label: 't', by: 'admin', requestId: 'r1', nowIso: NOW }); });
  // Two entries with one id cannot be written.
  await assert.rejects(() => ledger.mutate(draft => { draft.entries.push({ ...draft.entries[0] }); }), /share the id/);
  assert.equal(ledger.read().entries.length, 1);
  assert.equal((await docs.pool.query('select count(*)::int n from virtually.ledger_entries')).rows[0].n, 1);
  await ledger.close();
});

test('ledger: the earlier ledger.json (file, or the document row) is taken over once', { skip }, async () => {
  for (const source of ['file', 'document']) {
    await freshDatabase();
    const dir = await tempDir();
    const earlier = {
      version: 1,
      users: { u1: { email: 'a@x.com', name: 'A' } },
      entries: [{ id: 'e1', at: NOW, sub: 'u1', delta: 70, kind: 'topup', label: 'x', email: 'a@x.com', by: 'admin', requestId: 'r' }],
      orders: { o1: { sub: 'u1', email: 'a@x.com', checkoutId: 'c1', customerId: 'k', granted: 70, revoked: 0 } },
      webhooks: { w1: Date.parse(NOW) },
    };
    const file = path.join(dir, 'billing', 'ledger.json');
    const docs = await open(dir);
    if (source === 'file') {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(earlier));
    } else {
      await docs.pool.query('insert into virtually.documents (key, value) values ($1, $2::jsonb)', ['billing/ledger.json', JSON.stringify(earlier)]);
    }
    const ledger = await ledgers.openLedger(path.join(dir, 'billing'), { docs });
    assert.equal(ledgers.balanceOf(ledger.read(), 'u1'), 70, source);
    assert.deepEqual(ledger.read().orders.o1.granted, 70);
    await ledger.close();

    // Taken over once: changing the earlier file afterwards changes nothing.
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ ...earlier, entries: [] }));
    const again = await ledgers.openLedger(path.join(dir, 'billing'), { docs });
    assert.equal(ledgers.balanceOf(again.read(), 'u1'), 70, `${source} again`);
    await again.close();
  }
});

test('ledger: a database record and a disk file that disagree lock billing instead of picking one', { skip }, async () => {
  await freshDatabase();
  const dir = await tempDir();
  const docs = await open(dir);
  const base = { version: 1, users: {}, orders: {}, webhooks: {} };
  const entry = { id: 'e1', at: NOW, sub: 'u1', delta: 5, kind: 'topup', label: 'x', email: 'a@x.com', by: 'a', requestId: 'r' };
  await docs.pool.query('insert into virtually.documents (key, value) values ($1, $2::jsonb)', ['billing/ledger.json', JSON.stringify({ ...base, entries: [] })]);
  const file = path.join(dir, 'billing', 'ledger.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...base, entries: [entry] }));
  const logs = [];
  const locked = await ledgers.openLedger(path.join(dir, 'billing'), { docs, log: line => logs.push(line) });
  assert.throws(() => locked.read(), /unreadable/);
  assert.ok(logs.some(line => line.includes('different contents')));
  // Removing the stale record resolves it: the file's history is taken over.
  await docs.pool.query("delete from virtually.documents where key = 'billing/ledger.json'");
  const fixed = await ledgers.openLedger(path.join(dir, 'billing'), { docs });
  assert.equal(ledgers.balanceOf(fixed.read(), 'u1'), 5);
  await fixed.close();
});

test('ledger: an unreachable database locks billing instead of starting empty', { skip }, async () => {
  const dir = await tempDir();
  const docs = await open(dir);
  await docs.pool.end();
  const logs = [];
  const ledger = await ledgers.openLedger(path.join(dir, 'billing'), { docs, log: line => logs.push(line) });
  assert.throws(() => ledger.read(), /unreadable/);
  assert.ok(logs.some(line => line.includes('stays locked')));
});

test('activity: events are rows, ordered, and the earlier events.jsonl is imported once', { skip }, async () => {
  await freshDatabase();
  const dir = await tempDir();
  const earlier = [
    { id: 'old1', ts: '2026-09-01T00:00:00.000Z', actor: { sub: 'u1', email: 'a@x.com', name: 'A' }, type: 'character.create', characterId: 'c1', characterName: 'Mia' },
    { id: 'old2', ts: '2026-09-02T00:00:00.000Z', actor: { sub: 'u1', email: 'a@x.com', name: 'A' }, type: 'photo.add', photoId: 'p1' },
  ];
  await fs.mkdir(path.join(dir, 'activity'), { recursive: true });
  await fs.writeFile(path.join(dir, 'activity', 'events.jsonl'), `${earlier.map(e => JSON.stringify(e)).join('\n')}\n{"torn`);
  const docs = await open(dir);
  const log1 = await createActivityLog({ dataDir: dir, docs });
  assert.equal(log1.ownerOf('character', 'c1'), 'a@x.com');
  log1.record({ session: { sub: 'u2', email: 'b@x.com', name: 'B' } }, 'job.create', { jobId: 'j1' });
  await log1.flush();

  const dir2 = await tempDir(); // a new container: no file at all
  const log2 = await createActivityLog({ dataDir: dir2, docs: await open(dir2) });
  assert.deepEqual(log2.list().map(e => e.id).length, 3);
  assert.deepEqual(log2.list({ limit: 1 })[0].type, 'job.create');
  assert.equal(log2.ownerOf('job', 'j1'), 'b@x.com');
  assert.equal((await docs.pool.query('select count(*)::int n from virtually.activity_events')).rows[0].n, 3);
});

test('docs: a record only the old disk has is imported on first read; children include it', { skip }, async () => {
  await freshDatabase();
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'users', 'u1'), { recursive: true });
  await fs.writeFile(path.join(dir, 'users', 'u1', 'library.json'), JSON.stringify({ idle: null, motions: [{ id: 'm' }], idles: {} }));
  const docs = await open(dir);
  assert.deepEqual(await docs.children(path.join(dir, 'users')), ['u1']);
  assert.deepEqual((await docs.read(path.join(dir, 'users', 'u1', 'library.json'))).motions, [{ id: 'm' }]);
  await fs.rm(path.join(dir, 'users'), { recursive: true });
  assert.deepEqual((await docs.read(path.join(dir, 'users', 'u1', 'library.json'))).motions, [{ id: 'm' }]); // now from the row
  assert.deepEqual(await docs.children(path.join(dir, 'users')), ['u1']);
  await docs.remove(path.join(dir, 'users', 'u1', 'library.json'));
  assert.equal(await docs.read(path.join(dir, 'users', 'u1', 'library.json')), null);
});

test('server: a site that ran on files comes up on an empty database with its data', { skip }, async () => {
  await freshDatabase();
  const dir = await tempDir();
  // What the file-based server left on the volume.
  const user = path.join(dir, 'users', 'g123');
  await fs.mkdir(path.join(user, 'characters'), { recursive: true });
  await fs.writeFile(path.join(dir, 'obs-source.json'), JSON.stringify({ width: 1920, height: 1080 }));
  await fs.writeFile(path.join(user, 'owner.json'), JSON.stringify({ sub: 'g123', email: 'a@x.com', name: 'A' }));
  const docs = await open(dir);
  const server = await createAppServer({ dataDir: dir, docs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/obs-source`)).json(), { width: 1920, height: 1080 });
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 200));
  const check = await open(dir); // the server closed its own connection
  const rows = (await check.pool.query('select key from virtually.documents order by key')).rows.map(r => r.key);
  assert.ok(rows.includes('obs-source.json'), rows.join());
  assert.ok(rows.includes('users/g123/owner.json'), rows.join());
});
