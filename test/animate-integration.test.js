'use strict';

// End-to-end tests for /api/animate/* with the mock route. Nothing here
// touches the network: example videos come from a local fixture HTTP server
// serving ffmpeg-generated clips, and the mock route renders its "result"
// with ffmpeg.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const { main: fetchExamplesMain } = require('../scripts/fetch-examples');
const mockProvider = require('../lib/animate/providers/mock');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function ffmpegAvailable() {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const skip = ffmpegAvailable() ? false : 'ffmpeg is not installed';

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: 'ignore' });
}

function makeClip(filePath, { seconds = 4, size = '320x240', rate = 15, format = null } = {}) {
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}`, '-t', String(seconds),
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', ...(format ? ['-f', format] : []), filePath]);
}

function makeCharacter(filePath) {
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x96', '-frames:v', '1', '-vf', 'format=rgba', filePath]);
}

async function makeFixtures() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-fixture-'));
  const clip = path.join(dir, 'clip.mp4');
  makeClip(clip, { seconds: 4 });
  const short = path.join(dir, 'short.mp4');
  makeClip(short, { seconds: 2, size: '160x120' });
  const long = path.join(dir, 'long.mp4');
  makeClip(long, { seconds: 31, size: '64x48', rate: 5 });
  const character = path.join(dir, 'character.png');
  makeCharacter(character);
  return { dir, clip, short, long, character };
}

// Serves the fixture clip directly, behind a redirect, slowly-404, and as a
// non-video. Counts requests per path.
async function startFixtureServer(clipPath) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1);
    if (req.url === '/clip.mp4') {
      const body = fsSync.readFileSync(clipPath);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
      return res.end(body);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/clip.mp4' });
      return res.end();
    }
    if (req.url === '/bad-redirect') {
      res.writeHead(302, { Location: 'ftp://127.0.0.1/clip.mp4' });
      return res.end();
    }
    if (req.url === '/slow-missing') {
      setTimeout(() => { res.writeHead(404); res.end('missing'); }, 400);
      return;
    }
    if (req.url === '/text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('not a video at all');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, hits };
}

async function writeManifest(dir, base) {
  const manifestPath = path.join(dir, 'driving.json');
  const entry = (id, label, presetKey, url) => ({
    id, label, presetKey, downloadUrl: url,
    sourcePage: 'https://example.com/source', author: 'Fixture Author', license: 'Test License',
    licenseUrl: 'https://example.com/license', trim: { start: 0.5, duration: 3 }, notes: 'fixture',
  });
  await fs.writeFile(manifestPath, JSON.stringify({
    version: 1,
    examples: [
      entry('hi-wave', '인사 (손 흔들기)', 'hi', `${base}/redirect`),
      entry('free-dance', '짧은 춤', null, `${base}/clip.mp4`),
      entry('gone', '없는 영상', null, `${base}/slow-missing`),
      entry('not-video', '영상 아님', null, `${base}/text`),
      entry('bad-redirect', '잘못된 이동', null, `${base}/bad-redirect`),
    ],
  }, null, 2));
  return manifestPath;
}

async function cleanup(...dirs) {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function start(dataDir, manifestPath, extra = {}) {
  const server = await createAppServer({
    dataDir, examplesManifestPath: manifestPath, allowHttpExamples: true,
    animateMock: true, animatePollIntervalMs: 40, ...extra,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function json(base, method, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function upload(base, pathname, filePath, contentType = 'application/octet-stream') {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': contentType }, body: fsSync.readFileSync(filePath) });
}

async function waitForJob(base, id, states, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (states.includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}: ${JSON.stringify(job.error)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Collect SSE messages from /api/events.
function listen(base) {
  const messages = [];
  const request = http.get(`${base}/api/events`, response => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = block.split('\n').find(value => value.startsWith('data: '));
        if (line) messages.push(JSON.parse(line.slice(6)));
      }
    });
  });
  request.on('error', () => {});
  return { messages, close: () => request.destroy() };
}

test('full flow: fetch examples -> character -> mock job -> result -> add as motion', { skip }, async () => {
  const fixtures = await makeFixtures();
  const fixtureServer = await startFixtureServer(fixtures.clip);
  const manifestPath = await writeManifest(fixtures.dir, fixtureServer.base);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-'));
  const app = await start(dataDir, manifestPath);
  const events = listen(app.base);
  try {
    const status = await (await fetch(`${app.base}/api/animate/status`)).json();
    assert.equal(status.ffmpeg.available, true);
    assert.equal(status.character, null);
    const mockRoute = status.routes.find(route => route.id === 'mock/local-demo');
    assert.ok(mockRoute, 'mock route is listed');
    assert.equal(mockRoute.available, true);
    for (const key of ['id', 'provider', 'providerLabel', 'family', 'familyLabel', 'label', 'options', 'limits', 'pricing',
      'keepsImageBackground', 'verified', 'docs', 'needsRelay', 'available', 'unavailableCode']) {
      assert.ok(key in mockRoute, `RouteView has ${key}`);
    }
    assert.ok(status.routes.length >= 17, 'catalog routes are restored');
    assert.ok(status.providers.some(provider => provider.id === 'wavespeed'));
    assert.ok(!('keying' in status.config));

    let drivings = (await (await fetch(`${app.base}/api/animate/drivings`)).json()).drivings;
    assert.deepEqual(drivings.map(item => item.id), ['hi-wave', 'free-dance', 'gone', 'not-video', 'bad-redirect']);
    assert.ok(drivings.every(item => item.kind === 'example' && item.available === false && item.url === null && item.posterUrl === null));
    assert.deepEqual(drivings[0].credit, { author: 'Fixture Author', license: 'Test License', licenseUrl: 'https://example.com/license', sourcePage: 'https://example.com/source' });

    // No character yet.
    let response = await json(app.base, 'POST', '/api/animate/jobs', { drivingId: 'hi-wave', routeId: 'mock/local-demo' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'character_missing');

    response = await upload(app.base, '/api/animate/character?name=my%20char.png', fixtures.character, 'image/png');
    assert.equal(response.status, 201);
    const character = await response.json();
    assert.match(character.id, /^ch-[0-9a-f-]{36}$/);
    assert.deepEqual(character, { source: 'upload', id: character.id, filename: 'my char.png', width: 64, height: 96, hasAlpha: true, url: `/api/animate/characters/${character.id}/image` });
    response = await fetch(`${app.base}/api/animate/character/image`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.arrayBuffer();

    // Examples are not downloaded yet.
    response = await json(app.base, 'POST', '/api/animate/jobs', { drivingId: 'hi-wave', routeId: 'mock/local-demo' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'driving_unavailable');

    // Fetch examples; a second fetch while the first runs is refused.
    const first = json(app.base, 'POST', '/api/animate/examples/fetch', {});
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = await json(app.base, 'POST', '/api/animate/examples/fetch', {});
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, 'fetch_in_progress');
    response = await first;
    assert.equal(response.status, 200);
    const fetched = await response.json();
    const byId = Object.fromEntries(fetched.results.map(result => [result.id, result]));
    assert.equal(byId['hi-wave'].ok, true);
    assert.equal(byId['free-dance'].ok, true);
    assert.equal(byId.gone.ok, false);
    assert.match(byId.gone.error, /404/);
    assert.equal(byId['not-video'].ok, false);
    assert.equal(byId['bad-redirect'].ok, false);
    assert.equal(fixtureServer.hits.get('/redirect'), 1);

    drivings = fetched.drivings;
    const hi = drivings.find(item => item.id === 'hi-wave');
    assert.equal(hi.available, true);
    assert.equal(hi.presetKey, 'hi');
    assert.equal(hi.url, '/api/animate/drivings/hi-wave/video');
    assert.equal(hi.posterUrl, '/api/animate/drivings/hi-wave/poster');
    assert.ok(Math.abs(hi.duration - 3) < 0.2, `trimmed to 3 s, got ${hi.duration}`);
    assert.equal(hi.width, 320);
    assert.equal(hi.height, 240);
    assert.equal(drivings.find(item => item.id === 'gone').available, false);
    assert.ok(fsSync.existsSync(path.join(dataDir, 'animate', 'drivings', 'examples', 'hi-wave.mp4')));
    assert.ok(fsSync.existsSync(path.join(dataDir, 'animate', 'drivings', 'examples', 'hi-wave.jpg')));

    response = await fetch(`${app.base}/api/animate/drivings/hi-wave/video`, { headers: { Range: 'bytes=0-15' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 4, 8), 'ftyp');
    response = await fetch(`${app.base}/api/animate/drivings/hi-wave/poster`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    await response.arrayBuffer();

    // A second fetch only retries the missing ones.
    const retried = await (await json(app.base, 'POST', '/api/animate/examples/fetch', {})).json();
    assert.deepEqual(retried.results.map(result => result.id).sort(), ['bad-redirect', 'gone', 'not-video']);

    // Run the mock job.
    response = await json(app.base, 'POST', '/api/animate/jobs', { drivingId: 'hi-wave', routeId: 'mock/local-demo' });
    assert.equal(response.status, 202);
    const created = (await response.json()).job;
    assert.equal(created.drivingId, 'hi-wave');
    assert.equal(created.presetKey, 'hi');
    assert.equal(created.routeLabel, '로컬 테스트 (AI 아님)');
    assert.equal(created.result, null);
    const done = await waitForJob(app.base, created.id, ['succeeded', 'failed']);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.error, null);
    assert.equal(done.result.url, `/api/animate/jobs/${done.id}/result`);
    assert.equal(done.result.posterUrl, `/api/animate/jobs/${done.id}/poster`);
    assert.equal(done.result.mime, 'video/mp4');
    assert.equal(done.result.width, 64);
    assert.equal(done.result.height, 96);
    assert.ok(done.result.duration > 2.5 && done.result.duration < 3.5, `result duration ${done.result.duration}`);
    assert.deepEqual(Object.keys(done).sort(), ['characterId', 'characterLabel', 'createdAt', 'drivingId', 'drivingLabel', 'error', 'estimate', 'familyLabel', 'id', 'motionId',
      'motionName', 'presetKey', 'progress', 'providerLabel', 'providerStatus', 'result', 'routeId', 'routeLabel', 'state', 'updatedAt']);

    const list = (await (await fetch(`${app.base}/api/animate/jobs`)).json()).jobs;
    assert.equal(list[0].id, done.id);

    response = await fetch(`${app.base}${done.result.url}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-range'), /^bytes 0-99\/\d+$/);
    assert.equal((await response.arrayBuffer()).byteLength, 100);
    response = await fetch(`${app.base}${done.result.url}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    response = await fetch(`${app.base}${done.result.posterUrl}`);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    await response.arrayBuffer();

    // Add as motion: the name defaults to the preset label.
    response = await json(app.base, 'POST', `/api/animate/jobs/${done.id}/motion`, undefined);
    assert.equal(response.status, 415);
    response = await json(app.base, 'POST', `/api/animate/jobs/${done.id}/motion`, {});
    assert.equal(response.status, 201);
    const added = await response.json();
    assert.equal(added.motion.name, '인사 (Hi)');
    assert.equal(added.motion.kind, 'motion');
    assert.equal(added.motion.mime, 'video/mp4');
    assert.equal(added.motion.url, `/api/media/${added.motion.id}`);
    assert.deepEqual(added.motion.source, { jobId: done.id });
    assert.equal(added.job.motionId, added.motion.id);
    assert.equal(added.job.motionName, '인사 (Hi)');

    const library = await (await fetch(`${app.base}/api/library`)).json();
    assert.equal(library.motions.length, 1);
    assert.equal(library.motions[0].mime, 'video/mp4');
    assert.ok(fsSync.existsSync(path.join(dataDir, 'media', `${added.motion.id}.mp4`)));

    response = await fetch(`${app.base}/api/media/${added.motion.id}`, { headers: { Range: 'bytes=0-11' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 4, 8), 'ftyp');

    // The motion can be triggered like any other.
    response = await json(app.base, 'POST', '/api/trigger', { id: added.motion.id });
    assert.equal(response.status, 200);

    response = await json(app.base, 'POST', `/api/animate/jobs/${done.id}/motion`, { name: 'again' });
    assert.equal(response.status, 409);
    const already = await response.json();
    assert.equal(already.code, 'already_added');
    assert.deepEqual(already.detail, { motionId: added.motion.id });

    // After deleting the motion from the library it can be added again.
    response = await fetch(`${app.base}/api/media/${added.motion.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(fsSync.existsSync(path.join(dataDir, 'media', `${added.motion.id}.mp4`)), false);
    response = await json(app.base, 'POST', `/api/animate/jobs/${done.id}/motion`, { name: '  내\n인사  ' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).motion.name, '내 인사');

    // SSE carried job updates and the library change.
    await new Promise(resolve => setTimeout(resolve, 100));
    const jobEvents = events.messages.filter(message => message.type === 'animate-job' && message.job.id === done.id);
    const states = jobEvents.map(message => message.job.state);
    for (const state of ['queued', 'preparing', 'submitting', 'running', 'downloading', 'succeeded']) assert.ok(states.includes(state), `SSE saw ${state}`);
    assert.ok(jobEvents.some(message => message.job.motionId === added.motion.id));
    assert.ok(events.messages.some(message => message.type === 'library' && message.library.motions.some(item => item.mime === 'video/mp4')));
  } finally {
    events.close();
    await stop(app.server);
    await new Promise(resolve => fixtureServer.server.close(resolve));
    await cleanup(dataDir, fixtures.dir);
  }
});

