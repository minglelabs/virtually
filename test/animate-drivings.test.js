'use strict';

// Unit tests for lib/animate/drivings.js and scripts/fetch-examples.js. No
// network: downloads use a local fixture server or an injected fetch.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { loadManifest, validateExample, downloadExample, sniffVideo } = require('../lib/animate/drivings');
const { main: fetchExamplesMain } = require('../scripts/fetch-examples');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let skip = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { skip = 'ffmpeg is not installed'; }

const valid = {
  id: 'hi-wave', label: '인사', presetKey: 'hi', downloadUrl: 'https://example.com/a.mp4',
  sourcePage: 'https://example.com/p', author: 'A', license: 'L', licenseUrl: 'https://example.com/l',
  trim: { start: 0, duration: 5 },
};

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
