'use strict';

// The versions of one result: the original, the free transparent clip and the AI one are
// all kept, any of them can be put in use, added as the motion, and downloaded.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createAppServer } = require('../server.js');
const A = require('../public/animate.js');

const ffmpeg = (args) => {
  const done = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  assert.equal(done.status, 0, String(done.stderr));
};

test('page helpers: the versions of a result, the chosen one and their names', () => {
  const job = { result: { url: '/r', activeVersion: 'free', versions: [{ kind: 'original', url: '/r' }, { kind: 'free', url: '/f', keyMethod: 'color' }, { kind: 'ai', url: '/a', keyMethod: 'ai' }] } };
  assert.deepEqual(A.jobVersions(job).map(v => v.kind), ['original', 'free', 'ai']);
  assert.equal(A.chosenVersion(job, null), 'free', 'the one in use');
  assert.equal(A.chosenVersion(job, 'ai'), 'ai', 'the page pick');
  assert.equal(A.chosenVersion(job, 'gone'), 'free');
  assert.deepEqual(A.jobVersions(job).map(A.versionLabel), ['원본', '배경 제거 (무료)', '배경 제거 (AI)']);
  // An answer without `versions`: the original and the keyed clip.
  assert.deepEqual(A.jobVersions({ result: { url: '/r', keyedUrl: '/k', keyMethod: 'ai' } }).map(v => [v.kind, v.url]), [['original', '/r'], ['ai', '/k']]);
  assert.deepEqual(A.jobVersions({ result: null }), []);
  assert.equal(A.chosenVersion({ result: { url: '/r' } }, null), 'original');
  // Step 3 of a result whose original is in use while a transparent version exists.
  const steps = A.jobSteps({ state: 'succeeded', steps: { cut: 'done', key: true }, result: { url: '/r', keyedUrl: null, versions: job.result.versions } });
  assert.deepEqual([steps[2].text, steps[2].kind], ['완료 · 원본 사용 중', 'done']);
});

