#!/usr/bin/env node
'use strict';

// Download the example driving videos listed in examples/driving.json into the
// data dir, exactly like POST /api/animate/examples/fetch, without a server.
// Examples hidden on the page (data/animate/drivings/hidden-examples.json) are skipped.
//
//   pnpm run fetch-examples [-- --data-dir <dir>] [--manifest <file>]
//
// The videos come from the sources named in the manifest and their licenses
// apply; they are stored under data/ (gitignored), never in the repository.

const path = require('node:path');
const { DrivingStore } = require('../lib/animate/drivings');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

// `options.allowHttpExamples` exists for tests (local fixture servers).
async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log;
  const args = parseArgs(argv);
  if (args.help) {
    log('Usage: pnpm run fetch-examples [-- --data-dir <dir>] [--manifest <file>]');
    return { results: [] };
  }
  const store = await new DrivingStore({
    dataDir: path.resolve(args.dataDir || path.join(ROOT, 'data')),
    manifestPath: path.resolve(args.manifest || path.join(ROOT, 'examples', 'driving.json')),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    allowHttpExamples: !!options.allowHttpExamples,
  }).init();
  if (store.examples.length === 0) {
    log('No examples in the manifest.');
    return { results: [] };
  }
  // Examples deleted on the page (hidden-examples.json) are skipped.
  const results = await store.fetchExamples();
  const hidden = store.hiddenCount();
  const skipped = store.visibleExamples().length - results.length;
  for (const result of results) log(result.ok ? `ok      ${result.id}` : `failed  ${result.id}: ${result.error}`);
  if (skipped > 0) log(`${skipped} already downloaded.`);
  if (hidden > 0) log(`${hidden} hidden (deleted on the page), skipped.`);
  return { results };
}

if (require.main === module) {
  main().then(({ results }) => {
    if (results.some(result => !result.ok)) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
