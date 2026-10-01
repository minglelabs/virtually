#!/usr/bin/env node
'use strict';

// Copies the JSON records under a data directory into Postgres (virtually.documents).
//
//   DATABASE_URL=postgres://... node scripts/migrate-to-db.js [dataDir] [--dry-run] [--overwrite]
//
// Copied: auth/state.json, billing/ledger.json, obs-source.json, library.json,
// characters/index.json, owner.json, animate/jobs/<id>/job.json,
// animate/drivings/uploads/<id>/meta.json, animate/drivings/hidden-examples.json
// (for the single-user layout and for every users/<id>/ workspace).
// Not copied: the admin-written config.json files (they hold provider and payment
// secrets), the activity log, probe caches, and media files.
// Records already in the database are kept unless --overwrite is given, so running
// it twice, or after the server has started on the database, is safe.

const fs = require('node:fs');
const path = require('node:path');

const { openDocs } = require('../lib/docs');

const FIXED = [
  'auth/state.json', 'billing/ledger.json', 'obs-source.json', 'library.json', 'characters/index.json', 'owner.json',
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
