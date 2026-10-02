'use strict';

// The AI director of one workspace: listens to what the streamer says (final
// speech-to-text lines posted by the controller), asks the decider once a second
// which motion of the photo on air fits the new words, and plays the picks one after
// another from a queue the streamer can see and edit.
//
//   speech(text)  a line that was just said.
//   tick          every TICK_MS while on: when there are words the AI has not seen yet
//                 and no question is in flight, ask. It goes on asking while a motion
//                 plays; the answers queue up. Most answers are 기본 대기 동작 (nothing).
//   queue         FIFO. The head plays when nothing is playing; the overlay reports the
//                 end (done(seq)), with a timer from the clip's length as the fallback.
//                 A motion already playing or waiting is not queued again.
//   remove / clear / skip   drop one waiting motion, all of them, or stop the playing
//                 one and go on to the next.
// Nothing is stored: a restart turns it off and empties the queue.

const crypto = require('node:crypto');

const TICK_MS = 1000;
const WINDOW_MS = 30 * 1000; // how much speech the AI is given
const MAX_QUEUE = 8;
const MAX_LINE = 400;
const FALLBACK_MS = 20 * 1000; // a motion whose length is unknown and whose end nobody reports
const END_SLACK_MS = 3000;
const IDLE_LABEL = '기본 대기 동작';

const INSTRUCTIONS = [
  '버튜버가 방송에서 방금 한 말을 듣고, 캐릭터가 지금 할 동작을 하나 고릅니다.',
  '[새 대사]에 딱 맞는 동작이 있을 때만 그 동작을 고르세요. 이전 대사는 맥락을 위한 참고입니다.',
  `대부분의 말에는 특별한 동작이 필요 없습니다. 그럴 때는 반드시 '${IDLE_LABEL}'을 고르세요.`,
  '[이미 고른 동작]에 있는 동작을 같은 말 때문에 다시 고르지 마세요.',
].join(' ');

