#!/usr/bin/env python3
"""Apply the PFA store fix to the static HTML.

Idempotent: safe to run twice. Run from the repo root.

  python3 apply-store-fix.py            # apply
  python3 apply-store-fix.py --dry-run  # report only
"""
import glob
import os
import re
import sys

DRY = "--dry-run" in sys.argv
changed = {}


def save(path, before, after):
    if before == after:
        return False
    changed[path] = changed.get(path, 0) + 1
    if not DRY:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(after)
    return True


# ── 1. https:// sweep, sitewide ──────────────────────────────────────────────
# Mixed content silently blocks the cart POST, sweetalert, images and video.
# Only rewrite our own host and known-good CDNs; leave third-party http alone.
HTTP_FIX = [
    (re.compile(r'http://(www\.peopleforanimalsindia\.org)'), r'https://\1'),
    (re.compile(r'http://(cdn\.jsdelivr\.net)'), r'https://\1'),
    (re.compile(r'http://(oss\.maxcdn\.com)'), r'https://\1'),
    (re.compile(r'http://(ajax\.aspnetcdn\.com)'), r'https://\1'),
    (re.compile(r'http://(unpkg\.com)'), r'https://\1'),
]

html_files = [p for p in glob.glob("**/*.html", recursive=True) if ".git" not in p]
print(f"scanning {len(html_files)} html files")

for path in html_files:
    with open(path, encoding="utf-8", errors="surrogateescape") as fh:
        src = fh.read()
    out = src
    for pattern, repl in HTTP_FIX:
        out = pattern.sub(repl, out)
    save(path, src, out)

print(f"  https sweep: {len(changed)} files")

# ── 2. product pages ─────────────────────────────────────────────────────────
product_pages = sorted(glob.glob("product/details/*.html"))
for path in product_pages:
    with open(path, encoding="utf-8", errors="surrogateescape") as fh:
        src = fh.read()
    out = src

    # dead Laravel CSRF token -> 419 on any real backend, useless here
    out = re.sub(r'<input type="hidden" name="_token" value="[^"]*">\s*', "", out)

    # empty hidden size field shadows the checked radio (both are name="size")
    out = re.sub(r'<input type="hidden" name="size" value="">\s*', "", out)

    # point the form at nothing; cart.js intercepts in capture phase
    out = out.replace(
        'action="https://www.peopleforanimalsindia.org/cart/add"',
        'action="#" data-pfa-cart="add"',
    )
    out = out.replace(
        'action="http://www.peopleforanimalsindia.org/cart/add"',
        'action="#" data-pfa-cart="add"',
    )

    if "front/js/cart.js" not in out:
        out = out.replace(
            "</body>",
            '\t\t<script src="../../front/js/cart.js"></script>\n</body>',
            1,
        )
    save(path, src, out)

print(f"  product pages: {len(product_pages)} patched")

# ── 3. cart page ─────────────────────────────────────────────────────────────
CART_SECTION = """
    <div class="container" id="pfa-cart">
        <div class="row">
            <div class="col-12 col-lg-9 pe-lg-3 pe-md-3">
                <div data-cart-empty style="display:none;padding:48px 0;text-align:center">
                    <h4>Your cart is empty</h4>
                    <p class="text-muted">Every tee funds the rescue and care of injured animals.</p>
                    <a href="product.html" class="btn cart_btn w-auto">Browse the collection</a>
                </div>
                <div class="table-responsive" data-cart-table>
                    <table class="table table-sm cart_table table-bordered align-middle">
                        <thead>
                            <tr>
                                <th scope="col">Image</th>
                                <th scope="col">Product</th>
                                <th scope="col">Price</th>
                                <th scope="col">Quantity</th>
                                <th scope="col">Total</th>
                                <th scope="col">Remove</th>
                            </tr>
                        </thead>
                        <tbody data-cart-body></tbody>
                        <tfoot>
                            <tr>
                                <td colspan="6" class="text-end">
                                    <a href="product.html" class="btn cart_btn mb-2 mt-2 w-auto">Continue Shopping</a>
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
            <div class="col-12 col-lg-3 cart_total">
                <div class="card">
                    <h1>Cart Totals</h1>
                    <table class="table">
                        <tr><td>Sub Total</td><td data-cart-subtotal>\u20b90</td></tr>
                        <tr><td>Shipping</td><td data-cart-shipping>\u20b90</td></tr>
                        <tr><th>Total</th><th data-cart-total>\u20b90</th></tr>
                    </table>
                    <form id="pfa-checkout-form" method="POST" action="/api/store-checkout" class="py-3">
                        <h6 class="mb-2">Delivery details</h6>
                        <input class="form-control form-control-sm mb-2" name="billing_name" placeholder="Full name" required maxlength="100">
                        <input class="form-control form-control-sm mb-2" name="billing_email" type="email" placeholder="Email" required maxlength="100">
                        <input class="form-control form-control-sm mb-2" name="billing_tel" type="tel" placeholder="10-digit phone" required pattern="(\\+91)?[0-9]{10}">
                        <textarea class="form-control form-control-sm mb-2" name="delivery_address" placeholder="Address" required maxlength="150" rows="2"></textarea>
                        <input class="form-control form-control-sm mb-2" name="delivery_city" placeholder="City" required maxlength="50">
                        <input class="form-control form-control-sm mb-2" name="delivery_state" placeholder="State" maxlength="50">
                        <input class="form-control form-control-sm mb-3" name="delivery_zip" placeholder="6-digit PIN" required pattern="[0-9]{6}">
                        <button type="submit" data-cart-checkout class="btn cart_btn m-0 w-auto d-block">Proceed To Checkout</button>
                    </form>
                    <p class="small text-muted px-1">Prefer to order by phone?
                        <a href="tel:+919953313319">+91 99533 13319</a></p>
                </div>
            </div>
        </div>
    </div>
"""

path = "cart.html"
with open(path, encoding="utf-8", errors="surrogateescape") as fh:
    src = fh.read()

if "pfa-cart" in src:
    print("  cart.html: already patched")
else:
    # replace from the container that opens the cart table through its close
    start = src.index('<div class="container">', src.index("Cart List</li>"))
    end = src.index("</section>", start)
    out = src[:start] + CART_SECTION.strip() + "\n" + src[end:]
    if "front/js/cart.js" not in out:
        out = out.replace(
            "</body>", '\t\t<script src="front/js/cart.js"></script>\n</body>', 1
        )
    save(path, src, out)
    print("  cart.html: rebuilt")

# ── 4. cart.js on every page that shows the badge ────────────────────────────
badge_pages = 0
for path in html_files:
    if path.startswith("product/details/") or path == "cart.html":
        continue
    with open(path, encoding="utf-8", errors="surrogateescape") as fh:
        src = fh.read()
    if 'id="cart-count"' not in src or "front/js/cart.js" in src:
        continue
    depth = path.count("/")
    prefix = "../" * depth
    out = src.replace(
        "</body>", f'\t\t<script src="{prefix}front/js/cart.js"></script>\n</body>', 1
    )
    if save(path, src, out):
        badge_pages += 1

print(f"  badge pages: {badge_pages} given cart.js")
print(f"\n{'DRY RUN - nothing written' if DRY else 'done'}: {len(changed)} files changed")
