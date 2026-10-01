#!/usr/bin/env node
'use strict';

// Copies the JSON records under a data directory into Postgres (virtually.documents).
//
//   DATABASE_URL=postgres://... node scripts/migrate-to-db.js [dataDir] [--dry-run] [--overwrite]
//
// Copied: auth/state.json, billing/ledger.json (into the ledger_* tables), activity/events.jsonl
// (into activity_events), obs-source.json, library.json,
// characters/index.json, owner.json, animate/jobs/<id>/job.json,
// animate/drivings/uploads/<id>/meta.json, animate/drivings/hidden-examples.json
// (for the single-user layout and for every users/<id>/ workspace).
// Not copied: the admin-written config.json files (they hold provider and payment
// secrets), probe caches, and media files.
// Records already in the database are kept unless --overwrite is given, so running
// it twice, or after the server has started on the database, is safe. (The server also
// imports a missing record from its file by itself the first time it needs it; this script
// is for doing it up front, for checking with --dry-run, and for --overwrite when the
// server already started on an empty database and made fresh records.)
// --overwrite on the ledger replaces every ledger row: stop the server first.

const fs = require('node:fs');
const path = require('node:path');

const { openDocs } = require('../lib/docs');
const { createPostgresLedgerStore } = require('../lib/billing/ledger-store');
const { normalizeLedger } = require('../lib/billing/ledger');
const { createPostgresStore } = require('../lib/activity');

const FIXED = [
  'auth/state.json', 'obs-source.json', 'library.json', 'characters/index.json', 'owner.json',
  'animate/drivings/hidden-examples.json',
];

function jsonIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Every record file of one workspace root (relative paths with '/').
function recordsOf(root) {
  const found = [];
  for (const rel of FIXED) if (fs.existsSync(path.join(root, rel))) found.push(rel);
  for (const entry of jsonIn(path.join(root, 'animate', 'jobs'))) {
    const rel = `animate/jobs/${entry.name}/job.json`;
    if (entry.isDirectory() && fs.existsSync(path.join(root, rel))) found.push(rel);
  }
  for (const entry of jsonIn(path.join(root, 'animate', 'drivings', 'uploads'))) {
    const rel = `animate/drivings/uploads/${entry.name}/meta.json`;
    if (entry.isDirectory() && fs.existsSync(path.join(root, rel))) found.push(rel);
  }
  return found;
}

// billing/ledger.json -> the ledger tables.
async function copyLedger(docs, root, { dryRun, overwrite }) {
  const file = path.join(root, 'billing', 'ledger.json');
  if (!fs.existsSync(file)) return 'none';
  const ledger = normalizeLedger(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!ledger) throw new Error('billing/ledger.json is not a ledger');
  const store = createPostgresLedgerStore(docs.pool, { legacy: async () => null, normalize: normalizeLedger });
  const existing = await store.load();
  const rows = existing ? existing.entries.length + Object.keys(existing.users).length : 0;
  if (rows && !overwrite) {
    console.log(`keep   billing/ledger.json (the database already has ${existing.entries.length} entries, ${Object.keys(existing.users).length} users)`);
    return 'kept';
  }
  console.log(`${dryRun ? 'would copy' : 'copy  '} billing/ledger.json (${ledger.entries.length} entries, ${Object.keys(ledger.users).length} users)${rows ? ' replacing the database rows' : ''}`);
  if (!dryRun) {
    if (rows) await store.replaceAll(ledger);
    else {
      // An empty table set: the store's own first load imports it.
      await createPostgresLedgerStore(docs.pool, { legacy: async () => ledger, normalize: normalizeLedger }).load();
    }
  }
  return 'copied';
}

// activity/events.jsonl -> activity_events (events already there are skipped by id).
async function copyActivity(docs, root, { dryRun }) {
  const file = path.join(root, 'activity', 'events.jsonl');
  if (!fs.existsSync(file)) return 'none';
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  console.log(`${dryRun ? 'would copy' : 'copy  '} activity/events.jsonl (${events.length} events; ones already in the database are skipped)`);
  if (!dryRun) {
    const store = createPostgresStore(docs.pool, path.join(root, 'activity'));
    await store.load(); // creates the table
    await store.insertAll(events);
  }
  return 'copied';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const overwrite = args.includes('--overwrite');
  const dataDir = path.resolve(args.find(arg => !arg.startsWith('--')) || path.join(__dirname, '..', 'data'));
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL.');
  if (!fs.existsSync(dataDir)) throw new Error(`No such directory: ${dataDir}`);

  const roots = [dataDir];
  for (const entry of jsonIn(path.join(dataDir, 'users'))) if (entry.isDirectory() && !entry.name.endsWith('.tmp')) roots.push(path.join(dataDir, 'users', entry.name));

  const docs = await openDocs({ root: dataDir, log: console.warn });
  const count = { copied: 0, kept: 0, failed: 0 };
  try {
    for (const root of roots) {
      for (const [name, copy] of [['ledger', copyLedger], ['activity', copyActivity]]) {
        try {
          const result = await copy(docs, root, { dryRun, overwrite });
          if (result === 'copied') count.copied++;
          else if (result === 'kept') count.kept++;
        } catch (error) {
          console.warn(`skip ${name} of ${path.relative(dataDir, root) || '.'}: ${error.message}`);
          count.failed++;
        }
      }
      for (const rel of recordsOf(root)) {
        const file = path.join(root, rel);
        const label = path.relative(dataDir, file);
        let value;
        try {
          value = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
          console.warn(`skip ${label}: ${error.message}`);
          count.failed++;
          continue;
        }
        if (!overwrite && await docs.read(file) !== null) {
          console.log(`keep   ${label} (already in the database)`);
          count.kept++;
          continue;
        }
        console.log(`${dryRun ? 'would copy' : 'copy  '} ${label}`);
        if (!dryRun) await docs.write(file, value);
        count.copied++;
      }
    }
  } finally {
    await docs.close();
  }
  console.log(`${dryRun ? 'Dry run: ' : ''}${count.copied} copied, ${count.kept} kept, ${count.failed} skipped.`);
  if (count.failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
