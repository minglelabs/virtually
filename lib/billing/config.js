'use strict';

// The user-written billing config (<dataDir>/billing/config.json). The server
// only reads it. Absent -> billing is off; present but unusable -> "invalid"
// (paid generation fails closed); valid -> paid jobs cost credits (index.js
// also requires Google login to be on).
//
// { "polar": { "server", "accessToken", "webhookSecret", "apiVersion"? },
//   "creditsPerUsd"?, "freeEmails"? }

const fsp = require('node:fs/promises');

const { normalizeEmail } = require('../auth/config');
const { DEFAULT_CREDITS_PER_USD } = require('../../public/credits');

// Shown to users (logs, problem lines) instead of the real absolute path.
const DISPLAY_CONFIG_PATH = 'data/billing/config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
const POLAR_API_BASES = Object.freeze({
  sandbox: 'https://sandbox-api.polar.sh/v1',
  production: 'https://api.polar.sh/v1',
});
const DEFAULT_API_VERSION = '2026-10';
const API_VERSION_RE = /^\d{4}-\d{2}$/;
const MAX_CREDITS_PER_USD = 100000;
const WEBHOOK_SECRET_PREFIX = 'whsec_';

// Problem codes, in the order they are checked (login_required is added by index.js).
const PROBLEMS = Object.freeze([
  'invalid_json', 'bad_server', 'missing_token', 'bad_webhook_secret', 'bad_api_version',
  'bad_credits_per_usd', 'bad_free_emails', 'login_required',
]);

// The webhook secret on its own: the webhook keeps working whenever the file
// parses and this is usable, even if another field is wrong (payments must
// never be lost). A bare prefix is no secret at all.
function webhookSecretOf(polar) {
  if (!polar || typeof polar.webhookSecret !== 'string') return null;
  const value = polar.webhookSecret.trim();
  return value.startsWith(WEBHOOK_SECRET_PREFIX) && value.length > WEBHOOK_SECRET_PREFIX.length ? value : null;
}

// Validate parsed JSON. Always returns { mode, problem, config, webhookSecret }.
function validateBillingConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: 'invalid', problem: 'invalid_json', config: null, webhookSecret: null };
  }
  const polar = raw.polar && typeof raw.polar === 'object' && !Array.isArray(raw.polar) ? raw.polar : null;
  const webhookSecret = webhookSecretOf(polar);
  const fail = problem => ({ mode: 'invalid', problem, config: null, webhookSecret });
  if (!polar || typeof polar.server !== 'string' || !Object.hasOwn(POLAR_API_BASES, polar.server)) return fail('bad_server');
  const accessToken = typeof polar.accessToken === 'string' ? polar.accessToken.trim() : '';
  if (!accessToken) return fail('missing_token');
  if (!webhookSecret) return fail('bad_webhook_secret');
  const apiVersion = polar.apiVersion == null ? DEFAULT_API_VERSION : polar.apiVersion;
  if (typeof apiVersion !== 'string' || !API_VERSION_RE.test(apiVersion)) return fail('bad_api_version');
  const creditsPerUsd = raw.creditsPerUsd == null ? DEFAULT_CREDITS_PER_USD : raw.creditsPerUsd;
  if (!Number.isInteger(creditsPerUsd) || creditsPerUsd < 1 || creditsPerUsd > MAX_CREDITS_PER_USD) {
    return fail('bad_credits_per_usd');
  }
  let freeEmails = [];
  if (raw.freeEmails != null) {
    if (!Array.isArray(raw.freeEmails) || raw.freeEmails.some(entry => typeof entry !== 'string' || !entry.trim())) {
      return fail('bad_free_emails');
    }
    // Matched like auth allowedEmails: exact addresses, or "@domain".
    freeEmails = [...new Set(raw.freeEmails.map(normalizeEmail))];
  }
  return {
    mode: 'enabled',
    problem: null,
    webhookSecret,
    config: {
      server: polar.server,
      apiBase: POLAR_API_BASES[polar.server],
      accessToken,
      webhookSecret,
      apiVersion,
      creditsPerUsd,
      freeEmails,
    },
  };
}

function parseBillingConfig(text) {
  let raw;
  try {
    // Editors on Windows may prepend a UTF-8 BOM.
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return { mode: 'invalid', problem: 'invalid_json', config: null, webhookSecret: null };
  }
  return validateBillingConfig(raw);
}

const DISABLED = Object.freeze({ mode: 'disabled', problem: null, config: null, webhookSecret: null });
const UNREADABLE = Object.freeze({ mode: 'invalid', problem: 'invalid_json', config: null, webhookSecret: null });

// Watches config.json exactly like the auth config: stat at most once per
// intervalMs (on the injected clock), and re-read only when the file's
// identity, size or mtime changed. A read that races with an editor may see
// partial JSON; that stays "invalid" until the next change (fail closed).
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
      return { signature: nextSignature, state: parseBillingConfig(await fsp.readFile(configPath, 'utf8')) };
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
  DEFAULT_API_VERSION,
  DISPLAY_CONFIG_PATH,
  POLAR_API_BASES,
  PROBLEMS,
  createConfigWatcher,
  parseBillingConfig,
  validateBillingConfig,
};
