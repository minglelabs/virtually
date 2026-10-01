'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { loadDotEnv } = require('../lib/env');
const { requireDatabaseInProduction, storageSummary } = require('../server');

test('loadDotEnv fills in unset variables from the file, never overrides one that is set', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-dotenv-'));
  const names = ['VIRTUALLY_TEST_FROM_FILE', 'VIRTUALLY_TEST_ALREADY_SET'];
  try {
    const file = path.join(dir, '.env');
    await fs.writeFile(file, 'VIRTUALLY_TEST_FROM_FILE=from-file\nVIRTUALLY_TEST_ALREADY_SET=from-file\n');
    process.env.VIRTUALLY_TEST_ALREADY_SET = 'from-shell';
    assert.equal(loadDotEnv(file), true);
    assert.equal(process.env.VIRTUALLY_TEST_FROM_FILE, 'from-file');
    assert.equal(process.env.VIRTUALLY_TEST_ALREADY_SET, 'from-shell');
    // No file is not an error.
    assert.equal(loadDotEnv(path.join(dir, 'missing.env')), false);
  } finally {
    for (const name of names) delete process.env[name];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('requiring server.js reads no .env: only running it does', () => {
  // A .env in the repo (a developer's machine) must not leak into a process that merely requires
  // the module, which is what every test does. Here that .env's R2_BUCKET would show.
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env };
  for (const name of ['R2_BUCKET', 'DATABASE_URL', 'NODE_ENV']) delete env[name];
  const out = execFileSync(process.execPath, ['-e', "require('./server'); console.log(JSON.stringify([process.env.R2_BUCKET || null, process.env.DATABASE_URL || null]))"], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(out.trim(), '[null,null]');
});

test('production refuses to start without DATABASE_URL', () => {
  assert.throws(() => requireDatabaseInProduction({ NODE_ENV: 'production' }), /DATABASE_URL/);
  assert.doesNotThrow(() => requireDatabaseInProduction({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@h/db' }));
  assert.doesNotThrow(() => requireDatabaseInProduction({}));
  assert.doesNotThrow(() => requireDatabaseInProduction({ NODE_ENV: 'development' }));
});

test('the storage summary names the host and bucket, never a credential', () => {
  const secret = 'pw-not-real-9876';
  const url = new URL('postgres://db.example.com:6543/postgres');
  url.username = 'postgres.ref';
  url.password = secret;
  const env = { DATABASE_URL: url.href, R2_BUCKET: 'my-bucket', R2_SECRET_ACCESS_KEY: secret };
  const full = storageSummary({ docs: { kind: 'postgres' }, blobs: { kind: 's3' }, env });
  assert.deepEqual(full, ['[db] Postgres at db.example.com, schema virtually', '[storage] media mirrored to R2 bucket my-bucket']);
  assert.equal(full.join('\n').includes(secret), false);

  const local = storageSummary({ docs: { kind: 'file' }, blobs: null, env: {} });
  assert.match(local[0], /JSON files under data\//);
  assert.match(local[1], /local disk only/);
});
