'use strict';

// Server-managed login secrets (<dataDir>/auth/state.json, file 0600, dir 0700):
// { "sessionSecret": <base64url 32 bytes>, "overlayKey": <base64url 24 bytes> }.
// Created on startup when missing and kept across restarts; written atomically.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

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

async function writeState(filePath, state) {
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, filePath);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// Returns { get(), rotateOverlayKey() }. `log` reports a regenerated state file.
async function openStateStore(authDir, { log = () => {} } = {}) {
  const filePath = path.join(authDir, 'state.json');
  await fsp.mkdir(authDir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to a directory it creates; tighten an existing one too.
  await fsp.chmod(authDir, 0o700);

  let stored = null;
  let unreadable = false;
  try {
    stored = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') unreadable = true;
  }
  const record = stored && typeof stored === 'object' ? stored : {};
  let state = {
    sessionSecret: validSecret(record.sessionSecret, 32) ? record.sessionSecret : newSessionSecret(),
    overlayKey: validSecret(record.overlayKey, 24) ? record.overlayKey : newOverlayKey(),
  };
  if (!stored || state.sessionSecret !== record.sessionSecret || state.overlayKey !== record.overlayKey) {
    if (stored || unreadable) log('[auth] data/auth/state.json was unreadable or incomplete; created new secrets (sessions and the OBS key were reset)');
    await writeState(filePath, state);
  } else {
    await fsp.chmod(filePath, 0o600);
  }

  let queue = Promise.resolve();
  // onSwitched runs synchronously right after the in-memory key changes, so the
  // caller can tell what the old key admitted apart from what the new one admits.
  function rotateOverlayKey(onSwitched = () => {}) {
    const next = queue.then(async () => {
      const updated = { ...state, overlayKey: newOverlayKey() };
      await writeState(filePath, updated);
      // Switch only after the new key is on disk, so a failed write keeps the old key.
      state = updated;
      onSwitched(updated.overlayKey);
      return updated.overlayKey;
    });
    queue = next.catch(() => {});
    return next;
  }

  return { get: () => state, rotateOverlayKey, filePath };
}

module.exports = { openStateStore };
