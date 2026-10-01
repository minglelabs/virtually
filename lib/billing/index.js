'use strict';

// Credit billing. createBilling() owns the hot-reloaded billing config, the
// credit ledger, the admin top-up routes, the optional Polar client, the
// /api/billing* routes, the Polar webhook, and the job charge/refund hooks the
// animate API calls. server.js calls, per request: refresh() next to the auth
// refresh, handleWebhook() after its Host/Origin checks and BEFORE the auth
// routes and gate (Polar has no session), and handleApi() after the gate.
//
// Modes: disabled (no config.json) -> no billing at all, the app behaves as
// before; enabled (valid file and Google login on) -> paid jobs cost
// credits; invalid -> paid generation and the POST billing routes fail
// closed, while the webhook keeps working as long as the file parses, has a
// `polar` section and its webhook secret is usable (payments are never lost).
//
// Credits come from an admin (bank transfer, 1 credit = 1 KRW) and, while
// `polar` is configured, from Polar orders. Pending admin entries and
// unclaimed Polar orders move to a user at the start of each of its signed-in
// billing requests and right before each of its job charges.

const net = require('node:net');
const path = require('node:path');

const { DEFAULT_CREDITS_PER_USD, creditsFor } = require('../../public/credits');
const { isEmailAllowed, normalizeEmail } = require('../auth/config');
const { DISPLAY_CONFIG_PATH, createConfigWatcher, fullEmail } = require('./config');
const ledgers = require('./ledger');
const { PolarError, listAll, orderFacts, polarRequest, productView, sortProducts } = require('./polar');
const { readRawBody, verifyWebhook } = require('./webhook');

const WEBHOOK_PATH = '/api/billing/polar/webhook';
const PRODUCT_CACHE_MS = 60 * 1000;
const FULL_SYNC_INTERVAL_MS = 5 * 1000;
const ORDER_EVENTS = new Set(['order.paid', 'order.updated', 'order.refunded']);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_CUSTOMER_NAME = 256;
const MAX_QUERY_LENGTH = 100;
const MAX_MEMO_LENGTH = 200;
const MAX_ADJUST_CREDITS = 100000000;

// Addresses that say nothing about where a customer is.
const NON_PUBLIC = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
]) NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
NON_PUBLIC.addAddress('::', 'ipv6');
NON_PUBLIC.addAddress('::1', 'ipv6');
NON_PUBLIC.addSubnet('fc00::', 7, 'ipv6');
NON_PUBLIC.addSubnet('fe80::', 10, 'ipv6');

function apiError(status, code, message, detail) {
  return Object.assign(new Error(message), { status, code, detail });
}

function badField(field) {
  return apiError(400, 'bad_request', `Invalid ${field}.`, { field });
}

// A customer IP worth telling Polar (tax location, fraud checks), or null.
function publicIp(value) {
  let candidate = String(value || '').trim();
  if (candidate.startsWith('[')) {
    const end = candidate.indexOf(']');
    candidate = end > 0 ? candidate.slice(1, end) : '';
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate);
  if (mapped) candidate = mapped[1];
  const family = net.isIP(candidate);
  if (!family) return null;
  return NON_PUBLIC.check(candidate, family === 4 ? 'ipv4' : 'ipv6') ? null : candidate;
}

function describe(state) {
  if (state.mode === 'enabled') {
    return state.config.polar
      ? `Billing (Polar): on (${state.config.polar.server})`
      : 'Billing: on (admin top-ups; Polar off)';
  }
  if (state.mode === 'invalid') {
    return `Billing config problem: ${state.problem} (${DISPLAY_CONFIG_PATH}) - paid generation stays locked until it is fixed`;
  }
  return `Billing: off (no ${DISPLAY_CONFIG_PATH})`;
}

