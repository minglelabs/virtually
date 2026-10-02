'use strict';

// The AI director: the decider (OpenAI Decisions API with a Chat Completions
// fallback), the queue (lib/director) and its routes. No network: fetch is faked.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { execFileSync } = require('node:child_process');

const { createDecider, parseDecision } = require('../lib/director/decider');
const { createDirector, IDLE_LABEL, MIC_LEASE_MS } = require('../lib/director');
const { createAppServer } = require('../server');
const D = require('../public/director.js');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let skip = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { skip = 'ffmpeg is not installed'; }

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const OPTIONS = [{ label: IDLE_LABEL, description: '가만히' }, { label: '원영턴' }, { label: '인사' }];

test('decider: the Decisions API body and lenient answers', async () => {
  const calls = [];
  const decider = createDecider({
    env: { OPENAI_API_KEY: 'sk-test-secret-key' },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return jsonResponse(200, { object: 'decision', decision: '원영턴', usage: { input_tokens: 120, output_tokens: 1 } });
    },
  });
  assert.deepEqual(decider.status(), { configured: true, wanted: 'auto', model: 'gpt-6-luna', driver: null, decisionsNote: null });
  const answer = await decider.decide({ instructions: 'pick', input: 'hello', options: OPTIONS });
  assert.equal(answer.label, '원영턴');
  assert.equal(answer.driver, 'decisions');
  assert.deepEqual(answer.usage, { input: 120, output: 1 });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(calls[0].auth, 'Bearer sk-test-secret-key');
  assert.deepEqual(calls[0].body, {
    model: 'gpt-6-luna', input: 'hello', instructions: 'pick',
    options: [{ label: IDLE_LABEL, description: '가만히' }, { label: '원영턴' }, { label: '인사' }],
  });
  assert.equal(parseDecision({ output: { label: 'a' } }), 'a');
  assert.equal(parseDecision({ choice: { label: 'b' } }), 'b');
  assert.equal(parseDecision({ answer: 'c' }), 'c');
  assert.equal(parseDecision({ text: 'nope' }), null);
});

test('decider: a refused Decisions API falls back to Chat Completions and stays there; errors never carry the key', async () => {
  const urls = [];
  const decider = createDecider({
    env: { OPENAI_API_KEY: 'sk-test-secret-key' },
    fetchImpl: async (url, init) => {
      urls.push(url.replace('https://api.openai.com', ''));
      if (url.endsWith('/v1/decisions')) return jsonResponse(403, { error: { message: 'Decision API is not enabled for this user.' } });
      const body = JSON.parse(init.body);
      assert.deepEqual(body.response_format.json_schema.schema.properties.label.enum, [IDLE_LABEL, '원영턴', '인사']);
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ label: IDLE_LABEL }) } }], usage: { prompt_tokens: 300, completion_tokens: 8 } });
    },
  });
  let answer = await decider.decide({ instructions: 'pick', input: 'hello', options: OPTIONS });
  assert.deepEqual([answer.label, answer.driver], [IDLE_LABEL, 'chat']);
  answer = await decider.decide({ instructions: 'pick', input: 'again', options: OPTIONS });
  assert.deepEqual(urls, ['/v1/decisions', '/v1/chat/completions', '/v1/chat/completions'], 'the refused API is not asked again at once');
  assert.match(decider.status().decisionsNote, /403: Decision API is not enabled/);
  assert.equal(decider.status().driver, 'chat');

  const none = createDecider({ env: {} });
  await assert.rejects(none.decide({ instructions: '', input: '', options: OPTIONS }), { code: 'not_configured' });
  const failing = createDecider({
    env: { OPENAI_API_KEY: 'sk-test-secret-key', DIRECTOR_DRIVER: 'chat' },
    fetchImpl: async () => jsonResponse(401, { error: { message: 'Incorrect API key provided: sk-test-secret-key' } }),
  });
  await assert.rejects(failing.decide({ instructions: '', input: '', options: OPTIONS }), error => !error.message.includes('secret'));
  const stray = createDecider({ env: { OPENAI_API_KEY: 'k', DIRECTOR_DRIVER: 'decisions' }, fetchImpl: async () => jsonResponse(200, { label: '없는 동작' }) });
  await assert.rejects(stray.decide({ instructions: '', input: '', options: OPTIONS }), /not offered/);
});

