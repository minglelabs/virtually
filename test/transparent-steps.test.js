'use strict';

// A photo's background (transparent already / cut out / kept) with the routes that
// change it, and a job's three steps: 1 photo -> transparent, 2 the AI generation,
// 3 result video -> transparent, of which 1 and 3 can be left out.
// Everything here runs on the server with ffmpeg: no outside service.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { execFileSync } = require('node:child_process');

const { createAppServer } = require('../server');
const A = require('../public/animate.js');
const C = require('../public/characters.js');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let skip = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { skip = 'ffmpeg is not installed'; }
const ffmpeg = args => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: 'ignore' });

test('page helpers: the photo background state, step 1 for a photo, a job\'s steps and the request flags', () => {
  assert.deepEqual([C.backgroundState({ transparent: 'own' }).state, C.backgroundState({ transparent: 'own' }).tag], ['own', '투명 배경']);
  assert.deepEqual([C.backgroundState({ transparent: 'cut' }).state, C.backgroundState({ transparent: 'cut' }).tag], ['cut', '배경 지움']);
  assert.equal(C.backgroundState({ transparent: 'no', cutoutReason: 'kept' }).canCut, true);
  assert.equal(C.backgroundState({ transparent: 'no', cutoutReason: 'not_uniform' }).canCut, false);
  assert.equal(C.transparentPath('c-1', 'ph-1'), '/api/characters/c-1/photos/ph-1/transparent');

  assert.equal(A.cutStepView({ transparent: 'own' }).needed, false);
  assert.equal(A.cutStepView({ transparent: 'cut' }).needed, true);
  assert.equal(A.cutStepView({ transparent: 'no', cutoutReason: 'kept' }).needed, true);
  assert.equal(A.cutStepView({ transparent: 'no', cutoutReason: 'not_uniform' }).needed, false);
  assert.equal(A.cutStepView(null).needed, false);

  const texts = job => A.jobSteps(job).map(step => `${step.text}/${step.kind}`);
  assert.deepEqual(A.jobSteps({ state: 'running', steps: { cut: 'done', key: true } }).map(step => step.label),
    ['① 사진 투명배경화', '② AI 동작 생성', '③ 영상 투명배경화']);
  assert.deepEqual(texts({ state: 'running', steps: { cut: 'done', key: true } }), ['완료/done', '생성 중/active', '대기/muted']);
  assert.deepEqual(texts({ state: 'keying', steps: { cut: 'own', key: true } }), ['필요 없음/done', '완료/done', '진행 중/active']);
  assert.deepEqual(texts({ state: 'succeeded', steps: { cut: 'skipped', key: false }, result: {} }), ['건너뜀/muted', '완료/done', '건너뜀/muted']);
  assert.deepEqual(texts({ state: 'succeeded', steps: { cut: 'not_plain', key: true }, result: { keyedUrl: '/k' } }), ['지울 수 없는 배경/warn', '완료/done', '완료/done']);
  assert.deepEqual(texts({ state: 'succeeded', steps: { cut: 'done', key: true }, result: {} }), ['완료/done', '완료/done', '지우지 못함/warn']);
  assert.deepEqual(texts({ state: 'failed', characterCutout: { color: '#FFFFFF' } }), ['완료/done', '실패/error', '하지 않음/muted'], 'a job from before steps were recorded');

  const base = { drivingId: 'd', photoId: 'p', route: { id: 'r', free: true }, options: {} };
  assert.deepEqual(A.jobPayload(base), { drivingId: 'd', photoId: 'p', routeId: 'r', options: {} });
  assert.deepEqual(A.jobPayload({ ...base, cutPhoto: false, keyResult: false }), { drivingId: 'd', photoId: 'p', routeId: 'r', options: {}, cutPhoto: false, keyResult: false });
  assert.match(A.keyNote({ result: { keySkipped: 'not_requested' } }), /건너뛰었습니다/);
});

