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
  assert.deepEqual(decider.status(), {
    configured: true, provider: 'openai',
    providers: [{ id: 'openai', label: 'GPT-6 Luna (fast)', configured: true }, { id: 'clef', label: 'Clef-flash', configured: false }, { id: 'jev', label: 'Jev', configured: false }],
    wanted: 'auto', model: 'gpt-6-luna', reasoning: 'none', tier: 'priority', driver: null, decisionsNote: null,
  });
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
      assert.deepEqual(body.response_format.json_schema.schema.properties.labels.items.enum, [IDLE_LABEL, '원영턴', '인사']);
      assert.equal(body.reasoning_effort, 'none');
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
  assert.doesNotMatch(D.noteText(base), /크레딧/, 'the price is on the button');
  assert.equal(D.buttonPrice({ price: { perMinute: 8, blockMinutes: 1 } }), '1분 8크레딧');
  assert.equal(D.buttonPrice({}), '');
  assert.match(D.noteText({ ...base, enabled: true, stt: { configured: false } }), /SONIOX_API_KEY/);
  // On, but no page holds the microphone (permission refused, or not connected yet).
  assert.match(D.noteText({ ...base, enabled: true, listening: true }), /^말을 듣는 중입니다/);
  assert.match(D.noteText({ ...base, enabled: true, listening: false }), /^아직 마이크가 연결되지 않아/);
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
  assert.deepEqual(await response.json(), { apiKey: 'temp:abc', model: 'stt-rt-v5', url: 'wss://stt-rt.soniox.com/transcribe-websocket', terms: ['turn', 'a'] });
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

test('director: one price for the picks and the speech-to-text, 8 credits a minute charged ahead', async () => {
  const charges = [];
  let broke = false;
  let clock = 1000000;
  const director = createDirector({
    decider: { status: () => ({ configured: true }) }, getView: () => null, play: () => 1, stop: () => {},
    stt: { configured: true }, now: () => clock,
    charge: async (credits, minutes) => {
      if (broke) throw Object.assign(new Error('Not enough credits.'), { code: 'insufficient_credits' });
      charges.push([credits, minutes]);
    },
  });
  assert.deepEqual(director.state().price, { perMinute: 8, blockMinutes: 1 });
  assert.equal(D.priceText(director.state()), '켜 둔 동안 1분에 8 크레딧(음성 인식 포함)이 1분 단위로 차감됩니다.');
  assert.equal(director.micHold('tab-1'), 'off', 'no microphone while it is off');
  await director.setEnabled(true);
  assert.deepEqual(charges, [[8, 1]], 'the first minute is charged when it is switched on');
  // The microphone changes nothing in the price: one page listens, a second waits.
  assert.equal(director.micHold('tab-1'), 'ok');
  assert.equal(director.micHold('tab-2'), 'elsewhere');
  assert.equal(director.state().listening, true);
  clock += 20000;
  assert.equal(director.micRelease('tab-2'), false);
  assert.equal(director.micRelease('tab-1'), true);
  assert.equal(director.state().listening, false);
  await director.setEnabled(false);
  assert.deepEqual(charges, [[8, 1]], 'switching off charges nothing more');
  // A page that goes silent loses the microphone after the lease.
  await director.setEnabled(true);
  assert.equal(director.micHold('tab-1'), 'ok');
  clock += MIC_LEASE_MS + 1;
  assert.equal(director.micHold('tab-2'), 'ok', 'the silent page lost it');
  await director.setEnabled(false);
  assert.equal(MIC_LEASE_MS, 30000);
  broke = true;
  await assert.rejects(director.setEnabled(true), { code: 'insufficient_credits' });
  assert.equal(director.state().enabled, false);
  director.close();

  // Without speech-to-text the page says only the price.
  const quiet = createDirector({
    decider: { status: () => ({ configured: true }) }, getView: () => null, play: () => 1, stop: () => {},
  });
  assert.equal(D.priceText(quiet.state()), '켜 둔 동안 1분에 8 크레딧이 1분 단위로 차감됩니다.');
  quiet.close();
});

test('live events: a reconnect that hears another deployment reloads the page once', () => {
  const M = require('../public/motions.js');
  let reloads = 0;
  const reload = () => { reloads += 1; };
  const build = id => ({ data: JSON.stringify({ type: 'build', id }) });
  assert.equal(M.noteBuild({ data: '{"type":"library"}' }, reload), false, 'other messages pass through');
  assert.equal(M.noteBuild(build('deploy-1'), reload), true);
  assert.equal(M.noteBuild(build('deploy-1'), reload), true);
  assert.equal(reloads, 0, 'the same deployment after a drop');
  M.noteBuild(build('deploy-2'), reload);
  assert.equal(reloads, 1);
});

