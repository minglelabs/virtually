'use strict';

// Picks one answer from a closed list: which motion fits what the streamer just said.
//
// Two providers; the streamer picks one on the 방송 화면 (setProvider). Until then it is
// Jev when its key is set, else OpenAI.
//   jev        TypeSafe's Jev (POST /v1/systemone, key TYPESAFE_API_KEY): one `choice`
//              question whose criteria are the options. It picks ONE option per call,
//              so when the request names the "nothing" option (`none`) it is asked
//              again without the options already picked, until it answers `none`
//              (at most MAX_ROUNDS calls): several motions said in one breath.
//   openai     the drivers below (key OPENAI_API_KEY).
//
// OpenAI drivers (DIRECTOR_DRIVER, default `auto`):
//   decisions  OpenAI's Decisions API, POST /v1/decisions (GPT-6 Luna tuned for one fast
//              pick). PROVISIONAL: it is a limited preview without a published reference,
//              so the body below ({ model, input, instructions, options: [{ label,
//              description }] }) is inferred and the answer is parsed leniently
//              (label | decision | answer | choice, bare or under `output`).
//   chat       Chat Completions with a JSON schema whose only field is a list of the
//              labels (several motions said in one breath come back together, in the
//              order they were said): works with any OpenAI key. It asks for no
//              reasoning (DIRECTOR_REASONING, default `none`), which is what makes it
//              fast; a model that refuses the setting is asked without it from then on.
//   auto       decisions first; when the API refuses the request (not enabled for the
//              account, or the inferred body is wrong) it falls back to chat and tries
//              decisions again after RETRY_DECISIONS_MS.
// The keys are never logged or sent anywhere but their own API.

const DEFAULT_MODEL = 'gpt-6-luna';
const DEFAULT_BASE = 'https://api.openai.com';
const TIMEOUT_MS = 5000;
const RETRY_DECISIONS_MS = 10 * 60 * 1000;
const JEV_BASE = 'https://api.typesafe.ai';
const JEV_MODEL = 'jev-latest';
const MAX_ROUNDS = 6;
const PROVIDERS = [{ id: 'jev', label: 'Jev' }, { id: 'openai', label: 'GPT-6 Luna' }];

function safeMessage(text) {
  return String(text || '').replace(/(sk|ts)-[A-Za-z0-9_-]{8,}/g, '$1-…').slice(0, 200);
}

function deciderError(message, extra = {}) {
  return Object.assign(new Error(safeMessage(message)), extra);
}

// The picked label of a Decisions answer, or null.
function parseDecision(body) {
  for (const source of [body, body && body.output, body && Array.isArray(body.output) ? body.output[0] : null]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['label', 'decision', 'answer', 'choice']) {
      const value = source[key];
      if (typeof value === 'string' && value) return value;
      if (value && typeof value === 'object' && typeof value.label === 'string') return value.label;
    }
  }
  return null;
}

function usageOf(body) {
  const usage = body && typeof body.usage === 'object' && body.usage ? body.usage : {};
  const input = Number(usage.input_tokens ?? usage.prompt_tokens);
  const output = Number(usage.output_tokens ?? usage.completion_tokens);
  return { input: Number.isFinite(input) ? input : null, output: Number.isFinite(output) ? output : null };
}

