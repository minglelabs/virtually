'use strict';

// 영상 관리: the videos an account keeps (lib/videos.js), and a small editor for them.
// The editor's timeline is a row of pieces, each a span of one video. A piece can be split
// at the playhead, copied, cut, pasted, dragged to another place and deleted, and other
// videos can be put after it. 저장 sends the pieces to POST /api/videos/render, which writes
// them as ONE new video; the videos they were cut from stay as they are.
// All names are user data: textContent only.

// DOM-free helpers, exported for node tests.
const VideoEditHelpers = (() => {
  // The shortest piece a split may leave.
  const MIN_PIECE = 0.1;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const round3 = value => Math.round(value * 1000) / 1000;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /** How long a piece lasts, in seconds. */
  const lengthOf = clip => Math.max(0, clip.end - clip.start);
  /** How long the timeline lasts. */
  const totalOf = clips => round3(clips.reduce((sum, clip) => sum + lengthOf(clip), 0));
  /** Where each piece begins on the timeline. */
  function startsOf(clips) {
    const starts = [];
    let at = 0;
    for (const clip of clips) {
      starts.push(round3(at));
      at += lengthOf(clip);
    }
    return starts;
  }

  /** A video as one whole piece. */
  function pieceOf(video, key) {
    return { key, video: video.id, start: 0, end: round3(finite(video.duration) && video.duration > 0 ? video.duration : 0) };
  }

  /**
   * The piece under the timeline time `time`: { index, at (where the piece begins), source
   * (the time inside its video) }, or null on an empty timeline. A time on a border belongs
   * to the piece that begins there; the very end belongs to the last piece.
   */
  function locate(clips, time) {
    if (!clips.length) return null;
    const starts = startsOf(clips);
    const t = clamp(finite(time) ? time : 0, 0, totalOf(clips));
    let index = clips.length - 1;
    for (let i = 0; i < clips.length; i += 1) {
      if (t < starts[i] + lengthOf(clips[i]) - 1e-6) {
        index = i;
        break;
      }
    }
    const offset = clamp(t - starts[index], 0, lengthOf(clips[index]));
    return { index, at: starts[index], source: round3(clips[index].start + offset) };
  }

  /**
   * The timeline with the piece under `time` cut in two there (the second half gets `key`).
   * The same list when the cut would leave a piece shorter than MIN_PIECE.
   */
  function split(clips, time, key) {
    const here = locate(clips, time);
    if (!here) return clips;
    const clip = clips[here.index];
    if (here.source - clip.start < MIN_PIECE || clip.end - here.source < MIN_PIECE) return clips;
    const next = [...clips];
    next.splice(here.index, 1, { ...clip, end: here.source }, { ...clip, key, start: here.source });
    return next;
  }

  const removeAt = (clips, index) => clips.filter((clip, i) => i !== index);

  /** The timeline with `clip` put in at `index` (0: first; clips.length: last). */
  function insertAt(clips, index, clip) {
    const next = [...clips];
    next.splice(clamp(index, 0, clips.length), 0, clip);
    return next;
  }

  /**
   * The timeline with the piece `from` moved so that it sits before what was at `to`
   * (to = clips.length: to the end). The same list when that changes nothing.
   */
  function move(clips, from, to) {
    if (!(from >= 0 && from < clips.length)) return clips;
    const target = clamp(to, 0, clips.length);
    if (target === from || target === from + 1) return clips;
    const next = [...clips];
    const [clip] = next.splice(from, 1);
    next.splice(target > from ? target - 1 : target, 0, clip);
    return next;
  }

  /** Where a paste goes: right after the piece under the playhead (0 on an empty timeline). */
  function pasteIndex(clips, time) {
    const here = locate(clips, time);
    if (!here) return 0;
    // At the very start of the first piece: before everything.
    return time <= 1e-6 ? 0 : here.index + 1;
  }

  /** The border a dragged piece is dropped on, for a pointer at `x` px from the timeline's start: 0..clips.length. */
  function dropIndex(clips, pxPerSecond, x) {
    const starts = startsOf(clips);
    for (let i = 0; i < clips.length; i += 1) {
      if (x < (starts[i] + lengthOf(clips[i]) / 2) * pxPerSecond) return i;
    }
    return clips.length;
  }

  /** What POST /api/videos/render takes. */
  const segmentsOf = clips => clips.map(clip => ({ video: clip.video, start: round3(clip.start), end: round3(clip.end) }));

  /** '1:05.3' for 65.3 seconds. */
  function timeText(seconds) {
    const tenths = Math.max(0, Math.round((finite(seconds) ? seconds : 0) * 10));
    return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
  }

  /** '12초', '1분 5초'. */
  function lengthText(seconds) {
    const s = Math.max(0, Math.round(finite(seconds) ? seconds : 0));
    return s >= 60 ? `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}` : `${s}초`;
  }

  /** '1920×1080 · 12초 · 투명 · 소리' for a video of the library. */
  function metaText(video) {
    return [
      finite(video.width) && finite(video.height) ? `${video.width}×${video.height}` : '',
      finite(video.duration) ? lengthText(video.duration) : '',
      video.alpha ? '투명 배경' : '',
      video.audio ? '소리 있음' : '',
    ].filter(Boolean).join(' · ');
  }

  /** The zoom slider (0..100) as pixels per second: 4 to 240, evenly in ratio. */
  function pxPerSecond(zoom) {
    const z = clamp(Number(zoom) || 0, 0, 100) / 100;
    return round3(4 * (240 / 4) ** z);
  }
  /** The slider position at which `total` seconds fill `width` px. */
  function zoomToFit(total, width) {
    if (!(total > 0) || !(width > 0)) return 40;
    return Math.round(clamp(Math.log(width / total / 4) / Math.log(240 / 4), 0, 1) * 100);
  }

  /** The seconds between the ruler's marks, so that they stand at least ~70px apart. */
  function tickStep(pps) {
    return [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(step => step * pps >= 70) || 600;
  }

  /** True when the pieces mix transparent videos with ones that have a background (cannot be saved as one video). */
  function mixedAlpha(clips, videoOf) {
    const kinds = new Set(clips.map(clip => Boolean((videoOf(clip.video) || {}).alpha)));
    return kinds.size > 1;
  }

  /** A stable colour (a hue) for the pieces of one video. */
  function hueOf(id) {
    let sum = 0;
    for (const char of String(id)) sum = (sum * 31 + char.charCodeAt(0)) % 360;
    return sum;
  }

  /** The name a saved timeline is offered: '<first video> 편집'. */
  const saveNameOf = video => `${String((video && video.name) || '영상').slice(0, 90)} 편집`;

  return {
    MIN_PIECE, lengthOf, totalOf, startsOf, pieceOf, locate, split, removeAt, insertAt, move, pasteIndex, dropIndex, segmentsOf,
    timeText, lengthText, metaText, pxPerSecond, zoomToFit, tickStep, mixedAlpha, hueOf, saveNameOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VideoEditHelpers;

if (typeof document !== 'undefined') (() => {
  const H = VideoEditHelpers;
  const $ = id => document.getElementById(id);
  const MAX_HISTORY = 100;
  const DRAG_START_PX = 6;
  const TRACK_PAD = 12; // .videos-track's side padding

  const libraryList = $('libraryList');
  const libraryCount = $('libraryCount');
  const libraryEmpty = $('libraryEmpty');
  const libraryStatus = $('libraryStatus');
  const uploadBtn = $('uploadBtn');
  const uploadFile = $('uploadFile');
  const uploadProgress = $('uploadProgress');
  const editorStatus = $('editorStatus');
  const saveName = $('saveName');
  const saveBtn = $('saveBtn');
  const player = $('player');
  const previewEmpty = $('previewEmpty');
  const playBtn = $('playBtn');
  const timeNode = $('timeText');
  const timeline = $('timeline');
  const track = $('track');
  const ruler = $('ruler');
  const clipsNode = $('clips');
  const playhead = $('playhead');
  const dropMark = $('dropMark');
  const zoom = $('zoom');
  const addFile = $('addFile');
  const tools = {
    split: $('splitBtn'), copy: $('copyBtn'), cut: $('cutBtn'), paste: $('pasteBtn'), left: $('leftBtn'), right: $('rightBtn'),
    remove: $('deleteBtn'), undo: $('undoBtn'), redo: $('redoBtn'), add: $('addBtn'),
  };

  let videos = []; // the library, the newest first
  let clips = []; // the timeline
  let selected = -1;
  let time = 0; // the playhead, in timeline seconds
  let clipboard = null; // a copied piece: { video, start, end }
  let past = [];
  let future = [];
  let dirty = false;
  let playing = false;
  let showing = -1; // the piece the player shows
  let loaded = null; // the video id the player has
  let settling = false; // the player is on its way to a new place
  let frame = 0;
  let busy = false; // uploading or saving
  let keys = 0;
  let drag = null;

  const videoOf = id => videos.find(video => video.id === id) || null;
  const newKey = () => `c${keys += 1}`;

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  async function call(method, path, json) {
    const response = await fetch(path, {
      method,
      headers: json === undefined ? {} : { 'Content-Type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    let data = null;
    try { data = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${response.status}`), { code: data && data.code });
    return data;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false && value != null) node.setAttribute(key, String(value));
    }
    node.append(...children);
    return node;
  }

  // ---- The library ----
  function setVideos(next) {
    videos = Array.isArray(next) ? next.filter(video => video && typeof video.id === 'string') : [];
    // A piece whose video was deleted goes with it.
    if (clips.some(clip => !videoOf(clip.video))) {
      stop();
      clips = clips.filter(clip => videoOf(clip.video));
      selected = -1;
      past = [];
      future = [];
      seek(time);
    }
    renderLibrary();
    renderEditor();
  }

  function libraryItem(video) {
    const thumb = el('video', { muted: true, playsinline: true, preload: 'metadata', src: `${video.url}#t=0.1` });
    thumb.muted = true;
    const actions = [
      el('button', { type: 'button', className: 'btn btn-sm', text: '편집', title: '이 영상으로 새 타임라인 시작', onclick: () => startWith(video) }),
      el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm', text: '+ 타임라인', title: '지금 타임라인 끝에 이어붙이기', 'data-act': 'append',
        onclick: () => append([video]),
      }),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '방송 화면에 추가', onclick: () => toScene(video) }),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '이름', title: '이름 바꾸기', onclick: () => rename(video) }),
      el('a', { className: 'btn btn-ghost btn-sm', href: `${video.url}?download=1`, download: '', text: '다운로드' }),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => remove(video) }),
    ];
    const node = el('li', { className: 'videos-item' }, [
      el('span', { className: `videos-thumb${video.alpha ? ' checkerboard' : ''}` }, [thumb]),
      el('div', { className: 'videos-info' }, [
        el('span', { className: 'videos-item-name', text: video.name, title: video.name }),
        el('span', { className: 'videos-item-meta', text: H.metaText(video) }),
        el('div', { className: 'videos-item-actions' }, actions),
      ]),
    ]);
    node.dataset.id = video.id;
    return node;
  }

  function renderLibrary() {
    libraryCount.textContent = videos.length ? `· ${videos.length}개` : '';
    libraryEmpty.hidden = videos.length > 0;
    libraryList.replaceChildren(...videos.map(libraryItem));
    markLibrary();
  }

  // What follows the timeline, without building the list again (its thumbnails would load again).
  function markLibrary() {
    for (const node of libraryList.children) {
      node.classList.toggle('is-used', clips.some(clip => clip.video === node.dataset.id));
      node.querySelector('[data-act="append"]').disabled = !clips.length;
    }
    uploadBtn.disabled = busy;
  }

  async function rename(video) {
    const name = window.prompt('영상 이름', video.name);
    if (name == null || !name.trim() || name.trim() === video.name) return;
    try {
      setVideos((await call('PATCH', `/api/videos/${video.id}`, { name: name.trim() })).videos);
      setStatus(libraryStatus, '');
    } catch (error) {
      setStatus(libraryStatus, error.message, 'error');
    }
  }

  async function remove(video) {
    if (!window.confirm(`'${video.name}'을(를) 지울까요? 방송 화면에서 쓰고 있으면 거기서도 빠집니다. 되돌릴 수 없습니다.`)) return;
    try {
      setVideos((await call('DELETE', `/api/videos/${video.id}`)).videos);
      setStatus(libraryStatus, '');
    } catch (error) {
      setStatus(libraryStatus, error.message, 'error');
    }
  }

  async function toScene(video) {
    try {
      await call('POST', `/api/scene/layers?video=${encodeURIComponent(video.id)}`);
      setStatus(libraryStatus, `'${video.name}'을(를) 방송 화면에 추가했습니다. 방송 화면 → 화면 구성에서 순서와 크기를 바꿀 수 있습니다.`);
    } catch (error) {
      setStatus(libraryStatus, error.message, 'error');
    }
  }

  // ---- Upload: one file after another ----
  function sendFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      // XHR for upload progress (fetch has none).
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/videos?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      });
      xhr.upload.addEventListener('load', () => onProgress(null));
      xhr.addEventListener('load', () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status === 401 && String(xhr.getResponseHeader('X-Virtually-Auth') || '').toLowerCase() === 'required') {
          const auth = window.VirtuallyAuth;
          if (auth && typeof auth.loginUrlFor === 'function') window.location.assign(auth.loginUrlFor(window.location.pathname, window.location.search));
        }
        if (xhr.status === 201 && data && data.video) resolve(data);
        else reject(new Error((data && data.error) || `HTTP ${xhr.status}`));
      });
      xhr.addEventListener('error', () => reject(new Error('서버에 연결할 수 없습니다')));
      xhr.send(file);
    });
  }

  // -> the videos that went up. `status`: the line that tells how it goes.
  async function uploadFiles(files, status) {
    if (busy || !files.length) return [];
    busy = true;
    markLibrary();
    renderEditor();
    uploadProgress.hidden = false;
    const made = [];
    try {
      for (const [index, file] of files.entries()) {
        const which = files.length > 1 ? ` (${index + 1}/${files.length})` : '';
        const data = await sendFile(file, (percent) => {
          if (percent == null) uploadProgress.removeAttribute('value');
          else uploadProgress.value = percent;
          setStatus(status, percent == null ? `영상을 확인하는 중…${which}` : `올리는 중…${which} ${percent}%`);
        });
        made.push(data.video);
        videos = data.videos;
      }
      setStatus(status, '');
    } catch (error) {
      setStatus(status, `${made.length ? `${made.length}개를 올렸고, 다음 파일에서 멈췄습니다. ` : ''}올리지 못했습니다: ${error.message}`, 'error');
    } finally {
      busy = false;
      uploadProgress.hidden = true;
      setVideos(videos);
    }
    return made;
  }

  uploadBtn.addEventListener('click', () => uploadFile.click());
  uploadFile.addEventListener('change', () => {
    const files = Array.from(uploadFile.files || []);
    uploadFile.value = '';
    uploadFiles(files, libraryStatus);
  });
  // + 영상 첨부: the files go into the library and onto the end of the timeline.
  tools.add.addEventListener('click', () => addFile.click());
  addFile.addEventListener('change', async () => {
    const files = Array.from(addFile.files || []);
    addFile.value = '';
    const made = await uploadFiles(files, editorStatus);
    if (made.length) append(made);
  });

  // ---- The timeline: every change goes through commit (so it can be undone) ----
  function commit(next, { select = selected, at = time } = {}) {
    if (next === clips) return;
    stop();
    past.push({ clips, selected, time });
    if (past.length > MAX_HISTORY) past.shift();
    future = [];
    clips = next;
    selected = select >= 0 && select < clips.length ? select : -1;
    dirty = clips.length > 0;
    showing = -1;
    seek(at);
    markLibrary();
    renderEditor();
  }

  function restore(from, to) {
    const state = from.pop();
    if (!state) return;
    stop();
    to.push({ clips, selected, time });
    ({ clips, selected } = state);
    dirty = clips.length > 0;
    showing = -1;
    seek(state.time);
    markLibrary();
    renderEditor();
  }

  function startWith(video) {
    if (dirty && clips.length && !window.confirm('지금 편집 중인 타임라인을 버리고 이 영상으로 새로 시작할까요?')) return;
    stop();
    past = [];
    future = [];
    clips = [H.pieceOf(video, newKey())];
    selected = 0;
    dirty = false;
    showing = -1;
    saveName.value = H.saveNameOf(video);
    zoom.value = String(H.zoomToFit(H.totalOf(clips), timeline.clientWidth - TRACK_PAD * 2 - 4));
    setStatus(editorStatus, '');
    seek(0);
    markLibrary();
    renderEditor();
  }

  function append(list) {
    const pieces = list.filter(video => video && video.duration > 0).map(video => H.pieceOf(video, newKey()));
    if (!pieces.length) return;
    if (!clips.length && !saveName.value) saveName.value = H.saveNameOf(list[0]);
    commit([...clips, ...pieces], { select: clips.length + pieces.length - 1, at: H.totalOf(clips) });
  }

  const actions = {
    split() {
      const next = H.split(clips, time, newKey());
      if (next === clips) return;
      commit(next, { select: H.locate(next, time).index });
    },
    copy() {
      if (selected < 0) return;
      const { video, start, end } = clips[selected];
      clipboard = { video, start, end };
      renderEditor();
    },
    cut() {
      if (selected < 0) return;
      actions.copy();
      actions.remove();
    },
    paste() {
      if (!clipboard || !videoOf(clipboard.video)) return;
      const index = H.pasteIndex(clips, time);
      const next = H.insertAt(clips, index, { ...clipboard, key: newKey() });
      commit(next, { select: index, at: H.startsOf(next)[index] });
    },
    remove() {
      if (selected < 0) return;
      const next = H.removeAt(clips, selected);
      commit(next, { select: Math.min(selected, next.length - 1), at: Math.min(time, H.totalOf(next)) });
    },
    left() {
      if (selected <= 0) return;
      const next = H.move(clips, selected, selected - 1);
      commit(next, { select: selected - 1, at: H.startsOf(next)[selected - 1] });
    },
    right() {
      if (selected < 0 || selected >= clips.length - 1) return;
      const next = H.move(clips, selected, selected + 2);
      commit(next, { select: selected + 1, at: H.startsOf(next)[selected + 1] });
    },
    undo: () => restore(past, future),
    redo: () => restore(future, past),
  };
  for (const name of ['split', 'copy', 'cut', 'paste', 'remove', 'left', 'right', 'undo', 'redo']) {
    tools[name].addEventListener('click', () => actions[name]());
  }

  // ---- The player: one <video> that shows the piece under the playhead ----
  function showPiece(index, source, thenPlay) {
    const clip = clips[index];
    const video = clip && videoOf(clip.video);
    if (!video) return;
    showing = index;
    settling = true;
    const arrive = () => {
      try { player.currentTime = source; } catch { /* not ready */ }
      if (!player.seeking) settling = false;
      if (thenPlay) player.play().catch(() => stop());
    };
    if (loaded !== video.id) {
      loaded = video.id;
      player.src = video.url;
      player.addEventListener('loadedmetadata', arrive, { once: true });
      player.load();
    } else {
      arrive();
    }
  }
  player.addEventListener('seeked', () => { settling = false; });

  function seek(to) {
    const total = H.totalOf(clips);
    time = Math.min(total, Math.max(0, Number.isFinite(to) ? to : 0));
    const here = H.locate(clips, time);
    if (here) {
      showPiece(here.index, here.source, playing);
    } else {
      showing = -1;
      loaded = null;
      player.removeAttribute('src');
      player.load();
    }
    drawPlayhead();
  }

  function tick() {
    if (!playing) return;
    const clip = clips[showing];
    if (clip && !settling && player.readyState >= 1) {
      const at = player.currentTime;
      const starts = H.startsOf(clips);
      if (at >= clip.end - 0.02 || player.ended) {
        if (showing + 1 < clips.length) {
          time = starts[showing + 1];
          showPiece(showing + 1, clips[showing + 1].start, true);
        } else {
          time = H.totalOf(clips);
          stop();
        }
      } else {
        time = starts[showing] + Math.max(0, at - clip.start);
      }
      drawPlayhead();
    }
    frame = requestAnimationFrame(tick);
  }

  function play() {
    if (playing || !clips.length) return;
    if (time >= H.totalOf(clips) - 0.05) time = 0;
    playing = true;
    playBtn.textContent = '정지';
    seek(time);
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(frame);
    player.pause();
    playBtn.textContent = '재생';
  }

  playBtn.addEventListener('click', () => (playing ? stop() : play()));

  // ---- Drawing the timeline ----
  const pps = () => H.pxPerSecond(zoom.value);

  function drawPlayhead() {
    playhead.hidden = !clips.length;
    playhead.style.left = `${TRACK_PAD + time * pps()}px`;
    timeNode.textContent = `${H.timeText(time)} / ${H.timeText(H.totalOf(clips))}`;
    if (playhead.hidden || drag) return;
    // Keep the playhead in view.
    const x = TRACK_PAD + time * pps();
    if (x < timeline.scrollLeft || x > timeline.scrollLeft + timeline.clientWidth - 24) timeline.scrollLeft = Math.max(0, x - 40);
  }

  function renderEditor() {
    const scale = pps();
    const total = H.totalOf(clips);
    const has = clips.length > 0;
    previewEmpty.hidden = has;
    track.style.width = `${Math.max(0, total * scale) + TRACK_PAD * 2}px`;

    const step = H.tickStep(scale);
    const ticks = [];
    for (let at = 0; at <= total + 1e-6 && ticks.length < 2000; at += step) {
      ticks.push(el('span', { className: 'videos-tick', text: H.timeText(at).replace(/\.0$/, ''), style: `left:${at * scale}px` }));
    }
    ruler.replaceChildren(...ticks);

    clipsNode.replaceChildren(...clips.map((clip, index) => {
      const video = videoOf(clip.video);
      const node = el('button', {
        type: 'button', className: `videos-clip${index === selected ? ' is-selected' : ''}`, 'aria-pressed': String(index === selected),
        title: `${video ? video.name : ''} · ${H.timeText(clip.start)} ~ ${H.timeText(clip.end)}`,
        style: `width:${Math.max(2, H.lengthOf(clip) * scale)}px;--hue:${H.hueOf(clip.video)}`,
      }, [
        el('span', { className: 'videos-clip-name', text: video ? video.name : '' }),
        el('span', { className: 'videos-clip-len', text: H.timeText(H.lengthOf(clip)) }),
      ]);
      node.dataset.index = String(index);
      return node;
    }));

    const one = selected >= 0;
    tools.split.disabled = !has || H.split(clips, time, 'x') === clips;
    tools.copy.disabled = !one;
    tools.cut.disabled = !one;
    tools.remove.disabled = !one;
    tools.paste.disabled = !clipboard || !videoOf(clipboard.video);
    tools.left.disabled = selected <= 0;
    tools.right.disabled = !one || selected >= clips.length - 1;
    tools.undo.disabled = !past.length;
    tools.redo.disabled = !future.length;
    tools.add.disabled = busy;
    playBtn.disabled = !has;
    saveName.disabled = !has || busy;
    const mixed = H.mixedAlpha(clips, videoOf);
    saveBtn.disabled = !has || busy || mixed;
    if (mixed) setStatus(editorStatus, '배경이 투명한 영상과 배경이 있는 영상은 한 영상으로 저장할 수 없습니다. 한쪽 조각을 빼 주세요.', 'error');
    else if (editorStatus.dataset.kind === 'error' && editorStatus.textContent.startsWith('배경이 투명한')) setStatus(editorStatus, '');
    drawPlayhead();
  }

  zoom.addEventListener('input', renderEditor);

  // ---- The pointer on the timeline: click to go there, click a piece to select it, drag a piece to move it ----
  const trackX = event => event.clientX - track.getBoundingClientRect().left - TRACK_PAD;

  ruler.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !clips.length) return;
    stop();
    seek(trackX(event) / pps());
    renderEditor();
  });

  clipsNode.addEventListener('pointerdown', (event) => {
    const node = event.target.closest('.videos-clip');
    if (event.button !== 0 || !node) return;
    node.setPointerCapture(event.pointerId);
    drag = { index: Number(node.dataset.index), node, pointer: event.pointerId, startX: event.clientX, moved: false, to: null };
  });
  clipsNode.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_START_PX) return;
    drag.moved = true;
    drag.node.classList.add('is-dragging');
    drag.to = H.dropIndex(clips, pps(), trackX(event));
    const starts = H.startsOf(clips);
    const at = drag.to >= clips.length ? H.totalOf(clips) : starts[drag.to];
    dropMark.hidden = false;
    dropMark.style.left = `${TRACK_PAD + at * pps()}px`;
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { index, moved, to, node } = drag;
    drag = null;
    dropMark.hidden = true;
    node.classList.remove('is-dragging');
    if (moved && event.type === 'pointerup' && to != null) {
      const next = H.move(clips, index, to);
      if (next !== clips) {
        const landed = to > index ? to - 1 : to;
        commit(next, { select: landed, at: H.startsOf(next)[landed] });
      }
      return;
    }
    if (moved) return;
    // A click: select the piece and go to where it was clicked.
    stop();
    selected = index;
    seek(trackX(event) / pps());
    renderEditor();
  };
  clipsNode.addEventListener('pointerup', endDrag);
  clipsNode.addEventListener('pointercancel', endDrag);

  // ---- Keys (not while typing a name) ----
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (!clips.length && !(clipboard && (event.ctrlKey || event.metaKey))) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    let run = null;
    if (mod && key === 'z') run = event.shiftKey ? actions.redo : actions.undo;
    else if (mod && key === 'y') run = actions.redo;
    else if (mod && key === 'c') run = actions.copy;
    else if (mod && key === 'x') run = actions.cut;
    else if (mod && key === 'v') run = actions.paste;
    else if (mod || event.altKey) return;
    else if (key === ' ') run = () => (playing ? stop() : play());
    else if (key === 's') run = actions.split;
    else if (key === 'delete' || key === 'backspace') run = actions.remove;
    else if (key === 'arrowleft' || key === 'arrowright') {
      run = () => {
        stop();
        seek(time + (key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1));
        renderEditor();
      };
    }
    if (!run) return;
    // Text selected on the page is copied as usual.
    if (mod && key === 'c' && String(window.getSelection() || '')) return;
    event.preventDefault();
    run();
  });

  // ---- Save: the timeline as one new video ----
  saveBtn.addEventListener('click', async () => {
    if (busy || !clips.length) return;
    stop();
    busy = true;
    markLibrary();
    renderEditor();
    setStatus(editorStatus, '새 영상을 만드는 중… (길이에 따라 몇 분 걸릴 수 있습니다. 이 화면을 닫지 마세요)');
    try {
      const data = await call('POST', '/api/videos/render', { name: saveName.value.trim(), segments: H.segmentsOf(clips) });
      dirty = false;
      busy = false;
      setVideos(data.videos);
      setStatus(editorStatus, `'${data.video.name}'을(를) 저장했습니다. 왼쪽 목록의 '방송 화면에 추가'나 방송 화면 → 화면 구성에서 쓸 수 있습니다.`);
    } catch (error) {
      setStatus(editorStatus, `저장하지 못했습니다: ${error.message}`, 'error');
    } finally {
      busy = false;
      markLibrary();
      renderEditor();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!dirty || !clips.length) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // ---- Start ----
  renderEditor();
  call('GET', '/api/videos').then((data) => {
    setVideos(data.videos);
    // /videos?edit=<id>: opened from the broadcast page to edit that video.
    const wanted = new URLSearchParams(window.location.search).get('edit');
    const video = wanted ? videoOf(wanted) : null;
    if (video) startWith(video);
  }).catch(error => setStatus(libraryStatus, `영상 목록을 불러오지 못했습니다: ${error.message}`, 'error'));
})();
