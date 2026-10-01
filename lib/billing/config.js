'use strict';

// The user-written billing config (<dataDir>/billing/config.json). The server
// only reads it. Absent -> billing is off; present but unusable -> "invalid"
// (paid generation fails closed); valid -> paid jobs cost credits (index.js
// also requires Google login to be on).
//
// { "adminEmails": [...], "freeEmails"?: [...], "creditsPerUsd"?, "transferNote"?,
//   "polar"?: { "server", "accessToken", "webhookSecret", "apiVersion"? } }
//
// Customers pay by bank transfer and an admin (adminEmails) adds their
// credits. Polar checkout is optional: on only while `polar` is present.

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
const MAX_TRANSFER_NOTE = 1000;
const MAX_EMAIL_LENGTH = 254;
const WEBHOOK_SECRET_PREFIX = 'whsec_';

// Problem codes, in the order they are checked (login_required is added by
// index.js). The Polar ones only apply while `polar` is present.
const PROBLEMS = Object.freeze([
  'invalid_json', 'bad_admin_emails', 'bad_server', 'missing_token', 'bad_webhook_secret', 'bad_api_version',
  'bad_credits_per_usd', 'bad_free_emails', 'bad_welcome_credits', 'bad_transfer_note', 'login_required',
]);

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// A full address (not "@domain"): trimmed and lowercased, exactly one "@"
// with text on both sides, no whitespace or control characters, at most 254
// characters. -> the normalized address, or null.
function fullEmail(value) {
  if (typeof value !== 'string') return null;
  const email = normalizeEmail(value);
  const at = email.indexOf('@');
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  if (/[\s\x00-\x1f\x7f]/.test(email)) return null;
  return email;
}

// The webhook secret on its own: the webhook keeps working whenever the file
// parses and this is usable, even if another field is wrong (payments must
// never be lost). A bare prefix is no secret at all.
function webhookSecretOf(polar) {
  if (!isObject(polar) || typeof polar.webhookSecret !== 'string') return null;
  const value = polar.webhookSecret.trim();
  return value.startsWith(WEBHOOK_SECRET_PREFIX) && value.length > WEBHOOK_SECRET_PREFIX.length ? value : null;
}

const DEFAULT_WELCOME_CREDITS = 100;
const MAX_WELCOME_CREDITS = 1000000;

// creditsPerUsd (default 2000, integer 1..100000), or null when unusable.
function creditsPerUsdOf(value) {
  const rate = value == null ? DEFAULT_CREDITS_PER_USD : value;
  return Number.isInteger(rate) && rate >= 1 && rate <= MAX_CREDITS_PER_USD ? rate : null;
}

// A state for a file that could not be read or parsed: whether Polar is on is
// unknown, so the webhook answers 503 (Polar retries) rather than 404.
function unparsed() {
  return { mode: 'invalid', problem: 'invalid_json', config: null, polar: null, webhookSecret: null, creditsPerUsd: DEFAULT_CREDITS_PER_USD };
}

// Validate parsed JSON. Always returns { mode, problem, config, polar,
// webhookSecret, creditsPerUsd }: polar = whether the file has a `polar`
// section (null when unknown), creditsPerUsd = the file's rate when usable,
// else the default (shown even while the file is invalid).
function validateBillingConfig(raw) {
  if (!isObject(raw)) return unparsed();
  const hasPolar = raw.polar !== undefined && raw.polar !== null;
  const polar = hasPolar && isObject(raw.polar) ? raw.polar : null;
  const webhookSecret = hasPolar ? webhookSecretOf(polar) : null;
  const rate = creditsPerUsdOf(raw.creditsPerUsd);
  const creditsPerUsd = rate === null ? DEFAULT_CREDITS_PER_USD : rate;
  const fail = problem => ({ mode: 'invalid', problem, config: null, polar: hasPolar, webhookSecret, creditsPerUsd });

  if (!Array.isArray(raw.adminEmails) || !raw.adminEmails.length) return fail('bad_admin_emails');
  const adminEmails = raw.adminEmails.map(fullEmail);
  if (adminEmails.includes(null)) return fail('bad_admin_emails');

  let polarConfig = null;
  if (hasPolar) {
    if (!polar || typeof polar.server !== 'string' || !Object.hasOwn(POLAR_API_BASES, polar.server)) return fail('bad_server');
    const accessToken = typeof polar.accessToken === 'string' ? polar.accessToken.trim() : '';
    if (!accessToken) return fail('missing_token');
    if (!webhookSecret) return fail('bad_webhook_secret');
    const apiVersion = polar.apiVersion == null ? DEFAULT_API_VERSION : polar.apiVersion;
    if (typeof apiVersion !== 'string' || !API_VERSION_RE.test(apiVersion)) return fail('bad_api_version');
    polarConfig = { server: polar.server, apiBase: POLAR_API_BASES[polar.server], accessToken, webhookSecret, apiVersion };
  }
  if (rate === null) return fail('bad_credits_per_usd');

  let freeEmails = [];
  if (raw.freeEmails != null) {
    if (!Array.isArray(raw.freeEmails) || raw.freeEmails.some(entry => typeof entry !== 'string' || !entry.trim())) {
      return fail('bad_free_emails');
    }
    // Matched like auth allowedEmails: exact addresses, or "@domain".
    freeEmails = [...new Set(raw.freeEmails.map(normalizeEmail))];
  }

  // Credits a new sign-up gets once (default 100; 0 turns it off).
  let welcomeCredits = DEFAULT_WELCOME_CREDITS;
  if (raw.welcomeCredits != null) {
    if (!Number.isInteger(raw.welcomeCredits) || raw.welcomeCredits < 0 || raw.welcomeCredits > MAX_WELCOME_CREDITS) return fail('bad_welcome_credits');
    welcomeCredits = raw.welcomeCredits;
  }

  let transferNote = null;
  if (raw.transferNote != null) {
    const note = typeof raw.transferNote === 'string' ? raw.transferNote.trim() : '';
    if (!note || note.length > MAX_TRANSFER_NOTE) return fail('bad_transfer_note');
    transferNote = note;
  }

  return {
    mode: 'enabled',
    problem: null,
    polar: hasPolar,
    webhookSecret,
    creditsPerUsd: rate,
    config: {
      adminEmails: [...new Set(adminEmails)],
      freeEmails,
      welcomeCredits,
      creditsPerUsd: rate,
      transferNote,
      // null = Polar off (no product list, checkout, sync, portal or webhook).
      polar: polarConfig,
    },
  };
}

function parseBillingConfig(text) {
  let raw;
  try {
    // Editors on Windows may prepend a UTF-8 BOM.
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return unparsed();
  }
  return validateBillingConfig(raw);
}

const DISABLED = Object.freeze({
  mode: 'disabled', problem: null, config: null, polar: false, webhookSecret: null, creditsPerUsd: DEFAULT_CREDITS_PER_USD,
});
const UNREADABLE = Object.freeze(unparsed());

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
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        // No config.json (a host without a persistent disk): the same JSON may be in VIRTUALLY_BILLING_CONFIG.
        const text = process.env.VIRTUALLY_BILLING_CONFIG;
        return text && text.trim() ? { signature: 'env', state: parseBillingConfig(text) } : { signature: 'absent', state: DISABLED };
      }
      return { signature: `error:${error.code}`, state: UNREADABLE };
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
  MAX_EMAIL_LENGTH,
  POLAR_API_BASES,
  PROBLEMS,
  createConfigWatcher,
  fullEmail,
  parseBillingConfig,
  validateBillingConfig,
};
