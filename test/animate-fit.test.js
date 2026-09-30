'use strict';

// Character-box measurement (lib/animate/fit.js) and the driving margin
// (lib/animate/margin.js + media.prepareReference + the job option). All
// media is generated locally with ffmpeg; nothing touches the network.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { execFileSync } = require('node:child_process');

const { measureFit } = require('../lib/animate/fit');
const margins = require('../lib/animate/margin');
const media = require('../lib/animate/media');
const { createAppServer } = require('../server');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

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

function near(actual, expected, tolerance = 0.02) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${actual} vs ${expected}`));
}

// One RGB pixel of frame 0 of a video.
function pixel(filePath, x, y, width) {
  const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const at = (y * width + x) * 3;
  return [raw[at], raw[at + 1], raw[at + 2]];
}

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('measureFit: a transparent WebM with a box moving to the right edge', { skip }, async () => {
  const dir = await tmpDir('virtually-fit-');
  const file = path.join(dir, 'moving.webm');
  // 160x120, 24 fps, 2 s. A 40x40 opaque box starts at x 20-59, y 40-79 and
  // moves right 120 px/s until it is clamped against the right edge. At 24 fps
  // the fps=4 sampler's first output is frame 2 (box already 10 px right), so
  // `first` must come from frame 0 itself.
  ffmpeg(['-f', 'lavfi', '-i',
    "nullsrc=s=160x120:r=24:d=2,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,min(20+120*T\\,120)\\,min(59+120*T\\,159))*between(Y\\,40\\,79)'",
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '10', '-b:v', '0', '-auto-alt-ref', '0', file]);
  const fit = await measureFit(FFMPEG, FFPROBE, file);
  assert.ok(fit, 'measured');
  assert.equal(fit.v, 1);
  assert.equal(fit.width, 160);
  assert.equal(fit.height, 120);
  near(fit.first, [20 / 160, 40 / 120, 60 / 160, 80 / 120]);
  near(fit.union, [20 / 160, 40 / 120, 1, 80 / 120]);
  assert.deepEqual(fit.touches, { left: false, right: true, top: false, bottom: false });
  for (const value of [...fit.first, ...fit.union]) assert.equal(value, Number(value.toFixed(4)), 'rounded to 4 decimals');
});

test('measureFit: PNG with alpha, a large PNG (scaled, source size kept), MP4, opaque WebM and fully transparent', { skip }, async () => {
  const dir = await tmpDir('virtually-fit-');
  const png = path.join(dir, 'character.png');
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'",
    '-frames:v', '1', png]);
  const fit = await measureFit(FFMPEG, FFPROBE, png);
  assert.deepEqual(fit, {
    v: 1, width: 64, height: 96, first: [0.25, 0.25, 0.75, 0.75], union: [0.25, 0.25, 0.75, 0.75],
    touches: { left: false, right: false, top: false, bottom: false },
  });

  // 1000x500 -> scanned at 256x128; a box touching the bottom edge.
  const big = path.join(dir, 'big.png');
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=1000x500,format=rgba,geq=r=0:g=0:b=255:a='255*between(X\\,200\\,599)*gte(Y\\,100)'",
    '-frames:v', '1', big]);
  const bigFit = await measureFit(FFMPEG, FFPROBE, big);
  assert.equal(bigFit.width, 1000);
  assert.equal(bigFit.height, 500);
  near(bigFit.first, [0.2, 0.2, 0.6, 1]);
  assert.deepEqual(bigFit.touches, { left: false, right: false, top: false, bottom: true });

  const mp4 = path.join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=8', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', mp4]);
  assert.equal(await measureFit(FFMPEG, FFPROBE, mp4), null);

  const opaque = path.join(dir, 'opaque.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=8', '-t', '1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-deadline', 'realtime', opaque]);
  assert.equal(await measureFit(FFMPEG, FFPROBE, opaque), null);

  const empty = path.join(dir, 'empty.png');
  ffmpeg(['-f', 'lavfi', '-i', 'nullsrc=s=32x32,format=rgba,geq=r=0:g=0:b=0:a=0', '-frames:v', '1', empty]);
  assert.equal(await measureFit(FFMPEG, FFPROBE, empty), null);

  // Unreadable files never throw.
  const junk = path.join(dir, 'junk.webm');
  await fs.writeFile(junk, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
  assert.equal(await measureFit(FFMPEG, FFPROBE, junk), null);
  assert.equal(await measureFit(FFMPEG, FFPROBE, path.join(dir, 'missing.png')), null);
});

test('margin values, labels, defaults and padding size', () => {
  assert.deepEqual(margins.marginViews(), [{ value: 'none', label: '없음' }, { value: 'normal', label: '보통' }, { value: 'wide', label: '넓게' }]);
  assert.equal(margins.defaultMarginFor({ defaultMargin: 'normal' }), 'normal');
  assert.equal(margins.defaultMarginFor({ defaultMargin: 'huge' }), 'none');
  assert.equal(margins.defaultMarginFor({}), 'none');
  assert.equal(margins.marginRecord(undefined), 'none');
  assert.equal(margins.marginPx('normal', 320, 240), 38);
  assert.equal(margins.marginPx('wide', 320, 240), 80);
  assert.equal(margins.marginPx('none', 320, 240), 0);
});

test('prepareReference pads left, right and top with black before scaling', { skip }, async () => {
  const dir = await tmpDir('virtually-margin-');
  const source = path.join(dir, 'white.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', source]);
  const padded = path.join(dir, 'padded.mp4');
  const prep = await media.prepareReference(FFMPEG, FFPROBE, source, padded, { marginPx: margins.marginPx('normal', 320, 240) });
  assert.equal(prep.padPx, 38);
  assert.deepEqual(prep.padded, { w: 396, h: 278 });
  const probed = await media.probeVideo(FFPROBE, padded);
  assert.equal(probed.width, 396);
  assert.equal(probed.height, 278);
  for (const [x, y] of [[4, 4], [391, 4], [4, 200], [391, 200], [198, 10]]) {
    assert.ok(Math.max(...pixel(padded, x, y, 396)) < 30, `padding at ${x},${y} is black`);
  }
  assert.ok(Math.min(...pixel(padded, 198, 274, 396)) > 220, 'bottom centre keeps the original content');

  const plain = path.join(dir, 'plain.mp4');
  const none = await media.prepareReference(FFMPEG, FFPROBE, source, plain, { marginPx: 0 });
  assert.equal(none.padPx, 0);
  const plainProbe = await media.probeVideo(FFPROBE, plain);
  assert.equal(plainProbe.width, 320);
  assert.equal(plainProbe.height, 240);
  assert.ok(Math.min(...pixel(plain, 4, 4, 320)) > 220, 'no margin: the corner is the original content');
});

async function start(dataDir) {
  const server = await createAppServer({ dataDir, animateMock: true, animatePollIntervalMs: 40, examplesManifestPath: path.join(dataDir, 'no-examples.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function post(base, pathname, body) {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function waitForJob(base, id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
    if (['succeeded', 'failed', 'canceled'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('job margin option: validation, padded reference, job view, lazy fit after a restart', { skip }, async () => {
  const dir = await tmpDir('virtually-margin-job-');
  const dataDir = path.join(dir, 'data');
  const clip = path.join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
  const character = path.join(dir, 'character.png');
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'",
    '-frames:v', '1', character]);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'no-examples.json'), JSON.stringify({ version: 1, examples: [] }));
  let app = await start(dataDir);
  let jobId;
  try {
    let response = await fetch(`${app.base}/api/animate/characters?name=c.png`, { method: 'POST', body: fsSync.readFileSync(character) });
    assert.equal(response.status, 201);
    response = await fetch(`${app.base}/api/animate/drivings?name=clip.mp4`, { method: 'POST', body: fsSync.readFileSync(clip) });
    assert.equal(response.status, 201);
    const driving = await response.json();

    response = await post(app.base, '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', margin: 'huge' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'bad_margin');

    response = await post(app.base, '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', margin: 'normal' });
    assert.equal(response.status, 202);
    const created = (await response.json()).job;
    assert.equal(created.margin, 'normal');
    const done = await waitForJob(app.base, created.id);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.margin, 'normal');
    jobId = done.id;
    const jobDir = path.join(dataDir, 'animate', 'jobs', jobId);
    const reference = await media.probeVideo(FFPROBE, path.join(jobDir, 'reference.mp4'));
    assert.equal(reference.width, 396, 'P = round(0.12 * 320) = 38 on the left and right');
    assert.equal(reference.height, 278, 'and 38 on top, none at the bottom');
    assert.ok(Math.max(...pixel(path.join(jobDir, 'reference.mp4'), 4, 4, 396)) < 30, 'the padded corner is black');
    assert.ok(done.result.fit && done.result.fit.v === 1, 'keyed result has a fit');

    // A job stored before margins/fit existed: margin 'none', fit measured in the background.
    const jobPath = path.join(jobDir, 'job.json');
    const stored = JSON.parse(await fs.readFile(jobPath, 'utf8'));
    delete stored.margin;
    delete stored.result.fit;
    await stop(app.server);
    await fs.writeFile(jobPath, JSON.stringify(stored));
    app = await start(dataDir);
    await app.server.animate.pipeline.fitBackfill;
    const reloaded = await (await fetch(`${app.base}/api/animate/jobs/${jobId}`)).json();
    assert.equal(reloaded.margin, 'none');
    assert.deepEqual(reloaded.result.fit, done.result.fit);
    assert.ok('fit' in JSON.parse(await fs.readFile(jobPath, 'utf8')).result, 'persisted');
  } finally {
    await stop(app.server);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('library: uploads store fit, startup backfill fills missing fits and leaves fit:null alone', { skip }, async () => {
  const dir = await tmpDir('virtually-fit-lib-');
  const dataDir = path.join(dir, 'data');
  const mediaDir = path.join(dataDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(dir, 'no-examples.json'), JSON.stringify({ version: 1, examples: [] }));
  const missingId = '11111111-1111-4111-8111-111111111111';
  const nullId = '22222222-2222-4222-8222-222222222222';
  const idleId = '33333333-3333-4333-8333-333333333333';
  const webm = path.join(mediaDir, `${missingId}.webm`);
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96:r=8:d=1,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'",
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '10', '-b:v', '0', '-auto-alt-ref', '0', webm]);
  await fs.copyFile(webm, path.join(mediaDir, `${nullId}.webm`));
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=255:g=0:b=0:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'",
    '-frames:v', '1', path.join(mediaDir, `${idleId}.png`)]);
  const record = (id, name, mime) => ({ id, name, kind: 'motion', mime, url: `/api/media/${id}`, createdAt: new Date().toISOString() });
  await fs.writeFile(path.join(dataDir, 'library.json'), JSON.stringify({
    idle: { ...record(idleId, 'idle', 'image/png'), kind: 'idle' },
    motions: [record(missingId, 'old motion', 'video/webm'), { ...record(nullId, 'measured', 'video/webm'), fit: null }],
  }));
  const server = await createAppServer({ dataDir, examplesManifestPath: path.join(dir, 'no-examples.json') });
  // Backfill runs after listen and must not hold it up.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await server.fitBackfill;
    const library = await (await fetch(`${base}/api/library`)).json();
    const expected = [0.25, 0.25, 0.75, 0.75];
    near(library.motions[0].fit.first, expected);
    assert.equal(library.motions[0].fit.width, 64);
    assert.equal(library.motions[1].fit, null, 'a record with fit:null is not rewritten');
    assert.deepEqual(library.idle.fit.first, expected);
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8'));
    assert.deepEqual(persisted.motions[0].fit, library.motions[0].fit);

    // Uploads: a transparent WebM motion and a PNG idle get a fit.
    let response = await fetch(`${base}/api/upload?kind=motion&name=new&filename=new.webm`, {
      method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: fsSync.readFileSync(webm),
    });
    assert.equal(response.status, 201);
    near((await response.json()).fit.first, expected);
    response = await fetch(`${base}/api/upload?kind=idle&name=idle&filename=idle.png`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: fsSync.readFileSync(path.join(mediaDir, `${idleId}.png`)),
    });
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).fit.first, expected);
  } finally {
    await stop(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
