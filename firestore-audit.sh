#!/usr/bin/env bash
# firestore-audit.sh — read the live pfa-oldsite Firestore config from the CLI.
# Read-only. Changes nothing.
#
# Setup (once):
#   npm i -g firebase-tools
#   firebase login
#   gcloud auth login          # for the access token
#   gcloud config set project pfa-oldsite
#
# Usage: ./firestore-audit.sh [project-id]

set -uo pipefail
PROJECT="${1:-pfa-oldsite}"
DB="(default)"

BLD=$'\033[1m'; DIM=$'\033[2m'; YEL=$'\033[33m'; N=$'\033[0m'
hdr() { printf '\n%s%s%s\n%s%s%s\n' "$BLD" "$1" "$N" "$DIM" "$(printf '─%.0s' {1..62})" "$N"; }

command -v gcloud >/dev/null || { echo "gcloud not found — install the Google Cloud SDK"; exit 1; }
command -v jq     >/dev/null || { echo "jq not found — brew install jq"; exit 1; }

TOKEN="$(gcloud auth print-access-token 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "no access token — run: gcloud auth login"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")

# ── 1. live security rules ───────────────────────────────────────────────────
hdr "1. LIVE FIRESTORE RULES  ($PROJECT)"
RELEASE=$(curl -s "${AUTH[@]}" \
  "https://firebaserules.googleapis.com/v1/projects/$PROJECT/releases" \
  | jq -r '.releases[]? | select(.name|endswith("cloud.firestore")) | .rulesetName' | head -1)

if [ -z "$RELEASE" ]; then
  echo "  could not read releases — check that you have firebaserules.viewer on $PROJECT"
else
  echo "  ruleset: $RELEASE"
  curl -s "${AUTH[@]}" "https://firebaserules.googleapis.com/v1/$RELEASE" \
    | jq -r '.source.files[].content' | tee /tmp/live-firestore.rules | sed 's/^/  │ /'
  echo
  echo "  saved to /tmp/live-firestore.rules"

  # the three findings that matter most
  echo
  if grep -qE 'allow (read|write|read, *write) *: *if true' /tmp/live-firestore.rules; then
    printf '  %sOPEN RULE FOUND — "if true" grants everyone access%s\n' "$YEL" "$N"
  fi
  if grep -qE 'match /admins/' /tmp/live-firestore.rules; then
    echo "  /admins has an explicit rule:"
    grep -A3 'match /admins/' /tmp/live-firestore.rules | sed 's/^/    /'
  else
    printf '  %sNO explicit rule for /admins — it falls through to the catch-all%s\n' "$YEL" "$N"
  fi
  if grep -qE 'request\.time *< *timestamp\.date' /tmp/live-firestore.rules; then
    printf '  %sTIME-LOCKED test rules — these expire and then deny everything%s\n' "$YEL" "$N"
  fi
fi

# ── 2. collections actually present ──────────────────────────────────────────
hdr "2. COLLECTIONS"
curl -s "${AUTH[@]}" -X POST \
  "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$DB/documents:listCollectionIds" \
  -H 'Content-Type: application/json' -d '{}' \
  | jq -r '.collectionIds[]?' | sed 's/^/  /'

# ── 3. who has admin access ──────────────────────────────────────────────────
hdr "3. ADMIN ALLOWLIST  (/admins)"
curl -s "${AUTH[@]}" \
  "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$DB/documents/admins" \
  | jq -r '.documents[]? | "  \(.name|split("/")|last)\n    email:     \(.fields.email.stringValue // "—")\n    grantedAt: \(.fields.grantedAt.timestampValue // "—")\n"'

# ── 4. cross-reference against auth users ────────────────────────────────────
hdr "4. MATCHING AUTH ACCOUNTS"
if command -v firebase >/dev/null; then
  TMP=$(mktemp /tmp/pfa-users.XXXXXX)
  if firebase auth:export "$TMP" --format=json --project "$PROJECT" >/dev/null 2>&1; then
    echo "  total accounts: $(jq '.users|length' "$TMP")"
    echo "  admin accounts:"
    curl -s "${AUTH[@]}" \
      "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$DB/documents/admins" \
      | jq -r '.documents[]?.name|split("/")|last' \
      | while read -r uid; do
          jq -r --arg u "$uid" '.users[]|select(.localId==$u)|
            "    \(.localId)  \(.email // "no-email")  last sign-in: \(.lastSignedInAt // "never")"' "$TMP"
        done
    rm -f "$TMP"
  else
    echo "  auth:export failed — needs Firebase Authentication Admin role"
  fi
else
  echo "  firebase-tools not installed: npm i -g firebase-tools"
fi

hdr "NEXT"
cat <<'EOF'
  Review /tmp/live-firestore.rules. If /admins is client-writable, anyone who
  can sign up can add their own uid and read the whole donor database.

  To deploy hardened rules:
    firebase deploy --only firestore:rules --project pfa-oldsite

  Test them first without touching production:
    firebase emulators:start --only firestore
EOF
