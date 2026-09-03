'use strict';

/* PFA store -> CCAvenue handoff.
 *
 * Deliberately mirrors ccavenue-request.js: same encryption, same IV, same
 * auto-submit page, same env vars. The difference is what is being paid for.
 *
 * The browser posts items=[{id,size,qty}] and nothing else. Price, shipping
 * and total are computed here from api/_products.js. A localStorage cart is
 * fully editable by the visitor, so any price arriving from the browser is
 * ignored on purpose.
 *
 * Required Vercel environment variables (same as donations):
 *   CCAVENUE_MERCHANT_ID
 *   CCAVENUE_ACCESS_CODE
 *   CCAVENUE_WORKING_KEY
 *   CCAVENUE_MODE=production      (anything else uses test.ccavenue.com)
 *   PUBLIC_SITE_URL=https://www.peopleforanimalsindia.org
 *   FIREBASE_SERVICE_ACCOUNT      (optional; without it orders are logged only)
 */

const crypto = require('crypto');
const products = require('./_products.js');

let store = null;
try { store = require('./_firestore.js'); } catch (e) { store = null; }

const IV = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
]);

const PRODUCTION_URL = 'https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction';
const TEST_URL = 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction';

function encrypt(plainText, workingKey) {
  const key = crypto.createHash('md5').update(String(workingKey), 'utf8').digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final()
  ]).toString('hex');
}

function clean(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength || 200);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function readBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  let raw = request.body;
  if (raw == null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > 64 * 1024) throw new Error('Request body is too large.');
      chunks.push(buf);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  const params = new URLSearchParams(String(raw));
  const out = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

function makeOrderId() {
  return `PFASHOP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function baseUrl(request) {
  const configured = clean(process.env.PUBLIC_SITE_URL || '', 300);
  if (configured) return new URL(configured).origin;
  const proto = String(request.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0];
  if (!host) throw new Error('Could not determine the site URL.');
  return `${proto}://${host}`;
}

