'use strict';

// The user-written Google login config (<dataDir>/auth/config.json). The server
// only reads it. Absent -> login is off; present but unusable -> "invalid" (the
// app fails closed); valid -> login is required.
//
// { "google": { "clientId", "clientSecret" }, "allowedEmails": [...], "publicUrl"? }

const fsp = require('node:fs/promises');

// Shown to users (status payload, logs) instead of the real absolute path.
const DISPLAY_CONFIG_PATH = 'data/auth/config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;

function normalizeEmail(value) {
  return String(value).trim().toLowerCase();
}

// allowedEmails entries are exact addresses, or "@domain" for every address at that domain.
function isEmailAllowed(allowedEmails, email) {
  if (typeof email !== 'string' || !email) return false;
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  const domain = at > 0 ? normalized.slice(at + 1) : null;
  return allowedEmails.some(entry => (entry.startsWith('@') ? domain !== null && entry.slice(1) === domain : entry === normalized));
}

// publicUrl: an http(s) origin, optionally with a trailing "/". Returns the parsed
// URL, null when unset, or undefined when the value is unusable.
function parsePublicUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('?') || trimmed.includes('#')) return undefined;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || !url.hostname || url.pathname !== '/' || url.search || url.hash) return undefined;
  return url;
}

// Validate parsed JSON. Always returns { mode, problem, config, publicUrl }:
// publicUrl is reported on its own (when it is valid) even if another field is
// wrong, so the login page stays reachable through the public host.
function validateAuthConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: 'invalid', problem: 'invalid_json', config: null, publicUrl: null };
  }
  const publicUrl = parsePublicUrl(raw.publicUrl);
  const validPublicUrl = publicUrl || null;
  const google = raw.google && typeof raw.google === 'object' && !Array.isArray(raw.google) ? raw.google : {};
  const clientId = typeof google.clientId === 'string' ? google.clientId.trim() : '';
  const clientSecret = typeof google.clientSecret === 'string' ? google.clientSecret.trim() : '';
  if (!clientId || !clientSecret) return { mode: 'invalid', problem: 'missing_client', config: null, publicUrl: validPublicUrl };
  const allowedEmails = Array.isArray(raw.allowedEmails)
    ? [...new Set(raw.allowedEmails.filter(entry => typeof entry === 'string').map(normalizeEmail).filter(Boolean))]
    : [];
  if (!allowedEmails.length) return { mode: 'invalid', problem: 'no_allowed_emails', config: null, publicUrl: validPublicUrl };
  if (publicUrl === undefined) return { mode: 'invalid', problem: 'bad_public_url', config: null, publicUrl: null };
  return { mode: 'enabled', problem: null, config: { clientId, clientSecret, allowedEmails }, publicUrl: validPublicUrl };
}

function parseAuthConfig(text) {
  let raw;
  try {
    // Editors on Windows may prepend a UTF-8 BOM.
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return { mode: 'invalid', problem: 'invalid_json', config: null, publicUrl: null };
  }
  return validateAuthConfig(raw);
}

const DISABLED = Object.freeze({ mode: 'disabled', problem: null, config: null, publicUrl: null });
const UNREADABLE = Object.freeze({ mode: 'invalid', problem: 'invalid_json', config: null, publicUrl: null });

// Watches config.json: stat at most once per intervalMs (on the injected clock),
// and re-read only when the file's identity, size or mtime changed. A read that
// races with an editor may see partial JSON; that stays "invalid" until the next
// change, so the app fails closed meanwhile.
function createConfigWatcher(configPath, { now, intervalMs, onChange = () => {} }) {
  let state = DISABLED;
  let signature;
  let checkedAt = null;
  let inflight = null;

  async function check() {
    let stat;
    try {
      stat = await fsp.stat(configPath);
    } catch (error) {
      return error.code === 'ENOENT' || error.code === 'ENOTDIR'
        ? { signature: 'absent', state: DISABLED }
        : { signature: `error:${error.code}`, state: UNREADABLE };
    }
    const nextSignature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (nextSignature === signature) return null;
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return { signature: nextSignature, state: UNREADABLE };
    try {
      return { signature: nextSignature, state: parseAuthConfig(await fsp.readFile(configPath, 'utf8')) };
    } catch (error) {
      return error.code === 'ENOENT'
        ? { signature: 'absent', state: DISABLED }
        : { signature: nextSignature, state: UNREADABLE };
    }
  }

  async function refresh() {
    const time = now();
    if (checkedAt !== null && time >= checkedAt && time - checkedAt < intervalMs) return state;
    if (!inflight) {
      inflight = (async () => {
        try {
          const result = await check();
          checkedAt = now();
          if (result) {
            const previous = state;
            signature = result.signature;
            state = result.state;
            if (previous !== state) onChange(state, previous);
          }
          return state;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  }

  return { refresh, current: () => state };
}

module.exports = {
  DISPLAY_CONFIG_PATH,
  createConfigWatcher,
  isEmailAllowed,
  normalizeEmail,
  parseAuthConfig,
  parsePublicUrl,
  validateAuthConfig,
};
