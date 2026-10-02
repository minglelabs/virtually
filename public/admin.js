'use strict';

// Admin page (/admin, 크레딧 관리): add or take off an account's credits after a
// bank transfer (1 credit = 1 KRW), find accounts, and read one account's credit
// history. Only admins (adminEmails in data/billing/config.json) get answers from
// the admin routes; anyone else sees 관리자만 볼 수 있습니다. Emails, names, memos
// and labels are user data: the DOM is built with createElement/textContent only.
// The DOM-free helpers are require()-able from node tests (like billing.js, whose
// shared texts and formats this page reuses: admin.html loads billing.js first).
(function (root) {
  const B = root && root.VirtuallyBillingHelpers ? root.VirtuallyBillingHelpers : require('./billing.js');

  // The server's rules for POST /api/billing/admin/adjust and GET .../users.
  const MAX_EMAIL_LENGTH = 254;
  const MAX_CREDITS = 100000000;
  const MAX_MEMO_LENGTH = 200;
  const MAX_QUERY_LENGTH = 100;
  const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
  const SEARCH_DELAY_MS = 250;
  const USERS_PATH = '/api/billing/admin/users';
  const HISTORY_PATH = '/api/billing/admin/history';
  const ADJUST_PATH = '/api/billing/admin/adjust';

  const TEXT = Object.freeze({
    notAdmin: '관리자만 볼 수 있습니다.',
    pending: '아직 로그인한 적 없는 이메일입니다. 처음 로그인하면 반영됩니다.',
    loginBlocked: '이 이메일은 로그인 허용 목록(data/auth/config.json의 allowedEmails)에 없어 아직 로그인할 수 없습니다.',
    statusPending: '로그인 전',
    statusBlocked: '로그인 불가',
    noUsers: '아직 사용자가 없습니다.',
    noMatches: '찾는 사용자가 없습니다.',
    noHistory: '아직 내역이 없습니다.',
    badEmail: '위 목록에서 사용자를 선택해 주세요.',
    badCredits: '크레딧은 1부터 100,000,000까지의 정수로 적어 주세요.',
    badMemo: '메모는 200자까지 쓸 수 있습니다.',
    badRequest: '입력한 내용을 확인해 주세요.',
    saving: '처리하고 있습니다…',
    loading: '불러오는 중…',
    retrySafe: '같은 내용으로 다시 누르면 한 번만 반영됩니다.',
  });

  // POST .../adjust answers 400 bad_request with detail { field }.
  const FIELD_TEXTS = new Map([
    ['email', TEXT.badEmail],
    ['credits', TEXT.badCredits],
    ['memo', TEXT.badMemo],
  ]);

  // Refusals that are about the whole page, not one request.
  const PAGE_CODES = new Set(['admin_only', 'billing_disabled', 'billing_misconfigured']);

  /** An email as the server keeps it: trimmed and lower-cased ('' for anything else). */
  function normalizeEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /** One address the adjust route takes: one '@' with text on both sides, no spaces, at most 254 characters. */
  function isValidEmail(email) {
    if (typeof email !== 'string' || !email || email.length > MAX_EMAIL_LENGTH) return false;
    if (/[\s\u0000-\u001f\u007f]/.test(email)) return false;
    const at = email.indexOf('@');
    return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1;
  }

  /** The 크레딧 field as whole credits, 1..100,000,000 (commas and spaces allowed: '50,000'); null otherwise. */
  function parseCredits(value) {
    const digits = String(value ?? '').replace(/[,\s]/g, '');
    if (!/^\d{1,9}$/.test(digits)) return null;
    const credits = Number(digits);
    return credits >= 1 && credits <= MAX_CREDITS ? credits : null;
  }

  /** The memo as sent: trimmed ('' for none); null when it is longer than 200 characters. */
  function normalizeMemo(value) {
    const memo = typeof value === 'string' ? value.trim() : '';
    return memo.length <= MAX_MEMO_LENGTH ? memo : null;
  }

  /** "a@b.com에 50,000 크레딧을 충전할까요?" (credits > 0) / "…차감할까요?" (credits < 0). */
  function confirmText(email, credits) {
    return `${email}에 ${B.formatCredits(Math.abs(credits))} 크레딧을 ${credits < 0 ? '차감' : '충전'}할까요?`;
  }

  /**
   * The adjust body for the form fields and the pressed button ('topup' | 'deduct'),
   * without its requestId: { ok: true, body: { email, credits, memo? }, question }, or
   * { ok: false, field, text } for the first field to fix.
   */
  function adjustRequest(fields, action) {
    const email = normalizeEmail(fields && fields.email);
    if (!isValidEmail(email)) return { ok: false, field: 'email', text: TEXT.badEmail };
    const amount = parseCredits(fields && fields.credits);
    if (amount == null) return { ok: false, field: 'credits', text: TEXT.badCredits };
    const memo = normalizeMemo(fields && fields.memo);
    if (memo == null) return { ok: false, field: 'memo', text: TEXT.badMemo };
    const credits = action === 'deduct' ? -amount : amount;
    const body = { email, credits };
    if (memo) body.memo = memo;
    return { ok: true, body, question: confirmText(email, credits) };
  }

  /** One submit, for the requestId rule: the same email, signed credits and memo. */
  function submitKey(body) {
    return JSON.stringify([body.email, body.credits, body.memo || '']);
  }

  /**
   * The requestId of a confirmed submit: the previous attempt's when that attempt was
   * this same submit and got no definite answer (`retry` = { key, requestId }), so a
   * retry after a network error cannot apply twice; else a new one from makeId().
   */
  function requestIdFor(retry, body, makeId) {
    return retry && retry.key === submitKey(body) && REQUEST_ID_PATTERN.test(retry.requestId)
      ? retry.requestId
      : makeId();
  }

  /** True when an attempt may have been applied without the page hearing so: no answer, or a server error. */
  function outcomeUnknown(result) {
    return Boolean(result && result.ok !== true && (!(result.status > 0) || result.status >= 500));
  }

  /** A new requestId: crypto.randomUUID(), else 32 hex characters (getRandomValues, then Math.random). */
  function newRequestId(cryptoApi) {
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    const bytes = new Uint8Array(16);
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * The messages after an adjust answer: the account's new balance, then why the
   * customer may not see it yet (never signed in; not on the login allowlist).
   */
  function adjustMessages(answer) {
    const user = answer && answer.user && typeof answer.user === 'object' ? answer.user : {};
    const email = typeof user.email === 'string' ? user.email : '';
    const messages = [{ kind: 'success', text: `${email} 잔액 ${B.formatCredits(user.balance)} 크레딧` }];
    if (user.pending === true) messages.push({ kind: 'warn', text: TEXT.pending });
    if (answer && answer.loginAllowed === false) messages.push({ kind: 'warn', text: TEXT.loginBlocked });
    return messages;
  }

  /** Korean text for a failed admin request: bad_request names its field; the rest are the billing page's texts. */
  function adminErrorText(failure) {
    if (failure && failure.code === 'bad_request') {
      const field = failure.detail && typeof failure.detail === 'object' ? failure.detail.field : null;
      return FIELD_TEXTS.get(field) || TEXT.badRequest;
    }
    return B.apiErrorText(failure);
  }

  /**
   * The page message when an admin route refuses: not an admin, billing off or
   * misconfigured (the billing page's texts), or no answer. Null for an answer.
   */
  function refusalMessage(failure) {
    if (!failure || failure.ok === true) return null;
    if (failure.code === 'admin_only') return { kind: 'error', text: TEXT.notAdmin };
    if (failure.code === 'billing_disabled') return { kind: 'info', text: B.TEXT.disabled };
    if (failure.code === 'billing_misconfigured') {
      return { kind: 'error', text: B.invalidText(failure.detail && typeof failure.detail === 'object' ? failure.detail.problem : null) };
    }
    return { kind: 'error', text: B.apiErrorText(failure) };
  }

  /** True for a refusal that is about the whole page (admin_only, billing off or misconfigured). */
  function isPageRefusal(failure) {
    return Boolean(failure && failure.ok !== true && PAGE_CODES.has(failure.code));
  }

  /** '1크레딧 = 1원 · 원가 1달러 = 2,000 크레딧'; the first part alone without a valid rate. */
  function rateText(creditsPerUsd) {
    if (!Number.isInteger(creditsPerUsd) || creditsPerUsd < 1) return B.TEXT.rate;
    return `${B.TEXT.rate} · 원가 1달러 = ${B.formatCredits(creditsPerUsd)} 크레딧`;
  }

  /** The search box value as sent: trimmed, at most 100 characters. */
  function searchQuery(value) {
    return typeof value === 'string' ? value.trim().slice(0, MAX_QUERY_LENGTH) : '';
  }

  /** GET path of the users list for a search ('' = everyone). */
  function usersPath(query) {
    const q = searchQuery(query);
    return q ? `${USERS_PATH}?q=${encodeURIComponent(q)}` : USERS_PATH;
  }

  /** GET path of one account's history. */
  function historyPath(email) {
    return `${HISTORY_PATH}?email=${encodeURIComponent(String(email ?? ''))}`;
  }

  /** The 상태 column: '로그인 전' (credits wait for the first login), '로그인 불가' (not on the allowlist), both, or ''. */
  function userStatusText(user) {
    const parts = [];
    if (user && user.pending === true) parts.push(TEXT.statusPending);
    if (user && user.loginAllowed === false) parts.push(TEXT.statusBlocked);
    return parts.join(' · ');
  }

  /**
   * The address typed in the filter box, when it is a whole address that is not one of
   * the listed rows: it can be picked as it is (credits wait for its first login). Else ''.
   */
  function typedPick(query, rows) {
    const email = normalizeEmail(query);
    if (!isValidEmail(email) || !/\.[^.@\s]+$/.test(email)) return '';
    return (Array.isArray(rows) ? rows : []).some(row => row && row.email === email) ? '' : email;
  }

  /** One users-table row, or null for an entry without an email. */
  function userRow(user) {
    if (!user || typeof user !== 'object' || typeof user.email !== 'string' || !user.email) return null;
    return {
      email: user.email,
      name: typeof user.name === 'string' ? user.name : '',
      balance: B.formatCredits(user.balance),
      negative: typeof user.balance === 'number' && user.balance < 0,
      lastAt: B.formatHistoryTime(user.lastAt),
      at: typeof user.lastAt === 'string' ? user.lastAt : '',
      status: userStatusText(user),
    };
  }

  /** The users table for a GET .../users answer and the search that asked: { rows, empty, rate }. */
  function usersView(payload, query) {
    const rows = (Array.isArray(payload && payload.users) ? payload.users : []).map(userRow).filter(Boolean);
    const empty = rows.length > 0 ? null : searchQuery(query) ? TEXT.noMatches : TEXT.noUsers;
    return { rows, empty, rate: rateText(payload && payload.creditsPerUsd) };
  }

  /**
   * One account's history for a GET .../history answer: { email, summary, entries, empty }.
   * Entries are the billing page's history rows plus `by` (the admin who adjusted, or '').
   */
  function historyView(payload) {
    const email = payload && typeof payload.email === 'string' ? payload.email : '';
    const parts = email ? [email] : [];
    const balance = B.formatCredits(payload && payload.balance);
    if (balance) parts.push(`잔액 ${balance} 크레딧`);
    if (payload && payload.pending === true) parts.push(TEXT.statusPending);
    const entries = (Array.isArray(payload && payload.entries) ? payload.entries : [])
      .map((entry) => {
        const view = B.historyView(entry);
        return view && { ...view, by: typeof entry.by === 'string' ? entry.by : '' };
      })
      .filter(Boolean);
    return { email, summary: parts.join(' · '), entries, empty: entries.length > 0 ? null : TEXT.noHistory };
  }

  const api = Object.freeze({
    MAX_EMAIL_LENGTH,
    MAX_CREDITS,
    MAX_MEMO_LENGTH,
    MAX_QUERY_LENGTH,
    REQUEST_ID_PATTERN,
    SEARCH_DELAY_MS,
    TEXT,
    normalizeEmail,
    isValidEmail,
    parseCredits,
    normalizeMemo,
    confirmText,
    adjustRequest,
    submitKey,
    requestIdFor,
    outcomeUnknown,
    newRequestId,
    adjustMessages,
    adminErrorText,
    refusalMessage,
    isPageRefusal,
    rateText,
    searchQuery,
    usersPath,
    historyPath,
    userStatusText,
    typedPick,
    userRow,
    usersView,
    historyView,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;

  // ---- Page ----
  const document = root.document;
  const $ = id => document.getElementById(id);
  const pageMessage = $('adminMessage');
  const rateNode = $('rateText');
  const adjustCard = $('adjustCard');
  const adjustForm = $('adjustForm');
  const emailInput = $('emailInput');
  const creditsInput = $('creditsInput');
  const memoInput = $('memoInput');
  const topupBtn = $('topupBtn');
  const deductBtn = $('deductBtn');
  const adjustResult = $('adjustResult');
  const usersCard = $('usersCard');
  const searchInput = $('searchInput');
  const usersStatus = $('usersStatus');
  const usersTable = $('usersTable');
  const usersBody = $('usersBody');
  const usersEmpty = $('usersEmpty');
  const pickTypedBtn = $('pickTypedBtn');
  const historyCard = $('historyCard');
  const historySummary = $('historySummary');
  const historyStatus = $('historyStatus');
  const historyEmpty = $('historyEmpty');
  const historyList = $('historyList');
  const shared = root.VirtuallyBilling || null;

  let busy = false;
  let retry = null; // { key, requestId } of the last attempt that got no definite answer
  let usersSeq = 0;
  let historySeq = 0;
  let searchTimer = null;
  let selectedEmail = null;

  function el(tag, { className, text, attrs } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  // Message paragraphs (or none) in a live region.
  function showMessages(region, messages) {
    region.replaceChildren(...(messages || []).filter(m => m && m.text).map((message) => {
      const p = el('p', { text: message.text });
      if (message.kind) p.dataset.kind = message.kind;
      return p;
    }));
  }

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  /** GET or POST JSON: { ok: true, status, body } or { ok: false, status, code, error, detail }. */
  async function request(method, path, body) {
    const init = { method, headers: { Accept: 'application/json' } };
    if (body === undefined) init.cache = 'no-store';
    else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await root.fetch(path, init);
    } catch {
      return { ok: false, status: 0, code: 'network', error: null, detail: null };
    }
    let data = null;
    try {
      data = await response.json();
    } catch { /* empty or not JSON */ }
    if (response.ok) return { ok: true, status: response.status, body: data };
    return {
      ok: false,
      status: response.status,
      code: data && typeof data.code === 'string' ? data.code : null,
      error: data && typeof data.error === 'string' ? data.error : null,
      detail: data && data.detail !== undefined ? data.detail : null,
    };
  }

  // Not an admin, billing off or misconfigured: only the message stays.
  function showRefusal(failure) {
    showMessages(pageMessage, [refusalMessage(failure)]);
    rateNode.hidden = true;
    adjustCard.hidden = true;
    usersCard.hidden = true;
    historyCard.hidden = true;
  }

  function userItem(row) {
    const tr = el('tr', { className: row.email === selectedEmail ? 'is-selected' : '' }, [
      // The button makes the row reachable by keyboard; its click reaches the row's listener.
      el('th', { attrs: { scope: 'row' } }, [el('button', { className: 'user-pick', text: row.email, attrs: { type: 'button' } })]),
      el('td', { className: 'user-name', text: row.name }),
      el('td', { className: `num${row.negative ? ' is-negative' : ''}`, text: row.balance }),
      el('td', { className: 'user-time' }, [el('time', { text: row.lastAt, attrs: row.at ? { datetime: row.at } : {} })]),
      el('td', { className: 'user-status', text: row.status }),
    ]);
    tr.dataset.email = row.email;
    tr.addEventListener('click', () => selectUser(row.email));
    return tr;
  }

  function renderUsers(view) {
    usersBody.replaceChildren(...view.rows.map(userItem));
    usersTable.hidden = view.rows.length === 0;
    usersEmpty.textContent = view.empty || '';
    usersEmpty.hidden = !view.empty;
    // A whole address that is not in the list: offered as it is (someone who has not signed in yet).
    if (pickTypedBtn) {
      const typed = typedPick(searchInput.value, view.rows);
      pickTypedBtn.hidden = !typed;
      pickTypedBtn.textContent = typed ? `목록에 없는 '${typed}' 선택 (아직 로그인 전인 이메일)` : '';
      pickTypedBtn.dataset.email = typed;
    }
  }

  async function loadUsers() {
    usersSeq += 1;
    const seq = usersSeq;
    const query = searchInput.value;
    const result = await request('GET', usersPath(query));
    // Only the newest search draws.
    if (seq !== usersSeq) return;
    if (!result.ok) {
      // The first load decides the page; later, only a page-wide refusal replaces it.
      if (usersCard.hidden || isPageRefusal(result)) showRefusal(result);
      else setStatus(usersStatus, adminErrorText(result), 'error');
      return;
    }
    const view = usersView(result.body, query);
    showMessages(pageMessage, []);
    rateNode.textContent = view.rate;
    rateNode.hidden = false;
    adjustCard.hidden = false;
    usersCard.hidden = false;
    setStatus(usersStatus, '');
    renderUsers(view);
  }

  function historyItem(entry) {
    return el('li', { className: 'history-row' }, [
      el('time', { className: 'history-time', text: entry.time, attrs: entry.at ? { datetime: entry.at } : {} }),
      el('span', { className: 'history-label', text: entry.label }),
      entry.kind ? el('span', { className: 'badge history-kind', text: entry.kind }) : null,
      el('span', { className: `history-delta is-${entry.sign}`, text: entry.delta }),
      entry.by ? el('span', { className: 'history-by', text: entry.by }) : null,
    ]);
  }

  async function loadHistory(email) {
    historySeq += 1;
    const seq = historySeq;
    historyCard.hidden = false;
    historySummary.textContent = email;
    setStatus(historyStatus, TEXT.loading);
    const result = await request('GET', historyPath(email));
    if (seq !== historySeq) return;
    if (!result.ok) {
      setStatus(historyStatus, adminErrorText(result), 'error');
      historyList.replaceChildren();
      historyList.hidden = true;
      historyEmpty.hidden = true;
      return;
    }
    const view = historyView(result.body);
    setStatus(historyStatus, '');
    historySummary.textContent = view.summary || email;
    historyList.replaceChildren(...view.entries.map(historyItem));
    historyList.hidden = view.entries.length === 0;
    historyEmpty.textContent = view.empty || '';
    historyEmpty.hidden = !view.empty;
  }

  function selectUser(email) {
    selectedEmail = email;
    emailInput.value = email;
    for (const tr of usersBody.children) tr.className = tr.dataset.email === email ? 'is-selected' : '';
    loadHistory(email);
  }

  function setBusy(value) {
    busy = value;
    topupBtn.disabled = value;
    deductBtn.disabled = value;
  }

  const FIELDS = { email: emailInput, credits: creditsInput, memo: memoInput };

  async function submit(action) {
    if (busy) return;
    const prepared = adjustRequest({ email: emailInput.value, credits: creditsInput.value, memo: memoInput.value }, action);
    if (!prepared.ok) {
      showMessages(adjustResult, [{ kind: 'error', text: prepared.text }]);
      if (FIELDS[prepared.field] && typeof FIELDS[prepared.field].focus === 'function') FIELDS[prepared.field].focus();
      return;
    }
    if (!root.confirm(prepared.question)) return;
    const requestId = requestIdFor(retry, prepared.body, () => newRequestId(root.crypto));
    retry = null;
    setBusy(true);
    showMessages(adjustResult, [{ kind: 'pending', text: TEXT.saving }]);
    const result = await request('POST', ADJUST_PATH, { ...prepared.body, requestId });
    setBusy(false);
    if (!result.ok) {
      const messages = [{ kind: 'error', text: adminErrorText(result) }];
      if (outcomeUnknown(result)) {
        // Maybe applied: the same submit again reuses this requestId, so it counts once.
        retry = { key: submitKey(prepared.body), requestId };
        messages.push({ kind: 'info', text: TEXT.retrySafe });
      }
      showMessages(adjustResult, messages);
      return;
    }
    showMessages(adjustResult, adjustMessages(result.body));
    creditsInput.value = '';
    memoInput.value = '';
    const email = result.body && result.body.user && typeof result.body.user.email === 'string'
      ? result.body.user.email : prepared.body.email;
    selectedEmail = email;
    loadUsers();
    loadHistory(email);
    // The admin may have changed their own balance: redraw the header chip.
    if (shared && typeof shared.refresh === 'function') shared.refresh().catch(() => {});
  }

  topupBtn.addEventListener('click', () => submit('topup'));
  deductBtn.addEventListener('click', () => submit('deduct'));
  // Both buttons are type="button": Enter in a field never adjusts anything.
  adjustForm.addEventListener('submit', event => event.preventDefault());
  if (pickTypedBtn) pickTypedBtn.addEventListener('click', () => { if (pickTypedBtn.dataset.email) selectUser(pickTypedBtn.dataset.email); });
  searchInput.addEventListener('input', () => {
    root.clearTimeout(searchTimer);
    searchTimer = root.setTimeout(loadUsers, SEARCH_DELAY_MS);
  });

  loadUsers();
})(typeof window !== 'undefined' ? window : null);
