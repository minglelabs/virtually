'use strict';

// Server-managed login secrets (<dataDir>/auth/state.json, file 0600, dir 0700):
// { "sessionSecret": <base64url 32 bytes>, "overlayKeys": { <google sub>: <base64url 24 bytes> } }.
// Every account has its own OBS overlay key, made the first time it is asked
// for; the key tells the overlay (which has no login) whose characters to show.
// Created on startup when missing and kept across restarts; written atomically.

const path = require('node:path');
const crypto = require('node:crypto');

const { createFileDocs } = require('../docs');

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function newSessionSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function newOverlayKey() {
  return crypto.randomBytes(24).toString('base64url');
}

function validSecret(value, minBytes) {
  return typeof value === 'string' && BASE64URL.test(value) && Buffer.from(value, 'base64url').length >= minBytes;
}

function keyHash(key) {
  return crypto.createHash('sha256').update(key).digest('base64url');
}

function cleanKeys(value) {
  const keys = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return keys;
  const seen = new Set();
  for (const [sub, key] of Object.entries(value)) {
    if (!sub || !validSecret(key, 24) || seen.has(key)) continue;
    seen.add(key);
    keys[sub] = key;
  }
  return keys;
}

// Returns { get(), overlayKeyOf(sub), subForKey(key), rotateOverlayKey(sub) }.
// `log` reports a regenerated state file.
async function openStateStore(authDir, { log = () => {}, docs = createFileDocs() } = {}) {
  const filePath = path.join(authDir, 'state.json');
  const writeState = (file, value) => docs.write(file, value, { private: true });

  let stored = null;
  let unreadable = false;
  try {
    stored = await docs.read(filePath);
  } catch (error) {
    // A database that cannot be reached must not look like a damaged state (it would be
    // overwritten with fresh secrets); only a file we cannot parse or open does.
    if (docs.kind !== 'file' && !(error instanceof SyntaxError)) throw error;
    unreadable = true;
  }
  const record = stored && typeof stored === 'object' ? stored : {};
  let state = {
    sessionSecret: validSecret(record.sessionSecret, 32) ? record.sessionSecret : newSessionSecret(),
    overlayKeys: cleanKeys(record.overlayKeys),
  };
  // A file from before per-account keys (a single global overlayKey) is rewritten
  // without it: that key could not say whose overlay it was.
  const clean = stored && state.sessionSecret === record.sessionSecret && !('overlayKey' in record)
    && JSON.stringify(state.overlayKeys) === JSON.stringify(record.overlayKeys || {});
  if (!clean) {
    if (stored || unreadable) log('[auth] data/auth/state.json was unreadable or incomplete; it was rewritten (OBS keys are made again per account)');
    await writeState(filePath, state);
  } else if (docs.secure) {
    await docs.secure(filePath);
  }

  // sha256(key) -> sub, so a key from an overlay URL finds its account at once.
  let bySub = new Map();
  let byHash = new Map();
  const index = () => {
    bySub = new Map(Object.entries(state.overlayKeys));
    byHash = new Map(Object.entries(state.overlayKeys).map(([sub, key]) => [keyHash(key), sub]));
  };
  index();

  let queue = Promise.resolve();
  function mutate(update) {
    const next = queue.then(async () => {
      const updated = update(state);
      await writeState(filePath, updated);
      // Switch only after the new state is on disk, so a failed write keeps the old keys.
      state = updated;
      index();
    });
    queue = next.catch(() => {});
    return next;
  }

  // The account's key, made on first use.
  async function overlayKeyOf(sub) {
    if (bySub.has(sub)) return bySub.get(sub);
    let key;
    await mutate(current => {
      key = current.overlayKeys[sub] || newOverlayKey();
      return { ...current, overlayKeys: { ...current.overlayKeys, [sub]: key } };
    });
    return key;
  }

  // The account a key belongs to, or null.
  function subForKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) return null;
    return byHash.get(keyHash(key)) ?? null;
  }

  // A new key for the account. onSwitched(oldKey) runs synchronously right after
  // the in-memory key changes, so the caller can tell what the old key admitted
  // apart from what the new one admits.
  async function rotateOverlayKey(sub, onSwitched = () => {}) {
    let fresh;
    let old = null;
    await mutate(current => {
      old = current.overlayKeys[sub] || null;
      fresh = newOverlayKey();
      return { ...current, overlayKeys: { ...current.overlayKeys, [sub]: fresh } };
    });
    onSwitched(old, fresh);
    return fresh;
  }

  return { get: () => state, overlayKeyOf, subForKey, rotateOverlayKey, filePath };
}

module.exports = { openStateStore };
