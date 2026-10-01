'use strict';

// Activity log for the admin page (/admin/activity). Every state-changing call
// by a signed-in account becomes one line in <dataDir>/activity/events.jsonl:
// { id, ts, actor: { sub, email, name } | null, type, ...detail }. The log also
// answers "who uploaded this?": the first event that created a character, photo,
// motion, driving video or job names its owner. Things made before the log
// existed have no owner (the admin page says 기록 이전).
//
// The events live in the database when there is one (virtually.activity_events), else in
// <dataDir>/activity/events.jsonl; see the two stores below.
//
// Nothing here changes how the app stores data: server.js hands each request to
// observe(), which waits for the answer and records successful changes, and
// calls record() itself where the answer does not say enough (motion plays).

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_LIST = 500;
const DEFAULT_LIST = 100;
const MAX_NAME = 120;

// Event types, grouped for the admin page's filters.
const GROUPS = Object.freeze({
  upload: ['character.create', 'photo.add', 'motion.upload', 'library.upload', 'driving.upload', 'motion.add'],
  edit: ['character.rename', 'character.delete', 'photo.delete', 'photo.base', 'media.delete', 'driving.delete'],
  onair: ['onair.set'],
  play: ['motion.trigger'],
  job: ['job.create'],
});

const OWNER_KINDS = Object.freeze({
  'character.create': [['character', 'characterId'], ['photo', 'photoId']],
  'photo.add': [['photo', 'photoId']],
  'motion.upload': [['motion', 'motionId']],
  'motion.add': [['motion', 'motionId']],
  'library.upload': [['motion', 'itemId']],
  'driving.upload': [['driving', 'drivingId']],
  'job.create': [['job', 'jobId']],
});

function clean(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, MAX_NAME) : null;
}

function actorOf(access) {
  const session = access && access.session;
  if (!session || typeof session.email !== 'string' || !session.email) return null;
  return {
    sub: typeof session.sub === 'string' ? session.sub : null,
    email: session.email.trim().toLowerCase(),
    name: clean(session.name),
  };
}

// --- stores: load() -> every event, oldest first; append(event) ---------------

function createFileStore(dir) {
  const file = path.join(dir, 'events.jsonl');
  return {
    kind: 'file',
    async load() {
      await fsp.mkdir(dir, { recursive: true });
      let text = '';
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return parseLines(text);
    },
    async append(event) {
      await fsp.appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    },
  };
}

// A torn last line (power loss) is skipped.
function parseLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* skipped */ }
  }
  return events;
}

const ACTIVITY_SQL = `
create table if not exists virtually.activity_events (
  seq bigserial primary key,
  id text not null unique,
  ts text not null,
  actor_email text,
  type text not null,
  data jsonb not null
);
create index if not exists activity_events_email_idx on virtually.activity_events (actor_email, seq);
create index if not exists activity_events_type_idx on virtually.activity_events (type, seq);
alter table virtually.activity_events enable row level security;
`;