test('a result keeps every version: each can be put in use, added as the motion and fetched', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-versions-'));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'no-examples.json'), JSON.stringify({ version: 1, examples: [] }));
  const file = name => path.join(dir, name);
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=64x96,format=rgba,geq=r=200:g=40:b=40:a='255*between(X\\,16\\,47)*between(Y\\,24\\,71)'", '-frames:v', '1', file('c.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', file('clip.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', "color=c=red:s=64x96:r=8:d=1,format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(between(X,16,48)*between(Y,24,72),255,0)'",
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', file('ai.webm')]);
  let aiCalls = 0;
  const rimCalls = [];
  const backgroundAi = {
    available: () => true,
    image: async () => { throw new Error('not used'); },
    video: async (src, dest) => { aiCalls += 1; await fs.copyFile(file('ai.webm'), dest); return { rimCleaned: false }; },
    cleanRim: async (src, keyedPath, options) => { rimCalls.push([path.basename(keyedPath), options.choke]); return true; },
    videoUsd: () => 0.05,
    view: () => ({ available: true, imageUsd: 0.004, videoUsdPerSecond: 0.05, videoMinSeconds: 1 }),
  };
  const server = await createAppServer({ dataDir, animateMock: true, animatePollIntervalMs: 40, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animate: { backgroundAi } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const bytes = async p => Buffer.from(await (await fetch(`${base}${p}`)).arrayBuffer());

  const created = await (await fetch(`${base}/api/characters?name=c&filename=c.png`, { method: 'POST', body: fsSync.readFileSync(file('c.png')) })).json();
  const photoId = created.character.basePhotoId;
  const driving = await (await fetch(`${base}/api/animate/drivings?name=clip.mp4`, { method: 'POST', body: fsSync.readFileSync(file('clip.mp4')) })).json();
  const id = (await (await post('/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', photoId })).json()).job.id;
  let job;
  for (let i = 0; i < 400; i += 1) {
    const got = await (await fetch(`${base}/api/animate/jobs/${id}`)).json(); job = got.job || got;
    if (['succeeded', 'failed', 'canceled'].includes(job.state)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  const kinds = j => j.result.versions.map(v => v.kind);

  // The run made the free transparent clip: the original and that one, the free one in use.
  // The free key ran the colour clean-up on its clip by itself.
  assert.deepEqual([kinds(job), job.result.activeVersion], [['original', 'free'], 'free']);
  assert.deepEqual([rimCalls.length, rimCalls[0][0], job.result.versions[1].cleaned], [1, 'result.webm', true]);
  const freeUrl = job.result.versions[1].url;
  assert.match(freeUrl, new RegExp(`^/api/animate/jobs/${id}/result\\?variant=free&v=\\d+$`));
  const freeBytes = await bytes(freeUrl);
  assert.deepEqual(freeBytes, await bytes(job.result.keyedUrl));

  // The AI remover adds its own version and leaves the free one.
  let response = await post(`/api/animate/jobs/${id}/key`, { method: 'ai' });
  let data = await response.json();
  assert.deepEqual([response.status, data.keyed, kinds(data.job), data.job.result.activeVersion, aiCalls], [200, true, ['original', 'free', 'ai'], 'ai', 1]);
  assert.deepEqual(await bytes(data.job.result.versions[2].url), fsSync.readFileSync(file('ai.webm')));
  assert.deepEqual(await bytes(data.job.result.versions[1].url), freeBytes, 'the free version is still there');

  // '배경색 번짐 지우기' works on the version asked for, free or AI, in use or not; the alpha
  // is pulled in the first time only (the free version had its clean-up when it was made).
  assert.equal(data.job.result.rimCleanable, true);
  for (const [version, choke] of [['free', false], ['ai', true]]) {
    response = await post(`/api/animate/jobs/${id}/key`, { method: 'rim', version });
    data = await response.json();
    assert.deepEqual([response.status, data.keyed, data.rimCleaned, data.job.result.activeVersion], [200, true, true, 'ai'], version);
    assert.deepEqual(rimCalls[rimCalls.length - 1], [`keyed.${version}.webm`, choke]);
  }
  assert.equal(aiCalls, 1, 'no AI call for the colour clean-up');
  response = await post(`/api/animate/jobs/${id}/key`, { method: 'rim', version: 'original' });
  assert.equal((await response.json()).rimCleaned, true, 'an unknown or original version means the one in use');

  // Back to the free one, then to an unknown one.
  response = await post(`/api/animate/jobs/${id}/version`, { version: 'free' });
  data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.deepEqual([response.status, data.job.result.activeVersion, data.job.result.keyMethod, data.motion], [200, 'free', job.result.keyMethod, null]);
  assert.deepEqual(await bytes(data.job.result.keyedUrl), freeBytes);
  response = await post(`/api/animate/jobs/${id}/version`, { version: 'nope' });
  assert.deepEqual([response.status, (await response.json()).code], [400, 'no_such_version']);

  // Added as the original: the motion is the MP4, and the transparent versions stay.
  response = await post(`/api/animate/jobs/${id}/motion`, { name: 'm', version: 'original' });
  data = await response.json();
  assert.deepEqual([response.status, data.motion.mime, data.keyed, data.job.result.activeVersion, kinds(data.job)], [201, 'video/mp4', false, 'original', ['original', 'free', 'ai']]);
  const motionId = data.motion.id;
  // The motion follows the version put in use: the AI clip, without another AI call.
  response = await post(`/api/animate/jobs/${id}/version`, { version: 'ai' });
  data = await response.json();
  assert.deepEqual([response.status, data.motion.id, data.motion.mime, data.job.result.activeVersion, aiCalls], [200, motionId, 'video/webm', 'ai', 1]);
  assert.deepEqual(await bytes(`/api/media/${motionId}`), fsSync.readFileSync(file('ai.webm')));
  response = await post(`/api/animate/jobs/${id}/version`, { version: 'original' });
  data = await response.json();
  assert.deepEqual([data.motion.mime, data.job.result.activeVersion], ['video/mp4', 'original']);

  // Downloads take the version asked for.
  response = await fetch(`${base}/api/animate/jobs/${id}/result?variant=ai&download=1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') || '', /\.mov/);
  await response.arrayBuffer();
});

test('page helper: the quality of a job, as asked and as it came', () => {
  assert.equal(A.qualityText({ resolution: '720p', result: { width: 752, height: 1232 } }), '720p · 752×1232');
  assert.equal(A.qualityText({ resolution: '480p', result: null }), '480p', 'before there is a result');
  assert.equal(A.qualityText({ resolution: null, result: { width: 720, height: 1280 } }), '720×1280', 'a model without the choice');
  assert.equal(A.qualityText({}), '');
});