test('a photo\'s background is cut out or kept on request, and a job leaves steps 1 and 3 out when asked', { skip }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-steps-'));
  const file = name => path.join(dataDir, name);
  // A red box on white (opaque), the same on a transparent canvas, a busy picture, a driving clip.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=64x96,drawbox=x=16:y=24:w=32:h=48:color=red:t=fill', '-frames:v', '1', '-pix_fmt', 'rgb24', file('white.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white@0.0:s=64x96,format=rgba,drawbox=x=16:y=24:w=32:h=48:color=red@1.0:t=fill', '-frames:v', '1', file('alpha.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x96', '-frames:v', '1', '-pix_fmt', 'rgb24', file('busy.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', file('clip.mp4')]);
  await fs.writeFile(file('no-examples.json'), JSON.stringify({ version: 1, examples: [] }));
  const server = await createAppServer({ dataDir: file('data'), examplesManifestPath: file('no-examples.json'), animateMock: true, animatePollIntervalMs: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const json = (method, pathname, body) => fetch(`${base}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const create = async (name) => {
    const response = await fetch(`${base}/api/characters?name=${name}&filename=${name}.png`, { method: 'POST', body: fsSync.readFileSync(file(`${name}.png`)) });
    assert.equal(response.status, 201);
    return (await response.json()).character;
  };

  // Uploading decides it: a plain background is cut out at once, the others are told apart.
  const white = await create('white');
  const alpha = await create('alpha');
  const busy = await create('busy');
  assert.deepEqual([white.photos[0].transparent, white.photos[0].cutoutReason], ['cut', null]);
  assert.deepEqual([alpha.photos[0].transparent, alpha.photos[0].cutoutReason], ['own', null]);
  assert.deepEqual([busy.photos[0].transparent, busy.photos[0].cutoutReason], ['no', 'not_uniform']);
  const photoId = white.basePhotoId;
  const route = `/api/characters/${white.id}/photos/${photoId}/transparent`;

  // Back to the original, and cut again (a new address, so pages show the new image).
  let response = await json('DELETE', route, {});
  assert.equal(response.status, 200);
  let photo = (await response.json()).character.photos[0];
  assert.deepEqual([photo.transparent, photo.cutoutReason, photo.displayUrl], ['no', 'kept', `/api/media/${photoId}`]);
  assert.equal((await fetch(`${base}/api/media/${photoId}?variant=cutout`)).status, 404);
  response = await json('POST', route, {});
  assert.equal(response.status, 200);
  photo = (await response.json()).character.photos[0];
  assert.equal(photo.transparent, 'cut');
  assert.match(photo.displayUrl, new RegExp(`^/api/media/${photoId}\\?variant=cutout&v=\\d+$`));
  response = await fetch(`${base}${photo.displayUrl}`);
  assert.deepEqual([response.status, response.headers.get('content-type')], [200, 'image/png']);
  await response.arrayBuffer();

  // What cannot be done says why.
  response = await json('POST', `/api/characters/${alpha.id}/photos/${alpha.basePhotoId}/transparent`, {});
  assert.deepEqual([response.status, (await response.json()).code], [409, 'already_transparent']);
  response = await json('POST', `/api/characters/${busy.id}/photos/${busy.basePhotoId}/transparent`, {});
  assert.deepEqual([response.status, (await response.json()).code], [409, 'cutout_not_plain']);

  const driving = await (await fetch(`${base}/api/animate/drivings?name=clip.mp4`, { method: 'POST', body: fsSync.readFileSync(file('clip.mp4')) })).json();
  const run = async (body) => {
    response = await json('POST', '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', ...body });
    assert.equal(response.status, 202);
    const { id } = (await response.json()).job;
    for (const deadline = Date.now() + 30000; ;) {
      const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
      if (['succeeded', 'failed', 'canceled'].includes(job.state)) return job;
      if (Date.now() > deadline) throw new Error(`stuck in ${job.state}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  // The default: all three steps.
  let job = await run({ photoId });
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.deepEqual(job.steps, { cut: 'done', key: true });
  assert.ok(job.characterCutout && job.result.keyedUrl);
  assert.deepEqual((await run({ photoId: alpha.basePhotoId })).steps, { cut: 'own', key: true });
  assert.deepEqual((await run({ photoId: busy.basePhotoId })).steps, { cut: 'not_plain', key: true });

  // Without step 1 the photo goes as it is; without step 3 the result stays an MP4 with its background.
  job = await run({ photoId, cutPhoto: false, keyResult: false });
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.deepEqual(job.steps, { cut: 'skipped', key: false });
  assert.equal(job.characterCutout, null);
  assert.deepEqual([job.result.keyedUrl, job.result.keySkipped], [null, 'not_requested']);
  response = await json('POST', `/api/animate/jobs/${job.id}/motion`, {});
  assert.equal(response.status, 201);
  const added = await response.json();
  assert.deepEqual([added.motion.mime, added.keyed], ['video/mp4', false], 'added as it is, not keyed behind the user\'s back');
  // 배경 제거하기 still does step 3 later.
  response = await json('POST', `/api/animate/jobs/${job.id}/key`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).keyed, true);
});

test('the paid AI removers run only when picked: photo and result, with their cost in the estimate', { skip }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-ai-steps-'));
  const file = name => path.join(dataDir, name);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x96', '-frames:v', '1', '-pix_fmt', 'rgb24', file('busy.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white@0.0:s=64x96,format=rgba,drawbox=x=16:y=24:w=32:h=48:color=red@1.0:t=fill', '-frames:v', '1', file('cut.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', file('clip.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red@1.0:s=64x96:rate=15,format=rgba', '-t', '1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', file('alpha.webm')]);
  await fs.writeFile(file('no-examples.json'), JSON.stringify({ version: 1, examples: [] }));
  // A fake remover: counts its calls and answers with ready-made transparent files.
  const calls = { image: 0, video: 0 };
  let videoFails = false;
  const backgroundAi = {
    available: () => true,
    image: async (src, dest) => { calls.image += 1; await fs.copyFile(file('cut.png'), dest); },
    video: async (src, dest) => { calls.video += 1; if (videoFails) throw new Error('no luck'); await fs.copyFile(file('alpha.webm'), dest); },
    videoUsd: seconds => A.aiVideoUsd(seconds, { videoUsdPerSecond: 0.01, videoMinSeconds: 3 }),
    view: () => ({ available: true, imageUsd: 0.01, videoUsdPerSecond: 0.01, videoMinSeconds: 3 }),
  };
  const server = await createAppServer({
    dataDir: file('data'), examplesManifestPath: file('no-examples.json'), animateMock: true, animatePollIntervalMs: 40, animate: { backgroundAi },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const json = (method, pathname, body) => fetch(`${base}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.deepEqual((await (await fetch(`${base}/api/animate/status`)).json()).backgroundAi, { available: true, imageUsd: 0.01, videoUsdPerSecond: 0.01, videoMinSeconds: 3 });

  let response = await fetch(`${base}/api/characters?name=busy&filename=busy.png`, { method: 'POST', body: fsSync.readFileSync(file('busy.png')) });
  const character = (await response.json()).character;
  const photoId = character.basePhotoId;
  assert.equal(character.photos[0].transparent, 'no');
  const driving = await (await fetch(`${base}/api/animate/drivings?name=clip.mp4`, { method: 'POST', body: fsSync.readFileSync(file('clip.mp4')) })).json();
  const run = async (body) => {
    response = await json('POST', '/api/animate/jobs', { drivingId: driving.id, routeId: 'mock/local-demo', photoId, ...body });
    assert.equal(response.status, 202);
    const { id } = (await response.json()).job;
    for (const deadline = Date.now() + 30000; ;) {
      const job = await (await fetch(`${base}/api/animate/jobs/${id}`)).json();
      if (['succeeded', 'failed', 'canceled'].includes(job.state)) return job;
      if (Date.now() > deadline) throw new Error(`stuck in ${job.state}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  // Nothing is called by default.
  let job = await run({});
  assert.deepEqual(job.steps, { cut: 'not_plain', key: true });
  assert.deepEqual(calls, { image: 0, video: 0 });
  const plainEstimate = job.estimate.usd || 0;

  // Picked for both steps: the photo is cut once and kept, the result comes back transparent.
  job = await run({ cutPhoto: 'ai', keyResult: 'ai' });
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.deepEqual(job.steps, { cut: 'done', key: true, cutMethod: 'ai', keyMethod: 'ai' });
  assert.deepEqual(calls, { image: 1, video: 1 });
  assert.deepEqual([job.result.keyMethod, job.result.keyAiFailed, Boolean(job.result.keyedUrl)], ['ai', false, true]);
  assert.equal(Number((job.estimate.usd - plainEstimate).toFixed(4)), 0.04, '$0.01 for the photo + 3 s of video at $0.01');
  let photo = (await (await fetch(`${base}/api/characters`)).json()).characters[0].photos[0];
  assert.deepEqual([photo.transparent, photo.cutoutMethod], ['cut', 'ai']);

  // The photo's AI cutout is reused; a failing video remover falls back to the free key.
  videoFails = true;
  job = await run({ cutPhoto: 'ai', keyResult: 'ai' });
  assert.deepEqual(calls, { image: 1, video: 2 });
  assert.equal(job.state, 'succeeded');
  assert.equal(job.result.keyAiFailed, true);
  assert.equal(Number((job.estimate.usd - plainEstimate).toFixed(4)), 0.03, 'the photo was not paid for again');
  videoFails = false;

  // The buttons: the photo again on request, a result by 'AI로 배경 제거'.
  response = await json('POST', `/api/characters/${character.id}/photos/${photoId}/transparent`, { method: 'ai' });
  assert.equal(response.status, 200);
  assert.equal(calls.image, 2);
  response = await json('POST', `/api/animate/jobs/${job.id}/key`, { method: 'ai' });
  assert.equal((await response.json()).job.result.keyMethod, 'ai');
  assert.equal(calls.video, 3);
  response = await json('POST', `/api/animate/jobs/${job.id}/key`, {});
  assert.equal(calls.video, 3, 'the plain 배경 제거하기 never calls the paid remover');
});

test('AI step helpers: what it adds to the price and how the request names it', () => {
  const ai = { available: true, imageUsd: 0.01, videoUsdPerSecond: 0.01, videoMinSeconds: 3 };
  assert.equal(A.aiVideoUsd(2, ai), 0.03);
  assert.equal(A.aiVideoUsd(5.2, ai), 0.06);
  assert.equal(A.aiVideoUsd(5, null), null);
  const photo = { transparent: 'no', cutoutReason: 'not_uniform', cutoutMethod: null };
  assert.equal(A.stepsExtraUsd({ photo, cutAi: true, keyAi: true, seconds: 5, ai }), 0.06);
  assert.equal(A.stepsExtraUsd({ photo: { ...photo, transparent: 'cut', cutoutMethod: 'ai' }, cutAi: true, keyAi: false, seconds: 5, ai }), 0);
  assert.equal(A.stepsExtraUsd({ photo, cutAi: false, keyAi: false, seconds: 5, ai }), 0);
  assert.equal(A.cutStepView(photo).needed, false, 'the free cut cannot do this photo');
  assert.equal(A.cutStepView(photo, { ai: true }).needed, true, 'the AI one can');
  const base = { drivingId: 'd', photoId: 'p', route: { id: 'r', free: true }, options: {} };
  assert.deepEqual(A.jobPayload({ ...base, cutPhoto: 'ai', keyResult: 'ai' }), { drivingId: 'd', photoId: 'p', routeId: 'r', options: {}, cutPhoto: 'ai', keyResult: 'ai' });
  assert.deepEqual(A.jobSteps({ state: 'succeeded', steps: { cut: 'done', cutMethod: 'ai', key: true, keyMethod: 'ai' }, result: { keyedUrl: '/k', keyMethod: 'ai' } }).map(step => step.text),
    ['완료 (AI)', '완료', '완료 (AI)']);
});
