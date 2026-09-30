'use strict';

// The Polar API client (global fetch, no SDK) and the interpretation of the
// Polar payloads billing relies on: credit products and orders.
//
// Every call sends Authorization: Bearer <token>, Polar-Version, Accept (and
// Content-Type on POST) and gives up after 10 s. The token and the payloads
// are never logged.

const MAX_CREDITS = 10000000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PAGES = 50;
const INTERVALS = new Set(['day', 'week', 'month', 'year']);
const PRICE_TYPES = new Set(['fixed', 'custom', 'free']);
const PAID_STATUSES = new Set(['paid', 'partially_refunded', 'refunded']);
const MAX_SUB_LENGTH = 255;
const MAX_ID_LENGTH = 200;

class PolarError extends Error {
  // polarStatus: the HTTP status Polar answered, or null when it did not answer.
  constructor(message, polarStatus = null) {
    super(message);
    this.name = 'PolarError';
    this.polarStatus = polarStatus;
  }
}

// settings: { apiBase, accessToken, apiVersion }. `pathAndQuery` starts with "/".
async function polarRequest(settings, method, pathAndQuery, body, { log = () => {} } = {}) {
  const headers = {
    Authorization: `Bearer ${settings.accessToken}`,
    'Polar-Version': settings.apiVersion,
    Accept: 'application/json',
  };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  const where = `${method} ${pathAndQuery.split('?')[0]}`;
  let response;
  try {
    response = await fetch(`${settings.apiBase}${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log(`[billing] polar ${where} failed: ${error.name === 'TimeoutError' ? 'timeout' : 'no response'}`);
    throw new PolarError('Polar did not answer.', null);
  }
  let text = '';
  try {
    text = await response.text();
  } catch {
    log(`[billing] polar ${where} failed: body read error`);
    throw new PolarError('Polar did not answer.', null);
  }
  if (!response.ok) {
    log(`[billing] polar ${where} failed: HTTP ${response.status}`);
    throw new PolarError(`Polar answered HTTP ${response.status}.`, response.status);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    log(`[billing] polar ${where} failed: not a JSON object`);
    throw new PolarError('Polar answered with an unexpected body.', response.status);
  }
  return json;
}

// Every item of a paginated list: `firstPath` is page 1, `pagePath(N)` is
// page N >= 2, up to Polar's pagination.max_page (capped at MAX_PAGES).
async function listAll(settings, firstPath, pagePath, options) {
  const items = [];
  let page = 1;
  let maxPage = 1;
  do {
    const result = await polarRequest(settings, 'GET', page === 1 ? firstPath : pagePath(page), undefined, options);
    if (!Array.isArray(result.items)) throw new PolarError('Polar answered with an unexpected list.', 200);
    items.push(...result.items);
    const reported = result.pagination && Number(result.pagination.max_page);
    maxPage = Number.isInteger(reported) ? Math.min(reported, MAX_PAGES) : 1;
    page += 1;
  } while (page <= maxPage);
  return items;
}

// metadata.virtually_credits: an integer 1..10000000 or a string of digits
// in that range. Anything else -> null (not a credit product).
function creditValue(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata.virtually_credits;
  let value = null;
  if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'string' && /^\d{1,20}$/.test(raw)) value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_CREDITS ? value : null;
}

// The listing shape of a credit product, or null when it is not for sale here.
function productView(product) {
  if (!product || typeof product !== 'object' || typeof product.id !== 'string' || !product.id) return null;
  if (product.is_archived === true || product.visibility === 'draft') return null;
  const credits = creditValue(product.metadata);
  if (credits === null) return null;
  const price = (Array.isArray(product.prices) ? product.prices : []).find(entry => entry && typeof entry === 'object' && entry.is_archived !== true);
  if (!price || !PRICE_TYPES.has(price.amount_type)) return null;
  let amount = null;
  if (price.amount_type === 'fixed') amount = Number.isFinite(price.price_amount) ? price.price_amount : null;
  else if (price.amount_type === 'custom') amount = Number.isFinite(price.preset_amount) ? price.preset_amount : null;
  else amount = 0;
  const recurring = product.is_recurring === true;
  const interval = [product.recurring_interval, price.recurring_interval].find(value => INTERVALS.has(value)) || null;
  return {
    id: product.id,
    name: typeof product.name === 'string' ? product.name : '',
    description: typeof product.description === 'string' && product.description.trim() ? product.description : null,
    credits,
    recurring,
    interval: recurring ? interval : null,
    price: { type: price.amount_type, amount, currency: typeof price.price_currency === 'string' ? price.price_currency : null },
  };
}

// One-time packs before subscriptions, then credits ascending (stable).
function sortProducts(list) {
  return list.slice().sort((a, b) => (Number(a.recurring) - Number(b.recurring)) || (a.credits - b.credits));
}

function subOf(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SUB_LENGTH && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

function emailOf(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 320 ? email : null;
}

function amountOf(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// What billing needs from a Polar order, or null when it has no usable id.
// credits is the product's credits x units (null: not a credit order).
function orderFacts(order) {
  if (!order || typeof order !== 'object' || typeof order.id !== 'string' || !order.id || order.id.length > MAX_ID_LENGTH) return null;
  const product = order.product && typeof order.product === 'object' ? order.product : null;
  const metadata = order.metadata && typeof order.metadata === 'object' ? order.metadata : {};
  const customer = order.customer && typeof order.customer === 'object' ? order.customer : {};
  const perUnit = product ? creditValue(product.metadata) : null;
  const units = Number.isSafeInteger(order.units) && order.units > 1 ? order.units : 1;
  const credits = perUnit !== null && Number.isSafeInteger(perUnit * units) ? perUnit * units : null;
  const externalId = typeof customer.external_id === 'string' && customer.external_id.startsWith('google:')
    ? subOf(customer.external_id.slice('google:'.length))
    : null;
  const customerId = [order.customer_id, customer.id].find(value => typeof value === 'string' && value && value.length <= MAX_ID_LENGTH) || null;
  const status = typeof order.status === 'string' ? order.status : null;
  return {
    id: order.id,
    status,
    paid: order.paid === true || PAID_STATUSES.has(status),
    reason: typeof order.billing_reason === 'string' ? order.billing_reason : null,
    credits,
    netAmount: amountOf(order.net_amount),
    refundedAmount: amountOf(order.refunded_amount),
    checkoutId: typeof order.checkout_id === 'string' && order.checkout_id.length <= MAX_ID_LENGTH ? order.checkout_id : null,
    customerId,
    metadataUser: subOf(metadata.virtually_user),
    metadataEmail: emailOf(metadata.virtually_email),
    externalUser: externalId,
    email: emailOf(customer.email),
    label: product && typeof product.name === 'string' && product.name.trim() ? product.name.trim().slice(0, 200) : 'Polar order',
  };
}

module.exports = {
  MAX_CREDITS,
  PolarError,
  creditValue,
  listAll,
  orderFacts,
  polarRequest,
  productView,
  sortProducts,
};