// A director on fakes: answers come from `answers` in order; ticks are run by hand.
function fakeDirector({ answers, motions = [{ id: 'm-turn', name: '원영턴' }, { id: 'm-hi', name: '인사' }] }) {
  const asked = [];
  const played = [];
  const log = { stops: 0, changes: 0 };
  let seq = 0;
  let clock = 1000;
  const view = { photo: { id: 'ph-1' }, motions };
  const director = createDirector({
    decider: {
      status: () => ({ configured: true }),
      decide: async (request) => {
        asked.push(request);
        return { label: answers.shift() ?? IDLE_LABEL, driver: 'decisions', ms: 5 };
      },
    },
    getView: () => view,
    play: (motion) => { played.push(motion.name); seq += 1; return seq; },
    stop: () => { log.stops += 1; },
    onChange: () => { log.changes += 1; },
    now: () => clock,
    tickMs: 3600 * 1000,
  });
  const tick = async (ms = 1000) => {
    clock += ms;
    director.tick();
    await new Promise(resolve => setImmediate(resolve));
  };
  return { director, asked, played, log, view, tick, seq: () => seq };
}

test('director: asks only about new words, queues the picks, plays them one after another', async () => {
  const { director, asked, played, tick, seq } = fakeDirector({ answers: [IDLE_LABEL, '원영턴', '인사', '원영턴'] });
  assert.equal(director.speech('꺼져 있을 때 한 말'), false, 'off: nothing is heard');
  await director.setEnabled(true);
  await tick();
  assert.equal(asked.length, 0, 'nothing said: nothing asked');

  director.speech('안녕하세요 여러분');
  await tick();
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].options.map(option => option.label), [IDLE_LABEL, '원영턴', '인사']);
  assert.match(asked[0].input, /\[새 대사\]\n안녕하세요 여러분/);
  assert.deepEqual(played, [], 'the usual answer is the idle: no motion');
  await tick();
  assert.equal(asked.length, 1, 'the same words are not asked about twice');

  director.speech('한 바퀴 돌아 볼게요');
  await tick();
  assert.deepEqual(played, ['원영턴']);
  assert.equal(director.state().current.name, '원영턴');
  assert.match(asked[1].input, /\[이전 대사\]\n안녕하세요 여러분/);

  // While it plays, the questions go on and the answers wait in the queue.
  director.speech('다들 반가워요');
  await tick();
  director.speech('한 번 더 돌까');
  await tick();
  assert.match(asked[3].input, /원영턴 \(지금 하는 중\)\n인사 \(대기 중\)/);
  assert.deepEqual(played, ['원영턴'], 'the next one waits for the end');
  assert.deepEqual(director.state().queue.map(item => item.name), ['인사'], 'a motion that is playing is not queued again');

  assert.equal(director.done(999), false, 'another motion ending changes nothing');
  assert.equal(director.done(seq()), true);
  assert.deepEqual(played, ['원영턴', '인사']);
  assert.deepEqual(director.state().queue, []);
  director.done(seq());
  assert.equal(director.state().current, null);
  director.close();
});