test('job validation, uploads, config, cancel and the idle fallback', { skip }, async () => {
  const fixtures = await makeFixtures();
  const fixtureServer = await startFixtureServer(fixtures.clip);
  const manifestPath = await writeManifest(fixtures.dir, fixtureServer.base);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-'));
  const app = await start(dataDir, manifestPath);
  try {
    // Static pages the animate page needs are routed.
    for (const pathname of ['/animate', '/animate.js', '/animate.css', '/motions.js']) {
      const staticResponse = await fetch(`${app.base}${pathname}`, { method: 'HEAD' });
      assert.notEqual(staticResponse.status, 404, `${pathname} is routed`);
    }

    // The library idle image stands in for a missing character.
    let response = await upload(app.base, '/api/upload?kind=idle&name=Idle%20pose.png', fixtures.character, 'image/png');
    assert.equal(response.status, 201);
    let status = await (await fetch(`${app.base}/api/animate/status`)).json();
    assert.deepEqual(status.character, { source: 'idle', id: null, filename: 'Idle pose.png', width: 64, height: 96, hasAlpha: true, url: '/api/animate/character/image' });

    // Character uploads are checked by signature.
    response = await fetch(`${app.base}/api/animate/character?name=x.png`, { method: 'POST', body: Buffer.from('not an image at all') });
    assert.equal(response.status, 415);
    response = await upload(app.base, '/api/animate/character?name=c.png', fixtures.character);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).source, 'upload');
    response = await fetch(`${app.base}/api/animate/character`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).character.source, 'idle');

    // Driving uploads.
    response = await fetch(`${app.base}/api/animate/drivings?name=bad.mp4`, { method: 'POST', body: Buffer.from('garbage bytes that are no video') });
    assert.equal(response.status, 415);
    response = await upload(app.base, '/api/animate/drivings?name=%EB%82%B4%20%EC%B6%A4.mp4', fixtures.clip);
    assert.equal(response.status, 201);
    const mine = await response.json();
    assert.match(mine.id, /^up-[0-9a-f-]{36}$/);
    assert.equal(mine.kind, 'upload');
    assert.equal(mine.label, '내 춤');
    assert.equal(mine.presetKey, null);
    assert.equal(mine.credit, null);
    assert.ok(Math.abs(mine.duration - 4) < 0.2);
    response = await upload(app.base, '/api/animate/drivings?name=short.mp4', fixtures.short);
    const short = await response.json();
    response = await upload(app.base, '/api/animate/drivings?name=long.mov', fixtures.long);
    assert.equal(response.status, 201);
    const long = await response.json();
    response = await fetch(`${app.base}${long.url}`, { method: 'HEAD' });
    assert.equal(response.headers.get('content-type'), 'video/quicktime');
    const drivings = (await (await fetch(`${app.base}/api/animate/drivings`)).json()).drivings;
    assert.deepEqual(drivings.slice(-3).map(item => item.id), [long.id, short.id, mine.id], 'uploads newest first after the examples');
    assert.equal(drivings[0].id, 'hi-wave');

    // Job validation.
    const post = body => json(app.base, 'POST', '/api/animate/jobs', body);
    response = await fetch(`${app.base}/api/animate/jobs`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(response.status, 415);
    response = await post({ drivingId: mine.id, routeId: 'nope/nope' });
    assert.equal((await response.json()).code, 'unknown_route');
    const locked = status.routes.find(route => !route.available && route.unavailableCode === 'no_credentials');
    if (locked) {
      response = await post({ drivingId: mine.id, routeId: locked.id, confirmed: true });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'This model route is not available.', code: 'route_unavailable', detail: { unavailableCode: 'no_credentials' } });
    }
    response = await post({ drivingId: 'up-00000000-0000-0000-0000-000000000000', routeId: 'mock/local-demo' });
    assert.equal((await response.json()).code, 'driving_missing');
    response = await post({ drivingId: long.id, routeId: 'mock/local-demo' });
    const tooLong = await response.json();
    assert.equal(tooLong.code, 'driving_too_long');
    assert.equal(tooLong.detail.maxSec, 30);

    // Config: keys are stored 0600 and shown masked; baseUrl cannot be set.
    response = await json(app.base, 'PUT', '/api/animate/config', { providers: { wavespeed: { baseUrl: 'http://127.0.0.1:1' } } });
    assert.equal(response.status, 400);
    response = await json(app.base, 'PUT', '/api/animate/config', { providers: { wavespeed: { apiKey: 'test-key-not-real-1234' } } });
    assert.equal(response.status, 200);
    const configured = await response.json();
    assert.deepEqual(Object.keys(configured).sort(), ['config', 'providers', 'routes']);
    const wavespeed = configured.providers.find(provider => provider.id === 'wavespeed');
    assert.equal(wavespeed.configured, true);
    assert.equal(wavespeed.credentials[0].masked, '••••1234');
    assert.ok(!JSON.stringify(configured).includes('test-key-not-real'));
    const configPath = path.join(dataDir, 'animate', 'config.json');
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    const paidRoute = configured.routes.find(route => route.id === 'wavespeed/wan-2.2-animate');
    assert.equal(paidRoute.available, true);
    // A paid route needs explicit confirmation; nothing is sent without it.
    response = await post({ drivingId: mine.id, routeId: paidRoute.id });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'not_confirmed');
    // WaveSpeed Wan has no input minimum (3 s is billing only): the 2 s clip passes the length
    // check and stops at the confirmation. Kling documents 3-30 s and refuses it.
    response = await post({ drivingId: short.id, routeId: paidRoute.id });
    assert.equal((await response.json()).code, 'not_confirmed');
    const klingRoute = configured.routes.find(route => route.id === 'wavespeed/kling-v3-motion-control-std');
    assert.equal(klingRoute.available, true);
    response = await post({ drivingId: short.id, routeId: klingRoute.id, confirmed: true });
    const klingShort = await response.json();
    assert.equal(klingShort.code, 'driving_too_short');
    assert.equal(klingShort.detail.minSec, 3);
    response = await json(app.base, 'PUT', '/api/animate/config', { providers: { wavespeed: { apiKey: '' } } });
    assert.equal(response.status, 200);
    assert.equal((await (await fetch(`${app.base}/api/animate/jobs`)).json()).jobs.length, 0, 'no job was created for a paid route');

    // Cancel a slow mock job; it cannot be added as a motion.
    response = await post({ drivingId: mine.id, routeId: 'mock/local-demo', options: { delayMs: 20000 } });
    assert.equal(response.status, 202);
    const slow = (await response.json()).job;
    assert.equal(slow.drivingLabel, '내 춤');
    await waitForJob(app.base, slow.id, ['running']);
    response = await fetch(`${app.base}/api/animate/jobs/${slow.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'canceled');
    response = await json(app.base, 'POST', `/api/animate/jobs/${slow.id}/motion`, {});
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'not_ready');
    response = await fetch(`${app.base}/api/animate/jobs/${slow.id}/result`);
    assert.equal(response.status, 404);

    // A job made from an upload (no preset) is named after the driving label.
    response = await post({ drivingId: mine.id, routeId: 'mock/local-demo' });
    const plain = await waitForJob(app.base, (await response.json()).job.id, ['succeeded', 'failed']);
    assert.equal(plain.state, 'succeeded', JSON.stringify(plain.error));
    response = await json(app.base, 'POST', `/api/animate/jobs/${plain.id}/motion`, {});
    assert.equal((await response.json()).motion.name, '내 춤');

    // Deleting an upload removes its files.
    response = await fetch(`${app.base}/api/animate/drivings/${mine.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    response = await fetch(`${app.base}/api/animate/drivings/${mine.id}/video`);
    assert.equal(response.status, 404);
    response = await fetch(`${app.base}/api/animate/jobs/00000000-0000-0000-0000-000000000000`);
    assert.equal(response.status, 404);
  } finally {
    await stop(app.server);
    await new Promise(resolve => fixtureServer.server.close(resolve));
    await cleanup(dataDir, fixtures.dir);
  }
});