function insertSql(count) {
  return `insert into virtually.activity_events (id, ts, actor_email, type, data) values ${
    Array.from({ length: count }, (_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}::jsonb)`).join(', ')
  } on conflict (id) do nothing`;
}

function eventParams(event) {
  return [String(event.id), String(event.ts), event.actor && event.actor.email ? event.actor.email : null, event.type, JSON.stringify(event)];
}

// `dir` is where an earlier events.jsonl may be: it is imported once, while the table is empty.
function createPostgresStore(pool, dir) {
  const legacyFile = path.join(dir, 'events.jsonl');
  async function insertAll(events) {
    const valid = events.filter(event => event && typeof event.type === 'string' && event.id && event.ts);
    for (let i = 0; i < valid.length; i += 500) {
      const part = valid.slice(i, i + 500);
      await pool.query(insertSql(part.length), part.flatMap(eventParams));
    }
    return valid.length;
  }
  return {
    kind: 'postgres',
    async load() {
      await pool.query(ACTIVITY_SQL);
      const { rows } = await pool.query('select data from virtually.activity_events order by seq');
      if (rows.length) return rows.map(row => row.data);
      let text = '';
      try {
        text = await fsp.readFile(legacyFile, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const events = parseLines(text);
      await insertAll(events);
      return events.filter(event => event && typeof event.type === 'string' && event.id && event.ts);
    },
    async append(event) {
      await insertAll([event]);
    },
    insertAll,
  };
}

class ActivityLog {
  // `store`, or `dir` for the file store under it.
  constructor({ store = null, dir = null, now = () => new Date(), log = () => {} }) {
    this.store = store || createFileStore(dir);
    this.now = now;
    this.log = log;
    this.events = []; // oldest first
    this.owners = new Map(); // 'kind:id' -> email
    this.names = new Map(); // id -> last known name
    this.chain = Promise.resolve();
  }

  async load() {
    for (const event of await this.store.load()) this.index(event);
    return this;
  }

  index(event) {
    if (!event || typeof event.type !== 'string') return;
    this.events.push(event);
    const email = event.actor ? event.actor.email : null;
    for (const [kind, field] of OWNER_KINDS[event.type] || []) {
      const id = event[field];
      if (id && email && !this.owners.has(`${kind}:${id}`)) this.owners.set(`${kind}:${id}`, email);
    }
    for (const [idField, nameField] of [['characterId', 'characterName'], ['motionId', 'motionName'], ['drivingId', 'drivingName'], ['itemId', 'itemName']]) {
      if (event[idField] && event[nameField]) this.names.set(event[idField], event[nameField]);
    }
    if (event.type === 'character.rename' && event.characterId && event.name) this.names.set(event.characterId, event.name);
  }

  /** Appends one event (the write is queued; failures are logged, never thrown into a request). */
  record(access, type, detail = {}) {
    const event = { id: crypto.randomUUID(), ts: this.now().toISOString(), actor: actorOf(access), type, ...detail };
    this.index(event);
    this.chain = this.chain
      .then(() => this.store.append(event))
      .catch(error => this.log(`[activity] could not write an event: ${error.message}`));
    return event;
  }

  flush() {
    return this.chain;
  }

  ownerOf(kind, id) {
    return this.owners.get(`${kind}:${id}`) || null;
  }

  nameOf(id) {
    return this.names.get(id) || null;
  }

  /** Newest first. Filters: type (one type or a group name), email, before (ISO ts), limit. */
  list({ type = '', email = '', before = '', limit = DEFAULT_LIST } = {}) {
    const types = GROUPS[type] || (type ? [type] : null);
    const wanted = String(email || '').trim().toLowerCase();
    const max = Math.min(MAX_LIST, Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIST));
    const out = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < max; i -= 1) {
      const event = this.events[i];
      if (before && !(event.ts < before)) continue;
      if (types && !types.includes(event.type)) continue;
      if (wanted && (!event.actor || event.actor.email !== wanted)) continue;
      out.push(event);
    }
    return out;
  }

  /** One row per account that did anything: counts by kind and the last time. */
  users() {
    const byEmail = new Map();
    for (const event of this.events) {
      if (!event.actor) continue;
      const email = event.actor.email;
      let row = byEmail.get(email);
      if (!row) {
        row = { email, name: event.actor.name, firstAt: event.ts, lastAt: event.ts, counts: { upload: 0, edit: 0, onair: 0, play: 0, job: 0 } };
        byEmail.set(email, row);
      }
      if (event.actor.name) row.name = event.actor.name;
      row.lastAt = event.ts;
      for (const [group, types] of Object.entries(GROUPS)) if (types.includes(event.type)) row.counts[group] += 1;
    }
    return [...byEmail.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
}

async function createActivityLog({ dataDir, docs = null, now, log }) {
  const dir = path.join(dataDir, 'activity');
  const store = docs && docs.kind === 'postgres' ? createPostgresStore(docs.pool, dir) : createFileStore(dir);
  return new ActivityLog({ store, now, log }).load();
}

// ---- Turning successful requests into events ----

const ID = '([^/]+)';
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };

// [method, path pattern, (activity, access, params, body) => event | null]
const RULES = [
  ['POST', /^\/api\/characters$/, (a, access, p, body) => body && body.character && ({
    type: 'character.create', characterId: body.character.id, characterName: clean(body.character.name), photoId: body.character.basePhotoId || null,
  })],
  ['PATCH', new RegExp(`^/api/characters/${ID}$`), (a, access, p, body) => body && body.character && ({
    type: 'character.rename', characterId: body.character.id, name: clean(body.character.name), from: a.nameOf(body.character.id),
  })],
  ['DELETE', new RegExp(`^/api/characters/${ID}$`), (a, access, p) => ({
    type: 'character.delete', characterId: decode(p[0]), characterName: a.nameOf(decode(p[0])),
  })],
  ['POST', new RegExp(`^/api/characters/${ID}/photos$`), (a, access, p, body) => body && body.photo && ({
    type: 'photo.add', characterId: decode(p[0]), characterName: body.character ? clean(body.character.name) : a.nameOf(decode(p[0])), photoId: body.photo.id,
  })],
  ['DELETE', new RegExp(`^/api/characters/${ID}/photos/${ID}$`), (a, access, p) => ({
    type: 'photo.delete', characterId: decode(p[0]), characterName: a.nameOf(decode(p[0])), photoId: decode(p[1]),
  })],
  ['PUT', new RegExp(`^/api/characters/${ID}/base$`), (a, access, p, body) => body && body.character && ({
    type: 'photo.base', characterId: decode(p[0]), characterName: clean(body.character.name), photoId: body.character.basePhotoId || null,
  })],
  ['POST', new RegExp(`^/api/characters/${ID}/photos/${ID}/motions$`), (a, access, p, body) => body && body.motion && ({
    type: 'motion.upload', characterId: decode(p[0]), characterName: a.nameOf(decode(p[0])), photoId: decode(p[1]),
    motionId: body.motion.id, motionName: clean(body.motion.name), keyed: body.keyed === true,
  })],
  ['PUT', /^\/api\/active-photo$/, (a, access, p, body) => body && ({
    type: 'onair.set', photoId: body.activePhotoId || null, characterId: body.activeCharacterId || null,
    characterName: body.activeCharacterId ? a.nameOf(body.activeCharacterId) : null,
  })],
  ['POST', /^\/api\/upload$/, (a, access, p, body) => body && body.id && ({
    type: 'library.upload', kind: body.kind, itemId: body.id, itemName: clean(body.name), photoId: body.photoId || null,
  })],
  ['DELETE', new RegExp(`^/api/media/${ID}$`), (a, access, p) => ({
    type: 'media.delete', itemId: decode(p[0]), itemName: a.nameOf(decode(p[0])),
  })],
  ['POST', /^\/api\/animate\/drivings$/, (a, access, p, body) => body && body.id && ({
    type: 'driving.upload', drivingId: body.id, drivingName: clean(body.label || body.name),
  })],
  ['DELETE', new RegExp(`^/api/animate/drivings/${ID}$`), (a, access, p) => ({
    type: 'driving.delete', drivingId: decode(p[0]), drivingName: a.nameOf(decode(p[0])),
  })],
  ['POST', /^\/api\/animate\/jobs$/, (a, access, p, body) => body && body.job && ({
    type: 'job.create', jobId: body.job.id, routeLabel: clean(body.job.routeLabel), drivingId: body.job.drivingId || null,
    drivingName: clean(body.job.drivingLabel), photoId: body.job.photoId || null, characterId: body.job.characterId || null,
    characterName: clean(body.job.characterLabel), credits: body.job.billing ? body.job.billing.credits : null,
  })],
  ['POST', new RegExp(`^/api/animate/jobs/${ID}/motion$`), (a, access, p, body) => body && body.motion && ({
    type: 'motion.add', jobId: decode(p[0]), motionId: body.motion.id, motionName: clean(body.motion.name), photoId: body.motion.photoId || null,
  })],
];

/**
 * Called by server.js for every request after the access gate. Successful
 * changes are recorded once the answer is out; reads and failures are not.
 */
function observe(activity, req, res, url, access) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const hit = RULES.map(([method, pattern, describe]) => (method === req.method ? [pattern.exec(url.pathname), describe] : null))
    .find(entry => entry && entry[0]);
  if (!hit) return;
  const [match, describe] = hit;
  const chunks = [];
  const keep = chunk => { if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk)); };
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (chunk, ...rest) => { keep(chunk); return write(chunk, ...rest); };
  res.end = (chunk, ...rest) => { keep(chunk); return end(chunk, ...rest); };
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
      const detail = describe(activity, access, match.slice(1), body);
      if (!detail) return;
      const { type, ...rest } = detail;
      activity.record(access, type, rest);
    } catch (error) {
      activity.log(`[activity] could not describe ${req.method} ${url.pathname}: ${error.message}`);
    }
  });
}

module.exports = { ActivityLog, createActivityLog, createPostgresStore, observe, actorOf, GROUPS };