test('decider: Chat Completions asks for no reasoning, drops the setting when refused, and returns every pick in order', async () => {
  const bodies = [];
  const logs = [];
  const decider = createDecider({
    env: { OPENAI_API_KEY: 'k', DIRECTOR_DRIVER: 'chat' },
    log: line => logs.push(line),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.reasoning_effort) return jsonResponse(400, { error: { message: "Unsupported value: 'reasoning_effort' does not support 'none'." } });
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ labels: ['인사', '원영턴'] }) } }] });
    },
  });
  let answer = await decider.decide({ instructions: 'pick', input: '인사하고 돌아', options: OPTIONS });
  assert.deepEqual([answer.labels, answer.label], [['인사', '원영턴'], '인사']);
  assert.deepEqual(bodies.map(body => body.reasoning_effort), ['none', undefined]);
  assert.equal(logs.length, 1);
  answer = await decider.decide({ instructions: 'pick', input: 'again', options: OPTIONS });
  assert.equal(bodies.length, 3, 'the refused setting is not sent again');
  assert.equal(decider.status().reasoning, null);

  const nothing = createDecider({
    env: { OPENAI_API_KEY: 'k', DIRECTOR_DRIVER: 'chat' },
    fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: '{"labels":[]}' } }] }),
  });
  assert.deepEqual((await nothing.decide({ instructions: '', input: '', options: OPTIONS })).labels, []);
});

test('director: several motions said in one breath all queue, in order; words are asked about at once', async () => {
  const motions = [{ id: 'm-a', name: '인사' }, { id: 'm-b', name: '박수' }, { id: 'm-c', name: '원영턴' }, { id: 'm-d', name: '하트' }];
  const asked = [];
  const played = [];
  const answers = [['인사', '박수', IDLE_LABEL, '원영턴', '박수', '하트'], []];
  let seq = 0;
  const director = createDirector({
    decider: {
      status: () => ({ configured: true }),
      decide: async (request) => { asked.push(request); const labels = answers.shift() ?? []; return { labels, label: labels[0] ?? null, driver: 'chat', ms: 5 }; },
    },
    getView: () => ({ photo: { id: 'ph-1' }, motions }),
    play: (motion) => { played.push(motion.name); seq += 1; return seq; },
    stop: () => {},
    tickMs: 3600 * 1000,
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await director.setEnabled(true);
  director.speech('인사하고 박수 치고 한 바퀴 돌고 하트');
  await settle();
  assert.equal(asked.length, 1, 'no tick was needed');
  let state = director.state();
  assert.deepEqual([state.current.name, state.queue.map(item => item.name)], ['인사', ['박수', '원영턴', '하트']]);
  assert.equal(state.last.label, '인사, 박수, 원영턴, 하트');
  for (const name of ['박수', '원영턴', '하트']) {
    director.done(seq);
    assert.equal(director.state().current.name, name);
  }
  director.speech('그냥 하는 말');
  await settle();
  assert.equal(director.state().last.label, IDLE_LABEL);
  assert.deepEqual(played, ['인사', '박수', '원영턴', '하트']);
  director.close();
});

test('decider: Jev is asked again until it picks nothing; the streamer can switch', async () => {
  const calls = [];
  const picks = ['o2', 'o1', 'o0'];
  const decider = createDecider({
    env: { TYPESAFE_API_KEY: 'ts-secret-key-1234' },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, auth: init.headers.Authorization, body });
      if (url.includes('typesafe')) return jsonResponse(200, { model: 'jev-1.13.0', answers: { pick: { type: 'choice', choice: picks.shift(), confidence: 0.9 } }, usage: { input_tokens: 200, output_tokens: 0 } });
      return jsonResponse(200, { label: '인사' });
    },
  });
  assert.equal(decider.status().provider, 'jev');
  const answer = await decider.decide({ instructions: 'pick', input: '인사하고 돌아', options: OPTIONS, none: IDLE_LABEL });
  assert.deepEqual([answer.labels, answer.driver, answer.usage.input], [['인사', '원영턴'], 'jev', 400]);
  assert.equal(calls.length, 2, 'nothing is left to pick: no third call');
  assert.deepEqual([calls[0].url, calls[0].auth, calls[0].body.model], ['https://api.typesafe.ai/v1/systemone', 'Bearer ts-secret-key-1234', 'jev-latest']);
  assert.deepEqual(Object.keys(calls[0].body.questions.pick.criteria), ['o0', 'o1', 'o2']);
  assert.deepEqual(Object.keys(calls[1].body.questions.pick.criteria), ['o0', 'o1'], 'what was picked is not offered again');
  assert.match(calls[1].body.state, /\[이번에 이미 고른 동작\]\n인사/);

  picks.splice(0, picks.length, 'o1', 'o0');
  const one = await decider.decide({ instructions: 'pick', input: '돌아', options: OPTIONS, none: IDLE_LABEL });
  assert.deepEqual([one.labels, calls.length], [['원영턴'], 4], 'it stops when the answer is nothing');

  assert.throws(() => decider.setProvider('openai'), { code: 'not_configured' });
  assert.throws(() => decider.setProvider('other'), { status: 400 });
  const only = createDecider({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: async () => jsonResponse(500, {}) });
  assert.throws(() => only.setProvider('jev'), { code: 'not_configured' });
  const failing = createDecider({ env: { TYPESAFE_API_KEY: 'ts-secret-key-1234' }, fetchImpl: async () => jsonResponse(401, { error: { message: 'bad key ts-secret-key-1234' } }) });
  await assert.rejects(failing.decide({ instructions: '', input: '', options: OPTIONS }), error => !error.message.includes('secret'));
});

