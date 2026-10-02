'use strict';

// Picks one answer from a closed list: which motion fits what the streamer just said.
//
// Drivers (DIRECTOR_DRIVER, default `auto`):
//   decisions  OpenAI's Decisions API, POST /v1/decisions (GPT-6 Luna tuned for one fast
//              pick). PROVISIONAL: it is a limited preview without a published reference,
//              so the body below ({ model, input, instructions, options: [{ label,
//              description }] }) is inferred and the answer is parsed leniently
//              (label | decision | answer | choice, bare or under `output`).
//   chat       Chat Completions with a JSON schema whose only field is an enum of the
//              labels: works with any OpenAI key.
//   auto       decisions first; when the API refuses the request (not enabled for the
//              account, or the inferred body is wrong) it falls back to chat and tries
//              decisions again after RETRY_DECISIONS_MS.
// The key is OPENAI_API_KEY; it is never logged or sent anywhere but the API.

const DEFAULT_MODEL = 'gpt-6-luna';
const DEFAULT_BASE = 'https://api.openai.com';
const TIMEOUT_MS = 5000;
const RETRY_DECISIONS_MS = 10 * 60 * 1000;

function safeMessage(text) {
  return String(text || '').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…').slice(0, 200);
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
  let decisionsOffUntil = 0; // auto: when to try the Decisions API again
  let decisionsNote = null; // why it is off (the API's own words)
  let lastDriver = null;

  async function post(pathname, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${pathname}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw deciderError(error.name === 'TimeoutError' ? 'The AI did not answer in time.' : `Could not reach the AI: ${error.message}`, { retryable: true });
    }
    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) {
      const message = data && data.error && typeof data.error.message === 'string' ? data.error.message : `HTTP ${response.status}`;
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
    return { label, usage: usageOf(data) };
  }

  async function viaChat({ instructions, input, options }) {
    const data = await post('/v1/chat/completions', {
      model,
      messages: [
        { role: 'system', content: `${instructions}\n\n선택지:\n${options.map(option => `- ${option.label}${option.description ? `: ${option.description}` : ''}`).join('\n')}` },
        { role: 'user', content: input },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'decision', strict: true,
          schema: { type: 'object', properties: { label: { type: 'string', enum: options.map(option => option.label) } }, required: ['label'], additionalProperties: false },
        },
      },
    });
    let label = null;
    try { label = JSON.parse(data.choices[0].message.content).label; } catch { /* below */ }
    if (typeof label !== 'string') throw deciderError('The model answer had no label.', { status: 422 });
    return { label, usage: usageOf(data) };
  }

  // -> { label (one of options' labels), driver, ms, usage: { input, output } }
  async function decide(request) {
    if (!apiKey) throw deciderError('OPENAI_API_KEY is not set.', { code: 'not_configured' });
    const started = now();
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
    if (!request.options.some(option => option.label === answer.label)) throw deciderError('The AI picked an answer that was not offered.', { status: 422 });
    lastDriver = driver;
    return { ...answer, driver, ms: now() - started };
  }

  function status() {
    return {
      configured: Boolean(apiKey),
      wanted,
      model,
      // What the last answer came from (null before the first one).
      driver: lastDriver,
      decisionsNote,
    };
  }

  return { decide, status };
}

module.exports = { createDecider, parseDecision, DEFAULT_MODEL };
