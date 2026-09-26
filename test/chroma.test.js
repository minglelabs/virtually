'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createAppServer } = require('../server');
const { makeGreenscreenSample } = require('../scripts/make-greenscreen-sample');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// Detect a usable ffmpeg (with libvpx-vp9 + chromakey) once for the whole file.
async function ffmpegUsable() {
  const run = (cmd, args) => new Promise(resolve => {
    let out = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => resolve(null));
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.on('close', code => resolve(code === 0 ? out : null));
  });
  const version = await run(FFMPEG, ['-hide_banner', '-version']);
  if (!version) return false;
  if (!(await run(FFPROBE, ['-hide_banner', '-version']))) return false;
  const encoders = await run(FFMPEG, ['-hide_banner', '-encoders']);
  if (!encoders || !/\blibvpx-vp9\b/.test(encoders)) return false;
  const filters = await run(FFMPEG, ['-hide_banner', '-filters']);
  return !!filters && /\bchromakey\b/.test(filters);
}

async function start(opts) {
  const server = await createAppServer(opts);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

// Decode a PNG/WebM to raw RGBA and read one pixel's alpha. For VP9 alpha we
// must force the libvpx-vp9 decoder on the input.
function alphaAt(filePath, { width, height, x, y, vp9 = false }) {
  return new Promise((resolve, reject) => {
    const inputArgs = vp9 ? ['-c:v', 'libvpx-vp9'] : [];
    const args = ['-hide_banner', '-loglevel', 'error', ...inputArgs, '-i', filePath,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.on('error', reject);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`decode exited ${code}`));
      const buf = Buffer.concat(chunks);
      const idx = (y * width + x) * 4 + 3;
      resolve(buf[idx]);
    });
  });
}

