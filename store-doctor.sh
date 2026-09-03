#!/usr/bin/env bash
# store-doctor.sh — PFA store/cart diagnostic
# Usage: ./store-doctor.sh /path/to/PFAcurrent
set -uo pipefail

ROOT="${1:-.}"
cd "$ROOT" || { echo "cannot cd to $ROOT"; exit 1; }

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; BLD=$'\033[1m'; DIM=$'\033[2m'; N=$'\033[0m'
FAIL=0; WARN=0

hdr()  { printf '\n%s%s%s\n' "$BLD" "$1" "$N"; printf '%s%s%s\n' "$DIM" "$(printf '─%.0s' {1..64})" "$N"; }
bad()  { printf '  %sFAIL%s  %s\n' "$RED" "$N" "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  %sWARN%s  %s\n' "$YEL" "$N" "$1"; WARN=$((WARN+1)); }
ok()   { printf '  %s OK %s  %s\n' "$GRN" "$N" "$1"; }
note() { printf '        %s%s%s\n' "$DIM" "$1" "$N"; }

PAGES=$(ls product/details/*.html 2>/dev/null | wc -l | tr -d ' ')
printf '%sPFA STORE DIAGNOSTIC%s   repo=%s   product pages=%s\n' "$BLD" "$N" "$(pwd)" "$PAGES"

# ── 1. Backend routes ────────────────────────────────────────────────────────
hdr "1. CART BACKEND"
ADD=$(grep -rl 'action="[^"]*/cart/add"' product/details/*.html 2>/dev/null | wc -l | tr -d ' ')
CHK=$(grep -rl 'action="[^"]*/cart/checkout"' cart.html 2>/dev/null | wc -l | tr -d ' ')
if [ "$ADD" -gt 0 ]; then
  bad "$ADD/$PAGES product pages POST to Laravel route /cart/add"
  note "$(grep -m1 -n 'action="[^"]*/cart/add"' product/details/sabyasachi-x-pfa.html | cut -c1-96)"
fi
[ "$CHK" -gt 0 ] && bad "cart.html checkout targets dead route /cart/checkout"

if [ -d api ]; then
  RUNTIME=$(ls api/*.js 2>/dev/null | wc -l | tr -d ' ')
  note "host runtime: Node serverless — $RUNTIME functions in api/ ($(ls api/*.js | xargs -n1 basename | tr '\n' ' '))"
fi
[ -z "$(find . -name '*.php' -not -path './.git/*' 2>/dev/null)" ] \
  && bad "0 .php files present — Laravel cart cannot execute on this host"

# ── 2. Mixed content ─────────────────────────────────────────────────────────
hdr "2. MIXED CONTENT (page served over https)"
MC_FORM=$(grep -rho 'action="http://[^"]*"' product/details/*.html cart.html 2>/dev/null | wc -l | tr -d ' ')
MC_SWAL=$(grep -rl 'src="http://cdn.jsdelivr.net' --include='*.html' . 2>/dev/null | wc -l | tr -d ' ')
MC_ALL=$(grep -rho 'src="http://[^"]*"' --include='*.html' . 2>/dev/null | wc -l | tr -d ' ')
[ "$MC_FORM" -gt 0 ] && bad "$MC_FORM form actions use http:// — browser blocks the POST outright"
[ "$MC_SWAL" -gt 0 ] && bad "sweetalert2 loaded over http:// on $MC_SWAL pages -> Swal undefined -> handler throws"
[ "$MC_ALL" -gt 0 ] && warn "$MC_ALL total http:// asset refs sitewide (images/video also blocked)"
note "sample: $(grep -rho 'src="http://[^"]*"' --include='*.html' . | sort -u | head -3 | tr '\n' ' ')"

# ── 3. CSRF ──────────────────────────────────────────────────────────────────
hdr "3. CSRF TOKEN"
TOK=$(grep -rho 'name="_token" value="[^"]*"' product/details/*.html 2>/dev/null | sort -u | wc -l | tr -d ' ')
if [ "$TOK" -gt 0 ]; then
  bad "Laravel _token hardcoded into static HTML ($TOK unique value(s), frozen at snapshot)"
  note "any restored PHP backend returns HTTP 419 Page Expired on every submit"
fi

# ── 4. Cart page state ───────────────────────────────────────────────────────
hdr "4. CART PAGE RENDER"
if tr -d ' \t\n' < cart.html 2>/dev/null | grep -q '<tbody></tbody>'; then
  bad "cart.html <tbody> is empty — server-side Blade loop rendered nothing"
fi
grep -q 'id="cart-count"[^>]*d-none' cart.html 2>/dev/null \
  && bad "#cart-count badge hardcoded 0 and hidden (class=d-none), never updated"
HARD=$(grep -c '₹0\|₹150' cart.html 2>/dev/null)
[ "$HARD" -gt 0 ] && bad "totals hardcoded ($HARD literals: subtotal ₹0, shipping ₹150) — not computed"

# ── 5. Client-side fallback ──────────────────────────────────────────────────
hdr "5. CLIENT-SIDE CART FALLBACK"
STORE=$(grep -rl 'localStorage\|sessionStorage' --include='*.html' --include='*.js' . 2>/dev/null \
        | grep -v 'front/js/\(jquery\|bootstrap\|swiper\|popper\|turn\|aos\)' | wc -l | tr -d ' ')
if [ "$STORE" -eq 0 ]; then
  bad "no localStorage/sessionStorage anywhere — zero client state to fall back on"
else
  ok "$STORE file(s) use browser storage"
fi

# ── 6. AJAX error handling ───────────────────────────────────────────────────
hdr "6. AJAX HANDLER"
NOERR=0
for f in product/details/*.html cart.html; do
  grep -q 'addToCartForm' "$f" 2>/dev/null || continue
  grep -q 'error:\s*function' "$f" 2>/dev/null || NOERR=$((NOERR+1))
done
[ "$NOERR" -gt 0 ] && bad "$NOERR pages have \$.ajax with no error: callback — failures are silent to the user"

# ── 7. Repo hygiene ──────────────────────────────────────────────────────────
hdr "7. REPO HYGIENE"
grep -q '.env' .gitignore 2>/dev/null && ok ".env* is gitignored" || warn ".env not gitignored"
if grep -rn 'WORKING_KEY *= *["'\'']\|ACCESS_CODE *= *["'\'']' --include='*.js' api/ 2>/dev/null | grep -qv 'process.env'; then
  bad "hardcoded payment credential found in api/"
else
  ok "no hardcoded payment credentials (all via process.env)"
fi
[ -f .DS_Store ]   && warn ".DS_Store committed"
[ -f Archive.zip ] && warn "Archive.zip ($(du -h Archive.zip | cut -f1)) committed at repo root"

# ── Verdict ──────────────────────────────────────────────────────────────────
hdr "VERDICT"
printf '  %s%d FAIL%s   %s%d WARN%s\n\n' "$RED" "$FAIL" "$N" "$YEL" "$WARN" "$N"
cat <<'EOF'
  Root cause: static HTML snapshot of a Laravel app. The cart was 100%
  server-side. The server is gone, no PHP runtime exists on the host, and
  no client-side cart was ever written. "Add To Cart" is inert markup.

  Order of repair:
    1. https:// everywhere            (unblocks assets, ~10 min)
    2. interim WhatsApp/phone order   (stops revenue loss today)
    3. localStorage cart + api/ccavenue-order.js, server-side re-pricing by SKU
    4. stock counter — 99 pieces/design will oversell without one
EOF
exit 0
