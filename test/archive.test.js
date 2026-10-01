'use strict';

// scripts/archive-to-r2.js and the archive/ shelf, against an in-memory bucket.

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createMirror, createMemoryStore, mirrored } = require('../lib/blobs');
const { archive, restore, shelf, parseArgs } = require('../scripts/archive-to-r2');

const dirs = [];
after(async () => { for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }); });
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-archive-'));
  dirs.push(dir);
  return dir;
}
async function put(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function dataWithKeepers() {
  const root = await tempDir();
  await put(root, 'animate/drivings/uploads/up-1/video.mp4', 'driving video');
  await put(root, 'animate/drivings/uploads/up-1/meta.json', '{"label":"원영턴"}');
  await put(root, 'animate/jobs/j1/result.mp4', 'wan result');
  await put(root, 'animate/jobs/j1/.DS_Store', 'junk');
  await put(root, 'animate/jobs/other/result.mp4', 'not wanted');
  return root;
}

test('a dry run says what it would add and writes nothing', async () => {
  const root = await dataWithKeepers();
  const store = createMemoryStore();
  const lines = [];
  const report = await archive({ store, root, prefix: 'kpop', paths: [path.join(root, 'animate/drivings/uploads/up-1')], log: line => lines.push(line) });
  assert.equal(store.objects.size, 0);
  assert.deepEqual(report.pending.sort(), ['archive/kpop/animate/drivings/uploads/up-1/meta.json', 'archive/kpop/animate/drivings/uploads/up-1/video.mp4']);
  assert.equal(report.files, 2);
  assert.ok(lines.every(line => line.startsWith('would add')));
});

test('--apply stores the named folders under archive/<prefix>/ with their paths, verified, and skips dot files', async () => {
  const root = await dataWithKeepers();
  const store = createMemoryStore();
  const report = await archive({
    store, root, prefix: 'kpop', apply: true,
    paths: [path.join(root, 'animate/drivings/uploads/up-1'), path.join(root, 'animate/jobs/j1')],
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual([...store.objects.keys()].sort(), [
    'archive/kpop/animate/drivings/uploads/up-1/meta.json',
    'archive/kpop/animate/drivings/uploads/up-1/video.mp4',
    'archive/kpop/animate/jobs/j1/result.mp4',
  ]);
  assert.equal(store.objects.get('archive/kpop/animate/jobs/j1/result.mp4').toString(), 'wan result');
  assert.equal(store.contentTypes.get('archive/kpop/animate/jobs/j1/result.mp4'), 'video/mp4');
  assert.equal(store.contentTypes.get('archive/kpop/animate/drivings/uploads/up-1/meta.json'), 'application/json');
  assert.equal(report.uploaded.length, 3);

  // A second run finds everything there and does not upload again.
  const again = await archive({ store, root, prefix: 'kpop', apply: true, paths: [path.join(root, 'animate/jobs/j1')] });
  assert.deepEqual(again.uploaded, []);
  assert.deepEqual(again.same, ['archive/kpop/animate/jobs/j1/result.mp4']);
});

test('an object whose content differs is kept unless --overwrite; an upload that does not read back counts as failed', async () => {
  const root = await dataWithKeepers();
  const store = createMemoryStore();
  const paths = [path.join(root, 'animate/jobs/j1')];
  await archive({ store, root, apply: true, paths });
  await put(root, 'animate/jobs/j1/result.mp4', 'a different result');

  const kept = await archive({ store, root, apply: true, paths });
  assert.deepEqual(kept.differs, ['archive/animate/jobs/j1/result.mp4']);
  assert.equal(store.objects.get('archive/animate/jobs/j1/result.mp4').toString(), 'wan result');

  const replaced = await archive({ store, root, apply: true, overwrite: true, paths });
  assert.deepEqual(replaced.uploaded, ['archive/animate/jobs/j1/result.mp4']);
  assert.equal(store.objects.get('archive/animate/jobs/j1/result.mp4').toString(), 'a different result');

  // A store that loses the bytes is caught by the read-back.
  const lossy = createMemoryStore();
  lossy.upload = async () => {};
  const failed = await archive({ store: lossy, root, apply: true, paths });
  assert.deepEqual(failed.failed, ['archive/animate/jobs/j1/result.mp4']);
  assert.deepEqual(failed.uploaded, []);
});

test('a path outside --root is refused', async () => {
  const root = await dataWithKeepers();
  const elsewhere = await tempDir();
  await put(elsewhere, 'x.mp4', 'x');
  await assert.rejects(archive({ store: createMemoryStore(), root, paths: [elsewhere] }), /not inside --root/);
  await assert.rejects(archive({ store: createMemoryStore(), root, prefix: '../x', paths: [root] }), /Not a usable --prefix/);
});

test('the mirror neither downloads nor removes anything on the shelf', async () => {
  assert.equal(mirrored('archive/kpop/animate/jobs/j1/result.mp4'), false);
  const root = await tempDir();
  const store = createMemoryStore();
  store.objects.set('archive/kpop/a.mp4', Buffer.from('shelf'));
  store.objects.set('media/m.mp4', Buffer.from('media'));
  const mirror = createMirror({ root, store });
  await mirror.hydrate();
  assert.equal(await fs.readFile(path.join(root, 'media', 'm.mp4'), 'utf8'), 'media');
  assert.equal(await fs.stat(path.join(root, 'archive')).catch(() => null), null);

  await fs.rm(path.join(root, 'media', 'm.mp4'));
  await put(root, 'media/other.mp4', 'other');
  await mirror.flush({ force: true });
  assert.deepEqual([...store.objects.keys()].sort(), ['archive/kpop/a.mp4', 'media/other.mp4']);
});

test('list and restore: the shelf comes back as files, nothing is overwritten', async () => {
  const root = await dataWithKeepers();
  const store = createMemoryStore();
  await archive({ store, root, prefix: 'kpop', apply: true, paths: [path.join(root, 'animate/jobs/j1'), path.join(root, 'animate/drivings')] });
  store.objects.set('media/not-the-shelf.mp4', Buffer.from('x'));
  assert.equal((await shelf({ store })).length, 3);
  assert.equal((await shelf({ store, prefix: 'elsewhere' })).length, 0);

  const dir = await tempDir();
  const first = await restore({ store, dir, prefix: 'kpop' });
  assert.equal(first.restored.length, 3);
  assert.equal(await fs.readFile(path.join(dir, 'animate/jobs/j1/result.mp4'), 'utf8'), 'wan result');
  assert.equal(await fs.stat(path.join(dir, 'media')).catch(() => null), null);
  await put(dir, 'animate/jobs/j1/result.mp4', 'edited since');
  const second = await restore({ store, dir, prefix: 'kpop' });
  assert.equal(second.restored.length, 0);
  assert.equal(second.skipped.length, 3);
  assert.equal(await fs.readFile(path.join(dir, 'animate/jobs/j1/result.mp4'), 'utf8'), 'edited since');
});

test('command line: options, paths, and unknown flags', () => {
  const options = parseArgs(['--prefix', 'kpop', '--apply', '--root', '/r', 'a', 'b']);
  assert.equal(options.prefix, 'kpop');
  assert.equal(options.apply, true);
  assert.equal(options.root, '/r');
  assert.deepEqual(options.paths, ['a', 'b']);
  assert.equal(parseArgs(['--list']).apply, false);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['--prefix']), /needs a value/);
});