function createDecider({ env = process.env, fetchImpl = (...args) => fetch(...args), now = Date.now, log = () => {} } = {}) {
  const apiKey = env.OPENAI_API_KEY || '';
  const wanted = ['auto', 'decisions', 'chat'].includes(env.DIRECTOR_DRIVER) ? env.DIRECTOR_DRIVER : 'auto';
  const model = env.DIRECTOR_MODEL || DEFAULT_MODEL;
  const base = String(env.OPENAI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  let reasoning = env.DIRECTOR_REASONING === 'default' ? null : (env.DIRECTOR_REASONING || 'none');
  let decisionsOffUntil = 0; // auto: when to try the Decisions API again
  let decisionsNote = null; // why it is off (the API's own words)
  let lastDriver = null;
  const jevKey = env.TYPESAFE_API_KEY || env.JEV_API_KEY || '';
  const jevBase = String(env.TYPESAFE_BASE_URL || JEV_BASE).replace(/\/+$/, '');
  const jevModel = env.JEV_MODEL || JEV_MODEL;
  const keys = { jev: jevKey, openai: apiKey };
  let chosen = null; // what the streamer picked; null: Jev when it has a key, else OpenAI

  const provider = () => chosen || (jevKey || !apiKey ? 'jev' : 'openai');

  function setProvider(id) {
    if (!PROVIDERS.some(entry => entry.id === id)) throw deciderError('No such AI.', { status: 400, code: 'bad_request' });
    if (!keys[id]) throw deciderError('That AI has no key on the server.', { status: 409, code: 'not_configured' });
    chosen = id;
  }

  async function post(pathname, body, { root = base, key = apiKey } = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}${pathname}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw deciderError(error.name === 'TimeoutError' ? 'The AI did not answer in time.' : `Could not reach the AI: ${error.message}`, { retryable: true });
    }
    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) {
      const failure = data && (data.error ?? data.message ?? data.detail);
      const message = failure && typeof failure.message === 'string' ? failure.message : typeof failure === 'string' ? failure : `HTTP ${response.status}`;
      throw deciderError(`${response.status}: ${message}`, { status: response.status });
    }
    return data;
  }

  async function viaDecisions({ instructions, input, options }) {
    const data = await post('/v1/decisions', {
      model, input, instructions,
      options: options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
    });
    const label = parseDecision(data);
    if (!label) throw deciderError('The Decisions API answer had no label.', { status: 422 });
    return { labels: [label], usage: usageOf(data) };
  }

  async function viaChat({ instructions, input, options }) {
    const body = {
      model,
      messages: [
        { role: 'system', content: `${instructions}\n\n선택지:\n${options.map(option => `- ${option.label}${option.description ? `: ${option.description}` : ''}`).join('\n')}` },
        { role: 'user', content: input },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'decision', strict: true,
          schema: {
            type: 'object',
            properties: { labels: { type: 'array', items: { type: 'string', enum: options.map(option => option.label) } } },
            required: ['labels'], additionalProperties: false,
          },
        },
      },
    };
    let data;
    try {
      data = await post('/v1/chat/completions', reasoning ? { ...body, reasoning_effort: reasoning } : body);
    } catch (error) {
      // The model does not take this reasoning setting: ask without it, now and later.
      if (!(reasoning && error.status === 400 && /reasoning/i.test(error.message))) throw error;
      log(`[director] ${model} refused reasoning_effort=${reasoning} (${error.message}); asking without it`);
      reasoning = null;
      data = await post('/v1/chat/completions', body);
    }
    let labels = null;
    try {
      const parsed = JSON.parse(data.choices[0].message.content);
      labels = Array.isArray(parsed.labels) ? parsed.labels : typeof parsed.label === 'string' ? [parsed.label] : null;
    } catch { /* below */ }
    if (!labels || labels.some(label => typeof label !== 'string')) throw deciderError('The model answer had no labels.', { status: 422 });
    return { labels, usage: usageOf(data) };
  }

  // Jev answers one `choice` per call: ask again without what it picked, until it picks `none`.
  async function viaJev({ instructions, input, options, none }) {
    const ids = new Map(options.map((option, index) => [`o${index}`, option]));
    const labels = [];
    const usage = { input: 0, output: 0 };
    for (let round = 0; round < (none ? MAX_ROUNDS : 1); round += 1) {
      const left = [...ids].filter(([, option]) => !labels.includes(option.label));
      if (left.length < 2) break;
      const data = await post('/v1/systemone', {
        model: jevModel,
        state: labels.length ? `${input}\n\n[이번에 이미 고른 동작]\n${labels.join('\n')}` : input,
        questions: {
          pick: {
            type: 'choice',
            instructions: `${instructions} 한 번에 하나만 고릅니다. 아직 고르지 않은 동작 중 가장 먼저 말한 것을 고르고, 더 고를 것이 없으면 '${none || options[0].label}'을 고르세요.`.slice(0, 2000),
            criteria: Object.fromEntries(left.map(([id, option]) => [id, option.description ? `${option.label}: ${option.description}` : `'${option.label}' 동작`])),
          },
        },
      }, { root: jevBase, key: jevKey });
      const answer = data && data.answers && data.answers.pick;
      const option = answer && ids.get(answer.choice);
      if (!option) throw deciderError('The Jev answer had no choice.', { status: 422 });
      const used = usageOf(data);
      usage.input += used.input || 0;
      usage.output += used.output || 0;
      if (!none) return { labels: [option.label], usage };
      if (option.label === none) break;
      labels.push(option.label);
    }
    return { labels, usage };
  }

  // -> { labels (each one of options' labels, in order; may be empty), label (the first, or null),
  //      driver, ms, usage: { input, output } }
  async function decide(request) {
    const started = now();
    if (provider() === 'jev') {
      if (!jevKey) throw deciderError('TYPESAFE_API_KEY is not set.', { code: 'not_configured' });
      const answer = await viaJev(request);
      lastDriver = 'jev';
      return { ...answer, label: answer.labels[0] ?? null, driver: 'jev', ms: now() - started };
    }
    if (!apiKey) throw deciderError('OPENAI_API_KEY is not set.', { code: 'not_configured' });
    const useDecisions = wanted === 'decisions' || (wanted === 'auto' && now() >= decisionsOffUntil);
    let answer;
    let driver = useDecisions ? 'decisions' : 'chat';
    try {
      answer = await (useDecisions ? viaDecisions(request) : viaChat(request));
    } catch (error) {
      // auto: a refusal of the preview API (4xx other than a rate limit) means chat from now on.
      if (!(wanted === 'auto' && useDecisions && error.status && error.status !== 429 && error.status < 500)) throw error;
      decisionsOffUntil = now() + RETRY_DECISIONS_MS;
      if (decisionsNote !== error.message) log(`[director] the Decisions API refused (${error.message}); using Chat Completions with ${model}`);
      decisionsNote = error.message;
      driver = 'chat';
      answer = await viaChat(request);
    }
    if (driver === 'decisions') decisionsNote = null;
    if (answer.labels.some(label => !request.options.some(option => option.label === label))) throw deciderError('The AI picked an answer that was not offered.', { status: 422 });
    lastDriver = driver;
    return { ...answer, label: answer.labels[0] ?? null, driver, ms: now() - started };
  }

  function status() {
    return {
      configured: Boolean(keys[provider()]),
      // Which AI answers, and the ones the streamer can pick.
      provider: provider(),
      providers: PROVIDERS.map(entry => ({ ...entry, configured: Boolean(keys[entry.id]) })),
      wanted,
      model: provider() === 'jev' ? jevModel : model,
      reasoning,
      // What the last answer came from (null before the first one).
      driver: lastDriver,
      decisionsNote,
    };
  }

  return { decide, status, setProvider };
}

module.exports = { createDecider, parseDecision, DEFAULT_MODEL, MAX_ROUNDS };
