'use strict';

// 화면 구성 on the controller: the layers of the broadcast scene (lib/scene.js). The
// streamer adds videos and images (a looping background, a frame, a logo), orders them
// and the character from the back to the front, hides them, and sizes and places the
// ones that do not fill the canvas. The canvas preview shows every change at once, and
// the overlay in OBS gets it when it is saved.
// The scene comes from GET /api/scene and from the page's event stream (app.js passes
// its messages on as 'virtually:live' events). All names are user data: textContent only.

// DOM-free helpers, exported for node tests.
const SceneHelpers = (() => {
  const CHARACTER_ID = 'character';
  // The size slider: 5% to 300% of "fitted to the canvas".
  const PERCENT_MIN = 5;
  const PERCENT_MAX = 300;
  const OFFSET_MAX = 1.5;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const round4 = value => Math.round(value * 10000) / 10000;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /** The layers of a scene, back to front (an empty list for anything else). */
  function layersOf(scene) {
    const layers = scene && Array.isArray(scene.layers) ? scene.layers : [];
    return layers.filter(layer => layer && typeof layer === 'object' && typeof layer.id === 'string' && layer.id);
  }

  const layerOf = (scene, id) => layersOf(scene).find(layer => layer.id === id) || null;
  const mediaCount = scene => layersOf(scene).filter(layer => layer.kind !== 'character').length;

  /**
   * The rows of the list, the front layer first:
   * { id, kind, tag, name, visible, front, back } (front / back: it is already the very
   * front / back, so those buttons do nothing). The character's row carries the name of
   * the character on air ('데모 캐릭터' with none).
   */
  function rows(scene, characterName = '') {
    const layers = layersOf(scene);
    const who = String(characterName ?? '').trim();
    return layers.map((layer, index) => {
      const character = layer.kind === 'character';
      return {
        id: layer.id,
        kind: layer.kind,
        tag: character ? '캐릭터' : layer.kind === 'video' ? '영상' : '이미지',
        name: character ? (who || '데모 캐릭터') : String(layer.name ?? ''),
        visible: layer.visible !== false,
        front: index === layers.length - 1,
        back: index === 0,
      };
    }).reverse();
  }

  /** A layer that can be sized and dragged: the character, or a video/image that does not fill the canvas. */
  function canPlace(layer) {
    return Boolean(layer) && (layer.kind === 'character' || layer.fill === false);
  }

  /** The slider position (a whole percent) of a scale, and back. */
  function percentOf(scale) {
    return clamp(Math.round((finite(scale) && scale > 0 ? scale : 1) * 100), PERCENT_MIN, PERCENT_MAX);
  }
  function scaleOf(percent) {
    const value = Number(percent);
    return clamp(Number.isFinite(value) ? value : 100, PERCENT_MIN, PERCENT_MAX) / 100;
  }

  /** x, y of a layer dragged by (dx, dy), fractions of the canvas width and height. */
  function dragged(start, dx, dy) {
    const from = value => (finite(value) ? value : 0);
    return {
      x: round4(clamp(from(start && start.x) + from(dx), -OFFSET_MAX, OFFSET_MAX)),
      y: round4(clamp(from(start && start.y) + from(dy), -OFFSET_MAX, OFFSET_MAX)),
    };
  }

  /** The scene with `fields` put on the layer `id` (what the preview shows before it is saved). */
  function withLayer(scene, id, fields) {
    return { layers: layersOf(scene).map(layer => (layer.id === id ? { ...layer, ...fields } : layer)) };
  }

  /** '영상 2 · 이미지 1' for the card's title; '' with nothing added. */
  function countText(scene) {
    const layers = layersOf(scene);
    const videos = layers.filter(layer => layer.kind === 'video').length;
    const images = layers.filter(layer => layer.kind === 'image').length;
    return [videos ? `영상 ${videos}` : '', images ? `이미지 ${images}` : ''].filter(Boolean).join(' · ');
  }

  /** POST path of an upload: the file's name goes along (the layer is named after it). */
  function uploadPath(filename) {
    return `/api/scene/layers?name=${encodeURIComponent(String(filename ?? ''))}`;
  }

  /** The Content-Type sent with a file (the server looks at the bytes, not at this). */
  function contentType(file) {
    return file && typeof file.type === 'string' && file.type ? file.type : 'application/octet-stream';
  }

  /** '올리는 중… (2/3) 40%': the line shown while files go up. */
  function uploadText(index, total, percent) {
    const which = total > 1 ? ` (${index + 1}/${total})` : '';
    return percent == null ? `영상을 확인하는 중…${which}` : `올리는 중…${which} ${percent}%`;
  }

  // The play counts offered for a video (0: over and over).
  const REPEAT_COUNTS = [0, 1, 2, 3, 4, 5, 10, 20];

  /** The options of a video's 반복 select: [{ value, label }], with the layer's own count among them. */
  function repeatChoices(current) {
    const now = Number.isInteger(current) && current > 0 ? current : 0;
    const counts = REPEAT_COUNTS.includes(now) ? REPEAT_COUNTS : [...REPEAT_COUNTS, now].sort((a, b) => a - b);
    return counts.map(value => ({ value, label: value === 0 ? '계속 반복' : `${value}번만 재생` }));
  }

  /** The other video layers a video can be joined with: [{ id, name }], the front one first. */
  function joinChoices(scene, id) {
    return layersOf(scene).filter(layer => layer.kind === 'video' && layer.id !== id)
      .map(layer => ({ id: layer.id, name: String(layer.name ?? '') })).reverse();
  }

  return {
    CHARACTER_ID, PERCENT_MIN, PERCENT_MAX, layersOf, layerOf, mediaCount, rows, canPlace, percentOf, scaleOf, dragged,
    withLayer, countText, uploadPath, contentType, uploadText, repeatChoices, joinChoices,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SceneHelpers;

if (typeof document !== 'undefined') (() => {
  const H = SceneHelpers;
  const $ = id => document.getElementById(id);
  const card = $('sceneCard');
  const countNode = $('sceneCount');
  const addBtn = $('sceneAddBtn');
  const fileInput = $('sceneFile');
  const progress = $('sceneProgress');
  const status = $('sceneStatus');
  const list = $('sceneList');
  const canvasBox = $('canvasBox');
  const frame = $('overlayPreviewFrame');

  let scene = null; // what the server has
  let draft = null; // { id, fields }: a size or place being changed, not saved yet
  let pending = null; // a scene that arrived while the streamer was changing one
  let selectedId = null;
  let characterName = '';
  let opened = false; // the card opens by itself once, when the scene has videos or images
  let uploading = false;
  let joining = false; // two videos are being joined on the server
  let drag = null;

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
    if (!response.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${response.status}`), { code: data && data.code });
    return data;
  }

  // What the preview shows: the saved scene, with the change being made on top.
  const shown = () => (scene && draft ? H.withLayer(scene, draft.id, draft.fields) : scene);
  const selected = () => (selectedId ? H.layerOf(shown(), selectedId) : null);

  // Tell the canvas preview (overlay.js in the iframe): the scene as shown here, and the selected layer.
  function preview() {
    const target = frame.contentWindow;
    if (!target) return;
    const visible = card.open ? selectedId : null;
    target.postMessage({ source: 'virtually-controller', type: 'scene', scene: shown(), selected: visible }, window.location.origin);
    canvasBox.classList.toggle('is-placing', Boolean(visible) && H.canPlace(selected()));
  }
  frame.addEventListener('load', preview);

  function apply(next) {
    if (!next || typeof next !== 'object') return;
    // Not under the streamer's hand: a slider or a drag in use keeps its own value until it lets go.
    if (draft) {
      pending = next;
      return;
    }
    scene = next;
    if (selectedId && !H.layerOf(scene, selectedId)) selectedId = null;
    if (!opened && H.mediaCount(scene) > 0) {
      opened = true;
      card.open = true;
    }
    render();
  }

  async function act(method, path, json) {
    setStatus('');
    try {
      const data = await call(method, path, json);
      if (data && data.scene) apply(data.scene);
    } catch (error) {
      setStatus(error.message, 'error');
      render();
    }
  }

  const layerPath = id => `/api/scene/layers/${encodeURIComponent(id)}`;

  // Save what was being changed (a drag or a slider let go), then show what the server kept.
  async function commit() {
    if (!draft) return;
    const { id, fields } = draft;
    // The page shows the new value until the answer comes.
    if (scene) scene = H.withLayer(scene, id, fields);
    draft = null;
    setStatus('');
    try {
      const data = await call('PATCH', layerPath(id), fields);
      pending = null;
      if (data && data.scene) apply(data.scene);
    } catch (error) {
      setStatus(error.message, 'error');
      load();
    }
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

  function sizeControls(layer) {
    const output = el('output', { className: 'scene-size-value', text: `${H.percentOf(layer.scale)}%` });
    const slider = el('input', {
      type: 'range', min: H.PERCENT_MIN, max: H.PERCENT_MAX, step: 1, value: H.percentOf(layer.scale), 'aria-label': '크기',
      oninput: () => {
        draft = { id: layer.id, fields: { ...(draft && draft.id === layer.id ? draft.fields : {}), scale: H.scaleOf(slider.value) } };
        output.textContent = `${H.percentOf(draft.fields.scale)}%`;
        preview();
      },
      onchange: commit,
    });
    const reset = el('button', {
      type: 'button', className: 'btn btn-ghost btn-sm', text: '원래대로',
      title: '크기 100%, 가운데로',
      onclick: () => act('PATCH', layerPath(layer.id), { scale: 1, x: 0, y: 0 }),
    });
    return [
      el('div', { className: 'scene-size' }, [el('span', { className: 'scene-size-label', text: '크기' }), slider, output, reset]),
      el('p', { className: 'hint', text: '오른쪽 캔버스에서 끌어서 자리를 옮길 수 있습니다.' }),
    ];
  }

  // A video: how many times it plays, play it again from its start, and join it with another video.
  function videoControls(layer) {
    const parts = [];
    const current = Number.isInteger(layer.repeat) && layer.repeat > 0 ? layer.repeat : 0;
    const repeat = el('select', {
      'aria-label': '반복 횟수',
      onchange: () => act('PATCH', layerPath(layer.id), { repeat: Number(repeat.value) }),
    }, H.repeatChoices(current).map(choice => el('option', { value: choice.value, selected: choice.value === current, text: choice.label })));
    const replay = el('button', {
      type: 'button', className: 'btn btn-ghost btn-sm', text: '처음부터 재생', title: '이 영상을 처음부터 다시 재생합니다 (OBS 화면에서도)',
      onclick: () => call('POST', `${layerPath(layer.id)}/replay`, {}).catch(error => setStatus(error.message, 'error')),
    });
    parts.push(el('div', { className: 'scene-line' }, [el('span', { className: 'scene-size-label', text: '반복' }), repeat, replay]));
    if (current > 0) parts.push(el('p', { className: 'hint', text: `${current}번 재생한 뒤 마지막 장면에서 멈춥니다. 숨겼다 보이거나 '처음부터 재생'을 누르면 다시 재생합니다.` }));
    const others = H.joinChoices(shown(), layer.id);
    if (others.length) {
      const pick = el('select', { 'aria-label': '뒤에 이어붙일 영상' }, others.map(other => el('option', { value: other.id, text: other.name })));
      const join = el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm', text: '뒤에 이어붙이기', disabled: joining,
        title: '이 영상 다음에 고른 영상이 이어지는 새 영상을 만듭니다',
        onclick: () => joinLayers(layer, pick.value),
      });
      parts.push(el('div', { className: 'scene-line' }, [el('span', { className: 'scene-size-label', text: '이어붙이기' }), pick, join]));
    }
    return parts;
  }

  // The video `layer`, then the video `otherId`, as one new video layer (both stay as they are).
  async function joinLayers(layer, otherId) {
    if (joining || !otherId) return;
    joining = true;
    render();
    setStatus('두 영상을 이어붙이는 중… (영상 길이에 따라 1~2분 걸릴 수 있습니다)');
    try {
      const data = await call('POST', `${layerPath(layer.id)}/join`, { with: otherId });
      if (data && data.layer) selectedId = data.layer.id;
      setStatus('');
      joining = false;
      if (data && data.scene) apply(data.scene);
    } catch (error) {
      setStatus(`이어붙이지 못했습니다: ${error.message}`, 'error');
    } finally {
      joining = false;
      render();
    }
  }

  function options(layer) {
    if (layer.kind === 'character') return sizeControls(layer);
    const parts = [];
    const fill = el('input', {
      type: 'checkbox', checked: layer.fill !== false,
      onchange: () => act('PATCH', layerPath(layer.id), { fill: fill.checked }),
    });
    parts.push(el('label', { className: 'scene-check' }, [fill, document.createTextNode(' 화면에 꽉 채우기')]));
    if (layer.fill === false) parts.push(...sizeControls(layer));
    else parts.push(el('p', { className: 'hint', text: '끄면 크기를 줄이고 자리를 옮길 수 있습니다.' }));
    if (layer.kind === 'video') parts.push(...videoControls(layer));
    if (layer.kind === 'video' && layer.audio === true) {
      const sound = el('input', {
        type: 'checkbox', checked: layer.muted === false,
        onchange: () => act('PATCH', layerPath(layer.id), { muted: !sound.checked }),
      });
      parts.push(el('label', { className: 'scene-check' }, [sound, document.createTextNode(' 소리 켜기')]));
      if (layer.muted === false) {
        parts.push(el('p', { className: 'hint', text: "소리는 OBS에서만 납니다(이 미리보기는 조용합니다). 방송에 넣으려면 OBS 브라우저 소스 속성의 'OBS를 통해 오디오 조절'을 켜 주세요." }));
      }
    }
    return parts;
  }

  function row(item) {
    const layer = H.layerOf(shown(), item.id);
    const isSelected = item.id === selectedId;
    const move = (to, text, disabled, title) => el('button', {
      type: 'button', className: 'btn btn-ghost btn-sm', text, title, disabled,
      onclick: () => act('POST', `${layerPath(item.id)}/move`, { to }),
    });
    const head = el('div', { className: 'scene-row-head' }, [
      el('button', {
        type: 'button', className: 'scene-pick', 'aria-pressed': String(isSelected),
        title: isSelected ? '선택 해제' : '선택해서 크기와 자리 바꾸기',
        onclick: () => {
          selectedId = isSelected ? null : item.id;
          render();
        },
      }, [el('span', { className: 'scene-tag', text: item.tag }), el('span', { className: 'scene-name', text: item.name })]),
      el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm', text: item.visible ? '숨기기' : '보이기',
        'aria-label': `${item.name} ${item.visible ? '숨기기' : '보이기'}`,
        onclick: () => act('PATCH', layerPath(item.id), { visible: !item.visible }),
      }),
      ...(item.kind === 'character' ? [] : [el('button', {
        type: 'button', className: 'scene-del', text: '×', title: '삭제', 'aria-label': `${item.name} 삭제`,
        onclick: () => {
          if (window.confirm(`'${item.name}'을(를) 화면 구성에서 지울까요? 올린 파일도 지워집니다.`)) act('DELETE', layerPath(item.id));
        },
      })]),
    ]);
    const order = el('div', { className: 'scene-row-order', role: 'group', 'aria-label': `${item.name} 순서` }, [
      move('top', '맨 위로', item.front, '가장 앞에 보이게'),
      move('up', '위로', item.front, '한 칸 앞으로'),
      move('down', '아래로', item.back, '한 칸 뒤로'),
      move('bottom', '맨 아래로', item.back, '가장 뒤로'),
    ]);
    const node = el('li', { className: `scene-row${isSelected ? ' is-selected' : ''}${item.visible ? '' : ' is-hidden'}` }, [head, order]);
    node.dataset.id = item.id;
    if (isSelected && layer) node.append(el('div', { className: 'scene-row-opts' }, options(layer)));
    return node;
  }

  function render() {
    const count = H.countText(scene);
    countNode.textContent = count ? `· ${count}` : '';
    list.replaceChildren(...H.rows(shown(), characterName).map(row));
    addBtn.disabled = uploading;
    preview();
  }

  // ---- Upload: one file after another, with its progress ----
  function sendFile(file, index, total) {
    return new Promise((resolve, reject) => {
      // XHR for upload progress (fetch has none). A refused login goes to /login here.
      const xhr = new XMLHttpRequest();
      xhr.open('POST', H.uploadPath(file.name));
      xhr.setRequestHeader('Content-Type', H.contentType(file));
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable || !event.total) return;
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        progress.value = percent;
        setStatus(H.uploadText(index, total, percent));
      });
      xhr.upload.addEventListener('load', () => {
        progress.removeAttribute('value'); // indeterminate while the server works
        setStatus(H.uploadText(index, total, null));
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status === 401 && String(xhr.getResponseHeader('X-Virtually-Auth') || '').toLowerCase() === 'required') {
          const auth = window.VirtuallyAuth;
          if (auth && typeof auth.loginUrlFor === 'function') window.location.assign(auth.loginUrlFor(window.location.pathname, window.location.search));
        }
        if (xhr.status === 201 && data && data.layer) resolve(data);
        else reject(new Error((data && data.error) || `HTTP ${xhr.status}`));
      });
      xhr.addEventListener('error', () => reject(new Error('서버에 연결할 수 없습니다')));
      xhr.addEventListener('abort', () => reject(new Error('올리기를 멈췄습니다')));
      xhr.send(file);
    });
  }

  async function uploadFiles(files) {
    if (uploading || !files.length) return;
    uploading = true;
    addBtn.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    let done = 0;
    try {
      for (const [index, file] of files.entries()) {
        progress.value = 0;
        setStatus(H.uploadText(index, files.length, 0));
        const data = await sendFile(file, index, files.length);
        done += 1;
        selectedId = data.layer.id;
        apply(data.scene);
      }
      setStatus('');
    } catch (error) {
      setStatus(`${done ? `${done}개를 올렸고, 다음 파일에서 멈췄습니다. ` : ''}올리지 못했습니다: ${error.message}`, 'error');
    } finally {
      uploading = false;
      progress.hidden = true;
      render();
    }
  }

  addBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    uploadFiles(files);
  });

  // ---- Drag on the canvas: the selected layer moves (saved when it is let go) ----
  canvasBox.addEventListener('pointerdown', (event) => {
    const layer = card.open ? selected() : null;
    if (event.button !== 0 || !H.canPlace(layer)) return;
    const rect = canvasBox.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    event.preventDefault();
    canvasBox.setPointerCapture(event.pointerId);
    drag = { id: layer.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, rect, from: { x: layer.x, y: layer.y } };
  });
  canvasBox.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const place = H.dragged(drag.from, (event.clientX - drag.startX) / drag.rect.width, (event.clientY - drag.startY) / drag.rect.height);
    draft = { id: drag.id, fields: { ...(draft && draft.id === drag.id ? draft.fields : {}), ...place } };
    preview();
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null;
    if (draft) commit();
  };
  canvasBox.addEventListener('pointerup', endDrag);
  canvasBox.addEventListener('pointercancel', endDrag);

  // A closed card selects nothing on the canvas.
  card.addEventListener('toggle', () => {
    opened = true;
    preview();
  });

  // ---- Live state: at load, when the stream (re)opens, and every 'scene' message ----
  const load = () => call('GET', '/api/scene').then((data) => {
    draft = null;
    pending = null;
    apply(data);
  }).catch(() => {});
  window.addEventListener('virtually:live-open', load);
  window.addEventListener('virtually:live', (event) => {
    const data = event.detail;
    if (data?.type === 'scene') apply(data.scene);
    else if (data?.type === 'library') {
      const name = String(data.library?.character?.name ?? '');
      if (name !== characterName) {
        characterName = name;
        if (!draft) render();
      }
    }
  });
  load();
})();
