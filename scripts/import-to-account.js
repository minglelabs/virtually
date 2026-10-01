#!/usr/bin/env node
'use strict';

// Moves a local (login-off) data directory into one Google account's workspace on the
// deployed site, so the characters, motions, driving videos and animate jobs made locally
// show up in that account on the web.
//
//   node scripts/import-to-account.js --email <address> [--from <dataDir>] [--overwrite] [--apply] [<path>...]
//
// The account is the one that already signed in with that address (its users/<id>/owner.json
// is in the database). <path> is relative to --from (default data/); without any, the whole
// workspace is taken: characters, library.json, media, animate/drivings/uploads, animate/jobs.
//
//   records  characters/index.json, library.json, animate/jobs/<id>/job.json,
//            animate/drivings/uploads/<id>/meta.json   -> rows of the database (DATABASE_URL)
//   files    everything else (photos, motions, videos) -> R2 (R2_*), under users/<id>/<same path>
//
// Without --apply nothing is written. Media goes first and is read back (size and MD5); the
// records are written only when every file arrived. A record the account already has is kept
// (reported), --overwrite replaces it. Never imported: obs-source.json (the account's OBS URL key),
// owner.json, auth/, billing/, activity/ and animate/config.json. Nothing is ever deleted.
//
// The running server keeps an account's records in memory once it has opened it: restart the
// service after an import so it picks the new records and media up.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { loadDotEnv } = require('../lib/env');
const { openDocs } = require('../lib/docs');
const { storeFromEnv, safeKey } = require('../lib/blobs');
const { filesUnder, md5Of, compareRemote, uploadVerified } = require('../lib/transfer');

const DEFAULT_PATHS = ['characters', 'library.json', 'media', 'animate/drivings/uploads', 'animate/jobs'];
const RECORDS = [
  /^characters\/index\.json$/, /^library\.json$/,
  /^animate\/jobs\/[^/]+\/job\.json$/, /^animate\/drivings\/uploads\/[^/]+\/meta\.json$/,
];
const NEVER = [/^obs-source\.json$/, /^owner\.json$/, /^(auth|billing|activity)\//, /^animate\/config\.json$/];

const isRecord = rel => RECORDS.some(pattern => pattern.test(rel));

// What a new account starts with: not worth keeping over an import.
function isBlank(rel, value) {
  if (rel === 'characters/index.json') return !value || !Array.isArray(value.characters) || value.characters.length === 0;
  if (rel === 'library.json') return !value || (!(value.motions || []).length && !Object.keys(value.idles || {}).length && !value.idle);
  return !value;
}
const isNever = rel => NEVER.some(pattern => pattern.test(rel));

// The account that signed in with `email` -> { dir, owner }. `docs` addresses records by path
// under `virtualRoot` (its keys are relative to it), as the server does under its data directory.
async function findAccount({ docs, virtualRoot, email }) {
  const wanted = String(email).trim().toLowerCase();
  const found = [];
  for (const dir of await docs.children(path.join(virtualRoot, 'users'))) {
    const owner = await docs.read(path.join(virtualRoot, 'users', dir, 'owner.json'));
    if (owner && String(owner.email || '').trim().toLowerCase() === wanted) found.push({ dir, owner });
  }
  if (!found.length) throw new Error(`No account that signed in with ${email} was found: sign in to the site once with it first.`);
  if (found.length > 1) throw new Error(`More than one account matches ${email}.`);
  if (!safeKey(found[0].dir)) throw new Error('The account folder name is not usable.');
  return found[0];
}

// -> { files, bytes, media: {added, same, differs, failed}, records: {added, kept, replaced, skipped} } (lists of paths)
async function importToAccount({ docs, store, virtualRoot, from, accountDir, paths = DEFAULT_PATHS, apply = false, overwrite = false, log = () => {} }) {
  const base = path.resolve(from);
  const report = {
    files: 0, bytes: 0,
    media: { added: [], same: [], differs: [], failed: [] },
    records: { added: [], kept: [], replaced: [], skipped: [] },
  };
  const media = [];
  const records = [];
  for (const given of paths) {
    const target = path.resolve(base, given);
    const relToBase = path.relative(base, target);
    if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) throw new Error(`${given} is not inside --from (${base}).`);
    const exists = await fsp.stat(target).catch(() => null);
    if (!exists) {
      // The default set names things a given data directory may not have.
      if (paths === DEFAULT_PATHS) continue;
      throw new Error(`${given} does not exist under ${base}.`);
    }
    for await (const file of filesUnder(target)) {
      const rel = path.relative(base, file).split(path.sep).join('/');
      if (isNever(rel)) {
        report.records.skipped.push(rel);
        log(`skipped   ${rel} (never imported)`);
        continue;
      }
      const { size } = await fsp.stat(file);
      report.files++;
      report.bytes += size;
      (isRecord(rel) ? records : media).push({ rel, file, size });
    }
  }

  // Files first: a record must never point at a file that did not arrive.
  for (const { rel, file, size } of media) {
    const key = `users/${accountDir}/${rel}`;
    if (!safeKey(key)) throw new Error(`Not a usable object key: ${key}`);
    const md5 = await md5Of(file);
    const { state, remote } = await compareRemote(store, key, size, md5);
    if (state === 'same') {
      report.media.same.push(rel);
      log(`same      ${key}`);
    } else if (state === 'differs' && !overwrite) {
      report.media.differs.push(rel);
      log(`DIFFERS   ${key} (the bucket has ${remote.size} bytes; kept, --overwrite replaces it)`);
    } else if (!apply) {
      report.media.added.push(rel);
      log(`would add ${key} (${size} bytes)`);
    } else {
      try {
        await uploadVerified(store, key, file, size, md5);
        report.media.added.push(rel);
        log(`stored    ${key} (${size} bytes, verified)`);
      } catch (error) {
        report.media.failed.push(rel);
        log(`FAILED    ${key}: ${error.message}`);
      }
    }
  }
  const mediaOk = !report.media.failed.length && (!report.media.differs.length || overwrite);

  for (const { rel, file } of records) {
    const recordPath = path.join(virtualRoot, 'users', accountDir, ...rel.split('/'));
    const value = JSON.parse(await fsp.readFile(file, 'utf8'));
    const stored = await docs.read(recordPath);
    const existing = isBlank(rel, stored) ? null : stored;
    if (existing && !overwrite) {
      report.records.kept.push(rel);
      log(`kept      record ${rel} (the account already has it; --overwrite replaces it)`);
      continue;
    }
    if (!apply) {
      (existing ? report.records.replaced : report.records.added).push(rel);
      log(`would ${existing ? 'replace' : 'add'} record ${rel}`);
      continue;
    }
    if (!mediaOk) {
      report.records.skipped.push(rel);
      log(`skipped   record ${rel} (a file did not arrive; fix that and run again)`);
      continue;
    }
    await docs.write(recordPath, value);
    (existing ? report.records.replaced : report.records.added).push(rel);
    log(`${existing ? 'replaced' : 'wrote'}   record ${rel}`);
  }
  return report;
}

