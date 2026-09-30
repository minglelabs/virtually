'use strict';

// The credit ledger: <dataDir>/billing/ledger.json (file 0600, dir 0700),
// written atomically (tmp + rename). Every mutation runs through one queue on
// a copy that replaces the in-memory state only once it is on disk, so a
// balance check and its debit happen in one step (no double spend) and a
// failed write changes nothing.
//
// {
//   "version": 1,
//   "users":    { <sub>: { email, name?, seenAt?, polarCustomerId? } },
//   "entries":  [ { id, at, sub, delta, kind, label, orderId?, jobId?, chargeId?, email?, by?, requestId? } ],
//   "orders":   { <orderId>: { sub, email, checkoutId, customerId, granted, revoked, appliedAt?, pending? } },
//   "webhooks": { <webhook-id>: <ms when handled> }   (kept 30 days)
// }
// kind: 'grant'|'revoke' (Polar orders), 'charge'|'refund' (jobs; a refund
// names the charge it gives back in chargeId, since a re-fetch can charge a
// refunded job again), 'topup'|'deduct' (admin; email = the address the
// admin entered, by = the admin, requestId = the admin page's dedupe key). An
// admin entry for an email no ledger user has yet is pending: sub null until
// a signed-in user with that email claims it (its id, at and label are kept).
//
// A balance is the sum of a user's entry deltas. It may go negative (a refund
// revoking credits that were already spent); a negative or short balance
// blocks paid jobs. The functions below other than openLedger() work on a
// ledger object (the draft inside mutate(), or the committed read()).

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DISPLAY_LEDGER_PATH = 'data/billing/ledger.json';
const WEBHOOK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 30;
const ADMIN_HISTORY_LIMIT = 200;
const ADMIN_USERS_LIMIT = 500;
// seenAt is rewritten at most once a minute (every billing request touches it).
const SEEN_GRANULARITY_MS = 60 * 1000;
const MAX_NAME_LENGTH = 256;
const ADMIN_KINDS = new Set(['topup', 'deduct']);
const GRANT_REASONS = new Set(['purchase', 'subscription_create', 'subscription_cycle']);
const PLAN_CHANGE_REASONS = new Set(['subscription_update', 'subscription_meter_cycle']);

const isMap = value => !!value && typeof value === 'object' && !Array.isArray(value);
// Keys come from Polar payloads: never read an inherited property.
const own = (map, key) => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined);
const usableKey = key => typeof key === 'string' && key.length > 0 && key !== '__proto__';

function emptyLedger() {
  return { version: 1, users: {}, entries: [], orders: {}, webhooks: {} };
}

// A stored ledger with every section present, or null when it is not one.
function normalizeLedger(raw) {
  if (!isMap(raw)) return null;
  const ledger = emptyLedger();
  if (raw.entries !== undefined) {
    if (!Array.isArray(raw.entries)) return null;
    ledger.entries = raw.entries;
  }
  for (const key of ['users', 'orders', 'webhooks']) {
    if (raw[key] === undefined) continue;
    if (!isMap(raw[key])) return null;
    ledger[key] = raw[key];
  }
  return ledger;
}

