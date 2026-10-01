'use strict';

// '배경 제거하기': re-running background removal, with the plain-background
// fallback for results whose background is not the key colour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { frameAlpha, ringColor, plainCutVideo } = require('../lib/animate/plain-cut');
const { createAppServer } = require('../server');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const skip = spawnSync(FFMPEG, ['-version']).status === 0 ? false : 'ffmpeg not available';
const ffmpeg = args => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

function alphaAt(file, x, y, t = 0) {
  const w = Number(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', file]).toString().trim());
  const buf = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
  return buf[(y * w + x) * 4 + 3];
}

// 60x80 frame: near-white background, a dark-outlined "character" box with a pale
// (skin-like) inside, and a white hole enclosed by the character.
function frame() {
  const w = 60; const h = 80; const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const o = (y * w + x) * 4;
    const inBox = x >= 10 && x < 50 && y >= 10 && y < 80;
    const outline = inBox && (x < 12 || x >= 48 || y < 12);
    const hole = x >= 24 && x < 36 && y >= 40 && y < 52;
    const holeRim = x >= 22 && x < 38 && y >= 38 && y < 54 && !hole;
    let rgb = [231, 239, 246];
    if (inBox) rgb = outline || holeRim ? [40, 30, 30] : hole ? [231, 239, 246] : [249, 228, 221];
    px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
  }
  return { px, w, h };
}

test('frameAlpha clears only the border-connected plain background', () => {
  const { px, w, h } = frame();
  const bg = ringColor(px, w, h);
  assert.deepEqual(bg.map(Math.round), [231, 239, 246]);
  const { alpha, share } = frameAlpha(px, w, h, bg);
  assert.equal(alpha[0], 0, 'corner');
  assert.equal(alpha[30 * w + 30], 255, 'pale skin 30+ away stays');
  assert.equal(alpha[45 * w + 30], 255, 'enclosed background hole stays');
  assert.ok(share > 0.3 && share < 0.5, `share ${share}`);
  // No dominant border colour -> no background.
  const noisy = Buffer.from(px);
  for (let i = 0; i < w * h; i += 1) { noisy[i * 4] = (i * 97) % 256; noisy[i * 4 + 1] = (i * 57) % 256; }
  assert.equal(ringColor(noisy, w, h), null);
});

test('plainCutVideo makes the plain background of a clip transparent', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-plain-'));
  try {
    const { px, w, h } = frame();
    const png = path.join(dir, 'f.png');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0',
      '-frames:v', '1', png], { input: px });
    const clip = path.join(dir, 'clip.mp4');
    ffmpeg(['-loop', '1', '-i', png, '-t', '1', '-r', '10', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '12', clip]);
    const out = path.join(dir, 'out.webm');
    const result = await plainCutVideo(FFMPEG, FFPROBE, clip, out);
    assert.equal(result.cut, true, JSON.stringify(result));
    assert.equal(alphaAt(out, 1, 1), 0);
    assert.equal(alphaAt(out, 30, 25), 255);
    assert.equal(alphaAt(out, 30, 70, 0.5), 255, 'character body in a later frame');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('POST .../key re-runs removal, falls back to the plain cut and swaps the added motion to WebM', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-rekey-'));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'no-examples.json'), JSON.stringify({ version: 1, examples: [] }));
  const character = path.join(dir, 'c.png');
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=200:g=40:b=40:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'", '-frames:v', '1', character]);
  const clip = path.join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
  const server = await createAppServer({ dataDir, animateMock: true, animatePollIntervalMs: 40, examplesManifestPath: path.join(dataDir, 'no-examples.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await (await fetch(`${base}/api/characters?name=${encodeURIComponent('캐릭터')}&filename=c.png`, { method: 'POST', body: fsSync.readFileSync(character) })).json();
    const photoId = created.character.basePhotoId;
    // On air, so the motion added below is in the overlay's library.
    await fetch(`${base}/api/active-photo`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photoId }) });
    const driving = await (await fetch(`${base}/api/animate/drivings?name=clip.mp4`, { method: 'POST', body: fsSync.readFileSync(clip) })).json();
    const id = (await (await post('/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', photoId })).json()).job.id;
    let job;
    for (const deadline = Date.now() + 30000; ;) {
      job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
      if (['succeeded', 'failed', 'canceled'].includes(job.state)) break;
      if (Date.now() > deadline) throw new Error(`stuck in ${job.state}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(job.state, 'succeeded');
    const jobDir = path.join(dataDir, 'animate', 'jobs', id);

    // A result whose background could not be removed (noise: no key colour, no plain
    // border) is added to the motion list as an MP4.
    const resultPath = path.join(jobDir, 'result.mp4');
    ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=160x120:r=15:d=2,geq=lum='random(1)*255':cb=128:cr=128", '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '12', resultPath]);
    const stored = JSON.parse(await fs.readFile(path.join(jobDir, 'job.json'), 'utf8'));
    await fs.rm(path.join(jobDir, 'result.webm'), { force: true });
    server.animate.pipeline.get(id).result = { ...stored.result, keyed: null, keySkipped: 'not_key_color', fit: null };
    let response = await post(`/api/animate/jobs/${id}/motion`, {});
    assert.equal(response.status, 201);
    const added = await response.json();
    assert.equal(added.motion.mime, 'video/mp4');

    // Later the result is a plain white background (the model ignored the key colour):
    // 배경 제거하기 cuts it and the added motion becomes the transparent WebM.
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xE7EFF6:s=160x120:r=15:d=2', '-f', 'lavfi', '-i', 'color=c=0xC83232:s=40x60:r=15:d=2',
      '-filter_complex', '[0][1]overlay=60:40', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '12', resultPath]);

    response = await post(`/api/animate/jobs/${id}/key`, {});
    assert.equal(response.status, 200);
    const rekeyed = await response.json();
    assert.equal(rekeyed.keyed, true, JSON.stringify(rekeyed));
    assert.equal(rekeyed.job.result.keyMethod, 'plain');
    assert.match(rekeyed.job.result.keyedUrl, /variant=keyed&v=\d+/);
    assert.equal(rekeyed.motion.id, added.motion.id, 'same motion, same buttons');
    assert.equal(rekeyed.motion.mime, 'video/webm');
    assert.ok(rekeyed.motion.fit && rekeyed.motion.fit.v === 1);
    const library = await (await fetch(`${base}/api/library`)).json();
    const motion = library.motions.find(item => item.id === added.motion.id);
    assert.equal(motion.mime, 'video/webm');
    const media = await fetch(`${base}${motion.url}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'video/webm');
    assert.equal(fsSync.readdirSync(path.join(dataDir, 'media')).filter(f => f.startsWith(added.motion.id)).join(','), `${added.motion.id}.webm`, 'old MP4 removed');

    response = await post('/api/animate/jobs/00000000-0000-4000-8000-000000000000/key', {});
    assert.equal(response.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