function parseArgs(argv) {
  const options = { email: null, from: path.join(__dirname, '..', 'data'), apply: false, overwrite: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value.`);
      return argv[++i];
    };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--email') options.email = value();
    else if (arg === '--from') options.from = value();
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else options.paths.push(arg);
  }
  return options;
}

const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

async function main(argv) {
  loadDotEnv();
  const options = parseArgs(argv);
  if (!options.email) throw new Error('Say whose account: --email <address>.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set (in the environment or in .env).');
  const store = storeFromEnv();
  if (!store) throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must be set (in the environment or in .env).');
  // Record keys are paths under this folder; it is never read, so a missing one is right.
  const virtualRoot = path.join(os.tmpdir(), 'virtually-import-root');
  const docs = await openDocs({ root: virtualRoot });
  try {
    const { dir, owner } = await findAccount({ docs, virtualRoot, email: options.email });
    console.log(`Account ${dir}${owner.name ? ` (${owner.name})` : ''}, ${options.apply ? 'writing' : 'dry run'}.\n`);
    const report = await importToAccount({
      docs, store, virtualRoot, from: options.from, accountDir: dir,
      paths: options.paths.length ? options.paths : DEFAULT_PATHS, apply: options.apply, overwrite: options.overwrite, log: line => console.log(line),
    });
    const { media, records } = report;
    console.log(`\n${report.files} file(s), ${mb(report.bytes)}. Files: ${media.added.length} ${options.apply ? 'stored' : 'to add'}, ${media.same.length} already there, ${media.differs.length} differ, ${media.failed.length} failed.`
      + ` Records: ${records.added.length} ${options.apply ? 'written' : 'to add'}, ${records.replaced.length} ${options.apply ? 'replaced' : 'to replace'}, ${records.kept.length} kept.`);
    if (!options.apply) console.log('Dry run: nothing was written. Add --apply to import.');
    else console.log('Restart the service so it opens the account with the new records.');
    return media.failed.length || media.differs.length ? 1 : 0;
  } finally {
    await docs.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    const denied = /AccessDenied|Access Denied|Unauthorized|403/.test(`${error.name} ${error.message}`);
    console.error(`${error.message}${denied ? '\nThe R2 token has no access to this bucket: give it Object Read & Write on R2_BUCKET.' : ''}`);
    process.exitCode = 1;
  });
}

module.exports = { importToAccount, findAccount, parseArgs, DEFAULT_PATHS };