function createDirector({
  decider,
  // () => { motions: [{ id, name }], photo } : the library view (the on-air photo's motions).
  getView,
  // (motion) => seq : start it on the overlay.
  play,
  // () => void : back to the idle (stops the playing motion).
  stop,
  // async (motion) => seconds | null
  durationOf = async () => null,
  // (state) => void : tell the pages.
  onChange = () => {},
  stt = { configured: false },
  now = Date.now,
  tickMs = TICK_MS,
  log = () => {},
}) {
  let enabled = false;
  let timer = null;
  let asking = false;
  let lines = []; // { at, text }
  let askedUntil = 0; // lines up to this time have been shown to the AI as new
  let queue = []; // { id, motionId, name, at }
  let current = null; // { id, motionId, name, at, seq, startedAt }
  let endTimer = null;
  let recent = []; // what was picked lately: { name, at }
  let last = null; // { label, driver, ms, at }
  let error = null;
  let asked = 0;

  const seconds = ms => Math.max(0, Math.round(ms / 1000));

  function state() {
    const view = getView();
    return {
      enabled,
      ai: decider.status(),
      stt: { configured: stt.configured === true },
      onAir: Boolean(view && view.photo),
      motions: view && view.photo ? view.motions.length : 0,
      lines: lines.slice(-4).map(line => line.text),
      queue: queue.map(item => ({ id: item.id, name: item.name })),
      current: current ? { id: current.id, name: current.name } : null,
      last,
      asked,
      error,
    };
  }

  const changed = () => onChange(state());

  function finishCurrent() {
    clearTimeout(endTimer);
    endTimer = null;
    current = null;
  }

  // Start the head of the queue when nothing plays.
  function pump() {
    if (current || !queue.length) return;
    const view = getView();
    while (queue.length && !current) {
      const item = queue.shift();
      const motion = view && view.photo ? view.motions.find(entry => entry.id === item.motionId) : null;
      if (!motion) continue; // deleted, or the photo went off air
      current = { ...item, seq: play(motion), startedAt: now() };
      const playing = current;
      endTimer = setTimeout(() => done(playing.seq), FALLBACK_MS);
      if (endTimer.unref) endTimer.unref();
      durationOf(motion).then(length => {
        if (current !== playing || !Number.isFinite(length) || length <= 0) return;
        clearTimeout(endTimer);
        endTimer = setTimeout(() => done(playing.seq), Math.max(0, length * 1000 + END_SLACK_MS - (now() - playing.startedAt)));
        if (endTimer.unref) endTimer.unref();
      }).catch(() => {});
    }
  }

  // The overlay finished the motion it was told to play with `seq` (or the fallback timer fired).
  function done(seq) {
    if (!current || current.seq !== seq) return false;
    finishCurrent();
    pump();
    changed();
    return true;
  }

  async function ask() {
    const view = getView();
    const motions = view && view.photo ? view.motions.filter(motion => motion && motion.name && motion.name !== IDLE_LABEL) : [];
    const fresh = lines.filter(line => line.at > askedUntil);
    if (!fresh.length || !motions.length) return;
    const at = now();
    const earlier = lines.filter(line => line.at <= askedUntil);
    const byLabel = new Map();
    for (const motion of motions) if (!byLabel.has(motion.name)) byLabel.set(motion.name, motion);
    const picked = [
      ...(current ? [`${current.name} (지금 하는 중)`] : []),
      ...queue.map(item => `${item.name} (대기 중)`),
      ...recent.filter(item => at - item.at < WINDOW_MS).map(item => `${item.name} (${seconds(at - item.at)}초 전)`),
    ];
    const input = [
      `[이전 대사]\n${earlier.map(line => line.text).join('\n') || '(없음)'}`,
      `[새 대사]\n${fresh.map(line => line.text).join('\n')}`,
      `[이미 고른 동작]\n${picked.join('\n') || '(없음)'}`,
    ].join('\n\n');
    askedUntil = fresh[fresh.length - 1].at;
    asking = true;
    try {
      const answer = await decider.decide({
        instructions: INSTRUCTIONS,
        input,
        options: [{ label: IDLE_LABEL, description: '특별한 동작 없이 가만히 있기' }, ...[...byLabel.keys()].map(label => ({ label }))],
      });
      asked += 1;
      error = null;
      last = { label: answer.label, driver: answer.driver, ms: answer.ms, at: now() };
      const motion = byLabel.get(answer.label);
      if (enabled && motion && queue.length < MAX_QUEUE
        && !(current && current.motionId === motion.id) && !queue.some(item => item.motionId === motion.id)) {
        queue.push({ id: crypto.randomUUID(), motionId: motion.id, name: motion.name, at: now() });
        recent = [...recent.filter(item => now() - item.at < WINDOW_MS), { name: motion.name, at: now() }];
        pump();
      }
    } catch (failure) {
      if (error !== failure.message) log(`[director] ${failure.message}`);
      error = failure.message;
    } finally {
      asking = false;
      changed();
    }
  }

  function tick() {
    const cutoff = now() - WINDOW_MS;
    if (lines.length && lines[0].at < cutoff) lines = lines.filter(line => line.at >= cutoff);
    if (!enabled || asking) return;
    ask().catch(() => {});
  }

  function setEnabled(value) {
    if (enabled === Boolean(value)) return state();
    enabled = Boolean(value);
    clearInterval(timer);
    timer = null;
    if (enabled) {
      error = null;
      lines = [];
      askedUntil = 0;
      timer = setInterval(tick, tickMs);
      if (timer.unref) timer.unref();
    } else {
      queue = [];
      lines = [];
    }
    changed();
    return state();
  }

  // A line the streamer just said (ignored while off).
  function speech(text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
    if (!enabled || !clean) return false;
    // Strictly increasing times, so "new since the last question" is never ambiguous.
    const at = Math.max(now(), lines.length ? lines[lines.length - 1].at + 1 : 0);
    lines.push({ at, text: clean });
    changed();
    return true;
  }

  function remove(id) {
    const before = queue.length;
    queue = queue.filter(item => item.id !== id);
    if (queue.length === before) return false;
    changed();
    return true;
  }

  function clear() {
    queue = [];
    changed();
  }

  // Stop what plays now and go on to the next motion in the queue.
  function skip() {
    if (current) {
      finishCurrent();
      if (!queue.length) stop();
    }
    pump();
    changed();
  }

  function close() {
    clearInterval(timer);
    clearTimeout(endTimer);
    timer = null;
    enabled = false;
  }

  return { state, setEnabled, speech, done, remove, clear, skip, tick, close };
}

module.exports = { createDirector, IDLE_LABEL, TICK_MS, WINDOW_MS, MAX_QUEUE };