function isPng(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

test('chroma key transparent WebM job API', async (t) => {
  if (!(await ffmpegUsable())) {
    t.skip('ffmpeg with libvpx-vp9 is unavailable.');
    return;
  }

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-chroma-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-chroma-src-'));
  const shortClip = path.join(scratch, 'short.mp4');
  const longClip = path.join(scratch, 'long.mp4');
  await makeGreenscreenSample(shortClip, { width: 320, height: 180, duration: 2, fps: 30, ffmpegPath: FFMPEG });
  await makeGreenscreenSample(longClip, { width: 640, height: 360, duration: 6, fps: 30, ffmpegPath: FFMPEG });
  const shortBytes = await fs.readFile(shortClip);

  const { server, base } = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
  try {
    // 1. status
    const status = await (await fetch(`${base}/api/chroma/status`)).json();
    assert.equal(status.available, true);
    assert.ok(status.ffmpegVersion);
    assert.deepEqual(status.defaults, { color: '#00FF00', similarity: 0.12, blend: 0.06, despill: false });
    assert.deepEqual(status.limits, { similarity: [0.01, 1], blend: [0, 1] });
    assert.ok(status.acceptedExtensions.includes('.mp4'));

    // 2. bad extension -> 415
    const badExt = await fetch(`${base}/api/chroma/jobs?filename=clip.gif`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: shortBytes,
    });
    assert.equal(badExt.status, 415);

    // 3. non-video bytes named .mp4 -> 415, no leftover job dir
    const notVideo = await fetch(`${base}/api/chroma/jobs?filename=fake.mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('this is not a video at all'),
    });
    assert.equal(notVideo.status, 415);
    const workEntries = await fs.readdir(path.join(dataDir, 'work'));
    assert.equal(workEntries.length, 0, 'failed upload left no job dir');

    // 4. create a job from the short clip
    const created = await fetch(`${base}/api/chroma/jobs?filename=short.mp4&name=${encodeURIComponent('테스트 캐릭터')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: shortBytes,
    });
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.match(job.id, /^[0-9a-f-]{36}$/);
    assert.equal(job.state, 'ready');
    assert.equal(job.name, '테스트 캐릭터');
    assert.equal(job.source.width, 320);
    assert.equal(job.source.height, 180);
    assert.ok(Math.abs(job.source.duration - 2) < 0.5);
    assert.equal(job.source.codec, 'h264');
    assert.equal(job.frameUrl, `/api/chroma/jobs/${job.id}/frame`);

    // GET list + single
    const list = await (await fetch(`${base}/api/chroma/jobs`)).json();
    assert.equal(list.jobs[0].id, job.id);
    assert.equal((await fetch(`${base}/api/chroma/jobs/${job.id}`)).status, 200);
    assert.equal((await fetch(`${base}/api/chroma/jobs/00000000-0000-0000-0000-000000000000`)).status, 404);

    // 5. frame -> PNG
    const frame = await fetch(`${base}/api/chroma/jobs/${job.id}/frame?t=1`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('content-type'), 'image/png');
    const framePng = Buffer.from(await frame.arrayBuffer());
    assert.ok(isPng(framePng), 'frame is a PNG');

    // 6. preview -> PNG with alpha (corner 0, center 255)
    const preview = await fetch(`${base}/api/chroma/jobs/${job.id}/preview?t=1&color=00FF00&similarity=0.12&blend=0.06`);
    assert.equal(preview.status, 200);
    const previewPng = Buffer.from(await preview.arrayBuffer());
    assert.ok(isPng(previewPng), 'preview is a PNG');
    const previewPath = path.join(scratch, 'preview.png');
    await fs.writeFile(previewPath, previewPng);
    assert.equal(await alphaAt(previewPath, { width: 320, height: 180, x: 3, y: 3 }), 0, 'corner is transparent');
    assert.equal(await alphaAt(previewPath, { width: 320, height: 180, x: 160, y: 90 }), 255, 'center is opaque');

    // invalid params -> 400
    assert.equal((await fetch(`${base}/api/chroma/jobs/${job.id}/preview?color=red`)).status, 400);
    assert.equal((await fetch(`${base}/api/chroma/jobs/${job.id}/preview?similarity=5`)).status, 400);

    // convert requires application/json
    const wrongType = await fetch(`${base}/api/chroma/jobs/${job.id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.equal(wrongType.status, 415);

    // 7. convert -> poll to done
    const convert = await fetch(`${base}/api/chroma/jobs/${job.id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: '#00FF00', similarity: 0.12, blend: 0.06 }),
    });
    assert.equal(convert.status, 202);
    assert.equal((await convert.json()).state, 'converting');

    let done = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400));
      const poll = await (await fetch(`${base}/api/chroma/jobs/${job.id}`)).json();
      if (poll.state === 'done') { done = poll; break; }
      if (poll.state === 'failed') { assert.fail(`conversion failed: ${poll.error}`); }
    }
    assert.ok(done, 'conversion finished within 60 s');
    assert.equal(done.result.alpha, true);
    assert.equal(done.progress, 1);
    assert.ok(done.command.includes('libvpx-vp9'));

    // result 200 + EBML signature
    const result = await fetch(`${base}${done.result.url}`);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'video/webm');
    const resultBytes = Buffer.from(await result.arrayBuffer());
    assert.ok(resultBytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'EBML signature');

    // Range -> 206
    const ranged = await fetch(`${base}${done.result.url}`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206);

    // download -> Content-Disposition attachment
    const download = await fetch(`${base}${done.result.downloadUrl}`);
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
    assert.ok((download.headers.get('content-disposition') || '').includes(`filename*=UTF-8''${encodeURIComponent('테스트 캐릭터-transparent.webm')}`));
    await download.arrayBuffer();

    // decode result alpha with libvpx-vp9: corner 0, center 255
    const resultPath = path.join(scratch, 'result.webm');
    await fs.writeFile(resultPath, resultBytes);
    assert.equal(await alphaAt(resultPath, { width: 320, height: 180, x: 3, y: 3, vp9: true }), 0, 'result corner transparent');
    assert.equal(await alphaAt(resultPath, { width: 320, height: 180, x: 160, y: 90, vp9: true }), 255, 'result center opaque');

    // publish motion -> library + media serve
    const publishMotion = await fetch(`${base}/api/chroma/jobs/${job.id}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'motion', name: 'wave' }),
    });
    assert.equal(publishMotion.status, 201);
    const motionItem = await publishMotion.json();
    const lib1 = await (await fetch(`${base}/api/library`)).json();
    assert.ok(lib1.motions.some(m => m.id === motionItem.id));
    assert.equal((await fetch(`${base}${motionItem.url}`)).status, 200);

    // publish idle replaces idle
    const idle1 = await (await fetch(`${base}/api/chroma/jobs/${job.id}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'idle' }),
    })).json();
    const idle2 = await (await fetch(`${base}/api/chroma/jobs/${job.id}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'idle' }),
    })).json();
    const lib2 = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib2.idle.id, idle2.id);
    assert.notEqual(idle1.id, idle2.id);

    // bad kind -> 400
    assert.equal((await fetch(`${base}/api/chroma/jobs/${job.id}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'nope' }),
    })).status, 400);

    // 8. second convert while one runs -> 409, then cancel (use the long clip)
    const longCreated = await (await fetch(`${base}/api/chroma/jobs?filename=long.mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await fs.readFile(longClip),
    })).json();
    const conv1 = await fetch(`${base}/api/chroma/jobs/${longCreated.id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(conv1.status, 202);
    const conflict = await fetch(`${base}/api/chroma/jobs/${job.id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(conflict.status, 409);
    const canceled = await fetch(`${base}/api/chroma/jobs/${longCreated.id}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(canceled.status, 200);
    assert.equal((await canceled.json()).state, 'canceled');
    // cancel when not converting -> 409
    assert.equal((await fetch(`${base}/api/chroma/jobs/${longCreated.id}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).status, 409);

    // two simultaneous converts (double click) -> exactly one encode starts
    const racing = await Promise.all([0, 1].map(() => fetch(`${base}/api/chroma/jobs/${longCreated.id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })));
    assert.deepEqual(racing.map(r => r.status).sort(), [202, 409]);
    await Promise.all(racing.map(r => r.arrayBuffer()));
    assert.equal((await fetch(`${base}/api/chroma/jobs/${longCreated.id}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).status, 200);

    // publish before done -> 409 (longCreated has no result)
    assert.equal((await fetch(`${base}/api/chroma/jobs/${longCreated.id}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'motion' }),
    })).status, 409);

    // DELETE job -> then 404 and dir removed
    const del = await fetch(`${base}/api/chroma/jobs/${job.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${base}/api/chroma/jobs/${job.id}`)).status, 404);
    const stillThere = await fs.readdir(path.join(dataDir, 'work'));
    assert.ok(!stillThere.includes(job.id), 'job dir removed');

    await stop(server);

    // restart with the same dataDir -> jobs empty + work dir empty
    const restarted = await start({ dataDir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
    try {
      const jobsAfter = await (await fetch(`${restarted.base}/api/chroma/jobs`)).json();
      assert.deepEqual(jobsAfter.jobs, []);
      const workAfter = await fs.readdir(path.join(dataDir, 'work'));
      assert.equal(workAfter.length, 0);
    } finally {
      await stop(restarted.server);
    }
  } finally {
    if (server.listening) await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('bogus ffmpegPath -> status unavailable and jobs POST 503', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-chroma-noffmpeg-'));
  const { server, base } = await start({ dataDir, ffmpegPath: '/nonexistent/ffmpeg-xyz', ffprobePath: '/nonexistent/ffprobe-xyz' });
  try {
    const status = await (await fetch(`${base}/api/chroma/status`)).json();
    assert.equal(status.available, false);
    assert.ok(status.reason);
    const post = await fetch(`${base}/api/chroma/jobs?filename=clip.mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(post.status, 503);
  } finally {
    await stop(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
