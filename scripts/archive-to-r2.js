#!/usr/bin/env node
'use strict';

// A long-term shelf in the R2 bucket for files that are hard to make again: reference
// (driving) videos and finished Wan results. They go under archive/, which the server's
// mirror (lib/blobs.js) never downloads at start and never removes, so the shelf does not
// grow what every container restores, and a pass of the mirror cannot touch it.
//
//   node scripts/archive-to-r2.js [--root <dir>] [--prefix <name>] [--overwrite] [--apply] <file-or-dir>...
//   node scripts/archive-to-r2.js --list [--prefix <name>]
//   node scripts/archive-to-r2.js --restore <dir> [--prefix <name>]
//
// Uploads: object key = archive/<prefix>/<path relative to --root> (root defaults to data/).
// Without --apply nothing is written: it only says what it would do. Every uploaded
// object is read back (size and MD5) before it counts as stored. An object that already
// exists with the same content is left alone; one with different content is reported and
// kept as it is unless --overwrite is given. It never deletes anything.
//
// R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET come from the
// environment or the repo's .env. The token needs Object Read & Write on the bucket.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadDotEnv } = require('../lib/env');
const { storeFromEnv, safeKey } = require('../lib/blobs');
const { filesUnder, md5Of, compareRemote, uploadVerified } = require('../lib/transfer');

const SHELF = 'archive';

function keyFor(prefix, rel) {
  return [SHELF, prefix, rel].filter(Boolean).join('/');
}

// -> { files, bytes, uploaded, same, differs, failed } (each a list of keys, except the first two).
// `apply` false: decide only. `store` needs list/head/upload.
async function archive({ store, root, prefix = '', paths, apply = false, overwrite = false, log = () => {} }) {
  const base = path.resolve(root);
  const report = { files: 0, bytes: 0, uploaded: [], same: [], differs: [], failed: [], pending: [] };
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  if (cleanPrefix && !safeKey(cleanPrefix)) throw new Error(`Not a usable --prefix: ${prefix}`);
  for (const given of paths) {
    const target = path.resolve(given);
    const relToRoot = path.relative(base, target);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new Error(`${given} is not inside --root (${base}).`);
    for await (const file of filesUnder(target)) {
      const rel = path.relative(base, file).split(path.sep).join('/');
      const key = keyFor(cleanPrefix, rel);
      if (!safeKey(key)) throw new Error(`Not a usable object key: ${key}`);
      const { size } = await fsp.stat(file);
      report.files++;
      report.bytes += size;
      const md5 = await md5Of(file);
      const { state, remote } = await compareRemote(store, key, size, md5);
      if (state === 'same') {
        report.same.push(key);
        log(`same      ${key}`);
        continue;
      }
      if (state === 'differs' && !overwrite) {
        report.differs.push(key);
        log(`DIFFERS   ${key} (the bucket has ${remote.size} bytes; kept as it is, --overwrite replaces it)`);
        continue;
      }
      if (!apply) {
        report.pending.push(key);
        log(`would add ${key} (${size} bytes)`);
        continue;
      }
      try {
        await uploadVerified(store, key, file, size, md5);
        report.uploaded.push(key);
        log(`stored    ${key} (${size} bytes, verified)`);
      } catch (error) {
        report.failed.push(key);
        log(`FAILED    ${key}: ${error.message}`);
      }
    }
  }
  return report;
}

// Everything on the shelf (under the prefix) -> [{ key, size }].
async function shelf({ store, prefix = '' }) {
  const start = `${keyFor(prefix.replace(/^\/+|\/+$/g, ''), '')}/`;
  return (await store.list()).filter(item => item.key.startsWith(start));
}

// Downloads the shelf (under the prefix) into `dir`, keeping the paths below archive/<prefix>/.
// A file that is already there with the same size is skipped; none is overwritten.
async function restore({ store, dir, prefix = '', log = () => {} }) {
  const start = `${keyFor(prefix.replace(/^\/+|\/+$/g, ''), '')}/`;
  const result = { restored: [], skipped: [] };
  for (const { key, size } of await shelf({ store, prefix })) {
    if (!safeKey(key)) continue;
    const file = path.join(dir, ...key.slice(start.length).split('/'));
    const existing = await fsp.stat(file).catch(() => null);
    if (existing) {
      result.skipped.push(key);
      log(`exists    ${file}${existing.size === size ? '' : ' (different size, left alone)'}`);
      continue;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await store.download(key, tmp);
      await fsp.rename(tmp, file);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
    result.restored.push(key);
    log(`restored  ${file}`);
  }
  return result;
}

function parseArgs(argv) {
  const options = { root: path.join(__dirname, '..', 'data'), prefix: '', apply: false, overwrite: false, list: false, restore: null, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value.`);
      return argv[++i];
    };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--restore') options.restore = value();
    else if (arg === '--root') options.root = value();
    else if (arg === '--prefix') options.prefix = value();
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else options.paths.push(arg);
  }
  return options;
}

const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

async function main(argv) {
  loadDotEnv();
  const options = parseArgs(argv);
  const store = storeFromEnv();
  if (!store) throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must be set (in the environment or in .env).');
  const log = line => console.log(line);

  if (options.list) {
    const items = await shelf({ store, prefix: options.prefix });
    for (const item of items) console.log(`${String(item.size).padStart(11)}  ${item.key}`);
    console.log(`${items.length} object(s), ${mb(items.reduce((sum, item) => sum + item.size, 0))} on the shelf.`);
    return 0;
  }
  if (options.restore) {
    const { restored, skipped } = await restore({ store, dir: path.resolve(options.restore), prefix: options.prefix, log });
    console.log(`${restored.length} restored, ${skipped.length} already there.`);
    return 0;
  }
  if (!options.paths.length) throw new Error('Name the files or folders to archive (see the header of this script).');

  const report = await archive({ store, ...options, log });
  console.log(`\n${report.files} file(s), ${mb(report.bytes)}: ${report.uploaded.length} stored, ${report.same.length} already there, ${report.pending.length} to add, ${report.differs.length} differ, ${report.failed.length} failed.`);
  if (!options.apply && report.pending.length) console.log('Dry run: nothing was written. Add --apply to store them.');
  return report.failed.length || report.differs.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    const denied = /AccessDenied|Access Denied|Unauthorized|403/.test(`${error.name} ${error.message}`);
    console.error(`${error.message}${denied ? '\nThe R2 token has no access to this bucket: give it Object Read & Write on R2_BUCKET.' : ''}`);
    process.exitCode = 1;
  });
}

module.exports = { archive, restore, shelf, keyFor, parseArgs };
