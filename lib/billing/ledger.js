'use strict';

// The credit ledger: <dataDir>/billing/ledger.json (file 0600, dir 0700),
// written atomically (tmp + rename). Every mutation runs through one queue on
// a copy that replaces the in-memory state only once it is on disk, so a
// balance check and its debit happen in one step (no double spend) and a
// failed write changes nothing.
//
// {
//   "version": 1,
//   "users":    { <sub>: { email, polarCustomerId? } },
//   "entries":  [ { id, at, sub, delta, kind: 'grant'|'revoke'|'charge'|'refund', label, orderId?, jobId? } ],
//   "orders":   { <orderId>: { sub, email, checkoutId, customerId, granted, revoked, appliedAt?, pending? } },
//   "webhooks": { <webhook-id>: <ms when handled> }   (kept 30 days)
// }
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

// --- mutations (on a draft) --------------------------------------------------

function newEntry(ledger, fields) {
  const entry = { id: crypto.randomUUID(), ...fields };
  ledger.entries.push(entry);
  return entry;
}

// Creates the user's record on their first billing request; keeps the email current.
function touchUser(ledger, sub, email) {
  if (!usableKey(sub)) return;
  const user = own(ledger.users, sub);
  if (!user) ledger.users[sub] = { email };
  else if (user.email !== email) ledger.users[sub] = { ...user, email };
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

// Gives a job charge back once (same label). Works whatever the billing mode.
// -> { refunded: false } when the ledger has no such charge, else
//    { refunded: true, now, credits, sub, email } (now: false = already refunded).
function refundCharge(ledger, { chargeId, nowIso }) {
  const charge = ledger.entries.find(entry => entry && entry.id === chargeId && entry.kind === 'charge');
  if (!charge || typeof charge.jobId !== 'string') return { refunded: false };
  const credits = -charge.delta;
  const user = own(ledger.users, charge.sub);
  const email = (user && user.email) || charge.sub;
  const already = ledger.entries.some(entry => entry && entry.kind === 'refund' && entry.jobId === charge.jobId && entry.sub === charge.sub);
  if (already) return { refunded: true, now: false, credits, sub: charge.sub, email };
  newEntry(ledger, { at: nowIso, sub: charge.sub, delta: credits, kind: 'refund', label: charge.label, jobId: charge.jobId });
  return { refunded: true, now: true, credits, sub: charge.sub, email };
}

module.exports = {
  DISPLAY_LEDGER_PATH,
  HISTORY_LIMIT,
  WEBHOOK_RETENTION_MS,
  applyOrder,
  balanceOf,
  chargeCredits,
  claimOrders,
  customerIdOf,
  grantedForCheckout,
  hasWebhook,
  historyOf,
  openLedger,
  recordWebhook,
  refundCharge,
  revokeTarget,
  touchUser,
};