async function createBilling({
  dataDir,
  auth,
  sendJson,
  readBody,
  // Test-only: overrides the Polar API base derived from polar.server.
  apiBase = null,
  now = Date.now,
  configCheckIntervalMs = 1000,
  log = message => console.log(message),
} = {}) {
  if (!dataDir) throw new Error('createBilling needs dataDir.');
  if (!auth) throw new Error('createBilling needs auth.');
  const intervalMs = Number.isFinite(configCheckIntervalMs) && configCheckIntervalMs >= 0 ? configCheckIntervalMs : 1000;
  const billingDir = path.join(dataDir, 'billing');
  const watcher = createConfigWatcher(path.join(billingDir, 'config.json'), { now, intervalMs });
  await watcher.refresh();
  const ledger = await ledgers.openLedger(billingDir, { log });
  const polarOptions = { log };
  const context = () => ({ nowIso: new Date(now()).toISOString(), log });

  // The combined mode: the file's state, then Google login. creditsPerUsd is
  // known in every mode (the default while off or unusable).
  function current() {
    const file = watcher.current();
    if (file.mode === 'disabled') return { mode: 'disabled', problem: null, config: null, creditsPerUsd: DEFAULT_CREDITS_PER_USD };
    if (file.mode !== 'enabled') return { mode: 'invalid', problem: file.problem, config: null, creditsPerUsd: file.creditsPerUsd };
    if (auth.summary().mode !== 'enabled') {
      return { mode: 'invalid', problem: 'login_required', config: null, creditsPerUsd: file.config.creditsPerUsd };
    }
    return { mode: 'enabled', problem: null, config: file.config, creditsPerUsd: file.config.creditsPerUsd };
  }

  let described = describe(current());

  async function refresh() {
    await watcher.refresh();
    // The startup state is printed by server.js; later changes are logged here.
    const text = describe(current());
    if (text !== described) log(`[billing] ${text}`);
    described = text;
  }

  function settingsFor(polar) {
    return { apiBase: apiBase || polar.apiBase, accessToken: polar.accessToken, apiVersion: polar.apiVersion };
  }

  function requireEnabled() {
    const state = current();
    if (state.mode === 'disabled') throw apiError(409, 'billing_disabled', 'Billing is off.');
    if (state.mode === 'invalid') {
      throw apiError(503, 'billing_misconfigured', 'The billing config has a problem.', { problem: state.problem });
    }
    return state.config;
  }

  function requirePolar(config) {
    if (!config.polar) throw apiError(409, 'polar_disabled', 'Polar checkout is not set up.');
    return config.polar;
  }

  // The gate admits /api/billing* only with a session while login is on.
  function sessionUser(access) {
    const session = access && access.session;
    if (!session || typeof session.sub !== 'string' || !session.sub || typeof session.email !== 'string' || !session.email) {
      throw apiError(401, 'auth_required', 'Login required.');
    }
    return { sub: session.sub, email: normalizeEmail(session.email), name: typeof session.name === 'string' ? session.name : null };
  }

  function isFree(config, email) {
    return isEmailAllowed(config.freeEmails, email);
  }

  function isAdmin(config, email) {
    return config.adminEmails.includes(email);
  }

  // Whether the CURRENT Google login allowlist lets this address sign in.
  function loginAllowed(email) {
    return typeof auth.loginAllowed === 'function' ? auth.loginAllowed(email) === true : false;
  }

  // Inside one ledger step: the user's record (email, name, last seen), then
  // its pending admin entries and unclaimed Polar orders move to it.
  // -> the number of admin entries moved.
  function claimFor(draft, user) {
    const { nowIso } = context();
    ledgers.touchUser(draft, user.sub, user.email, { name: user.name, nowIso });
    const moved = ledgers.claimAdminEntries(draft, user.sub, user.email);
    ledgers.claimOrders(draft, user.sub, user.email, context());
    return moved;
  }

  function logClaimed(moved, user) {
    if (moved) log(`[billing] ${moved} pending admin ${moved === 1 ? 'entry' : 'entries'} claimed by ${user.email}`);
  }

  // The start of every signed-in billing request (billing enabled).
  async function enter(access) {
    const user = sessionUser(access);
    logClaimed(await ledger.mutate(draft => claimFor(draft, user)), user);
    return user;
  }

  // Admin routes: billing on, the claim, then the admin check.
  async function enterAdmin(access) {
    const config = requireEnabled();
    const admin = await enter(access);
    if (!isAdmin(config, admin.email)) throw apiError(403, 'admin_only', 'Only admins can do this.');
    return { config, admin };
  }

  function polarFailure(error) {
    if (!(error instanceof PolarError)) return error;
    return apiError(502, 'polar_error', 'The Polar request failed.', { polarStatus: error.polarStatus });
  }

  function viaPublicHost(req) {
    const host = auth.publicHost();
    return host !== null && String(req.headers.host || '').toLowerCase() === host;
  }

  // Where Polar sends the browser back to.
  function requestOrigin(req) {
    const { publicUrl } = auth.summary();
    if (publicUrl && viaPublicHost(req)) return publicUrl;
    return `http://${req.headers.host || 'localhost'}`;
  }

  function customerIp(req) {
    if (viaPublicHost(req)) return publicIp(String(req.headers['x-forwarded-for'] || '').split(',')[0]);
    return publicIp(req.socket.remoteAddress);
  }

  async function jsonBody(req) {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw apiError(400, 'bad_request', 'Expected application/json.');
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      if (error.status === 400) throw apiError(400, 'bad_request', 'Invalid JSON.');
      throw error;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(400, 'bad_request', 'Body must be a JSON object.');
    return body;
  }

  // --- credit products (cached 60 s) ------------------------------------------

  // { key, list, hasList, error, errorStatus, fetchedAt }. A failed refresh
  // keeps the last good list and is itself cached, so a Polar outage is not
  // hammered by every page view.
  let catalog = { key: null, list: [], hasList: false, error: null, errorStatus: null, fetchedAt: null };
  let catalogFetch = null;

  async function loadCatalog(polar) {
    const settings = settingsFor(polar);
    const key = `${settings.apiBase}\n${settings.apiVersion}\n${settings.accessToken}`;
    if (catalog.key !== key) catalog = { key, list: [], hasList: false, error: null, errorStatus: null, fetchedAt: null };
    const time = now();
    if (catalog.fetchedAt !== null && time >= catalog.fetchedAt && time - catalog.fetchedAt < PRODUCT_CACHE_MS) return catalog;
    if (!catalogFetch || catalogFetch.key !== key) {
      const promise = (async () => {
        let next;
        try {
          const items = await listAll(settings, '/products/?is_archived=false&limit=100',
            page => `/products/?is_archived=false&limit=100&page=${page}`, polarOptions);
          next = { key, list: sortProducts(items.map(productView).filter(Boolean)), hasList: true, error: null, errorStatus: null, fetchedAt: now() };
        } catch (error) {
          if (!(error instanceof PolarError)) throw error;
          const status = error.polarStatus;
          next = { ...catalog, key, error: status === 401 || status === 403 ? 'polar_unauthorized' : 'polar_unreachable', errorStatus: status, fetchedAt: now() };
        }
        if (catalog.key === key) catalog = next;
        return next;
      })().finally(() => {
        if (catalogFetch && catalogFetch.promise === promise) catalogFetch = null;
      });
      catalogFetch = { key, promise };
    }
    return catalogFetch.promise;
  }

  // --- routes -------------------------------------------------------------------

  async function getBilling(req, res, url, access) {
    const state = current();
    if (state.mode === 'disabled') return sendJson(res, 200, { enabled: false, creditsPerUsd: state.creditsPerUsd });
    if (state.mode === 'invalid') {
      return sendJson(res, 200, {
        enabled: true, mode: 'invalid', problem: state.problem, creditsPerUsd: state.creditsPerUsd, balance: null, products: [], history: [],
      });
    }
    const { config } = state;
    const user = await enter(access);
    const products = config.polar ? await loadCatalog(config.polar) : null;
    const snapshot = ledger.read();
    return sendJson(res, 200, {
      enabled: true,
      mode: 'enabled',
      problem: null,
      server: config.polar ? config.polar.server : null,
      creditsPerUsd: config.creditsPerUsd,
      free: isFree(config, user.email),
      isAdmin: isAdmin(config, user.email),
      polar: !!config.polar,
      transferNote: config.transferNote,
      balance: ledgers.balanceOf(snapshot, user.sub),
      products: products ? products.list : [],
      productsError: products ? products.error : null,
      history: ledgers.historyOf(snapshot, user.sub),
      canManage: !!config.polar && ledgers.customerIdOf(snapshot, user.sub) !== null,
    });
  }

  async function createCheckout(req, res, url, access) {
    const config = requireEnabled();
    const user = await enter(access);
    const polar = requirePolar(config);
    const body = await jsonBody(req);
    if (typeof body.productId !== 'string' || !ID_RE.test(body.productId)) throw apiError(400, 'bad_request', 'productId is required.');
    const products = await loadCatalog(polar);
    if (!products.hasList && products.error) {
      throw apiError(502, 'polar_error', 'The Polar request failed.', { polarStatus: products.errorStatus });
    }
    if (!products.list.some(product => product.id === body.productId)) {
      throw apiError(400, 'unknown_product', 'This product is not for sale.');
    }
    const origin = requestOrigin(req);
    const payload = { products: [body.productId], external_customer_id: `google:${user.sub}`, customer_email: user.email };
    const name = typeof user.name === 'string' ? user.name.trim() : '';
    if (name) payload.customer_name = name.slice(0, MAX_CUSTOMER_NAME);
    const ip = customerIp(req);
    if (ip) payload.customer_ip_address = ip;
    payload.metadata = { virtually_user: user.sub, virtually_email: user.email };
    // Concatenated, not URL-built: Polar needs the braces literally.
    payload.success_url = `${origin}/billing?checkout_id={CHECKOUT_ID}`;
    payload.return_url = `${origin}/billing`;
    let checkout;
    try {
      checkout = await polarRequest(settingsFor(polar), 'POST', '/checkouts/', payload, polarOptions);
    } catch (error) {
      throw polarFailure(error);
    }
    if (typeof checkout.url !== 'string' || !/^https?:\/\//i.test(checkout.url)) {
      throw apiError(502, 'polar_error', 'Polar returned no checkout URL.', { polarStatus: null });
    }
    log(`[billing] checkout ${typeof checkout.id === 'string' ? checkout.id : '?'} created for ${user.email}`);
    return sendJson(res, 200, { url: checkout.url });
  }

  // Applies Polar orders (deduped by id) in one ledger step. -> applied count.
  function applyAll(orders, user) {
    const byId = new Map();
    for (const order of orders) {
      const facts = orderFacts(order);
      if (facts && !byId.has(facts.id)) byId.set(facts.id, facts);
    }
    return ledger.mutate(draft => {
      ledgers.touchUser(draft, user.sub, user.email);
      let applied = 0;
      for (const facts of byId.values()) {
        if (ledgers.applyOrder(draft, facts, context()).changed) applied += 1;
      }
      return applied;
    });
  }

  const lastFullSync = new Map(); // sub -> ms of the last full sync

  async function sync(req, res, url, access) {
    const config = requireEnabled();
    const user = await enter(access);
    const polar = requirePolar(config);
    const body = await jsonBody(req);
    const { checkoutId } = body;
    if (checkoutId != null && (typeof checkoutId !== 'string' || !ID_RE.test(checkoutId))) {
      throw apiError(400, 'bad_request', 'checkoutId is malformed.');
    }
    const settings = settingsFor(polar);
    const missing = () => apiError(404, 'checkout_missing', 'Checkout not found.');
    if (checkoutId) {
      let checkout;
      try {
        checkout = await polarRequest(settings, 'GET', `/checkouts/${checkoutId}`, undefined, polarOptions);
      } catch (error) {
        if (error instanceof PolarError && error.polarStatus === 404) throw missing();
        throw polarFailure(error);
      }
      const metadata = checkout.metadata && typeof checkout.metadata === 'object' ? checkout.metadata : {};
      if (metadata.virtually_user !== user.sub && checkout.external_customer_id !== `google:${user.sub}`) throw missing();
      let orders;
      try {
        orders = await listAll(settings, `/orders/?checkout_id=${checkoutId}&limit=100`,
          page => `/orders/?checkout_id=${checkoutId}&limit=100&page=${page}`, polarOptions);
      } catch (error) {
        throw polarFailure(error);
      }
      const applied = await applyAll(orders, user);
      const snapshot = ledger.read();
      return sendJson(res, 200, {
        balance: ledgers.balanceOf(snapshot, user.sub),
        applied,
        checkout: {
          status: typeof checkout.status === 'string' ? checkout.status : null,
          granted: ledgers.grantedForCheckout(snapshot, checkoutId),
        },
      });
    }
    // Full sync of this user's orders, at most once per 5 s per user.
    const time = now();
    const last = lastFullSync.get(user.sub);
    let applied = 0;
    if (last === undefined || time < last || time - last >= FULL_SYNC_INTERVAL_MS) {
      lastFullSync.set(user.sub, time);
      const found = [];
      try {
        for (const filter of [`metadata[virtually_user]=${encodeURIComponent(user.sub)}`,
          `external_customer_id=${encodeURIComponent(`google:${user.sub}`)}`]) {
          const first = `/orders/?${filter}&limit=100&page=1`;
          found.push(...await listAll(settings, first, page => `/orders/?${filter}&limit=100&page=${page}`, polarOptions));
        }
      } catch (error) {
        throw polarFailure(error);
      }
      applied = await applyAll(found, user);
    }
    return sendJson(res, 200, { balance: ledgers.balanceOf(ledger.read(), user.sub), applied, checkout: null });
  }

  async function portal(req, res, url, access) {
    const config = requireEnabled();
    const user = await enter(access);
    const polar = requirePolar(config);
    await jsonBody(req);
    const customerId = ledgers.customerIdOf(ledger.read(), user.sub);
    const returnUrl = `${requestOrigin(req)}/billing`;
    const payload = customerId
      ? { customer_id: customerId, return_url: returnUrl }
      : { external_customer_id: `google:${user.sub}`, return_url: returnUrl };
    let session;
    try {
      session = await polarRequest(settingsFor(polar), 'POST', '/customer-sessions/', payload, polarOptions);
    } catch (error) {
      if (error instanceof PolarError && (error.polarStatus === 404 || error.polarStatus === 422)) {
        throw apiError(404, 'no_customer', 'There is no Polar customer for this account yet.');
      }
      throw polarFailure(error);
    }
    if (typeof session.customer_portal_url !== 'string' || !/^https?:\/\//i.test(session.customer_portal_url)) {
      throw apiError(502, 'polar_error', 'Polar returned no portal URL.', { polarStatus: null });
    }
    return sendJson(res, 200, { url: session.customer_portal_url });
  }

  // --- admin top-up routes ---------------------------------------------------------

  // GET /api/billing/admin/users?q=
  async function adminUsersRoute(req, res, url, access) {
    const { config } = await enterAdmin(access);
    const raw = url.searchParams.get('q');
    if (raw !== null && raw.length > MAX_QUERY_LENGTH) throw badField('q');
    const query = raw ? raw.trim().toLowerCase() : '';
    const users = ledgers.adminUsers(ledger.read(), { query }).map(row => ({ ...row, loginAllowed: loginAllowed(row.email) }));
    return sendJson(res, 200, { creditsPerUsd: config.creditsPerUsd, users });
  }

  // GET /api/billing/admin/history?email=
  async function adminHistoryRoute(req, res, url, access) {
    await enterAdmin(access);
    const email = fullEmail(url.searchParams.get('email'));
    if (!email) throw badField('email');
    return sendJson(res, 200, ledgers.adminHistory(ledger.read(), email));
  }

  // POST /api/billing/admin/adjust { email, credits, memo?, requestId }
  async function adminAdjustRoute(req, res, url, access) {
    const { admin } = await enterAdmin(access);
    const body = await jsonBody(req);
    const email = fullEmail(body.email);
    if (!email) throw badField('email');
    const { credits } = body;
    if (!Number.isInteger(credits) || credits === 0 || Math.abs(credits) > MAX_ADJUST_CREDITS) throw badField('credits');
    let memo = null;
    if (body.memo != null) {
      if (typeof body.memo !== 'string') throw badField('memo');
      memo = body.memo.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
      if (memo.length > MAX_MEMO_LENGTH) throw badField('memo');
    }
    if (typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)) throw badField('requestId');
    const kind = credits > 0 ? 'topup' : 'deduct';
    const label = `${credits > 0 ? '관리자 충전' : '관리자 차감'}${memo ? ` · ${memo}` : ''}`;
    const { nowIso } = context();
    const result = await ledger.mutate(draft => ledgers.adjustCredits(draft, {
      email, credits, label, by: admin.email, requestId: body.requestId, nowIso,
    }));
    if (!result.ok) {
      throw apiError(409, 'insufficient_balance', 'The deduction is larger than the balance.', { balance: result.balance });
    }
    if (!result.duplicate) log(`[billing] admin ${admin.email} ${kind} ${email} ${credits > 0 ? '+' : ''}${credits}`);
    const user = ledgers.adminEntryOwner(ledger.read(), result.entry);
    const payload = { user, entry: ledgers.entryView(result.entry), loginAllowed: loginAllowed(user.email) };
    if (result.duplicate) payload.duplicate = true;
    return sendJson(res, 200, payload);
  }

  const ROUTES = new Map([
    ['GET /api/billing', getBilling],
    ['POST /api/billing/checkout', createCheckout],
    ['POST /api/billing/sync', sync],
    ['POST /api/billing/portal', portal],
    ['GET /api/billing/admin/users', adminUsersRoute],
    ['GET /api/billing/admin/history', adminHistoryRoute],
    ['POST /api/billing/admin/adjust', adminAdjustRoute],
  ]);

  // Session routes (the gate already admitted the request). Returns true when handled.
  async function handleApi(req, res, url, access) {
    const { pathname } = url;
    if (pathname !== '/api/billing' && !pathname.startsWith('/api/billing/')) return false;
    const route = ROUTES.get(`${req.method} ${pathname}`);
    if (!route) return false;
    await route(req, res, url, access);
    return true;
  }

  // --- webhook -------------------------------------------------------------------

  // POST /api/billing/polar/webhook, before the auth routes and gate. Makes no
  // Polar call (answers fast); a failed ledger write answers 500 so Polar retries.
  async function handleWebhook(req, res, url) {
    if (req.method !== 'POST' || url.pathname !== WEBHOOK_PATH) return false;
    const file = watcher.current();
    if (file.mode === 'disabled') {
      sendJson(res, 404, { error: 'Billing is off.', code: 'billing_disabled' });
      return true;
    }
    if (file.polar === false) {
      sendJson(res, 404, { error: 'Polar is not set up.', code: 'polar_disabled' });
      return true;
    }
    if (!file.webhookSecret) {
      log(`[billing] webhook refused: ${DISPLAY_CONFIG_PATH} has no usable webhook secret (${file.problem})`);
      sendJson(res, 503, { error: 'The billing config has a problem.', code: 'billing_misconfigured', detail: { problem: file.problem } });
      return true;
    }
    const body = await readRawBody(req);
    if (!body.bytes) {
      if (body.close) res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: 'Payload too large.' });
      return true;
    }
    const check = verifyWebhook({ secret: file.webhookSecret, headers: req.headers, rawBody: body.bytes, nowMs: now() });
    if (!check.ok) {
      log(`[billing] webhook rejected ${check.reason}`);
      sendJson(res, 403, { error: 'Invalid signature.' });
      return true;
    }
    let event;
    try {
      event = JSON.parse(body.bytes.toString('utf8'));
    } catch {
      event = null;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      sendJson(res, 400, { error: 'Invalid JSON.' });
      return true;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    log(`[billing] webhook ${type.replace(/[^\w.-]/g, '').slice(0, 100) || '(none)'} ${check.id}`);
    const facts = ORDER_EVENTS.has(type) ? orderFacts(event.data) : null;
    let outcome;
    try {
      outcome = await ledger.mutate(draft => {
        if (ledgers.hasWebhook(draft, check.id, now())) return 'duplicate';
        if (!facts) return 'ignored';
        ledgers.applyOrder(draft, facts, context());
        // Recorded in the same write as its effect: only after it was handled.
        ledgers.recordWebhook(draft, check.id, now());
        return 'applied';
      });
    } catch (error) {
      log(`[billing] webhook ${check.id} failed: ${error.message}`);
      sendJson(res, 500, { error: 'Internal server error.' });
      return true;
    }
    if (outcome === 'duplicate') sendJson(res, 200, { ok: true, duplicate: true });
    else if (outcome === 'ignored') sendJson(res, 200, { ok: true, ignored: true });
    else sendJson(res, 200, { ok: true });
    return true;
  }

  // --- paid jobs -----------------------------------------------------------------

  function lockedError(state) {
    return apiError(503, 'billing_misconfigured', 'The billing config has a problem, so paid generation is locked.', { problem: state.problem });
  }

  // The claim, the balance check and the debit, in one ledger step (no double
  // spend). -> the new charge id; throws 402 insufficient_credits.
  async function debit(user, { credits, label, jobId }) {
    const { nowIso } = context();
    const { moved, result } = await ledger.mutate(draft => ({
      moved: claimFor(draft, user),
      result: ledgers.chargeCredits(draft, { sub: user.sub, email: user.email, credits, label, jobId, nowIso }),
    }));
    logClaimed(moved, user);
    if (!result.ok) throw apiError(402, 'insufficient_credits', 'Not enough credits.', { needed: credits, balance: result.balance });
    return result.chargeId;
  }

  // Called by the animate API after every other check, before the job exists.
  // -> null when billing is off (the job carries no billing record), else
  // { sub, email, credits, free, chargeId, refunded: false }. Throws the
  // 503 / 400 / 402 refusals.
  async function chargeJob({ access, jobId, estimateUsd, label }) {
    const state = current();
    if (state.mode === 'disabled') return null;
    if (state.mode === 'invalid') throw lockedError(state);
    const { config } = state;
    const user = sessionUser(access);
    const credits = creditsFor(estimateUsd, config.creditsPerUsd);
    const record = { sub: user.sub, email: user.email, credits, free: isFree(config, user.email), chargeId: null, refunded: false };
    if (record.free) return record;
    if (credits === null) throw apiError(400, 'price_unknown', 'This model has no price, so it cannot be paid with credits.');
    const chargeId = await debit(user, { credits, label, jobId });
    if (chargeId) log(`[billing] charge job ${jobId} -${credits} ${user.email}`);
    return { ...record, chargeId };
  }

  // '다시 받기' of a job whose charge was given back: a delivered result is paid
  // once, so its credits are taken again (the job's original amount) from the
  // account asking, before the re-fetch starts. -> null when nothing is taken
  // (billing off, a free account, nothing to take), else { sub, email, credits,
  // chargeId }. Throws the 503 / 402 refusals (the job stays as it was).
  async function rechargeJob({ access, jobId, credits, label }) {
    const state = current();
    if (state.mode === 'disabled') return null;
    if (state.mode === 'invalid') throw lockedError(state);
    const user = sessionUser(access);
    if (isFree(state.config, user.email) || !Number.isSafeInteger(credits) || credits <= 0) return null;
    const chargeId = await debit(user, { credits, label, jobId });
    log(`[billing] charge job ${jobId} -${credits} ${user.email} (refetch)`);
    return { sub: user.sub, email: user.email, credits, chargeId };
  }

  // Gives a job's charge back once, in every mode (the animate API decides
  // when: failed, canceled by the provider, or canceled before a provider task
  // existed). Each charge of a job (a re-fetch can add one) on its own.
  // -> true when the charge is refunded (now or earlier), false when the
  // ledger has no such charge.
  async function refundJob({ jobId, chargeId }) {
    if (typeof chargeId !== 'string' || !chargeId) return false;
    const { nowIso } = context();
    const result = await ledger.mutate(draft => ledgers.refundCharge(draft, { chargeId, nowIso }));
    if (result.refunded && result.now) log(`[billing] refund job ${jobId} +${result.credits} ${result.email}`);
    return result.refunded;
  }

  function summary() {
    const state = current();
    const polar = state.config ? state.config.polar : null;
    return { mode: state.mode, problem: state.problem, polar: !!polar, server: polar ? polar.server : null, text: describe(state) };
  }

  return {
    refresh,
    handleWebhook,
    handleApi,
    summary,
    // 'disabled' | 'enabled' | 'invalid' right now (cheap; job views read it).
    mode: () => current().mode,
    chargeJob,
    rechargeJob,
    refundJob,
    close: () => ledger.close(),
  };
}

module.exports = { WEBHOOK_PATH, createBilling, publicIp };