test('deleting an example hides it; restore brings it back unavailable', { skip }, async () => {
  const fixtures = await makeFixtures();
  const fixtureServer = await startFixtureServer(fixtures.clip);
  const manifestPath = await writeManifest(fixtures.dir, fixtureServer.base);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-'));
  const drivingsDir = path.join(dataDir, 'animate', 'drivings');
  const hiddenPath = path.join(drivingsDir, 'hidden-examples.json');
  const exampleFile = (id, ext) => path.join(drivingsDir, 'examples', `${id}.${ext}`);
  const list = async base => (await fetch(`${base}/api/animate/drivings`)).json();
  let app = await start(dataDir, manifestPath);
  try {
    await upload(app.base, '/api/animate/character?name=c.png', fixtures.character);
    await (await json(app.base, 'POST', '/api/animate/examples/fetch', {})).json();
    assert.ok(fsSync.existsSync(exampleFile('hi-wave', 'mp4')));
    assert.equal((await list(app.base)).hiddenExamples, 0);

    // A job made from the example before it is hidden.
    let response = await json(app.base, 'POST', '/api/animate/jobs', { drivingId: 'hi-wave', routeId: 'mock/local-demo' });
    const job = await waitForJob(app.base, (await response.json()).job.id, ['succeeded', 'failed']);
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    const mine = await (await upload(app.base, '/api/animate/drivings?name=mine.mp4', fixtures.clip)).json();

    // Hide it: gone from the list, files removed, persisted.
    response = await fetch(`${app.base}/api/animate/drivings/hi-wave`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    let data = await list(app.base);
    assert.equal(data.hiddenExamples, 1);
    assert.deepEqual(data.drivings.map(item => item.id), ['free-dance', 'gone', 'not-video', 'bad-redirect', mine.id]);
    for (const ext of ['mp4', 'jpg', 'json']) assert.equal(fsSync.existsSync(exampleFile('hi-wave', ext)), false, `hi-wave.${ext} removed`);
    assert.deepEqual(JSON.parse(await fs.readFile(hiddenPath, 'utf8')), { hidden: ['hi-wave'] });
    assert.deepEqual((await fs.readdir(drivingsDir)).filter(name => name.endsWith('.tmp')), [], 'no temp files left');
    response = await fetch(`${app.base}/api/animate/drivings/hi-wave/video`);
    assert.equal(response.status, 404);
    response = await json(app.base, 'POST', '/api/animate/jobs', { drivingId: 'hi-wave', routeId: 'mock/local-demo' });
    assert.equal((await response.json()).code, 'driving_missing');
    response = await fetch(`${app.base}/api/animate/drivings/hi-wave`, { method: 'DELETE' });
    assert.equal(response.status, 404, 'an already hidden example is not found');

    // The earlier job still serves its result.
    response = await fetch(`${app.base}${job.result.url}`);
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 4, 8), 'ftyp');
    response = await fetch(`${app.base}${job.result.posterUrl}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal((await (await fetch(`${app.base}/api/animate/jobs/${job.id}`)).json()).state, 'succeeded');

    // Uploads are unaffected.
    response = await fetch(`${app.base}${mine.url}`, { method: 'HEAD' });
    assert.equal(response.status, 200);

    // Bad and unknown ids.
    for (const id of ['no-such-example', 'BAD_ID', '..%2Fhidden-examples.json', 'up-00000000-0000-0000-0000-000000000000', 'a'.repeat(41)]) {
      response = await fetch(`${app.base}/api/animate/drivings/${id}`, { method: 'DELETE' });
      assert.equal(response.status, 404, id);
      assert.equal((await response.json()).code, 'driving_missing');
    }

    // Fetch skips hidden examples. Hiding the failing ones leaves nothing missing.
    const hitsBefore = fixtureServer.hits.get('/redirect') || 0;
    for (const id of ['gone', 'not-video', 'bad-redirect']) {
      assert.equal((await fetch(`${app.base}/api/animate/drivings/${id}`, { method: 'DELETE' })).status, 200);
    }
    const fetched = await (await json(app.base, 'POST', '/api/animate/examples/fetch', {})).json();
    assert.deepEqual(fetched.results, []);
    assert.equal(fetched.hiddenExamples, 4);
    assert.equal(fixtureServer.hits.get('/redirect') || 0, hitsBefore, 'hidden example was not downloaded');
    assert.equal(fsSync.existsSync(exampleFile('hi-wave', 'mp4')), false);
    assert.ok(fetched.drivings.filter(item => item.kind === 'example').every(item => item.available), 'no missing examples left to announce');
  } finally {
    await stop(app.server);
  }

  try {
    // The hidden list survives a restart, and the CLI skips it too.
    const lines = [];
    const { results } = await fetchExamplesMain(['--data-dir', dataDir, '--manifest', manifestPath], { allowHttpExamples: true, log: line => lines.push(line) });
    assert.deepEqual(results, []);
    assert.ok(lines.some(line => /4 hidden/.test(line)), lines.join('\n'));
    assert.equal(fsSync.existsSync(exampleFile('hi-wave', 'mp4')), false);

    app = await start(dataDir, manifestPath);
    let data = await list(app.base);
    assert.equal(data.hiddenExamples, 4);
    assert.ok(!data.drivings.some(item => item.id === 'hi-wave'));

    // Restore: examples come back unavailable until fetched again.
    let response = await fetch(`${app.base}/api/animate/examples/restore`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(response.status, 415);
    response = await json(app.base, 'POST', '/api/animate/examples/restore', {});
    assert.equal(response.status, 200);
    const restored = await response.json();
    assert.deepEqual(Object.keys(restored).sort(), ['drivings', 'hidden']);
    assert.deepEqual(restored.hidden, []);
    const hi = restored.drivings.find(item => item.id === 'hi-wave');
    assert.equal(hi.available, false);
    assert.equal(hi.url, null);
    assert.equal(restored.drivings.find(item => item.id === 'free-dance').available, true);
    assert.deepEqual(JSON.parse(await fs.readFile(hiddenPath, 'utf8')), { hidden: [] });
    data = await list(app.base);
    assert.equal(data.hiddenExamples, 0);
    assert.deepEqual(data.drivings.filter(item => item.kind === 'example').map(item => item.id), ['hi-wave', 'free-dance', 'gone', 'not-video', 'bad-redirect']);

    const refetched = await (await json(app.base, 'POST', '/api/animate/examples/fetch', {})).json();
    assert.ok(refetched.results.some(result => result.id === 'hi-wave' && result.ok));
    assert.equal(refetched.drivings.find(item => item.id === 'hi-wave').available, true);
  } finally {
    await stop(app.server);
    await new Promise(resolve => fixtureServer.server.close(resolve));
    await cleanup(dataDir, fixtures.dir);
  }
});

test('jobs survive a restart: polling resumes, a mid-submit job becomes interrupted', { skip }, async () => {
  const fixtures = await makeFixtures();
  const fixtureServer = await startFixtureServer(fixtures.clip);
  const manifestPath = await writeManifest(fixtures.dir, fixtureServer.base);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-'));
  let app = await start(dataDir, manifestPath);
  let job;
  try {
    await upload(app.base, '/api/animate/character?name=c.png', fixtures.character);
    const driving = await (await upload(app.base, '/api/animate/drivings?name=clip.mp4', fixtures.clip)).json();
    const response = await json(app.base, 'POST', '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', options: { delayMs: 1500 } });
    job = (await response.json()).job;
    await waitForJob(app.base, job.id, ['running']);
  } finally {
    await stop(app.server);
    await new Promise(resolve => fixtureServer.server.close(resolve));
  }
  const submitsBefore = mockProvider._submitCount();

  // A job that died between upload and submit must not be submitted again.
  const orphanId = '11111111-2222-4333-8444-555555555555';
  const orphanDir = path.join(dataDir, 'animate', 'jobs', orphanId);
  await fs.mkdir(orphanDir, { recursive: true });
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'animate', 'jobs', job.id, 'job.json'), 'utf8'));
  await fs.writeFile(path.join(orphanDir, 'job.json'), JSON.stringify({ ...stored, id: orphanId, state: 'submitting', task: null, createdAt: '2020-01-01T00:00:00.000Z' }));

  app = await start(dataDir, manifestPath);
  try {
    const resumed = await waitForJob(app.base, job.id, ['succeeded', 'failed']);
    assert.equal(resumed.state, 'succeeded', JSON.stringify(resumed.error));
    assert.equal(mockProvider._submitCount(), submitsBefore, 'the resumed job was not submitted again');
    const orphan = await (await fetch(`${app.base}/api/animate/jobs/${orphanId}`)).json();
    assert.equal(orphan.state, 'failed');
    assert.equal(orphan.error.code, 'interrupted');
  } finally {
    await stop(app.server);
    await cleanup(dataDir, fixtures.dir);
  }
});

test('the mock route is hidden unless enabled', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-animate-'));
  const manifestPath = path.join(dataDir, 'none.json');
  const app = await start(dataDir, manifestPath, { animateMock: false });
  try {
    const status = await (await fetch(`${app.base}/api/animate/status`)).json();
    assert.ok(!status.routes.some(route => route.id === 'mock/local-demo'));
    assert.ok(!status.providers.some(provider => provider.id === 'mock'));
    const drivings = await (await fetch(`${app.base}/api/animate/drivings`)).json();
    assert.deepEqual(drivings, { drivings: [], hiddenExamples: 0 });
    const response = await json(app.base, 'POST', '/api/animate/jobs', { drivingId: 'x', routeId: 'mock/local-demo' });
    assert.equal((await response.json()).code, 'unknown_route');
  } finally {
    await stop(app.server);
    await cleanup(dataDir);
  }
});
