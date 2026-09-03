/* End-to-end test of cart.js against the REAL patched pages.
   Loads product HTML in jsdom, clicks Add To Cart, then loads cart.html
   with the same localStorage and checks what renders. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const REPO = process.cwd();
const CART_JS = fs.readFileSync(`${REPO}/front/js/cart.js`, 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m)); };

// shared localStorage across "page loads", like a real browser
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

function load(file) {
  const dom = new JSDOM(fs.readFileSync(`${REPO}/${file}`, 'utf8'), {
    url: 'https://www.peopleforanimalsindia.org/' + file,
    runScripts: 'outside-only',
  });
  Object.defineProperty(dom.window, 'localStorage', { value: localStorage, configurable: true });
  dom.window.alert = () => {};
  dom.window.eval(CART_JS);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
}

console.log('\n1. ADD TO CART  (product/details/sabyasachi-x-pfa.html)');
let dom = load('product/details/sabyasachi-x-pfa.html');
let d = dom.window.document;

const form = d.getElementById('addToCartForm');
ok(!!form, 'add-to-cart form exists');
ok(form.getAttribute('action') === '#', 'form action no longer points at /cart/add');
ok(!d.querySelector('[name="_token"]'), 'dead Laravel _token removed');
ok(!d.querySelector('input[type="hidden"][name="size"]'), 'empty hidden size input removed');

// choose XL, qty 2, submit
d.querySelector('#sizeMedium').checked = true;
d.querySelector('#sizeLarge').checked = false;
d.querySelector('[name="qty"]').value = '2';
form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

let cart = JSON.parse(localStorage.getItem('pfa_cart_v1') || '[]');
ok(cart.length === 1, 'one line in cart');
ok(cart[0] && cart[0].id === '23', 'correct product_id captured (23)');
ok(cart[0] && cart[0].size === 'XL', 'size taken from checked radio, not the hidden field');
ok(cart[0] && cart[0].qty === 2, 'qty captured (2)');
ok(cart[0] && !/^http:\/\//.test(cart[0].image), 'image url upgraded to https');

console.log('\n2. SECOND PRODUCT + MERGE');
dom = load('product/details/t-shirt.html');
d = dom.window.document;
d.getElementById('addToCartForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
cart = JSON.parse(localStorage.getItem('pfa_cart_v1'));
ok(cart.length === 2, 'second distinct product added');

// re-add the same sabyasachi XL: should merge, not duplicate
dom = load('product/details/sabyasachi-x-pfa.html');
d = dom.window.document;
d.querySelector('#sizeMedium').checked = true;
d.querySelector('[name="qty"]').value = '1';
d.getElementById('addToCartForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
cart = JSON.parse(localStorage.getItem('pfa_cart_v1'));
const sab = cart.find((i) => i.id === '23' && i.size === 'XL');
ok(cart.length === 2, 'same id+size merged instead of duplicating');
ok(sab && sab.qty === 3, 'merged qty is 3 (2 + 1)');

console.log('\n3. CART PAGE RENDER  (cart.html)');
dom = load('cart.html');
d = dom.window.document;
const rows = d.querySelectorAll('[data-cart-body] tr');
ok(rows.length === 2, `cart table rendered ${rows.length} rows (expected 2)`);
ok(d.querySelector('[data-cart-subtotal]').textContent.replace(/[^\d]/g, '') === '15350',
   'subtotal = 3x5000 + 1x350 = 15,350  (got ' + d.querySelector('[data-cart-subtotal]').textContent + ')');
ok(d.querySelector('[data-cart-total]').textContent.replace(/[^\d]/g, '') === '15500',
   'total  = 15,350 + 150 shipping = 15,500');
const badge = d.querySelector('#cart-count');
ok(badge && badge.textContent === '4', 'badge shows 4 items (got ' + (badge && badge.textContent) + ')');
ok(badge && !badge.classList.contains('d-none'), 'badge no longer permanently hidden');

console.log('\n4. QTY CHANGE + REMOVE');
const qtyInput = d.querySelector('[data-qty]');
qtyInput.value = '1';
qtyInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
ok(d.querySelector('[data-cart-subtotal]').textContent.replace(/[^\d]/g, '') === '5350',
   'subtotal recalculated after qty change (1x5000 + 1x350)');

d.querySelector('[data-remove]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
ok(d.querySelectorAll('[data-cart-body] tr').length === 1, 'row removed');

console.log('\n5. CHECKOUT PAYLOAD');
const co = d.getElementById('pfa-checkout-form');
ok(!!co, 'checkout form exists');
ok(co.getAttribute('action') === '/api/store-checkout', 'checkout posts to the new endpoint');
co.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
const items = JSON.parse(d.querySelector('input[name="items"]').value);
ok(Array.isArray(items) && items.length === 1, 'items payload serialised');
ok(items[0] && !('price' in items[0]), 'NO price field sent to server (server re-prices)');
ok(Object.keys(items[0]).sort().join(',') === 'id,qty,size', 'payload is exactly {id,qty,size}');

console.log('\n6. EMPTY CART');
store.clear();
dom = load('cart.html');
d = dom.window.document;
ok(d.querySelector('[data-cart-empty]').style.display === '', 'empty-cart message shown');
ok(d.querySelector('[data-cart-checkout]').disabled === true, 'checkout button disabled when empty');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
