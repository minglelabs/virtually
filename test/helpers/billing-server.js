'use strict';

// Shared setup for the server billing tests (billing-config, billing-admin,
// billing-jobs): an app server with Google login through the fake Google and
// an optional billing config, one injected clock, sign-in as any account, and
// requests carrying that account's session cookie. The job helpers add the
// mock provider with priced custom routes (ffmpeg required).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { createAppServer } = require('../../server');
const { startFakeGoogle } = require('./fake-google');

const CLIENT_ID = 'billing-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-billing-test-secret';
const START = Date.parse('2026-09-30T00:00:00Z');
const MINUTE = 60 * 1000;

const ADMIN = Object.freeze({ sub: '200000000000000000001', email: 'owner@example.com', name: 'Owner Park' });
const ALICE = Object.freeze({ sub: '200000000000000000002', email: 'alice@example.com', name: 'Alice Kim' });
const BOB = Object.freeze({ sub: '200000000000000000003', email: 'bob@example.com', name: 'Bob Lee' });

// Google login allows every example.com address.
function authConfig(overrides = {}) {
  return { google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, allowedEmails: ['@example.com'], ...overrides };
}

function billingConfig(overrides = {}) {
  return { adminEmails: [ADMIN.email], ...overrides };
}

function makeClock(start = START) {
  const clock = { t: start, now: () => clock.t, advance: ms => { clock.t += ms; } };
  return clock;
}

let stampCounter = 0;
// Writes a file (JSON value or raw text) with a fresh mtime, so a hot-reload
// check sees the change however quickly a test writes twice.
async function writeFresh(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  stampCounter += 1;
  const stamp = new Date(Date.now() + stampCounter * 1000);
  await fs.utimes(file, stamp, stamp);
}

// The tests start every account at 0 credits; the welcome credits have their own tests.
const noWelcome = value => (value && typeof value === 'object' && !('welcomeCredits' in value) ? { welcomeCredits: 0, ...value } : value);
const billingConfigPath = dataDir => path.join(dataDir, 'billing', 'config.json');
const authConfigPath = dataDir => path.join(dataDir, 'auth', 'config.json');
const ledgerPath = dataDir => path.join(dataDir, 'billing', 'ledger.json');

// value null removes the file.
async function setBillingConfig(ctx, value) {
  if (value === null) await fs.rm(billingConfigPath(ctx.dataDir), { force: true });
  else await writeFresh(billingConfigPath(ctx.dataDir), noWelcome(value));
}

async function setAuthConfig(ctx, value) {
  if (value === null) await fs.rm(authConfigPath(ctx.dataDir), { force: true });
  else await writeFresh(authConfigPath(ctx.dataDir), value);
}

async function readLedger(ctx) {
  return JSON.parse(await fs.readFile(ledgerPath(ctx.dataDir), 'utf8'));
}

// --- the app -----------------------------------------------------------------------

async function launch(ctx) {
  ctx.server = await createAppServer({
    animate: ctx.animate ? { customRoutes: [PRICED_ROUTE, UNPRICED_ROUTE], config: { concurrency: ctx.animate.concurrency ?? 1 } } : undefined,
    ...ctx.serverOptions,
    dataDir: ctx.dataDir,
    examplesManifestPath: ctx.manifestPath,
    animateMock: ctx.mock,
    animatePollIntervalMs: ctx.mock ? 40 : null,
    auth: { endpoints: ctx.google.endpoints, now: ctx.clock.now, configCheckIntervalMs: 0, log: line => ctx.logs.push(line) },
    billing: { now: ctx.clock.now, configCheckIntervalMs: 0, log: line => ctx.logs.push(line), ...ctx.billingOptions },
  });
  await new Promise(resolve => ctx.server.listen(0, '127.0.0.1', resolve));
  ctx.port = ctx.server.address().port;
  return ctx;
}

