'use strict';

// Billing page (/billing): the credit balance (1 credit = 1 KRW), how to top up
// (bank transfer to the admin, the config's transferNote), this account's credit
// history and, when Polar is configured, the Polar credit products (bought or
// subscribed on Polar's hosted checkout) and the Polar customer portal, all from
// GET /api/billing. Back from Polar (?checkout_id=), it asks the server to check
// the payment until the credits arrive. Product names, descriptions, the transfer
// note and history labels are data: the DOM is built with createElement/textContent
// only. The DOM-free helpers are require()-able from node tests (like login.js) and
// shared with the admin page as window.VirtuallyBillingHelpers. auth.js (loaded
// first) shares the GET /api/billing payload through window.VirtuallyBilling and
// keeps the credits chip in the header in step with every reload.
(function (root) {
  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS = 60000;
  // Same rule as the server's POST /api/billing/sync.
  const CHECKOUT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

  const TEXT = Object.freeze({
    disabled: '크레딧 결제가 꺼져 있습니다. data/billing/config.json을 만들면 켜집니다(README 참고).',
    invalid: '결제 설정에 문제가 있습니다',
    balance: '보유 크레딧',
    rate: '1크레딧 = 1원',
    transferDefault: '충전은 관리자에게 문의해 주세요.',
    credits: '크레딧',
    buy: '구매',
    subscribe: '구독',
    customAmount: '금액 변경 가능',
    customOpen: '금액 직접 입력',
    freePrice: '무료',
    noProducts: '판매 중인 크레딧 상품이 없습니다. Polar에서 상품 메타데이터에 virtually_credits(예: 500)를 넣어 주세요.',
    checking: '결제를 확인하고 있습니다…',
    notCompleted: '결제가 완료되지 않았습니다.',
    slow: "결제 확인이 늦어지고 있습니다. 잠시 후 '결제 내역 다시 확인'을 눌러 주세요.",
    offline: '서버에 연결하지 못했습니다.',
    insufficientBalance: '잔액보다 많이 차감할 수 없습니다',
  });

  // GET /api/billing `problem` codes (mode 'invalid'), in the server's checking order.
  const PROBLEM_TEXTS = new Map([
    ['invalid_json', '결제 설정 파일의 JSON 형식이 올바르지 않습니다.'],
    ['bad_admin_emails', 'adminEmails에 관리자 이메일을 넣어 주세요.'],
    ['bad_server', 'polar.server는 sandbox 또는 production이어야 합니다.'],
    ['missing_token', 'polar.accessToken이 필요합니다.'],
    ['bad_webhook_secret', 'polar.webhookSecret은 whsec_로 시작해야 합니다.'],
    ['bad_api_version', 'polar.apiVersion은 2026-10 같은 형식이어야 합니다.'],
    ['bad_credits_per_usd', 'creditsPerUsd는 1 이상의 정수여야 합니다.'],
    ['bad_free_emails', 'freeEmails는 이메일 목록이어야 합니다.'],
    ['bad_welcome_credits', 'welcomeCredits는 0 이상의 정수여야 합니다.'],
    ['bad_transfer_note', 'transferNote는 1000자 이하의 글이어야 합니다.'],
    ['login_required', '크레딧 결제를 쓰려면 Google 로그인을 먼저 켜야 합니다.'],
  ]);

  // Error `code`s of the billing and admin routes; 'network' = the request did not
  // complete. insufficient_balance is built by apiErrorText (it names the balance).
  const ERROR_TEXTS = new Map([
    ['unknown_product', '이 상품은 지금 살 수 없습니다. 새로고침해 주세요.'],
    ['polar_error', 'Polar 요청이 실패했습니다. 잠시 후 다시 시도해 주세요.'],
    ['billing_misconfigured', '결제 설정에 문제가 있어 지금은 결제할 수 없습니다.'],
    ['billing_disabled', '크레딧 결제가 꺼져 있습니다.'],
    ['no_customer', '아직 결제 내역이 없습니다.'],
    ['checkout_missing', '이 결제를 찾지 못했습니다.'],
    ['polar_disabled', '카드 결제(Polar)는 아직 설정되지 않았습니다.'],
    ['admin_only', '관리자만 쓸 수 있습니다.'],
    ['network', '서버에 연결하지 못했습니다.'],
  ]);

  // GET /api/billing `productsError` (the product list could not be refreshed from Polar).
  const PRODUCTS_ERROR_TEXTS = new Map([
    ['polar_unreachable', 'Polar에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
    ['polar_unauthorized', 'Polar 액세스 토큰(polar.accessToken)을 확인해 주세요.'],
  ]);

  // Ledger entry kinds (topup / deduct: an admin's adjustment).
  const KIND_TEXTS = new Map([
    ['grant', '충전'],
    ['revoke', '환불로 회수'],
    ['charge', '사용'],
    ['refund', '돌려받음'],
    ['welcome', '가입 환영'],
    ['topup', '충전'],
    ['deduct', '차감'],
  ]);

  const INTERVAL_SUFFIXES = new Map([
    ['day', '/일'],
    ['week', '/주'],
    ['month', '/월'],
    ['year', '/년'],
  ]);

  // Sync answers that polling again cannot change; any other failure is retried until the timeout.
  const FINAL_SYNC_CODES = new Set(['checkout_missing', 'bad_request', 'billing_disabled', 'billing_misconfigured',
    'polar_disabled']);
  const FAILED_CHECKOUT_STATUSES = new Set(['expired', 'failed']);

  /** A credit count as every page shows it: '1,234', '-50'; '' when it is not a number. */
  function formatCredits(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR') : '';
  }

  /** Korean text for a config problem code, or null when it is unknown. */
  function problemText(code) {
    return PROBLEM_TEXTS.get(code) || null;
  }

  /** The mode 'invalid' message, with the problem when it is known. */
  function invalidText(problem) {
    const detail = problemText(problem);
    return detail ? `${TEXT.invalid}: ${detail}` : `${TEXT.invalid}.`;
  }

  /**
   * Korean text for a failed billing request `{ code, error?, status?, detail? }`: the
   * mapped code, else the server's own message, else `HTTP <status>`, else the
   * network text. insufficient_balance names detail.balance when it has one.
   */
  function apiErrorText(failure) {
    const code = failure && typeof failure.code === 'string' ? failure.code : null;
    if (code === 'insufficient_balance') {
      const balance = formatCredits(failure.detail && typeof failure.detail === 'object' ? failure.detail.balance : null);
      return balance ? `${TEXT.insufficientBalance} (잔액 ${balance})` : TEXT.insufficientBalance;
    }
    const known = code ? ERROR_TEXTS.get(code) : null;
    if (known) return known;
    const message = failure && typeof failure.error === 'string' ? failure.error.trim() : '';
    if (message) return message;
    if (failure && Number.isInteger(failure.status) && failure.status > 0) return `HTTP ${failure.status}`;
    return ERROR_TEXTS.get('network');
  }

  /** Korean text for GET /api/billing `productsError`, or null. */
  function productsErrorText(code) {
    return PRODUCTS_ERROR_TEXTS.get(code) || null;
  }

  /** Korean text for a ledger entry kind, or '' when it is unknown. */
  function kindText(kind) {
    return KIND_TEXTS.get(kind) || '';
  }

  /** '/월' for a monthly subscription interval, '' for none or an unknown one. */
  function intervalSuffix(interval) {
    return INTERVAL_SUFFIXES.get(interval) || '';
  }

  /**
   * An amount in the currency's minor unit as en-US currency text: usd 999 ->
   * '$9.99', krw 10000 -> '₩10,000'. Null for a bad amount or currency code.
   */
  function formatMoney(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    if (typeof currency !== 'string' || !currency.trim()) return null;
    let format;
    try {
      format = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.trim().toUpperCase() });
    } catch {
      return null;
    }
    return format.format(amount / 10 ** format.resolvedOptions().maximumFractionDigits);
  }

  /**
   * A product's price text: '$9.99', '$9.99/월', '$5.00 · 금액 변경 가능',
   * '금액 직접 입력' or '무료'; '' when the price is unusable.
   */
  function priceText(product) {
    const price = product && product.price && typeof product.price === 'object' ? product.price : null;
    if (!price) return '';
    if (price.type === 'free') return TEXT.freePrice;
    const suffix = product.recurring === true ? intervalSuffix(product.interval) : '';
    const money = Number.isInteger(price.amount) ? formatMoney(price.amount, price.currency) : null;
    if (price.type === 'custom') return money ? `${money}${suffix} · ${TEXT.customAmount}` : TEXT.customOpen;
    if (price.type === 'fixed') return money ? `${money}${suffix}` : '';
    return '';
  }

  /** The product button: '구독' for a subscription, '구매' for a one-time pack. */
  function buyLabel(product) {
    return product && product.recurring === true ? TEXT.subscribe : TEXT.buy;
  }

  /** How to top up: the config's transferNote as written (line breaks kept), else the default text. */
  function transferText(note) {
    return typeof note === 'string' && note.trim() ? note : TEXT.transferDefault;
  }

  /** '보유 크레딧 1,234' (negative balances as they are), or '' without a number. */
  function balanceText(balance) {
    const value = formatCredits(balance);
    return value ? `${TEXT.balance} ${value}` : '';
  }

  /** "크레딧 500개가 충전되었습니다." */
  function grantedText(granted) {
    return `${TEXT.credits} ${formatCredits(granted)}개가 충전되었습니다.`;
  }

  /** A history time in local time, 'M월 D일 HH:mm'; '' when it is not a date. */
  function formatHistoryTime(value) {
    const t = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(t)) return '';
    const date = new Date(t);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}월 ${date.getDate()}일 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** '+500', '-24', '0'; '' when it is not a number. */
  function deltaText(delta) {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return '';
    return delta > 0 ? `+${formatCredits(delta)}` : formatCredits(delta);
  }

  /** What one product card shows, or null for an entry without an id. */
  function productView(product) {
    if (!product || typeof product !== 'object' || typeof product.id !== 'string' || !product.id) return null;
    const credits = formatCredits(product.credits);
    return {
      id: product.id,
      name: typeof product.name === 'string' ? product.name : '',
      description: typeof product.description === 'string' && product.description.trim() ? product.description : null,
      credits: credits ? `${TEXT.credits} ${credits}` : '',
      price: priceText(product),
      button: buyLabel(product),
    };
  }

  /** What one history row shows, or null for an entry that is not an object. */
  function historyView(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const delta = typeof entry.delta === 'number' && Number.isFinite(entry.delta) ? entry.delta : null;
    return {
      id: typeof entry.id === 'string' ? entry.id : '',
      time: formatHistoryTime(entry.at),
      at: typeof entry.at === 'string' ? entry.at : '',
      label: typeof entry.label === 'string' ? entry.label : '',
      kind: kindText(entry.kind),
      delta: deltaText(delta),
      sign: delta == null || delta === 0 ? 'zero' : delta > 0 ? 'plus' : 'minus',
    };
  }

  /**
   * What the page shows for a GET /api/billing payload (null when the request failed):
   * { mode: 'offline'|'disabled'|'invalid'|'enabled', message: { kind, text }|null,
   *   balance, rate, transfer, polar, sandbox, free, canManage, isAdmin,
   *   products: [productView], productsNote: { kind, text }|null, history: [historyView] }.
   * Without Polar (polar: false) there are no products, no portal and no sync button;
   * a payload without the field (an older server) counts as Polar on.
   */
  function billingView(payload) {
    const view = {
      mode: 'offline',
      message: null,
      balance: '',
      rate: '',
      transfer: '',
      polar: false,
      sandbox: false,
      free: false,
      canManage: false,
      isAdmin: false,
      products: [],
      productsNote: null,
      history: [],
    };
    if (!payload || typeof payload !== 'object') {
      view.message = { kind: 'error', text: TEXT.offline };
      return view;
    }
    if (payload.enabled !== true) {
      view.mode = 'disabled';
      view.message = { kind: 'info', text: TEXT.disabled };
      return view;
    }
    if (payload.mode !== 'enabled') {
      view.mode = 'invalid';
      view.message = { kind: 'error', text: invalidText(payload.problem) };
      return view;
    }
    view.mode = 'enabled';
    view.balance = balanceText(payload.balance);
    view.rate = TEXT.rate;
    view.transfer = transferText(payload.transferNote);
    view.polar = payload.polar !== false;
    view.sandbox = view.polar && payload.server === 'sandbox';
    view.free = payload.free === true;
    view.canManage = view.polar && payload.canManage === true;
    view.isAdmin = payload.isAdmin === true;
    if (view.polar) {
      view.products = (Array.isArray(payload.products) ? payload.products : []).map(productView).filter(Boolean);
      const productsError = productsErrorText(payload.productsError);
      if (productsError) view.productsNote = { kind: 'error', text: productsError };
      else if (view.products.length === 0) view.productsNote = { kind: 'info', text: TEXT.noProducts };
    }
    view.history = (Array.isArray(payload.history) ? payload.history : []).map(historyView).filter(Boolean);
    return view;
  }

  /** ?checkout_id= of the return from Polar: { present, id }; id is null when it is not a valid id. */
  function readCheckoutParam(search) {
    const params = new URLSearchParams(typeof search === 'string' ? search : '');
    if (!params.has('checkout_id')) return { present: false, id: null };
    const value = params.get('checkout_id');
    return { present: true, id: CHECKOUT_ID_PATTERN.test(value) ? value : null };
  }

  /** The page URL without ?checkout_id= (other parameters and the hash stay). */
  function urlWithoutCheckout(pathname, search, hash) {
    const params = new URLSearchParams(typeof search === 'string' ? search : '');
    params.delete('checkout_id');
    const query = params.toString();
    const path = typeof pathname === 'string' && pathname ? pathname : '/billing';
    return `${path}${query ? `?${query}` : ''}${typeof hash === 'string' ? hash : ''}`;
  }

  /**
   * The return-from-Polar poll after one POST /api/billing/sync answer:
   * `result` = { ok: true, body } or { ok: false, code, error?, status? } (code
   * 'network' when the request did not complete); `elapsedMs` since the first
   * request. Returns { stop, kind: 'pending'|'success'|'error'|'warn', text }.
   */
  function checkoutPoll(result, elapsedMs) {
    if (result && result.ok === true) {
      const checkout = result.body && result.body.checkout && typeof result.body.checkout === 'object'
        ? result.body.checkout : null;
      const granted = checkout && typeof checkout.granted === 'number' && Number.isFinite(checkout.granted)
        ? checkout.granted : 0;
      if (granted > 0) return { stop: true, kind: 'success', text: grantedText(granted) };
      if (checkout && FAILED_CHECKOUT_STATUSES.has(checkout.status)) {
        return { stop: true, kind: 'error', text: TEXT.notCompleted };
      }
    } else if (result && FINAL_SYNC_CODES.has(result.code)) {
      return { stop: true, kind: 'error', text: apiErrorText(result) };
    }
    if (!(elapsedMs < POLL_TIMEOUT_MS)) return { stop: true, kind: 'warn', text: TEXT.slow };
    return { stop: false, kind: 'pending', text: TEXT.checking };
  }

  /** An http(s) URL the page may navigate to (Polar checkout / portal), else null. */
  function navigableUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  const api = Object.freeze({
    POLL_INTERVAL_MS,
    POLL_TIMEOUT_MS,
    CHECKOUT_ID_PATTERN,
    TEXT,
    formatCredits,
    problemText,
    invalidText,
    apiErrorText,
    productsErrorText,
    kindText,
    intervalSuffix,
    formatMoney,
    priceText,
    buyLabel,
    transferText,
    balanceText,
    grantedText,
    formatHistoryTime,
    deltaText,
    productView,
    historyView,
    billingView,
    readCheckoutParam,
    urlWithoutCheckout,
    checkoutPoll,
    navigableUrl,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root) return;
  // The admin page loads this file for the shared texts only.
  if (!root.VirtuallyBillingHelpers) root.VirtuallyBillingHelpers = api;
  if (!root.document || !root.document.getElementById('billingMessage')) return;

  // ---- Page ----
  const document = root.document;
  const $ = id => document.getElementById(id);
  const pageMessage = $('billingMessage');
  const checkoutMessage = $('checkoutMessage');
  const summaryCard = $('summaryCard');
  const balanceNode = $('balanceText');
  const rateNode = $('rateText');
  const sandboxBadge = $('sandboxBadge');
  const sandboxNote = $('sandboxNote');
  const freeNote = $('freeNote');
  const summaryActions = $('summaryActions');
  const adminLink = $('adminLink');
  const portalBtn = $('portalBtn');
  const syncBtn = $('syncBtn');
  const summaryStatus = $('summaryStatus');
  const transferCard = $('transferCard');
  const transferNote = $('transferNote');
  const productsCard = $('productsCard');
  const productsNote = $('productsNote');
  const productList = $('productList');
  const productsStatus = $('productsStatus');
  const historyCard = $('historyCard');
  const historyEmpty = $('historyEmpty');
  const historyList = $('historyList');
  const shared = root.VirtuallyBilling || null;

  let busy = false;
  let buyButtons = [];
  let loadSeq = 0;

  function el(tag, { className, text, attrs } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  // One message paragraph (or none) in a live region.
  function showMessage(region, message) {
    if (!message || !message.text) {
      region.replaceChildren();
      return;
    }
    const p = el('p', { text: message.text });
    if (message.kind) p.dataset.kind = message.kind;
    region.replaceChildren(p);
  }

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  function applyBusy() {
    for (const button of [portalBtn, syncBtn, ...buyButtons]) button.disabled = busy;
  }

  function setBusy(value) {
    busy = value;
    applyBusy();
  }

  function productItem(product) {
    const button = el('button', { className: 'btn btn-sm product-buy', text: product.button, attrs: { type: 'button' } });
    button.addEventListener('click', () => buy(product));
    buyButtons.push(button);
    return el('li', { className: 'product' }, [
      el('div', { className: 'product-main' }, [
        el('h3', { className: 'product-name', text: product.name }),
        product.description ? el('p', { className: 'product-desc', text: product.description }) : null,
      ]),
      el('div', { className: 'product-side' }, [
        product.credits ? el('span', { className: 'product-credits', text: product.credits }) : null,
        product.price ? el('span', { className: 'product-price', text: product.price }) : null,
        button,
      ]),
    ]);
  }

  function historyItem(entry) {
    return el('li', { className: 'history-row' }, [
      el('time', { className: 'history-time', text: entry.time, attrs: entry.at ? { datetime: entry.at } : {} }),
      el('span', { className: 'history-label', text: entry.label }),
      entry.kind ? el('span', { className: 'badge history-kind', text: entry.kind }) : null,
      el('span', { className: `history-delta is-${entry.sign}`, text: entry.delta }),
    ]);
  }

  function render(view) {
    showMessage(pageMessage, view.message);
    const enabled = view.mode === 'enabled';
    summaryCard.hidden = !enabled;
    transferCard.hidden = !enabled;
    productsCard.hidden = !enabled || !view.polar;
    historyCard.hidden = !enabled;
    buyButtons = [];
    if (enabled) {
      balanceNode.textContent = view.balance;
      rateNode.textContent = view.rate;
      rateNode.hidden = !view.rate;
      sandboxBadge.hidden = !view.sandbox;
      sandboxNote.hidden = !view.sandbox;
      freeNote.hidden = !view.free;
      adminLink.hidden = !view.isAdmin;
      portalBtn.hidden = !view.canManage;
      syncBtn.hidden = !view.polar;
      summaryActions.hidden = adminLink.hidden && portalBtn.hidden && syncBtn.hidden;
      transferNote.textContent = view.transfer;
      productsNote.textContent = view.productsNote ? view.productsNote.text : '';
      if (view.productsNote) productsNote.dataset.kind = view.productsNote.kind;
      else delete productsNote.dataset.kind;
      productsNote.hidden = !view.productsNote;
      productList.replaceChildren(...view.products.map(productItem));
      productList.hidden = view.products.length === 0;
      historyEmpty.hidden = view.history.length > 0;
      historyList.replaceChildren(...view.history.map(historyItem));
      historyList.hidden = view.history.length === 0;
    } else {
      productList.replaceChildren();
      historyList.replaceChildren();
    }
    applyBusy();
  }

  // GET /api/billing: through auth.js when it is loaded (the chip redraws too), else directly.
  async function fetchPayload() {
    if (shared && typeof shared.refresh === 'function') return shared.refresh();
    try {
      const response = await root.fetch('/api/billing', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body && typeof body === 'object' ? body : null;
    } catch {
      return null;
    }
  }

  // Draws the payload `pending` resolves, unless a newer load started meanwhile.
  async function show(pending) {
    loadSeq += 1;
    const seq = loadSeq;
    let payload = null;
    try {
      payload = await pending;
    } catch { /* drawn as offline */ }
    if (seq === loadSeq) render(billingView(payload));
  }

  const reload = () => show(fetchPayload());

  /** POST a JSON body: { ok: true, status, body } or { ok: false, status, code, error, detail }. */
  async function post(path, body) {
    let response;
    try {
      response = await root.fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
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

  // Checkout and portal: the server answers { url } on Polar, and the browser goes there.
  async function goToPolar(path, body, statusNode) {
    if (busy) return;
    setBusy(true);
    setStatus(summaryStatus, '');
    setStatus(productsStatus, '');
    const result = await post(path, body);
    const url = result.ok ? navigableUrl(result.body && result.body.url) : null;
    if (url) {
      // Stay busy: the page is being left.
      root.location.assign(url);
      return;
    }
    setStatus(statusNode, apiErrorText(result.ok ? { code: 'polar_error' } : result), 'error');
    setBusy(false);
  }

  function buy(product) {
    return goToPolar('/api/billing/checkout', { productId: product.id }, productsStatus);
  }

  portalBtn.addEventListener('click', () => goToPolar('/api/billing/portal', {}, summaryStatus));

  syncBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    setStatus(summaryStatus, '');
    const result = await post('/api/billing/sync', {});
    if (!result.ok) setStatus(summaryStatus, apiErrorText(result), 'error');
    await reload();
    setBusy(false);
  });

  const sleep = ms => new Promise(resolve => root.setTimeout(resolve, ms));

  // Back from Polar: check the checkout at once and every 2 s until it is decided or 60 s pass.
  async function watchCheckout(param) {
    showMessage(checkoutMessage, { kind: 'pending', text: TEXT.checking });
    let outcome;
    if (!param.id) {
      outcome = { stop: true, kind: 'error', text: apiErrorText({ code: 'checkout_missing' }) };
    } else {
      const started = Date.now();
      for (;;) {
        outcome = checkoutPoll(await post('/api/billing/sync', { checkoutId: param.id }), Date.now() - started);
        if (outcome.stop) break;
        await sleep(POLL_INTERVAL_MS);
      }
    }
    showMessage(checkoutMessage, outcome);
    try {
      const { pathname, search, hash } = root.location;
      root.history.replaceState(root.history.state, '', urlWithoutCheckout(pathname, search, hash));
    } catch { /* the address bar keeps the id; nothing else depends on it */ }
    await reload();
  }

  show(shared && shared.ready && typeof shared.ready.then === 'function' ? shared.ready : fetchPayload());
  const checkout = readCheckoutParam(root.location.search);
  if (checkout.present) watchCheckout(checkout);

  // Back from Polar with the browser's back button, the page may come from the
  // back-forward cache with its buttons still disabled: free them and reload.
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('pageshow', (event) => {
      if (!event || !event.persisted) return;
      setBusy(false);
      reload();
    });
  }
})(typeof window !== 'undefined' ? window : null);
