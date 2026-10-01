'use strict';

// Admin activity page (/admin/activity): who uses what. Three tabs: 사용자 (what
// each account did), 올린 자료 (characters, photos, motions, uploaded driving
// videos and 동작 만들기 jobs, each with its owner) and 이력 (every recorded
// change, broadcast switch and motion play). Only admins get answers from
// /api/admin/*; anyone else sees 관리자만 볼 수 있습니다. Emails, names and labels
// are user data: the DOM is built with createElement/textContent only. The DOM-free
// helpers are require()-able from node tests.
const AdminActivityHelpers = (() => {
  const TEXT = Object.freeze({
    notAdmin: '관리자만 볼 수 있습니다.',
    offline: '서버에 연결할 수 없습니다.',
    unknownOwner: '기록 이전',
    anonymous: '로그인 없음',
    noUsers: '아직 기록된 활동이 없습니다.',
  });

  const GROUP_OF = Object.freeze({
    'character.create': 'upload', 'photo.add': 'upload', 'motion.upload': 'upload', 'library.upload': 'upload', 'driving.upload': 'upload', 'motion.add': 'upload',
    'character.rename': 'edit', 'character.delete': 'edit', 'photo.delete': 'edit', 'photo.base': 'edit', 'media.delete': 'edit', 'driving.delete': 'edit',
    'onair.set': 'onair',
    'motion.trigger': 'play',
    'job.create': 'job',
  });
  const KIND_LABEL = Object.freeze({ upload: '올림', edit: '수정·삭제', onair: '방송', play: '재생', job: '만들기' });
  const JOB_STATE = Object.freeze({
    queued: '대기', preparing: '준비 중', running: '만드는 중', keying: '배경 지우는 중', succeeded: '완료', failed: '실패', canceled: '취소',
  });

  const q = value => (value ? `'${value}'` : '');
  const or = (value, fallback) => (value ? value : fallback);

  function groupOf(type) {
    return GROUP_OF[type] || 'edit';
  }

  /** Who did it: the email, or 로그인 없음 (an overlay key or login off). */
  function actorText(event) {
    return event && event.actor && event.actor.email ? event.actor.email : TEXT.anonymous;
  }

  /** The owner of a stored item: its uploader's email, or 기록 이전 for what predates the log. */
  function ownerText(owner) {
    return typeof owner === 'string' && owner ? owner : TEXT.unknownOwner;
  }

  /** { group, kind, text } for one event, in Korean. */
  function describeEvent(event) {
    const group = groupOf(event.type);
    const kind = KIND_LABEL[group];
    const character = or(q(event.characterName), '캐릭터');
    let text;
    switch (event.type) {
      case 'character.create': text = `캐릭터 ${character}을(를) 만들었습니다`; break;
      case 'character.rename': text = `캐릭터 이름을 ${or(q(event.from), '(이전 이름 모름)')} → ${q(event.name)}로 바꿨습니다`; break;
      case 'character.delete': text = `캐릭터 ${character}을(를) 지웠습니다`; break;
      case 'photo.add': text = `${character}에 사진을 추가했습니다`; break;
      case 'photo.delete': text = `${character}의 사진을 지웠습니다`; break;
      case 'photo.base': text = `${character}의 기본 사진을 바꿨습니다`; break;
      case 'motion.upload': text = `${character}에 동작 영상 ${or(q(event.motionName), '')}을(를) 올렸습니다${event.keyed ? ' (배경 제거됨)' : ''}`; break;
      case 'motion.add': text = `만든 동작 ${or(q(event.motionName), '')}을(를) 동작 목록에 추가했습니다`; break;
      case 'library.upload': text = `${event.kind === 'idle' ? '대기 영상' : '동작'} ${or(q(event.itemName), '')}을(를) 올렸습니다`; break;
      case 'media.delete': text = `동작·영상 ${or(q(event.itemName), '')}을(를) 지웠습니다`; break;
      case 'driving.upload': text = `동작 영상(참고용) ${or(q(event.drivingName), '')}을(를) 올렸습니다`; break;
      case 'driving.delete': text = `동작 영상(참고용) ${or(q(event.drivingName), '')}을(를) 지웠습니다`; break;
      case 'onair.set': text = event.photoId ? `${character}을(를) 방송에 올렸습니다` : '방송을 내렸습니다'; break;
      case 'motion.trigger': text = `${event.characterName ? `${character}의 ` : ''}동작 ${event.motionId === 'demo' ? '데모' : or(q(event.motionName), '')}을(를) 재생했습니다`; break;
      case 'job.create': {
        const parts = [event.characterName, event.routeLabel, event.drivingName].filter(Boolean).join(' · ');
        text = `동작 만들기를 요청했습니다${parts ? ` (${parts})` : ''}${Number.isFinite(event.credits) ? ` · ${event.credits.toLocaleString('ko-KR')} 크레딧` : ''}`;
        break;
      }
      default: text = event.type;
    }
    return { group, kind, text: text.replace(/\s{2,}/g, ' ') };
  }

  const pad = n => String(n).padStart(2, '0');

  /** '10/01 17:45' in the browser's time zone; '' for a bad date. */
  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function jobStateText(state) {
    return JOB_STATE[state] || String(state ?? '');
  }

  /** The query string of GET /api/admin/activity. */
  function eventsQuery({ type = '', email = '', before = '', limit = 100 } = {}) {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (email) params.set('email', String(email).trim().toLowerCase());
    if (before) params.set('before', before);
    params.set('limit', String(limit));
    return params.toString();
  }

  /** The server's Korean `error` text, else 'HTTP <status>' (or the offline text without a status). */
  function errorText(body, status) {
    const text = body && typeof body.error === 'string' ? body.error.trim() : '';
    if (text) return text;
    return status ? `HTTP ${status}` : TEXT.offline;
  }

  return { TEXT, groupOf, actorText, ownerText, describeEvent, formatTime, jobStateText, eventsQuery, errorText };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AdminActivityHelpers;

if (typeof document !== 'undefined') (() => {
  const H = AdminActivityHelpers;
  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 100;
  const state = { tab: 'users', events: [], exhausted: false, loaded: { users: false, library: false, events: false } };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  function setStatus(node, text) {
    node.textContent = text || '';
  }

  async function api(path) {
    let response;
    try {
      response = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch {
      throw Object.assign(new Error(H.TEXT.offline), { status: 0 });
    }
    let data = null;
    try { data = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw Object.assign(new Error(H.errorText(data, response.status)), { status: response.status, code: data && data.code });
    return data;
  }

  function pageMessage(text) {
    $('pageMessage').replaceChildren(...(text ? [el('p', { text, 'data-kind': 'error' })] : []));
  }

  function ownerNode(owner) {
    return el('span', { className: `owner${owner ? '' : ' is-unknown'}`, text: H.ownerText(owner) });
  }

  // ---- Tabs ----
  function showTab(name) {
    state.tab = name;
    for (const button of $('tabs').querySelectorAll('.tab')) button.setAttribute('aria-selected', String(button.dataset.tab === name));
    $('panelUsers').hidden = name !== 'users';
    $('panelLibrary').hidden = name !== 'library';
    $('panelEvents').hidden = name !== 'events';
    if (!state.loaded[name]) loadTab(name);
  }

  function loadTab(name) {
    const run = { users: loadUsers, library: loadLibrary, events: () => loadEvents(true) }[name];
    state.loaded[name] = true;
    return run().catch(handleError);
  }

  function handleError(error) {
    if (error.code === 'admin_only' || error.status === 403) {
      $('tabs').hidden = true;
      for (const id of ['panelUsers', 'panelLibrary', 'panelEvents']) $(id).hidden = true;
      pageMessage(H.TEXT.notAdmin);
      return;
    }
    pageMessage(error.message);
  }

  // ---- 사용자 ----
  async function loadUsers() {
    setStatus($('usersStatus'), '불러오는 중…');
    const { users } = await api('/api/admin/overview');
    setStatus($('usersStatus'), users.length ? '' : H.TEXT.noUsers);
    $('usersTable').hidden = users.length === 0;
    $('usersBody').replaceChildren(...users.map((user) => {
      const row = el('tr', { tabindex: '0' });
      const open = () => {
        $('emailFilter').value = user.email;
        showTab('events');
        loadEvents(true).catch(handleError);
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
      const num = value => el('td', { className: 'num', text: String(value) });
      row.append(
        el('td', {}, [el('span', { className: 'user-pick', text: user.email })]),
        el('td', { className: 'user-name', text: user.name || '' }),
        num(user.counts.upload), num(user.counts.edit), num(user.counts.onair), num(user.counts.play), num(user.counts.job),
        el('td', { className: 'user-time', text: H.formatTime(user.lastAt) }),
      );
      return row;
    }));
  }

  // ---- 올린 자료 ----
  function photoNode(photo) {
    const tags = [];
    if (photo.isBase) tags.push(el('span', { className: 'tag', text: '기본' }));
    if (photo.onAir) tags.push(el('span', { className: 'tag tag-live', text: '방송 중' }));
    const motions = photo.motions.length
      ? el('ul', { className: 'motion-list' }, photo.motions.map(motion => el('li', {}, [
        el('a', { href: motion.url, target: '_blank', rel: 'noopener', text: motion.name || '(이름 없음)' }),
        ownerNode(motion.owner),
      ])))
      : el('p', { className: 'motion-empty', text: '동작 없음' });
    return el('div', { className: `photo-admin${photo.onAir ? ' is-onair' : ''}` }, [
      el('a', { className: 'photo-img', href: photo.url, target: '_blank', rel: 'noopener' }, [el('img', { src: photo.displayUrl, alt: '', loading: 'lazy' })]),
      el('div', { className: 'photo-tags' }, tags),
      ownerNode(photo.owner),
      motions,
    ]);
  }

  async function loadLibrary() {
    setStatus($('libraryStatus'), '불러오는 중…');
    const data = await api('/api/admin/library');
    setStatus($('libraryStatus'), '');

    $('characterEmpty').hidden = data.characters.length > 0;
    $('characterList').replaceChildren(...data.characters.map(character => el('section', { className: 'char-admin' }, [
      el('div', { className: 'char-admin-head' }, [
        el('h3', { className: 'char-admin-name', text: character.name }),
        character.onAir ? el('span', { className: 'live-pill', text: '방송 중' }) : null,
        el('span', { className: 'owner', text: `만든 사람 ` }, [ownerNode(character.owner)]),
        el('span', { className: 'owner', text: `${H.formatTime(character.createdAt)} · 사진 ${character.photos.length}장` }),
      ]),
      el('div', { className: 'photo-row' }, character.photos.map(photoNode)),
    ])));

    $('drivingEmpty').hidden = data.drivings.length > 0;
    $('drivingList').replaceChildren(...data.drivings.map(driving => el('div', { className: 'driving-admin' }, [
      driving.url
        ? el('video', { src: driving.url, poster: driving.posterUrl || '', controls: true, preload: 'none', muted: true, playsinline: true })
        : el('div', { className: 'poster-empty' }),
      el('span', { className: 'driving-label', text: driving.label || '(이름 없음)' }),
      ownerNode(driving.owner),
      el('span', { className: 'owner', text: H.formatTime(driving.createdAt) }),
    ])));

    const jobs = data.jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    $('jobsEmpty').hidden = jobs.length > 0;
    $('jobsTable').hidden = jobs.length === 0;
    $('jobsBody').replaceChildren(...jobs.map(job => el('tr', { className: 'static-row' }, [
      el('td', { className: 'user-time', text: H.formatTime(job.createdAt) }),
      el('td', {}, [ownerNode(job.owner)]),
      el('td', { text: job.characterLabel || '' }),
      el('td', { text: job.routeLabel || '' }),
      el('td', { text: job.drivingLabel || '' }),
      el('td', { className: `job-state-${job.state}`, text: H.jobStateText(job.state), title: job.error || '' }),
      el('td', { className: 'num', text: Number.isFinite(job.credits) ? job.credits.toLocaleString('ko-KR') : '' }),
      el('td', {}, [job.resultUrl ? el('a', { href: job.resultUrl, target: '_blank', rel: 'noopener', text: '보기' }) : null]),
    ])));
  }

  // ---- 이력 ----
  function eventRow(event) {
    const info = H.describeEvent(event);
    return el('li', { className: 'event-row' }, [
      el('time', { className: 'event-time', dateTime: event.ts, text: H.formatTime(event.ts) }),
      el('span', { className: 'event-who', text: H.actorText(event) }),
      el('span', { className: 'event-what' }, [el('span', { className: `event-kind kind-${info.group}`, text: info.kind }), info.text]),
    ]);
  }

  async function loadEvents(reset) {
    const before = reset || !state.events.length ? '' : state.events[state.events.length - 1].ts;
    setStatus($('eventsStatus'), '불러오는 중…');
    const { events } = await api(`/api/admin/activity?${H.eventsQuery({ type: $('typeFilter').value, email: $('emailFilter').value, before, limit: PAGE_SIZE })}`);
    state.events = reset ? events : state.events.concat(events);
    state.exhausted = events.length < PAGE_SIZE;
    setStatus($('eventsStatus'), '');
    $('eventsEmpty').hidden = state.events.length > 0;
    $('eventList').replaceChildren(...state.events.map(eventRow));
    $('moreBtn').hidden = state.exhausted;
  }

  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) showTab(tab.dataset.tab);
  });
  $('typeFilter').addEventListener('change', () => loadEvents(true).catch(handleError));
  let filterTimer = null;
  $('emailFilter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => loadEvents(true).catch(handleError), 250);
  });
  $('moreBtn').addEventListener('click', () => loadEvents(false).catch(handleError));

  // ---- Boot: the first answer says whether this account is an admin ----
  api('/api/admin/overview').then(() => {
    $('tabs').hidden = false;
    showTab('users');
  }).catch(handleError);
})();