function errorPage(response, status, message) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Order could not start | PFA</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Arial,sans-serif;background:#fff;color:#111}
.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(520px,100%);border:1px solid #ddd;padding:32px;border-radius:8px}
h1{font-size:26px;margin:0 0 12px}p{color:#555;line-height:1.55;margin:0}
a{display:inline-block;margin-top:20px;background:#7b6bd6;color:#fff;text-decoration:none;padding:13px 20px;border-radius:6px;font-weight:600}
</style></head><body><main class="wrap"><section class="card">
<h1>Your order could not be started</h1><p>${escapeHtml(message)}</p>
<a href="/cart.html">Back to cart</a>
<p style="margin-top:18px;font-size:14px">Or order directly on
<a href="tel:+919953313319" style="background:none;color:#7b6bd6;padding:0;display:inline">+91 99533 13319</a>.</p>
</section></main></body></html>`);
}

function parseItems(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || '[]'));
  } catch (e) {
    throw new Error('Your cart could not be read. Please add your items again.');
  }
  if (!Array.isArray(parsed)) throw new Error('Your cart could not be read.');
  return parsed;
}

/* Stock. Reserved at checkout start rather than on payment success, because
   two people paying at once for the last piece is worse than a reservation
   that expires unused. api/ccavenue-response.js should release reservations
   for orders that fail or are abandoned — see RELEASE-STOCK.md.

   Fails open: if Firestore is unreachable the sale proceeds. Losing a genuine
   ₹5000 order is worse than briefly risking an oversell, and this matches how
   _rate-limit.js already treats donations. */
async function reserveStock(lines, orderId) {
  if (!store) return { ok: true, skipped: 'no-firestore' };

  const tracked = lines.filter((l) => l.tracked);
  if (!tracked.length) return { ok: true };

  try {
    for (const line of tracked) {
      const doc = await store.readDoc('stock', line.stockKey);
      const remaining = doc && Number.isFinite(Number(doc.remaining))
        ? Number(doc.remaining)
        : products.get(line.id).stock;      // first sale seeds from catalogue

      if (remaining < line.qty) {
        return {
          ok: false,
          message: remaining <= 0
            ? `${line.name} (size ${line.size}) is sold out.`
            : `${line.name} (size ${line.size}): only ${remaining} left.`
        };
      }
    }

    await store.commit(tracked.map((line) => store.incrementDoc(
      'stock', line.stockKey, { [store.fieldPath('remaining')]: -line.qty }
    )));

    return { ok: true };
  } catch (error) {
    console.error('PFA stock check failed, allowing order', orderId, error && error.message);
    return { ok: true, skipped: 'error' };
  }
}

async function recordOrder(order) {
  if (!store) return;
  try {
    await store.commit([store.setDoc('orders', order.orderId, order)]);
  } catch (error) {
    console.error('PFA order record failed', order.orderId, error && error.message);
  }
}

module.exports = async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return errorPage(response, 405, 'Start your order from the PFA cart page.');
  }

  const merchantId = clean(process.env.CCAVENUE_MERCHANT_ID, 30);
  const accessCode = clean(process.env.CCAVENUE_ACCESS_CODE, 200);
  const workingKey = String(process.env.CCAVENUE_WORKING_KEY || '').trim();

  if (!merchantId || !accessCode || !workingKey) {
    console.error('CCAvenue env vars missing for store checkout');
    return errorPage(response, 500, 'Online orders are not configured yet. Please call +91 99533 13319.');
  }

  try {
    const body = await readBody(request);
    const quote = products.price(parseItems(body.items));

    if (quote.errors.length) return errorPage(response, 400, quote.errors[0]);
    if (quote.total < 1) return errorPage(response, 400, 'Your cart is empty.');

    const orderId = makeOrderId();

    const stock = await reserveStock(quote.lines, orderId);
    if (!stock.ok) return errorPage(response, 409, stock.message);

    const name  = clean(body.billing_name, 100);
    const email = clean(body.billing_email, 100);
    const tel   = clean(body.billing_tel, 20).replace(/[^\d+]/g, '');

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Please enter a valid email address.');
    }

    /* A physical product needs a real delivery address. CCAvenue collects
       billing details on its own page, but delivery_* must come from us. */
    const ship = {
      delivery_name:    name,
      delivery_address: clean(body.delivery_address, 150),
      delivery_city:    clean(body.delivery_city, 50),
      delivery_state:   clean(body.delivery_state, 50),
      delivery_zip:     clean(body.delivery_zip, 10).replace(/[^\d]/g, ''),
      delivery_country: clean(body.delivery_country, 50) || 'India',
      delivery_tel:     tel
    };

    if (!ship.delivery_address || !ship.delivery_city || !ship.delivery_zip) {
      return errorPage(response, 400, 'Please enter a full delivery address, city and PIN code.');
    }
    if (!/^\d{6}$/.test(ship.delivery_zip)) {
      return errorPage(response, 400, 'Please enter a valid 6-digit PIN code.');
    }
    if (!/^(\+91)?\d{10}$/.test(tel)) {
      return errorPage(response, 400, 'Please enter a valid 10-digit phone number for delivery.');
    }

    const summary = quote.lines
      .map((l) => `${l.slug}:${l.size}x${l.qty}`)
      .join(',')
      .slice(0, 250);

    await recordOrder({
      orderId,
      status: 'initiated',
      createdAt: new Date().toISOString(),
      items: quote.lines.map((l) => ({
        id: l.id, slug: l.slug, name: l.name, size: l.size,
        qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal
      })),
      subtotal: quote.subtotal,
      shipping: quote.shipping,
      total: quote.total,
      customer: { name, email, tel },
      delivery: ship
    });

    const callback = `${baseUrl(request)}/api/ccavenue-response`;

    /* Server owns merchant_id, order_id, amount and callbacks. */
    const payload = Object.assign({
      merchant_id: merchantId,
      order_id: orderId,
      amount: quote.total.toFixed(2),
      currency: 'INR',
      redirect_url: callback,
      cancel_url: callback,
      language: 'EN',
      billing_name: name,
      billing_email: email,
      billing_tel: tel,
      billing_address: ship.delivery_address,
      billing_city: ship.delivery_city,
      billing_state: ship.delivery_state,
      billing_zip: ship.delivery_zip,
      billing_country: ship.delivery_country,
      /* merchant_param1 is read back as the donor PAN by ccavenue-response.js
         and feeds Form 10BD. A purchase has no PAN, so it must stay empty —
         putting the item list here would file garbage into a tax return. */
      merchant_param1: '',
      merchant_param2: 'PFA Store',
      merchant_param3: 'store-order',      // the callback branches on this
      merchant_param4: summary
    }, ship);

    const params = new URLSearchParams();
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
    });

    const encRequest = encrypt(params.toString(), workingKey);
    const paymentUrl = String(process.env.CCAVENUE_MODE || '').toLowerCase() === 'production'
      ? PRODUCTION_URL
      : TEST_URL;

    console.info('PFA store order started', {
      orderId, total: quote.total, items: quote.lines.length, summary
    });

    const nonce = crypto.randomBytes(18).toString('base64');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      `form-action https://secure.ccavenue.com https://test.ccavenue.com; base-uri 'none'; frame-ancestors 'none'`
    );
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening secure payment | PFA</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Arial,sans-serif;background:#fff;color:#111}
.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(520px,100%);border:1px solid #ddd;padding:34px;border-radius:8px;text-align:center}
h1{font-size:24px;margin:0 0 10px}p{color:#555;line-height:1.55;margin:0}
.amt{font-size:30px;font-weight:700;margin:14px 0 4px}
.spinner{width:30px;height:30px;border:3px solid #eee;border-top-color:#7b6bd6;border-radius:50%;margin:22px auto;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
button{margin-top:18px;background:#7b6bd6;color:#fff;border:0;padding:13px 20px;border-radius:6px;font-weight:600;font-size:15px;cursor:pointer}
</style></head><body><main class="wrap"><section class="card">
<h1>Opening secure payment</h1>
<div class="amt">\u20B9${escapeHtml(quote.total.toLocaleString('en-IN'))}</div>
<div class="spinner"></div>
<p>You are being transferred to CCAvenue. People for Animals does not receive or store your card, bank or UPI details.</p>
<form id="cca" method="post" action="${escapeHtml(paymentUrl)}">
<input type="hidden" name="encRequest" value="${escapeHtml(encRequest)}">
<input type="hidden" name="access_code" value="${escapeHtml(accessCode)}">
<button type="submit">Continue</button></form>
</section></main><script nonce="${nonce}">document.getElementById('cca').submit();</script></body></html>`);
  } catch (error) {
    const message = clean(error && error.message ? error.message : 'Your order could not be started.', 300);
    console.error('PFA store checkout failed:', message);
    return errorPage(response, 400, message);
  }
};
