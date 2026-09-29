#!/usr/bin/env bash
# Runs OutRN on real places: every OpenStreetMap capture in fixtures/live, served by the real API,
# ready for the web app and the mobile app to point at.
#
#   pnpm real                 # local Postgres (pnpm db:start), a fresh database "outrn_real", API on :4000
#   HOST=0.0.0.0 pnpm real    # reachable from a phone on the same network
#   REAL_DATABASE_URL=postgres://… pnpm real   # another database instead (its tables are replaced)
#
# Each fixtures/live/<area>.json is ingested and the area switched on (served); a
# fixtures/live/<area>-photos.json next to it brings its photos. Capture more with `pnpm capture`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-4000}"
HOST="${HOST:-127.0.0.1}"

if [ -n "${REAL_DATABASE_URL:-}" ]; then
  export DATABASE_URL="$REAL_DATABASE_URL"
  pnpm -s db:reset >/dev/null
else
  BASE="postgres://outrn@127.0.0.1:${PGPORT_OUTRN:-54329}"
  # The local cluster (pnpm db:start), unless one already answers on the port.
  psql "$BASE/postgres" -qAtc "select 1" >/dev/null 2>&1 || bash scripts/db-start.sh
  PGOPTIONS=--client-min-messages=warning psql "$BASE/postgres" -qc "drop database if exists outrn_real" -c "create database outrn_real" >/dev/null
  psql "$BASE/outrn_real" -qc "create extension if not exists postgis; create extension if not exists pgcrypto;" >/dev/null
  export DATABASE_URL="$BASE/outrn_real"
fi
pnpm -s db:migrate >/dev/null
echo "database ready: ${DATABASE_URL%%@*}@…"

photos_supported=false
if pnpm -s outrn ingest photos --help >/dev/null 2>&1; then photos_supported=true; fi

shopt -s nullglob
served=()
for file in fixtures/live/*.json; do
  slug="$(basename "$file" .json)"
  case "$slug" in *-photos) continue ;; esac
  echo
  echo "== ${slug}"
  if ! pnpm -s outrn ingest osm --area "$slug" --from-file "$file" | grep -E "venues|parking"; then
    echo "   skipped: ${slug} is not an area here (outrn areas list)"
    continue
  fi
  if [ -f "fixtures/live/${slug}-photos.json" ] && $photos_supported; then
    pnpm -s outrn ingest photos --area "$slug" --from-file "fixtures/live/${slug}-photos.json" | grep -E "photos" || true
  fi
  if pnpm -s outrn areas launch "$slug" >/dev/null 2>&1; then served+=("$slug"); else echo "   not served: no eligible venues"; fi
done

cat <<EOF

Serving ${served[*]:-no areas} on http://${HOST}:${PORT}  (ctrl-c stops it)

  Web:     OUTRN_API_URL=http://localhost:${PORT} pnpm web:dev      → http://localhost:3000
  Mobile:  in apps/mobile/.env set EXPO_PUBLIC_API_URL=http://<this computer's address>:${PORT}
           and EXPO_PUBLIC_DEMO_MODE=false, then pnpm mobile:dev   (start this with HOST=0.0.0.0 for a phone)
  Browser preview of the mobile app (pnpm mobile:web) is allowed from http://localhost:8081.

Recommendations are for right now, where the area is. Only areas with a capture in fixtures/live
are served; \`pnpm capture\` records the rest (needs network access).
EOF
export OUTRN_WEB_ORIGINS="${OUTRN_WEB_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000,http://localhost:8081,http://127.0.0.1:8081}"
HOST="$HOST" PORT="$PORT" exec pnpm --silent --filter @outrn/api start