test('director: remove one, clear all, skip to the next, and off empties the queue', async () => {
  const motions = ['a', 'b', 'c', 'd'].map(name => ({ id: `m-${name}`, name }));
  const { director, played, log, tick } = fakeDirector({ answers: ['a', 'b', 'c', 'd', 'b'], motions });
  await director.setEnabled(true);
  for (const word of ['1', '2', '3', '4']) {
    director.speech(word);
    await tick();
  }
  assert.equal(director.state().current.name, 'a');
  assert.deepEqual(director.state().queue.map(item => item.name), ['b', 'c', 'd']);

  const c = director.state().queue[1];
  assert.equal(director.remove(c.id), true);
  assert.equal(director.remove(c.id), false);
  assert.deepEqual(director.state().queue.map(item => item.name), ['b', 'd']);

  director.skip();
  assert.deepEqual(played, ['a', 'b'], 'skip starts the next motion at once');
  assert.equal(log.stops, 0, 'the next play replaces the motion on the overlay');
  director.clear();
  assert.deepEqual(director.state().queue, []);
  director.skip();
  assert.equal(director.state().current, null);
  assert.equal(log.stops, 1, 'nothing waiting: back to the idle');

  director.speech('5');
  await tick();
  assert.equal(director.state().current.name, 'b');
  await director.setEnabled(false);
  assert.deepEqual([director.state().enabled, director.state().queue.length, director.state().lines.length], [false, 0, 0]);
  assert.equal(director.state().current.name, 'b', 'the motion that plays is left to finish');
  director.close();
});

test('controller helpers: the hint, the last pick, the queue rows and Soniox tokens', () => {
  const base = { enabled: false, ai: { configured: true }, stt: { configured: true }, onAir: true, motions: 2, queue: [], current: null, last: null, asked: 0, error: null };
  assert.match(D.noteText({ ...base, ai: { configured: false } }), /OPENAI_API_KEY/);
  assert.match(D.noteText({ ...base, onAir: false }), /방송할 캐릭터를 먼저/);
  assert.match(D.noteText({ ...base, motions: 0 }), /등록된 동작이 없습니다/);
  assert.match(D.noteText(base), /^켜면 마이크로/);
  assert.match(D.noteText({ ...base, enabled: true, stt: { configured: false } }), /SONIOX_API_KEY/);
  assert.equal(D.lastText({ ...base, enabled: true, asked: 3, last: { label: IDLE_LABEL, driver: 'decisions', ms: 140 } }), '방금 판단: 동작 없음(대기) · 140ms · Decisions API · 누적 3회');
  assert.match(D.lastText({ ...base, ai: { configured: true, decisionsNote: '403' }, asked: 1, last: { label: '원영턴', driver: 'chat', ms: 900 } }), /'원영턴' · 900ms · 일반 호출 \(Decisions API 사용 불가\)/);
  assert.equal(D.lastText({ ...base, error: '401: bad key' }), 'AI 오류: 401: bad key');
  assert.deepEqual(D.queueRows({ current: { id: '1', name: 'a' }, queue: [{ id: '2', name: 'b' }] }),
    [{ id: '1', name: 'a', current: true }, { id: '2', name: 'b', current: false }]);
  assert.deepEqual(D.readTokens({ tokens: [{ text: '안녕', is_final: true }, { text: '하세', is_final: false }, { text: '<end>', is_final: true }] }),
    { final: '안녕', interim: '하세', ended: true });
});

