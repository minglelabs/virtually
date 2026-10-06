'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { createAnimateShared } = require('./lib/animate/api');
const { createAuth } = require('./lib/auth');
const { openDocs, createFileDocs } = require('./lib/docs');
const { loadDotEnv } = require('./lib/env');
const { createMirror, storeFromEnv } = require('./lib/blobs');
const { createActivityLog, observe: observeActivity } = require('./lib/activity');
const { WEBHOOK_PATH, createBilling } = require('./lib/billing');
const { createSite } = require('./lib/site');
const { createWorkspace } = require('./lib/workspace');
const { extForMime, readBody, sendJson } = require('./lib/server-util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const EXAMPLES_MANIFEST = path.join(__dirname, 'examples', 'driving.json');
// Bundled example driving videos (the manifest's `file` entries): our own, committed assets.
const BUNDLED_DRIVINGS_DIR = path.join(__dirname, 'assets', 'drivings');
const STATIC_FILES = new Map([
  ['/', ['characters.html', 'text/html; charset=utf-8']],
  ['/broadcast', ['index.html', 'text/html; charset=utf-8']],
  ['/overlay', ['overlay.html', 'text/html; charset=utf-8']],
  ['/animate', ['animate.html', 'text/html; charset=utf-8']],
  ['/characters.css', ['characters.css', 'text/css; charset=utf-8']],
  ['/characters.js', ['characters.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/animate.css', ['animate.css', 'text/css; charset=utf-8']],
  ['/animate.js', ['animate.js', 'text/javascript; charset=utf-8']],
  ['/motions.js', ['motions.js', 'text/javascript; charset=utf-8']],
  ['/director.js', ['director.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['scene.js', 'text/javascript; charset=utf-8']],
  ['/videos', ['videos.html', 'text/html; charset=utf-8']],
  ['/videos.css', ['videos.css', 'text/css; charset=utf-8']],
  ['/videos.js', ['videos.js', 'text/javascript; charset=utf-8']],
  ['/overlay.css', ['overlay.css', 'text/css; charset=utf-8']],
  ['/overlay.js', ['overlay.js', 'text/javascript; charset=utf-8']],
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/login.css', ['login.css', 'text/css; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/auth.css', ['auth.css', 'text/css; charset=utf-8']],
  ['/auth.js', ['auth.js', 'text/javascript; charset=utf-8']],
  ['/billing', ['billing.html', 'text/html; charset=utf-8']],
  ['/billing.css', ['billing.css', 'text/css; charset=utf-8']],
  ['/billing.js', ['billing.js', 'text/javascript; charset=utf-8']],
  ['/credits.js', ['credits.js', 'text/javascript; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin/activity', ['admin-activity.html', 'text/html; charset=utf-8']],
  ['/admin-activity.css', ['admin-activity.css', 'text/css; charset=utf-8']],
  ['/admin-activity.js', ['admin-activity.js', 'text/javascript; charset=utf-8']],
]);

// With login on, anyone may load the non-HTML static files (the repo is public anyway).
function isPublicStatic(pathname) {
  const entry = STATIC_FILES.get(pathname);
  return !!entry && !entry[1].startsWith('text/html');
}

// The folder of an account's workspace under <dataDir>/users/: its Google sub as
// it is when that is plain, else a hash (a sub is never used as a path unchecked).
function workspaceDirName(sub) {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(sub)) return sub;
  return `x~${crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 32)}`;
}

// A production deploy that lost DATABASE_URL must not come up on empty local files and look healthy.
function requireDatabaseInProduction(env = process.env) {
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
    throw new Error('NODE_ENV=production needs DATABASE_URL (the records live in Postgres); refusing to start on local files.');
  }
}

// Where records and media go, one line each, so a log shows at once whether the database
// and the bucket are in use. Host and bucket names only, never a credential.
function storageSummary({ docs, blobs, env = process.env }) {
  let database = '[db] JSON files under data/ (DATABASE_URL is not set)';
  if (docs.kind === 'postgres') {
    let host = 'unknown host';
    try {
      host = new URL(env.DATABASE_URL).hostname;
    } catch {
      // keep the placeholder
    }
    database = `[db] Postgres at ${host}, schema virtually`;
  }
  const media = blobs && blobs.kind === 's3'
    ? `[storage] media mirrored to R2 bucket ${env.R2_BUCKET}`
    : '[storage] media on the local disk only (R2_* is not set)';
  return [database, media];
}

async function createAppServer({
  dataDir = path.join(__dirname, 'data'),
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  animateMock = process.env.VIRTUALLY_ANIMATE_MOCK === '1',
  animatePollIntervalMs = null,
  // Test-only: { config, customRoutes, env } replacing the ANIMATE_* / provider-key
  // environment variables (lib/animate/config.js).
  animate: animateOptions = {},
  // Where JSON records live (lib/docs.js): files under dataDir by default. Running
  // `node server.js` passes Postgres when DATABASE_URL is set.
  docs = createFileDocs(),
  // Where media files are kept durably (lib/blobs.js): nowhere but the disk by default.
  // Running `node server.js` passes R2 when R2_* is set; the disk is then a working copy
  // that is restored on start. The environment is read there, not here, so a test run
  // with these variables in the shell cannot touch the real database or bucket.
  blobs: blobStore = null,
  examplesManifestPath = EXAMPLES_MANIFEST,
  bundledDrivingsDir = BUNDLED_DRIVINGS_DIR,
  // Test-only: lets example downloads use plain http fixture servers.
  allowHttpExamples = false,
  // Google login (off unless <dataDir>/auth/config.json exists). Tests inject
  // { endpoints: { authorize, token, jwks }, now: () => ms, configCheckIntervalMs, log }.
  auth: authOptions = {},
  // Credit billing (off unless <dataDir>/billing/config.json exists). Tests inject
  // { apiBase, now: () => ms, configCheckIntervalMs, log }.
  billing: billingOptions = {},
  // Bytes each login account may store (login off: no limit). Env VIRTUALLY_ACCOUNT_QUOTA_MB; 0 = no limit.
  accountQuotaBytes = Number(process.env.VIRTUALLY_ACCOUNT_QUOTA_MB ?? 2048) * 1024 * 1024,
  // Download the example driving videos that are missing once the server listens
  // (`node server.js` does; tests fetch them through the API).
  fetchExamplesAtStart = false,
  // Test-only: { env, fetchImpl, tickMs } for the AI director (lib/director).
  director: directorOptions = {},
} = {}) {
  await fsp.mkdir(dataDir, { recursive: true });
  const mirror = blobStore ? createMirror({ root: dataDir, store: blobStore, log: message => console.warn(message) }) : null;
  // Before anything reads the disk: a new container starts from the bucket's files.
  if (mirror) await mirror.tryHydrate();

  // Before the workspaces, so a failing auth setup cannot leave their jobs running.
  const auth = await createAuth({ ...authOptions, dataDir, docs, sendJson, readBody, isPublicStatic });
  // Who did what (admin page): written to <dataDir>/activity/events.jsonl.
  const activity = await createActivityLog({ dataDir, docs, log: message => console.warn(message) });
  // Before the animate API too: jobs are charged and refunded through it.
  const billing = await createBilling({ ...billingOptions, dataDir, docs, auth, sendJson, readBody });
  // The server's provider keys and model routes, one set for every account.
  const animateShared = await createAnimateShared({ dataDir, mock: animateMock, ...animateOptions });
  // A redeploy runs two servers on one database for a moment: each job names the one running it.
  animateShared.instanceId = crypto.randomUUID();
  animateShared.restoreFile = mirror ? file => mirror.restore(file) : null;

  // --- workspaces: one per Google account, <dataDir>/users/<id>/ -------------------
  // With login off there is one workspace, <dataDir>/ itself (the single-user layout).
  // Opened lazily on an account's first request, and at startup for every account
  // that has one (their running jobs must go on and be refunded).
  const usersDir = path.join(dataDir, 'users');
  // The example driving videos are downloaded once, here, for every account (and kept
  // in the bucket with the rest of the media).
  const sharedExamplesDir = path.join(dataDir, 'animate', 'drivings', 'examples');
  const workspaces = new Map(); // id ('' = the login-off workspace) -> Promise<workspace>

  function openWorkspace(id) {
    if (!workspaces.has(id)) {
      const dir = id === '' ? dataDir : path.join(usersDir, id);
      const opening = (async () => {
        await fsp.mkdir(dir, { recursive: true });
        return createWorkspace({
          dataDir: dir, docs, owner: id === '' ? null : await readOwner(dir), ffmpegPath, ffprobePath, animateMock, animatePollIntervalMs,
          animateShared, examplesManifestPath, allowHttpExamples, bundledDrivingsDir, billing, activity,
          sharedExamplesDir: id === '' ? null : sharedExamplesDir,
          director: directorOptions,
          quotaBytes: id !== '' && accountQuotaBytes > 0 ? accountQuotaBytes : null,
        });
      })();
      workspaces.set(id, opening);
      opening.catch(() => workspaces.delete(id));
    }
    return workspaces.get(id);
  }

  async function readOwner(dir) {
    try {
      const stored = await docs.read(path.join(dir, 'owner.json'));
      return stored && typeof stored.sub === 'string' ? stored : null;
    } catch {
      return null;
    }
  }

  // Who the workspace belongs to (the admin page names them): owner.json, written
  // the first time a session reaches it in this run and whenever the name or address changes.
  const ownersWritten = new Map(); // id -> "email\nname"
  async function noteOwner(id, workspace, owner) {
    const stamp = `${owner.email}\n${owner.name}`;
    if (ownersWritten.get(id) === stamp) return;
    ownersWritten.set(id, stamp);
    workspace.setOwner(owner);
    try {
      await docs.write(path.join(workspace.dataDir, 'owner.json'), owner, { private: true });
    } catch (error) {
      ownersWritten.delete(id);
      console.warn(`[workspace] could not write owner.json: ${error.message}`);
    }
  }

  // The workspace a gated request acts on (access.userId: the session's account, or
  // the account of an OBS overlay key; null with login off).
  async function workspaceFor(access) {
    if (!access || !access.userId) return openWorkspace('');
    const id = workspaceDirName(access.userId);
    const workspace = await openWorkspace(id);
    const session = access.session;
    if (session && session.sub === access.userId) {
      await noteOwner(id, workspace, { sub: session.sub, email: String(session.email).trim().toLowerCase(), name: typeof session.name === 'string' ? session.name : null });
    }
    return workspace;
  }

  const defaultWorkspace = await openWorkspace('');
  for (const name of await docs.children(usersDir)) {
    if (!name.endsWith('.tmp') && /^[A-Za-z0-9_~-]+$/.test(name)) await openWorkspace(name);
  }
  const openedAtStart = await Promise.all([...workspaces.values()]);

  const everyWorkspace = async () => Promise.all([...workspaces.values()]);

  // ---- Admin routes (/api/admin/*): admins only (adminEmails of data/billing/config.json) ----
  async function adminLibrary() {
    const parts = await everyWorkspace();
    const snapshots = parts.map(workspace => workspace.adminSnapshot());
    return {
      activePhotoId: snapshots[0] ? snapshots[0].activePhotoId : null,
      characters: snapshots.flatMap(snapshot => snapshot.characters),
      looseMotions: snapshots.flatMap(snapshot => snapshot.looseMotions),
    };
  }

  async function adminAnimate() {
    const snapshots = await Promise.all((await everyWorkspace()).map(workspace => workspace.adminAnimateSnapshot()));
    return {
      drivings: snapshots.flatMap(snapshot => snapshot.drivings),
      jobs: snapshots.flatMap(snapshot => snapshot.jobs),
    };
  }

  async function handleAdmin(req, res, url, access) {
    const { pathname } = url;
    if (!pathname.startsWith('/api/admin/')) return false;
    if (!billing.isAdminAccess(access)) {
      sendJson(res, 403, { error: '관리자만 볼 수 있습니다.', code: 'admin_only' });
      return true;
    }
    if (req.method !== 'GET') return false;
    if (pathname === '/api/admin/overview') {
      sendJson(res, 200, { users: activity.users(), events: activity.events.length });
      return true;
    }
    if (pathname === '/api/admin/library') {
      sendJson(res, 200, { ...(await adminLibrary()), ...(await adminAnimate()) });
      return true;
    }
    if (pathname === '/api/admin/activity') {
      const q = url.searchParams;
      sendJson(res, 200, { events: activity.list({ type: q.get('type') || '', email: q.get('email') || '', before: q.get('before') || '', limit: q.get('limit') || 100 }) });
      return true;
    }
    return false;
  }

  const site = createSite();

  const server = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      // Railway's health check (in the service's settings): the server only listens once the media is back
      // from the bucket, so a new deploy takes over only when it can serve. No session, no Host check.
      if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 2, 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : 'ok');
      }
      // Picks up config.json edits (checked at most once per configCheckIntervalMs).
      await auth.refresh();
      await billing.refresh();
      const listeningAddress = server.address();
      if (listeningAddress && ['127.0.0.1', '::1'].includes(listeningAddress.address)) {
        const allowedHosts = new Set([`127.0.0.1:${listeningAddress.port}`, `localhost:${listeningAddress.port}`, `[::1]:${listeningAddress.port}`]);
        // A reverse proxy / tunnel forwarding publicUrl's Host to this loopback server.
        const publicHost = auth.publicHost();
        if (publicHost) allowedHosts.add(publicHost);
        if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
          return sendJson(res, 403, { error: 'Invalid host.' });
        }
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && !auth.isPublicOrigin(req)) {
        return sendJson(res, 403, { error: 'Cross-origin changes are not allowed.' });
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
        return sendJson(res, 403, { error: 'Cross-site changes are not allowed.' });
      }
      // The public pages need no session either (and no config reads).
      if (site.handle(req, res, pathname)) return;
      // The Polar webhook comes without a session: before the login routes and the gate
      // (it verifies its own signature).
      if (await billing.handleWebhook(req, res, url)) return;
      // Login routes, then the access gate (sends the refusal itself), then the app.
      if (await auth.handleRoute(req, res, url)) return;
      const access = auth.gate(req, res, url);
      if (!access) return;
      if (await auth.handleApi(req, res, url, access)) return;
      if (await billing.handleApi(req, res, url, access)) return;
      observeActivity(activity, req, res, url, access);
      if (await handleAdmin(req, res, url, access)) return;
      // Everything else under /api/ acts on the requester's own workspace.
      if (pathname.startsWith('/api/')) {
        const workspace = await workspaceFor(access);
        if (await workspace.handle(req, res, url, access)) return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC_FILES.has(pathname)) {
        const [filename, mime] = STATIC_FILES.get(pathname);
        const content = await fsp.readFile(path.join(PUBLIC_DIR, filename));
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      sendJson(res, 404, { error: 'Not found.' });
    })().catch(error => {
      if (res.headersSent) return res.destroy(error);
      if (!error.status) {
        sendJson(res, 500, { error: 'Internal server error.' });
        return console.error(error);
      }
      const body = { error: error.message };
      if (typeof error.code === 'string') body.code = error.code;
      if (error.detail && typeof error.detail === 'object') body.detail = error.detail;
      sendJson(res, error.status, body);
    });
  });
  // Records stored before fit measurement, and photos stored before cutouts, are
  // fixed once the server listens, without delaying it. server.fitBackfill and
  // server.cutoutBackfill resolve when every workspace opened at startup is done.
  const started = new Promise(resolve => server.once('listening', () => resolve(openedAtStart.map(workspace => workspace.backfill()))));
  server.fitBackfill = started.then(runs => Promise.all(runs.map(run => run.fits))).then(() => {});
  server.cutoutBackfill = started.then(runs => Promise.all(runs.map(run => run.cutouts))).then(() => {});

  if (fetchExamplesAtStart) {
    started.then(() => defaultWorkspace.animate.drivings.fetchExamples()).then(results => {
      const failed = results.filter(result => !result.ok);
      if (results.length) console.log(`[examples] ${results.length - failed.length} example video(s) downloaded${failed.length ? `, ${failed.length} failed (${failed.map(result => `${result.id}: ${result.error}`).join('; ')})` : ''}`);
    }).catch(error => console.warn(`[examples] download failed: ${error.message}`));
  }

  // Stop running jobs and downloads with the server (tests must not leak), then
  // let the ledger finish its pending writes and refuse new ones.
  server.on('close', () => {
    everyWorkspace()
      .then(all => Promise.all(all.map(workspace => workspace.close())))
      .catch(() => {})
      .finally(() => billing.close().catch(() => {}))
      .finally(() => (mirror ? mirror.close() : null))
      .catch(error => console.warn(`[storage] final upload failed: ${error.message}`))
      .finally(() => docs.close().catch(() => {}));
  });
  if (mirror) mirror.start();
  server.mirror = mirror;
  server.animate = defaultWorkspace.animate;
  server.auth = auth;
  server.characters = defaultWorkspace.characters;
  server.billing = billing;
  server.activity = activity;
  // The workspace of an account (by Google sub; null: the login-off workspace), once opened.
  server.workspaceFor = async userId => (userId ? openWorkspace(workspaceDirName(userId)) : defaultWorkspace);
  server.workspaces = workspaces;
  // SIGTERM (a redeploy): hand the running jobs to the next server instead of dropping them.
  // Their files first reach the bucket, so the next server can restore what it takes over.
  server.handoff = async () => {
    const pipelines = (await everyWorkspace()).map(workspace => workspace.animate.pipeline);
    await Promise.all(pipelines.map(pipeline => pipeline.stopForHandoff()));
    if (mirror) await mirror.flush({ force: true }).catch(error => console.warn(`[storage] upload before the handoff failed: ${error.message}`));
    await Promise.all(pipelines.map(pipeline => pipeline.releaseLeases()));
  };
  return server;
}


function listenOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

function isLoopbackHost(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

async function listenWithPortRotation(server, { host = '127.0.0.1', startPort = 8787, maxAttempts = 100 } = {}) {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer.');
  }
  const lastPort = Math.min(65535, startPort + maxAttempts - 1);
  for (let port = startPort; port <= lastPort; port += 1) {
    try {
      return await listenOnce(server, host, port);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No available port from ${startPort} to ${lastPort}.`);
}

if (require.main === module) {
  (async () => {
    // Before anything reads process.env (createAppServer's defaults included).
    if (loadDotEnv()) console.log('Loaded variables from .env (variables already set in the environment win).');
    requireDatabaseInProduction();
    const dataDir = path.join(__dirname, 'data');
    const docs = await openDocs({ root: dataDir, log: message => console.warn(message) });
    const blobs = storeFromEnv();
    for (const line of storageSummary({ docs, blobs })) console.log(line);
    return createAppServer({ dataDir, docs, blobs, fetchExamplesAtStart: true });
  })().then(async server => {
    const host = process.env.HOST || '127.0.0.1';
    const startPort = Number(process.env.PORT ?? 8787);
    // A redeploy sends SIGTERM: upload what the last seconds produced before the disk goes.
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, async () => {
        try {
          await server.handoff();
        } catch (error) {
          console.warn(`[animate] job handoff failed: ${error.message}`);
        }
        try {
          if (server.mirror) await server.mirror.flush({ force: true });
        } catch (error) {
          console.warn(`[storage] final upload failed: ${error.message}`);
        }
        process.exit(0);
      });
    }
    const port = await listenWithPortRotation(server, { host, startPort });
    const displayHost = host.includes(':') ? `[${host}]` : host;
    if (port !== startPort) console.log(`Port ${startPort} is in use; using ${port}.`);
    console.log(`Virtually characters: http://${displayHost}:${port}/`);
    console.log(`Virtually controller: http://${displayHost}:${port}/broadcast`);
    const login = server.auth.summary();
    if (login.mode === 'disabled') {
      console.log(`OBS Browser Source: http://${displayHost}:${port}/overlay`);
      if (!isLoopbackHost(host)) {
        console.warn(`Warning: HOST=${host} is not a loopback address and Google login is off, so anyone who can reach this address controls Virtually. Add data/auth/config.json to require Google login.`);
      }
    } else {
      // "Google login: on (N allowed entries)" or the config problem line.
      console.log(login.text);
      console.log('OBS Browser Source: copy the keyed URL from the controller (/broadcast)');
    }
    const billing = server.billing.summary();
    if (billing.mode === 'enabled') {
      // "Billing (Polar): on (sandbox)", or "Billing: on (admin top-ups; Polar off)"
      console.log(billing.text);
      if (billing.polar && login.publicUrl) {
        console.log(`Polar webhook URL: ${login.publicUrl}${WEBHOOK_PATH}`);
      } else if (billing.polar) {
        console.log('Polar webhooks need a public URL (publicUrl in data/auth/config.json); without one the billing page\'s sync still grants credits.');
      }
    } else if (billing.mode === 'invalid') {
      // "Billing config problem: <code> (data/billing/config.json) - paid generation stays locked until it is fixed"
      console.log(billing.text);
    }
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { createAppServer, listenWithPortRotation, extForMime, requireDatabaseInProduction, storageSummary };