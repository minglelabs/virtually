'use strict';

// Where the credit ledger is kept. ledger.js works on one in-memory object,
//   { version, users: {sub: {...}}, entries: [...], orders: {id: {...}}, webhooks: {id: ms} },
// and asks a store for two things: load() once at start and save(next) after every
// change. The store only decides how that object is laid out on disk.
//
//   file store      one JSON record (<dataDir>/billing/ledger.json), rewritten whole.
//   Postgres store  rows. virtually.ledger_users / ledger_entries / ledger_orders /
//                   ledger_webhooks, one row per user, entry, order and webhook, each
//                   with the full record as jsonb (the source of truth) and, for entries,
//                   the columns worth querying (sub, kind, delta, at, seq). save() writes
//                   only the rows that changed, in one transaction, so a failed save
//                   changes nothing and a crash cannot leave half a charge.
//
// The Postgres store fills itself once from the earlier storage (the ledger.json record
// or file), when its tables are empty.

const crypto = require('node:crypto');

const LEDGER_SQL = `
create table if not exists virtually.ledger_users (
  sub text primary key,
  data jsonb not null
);
create table if not exists virtually.ledger_entries (
  id text primary key,
  seq bigint not null,
  sub text,
  kind text,
  delta bigint,
  at text,
  data jsonb not null
);
create index if not exists ledger_entries_sub_idx on virtually.ledger_entries (sub, seq);
create index if not exists ledger_entries_seq_idx on virtually.ledger_entries (seq);
create table if not exists virtually.ledger_orders (
  id text primary key,
  data jsonb not null
);
create table if not exists virtually.ledger_webhooks (
  id text primary key,
  data jsonb not null
);
alter table virtually.ledger_users enable row level security;
alter table virtually.ledger_entries enable row level security;
alter table virtually.ledger_orders enable row level security;
alter table virtually.ledger_webhooks enable row level security;
`;

const CHUNK = 500;

function createFileLedgerStore(docs, filePath, { normalize }) {
  return {
    kind: 'file',
    async load() {
      const stored = await docs.read(filePath);
      if (stored === null) return null;
      const ledger = normalize(stored);
      if (!ledger) throw new Error('not a ledger object');
      if (docs.secure) await docs.secure(filePath);
      return ledger;
    },
    async save(next) {
      await docs.write(filePath, next, { private: true });
    },
  };
}

// The rows of a ledger, as { users: Map(sub -> json), entries: [{id, json, ...}], orders: Map, webhooks: Map }.
function rowsOf(ledger) {
  const text = value => JSON.stringify(value);
  const entries = [];
  const seen = new Set();
  ledger.entries.forEach((entry, index) => {
    const json = text(entry);
    let id = entry && typeof entry.id === 'string' && entry.id ? entry.id : `legacy-${crypto.createHash('sha1').update(json).digest('hex')}`;
    if (seen.has(id)) throw new Error(`Two ledger entries share the id ${id}.`);
    seen.add(id);
    entries.push({
      id, json, seq: index,
      sub: entry && typeof entry.sub === 'string' ? entry.sub : null,
      kind: entry && typeof entry.kind === 'string' ? entry.kind : null,
      delta: entry && Number.isSafeInteger(entry.delta) ? entry.delta : null,
      at: entry && typeof entry.at === 'string' ? entry.at : null,
    });
  });
  return {
    users: new Map(Object.entries(ledger.users).map(([key, value]) => [key, text(value)])),
    entries,
    orders: new Map(Object.entries(ledger.orders).map(([key, value]) => [key, text(value)])),
    webhooks: new Map(Object.entries(ledger.webhooks).map(([key, value]) => [key, text(value)])),
  };
}

function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

async function upsertPairs(client, table, pairs) {
  for (const part of chunks(pairs)) {
    await client.query(
      `insert into virtually.${table} (${table === 'ledger_users' ? 'sub' : 'id'}, data)
       select k, d::jsonb from unnest($1::text[], $2::text[]) as t(k, d)
       on conflict (${table === 'ledger_users' ? 'sub' : 'id'}) do update set data = excluded.data`,
      [part.map(pair => pair[0]), part.map(pair => pair[1])],
    );
  }
}

