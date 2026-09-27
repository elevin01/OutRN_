#!/usr/bin/env bash
# Full-stack smoke test: start an API (the mock, or the real one on DATABASE_URL) and the BUILT web
# app, then check the screens render through the HTTP boundary. CI runs both modes.
#
#   bash scripts/smoke.sh mock    # no database; fixtures only
#   bash scripts/smoke.sh real    # needs DATABASE_URL with the LES synthetic fixture ingested
set -euo pipefail
MODE="${1:-mock}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_PORT="${SMOKE_API_PORT:-4400}"
WEB_PORT="${SMOKE_WEB_PORT:-3400}"
API="http://127.0.0.1:$API_PORT"
WEB="http://127.0.0.1:$WEB_PORT"
AT="2026-10-03T22:30:00Z"
LOGS="$(mktemp -d)"

# Each server runs in its own session so cleanup can stop the whole process tree (pnpm → tsx → node).
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

cd "$ROOT"
API_SCRIPT=start
[ "$MODE" = "mock" ] && API_SCRIPT=mock
PORT="$API_PORT" OUTRN_OPS_TOKEN=smoke setsid pnpm --silent --filter @outrn/api "$API_SCRIPT" </dev/null >"$LOGS/api.log" 2>&1 &
PIDS+=($!)
OUTRN_API_URL="$API" OUTRN_OPS_TOKEN=smoke setsid bash -c "cd packages/web && exec npx next start -p $WEB_PORT" </dev/null >"$LOGS/web.log" 2>&1 &
PIDS+=($!)

wait_for() {
  for _ in $(seq 1 60); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timed out waiting for $1"; echo "--- api log"; cat "$LOGS/api.log"; echo "--- web log"; cat "$LOGS/web.log"; exit 1
}
wait_for "$API/healthz"
wait_for "$WEB/"

fetch() { curl -sf "$WEB$1" || { echo "FAIL $1: HTTP error"; cat "$LOGS/web.log"; exit 1; }; }
expect() {
  local path="$1" pattern="$2" body
  body="$(fetch "$path")"
  if ! grep -q -- "$pattern" <<<"$body"; then echo "FAIL $path: expected /$pattern/"; exit 1; fi
  echo "ok   $path  /$pattern/"
}

expect "/" "What fits right now?"
page1="$(fetch "/?run=1&area=les&minutes=180&at=$AT")"
grep -q "Three ways out" <<<"$page1" || { echo "FAIL results: no three cards"; exit 1; }
echo "ok   results page"
next="$(grep -o 'href="/?cursor=[^"]*"' <<<"$page1" | head -1 | sed 's/^href="//; s/"$//; s/&amp;/\&/g')"
[ -n "$next" ] || { echo "FAIL: no More options link"; exit 1; }
expect "$next" "More ways out"
place="$(grep -o 'href="/places/[^"?]*' <<<"$page1" | head -1 | sed 's/^href="//')"
[ -n "$place" ] || { echo "FAIL: no Details link"; exit 1; }
expect "$place" "What we know"
expect "/?cursor=not-a-cursor" "That page link has expired"
expect "/ops/eligible?run=1&area=les&minutes=180&at=$AT" "Candidate decisions"
if [ "$MODE" = "mock" ]; then
  expect "/?run=1&area=mock-fewer&minutes=60" "We won"
  expect "/?run=1&area=mock-error&minutes=60" 'role="alert"'
fi
echo "smoke ($MODE) passed"
