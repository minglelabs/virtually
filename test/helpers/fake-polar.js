'use strict';

// A dependency-free stand-in for the Polar API (Merchant of Record), for tests
// and a browser E2E: point createAppServer({ billing: { apiBase } }) at it.
//
//   const polar = await startFakePolar({ token, webhookSecret, webhookUrl? });
//   polar.apiBase                 // http://127.0.0.1:<port>/v1
//   polar.origin                  // http://127.0.0.1:<port>
//   polar.addProduct(fields)      // -> product (defaults + fields; `prices` replaces the default price)
//   await polar.pay(checkoutId, { units }?)   // -> the paid order (+ order.paid webhook)
//   await polar.refund(orderId, cents|null)   // -> the order (+ order.refunded webhook); null = the rest
//   await polar.renew(orderId)    // -> a subscription_cycle order (+ order.paid webhook)
//   polar.setWebhookUrl(url)      // null stops webhooks
//   polar.fail(kind|null)         // make API requests fail until fail(null)
//   polar.requests                // every /v1 request: { method, path, query, search, headers, body }
//   polar.sign(rawBody, { id, ts, scheme: 'standard'|'legacy' }) // -> webhook headers
//   await polar.close()
//
// Options beyond the contract: `now` (ms clock for timestamps and webhook
// signatures; share the one given to the app server) and `pageLimit` (the
// largest page it serves, so pagination can be tested with a few items).
// Also exposed: `deliveries` (webhooks sent: { id, type, status }),
// `deliver(type, data)` and the `checkouts` / `orders` / `customers` maps.
//
// The hosted checkout page GET <origin>/checkout/<id> pays an open checkout
// and 302s to its success_url with the literal "{CHECKOUT_ID}" replaced, so a
// browser can walk the whole flow. Webhooks are signed Standard Webhooks style.

const http = require('node:http');
const crypto = require('node:crypto');

const FAIL_KINDS = new Set([
  'down', // API requests: the connection is dropped without an answer
  'server_error', // API requests answer 500
  'unauthorized', // API requests answer 401
  'forbidden', // API requests answer 403 (a token without the needed scopes)
  'checkout_422', // POST /v1/checkouts/ answers 422
]);

const SECRET_PREFIX = 'whsec_';

function uuid() {
  return crypto.randomUUID();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __invalid: text };
  }
}

function firstActivePrice(product) {
  return (product.prices || []).find(price => price && price.is_archived !== true) || null;
}

function unitAmount(price) {
  if (!price) return 0;
  if (price.amount_type === 'fixed') return price.price_amount || 0;
  if (price.amount_type === 'custom') return price.preset_amount ?? price.minimum_amount ?? 0;
  return 0;
}

