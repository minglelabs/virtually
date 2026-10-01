'use strict';

// Where the server's JSON records live (auth state, the billing ledger, each
// account's characters / library / jobs ...). Callers keep addressing a record by
// the file path it always had, <dataDir>/users/<id>/library.json; the store maps
// that path to either
//   - a file (no DATABASE_URL: local development and the tests), written
//     atomically, private records at 0600 in a 0700 directory, or
//   - a row of virtually.documents(key, value jsonb) in Postgres, the key being the
//     path relative to the server's data directory.
//
// Both answer the same four calls:
//   read(file)               -> the parsed value, or null when there is none. A
//                               file that is not valid JSON throws (SyntaxError).
//   write(file, value, opts) -> atomically replaces the record. opts.private marks
//                               a secret (file mode only).
//   remove(file)             -> drops it; a missing record is fine.
//   children(dir)            -> names directly under dir (records and sub-paths).
// Media bytes are not records; they go through lib/blobs.js.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createFileDocs() {
  return {
    kind: 'file',

    async read(file) {
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      return JSON.parse(text);
    },

    async write(file, value, { private: secret = false } = {}) {
      const dir = path.dirname(file);
      await fsp.mkdir(dir, { recursive: true, ...(secret ? { mode: 0o700 } : {}) });
      // mkdir's mode only applies to a directory it creates; tighten an existing one too.
      if (secret) await fsp.chmod(dir, 0o700);
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', secret ? { mode: 0o600, flag: 'wx' } : { flag: 'wx' });
        if (secret) await fsp.chmod(tmp, 0o600);
        await fsp.rename(tmp, file);
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    },

    async remove(file) {
      await fsp.rm(file, { force: true });
    },

    // Tightens an existing private record's directory and file permissions.
    async secure(file) {
      await fsp.chmod(path.dirname(file), 0o700).catch(() => {});
      await fsp.chmod(file, 0o600).catch(() => {});
    },

    async children(dir) {
      try {
        return await fsp.readdir(dir);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
        throw error;
      }
    },

    async close() {},
  };
}

const SCHEMA_SQL = `
create schema if not exists virtually;
create table if not exists virtually.documents (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
-- Small facts about the database itself (which one-time imports ran).
create table if not exists virtually.meta (
  key text primary key,
  value text not null
);
-- Not exposed through Supabase's API; RLS on keeps it closed even if the schema ever is.
alter table virtually.documents enable row level security;
alter table virtually.meta enable row level security;
`;

// A record that is not in the database yet but exists as a file at the same path (what the
// server wrote before it used a database, e.g. on a Railway volume) is imported on first read,
// once: the row then exists and the file is never read again. So switching a running site to the
// database loses nothing, whichever record is touched first.
function createPostgresDocs(pool, root) {
  const base = path.resolve(root);
  function keyOf(file) {
    const relative = path.relative(base, path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Not under the data directory: ${file}`);
    return relative.split(path.sep).join('/');
  }
  async function legacyFile(file) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return null;
      throw error;
    }
    return JSON.parse(text);
  }
  return {
    kind: 'postgres',
    pool,

    async read(file) {
      const key = keyOf(file);
      const { rows } = await pool.query('select value from virtually.documents where key = $1', [key]);
      if (rows.length) return rows[0].value;
      const legacy = await legacyFile(file);
      if (legacy === null) return null;
      await pool.query('insert into virtually.documents (key, value) values ($1, $2::jsonb) on conflict (key) do nothing', [key, JSON.stringify(legacy)]);
      return (await pool.query('select value from virtually.documents where key = $1', [key])).rows[0].value;
    },

    // The two earlier sources on their own (the ledger compares them before choosing).
    async readRecord(file) {
      const { rows } = await pool.query('select value from virtually.documents where key = $1', [keyOf(file)]);
      return rows.length ? rows[0].value : null;
    },
    readLegacyFile: legacyFile,

    async write(file, value) {
      await pool.query(
        `insert into virtually.documents (key, value) values ($1, $2::jsonb)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [keyOf(file), JSON.stringify(value)],
      );
    },

    async remove(file) {
      await pool.query('delete from virtually.documents where key = $1', [keyOf(file)]);
      await fsp.rm(file, { force: true }); // else the import above would bring it back
    },

    async children(dir) {
      const prefix = `${keyOf(dir)}/`;
      const { rows } = await pool.query(
        `select distinct split_part(substr(key, $2), '/', 1) as name
           from virtually.documents where starts_with(key, $1)`,
        [prefix, prefix.length + 1],
      );
      const names = new Set(rows.map(row => row.name).filter(Boolean));
      let onDisk = [];
      try {
        onDisk = await fsp.readdir(dir);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
      for (const name of onDisk) names.add(name);
      return [...names];
    },

    async close() {
      await pool.end();
    },
  };
}

// DATABASE_URL set -> Postgres (the schema is created when missing); otherwise files.
async function openDocs({ databaseUrl = process.env.DATABASE_URL, root, log = () => {} } = {}) {
  if (!databaseUrl) return createFileDocs();
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    // Hosted Postgres (Supabase, Railway) needs TLS; the certificate chain is the host's own.
    ssl: local || /sslmode=disable/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  });
  pool.on('error', error => log(`[db] idle connection error: ${error.message}`));
  try {
    await pool.query(SCHEMA_SQL);
  } catch (error) {
    await pool.end().catch(() => {});
    throw new Error(`Could not prepare the database: ${error.message}`);
  }
  return createPostgresDocs(pool, root);
}

module.exports = { openDocs, createFileDocs, createPostgresDocs, SCHEMA_SQL };