test('decider: GPT-6 Luna is the default and asks in fast mode; Clef-flash goes to Workers AI; a likely motion beats a winning nothing', async () => {
  const calls = [];
  const logs = [];
  const decider = createDecider({
    env: { OPENAI_API_KEY: 'k', DIRECTOR_DRIVER: 'chat', TYPESAFE_API_KEY: 't', CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_API_TOKEN: 'cf-token' },
    log: line => logs.push(line),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, auth: init.headers.Authorization, body });
      if (url.includes('openai')) {
        if (body.service_tier) return jsonResponse(400, { error: { message: "Invalid service_tier 'priority' for this project." } });
        return jsonResponse(200, { service_tier: 'default', choices: [{ message: { content: '{"labels":["인사"]}' } }] });
      }
      // 대기 wins with 0.5, but 원영턴 has 0.4 (>= 0.3): the motion is taken; the next call says nothing.
      const first = calls.filter(call => call.url.includes('cloudflare')).length === 1;
      return jsonResponse(200, { success: true, result: { answers: { pick: { type: 'choice', choice: 'o0', probabilities: first ? { o0: 0.5, o1: 0.4, o2: 0.1 } : { o0: 0.95, o2: 0.05 } } }, usage: { input_tokens: 100 } } });
    },
  });
  assert.deepEqual([decider.status().provider, decider.status().tier], ['openai', 'priority']);
  let answer = await decider.decide({ instructions: 'pick', input: '안녕', options: OPTIONS, none: IDLE_LABEL });
  assert.deepEqual([answer.labels, answer.driver, answer.tier], [['인사'], 'chat', 'default']);
  assert.deepEqual(calls.map(call => [call.body.service_tier, call.body.reasoning_effort]), [['priority', 'none'], [undefined, 'none']]);
  assert.equal(decider.status().tier, null);
  assert.equal(logs.length, 1);

  decider.setProvider('clef');
  calls.length = 0;
  answer = await decider.decide({ instructions: 'pick', input: '돌아 볼까', options: OPTIONS, none: IDLE_LABEL });
  assert.deepEqual([answer.labels, answer.driver, answer.probabilities], [['원영턴'], 'clef', { [IDLE_LABEL]: 0.5, 원영턴: 0.4, 인사: 0.1 }]);
  assert.deepEqual([calls[0].url, calls[0].auth, calls[0].body.model], ['https://api.cloudflare.com/client/v4/accounts/acc1/ai/run/@cf/cloudflare/clef-flash', 'Bearer cf-token', 'clef-flash']);
  assert.equal(calls.length, 2);
  const noAccount = createDecider({ env: { CLOUDFLARE_API_TOKEN: 'x' }, fetchImpl: async () => jsonResponse(500, {}) });
  assert.equal(noAccount.status().providers.find(entry => entry.id === 'clef').configured, false);
});
