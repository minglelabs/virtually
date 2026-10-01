#!/usr/bin/env node
'use strict';

// Moves the data of a login-off install (data/library.json, data/characters, ...)
// into one Google account's workspace, data/users/<sub>/, so that account sees it
// once login is on. Usage: node scripts/claim-legacy-data.js <google sub> [dataDir]
// Stop the server first. Nothing is overwritten: if the account's folder already
// has one of these, the script stops before moving anything.

const fs = require('node:fs');
const path = require('node:path');

const MOVES = [
  'library.json',
  'obs-source.json',
  'characters',
  'media',
  path.join('animate', 'jobs'),
  path.join('animate', 'drivings'),
];

function main() {
  const [sub, dataArg] = process.argv.slice(2);
  if (!sub || !/^[A-Za-z0-9_-]{1,64}$/.test(sub)) {
    console.error('Usage: node scripts/claim-legacy-data.js <google sub> [dataDir]\nThe sub is the account id in data/billing/ledger.json (digits).');
    process.exit(2);
  }
  const dataDir = path.resolve(dataArg || path.join(__dirname, '..', 'data'));
  const home = path.join(dataDir, 'users', sub);
  const present = MOVES.filter(name => fs.existsSync(path.join(dataDir, name)));
  const clash = present.filter(name => fs.existsSync(path.join(home, name)));
  if (clash.length) {
    console.error(`${home} already has: ${clash.join(', ')}. Nothing was moved.`);
    process.exit(1);
  }
  for (const name of present) {
    fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
    fs.renameSync(path.join(dataDir, name), path.join(home, name));
    console.log(`moved ${name}`);
  }
  console.log(present.length ? `Done: ${present.length} item(s) are now in ${home}` : 'Nothing to move.');
}

main();