async function stopApp(ctx) {
  const { server } = ctx;
  if (!server) return;
  ctx.server = null;
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  // Jobs stop and the ledger finishes its writes before anything reopens the data.
  await server.animate.close().catch(() => {});
  await server.billing.close().catch(() => {});
}

async function restartApp(ctx, serverOptions) {
  if (serverOptions) ctx.serverOptions = serverOptions;
  await stopApp(ctx);
  return launch(ctx);
}

// A running app + fake Google on a fresh data dir. auth / billing: the config
// files to write (null = none). animate: { concurrency } adds the priced mock
// routes and turns the mock provider on. billingOptions: extra createBilling options.
async function startApp(t, { auth = authConfig(), billing = billingConfig(), animate = null, billingOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-billing-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const manifestPath = path.join(root, 'no-examples.json');
  await fs.writeFile(manifestPath, JSON.stringify({ version: 1, examples: [] }));
  const ctx = { root, dataDir, manifestPath, clock: makeClock(), logs: [], mock: !!animate, animate, billingOptions, server: null };
  ctx.google = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: ctx.clock.now });
  t.after(async () => {
    await stopApp(ctx);
    await ctx.google.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  if (auth !== null) await writeFresh(authConfigPath(dataDir), auth);
  if (billing !== null) await writeFresh(billingConfigPath(dataDir), noWelcome(billing));
  return launch(ctx);
}

// --- requests ------------------------------------------------------------------------

function httpRequest(port, pathname, { method = 'GET', body, cookie, headers = {}, contentType } = {}) {
  const allHeaders = { ...headers };
  if (cookie) allHeaders.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
    allHeaders['Content-Type'] = contentType || (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json');
    allHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: allHeaders, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const request = (ctx, pathname, options) => httpRequest(ctx.port, pathname, options);
const get = (ctx, pathname, cookie) => request(ctx, pathname, { cookie });
const post = (ctx, pathname, body, cookie) => request(ctx, pathname, { method: 'POST', body: body === undefined ? {} : body, cookie });

function cookieValue(response, name) {
  for (const line of response.headers['set-cookie'] || []) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1);
  }
  return null;
}

// Signs in as `user` ({ sub, email, name }) through the fake Google. -> Cookie header value.
async function signIn(ctx, user) {
  ctx.google.setUser({ sub: user.sub, email: user.email, name: user.name, email_verified: true });
  const start = await request(ctx, '/auth/google/login?next=%2F');
  assert.equal(start.status, 302, 'login start redirects to Google');
  const oauth = cookieValue(start, 'virtually_oauth');
  const authorize = new URL(start.headers.location);
  const approved = await httpRequest(Number(authorize.port), authorize.pathname + authorize.search);
  assert.equal(approved.status, 302, 'fake Google approves');
  const back = new URL(approved.headers.location);
  const callback = await request(ctx, back.pathname + back.search, { cookie: `virtually_oauth=${oauth}` });
  const session = cookieValue(callback, 'virtually_session');
  assert.ok(session, `signed in as ${user.email} (got ${callback.headers.location})`);
  return `virtually_session=${session}`;
}

// --- billing shortcuts ---------------------------------------------------------------

let requestCounter = 0;
function newRequestId() {
  requestCounter += 1;
  return `req-${requestCounter}-${crypto.randomUUID()}`;
}

// POST /api/billing/admin/adjust with a fresh requestId unless one is given.
function adjust(ctx, cookie, email, credits, extra = {}) {
  return post(ctx, '/api/billing/admin/adjust', { email, credits, requestId: newRequestId(), ...extra }, cookie);
}

async function billingOf(ctx, cookie) {
  const response = await get(ctx, '/api/billing', cookie);
  assert.equal(response.status, 200, response.text);
  return response.json;
}

// --- jobs (mock provider, priced custom routes) -----------------------------------------

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const ffmpegSkip = spawnSync(FFMPEG, ['-version']).status === 0 ? false : 'ffmpeg not available';

// $0.10/s with a 3 s floor: the 2 s test clip costs $0.30 = 600 credits at the
// default 2000 credits per USD. delayMs 60000 keeps a job running (its provider
// task exists) until it is canceled.
const PRICED_ROUTE = Object.freeze({
  id: 'mock/priced',
  provider: 'mock',
  family: 'other',
  label: '유료 테스트 경로',
  endpoint: 'mock',
  fields: { image: 'image', video: 'video', prompt: 'prompt' },
  params: {},
  options: [{ key: 'delayMs', field: 'delayMs', label: '지연', values: [0, 60000], default: 0 }],
  limits: { videoMinSec: 1, videoMaxSec: 30, imageMaxPx: 1920, imageMinPx: 64, aspectMin: 0.2, aspectMax: 5 },
  pricing: { usdPerSecond: 0.1, minSeconds: 3 },
  verified: true,
});
const UNPRICED_ROUTE = Object.freeze({ ...PRICED_ROUTE, id: 'mock/unpriced', label: '가격 없는 테스트 경로', pricing: null });
const JOB_CREDITS = 600;
const LONG = { delayMs: 60000 };

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: 'ignore' });
}

