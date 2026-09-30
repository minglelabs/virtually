'use strict';

// Unit tests for lib/animate/drivings.js and scripts/fetch-examples.js, plus
// the bundled demo idle example. No network: downloads use a local fixture
// server or an injected fetch.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { loadManifest, validateExample, downloadExample, sniffVideo, DrivingStore } = require('../lib/animate/drivings');
const { main: fetchExamplesMain } = require('../scripts/fetch-examples');
const { createAppServer } = require('../server');

const ROOT = path.join(__dirname, '..');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
let skip = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { skip = 'ffmpeg is not installed'; }

const valid = {
  id: 'hi-wave', label: '인사', presetKey: 'hi', downloadUrl: 'https://example.com/a.mp4',
  sourcePage: 'https://example.com/p', author: 'A', license: 'L', licenseUrl: 'https://example.com/l',
  trim: { start: 0, duration: 5 },
};

// A bundled example: a file in the store's bundledDir instead of a download URL.
const bundled = { id: 'demo-idle', label: '기본 캐릭터 대기 (idle)', presetKey: null, file: 'demo-idle.mp4', author: 'Virtually', license: null };

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: 'ignore' });
}

function probe(filePath) {
  return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath]).toString());
}

// A 160x240, 4 s bundled clip + poster in `dir`, named after `bundled.file`.
function makeBundledFiles(dir) {
  const video = path.join(dir, 'demo-idle.mp4');
  const poster = path.join(dir, 'demo-idle.jpg');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x240:rate=15', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', video]);
  ffmpeg(['-ss', '0.5', '-i', video, '-frames:v', '1', poster]);
  return { video, poster };
}

// Runs `callback` with console.warn captured: { value, warnings }.
async function captureWarnings(callback) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { value: await callback(), warnings };
  } finally {
    console.warn = warn;
  }
}