async function upsertEntries(client, entries) {
  for (const part of chunks(entries)) {
    await client.query(
      `insert into virtually.ledger_entries (id, seq, sub, kind, delta, at, data)
       select i, s, u, k, d, a, j::jsonb
         from unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::bigint[], $6::text[], $7::text[]) as t(i, s, u, k, d, a, j)
       on conflict (id) do update set seq = excluded.seq, sub = excluded.sub, kind = excluded.kind,
         delta = excluded.delta, at = excluded.at, data = excluded.data`,
      [part.map(e => e.id), part.map(e => e.seq), part.map(e => e.sub), part.map(e => e.kind), part.map(e => e.delta),
        part.map(e => e.at), part.map(e => e.json)],
    );
  }
}

async function deleteKeys(client, table, column, keys) {
  for (const part of chunks(keys)) {
    await client.query(`delete from virtually.${table} where ${column} = any($1::text[])`, [part]);
  }
}

function createPostgresLedgerStore(pool, { legacy, normalize }) {
  let snapshot = rowsOf({ users: {}, entries: [], orders: {}, webhooks: {} });
  let version = 1;
  let ready = null;

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Writes everything in `next` and removes the rest, in `client`'s transaction.
  async function writeAll(client, next, from) {
    const now = rowsOf(next);
    const was = from || rowsOf({ users: {}, entries: [], orders: {}, webhooks: {} });
    for (const [table, key, map, before] of [
      ['ledger_users', 'sub', now.users, was.users],
      ['ledger_orders', 'id', now.orders, was.orders],
      ['ledger_webhooks', 'id', now.webhooks, was.webhooks],
    ]) {
      await upsertPairs(client, table, [...map].filter(([k, json]) => before.get(k) !== json));
      await deleteKeys(client, table, key, [...before.keys()].filter(k => !map.has(k)));
    }
    const beforeEntries = new Map(was.entries.map(entry => [entry.id, entry]));
    await upsertEntries(client, now.entries.filter(entry => {
      const old = beforeEntries.get(entry.id);
      return !old || old.json !== entry.json || old.seq !== entry.seq;
    }));
    const kept = new Set(now.entries.map(entry => entry.id));
    await deleteKeys(client, 'ledger_entries', 'id', was.entries.filter(entry => !kept.has(entry.id)).map(entry => entry.id));
    await client.query(
      "insert into virtually.meta (key, value) values ('ledger.version', $1) on conflict (key) do update set value = excluded.value",
      [String(next.version || 1)],
    );
    return now;
  }

  async function readTables() {
    const [users, entries, orders, webhooks, meta] = await Promise.all([
      pool.query('select sub, data from virtually.ledger_users'),
      pool.query('select data from virtually.ledger_entries order by seq, id'),
      pool.query('select id, data from virtually.ledger_orders'),
      pool.query('select id, data from virtually.ledger_webhooks'),
      pool.query("select value from virtually.meta where key = 'ledger.version'"),
    ]);
    const empty = !users.rows.length && !entries.rows.length && !orders.rows.length && !webhooks.rows.length;
    return {
      empty,
      ledger: {
        version: meta.rows.length ? Number(meta.rows[0].value) || 1 : 1,
        users: Object.fromEntries(users.rows.map(row => [row.sub, row.data])),
        entries: entries.rows.map(row => row.data),
        orders: Object.fromEntries(orders.rows.map(row => [row.id, row.data])),
        webhooks: Object.fromEntries(webhooks.rows.map(row => [row.id, row.data])),
      },
    };
  }

  return {
    kind: 'postgres',

    async load() {
      if (!ready) {
        ready = (async () => {
          await pool.query(LEDGER_SQL);
          const stored = await readTables();
          if (!stored.empty) return stored.ledger;
          // Nothing in the tables: take over the earlier record once, if there is one.
          const earlier = await legacy();
          if (earlier === null) return null;
          const ledger = normalize(earlier);
          if (!ledger) throw new Error('the earlier ledger is not a ledger object');
          await transaction(client => writeAll(client, ledger, null));
          return ledger;
        })();
      }
      const ledger = await ready;
      if (ledger) {
        version = ledger.version || 1;
        snapshot = rowsOf(ledger);
      }
      return ledger;
    },

    async save(next) {
      snapshot = await transaction(client => writeAll(client, next, snapshot));
      version = next.version || version;
    },

    // Replaces every row with `ledger` (the migration script's --overwrite).
    async replaceAll(ledger) {
      await pool.query(LEDGER_SQL);
      const stored = await readTables();
      await transaction(client => writeAll(client, ledger, rowsOf(stored.ledger)));
    },
  };
}

module.exports = { createFileLedgerStore, createPostgresLedgerStore, LEDGER_SQL };
