'use strict';

/* Turns a decrypted CCAvenue callback for a STORE ORDER into Firestore records.
 *
 * Kept separate from _record-donation.js on purpose. A t-shirt sale is not a
 * donation: it must not land in payments/, must not increment the donation
 * aggregates, and must never appear in Form 10BD or receive an 80G receipt.
 * Mixing the two would overstate PFA's reported donations and issue tax
 * receipts for purchases.
 *
 * Writes:
 *   orders/{orderId}     updated in place from the 'initiated' record that
 *                        store-checkout.js wrote before redirecting
 *   aggregates/store     order and revenue counters, incremented once only
 *
 * On a failed or aborted payment the reserved stock is returned.
 */

let store = null;
try { store = require('./_firestore.js'); } catch (e) { store = null; }

let products = null;
try { products = require('./_products.js'); } catch (e) { products = null; }

function clean(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength || 200);
}

/* "sabyasachi-x-pfa:L x2,t-shirt:XL x1" -> [{slug,size,qty}] */
function parseSummary(summary) {
  return String(summary || '')
    .split(',')
    .map((part) => {
      const m = /^([a-z0-9-]+):([A-Z]+)x(\d+)$/.exec(part.trim());
      return m ? { slug: m[1], size: m[2], qty: Number(m[3]) } : null;
    })
    .filter(Boolean);
}

function idForSlug(slug) {
  if (!products) return null;
  const found = Object.entries(products.PRODUCTS).find(([, p]) => p.slug === slug);
  return found ? found[0] : null;
}

/* Payment failed or was abandoned, so put the reserved pieces back. */
async function releaseStock(summary) {
  if (!store || !products) return;
  const lines = parseSummary(summary);
  if (!lines.length) return;

  const ops = [];
  for (const line of lines) {
    const id = idForSlug(line.slug);
    if (!id) continue;
    const product = products.get(id);
    if (!product || product.stock === null) continue;
    ops.push(store.incrementDoc('stock', `${id}__${line.size}`, {
      [store.fieldPath('remaining')]: line.qty
    }));
  }
  if (!ops.length) return;

  try {
    await store.commit(ops);
  } catch (error) {
    console.error('PFA stock release failed', error && error.message);
  }
}

async function recordOrder(data) {
  if (!store) return { ok: false, error: 'firestore-unavailable' };

  const orderId = clean(data.order_id, 80);
  if (!orderId) return { ok: false, error: 'no-order-id' };

  const status = clean(data.order_status, 40);
  const amount = Number(clean(data.amount, 20)) || 0;
  const summary = clean(data.merchant_param4, 250);
  const paid = status === 'Success';

  try {
    const existing = await store.readDoc('orders', orderId);
    const alreadyFinal = existing && existing.status && existing.status !== 'initiated';

    const ops = [store.setDoc('orders', orderId, {
      orderId,
      status: paid ? 'paid' : status.toLowerCase() || 'failed',
      paidAt: paid ? new Date().toISOString() : null,
      amountCharged: amount,
      trackingId: clean(data.tracking_id, 60),
      bankRef: clean(data.bank_ref_no, 60),
      paymentMode: clean(data.payment_mode, 40),
      failureMessage: clean(data.failure_message || data.status_message, 200),
      itemSummary: summary,
      customer: {
        name: clean(data.billing_name, 100),
        email: clean(data.billing_email, 100),
        tel: clean(data.billing_tel, 20)
      },
      delivery: {
        name: clean(data.delivery_name, 100),
        address: clean(data.delivery_address, 150),
        city: clean(data.delivery_city, 50),
        state: clean(data.delivery_state, 50),
        zip: clean(data.delivery_zip, 10),
        country: clean(data.delivery_country, 50),
        tel: clean(data.delivery_tel, 20)
      },
      fulfilment: paid ? 'pending' : 'not-required'
    })];

    /* Counters only on first arrival. CCAvenue retries its callback and buyers
       refresh the result page, so this can run several times per order. */
    if (paid && !alreadyFinal) {
      ops.push(store.incrementDoc('aggregates', 'store', {
        [store.fieldPath('orders')]: 1,
        [store.fieldPath('revenue')]: amount
      }));
    }

    await store.commit(ops);

    if (!paid && !alreadyFinal) await releaseStock(summary);

    return { ok: true, recorded: paid ? 'paid' : 'failed' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

module.exports = { recordOrder, releaseStock, parseSummary };
