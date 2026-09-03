'use strict';

/* Authoritative product catalogue.
 *
 * This is the ONLY place prices are trusted. The browser cart lives in
 * localStorage, which any visitor can edit in devtools, so store-checkout.js
 * ignores whatever price the browser sends and re-prices every line from here
 * by product id. Without this a ₹5000 tee sells for ₹1.
 *
 * Extracted from the existing product pages, so ids match the historical
 * product_id values and nothing downstream has to be remapped.
 *
 * price      what the customer actually pays (was offer_price in the markup)
 * listPrice  the struck-through MRP, display only, never charged
 * stock      pieces per size for this drop. null = untracked (no cap).
 */

const PRODUCTS = {
  '21': { slug: 't-shirt',                   name: 'T-SHIRT',                     price: 350,  listPrice: 450,  sizes: ['L', 'XL'], stock: null, image: '/uploads/product/1663574021.3.jpg' },
  '23': { slug: 'sabyasachi-x-pfa',          name: 'Sabyasachi x PFA',            price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745704362.png' },
  '26': { slug: 'gaurav-gupta-x-pfa',        name: 'Gaurav Gupta x PFA',          price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745704396.png' },
  '27': { slug: 'varun-bahl-x-pfa',          name: 'Varun Bahl x PFA',            price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745706391.png' },
  '29': { slug: 'rocky-star-x-pfa',          name: 'Rocky Star x PFA',            price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745704223.png' },
  '30': { slug: 'geisha-designs-x-pfa',      name: 'Geisha Designs x PFA',        price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745706312.png' },
  '31': { slug: 'muzaffar-ali-x-pfa',        name: 'Muzaffar Ali x PFA',          price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745706275.png' },
  '32': { slug: 'nida-mahmood-x-pfa',        name: 'Nida Mahmood x PFA',          price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745706013.png' },
  '33': { slug: 'j-j-valaya-x-pfa',          name: 'J J Valaya x PFA',            price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745704182.png' },
  '34': { slug: 'gaurav-gupta-x-pfa-charcoal', name: 'Gaurav Gupta x PFA [Charcoal]', price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99, image: '/uploads/product/1745704146.png' },
  '35': { slug: 'monisha-jaisingh-x-pfa',    name: 'Monisha Jaisingh x PFA',      price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745704117.png' },
  '36': { slug: 'varun-bahl-x-pfa-design-2', name: 'Varun Bahl x PFA [Design 2]', price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745705960.png' },
  '37': { slug: 'raw-mango-x-pfa',           name: 'Raw Mango x PFA',             price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745704071.png' },
  '38': { slug: 'masaba-gupta-x-pfa',        name: 'Masaba Gupta x PFA',          price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745705914.png' },
  '39': { slug: 'ashima-singh-x-pfa',        name: 'Ashima Singh x PFA',          price: 5000, listPrice: 5000, sizes: ['L', 'XL'], stock: 99,   image: '/uploads/product/1745704033.png' }
};

/* Flat ₹150, matching what cart.html has always displayed. Change here only —
   store-checkout.js recomputes it server-side and the browser never sets it. */
const SHIPPING_FLAT = 150;
const FREE_SHIPPING_OVER = null;   // set a rupee figure to enable free shipping

function get(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, String(id))
    ? PRODUCTS[String(id)]
    : null;
}

function shippingFor(subtotal) {
  if (FREE_SHIPPING_OVER !== null && subtotal >= FREE_SHIPPING_OVER) return 0;
  return SHIPPING_FLAT;
}

/* Re-prices a browser cart against this catalogue.
   Returns { lines, subtotal, shipping, total, errors }. */
function price(rawItems) {
  const lines = [];
  const errors = [];

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { lines, subtotal: 0, shipping: 0, total: 0, errors: ['Your cart is empty.'] };
  }
  if (rawItems.length > 20) {
    return { lines, subtotal: 0, shipping: 0, total: 0, errors: ['Too many items in one order.'] };
  }

  for (const raw of rawItems) {
    const id = String(raw && raw.id != null ? raw.id : '').trim();
    const product = get(id);
    if (!product) { errors.push(`Unknown product (${id || 'blank'}).`); continue; }

    const size = String(raw.size || '').trim().toUpperCase();
    if (!product.sizes.includes(size)) {
      errors.push(`${product.name}: choose a size (${product.sizes.join(' or ')}).`);
      continue;
    }

    const qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 10) {
      errors.push(`${product.name}: quantity must be between 1 and 10.`);
      continue;
    }

    lines.push({
      id, size, qty,
      slug: product.slug,
      name: product.name,
      image: product.image,
      unitPrice: product.price,          // from catalogue, never from browser
      lineTotal: product.price * qty,
      stockKey: `${id}__${size}`,
      tracked: product.stock !== null
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const shipping = lines.length ? shippingFor(subtotal) : 0;
  return { lines, subtotal, shipping, total: subtotal + shipping, errors };
}

module.exports = { PRODUCTS, get, price, shippingFor, SHIPPING_FLAT };
