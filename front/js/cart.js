/* PFA store cart.
 *
 * Replaces the dead Laravel /cart/add server cart. Items live in localStorage;
 * pricing is re-derived server-side at checkout by api/_products.js, so nothing
 * here is trusted for money — editing localStorage changes what you see, not
 * what you are charged.
 *
 * Loaded on every store page. Safe to load on pages with no cart markup.
 */
(function () {
  'use strict';

  var KEY = 'pfa_cart_v1';
  var MAX_QTY = 10;

  /* ---------- storage ---------------------------------------------------- */

  function read() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch (e) {
      return [];                        // private mode, quota, corrupt JSON
    }
  }

  function write(items) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(items));
    } catch (e) {
      alert('Your browser is blocking storage, so the cart cannot be saved. '
          + 'Turn off private browsing, or call +91 99533 13319 to order.');
    }
    paintBadge();
  }

  function valid(i) {
    return i && i.id && i.size && Number(i.qty) > 0;
  }

  function lineKey(i) { return String(i.id) + '__' + String(i.size); }

  /* ---------- operations ------------------------------------------------- */

  function add(item) {
    var items = read();
    var key = lineKey(item);
    var existing = null;
    for (var n = 0; n < items.length; n++) {
      if (lineKey(items[n]) === key) { existing = items[n]; break; }
    }
    if (existing) {
      existing.qty = Math.min(MAX_QTY, Number(existing.qty) + Number(item.qty));
    } else {
      items.push(item);
    }
    write(items);
    return existing ? existing.qty : item.qty;
  }

  function remove(key) {
    write(read().filter(function (i) { return lineKey(i) !== key; }));
  }

  function setQty(key, qty) {
    qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number(qty) || 1)));
    var items = read();
    for (var n = 0; n < items.length; n++) {
      if (lineKey(items[n]) === key) { items[n].qty = qty; break; }
    }
    write(items);
  }

  function count() {
    return read().reduce(function (t, i) { return t + Number(i.qty); }, 0);
  }

  /* ---------- ui helpers ------------------------------------------------- */

  function rupees(n) { return '\u20B9' + Number(n).toLocaleString('en-IN'); }

  function paintBadge() {
    var n = count();
    var badges = document.querySelectorAll('#cart-count');
    for (var k = 0; k < badges.length; k++) {
      badges[k].textContent = String(n);
      badges[k].classList.toggle('d-none', n === 0);   // was permanently d-none
    }
  }

  function toast(message, ok) {
    if (window.Swal && typeof window.Swal.mixin === 'function') {
      window.Swal.mixin({
        toast: true, position: 'top-end', showConfirmButton: false, timer: 1600
      }).fire({ icon: ok ? 'success' : 'error', title: message });
      return;
    }
    var el = document.createElement('div');       // works even if Swal is blocked
    el.textContent = message;
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;'
      + 'background:' + (ok ? '#198754' : '#b02a37') + ';color:#fff;'
      + 'padding:12px 18px;border-radius:6px;font:600 14px system-ui,sans-serif;'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.2);max-width:320px';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  /* Site root, so this works from / and from /product/details/. */
  function root() {
    return /\/product\/details\//.test(window.location.pathname) ? '../../' : '';
  }

  /* ---------- add to cart ------------------------------------------------ */

  /* Capture phase on document fires BEFORE the page's own jQuery submit
     handler (which is bound on the form and runs in bubble phase), so the
     legacy AJAX POST to the dead /cart/add route never executes. That means
     the old inline scripts can stay exactly as they are. */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.id !== 'addToCartForm') return;

    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    function field(name) {
      var el = form.querySelector('[name="' + name + '"]');
      return el ? el.value : '';
    }

    /* Size must come from the checked radio. The markup also carries an empty
       hidden input named "size", which would otherwise win. */
    var checked = form.querySelector('input[type="radio"][name="size"]:checked');
    var size = checked ? checked.value : '';
    if (!size) { toast('Please choose a size.', false); return; }

    var qty = Math.max(1, Math.min(MAX_QTY, parseInt(field('qty'), 10) || 1));
    var id  = field('product_id');
    if (!id) { toast('Sorry, this product could not be added.', false); return; }

    var total = add({
      id: id,
      slug: field('product_slug'),
      name: field('product_name'),
      size: size,
      qty: qty,
      price: Number(field('offer_price') || field('price')) || 0,   // display only
      image: (field('product_image') || '').replace(/^http:\/\//, 'https://')
    });

    var btn = form.querySelector('#addToCart__btn');
    if (btn) {
      var was = btn.innerHTML;
      btn.innerHTML = 'Added \u2713';
      setTimeout(function () { btn.innerHTML = was; }, 1400);
    }
    toast(field('product_name') + ' (' + size + ') \u00D7 ' + total + ' in cart', true);
  }, true);

  /* ---------- cart page -------------------------------------------------- */

  function renderCart() {
    var host = document.getElementById('pfa-cart');
    if (!host) return;

    var items = read();
    var body    = host.querySelector('[data-cart-body]');
    var empty   = host.querySelector('[data-cart-empty]');
    var table   = host.querySelector('[data-cart-table]');
    var sub     = host.querySelector('[data-cart-subtotal]');
    var ship    = host.querySelector('[data-cart-shipping]');
    var grand   = host.querySelector('[data-cart-total]');
    var payBtn  = host.querySelector('[data-cart-checkout]');

    if (!items.length) {
      if (table) table.style.display = 'none';
      if (empty) empty.style.display = '';
      if (payBtn) payBtn.disabled = true;
      if (sub) sub.textContent = rupees(0);
      if (ship) ship.textContent = rupees(0);
      if (grand) grand.textContent = rupees(0);
      paintBadge();
      return;
    }

    if (table) table.style.display = '';
    if (empty) empty.style.display = 'none';
    if (payBtn) payBtn.disabled = false;

    var subtotal = 0;
    var html = '';
    items.forEach(function (i) {
      var line = Number(i.price) * Number(i.qty);
      subtotal += line;
      var key = lineKey(i);
      var img = String(i.image || '').replace(/^http:\/\//, 'https://');
      html += '<tr>'
        + '<td><img src="' + esc(img) + '" alt="" style="width:64px;height:auto;border-radius:4px"></td>'
        + '<td><strong>' + esc(i.name) + '</strong><br><small>Size ' + esc(i.size) + '</small></td>'
        + '<td>' + rupees(i.price) + '</td>'
        + '<td><input type="number" min="1" max="' + MAX_QTY + '" value="' + Number(i.qty)
        + '" data-qty="' + esc(key) + '" style="width:68px" class="form-control form-control-sm"></td>'
        + '<td>' + rupees(line) + '</td>'
        + '<td><button type="button" class="btn btn-sm btn-outline-danger" data-remove="'
        + esc(key) + '" aria-label="Remove ' + esc(i.name) + '">&times;</button></td>'
        + '</tr>';
    });

    if (body) body.innerHTML = html;
    var shipping = 150;                       // server recomputes; display only
    if (sub) sub.textContent = rupees(subtotal);
    if (ship) ship.textContent = rupees(shipping);
    if (grand) grand.textContent = rupees(subtotal + shipping);
    paintBadge();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  document.addEventListener('click', function (e) {
    var rm = e.target.closest && e.target.closest('[data-remove]');
    if (rm) { remove(rm.getAttribute('data-remove')); renderCart(); }
  });

  document.addEventListener('change', function (e) {
    var q = e.target.closest && e.target.closest('[data-qty]');
    if (q) { setQty(q.getAttribute('data-qty'), q.value); renderCart(); }
  });

  /* ---------- checkout --------------------------------------------------- */

  /* Posts only {id, size, qty}. Price, shipping and total are computed on the
     server from the catalogue — nothing about money crosses from the browser. */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.id !== 'pfa-checkout-form') return;

    var items = read();
    if (!items.length) {
      event.preventDefault();
      toast('Your cart is empty.', false);
      return;
    }
    var field = form.querySelector('input[name="items"]');
    if (!field) {
      field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'items';
      form.appendChild(field);
    }
    field.value = JSON.stringify(items.map(function (i) {
      return { id: i.id, size: i.size, qty: i.qty };
    }));
    // allow normal submit -> POST /api/store-checkout
  });

  /* ---------- boot ------------------------------------------------------- */

  function boot() { paintBadge(); renderCart(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.PFACart = {
    read: read, add: add, remove: remove, setQty: setQty,
    count: count, render: renderCart,
    clear: function () { write([]); renderCart(); }
  };
})();