// Creates a character (red body on a transparent canvas; its base photo is
// ctx.photoId, which createJob sends) and uploads a 2 s driving clip.
// -> the driving record.
async function prepareInputs(ctx, cookie) {
  const character = path.join(ctx.root, 'character.png');
  const clip = path.join(ctx.root, 'clip.mp4');
  if (!fsSync.existsSync(character)) {
    ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=200:g=40:b=40:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'",
      '-frames:v', '1', character]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
  }
  let response = await request(ctx, '/api/characters?name=c&filename=c.png', { method: 'POST', cookie, body: fsSync.readFileSync(character) });
  assert.equal(response.status, 201, response.text);
  ctx.photoId = response.json.character.basePhotoId;
  // Characters and driving videos belong to one account: createJob sends the photo of the account asking.
  (ctx.photoIds || (ctx.photoIds = new Map())).set(cookie, ctx.photoId);
  response = await request(ctx, '/api/animate/drivings?name=clip.mp4', { method: 'POST', cookie, body: fsSync.readFileSync(clip) });
  assert.equal(response.status, 201, response.text);
  return response.json;
}

// POST /api/animate/jobs (confirmed) on the priced route unless routeId is given.
function createJob(ctx, cookie, drivingId, { routeId = PRICED_ROUTE.id, options = {} } = {}) {
  return post(ctx, '/api/animate/jobs', { drivingId, photoId: (ctx.photoIds && ctx.photoIds.get(cookie)) || ctx.photoId, routeId, options, confirmed: true }, cookie);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Polls GET /api/animate/jobs/:id until predicate(view) holds.
async function waitForJob(ctx, cookie, id, predicate, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await get(ctx, `/api/animate/jobs/${id}`, cookie);
    assert.equal(response.status, 200, response.text);
    if (predicate(response.json)) return response.json;
    if (Date.now() > deadline) {
      const { state, billing, error } = response.json;
      throw new Error(`job ${id} did not get there: ${JSON.stringify({ state, billing, error })}`);
    }
    await sleep(40);
  }
}

async function waitFor(check, { timeoutMs = 10000, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await sleep(40);
  }
}

module.exports = {
  ADMIN,
  ALICE,
  BOB,
  JOB_CREDITS,
  LONG,
  MINUTE,
  PRICED_ROUTE,
  START,
  UNPRICED_ROUTE,
  adjust,
  authConfig,
  billingConfig,
  billingOf,
  createJob,
  ffmpegSkip,
  get,
  ledgerPath,
  newRequestId,
  post,
  prepareInputs,
  readLedger,
  request,
  restartApp,
  setAuthConfig,
  setBillingConfig,
  signIn,
  startApp,
  stopApp,
  waitFor,
  waitForJob,
};