test('manifest validation follows the spec rules', async () => {
  assert.equal(validateExample(valid, {}), null);
  assert.equal(validateExample({ ...valid, presetKey: null }, {}), null);
  assert.match(validateExample({ ...valid, id: 'Bad_Id' }, {}), /id/);
  assert.match(validateExample({ ...valid, id: 'a'.repeat(41) }, {}), /id/);
  assert.match(validateExample({ ...valid, presetKey: 'nope' }, {}), /presetKey/);
  assert.match(validateExample({ ...valid, downloadUrl: 'http://example.com/a.mp4' }, {}), /https/);
  assert.equal(validateExample({ ...valid, downloadUrl: 'http://127.0.0.1/a.mp4' }, { allowHttp: true }), null);
  assert.match(validateExample({ ...valid, trim: { start: 0, duration: 2 } }, {}), /3\.\.10/);
  assert.match(validateExample({ ...valid, trim: { start: 0, duration: 11 } }, {}), /3\.\.10/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-manifest-'));
  const file = path.join(dir, 'driving.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, examples: [valid, { ...valid }, { ...valid, id: 'other', trim: null }, { ...valid, id: 'second', presetKey: null }] }));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const examples = await loadManifest(file);
    assert.deepEqual(examples.map(item => item.id), ['hi-wave', 'second'], 'duplicates and invalid rows are skipped');
    assert.deepEqual(examples[0].credit, { author: 'A', license: 'L', licenseUrl: 'https://example.com/l', sourcePage: 'https://example.com/p' });
    assert.deepEqual(await loadManifest(path.join(dir, 'missing.json')), []);
  } finally {
    console.warn = warn;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function fakeResponse(status, { headers = {}, body = null } = {}) {
  return new Response(body, { status, headers });
}

test('downloadExample: https only on every hop, size caps, user agent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-download-'));
  const dest = name => path.join(dir, name);

  await assert.rejects(downloadExample(async () => { throw new Error('must not fetch'); }, 'http://example.com/a.mp4', dest('a')), /https/);

  const seen = [];
  const redirectToHttp = async (url, init) => {
    seen.push([url, init.headers['User-Agent'], init.redirect]);
    return fakeResponse(302, { headers: { Location: 'http://example.com/b.mp4' } });
  };
  await assert.rejects(downloadExample(redirectToHttp, 'https://example.com/a.mp4', dest('b')), /https/);
  assert.deepEqual(seen, [['https://example.com/a.mp4', 'virtually/0.1', 'manual']], 'the http hop was never requested');

  const redirectLoop = async () => fakeResponse(302, { headers: { Location: 'https://example.com/again' } });
  await assert.rejects(downloadExample(redirectLoop, 'https://example.com/a.mp4', dest('c')), /redirects/);

  const declaredTooLarge = async () => fakeResponse(200, { headers: { 'Content-Length': '2000' }, body: 'x' });
  await assert.rejects(downloadExample(declaredTooLarge, 'https://example.com/a.mp4', dest('d'), { maxBytes: 1000 }), /100 MB/);

  const streamedTooLarge = async () => fakeResponse(200, { body: Buffer.alloc(5000) });
  await assert.rejects(downloadExample(streamedTooLarge, 'https://example.com/a.mp4', dest('e'), { maxBytes: 1000 }), /100 MB/);
  assert.equal(fsSync.existsSync(dest('e')), false, 'a partial file is removed');

  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(downloadExample(hanging, 'https://example.com/a.mp4', dest('f'), { timeoutMs: 50 }), /timed out/);

  let hop = 0;
  const redirectThenOk = async () => (hop++ === 0
    ? fakeResponse(301, { headers: { Location: '/final.mp4' } })
    : fakeResponse(200, { body: Buffer.from('0000ftypisom0000') }));
  await downloadExample(redirectThenOk, 'https://example.com/a.mp4', dest('g'));
  assert.equal(await sniffVideo(dest('g')), 'mp4');
  await fs.rm(dir, { recursive: true, force: true });
});

test('fetch-examples script downloads and normalizes without a server', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-fetch-script-'));
  const clip = path.join(dir, 'tall.mp4');
  // Taller than 720 with an odd height: the output must be <= 720 and even.
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=406x1001:rate=10', '-t', '5',
    '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-preset', 'ultrafast', clip], { stdio: 'ignore' });
  const server = http.createServer((req, res) => {
    const body = fsSync.readFileSync(clip);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const manifest = path.join(dir, 'driving.json');
    await fs.writeFile(manifest, JSON.stringify({
      version: 1,
      examples: [{ ...valid, downloadUrl: `http://127.0.0.1:${server.address().port}/tall.mp4`, trim: { start: 1, duration: 3 } }],
    }));
    const dataDir = path.join(dir, 'data');
    const lines = [];
    const { results } = await fetchExamplesMain(['--data-dir', dataDir, '--manifest', manifest], { allowHttpExamples: true, log: line => lines.push(line) });
    assert.deepEqual(results, [{ id: 'hi-wave', ok: true }]);
    const out = path.join(dataDir, 'animate', 'drivings', 'examples', 'hi-wave.mp4');
    const probe = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString());
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.pix_fmt, 'yuv420p');
    assert.ok(video.height <= 720 && video.height % 2 === 0 && video.width % 2 === 0, `${video.width}x${video.height}`);
    assert.ok(!probe.streams.some(stream => stream.codec_type === 'audio'));
    assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.2);
    const poster = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams',
      path.join(dataDir, 'animate', 'drivings', 'examples', 'hi-wave.jpg')]).toString());
    assert.equal(poster.streams[0].height, 360);

    // A second run skips what is already there.
    const again = await fetchExamplesMain(['--data-dir', dataDir, '--manifest', manifest], { allowHttpExamples: true, log: line => lines.push(line) });
    assert.deepEqual(again.results, []);
    assert.ok(lines.some(line => /already downloaded/.test(line)));

    // Without the test flag, the http URL is rejected by the manifest rules.
    const warn = console.warn;
    console.warn = () => {};
    try {
      const strict = await fetchExamplesMain(['--data-dir', path.join(dir, 'strict'), '--manifest', manifest], { log: () => {} });
      assert.deepEqual(strict.results, []);
    } finally {
      console.warn = warn;
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function waitForJob(base, id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (['succeeded', 'failed', 'canceled'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('bundled examples: exactly one source, a bare file name, trim ignored', async () => {
  const neither = { ...valid };
  delete neither.downloadUrl;
  assert.equal(validateExample(bundled, {}), null);
  assert.equal(validateExample({ ...bundled, file: 'loop-2.webm' }, {}), null);
  assert.equal(validateExample({ ...bundled, trim: { start: 0, duration: 99 } }, {}), null, 'trim is ignored for a bundled file');
  assert.equal(validateExample({ ...valid, file: null }, {}), null, 'file: null is no file');
  assert.equal(validateExample({ ...bundled, downloadUrl: 'https://example.com/a.mp4' }, {}), 'both downloadUrl and file');
  assert.equal(validateExample(neither, {}), 'missing downloadUrl or file');
  for (const file of ['assets/demo-idle.mp4', 'a\\demo-idle.mp4', '/demo-idle.mp4', '../demo-idle.mp4', '..', 'demo..mp4',
    'Demo-idle.mp4', 'demo-idle.MP4', 'demo-idle.mov', 'demo-idle.jpg', 'demo-idle', '-demo.mp4', '.mp4', 'demo idle.mp4',
    `${'a'.repeat(41)}.mp4`, 'demo-idle.mp4\n', '', 7]) {
    assert.equal(validateExample({ ...bundled, file }, {}), 'bad file', JSON.stringify(file));
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-bundled-manifest-'));
  const file = path.join(dir, 'driving.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, examples: [
    { ...bundled, trim: { start: 1, duration: 99 } },
    { ...valid, id: 'both', file: 'both.mp4' },
    { ...neither, id: 'neither' },
    { ...bundled, id: 'escape', file: '../escape.mp4' },
    valid,
  ] }));
  try {
    const { value: examples, warnings } = await captureWarnings(() => loadManifest(file));
    assert.deepEqual(examples.map(item => item.id), ['demo-idle', 'hi-wave']);
    assert.deepEqual(examples[0], {
      id: 'demo-idle', label: '기본 캐릭터 대기 (idle)', presetKey: null, downloadUrl: null, file: 'demo-idle.mp4',
      credit: { author: 'Virtually', license: null, licenseUrl: null, sourcePage: null }, trim: null,
    });
    assert.equal(examples[1].file, null);
    assert.equal(examples[1].downloadUrl, valid.downloadUrl);
    assert.deepEqual(examples[1].trim, { start: 0, duration: 5 });
    assert.deepEqual(warnings, [
      'examples manifest: skipping both (both downloadUrl and file)',
      'examples manifest: skipping neither (missing downloadUrl or file)',
      'examples manifest: skipping escape (bad file)',
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a bundled example is available without a fetch and hides without losing its files', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-bundled-store-'));
  const bundledDir = path.join(dir, 'assets');
  await fs.mkdir(bundledDir);
  const files = makeBundledFiles(bundledDir);
  const bytes = { video: await fs.readFile(files.video), poster: await fs.readFile(files.poster) };
  const manifest = path.join(dir, 'driving.json');
  await fs.writeFile(manifest, JSON.stringify({ version: 1, examples: [bundled, { ...valid, id: 'remote', presetKey: null }] }));
  const requested = [];
  const options = {
    dataDir: path.join(dir, 'data'), manifestPath: manifest, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, bundledDir,
    fetchImpl: async url => { requested.push(url); throw new TypeError('offline'); },
  };
  try {
    const store = await new DrivingStore(options).init();
    const record = await store.get('demo-idle');
    assert.equal(record.kind, 'example');
    assert.equal(record.available, true);
    assert.equal(record.videoPath, files.video);
    assert.equal(record.posterPath, files.poster);
    assert.equal(record.mime, 'video/mp4');
    assert.ok(Math.abs(record.duration - 4) < 0.1, `duration ${record.duration}`);
    assert.deepEqual([record.width, record.height], [160, 240]);
    assert.deepEqual(record.credit, { author: 'Virtually', license: null, licenseUrl: null, sourcePage: null });
    const list = await store.list();
    assert.deepEqual(list.map(item => [item.id, item.available]), [['demo-idle', true], ['remote', false]]);
    assert.equal(list[0].url, '/api/animate/drivings/demo-idle/video');
    assert.equal(list[0].posterUrl, '/api/animate/drivings/demo-idle/poster');

    // Only the downloadable example is fetched; the bundled one is neither requested nor listed.
    const results = await store.fetchExamples();
    assert.deepEqual(results.map(result => result.id), ['remote']);
    assert.deepEqual(requested, [valid.downloadUrl]);
    assert.deepEqual(await fs.readdir(store.examplesDir), [], 'nothing is written to the data dir for it');

    // Hide: gone from the list and persisted; the bundled files stay.
    assert.equal(await store.remove('demo-idle'), true);
    assert.equal(await store.get('demo-idle'), null);
    assert.deepEqual((await store.list()).map(item => item.id), ['remote']);
    assert.equal(store.hiddenCount(), 1);
    assert.deepEqual(JSON.parse(await fs.readFile(store.hiddenPath, 'utf8')), { hidden: ['demo-idle'] });
    assert.ok((await fs.readFile(files.video)).equals(bytes.video), 'bundled video kept');
    assert.ok((await fs.readFile(files.poster)).equals(bytes.poster), 'bundled poster kept');
    // A restart (which finishes interrupted hides) keeps them too.
    const restarted = await new DrivingStore(options).init();
    assert.equal(await restarted.get('demo-idle'), null);
    assert.ok((await fs.readFile(files.video)).equals(bytes.video));

    // Restore: available at once, nothing to fetch.
    await restarted.restoreExamples();
    const back = await restarted.get('demo-idle');
    assert.equal(back.available, true);
    assert.equal(back.videoPath, files.video);
    assert.deepEqual((await restarted.fetchExamples()).map(result => result.id), ['remote']);

    // Without a bundledDir the example is listed but unavailable.
    const bare = await new DrivingStore({ ...options, bundledDir: null }).init();
    const missing = await bare.get('demo-idle');
    assert.equal(missing.available, false);
    assert.equal(missing.videoPath, null);
    assert.equal(bare.view(missing).url, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('API: a bundled example serves its files, drives a padded job and hides without deleting them', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-bundled-api-'));
  const bundledDir = path.join(dir, 'assets');
  await fs.mkdir(bundledDir);
  const files = makeBundledFiles(bundledDir);
  const bytes = { video: await fs.readFile(files.video), poster: await fs.readFile(files.poster) };
  const manifest = path.join(dir, 'driving.json');
  await fs.writeFile(manifest, JSON.stringify({ version: 1, examples: [bundled] }));
  // A red body on a transparent canvas (see animate-integration.test.js).
  const character = path.join(dir, 'character.png');
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'",
    '-frames:v', '1', character]);
  const dataDir = path.join(dir, 'data');
  const server = await createAppServer({
    dataDir, examplesManifestPath: manifest, bundledDrivingsDir: bundledDir, animateMock: true, animatePollIntervalMs: 40,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body) => fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const list = async () => (await fetch(`${base}/api/animate/drivings`)).json();
  const bodyOf = async response => Buffer.from(await response.arrayBuffer());
  try {
    let data = await list();
    assert.equal(data.hiddenExamples, 0);
    assert.deepEqual(data.drivings.map(item => [item.id, item.kind, item.available]), [['demo-idle', 'example', true]]);
    const view = data.drivings[0];

    let response = await fetch(`${base}${view.url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.ok((await bodyOf(response)).equals(bytes.video), 'video bytes are the bundled file');
    response = await fetch(`${base}${view.url}`, { headers: { Range: 'bytes=0-15' } });
    assert.equal(response.status, 206);
    assert.ok((await bodyOf(response)).equals(bytes.video.subarray(0, 16)));
    response = await fetch(`${base}${view.posterUrl}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.ok((await bodyOf(response)).equals(bytes.poster), 'poster bytes are the bundled file');

    // A job reads the bundled file in place; the 'normal' margin pads it by
    // round(0.12 * 240) = 29 px left, right and top: 218x269, then even -> 218x268.
    response = await fetch(`${base}/api/animate/characters?name=c.png`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: fsSync.readFileSync(character),
    });
    assert.equal(response.status, 201);
    await bodyOf(response);
    response = await post('/api/animate/jobs', { drivingId: 'demo-idle', routeId: 'mock/local-demo', margin: 'normal' });
    assert.equal(response.status, 202);
    const created = (await response.json()).job;
    assert.equal(created.drivingId, 'demo-idle');
    assert.equal(created.drivingLabel, bundled.label);
    const job = await waitForJob(base, created.id);
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    assert.equal(job.margin, 'normal');
    const reference = probe(path.join(dataDir, 'animate', 'jobs', job.id, 'reference.mp4')).streams.find(stream => stream.codec_type === 'video');
    assert.deepEqual([reference.width, reference.height], [218, 268]);
    assert.ok((await fs.readFile(files.video)).equals(bytes.video), 'the job left the bundled file alone');

    // Hide: not listed, not served, files still on disk; fetch has nothing to do.
    response = await fetch(`${base}/api/animate/drivings/demo-idle`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    data = await list();
    assert.deepEqual(data.drivings, []);
    assert.equal(data.hiddenExamples, 1);
    response = await fetch(`${base}${view.url}`);
    assert.equal(response.status, 404);
    await bodyOf(response);
    assert.ok((await fs.readFile(files.video)).equals(bytes.video), 'bundled video kept');
    assert.ok((await fs.readFile(files.poster)).equals(bytes.poster), 'bundled poster kept');
    response = await post('/api/animate/examples/fetch', {});
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).results, []);

    // Restore: back and available at once.
    response = await post('/api/animate/examples/restore', {});
    assert.equal(response.status, 200);
    const restored = await response.json();
    assert.deepEqual(restored.drivings.map(item => [item.id, item.available, item.url]), [['demo-idle', true, view.url]]);
    response = await fetch(`${base}${view.url}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('fetch-examples skips bundled examples', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-fetch-bundled-'));
  try {
    const manifest = path.join(dir, 'driving.json');
    await fs.writeFile(manifest, JSON.stringify({ version: 1, examples: [bundled] }));
    const lines = [];
    const { results } = await fetchExamplesMain(['--data-dir', path.join(dir, 'data'), '--manifest', manifest], { log: line => lines.push(line) });
    assert.deepEqual(results, []);
    assert.deepEqual(lines, ['1 bundled with the repository (nothing to download).']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the manifest lists the human idle loops first, then the committed demo idle clip', async () => {
  const { value: examples, warnings } = await captureWarnings(() => loadManifest(path.join(ROOT, 'examples', 'driving.json')));
  assert.deepEqual(warnings, [], 'every manifest entry is valid');
  assert.deepEqual(examples.slice(0, 3).map(item => item.id), ['human-idle-neutral', 'human-idle-smile', 'demo-idle']);
  for (const human of examples.slice(0, 2)) {
    assert.equal(human.file, null, `${human.id} is downloaded, not bundled`);
    assert.match(human.downloadUrl, /^https:\/\/videos\.pexels\.com\/video-files\//);
    assert.equal(human.presetKey, null);
    assert.equal(human.credit.license, 'Pexels License');
    assert.ok(human.trim.duration >= 4 && human.trim.duration <= 6, `${human.id}: ${human.trim.duration} s loop`);
  }
  const demo = examples[2];
  assert.equal(demo.file, 'demo-idle.mp4');
  assert.equal(demo.presetKey, null);
  assert.deepEqual(demo.credit, { author: 'Virtually', license: null, licenseUrl: null, sourcePage: null });
  for (const name of ['demo-idle.mp4', 'demo-idle.jpg']) {
    const stat = await fs.stat(path.join(ROOT, 'assets', 'drivings', name));
    assert.ok(stat.size > 0 && stat.size < 1024 * 1024, `${name}: ${stat.size} bytes`);
  }
});

test('the demo idle clip is H.264, 30 fps, 3.8 s and at most 720 px high', { skip }, async () => {
  const video = probe(path.join(ROOT, 'assets', 'drivings', 'demo-idle.mp4'));
  const stream = video.streams.find(item => item.codec_type === 'video');
  assert.equal(stream.codec_name, 'h264');
  assert.equal(stream.pix_fmt, 'yuv420p');
  const [num, den] = stream.avg_frame_rate.split('/').map(Number);
  assert.equal(num / den, 30);
  assert.ok(Math.abs(Number(video.format.duration) - 3.8) <= 0.05, `duration ${video.format.duration}`);
  assert.ok(stream.height <= 720, `height ${stream.height}`);
  assert.ok(!video.streams.some(item => item.codec_type === 'audio'), 'no audio');
  assert.equal(probe(path.join(ROOT, 'assets', 'drivings', 'demo-idle.jpg')).streams[0].height, 360);
});

test('render-demo-idle takes the whole #demo-avatar element from overlay.html', async () => {
  const { extractElement, renderPage, FRAMES } = require('../scripts/render-demo-idle');
  const html = await fs.readFile(path.join(ROOT, 'public', 'overlay.html'), 'utf8');
  const avatar = extractElement(html, 'demo-avatar');
  assert.match(avatar, /^<div\b[^>]*\bid="demo-avatar"/);
  assert.match(avatar, /<\/svg>\s*<\/div>$/);
  assert.equal((avatar.match(/<div\b/g) || []).length, (avatar.match(/<\/div>/g) || []).length, 'balanced');
  assert.ok(!avatar.includes('idle-layer'), 'stops at its own closing tag');
  assert.ok(!/\breacting\b/.test(avatar), 'idle markup');
  assert.ok(renderPage('.a {}', avatar).includes(avatar));
  assert.equal(FRAMES, 114, '3.8 s at 30 fps');
});