async function startFakePolar({ token, webhookSecret, webhookUrl = null, now = Date.now, pageLimit = 100 } = {}) {
  if (!token || !webhookSecret) throw new Error('startFakePolar needs token and webhookSecret.');
  const organizationId = uuid();
  const products = [];
  const checkouts = new Map();
  const orders = new Map();
  const customers = new Map();
  const requests = [];
  const deliveries = [];
  let failure = null;
  let hookUrl = webhookUrl;
  let base = '';

  const iso = () => new Date(now()).toISOString();

  function sign(rawBody, { id = `msg_${crypto.randomBytes(12).toString('hex')}`, ts = Math.floor(now() / 1000), scheme = 'standard' } = {}) {
    const key = scheme === 'legacy'
      ? Buffer.from(webhookSecret, 'utf8')
      : Buffer.from(webhookSecret.slice(SECRET_PREFIX.length), 'base64');
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const signature = crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), body])).digest('base64');
    return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${signature}` };
  }

  // POSTs a signed event to the webhook URL (when set). -> the HTTP status (0 = no answer).
  async function deliver(type, data) {
    if (!hookUrl) return null;
    const body = JSON.stringify({ type, timestamp: iso(), data });
    const headers = { 'Content-Type': 'application/json', ...sign(body) };
    let status = 0;
    try {
      const response = await fetch(hookUrl, { method: 'POST', headers, body });
      await response.arrayBuffer();
      status = response.status;
    } catch {
      status = 0;
    }
    deliveries.push({ id: headers['webhook-id'], type, status });
    return status;
  }

  function addProduct(fields = {}) {
    const product = {
      id: uuid(),
      created_at: iso(),
      modified_at: null,
      name: `Product ${products.length + 1}`,
      description: null,
      is_recurring: false,
      recurring_interval: null,
      is_archived: false,
      visibility: 'public',
      organization_id: organizationId,
      metadata: {},
      prices: [{
        id: uuid(), amount_type: 'fixed', price_amount: 1000, price_currency: 'usd', is_archived: false,
        type: 'one_time', recurring_interval: null,
      }],
      benefits: [],
      medias: [],
      attached_custom_fields: [],
      ...clone(fields),
    };
    products.push(product);
    return clone(product);
  }

  function customerFor(checkout) {
    for (const customer of customers.values()) {
      if (checkout.external_customer_id && customer.external_id === checkout.external_customer_id) return customer;
      if (!checkout.external_customer_id && !customer.external_id && customer.email === checkout.customer_email) return customer;
    }
    const customer = {
      id: uuid(),
      created_at: iso(),
      email: checkout.customer_email || 'buyer@example.com',
      email_verified: false,
      name: checkout.customer_name || null,
      external_id: checkout.external_customer_id || null,
      metadata: {},
      organization_id: organizationId,
    };
    customers.set(customer.id, customer);
    return customer;
  }

  function productSnapshot(product) {
    return {
      id: product.id, name: product.name, description: product.description, is_recurring: product.is_recurring,
      recurring_interval: product.recurring_interval, is_archived: product.is_archived, organization_id: organizationId,
      metadata: clone(product.metadata || {}),
    };
  }

  function makeOrder({ product, customer, checkoutId, subscriptionId, billingReason, metadata, units }) {
    const price = firstActivePrice(product);
    const net = unitAmount(price) * (units === undefined ? 1 : units);
    const order = {
      id: uuid(),
      created_at: iso(),
      modified_at: null,
      status: 'paid',
      paid: true,
      subtotal_amount: net,
      discount_amount: 0,
      net_amount: net,
      tax_amount: 0,
      total_amount: net,
      refunded_amount: 0,
      refunded_tax_amount: 0,
      currency: price ? price.price_currency : 'usd',
      billing_reason: billingReason,
      customer_id: customer.id,
      product_id: product.id,
      discount_id: null,
      subscription_id: subscriptionId,
      checkout_id: checkoutId,
      metadata: clone(metadata || {}),
      custom_field_data: {},
      customer: clone(customer),
      product: productSnapshot(product),
      items: [{ label: product.name, amount: net, tax_amount: 0, proration: false, product_price_id: price ? price.id : null }],
    };
    if (units !== undefined) order.units = units;
    orders.set(order.id, order);
    return order;
  }

  async function pay(checkoutId, { units } = {}) {
    const checkout = checkouts.get(checkoutId);
    if (!checkout) throw new Error(`Unknown checkout ${checkoutId}`);
    if (checkout.status !== 'open') throw new Error(`Checkout ${checkoutId} is ${checkout.status}`);
    const product = products.find(entry => entry.id === checkout.product_id);
    const customer = customerFor(checkout);
    checkout.status = 'succeeded';
    checkout.customer_id = customer.id;
    checkout.modified_at = iso();
    const order = makeOrder({
      product, customer, checkoutId,
      subscriptionId: product.is_recurring ? uuid() : null,
      billingReason: product.is_recurring ? 'subscription_create' : 'purchase',
      metadata: checkout.metadata,
      units,
    });
    await deliver('order.paid', clone(order));
    return clone(order);
  }

  async function renew(orderId) {
    const previous = orders.get(orderId);
    if (!previous || !previous.subscription_id) throw new Error(`Order ${orderId} is not a subscription order`);
    const product = products.find(entry => entry.id === previous.product_id);
    const order = makeOrder({
      product, customer: customers.get(previous.customer_id), checkoutId: null,
      subscriptionId: previous.subscription_id, billingReason: 'subscription_cycle', metadata: previous.metadata,
      units: previous.units,
    });
    await deliver('order.paid', clone(order));
    return clone(order);
  }

  async function refund(orderId, cents = null) {
    const order = orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    const left = order.net_amount - order.refunded_amount;
    order.refunded_amount += cents === null ? left : Math.min(cents, left);
    order.status = order.refunded_amount >= order.net_amount ? 'refunded' : 'partially_refunded';
    order.modified_at = iso();
    await deliver('order.refunded', clone(order));
    return clone(order);
  }

  function page(url, items) {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 10, 100, pageLimit));
    const number = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const start = (number - 1) * limit;
    return {
      items: clone(items.slice(start, start + limit)),
      pagination: { total_count: items.length, max_page: Math.max(1, Math.ceil(items.length / limit)) },
    };
  }

  function createCheckout(body) {
    const ids = body && Array.isArray(body.products) ? body.products : [];
    const chosen = ids.map(id => products.find(product => product.id === id));
    if (!ids.length || chosen.some(product => !product || product.is_archived)) {
      return [422, { detail: [{ loc: ['body', 'products'], msg: 'Product does not exist or is archived.', type: 'value_error' }] }];
    }
    const product = chosen[0];
    const price = firstActivePrice(product);
    const id = uuid();
    const checkout = {
      id,
      created_at: iso(),
      modified_at: null,
      status: 'open',
      client_secret: `polar_c_${crypto.randomBytes(16).toString('hex')}`,
      url: `${base}/checkout/${id}`,
      expires_at: new Date(now() + 60 * 60 * 1000).toISOString(),
      success_url: body.success_url ?? null,
      return_url: body.return_url ?? null,
      amount: unitAmount(price),
      currency: price ? price.price_currency : 'usd',
      product_id: product.id,
      product_price_id: price ? price.id : null,
      products: chosen.map(entry => clone(entry)),
      metadata: clone(body.metadata || {}),
      external_customer_id: body.external_customer_id ?? null,
      customer_id: null,
      customer_email: body.customer_email ?? null,
      customer_name: body.customer_name ?? null,
      customer_ip_address: body.customer_ip_address ?? null,
      organization_id: organizationId,
    };
    checkouts.set(id, checkout);
    return [201, clone(checkout)];
  }

  function listOrders(url) {
    const q = url.searchParams;
    let list = [...orders.values()];
    if (q.has('checkout_id')) list = list.filter(order => order.checkout_id === q.get('checkout_id'));
    if (q.has('customer_id')) list = list.filter(order => order.customer_id === q.get('customer_id'));
    if (q.has('external_customer_id')) list = list.filter(order => order.customer.external_id === q.get('external_customer_id'));
    for (const [key, value] of q) {
      const match = /^metadata\[(.+)\]$/.exec(key);
      if (match) list = list.filter(order => String(order.metadata[match[1]]) === value);
    }
    list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return page(url, list);
  }

  function createCustomerSession(body) {
    let customer = null;
    if (body && typeof body.customer_id === 'string') {
      customer = customers.get(body.customer_id) || null;
      if (!customer) return [422, { detail: [{ loc: ['body', 'customer_id'], msg: 'Customer does not exist.', type: 'value_error' }] }];
    } else if (body && typeof body.external_customer_id === 'string') {
      customer = [...customers.values()].find(entry => entry.external_id === body.external_customer_id) || null;
      if (!customer) return [404, { error: 'ResourceNotFound', detail: 'Customer not found.' }];
    } else {
      return [422, { detail: [{ loc: ['body'], msg: 'customer_id or external_customer_id is required.', type: 'value_error' }] }];
    }
    const sessionToken = `polar_cst_${crypto.randomBytes(16).toString('hex')}`;
    return [201, {
      id: uuid(),
      created_at: iso(),
      token: sessionToken,
      expires_at: new Date(now() + 60 * 60 * 1000).toISOString(),
      return_url: body.return_url ?? null,
      customer_portal_url: `${base}/portal?customer_session_token=${sessionToken}`,
      customer_id: customer.id,
      customer: clone(customer),
    }];
  }

  async function api(req, res, url) {
    const body = req.method === 'POST' ? await readJson(req) : null;
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      search: url.search,
      headers: { ...req.headers },
      body,
    });
    if (failure === 'down') return req.socket.destroy();
    if (failure === 'server_error') return send(res, 500, { error: 'InternalServerError' });
    if (failure === 'forbidden') return send(res, 403, { error: 'insufficient_scope', error_description: 'The token lacks a required scope.' });
    if (failure === 'unauthorized' || req.headers.authorization !== `Bearer ${token}`) {
      return send(res, 401, { error: 'invalid_token', error_description: 'The access token is invalid.' });
    }
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/v1/products/') {
      let list = products;
      if (url.searchParams.get('is_archived') === 'false') list = list.filter(product => !product.is_archived);
      if (url.searchParams.get('is_archived') === 'true') list = list.filter(product => product.is_archived);
      return send(res, 200, page(url, list));
    }
    if (req.method === 'POST' && pathname === '/v1/checkouts/') {
      if (failure === 'checkout_422') {
        return send(res, 422, { detail: [{ loc: ['body', 'customer_email'], msg: 'Invalid email.', type: 'value_error' }] });
      }
      const [status, value] = createCheckout(body);
      return send(res, status, value);
    }
    const checkoutMatch = /^\/v1\/checkouts\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && checkoutMatch) {
      const checkout = checkouts.get(checkoutMatch[1]);
      if (!checkout) return send(res, 404, { error: 'ResourceNotFound', detail: 'Not found' });
      return send(res, 200, clone(checkout));
    }
    if (req.method === 'GET' && pathname === '/v1/orders/') return send(res, 200, listOrders(url));
    if (req.method === 'POST' && pathname === '/v1/customer-sessions/') {
      const [status, value] = createCustomerSession(body);
      return send(res, status, value);
    }
    return send(res, 404, { error: 'ResourceNotFound', detail: 'Not found' });
  }

  // The hosted checkout page: pays an open checkout, then back to success_url.
  async function checkoutPage(req, res, id) {
    const checkout = checkouts.get(id);
    if (!checkout) return send(res, 404, { error: 'ResourceNotFound', detail: 'Not found' });
    if (checkout.status === 'open') await pay(id);
    if (!checkout.success_url) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><p>Paid.</p>\n');
    }
    res.writeHead(302, { Location: checkout.success_url.split('{CHECKOUT_ID}').join(id) });
    return res.end();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake-polar.invalid');
    (async () => {
      if (url.pathname.startsWith('/v1/')) return api(req, res, url);
      const hosted = /^\/checkout\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && hosted) return checkoutPage(req, res, hosted[1]);
      if (req.method === 'GET' && url.pathname === '/portal') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><p>Customer portal.</p>\n');
      }
      return send(res, 404, { error: 'ResourceNotFound', detail: 'Not found' });
    })().catch(error => {
      if (!res.headersSent) send(res, 500, { error: String(error && error.message) });
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    apiBase: `${base}/v1`,
    origin: base,
    requests,
    deliveries,
    checkouts,
    orders,
    customers,
    addProduct,
    pay,
    refund,
    renew,
    deliver,
    sign,
    setWebhookUrl(url) {
      hookUrl = url || null;
    },
    fail(kind) {
      if (kind != null && !FAIL_KINDS.has(kind)) throw new Error(`Unknown fake Polar failure: ${kind}`);
      failure = kind ?? null;
    },
    close() {
      server.closeAllConnections();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { startFakePolar, FAIL_KINDS };