async function writeLedgerFile(dir, filePath, ledger) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to a directory it creates; tighten an existing one too.
  await fsp.chmod(dir, 0o700);
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, filePath);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// Returns { read(), mutate(fn), close(), filePath }. Nothing is created on
// disk until the first mutation that changes something. An unreadable ledger
// is never replaced: every read and mutation then throws (billing fails
// closed with a 500) until the file is fixed.
async function openLedger(billingDir, { log = () => {} } = {}) {
  const filePath = path.join(billingDir, 'ledger.json');
  let committed = emptyLedger();
  let broken = null;
  try {
    const parsed = normalizeLedger(JSON.parse(await fsp.readFile(filePath, 'utf8')));
    if (!parsed) throw new Error('not a ledger object');
    committed = parsed;
    await fsp.chmod(billingDir, 0o700).catch(() => {});
    await fsp.chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    if (error.code !== 'ENOENT') {
      broken = error.code || (error instanceof SyntaxError ? 'invalid JSON' : error.message);
      log(`[billing] ${DISPLAY_LEDGER_PATH} is unreadable (${broken}); billing stays locked until it is fixed`);
    }
  }
  let serialized = JSON.stringify(committed);
  let queue = Promise.resolve();
  let closed = false;

  const unreadable = () => new Error(`The billing ledger (${DISPLAY_LEDGER_PATH}) is unreadable.`);

  function read() {
    if (broken) throw unreadable();
    return committed;
  }

  // fn(draft) runs synchronously on a copy; the copy is written and committed
  // when it differs. Resolves fn's return value.
  function mutate(fn) {
    const next = queue.then(async () => {
      if (broken) throw unreadable();
      if (closed) throw new Error('The billing ledger is closed.');
      const draft = JSON.parse(serialized);
      const result = fn(draft);
      const text = JSON.stringify(draft);
      if (text !== serialized) {
        await writeLedgerFile(billingDir, filePath, draft);
        committed = draft;
        serialized = text;
      }
      return result;
    });
    queue = next.catch(() => {});
    return next;
  }

  // Refuses later mutations and waits for the pending ones.
  async function close() {
    closed = true;
    await queue;
  }

  return { read, mutate, close, filePath };
}

// --- reads ------------------------------------------------------------------

function balanceOf(ledger, sub) {
  let total = 0;
  for (const entry of ledger.entries) {
    if (entry && entry.sub === sub && Number.isSafeInteger(entry.delta)) total += entry.delta;
  }
  return total;
}

// This user's newest entries first (insertion order is the ledger's order).
function historyOf(ledger, sub, limit = HISTORY_LIMIT) {
  const out = [];
  for (let i = ledger.entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = ledger.entries[i];
    if (entry && entry.sub === sub) out.push({ id: entry.id, at: entry.at, delta: entry.delta, kind: entry.kind, label: entry.label });
  }
  return out;
}

function customerIdOf(ledger, sub) {
  const user = own(ledger.users, sub);
  return user && typeof user.polarCustomerId === 'string' && user.polarCustomerId ? user.polarCustomerId : null;
}

// Credits granted so far (by webhook or sync, to anyone) for one checkout's orders.
function grantedForCheckout(ledger, checkoutId) {
  let total = 0;
  for (const record of Object.values(ledger.orders)) {
    if (record && record.checkoutId === checkoutId && Number.isSafeInteger(record.granted)) total += record.granted;
  }
  return total;
}

// A webhook id handled within the last 30 days.
function hasWebhook(ledger, id, nowMs) {
  const at = own(ledger.webhooks, id);
  return Number.isFinite(at) && nowMs - at < WEBHOOK_RETENTION_MS;
}

// --- admin reads --------------------------------------------------------------

// An admin entry still waiting for its email's first sign-in.
function isPendingEntry(entry) {
  return !!entry && entry.sub === null && typeof entry.email === 'string' && ADMIN_KINDS.has(entry.kind);
}

