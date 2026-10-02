'use strict';

// 자동 반응 on the controller: one switch for the whole broadcast. While it is on,
// the microphone is transcribed (Soniox, straight from this browser with a
// short-lived key from the server) and every finished phrase goes to the server,
// whose AI director (lib/director) picks motions and plays them from a queue.
// This card shows what was heard, the last pick and the queue, and edits the queue.
// All names are user data: textContent only.

// DOM-free helpers, exported for node tests.
const DirectorHelpers = (() => {
  const IDLE_LABEL = '기본 대기 동작';

  /** The hint under the title: why it cannot work yet, or what it does. */
  function noteText(state) {
    if (!state) return '';
    if (!state.ai?.configured) return 'AI 설정(OPENAI_API_KEY)이 서버에 없어 켤 수 없습니다.';
    if (!state.onAir) return '방송할 캐릭터를 먼저 골라 주세요. 자동 반응은 방송 중인 캐릭터의 동작으로 움직입니다.';
    if (!state.motions) return '이 캐릭터에 등록된 동작이 없습니다. 동작 관리에서 동작을 먼저 넣어 주세요.';
    // The price is on the 켜기 button (buttonPrice).
    if (!state.enabled) return '켜면 마이크로 말을 듣고, 말에 어울리는 동작을 캐릭터가 알아서 합니다.';
    // `listening`: a page holds the microphone right now (lib/director micHold).
    const heard = state.listening
      ? '말을 듣는 중입니다. 동작 버튼은 그대로 직접 누를 수 있습니다.'
      : '아직 마이크가 연결되지 않아 말을 듣지 않고 있습니다. 브라우저에서 마이크 권한을 허용했는지 확인해 주세요. 아래에 대사를 입력해 시험할 수 있습니다.';
    return `${state.stt?.configured
      ? heard
      : '음성 인식 설정(SONIOX_API_KEY)이 없어 마이크는 듣지 않습니다. 아래에 대사를 입력해 시험할 수 있습니다.'} ${priceText(state)}`.trim();
  }

  /** '켜 둔 동안 1분에 8 크레딧(음성 인식 포함)이 1분 단위로 차감됩니다.'; '' without a price. */
  function priceText(state) {
    const price = state && state.price;
    if (!price || !Number.isFinite(price.perMinute)) return '';
    const stt = state.stt?.configured ? '(음성 인식 포함)' : '';
    return `켜 둔 동안 1분에 ${price.perMinute.toLocaleString('ko-KR')} 크레딧${stt}이 ${price.blockMinutes}분 단위로 차감됩니다.`;
  }

  /** '1분 8크레딧' on the 켜기 button; '' without a price. */
  function buttonPrice(state) {
    const price = state && state.price;
    return price && Number.isFinite(price.perMinute) ? `1분 ${price.perMinute.toLocaleString('ko-KR')}크레딧` : '';
  }

  /** The line under the queue: the AI's last pick, or its error. */
  function lastText(state) {
    if (!state) return '';
    if (state.error) return `AI 오류: ${state.error}`;
    const last = state.last;
    if (!last) return state.enabled ? '아직 판단한 적이 없습니다' : '';
    const how = last.driver === 'decisions' ? 'Decisions API' : `일반 호출${state.ai?.decisionsNote ? ' (Decisions API 사용 불가)' : ''}`;
    const picked = last.label === IDLE_LABEL ? '동작 없음(대기)' : `'${last.label}'`;
    return `방금 판단: ${picked} · ${Number.isFinite(last.ms) ? `${last.ms}ms · ` : ''}${how} · 누적 ${state.asked}회`;
  }

  /** The queue rows: the playing motion first, then the waiting ones. */
  function queueRows(state) {
    const rows = [];
    if (state?.current) rows.push({ id: state.current.id, name: state.current.name, current: true });
    for (const item of Array.isArray(state?.queue) ? state.queue : []) rows.push({ id: item.id, name: item.name, current: false });
    return rows;
  }

  /**
   * Finished words out of one Soniox message: { final, interim, ended }. `<end>`
   * (endpoint detection) marks the end of a phrase and is not text.
   */
  function readTokens(message) {
    let final = '';
    let interim = '';
    let ended = false;
    for (const token of Array.isArray(message?.tokens) ? message.tokens : []) {
      const text = typeof token?.text === 'string' ? token.text : '';
      if (text === '<end>') { ended = true; continue; }
      if (token.is_final) final += text;
      else interim += text;
    }
    return { final, interim, ended };
  }

  return { IDLE_LABEL, noteText, priceText, buttonPrice, lastText, queueRows, readTokens };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DirectorHelpers;

if (typeof document !== 'undefined') (() => {
  const H = DirectorHelpers;
  const $ = id => document.getElementById(id);
  const card = $('directorCard');
  const toggle = $('directorToggle');
  const badge = $('directorBadge');
  const note = $('directorNote');
  const body = $('directorBody');
  const heard = $('directorHeard');
  const sayForm = $('directorSay');
  const sayText = $('directorText');
  const skipBtn = $('directorSkip');
  const clearBtn = $('directorClear');
  const queueList = $('directorQueue');
  const lastLine = $('directorLast');
  const status = $('directorStatus');

  let state = null;
  let busy = false;
  let loaded = false; // the first state has arrived

  function setStatus(text, kind) {
    status.textContent = text || '';
    if (kind) status.dataset.kind = kind;
    else delete status.dataset.kind;
  }

  async function call(method, path, json) {
    const response = await fetch(path, {
      method,
      headers: json === undefined ? {} : { 'Content-Type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    let data = null;
    try { data = await response.json(); } catch { /* empty */ }
    // Not enough credits reads the same on every page.
    const lack = data && data.code === 'insufficient_credits' && data.detail
      ? `크레딧이 부족합니다 (필요 ${Number(data.detail.needed).toLocaleString('ko-KR')}, 보유 ${Number(data.detail.balance).toLocaleString('ko-KR')})` : '';
    if (!response.ok) throw Object.assign(new Error(lack || (data && data.error) || `HTTP ${response.status}`), { code: data && data.code });
    return data;
  }

  // ---- Microphone -> Soniox -> POST /api/director/speech ----
  const mic = { stream: null, recorder: null, socket: null, pending: '', interim: '', flushTimer: null, beatTimer: null, wanted: false, retry: null };
  // One page listens at a time (two would send every phrase twice): the server knows this one by `tab`.
  const tab = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);

  function showHeard() {
    const lines = state && Array.isArray(state.lines) ? state.lines : [];
    const said = document.createElement('span');
    said.textContent = [lines[lines.length - 1] || '', mic.pending].filter(Boolean).join(' ');
    const interim = document.createElement('span');
    interim.className = 'interim';
    interim.textContent = mic.interim ? ` ${mic.interim}` : '';
    heard.replaceChildren(said, interim);
    if (!said.textContent && !mic.interim) heard.textContent = mic.socket ? '(말을 기다리는 중)' : '';
  }

  function flushSpeech() {
    const text = mic.pending.trim();
    mic.pending = '';
    if (text) call('POST', '/api/director/speech', { text }).catch(() => {});
  }

  function stopMic() {
    mic.wanted = false;
    clearTimeout(mic.retry);
    clearInterval(mic.flushTimer);
    mic.flushTimer = null;
    clearInterval(mic.beatTimer);
    mic.beatTimer = null;
    if (mic.recorder && mic.recorder.state !== 'inactive') mic.recorder.stop();
    mic.recorder = null;
    // The listened time is charged: tell the server this page stopped.
    if (mic.socket) fetch('/api/director/mic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab, on: false }), keepalive: true }).catch(() => {});
    if (mic.socket) { try { mic.socket.close(); } catch { /* closed */ } }
    mic.socket = null;
    if (mic.stream) for (const track of mic.stream.getTracks()) track.stop();
    mic.stream = null;
    mic.pending = '';
    mic.interim = '';
    badge.hidden = true;
  }

  async function startMic() {
    mic.wanted = true;
    if (!state?.stt?.configured) return;
    if (!navigator.mediaDevices || typeof MediaRecorder !== 'function') {
      setStatus('이 브라우저에서는 마이크를 쓸 수 없습니다. 대사를 직접 입력해 주세요.', 'error');
      return;
    }
    try {
      if (!mic.stream) mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setStatus('마이크 권한이 없어 말을 듣지 못합니다. 브라우저에서 마이크를 허용해 주세요.', 'error');
      return;
    }
    let key;
    try {
      key = await call('POST', '/api/director/stt-key', { tab });
    } catch (error) {
      if (error.code === 'mic_elsewhere') {
        // The other page may close: try again quietly.
        setStatus('다른 탭(창)에서 이미 말을 듣고 있어 이 탭에서는 듣지 않습니다.');
        clearTimeout(mic.retry);
        mic.retry = setTimeout(() => { if (mic.wanted && !mic.socket) startMic(); }, 10000);
      } else if (error.code !== 'director_off') {
        setStatus(`음성 인식 연결 실패: ${error.message}`, 'error');
      }
      return;
    }
    if (!mic.wanted) return stopMic();
    const socket = new WebSocket(key.url);
    mic.socket = socket;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        api_key: key.apiKey, model: key.model, audio_format: 'auto', language_hints: ['ko'], enable_endpoint_detection: true,
      }));
      const recorder = new MediaRecorder(mic.stream);
      mic.recorder = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(event.data);
      });
      recorder.start(250);
      // The AI is asked once a second: hand over what was finished since the last time.
      mic.flushTimer = setInterval(flushSpeech, 1000);
      // Keep the microphone (and its charge) on this page; losing it stops listening here.
      mic.beatTimer = setInterval(() => {
        call('POST', '/api/director/mic', { tab, on: true }).then((data) => { if (data && data.ok === false) socket.close(); }).catch(() => {});
      }, 10000);
      badge.hidden = false;
      setStatus('');
      showHeard();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.error_code) {
        setStatus(`음성 인식 오류: ${message.error_message || message.error_code}`, 'error');
        return;
      }
      const tokens = H.readTokens(message);
      mic.pending += tokens.final;
      mic.interim = tokens.interim;
      if (tokens.ended) flushSpeech();
      showHeard();
    });
    socket.addEventListener('close', () => {
      if (mic.socket !== socket) return;
      clearInterval(mic.flushTimer);
      clearInterval(mic.beatTimer);
      if (mic.recorder && mic.recorder.state !== 'inactive') mic.recorder.stop();
      mic.recorder = null;
      mic.socket = null;
      badge.hidden = true;
      fetch('/api/director/mic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab, on: false }), keepalive: true }).catch(() => {});
      // A dropped or timed-out session is opened again while the switch is on.
      if (mic.wanted) mic.retry = setTimeout(() => { if (mic.wanted) startMic(); }, 2000);
    });
  }

  // ---- Render ----
  function render() {
    const on = Boolean(state?.enabled);
    const ready = Boolean(state?.ai?.configured);
    card.classList.toggle('is-on', on);
    const price = on ? '' : H.buttonPrice(state);
    toggle.replaceChildren(document.createTextNode(on ? '끄기' : '켜기'));
    if (price) {
      const tag = document.createElement('span');
      tag.className = 'director-price';
      tag.textContent = price;
      toggle.append(tag);
    }
    toggle.setAttribute('aria-pressed', String(on));
    toggle.disabled = busy || !state || (!on && !ready);
    note.textContent = H.noteText(state);
    body.hidden = !on;
    const rows = H.queueRows(state);
    skipBtn.disabled = !state?.current;
    clearBtn.disabled = !(state?.queue?.length > 0);
    queueList.replaceChildren(...(rows.length ? rows.map((row) => {
      const li = document.createElement('li');
      if (row.current) li.className = 'is-current';
      const name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = row.name;
      const tag = document.createElement('span');
      tag.className = 'queue-tag';
      tag.textContent = row.current ? '지금 하는 중' : '대기';
      li.append(name, tag);
      if (!row.current) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = '대기열에서 빼기';
        remove.setAttribute('aria-label', `${row.name} 대기열에서 빼기`);
        remove.addEventListener('click', () => act('DELETE', `/api/director/queue/${encodeURIComponent(row.id)}`));
        li.append(remove);
      }
      return li;
    }) : [Object.assign(document.createElement('li'), { className: 'is-empty', textContent: '대기 중인 동작이 없습니다' })]));
    lastLine.textContent = H.lastText(state);
    showHeard();
  }

  function apply(next) {
    if (!next || typeof next !== 'object') return;
    const wasOn = Boolean(state?.enabled);
    state = next;
    render();
    // Another tab or a server restart turned it off: stop listening here too.
    if (wasOn && !state.enabled) stopMic();
    // The page was reloaded while it was on: listen again.
    if (!loaded && state.enabled) startMic();
    loaded = true;
  }

  async function act(method, path, json) {
    setStatus('');
    try {
      apply(await call(method, path, json));
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  toggle.addEventListener('click', async () => {
    if (busy || !state) return;
    busy = true;
    render();
    const turnOn = !state.enabled;
    await act('POST', '/api/director', { enabled: turnOn });
    busy = false;
    render();
    if (turnOn && state.enabled) startMic();
    else stopMic();
  });

  sayForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = sayText.value.trim();
    if (!text) return;
    sayText.value = '';
    call('POST', '/api/director/speech', { text }).catch(error => setStatus(error.message, 'error'));
  });
  skipBtn.addEventListener('click', () => act('POST', '/api/director/skip', {}));
  clearBtn.addEventListener('click', () => act('DELETE', '/api/director/queue'));

  // Live state: the 'director' message on /api/events, and once at load (and on reconnect).
  const load = () => call('GET', '/api/director').then(apply).catch(() => {});
  window.VirtuallyMotions.liveEvents('/api/events', { open: load, message: (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === 'director') apply(data.state);
    // The character on air (and so the motions) changed: the hint depends on it.
    else if (data?.type === 'library') load();
  } });
  window.addEventListener('pagehide', stopMic);
  load();
})();