test('routes: switch, speech, the queue and the overlay\'s done; the speech-to-text key', { skip }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-director-'));
  const png = path.join(dataDir, 'character.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x96', '-frames:v', '1', png]);
  const sonioxCalls = [];
  const server = await createAppServer({
    dataDir, examplesManifestPath: path.join(dataDir, 'no-examples.json'), animateMock: true,
    director: {
      env: { OPENAI_API_KEY: 'k', SONIOX_API_KEY: 'soniox-secret' },
      tickMs: 25,
      fetchImpl: async (url, init) => {
        if (url.includes('soniox')) {
          sonioxCalls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
          return jsonResponse(201, { api_key: 'temp:abc', expires_at: '2026-10-02T00:05:00Z' });
        }
        const body = JSON.parse(init.body);
        return jsonResponse(200, { label: /돌/.test(body.input.split('[새 대사]')[1].split('[이미')[0]) ? 'turn' : IDLE_LABEL });
      },
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const send = (method, pathname, body) => fetch(`${base}${pathname}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const stateNow = async () => (await send('GET', '/api/director')).json();
  const until = async (check) => {
    for (let i = 0; i < 80; i += 1) {
      const state = await stateNow();
      if (check(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`timed out: ${JSON.stringify(await stateNow())}`);
  };

  let state = await stateNow();
  assert.deepEqual([state.enabled, state.ai.configured, state.stt.configured, state.onAir], [false, true, true, false]);

  let response = await fetch(`${base}/api/characters?name=a&filename=character.png`, { method: 'POST', body: fsSync.readFileSync(png) });
  const photoId = (await response.json()).character.basePhotoId;
  await send('PUT', '/api/active-photo', { photoId });
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
  const motion = await (await fetch(`${base}/api/upload?kind=motion&name=turn.webm`, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: webm })).json();

  assert.equal((await send('POST', '/api/director', { enabled: 'yes' })).status, 400);
  state = await (await send('POST', '/api/director', { enabled: true })).json();
  assert.deepEqual([state.enabled, state.onAir, state.motions], [true, true, 1]);

  // The overlay hears 'play' for the picked motion and reports its end.
  const stream = await fetch(`${base}/api/events`);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const nextPlay = async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split('\n\n')) {
        if (!block.startsWith('data: ')) continue;
        try {
          const message = JSON.parse(block.slice(6));
          if (message.type === 'play') return message;
        } catch { /* a partial block */ }
      }
    }
  };
  await send('POST', '/api/director/speech', { text: '오늘 날씨 좋네요' });
  state = await until(now => now.asked === 1);
  assert.deepEqual([state.last.label, state.current], [IDLE_LABEL, null]);
  await send('POST', '/api/director/speech', { text: '한 바퀴 돌아 볼게요' });
  const play = await nextPlay();
  assert.equal(play.id, motion.id);
  state = await until(now => now.current !== null);
  assert.equal(state.current.name, 'turn');
  assert.deepEqual(await (await send('POST', '/api/director/done', { seq: play.seq + 100 })).json(), { ok: false });
  assert.deepEqual(await (await send('POST', '/api/director/done', { seq: play.seq })).json(), { ok: true });
  assert.equal((await stateNow()).current, null);

  assert.equal((await send('DELETE', '/api/director/queue/nope')).status, 404);
  assert.equal((await send('DELETE', '/api/director/queue')).status, 200);
  assert.equal((await send('POST', '/api/director/skip', {})).status, 200);

  // The browser gets a short-lived Soniox key; the real key stays on the server.
  response = await send('POST', '/api/director/stt-key', { tab: 'tab-1' });
  assert.deepEqual(await response.json(), { apiKey: 'temp:abc', model: 'stt-rt-v5', url: 'wss://stt-rt.soniox.com/transcribe-websocket' });
  assert.equal((await stateNow()).listening, true);
  // One page listens at a time: a second tab gets no key, the first keeps the microphone.
  response = await send('POST', '/api/director/stt-key', { tab: 'tab-2' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'mic_elsewhere');
  assert.deepEqual(await (await send('POST', '/api/director/mic', { tab: 'tab-2', on: true })).json(), { ok: false });
  assert.deepEqual(await (await send('POST', '/api/director/mic', { tab: 'tab-1', on: true })).json(), { ok: true });
  // The first one stops: the second can take over.
  await send('POST', '/api/director/mic', { tab: 'tab-1', on: false });
  assert.equal((await stateNow()).listening, false);
  assert.equal((await send('POST', '/api/director/stt-key', { tab: 'tab-2' })).status, 200);
  assert.deepEqual(sonioxCalls.slice(0, 1), [{
    url: 'https://api.soniox.com/v1/auth/temporary-api-key', auth: 'Bearer soniox-secret',
    body: { usage_type: 'transcribe_websocket', expires_in_seconds: 300 },
  }]);

  state = await (await send('POST', '/api/director', { enabled: false })).json();
  assert.equal(state.enabled, false);
  // No key (and no speech-to-text charge) while it is off.
  response = await send('POST', '/api/director/stt-key', { tab: 'tab-1' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'director_off');
});

test('director: the picks are charged a minute ahead, the speech-to-text only for the time a microphone listened', async () => {
  const charges = [];
  let broke = false;
  let clock = 1000000;
  const director = createDirector({
    decider: { status: () => ({ configured: true }) }, getView: () => null, play: () => 1, stop: () => {},
    stt: { configured: true }, now: () => clock, billBlockMs: 40,
    charge: async (credits, minutes) => {
      if (broke) throw Object.assign(new Error('Not enough credits.'), { code: 'insufficient_credits' });
      charges.push(credits);
    },
  });
  // Unit: a "block" of 40 ms is charged as an hour's 1/90000, so move the clock by hours instead.
  assert.equal(director.micHold('tab-1'), 'off', 'no microphone while it is off');
  await director.setEnabled(true);
  assert.deepEqual(charges, [], 'a fraction of a credit waits for a later block');
  assert.equal(director.micHold('tab-1'), 'ok');
  assert.equal(director.micHold('tab-2'), 'elsewhere');
  assert.equal(director.state().listening, true);
  // 20 seconds of listening, then the page stops: 240 an hour is 1.33 credits.
  clock += 20000;
  assert.equal(director.micRelease('tab-2'), false);
  assert.equal(director.micRelease('tab-1'), true);
  assert.equal(director.state().listening, false);
  clock += 3600000; // a long time without a microphone costs no speech-to-text
  await director.setEnabled(false);
  assert.deepEqual(charges, [1]);
  // A page that goes silent loses the microphone after the lease: only the lease is charged.
  charges.length = 0;
  await director.setEnabled(true);
  assert.equal(director.micHold('tab-1'), 'ok');
  clock += 3600000;
  assert.equal(director.micHold('tab-2'), 'ok', 'the silent page lost it');
  director.micRelease('tab-2');
  await director.setEnabled(false);
  assert.equal(MIC_LEASE_MS, 30000);
  assert.deepEqual(charges, [2], '30 seconds of 240 an hour');
  broke = true;
  director.close();

  // A real block: one minute of 250 credits an hour is 4.17, charged as 4 when it is switched on.
  const real = [];
  const plain = createDirector({
    decider: { status: () => ({ configured: true }) }, getView: () => null, play: () => 1, stop: () => {},
    stt: { configured: true },
    charge: async (credits, minutes) => {
      if (broke) throw Object.assign(new Error('Not enough credits.'), { code: 'insufficient_credits' });
      real.push([credits, minutes]);
    },
  });
  assert.deepEqual(plain.state().price, { decisionPerHour: 250, sttPerHour: 240, blockMinutes: 1 });
  assert.equal(D.priceText(plain.state()), '켜 둔 동안 시간당 약 250 크레딧, 마이크로 듣는 동안은 240 크레딧이 더 듭니다. 1분 단위로 차감됩니다.');
  broke = false;
  await plain.setEnabled(true);
  assert.deepEqual(real, [[4, 1]], 'the first block is charged when it is switched on');
  await plain.setEnabled(false);
  broke = true;
  await assert.rejects(plain.setEnabled(true), { code: 'insufficient_credits' });
  assert.equal(plain.state().enabled, false);
  plain.close();

  // Without speech-to-text the page says only the picks.
  const quiet = createDirector({
    decider: { status: () => ({ configured: true }) }, getView: () => null, play: () => 1, stop: () => {},
  });
  assert.equal(D.priceText(quiet.state()), '켜 둔 동안 시간당 약 250 크레딧. 1분 단위로 차감됩니다.');
  quiet.close();
});