// The later of two ISO times (either may be missing).
function laterIso(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

function isoMs(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : -Infinity;
}

function pendingBalance(ledger, email) {
  let total = 0;
  for (const entry of ledger.entries) {
    if (isPendingEntry(entry) && entry.email === email && Number.isSafeInteger(entry.delta)) total += entry.delta;
  }
  return total;
}

function hasPending(ledger, email) {
  return ledger.entries.some(entry => isPendingEntry(entry) && entry.email === email);
}

// The user's last activity: when it was last seen signed in, or its latest entry.
function lastAtOf(ledger, sub) {
  const user = own(ledger.users, sub);
  let last = user && typeof user.seenAt === 'string' ? user.seenAt : null;
  for (let i = ledger.entries.length - 1; i >= 0; i -= 1) {
    const entry = ledger.entries[i];
    if (entry && entry.sub === sub) {
      last = laterIso(last, entry.at);
      break;
    }
  }
  return last;
}

// Where an admin top-up/deduct for this address goes: the ledger user with
// that email (the most recently seen one if several), else pending under the
// email until it signs in. -> { email, sub|null, pending, balance }.
function adminTarget(ledger, email) {
  let best = null;
  for (const sub of Object.keys(ledger.users)) {
    const user = own(ledger.users, sub);
    if (!isMap(user) || user.email !== email || !usableKey(sub)) continue;
    const rank = [isoMs(user.seenAt), isoMs(lastAtOf(ledger, sub))];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { sub, rank };
  }
  if (best) return { email, sub: best.sub, pending: false, balance: balanceOf(ledger, best.sub) };
  return { email, sub: null, pending: hasPending(ledger, email), balance: pendingBalance(ledger, email) };
}

// The admin entry recorded under this requestId, or null.
function findAdminRequest(ledger, requestId) {
  return ledger.entries.find(entry => entry && ADMIN_KINDS.has(entry.kind) && entry.requestId === requestId) || null;
}

// Where an admin entry stands now (it may have been claimed since it was made).
// -> { email, sub|null, balance, pending }.
function adminEntryOwner(ledger, entry) {
  const current = ledger.entries.find(candidate => candidate && candidate.id === entry.id) || entry;
  if (usableKey(current.sub)) {
    const user = own(ledger.users, current.sub);
    return { email: (user && user.email) || current.email, sub: current.sub, balance: balanceOf(ledger, current.sub), pending: false };
  }
  return { email: current.email, sub: null, balance: pendingBalance(ledger, current.email), pending: true };
}

function entryView(entry) {
  return { id: entry.id, at: entry.at, delta: entry.delta, kind: entry.kind, label: entry.label };
}

// Every ledger user (with an email) plus every email holding pending admin
// entries, filtered by `query` (lowercase substring of email or name), sorted
// by lastAt newest first (null last), at most `limit`. loginAllowed is added
// by the caller.
function adminUsers(ledger, { query = '', limit = ADMIN_USERS_LIMIT } = {}) {
  const stats = new Map(); // sub -> { balance, lastAt }
  const pending = new Map(); // email -> { balance, lastAt }
  for (const entry of ledger.entries) {
    if (!entry || !Number.isSafeInteger(entry.delta)) continue;
    const key = isPendingEntry(entry) ? entry.email : entry.sub;
    const map = isPendingEntry(entry) ? pending : stats;
    if (typeof key !== 'string' || !key) continue;
    const stat = map.get(key) || { balance: 0, lastAt: null };
    stat.balance += entry.delta;
    stat.lastAt = laterIso(stat.lastAt, entry.at);
    map.set(key, stat);
  }
  const rows = [];
  for (const sub of Object.keys(ledger.users)) {
    const user = own(ledger.users, sub);
    if (!isMap(user) || typeof user.email !== 'string' || !user.email || !usableKey(sub)) continue;
    const stat = stats.get(sub) || { balance: 0, lastAt: null };
    rows.push({
      email: user.email,
      name: typeof user.name === 'string' && user.name ? user.name : null,
      sub,
      balance: stat.balance,
      pending: false,
      lastAt: laterIso(typeof user.seenAt === 'string' ? user.seenAt : null, stat.lastAt),
    });
  }
  for (const [email, stat] of pending) {
    rows.push({ email, name: null, sub: null, balance: stat.balance, pending: true, lastAt: stat.lastAt });
  }
  const matches = query
    ? rows.filter(row => row.email.includes(query) || (row.name !== null && row.name.toLowerCase().includes(query)))
    : rows;
  matches.sort((a, b) => (isoMs(b.lastAt) - isoMs(a.lastAt)) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return matches.slice(0, limit);
}

// One address as the admin page sees it: the adjust target's balance and
// entries (newest first, with `by`). An unknown address -> balance 0, entries [].
function adminHistory(ledger, email, limit = ADMIN_HISTORY_LIMIT) {
  const target = adminTarget(ledger, email);
  const entries = [];
  for (let i = ledger.entries.length - 1; i >= 0 && entries.length < limit; i -= 1) {
    const entry = ledger.entries[i];
    if (!entry) continue;
    const mine = target.sub !== null ? entry.sub === target.sub : isPendingEntry(entry) && entry.email === email;
    if (!mine) continue;
    entries.push({ ...entryView(entry), by: typeof entry.by === 'string' ? entry.by : null });
  }
  return { email, balance: target.balance, pending: target.pending, entries };
}

// --- mutations (on a draft) --------------------------------------------------

function newEntry(ledger, fields) {
  const entry = { id: crypto.randomUUID(), ...fields };
  ledger.entries.push(entry);
  return entry;
}

// Creates the user's record on their first billing request; keeps the email
// (and the Google name, when given) current. nowIso records when the user was
// last seen signed in (rewritten at most once a minute).
function touchUser(ledger, sub, email, { name = null, nowIso = null } = {}) {
  if (!usableKey(sub)) return;
  const user = own(ledger.users, sub);
  const next = isMap(user) ? { ...user, email } : { email };
  const cleanName = typeof name === 'string' ? name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_NAME_LENGTH) : '';
  if (cleanName) next.name = cleanName;
  if (nowIso) {
    const seen = isMap(user) && typeof user.seenAt === 'string' ? Date.parse(user.seenAt) : NaN;
    const age = Date.parse(nowIso) - seen;
    if (!Number.isFinite(age) || age < 0 || age >= SEEN_GRANULARITY_MS) next.seenAt = nowIso;
  }
  ledger.users[sub] = next;
}

// Moves the pending admin entries for this email to this user (ids, at and
// labels kept). -> the number of entries moved.
function claimAdminEntries(ledger, sub, email) {
  if (!usableKey(sub) || typeof email !== 'string' || !email) return 0;
  let moved = 0;
  for (const entry of ledger.entries) {
    if (isPendingEntry(entry) && entry.email === email) {
      entry.sub = sub;
      moved += 1;
    }
  }
  return moved;
}

// An admin top-up (credits > 0) or deduct (credits < 0) in one step: a
// requestId seen before returns that first entry again (duplicate, nothing
// added); a deduct larger than the target's balance is refused.
// -> { ok: true, duplicate, entry } or { ok: false, balance }.
function adjustCredits(ledger, { email, credits, label, by, requestId, nowIso }) {
  const earlier = findAdminRequest(ledger, requestId);
  if (earlier) return { ok: true, duplicate: true, entry: earlier };
  const target = adminTarget(ledger, email);
  if (credits < 0 && target.balance + credits < 0) return { ok: false, balance: target.balance };
  const entry = newEntry(ledger, {
    at: nowIso, sub: target.sub, email, delta: credits, kind: credits > 0 ? 'topup' : 'deduct', label, by, requestId,
  });
  return { ok: true, duplicate: false, entry };
}

function recordWebhook(ledger, id, nowMs) {
  for (const [key, at] of Object.entries(ledger.webhooks)) {
    if (!Number.isFinite(at) || nowMs - at >= WEBHOOK_RETENTION_MS) delete ledger.webhooks[key];
  }
  if (usableKey(id)) ledger.webhooks[id] = nowMs;
}

// Owner of an order, first match wins: metadata.virtually_user, then the
// customer's external_id google:<sub>, then the customer email when exactly
// one ledger user has it. null = unclaimed.
function resolveOwner(ledger, facts) {
  if (facts.metadataUser) return facts.metadataUser;
  if (facts.externalUser) return facts.externalUser;
  if (facts.email) {
    const matches = Object.keys(ledger.users).filter(sub => {
      const user = own(ledger.users, sub);
      return user && user.email === facts.email;
    });
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function ceilShare(granted, refunded, net) {
  if ([granted, refunded, net].every(Number.isSafeInteger)) {
    const numerator = BigInt(granted) * BigInt(refunded);
    const divisor = BigInt(net);
    return Number((numerator + divisor - 1n) / divisor);
  }
  return Math.ceil((granted * refunded) / net);
}

// Credits that should be revoked in total for a granted order.
function revokeTarget(facts, granted) {
  if (facts.status === 'refunded' || facts.status === 'void') return granted;
  if (facts.status !== 'partially_refunded' || !(facts.netAmount > 0)) return 0;
  return Math.min(granted, ceilShare(granted, facts.refundedAmount, facts.netAmount));
}

function ownerEmail(ledger, sub, facts) {
  const user = own(ledger.users, sub);
  return (user && user.email) || facts.metadataEmail || facts.email || sub;
}

// The one idempotent step for an order (webhook or sync, any number of
// times): grant its credits once when it is paid, revoke monotonically on
// refunds, or park it as unclaimed. `owner` forces the owner (claiming).
// -> { changed } (true when a grant or revoke entry was added now).
function applyOrder(ledger, facts, { nowIso, owner = null, log = () => {} }) {
  if (!usableKey(facts.id)) return { changed: false };
  const stored = own(ledger.orders, facts.id);
  const record = stored
    ? { ...stored }
    : { sub: null, email: null, checkoutId: null, customerId: null, granted: 0, revoked: 0 };
  record.email = facts.email || record.email || null;
  record.checkoutId = record.checkoutId || facts.checkoutId;
  record.customerId = facts.customerId || record.customerId || null;
  const grantable = facts.paid && GRANT_REASONS.has(facts.reason) && facts.credits !== null;
  const sub = record.sub || owner || resolveOwner(ledger, facts);

  if (!usableKey(sub)) {
    // Unclaimed: kept by email with its latest state until a signed-in user
    // with that email opens the billing page.
    if (!(grantable || record.pending) || !record.email) {
      if (grantable) log(`[billing] order ${facts.id} unclaimed (no customer email); nothing can be credited`);
      return { changed: false };
    }
    if (!record.pending) log(`[billing] order ${facts.id} unclaimed (${record.email})`);
    record.sub = null;
    record.pending = facts;
    ledger.orders[facts.id] = record;
    return { changed: false };
  }

  record.sub = sub;
  delete record.pending;
  let changed = false;
  if (!(record.granted > 0) && grantable) {
    newEntry(ledger, { at: nowIso, sub, delta: facts.credits, kind: 'grant', label: facts.label, orderId: facts.id });
    record.granted = facts.credits;
    record.revoked = 0;
    changed = true;
    log(`[billing] order ${facts.id} +${facts.credits} credits to ${ownerEmail(ledger, sub, facts)}`);
  }
  if (record.granted > 0) {
    const target = revokeTarget(facts, record.granted);
    const extra = target - (record.revoked || 0);
    if (extra > 0) {
      newEntry(ledger, { at: nowIso, sub, delta: -extra, kind: 'revoke', label: facts.label, orderId: facts.id });
      record.revoked = target;
      changed = true;
      log(`[billing] order ${facts.id} -${extra} credits from ${ownerEmail(ledger, sub, facts)} (${facts.status})`);
    }
  } else if (facts.paid && PLAN_CHANGE_REASONS.has(facts.reason)) {
    log(`[billing] order ${facts.id} grants nothing (${facts.reason}; plan changes apply at the next renewal)`);
  } else if (facts.paid && GRANT_REASONS.has(facts.reason) && facts.credits === null) {
    log(`[billing] order ${facts.id} grants nothing (not a credit product)`);
  }
  if (changed) {
    record.appliedAt = nowIso;
    const user = own(ledger.users, sub) || { email: facts.metadataEmail || facts.email || null };
    ledger.users[sub] = facts.customerId ? { ...user, polarCustomerId: facts.customerId } : { ...user };
  }
  if (record.granted > 0) ledger.orders[facts.id] = record;
  else if (stored) delete ledger.orders[facts.id];
  return { changed };
}

// Applies the unclaimed orders parked under this email to this user.
// -> the number of orders that changed the ledger.
function claimOrders(ledger, sub, email, context) {
  let applied = 0;
  for (const id of Object.keys(ledger.orders)) {
    const record = own(ledger.orders, id);
    if (!record || record.sub || !record.pending || record.email !== email) continue;
    if (applyOrder(ledger, record.pending, { ...context, owner: sub }).changed) applied += 1;
  }
  return applied;
}

// Balance check + debit in one step. credits 0 debits nothing.
// -> { ok: true, chargeId|null, balance } or { ok: false, balance }.
function chargeCredits(ledger, { sub, email, credits, label, jobId, nowIso }) {
  touchUser(ledger, sub, email);
  const balance = balanceOf(ledger, sub);
  if (balance < 0 || balance < credits) return { ok: false, balance };
  if (credits === 0) return { ok: true, chargeId: null, balance };
  const entry = newEntry(ledger, { at: nowIso, sub, delta: -credits, kind: 'charge', label, jobId });
  return { ok: true, chargeId: entry.id, balance: balance - credits };
}

// Whether this job charge was given back. A refund names its charge
// (chargeId); one written before a job could be charged twice (a re-fetch
// takes a refunded job's credits again) names only its job, and gave back
// that job's first charge.
function chargeRefunded(ledger, charge) {
  let firstCharge = null;
  let legacyRefund = false;
  for (const entry of ledger.entries) {
    if (!entry || entry.jobId !== charge.jobId) continue;
    if (entry.kind === 'refund') {
      if (entry.chargeId === charge.id) return true;
      if (entry.chargeId === undefined && entry.sub === charge.sub) legacyRefund = true;
    } else if (entry.kind === 'charge' && firstCharge === null) {
      firstCharge = entry;
    }
  }
  return legacyRefund && firstCharge !== null && firstCharge.id === charge.id;
}

// Gives a job charge back once (same label). Works whatever the billing mode.
// Each charge of a job is refunded on its own, at most once.
// -> { refunded: false } when the ledger has no such charge, else
//    { refunded: true, now, credits, sub, email } (now: false = already refunded).
function refundCharge(ledger, { chargeId, nowIso }) {
  const charge = ledger.entries.find(entry => entry && entry.id === chargeId && entry.kind === 'charge');
  if (!charge || typeof charge.jobId !== 'string') return { refunded: false };
  const credits = -charge.delta;
  const user = own(ledger.users, charge.sub);
  const email = (user && user.email) || charge.sub;
  if (chargeRefunded(ledger, charge)) return { refunded: true, now: false, credits, sub: charge.sub, email };
  newEntry(ledger, { at: nowIso, sub: charge.sub, delta: credits, kind: 'refund', label: charge.label, jobId: charge.jobId, chargeId: charge.id });
  return { refunded: true, now: true, credits, sub: charge.sub, email };
}

module.exports = {
  ADMIN_HISTORY_LIMIT,
  ADMIN_USERS_LIMIT,
  DISPLAY_LEDGER_PATH,
  HISTORY_LIMIT,
  WEBHOOK_RETENTION_MS,
  adjustCredits,
  adminEntryOwner,
  adminHistory,
  adminTarget,
  adminUsers,
  applyOrder,
  balanceOf,
  chargeCredits,
  chargeRefunded,
  claimAdminEntries,
  claimOrders,
  customerIdOf,
  entryView,
  grantedForCheckout,
  hasWebhook,
  historyOf,
  openLedger,
  pendingBalance,
  recordWebhook,
  refundCharge,
  revokeTarget,
  touchUser,
};
