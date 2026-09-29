#!/usr/bin/env bash
# Runs OutRN on real places: every OpenStreetMap capture in fixtures/live, served by the real API,
# ready for the web app and the mobile app to point at.
#
#   pnpm real                 # local Postgres (pnpm db:start), a fresh database "outrn_real", API on :4000
#   HOST=0.0.0.0 pnpm real    # reachable from a phone on the same network
#
# The only database it touches is outrn_real on the local cluster (127.0.0.1, port $PGPORT_OUTRN or
# 54329), which it drops and recreates on every run. It takes no database URL.
#
# Each fixtures/live/<area>.json is ingested and the area switched on (served); a
# fixtures/live/<area>-photos.json next to it brings its photos, and <area>-overture.json checks its
# places against Overture Maps (still operating, closed, websites and phones). A capture named after something
# that is not an area here is skipped. A capture of a real area that fails to replay stops the run
# before the API starts, so what is served is never a silent subset. Capture more with `pnpm capture`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-4000}"
HOST="${HOST:-127.0.0.1}"

fail() {
  echo "pnpm real: $*" >&2
  exit 1
}

# It used to replace the tables of whatever database this named. Refuse it rather than ignore it,
# and never echo it: it may hold a password.
if [ -n "${REAL_DATABASE_URL+set}" ]; then
  fail "REAL_DATABASE_URL is no longer supported: pnpm real only ever replaces the local database outrn_real. Unset it and run again."
fi

DB_NAME=outrn_real
DB_PORT="${PGPORT_OUTRN:-54329}"
BASE="postgres://outrn@127.0.0.1:${DB_PORT}"
# The URLs below name the server: don't let the environment send psql to another one.
unset PGHOSTADDR PGSERVICE
# The local cluster (pnpm db:start), unless one already answers on the port.
psql -X "$BASE/postgres" -qAtc "select 1" >/dev/null 2>&1 || bash scripts/db-start.sh
PGOPTIONS=--client-min-messages=warning psql -X -v ON_ERROR_STOP=1 "$BASE/postgres" -qc "drop database if exists ${DB_NAME}" -c "create database ${DB_NAME}" >/dev/null ||
  fail "could not recreate the database ${DB_NAME} on 127.0.0.1:${DB_PORT} (is an earlier pnpm real still running?)"
psql -X -v ON_ERROR_STOP=1 "$BASE/${DB_NAME}" -qc "create extension if not exists postgis; create extension if not exists pgcrypto;" >/dev/null ||
  fail "could not set up the extensions in ${DB_NAME}"
export DATABASE_URL="$BASE/${DB_NAME}"
pnpm -s db:migrate >/dev/null || fail "the migrations failed on ${DB_NAME}"
echo "database ready: ${DB_NAME} on 127.0.0.1:${DB_PORT}"

# Only a checkout with `outrn ingest photos` replays photos. An older CLI asked for that command's
# help prints the help of `ingest` and succeeds, so look for the command's own usage line.
photos_supported=false
photos_help="$(pnpm -s outrn ingest photos --help 2>/dev/null || true)"
case "$photos_help" in *"ingest photos"*) photos_supported=true ;; esac

# The summary lines of a command's output, captured first so that its exit status is its own.
summary() {
  printf '%s\n' "$1" | grep -E "$2" || true
}

# How many service areas have the slug $1 (0 or 1). The slug is bound by psql, never spliced into SQL.
area_count() {
  printf "select count(*) from service_areas where slug = :'slug';\n" | psql -X -v ON_ERROR_STOP=1 -v slug="$1" -qAt "$DATABASE_URL"
}

shopt -s nullglob
served=""
for file in fixtures/live/*.json; do
  slug="$(basename "$file" .json)"
  case "$slug" in *-photos | *-overture) continue ;; esac
  echo
  echo "== ${slug}"
  known="$(area_count "$slug")" || fail "could not look up ${slug} in ${DB_NAME}"
  case "$known" in
    0)
      echo "   skipped: ${slug} is not an area here (pnpm outrn areas list)"
      continue
      ;;
    1) ;;
    *) fail "could not look up ${slug} in ${DB_NAME}" ;;
  esac

  if ! out="$(pnpm -s outrn ingest osm --area "$slug" --from-file "$file")"; then
    if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
    fail "${slug}: ${file} did not replay (see above), so nothing is served. Re-record it with pnpm capture ${slug}, or move it out of fixtures/live."
  fi
  summary "$out" "venues|parking"

  photos="fixtures/live/${slug}-photos.json"
  if [ -f "$photos" ]; then
    if $photos_supported; then
      if ! out="$(pnpm -s outrn ingest photos --area "$slug" --from-file "$photos")"; then
        if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
        fail "${slug}: ${photos} did not replay (see above), so nothing is served. Re-record it with pnpm capture ${slug}, or move it out of fixtures/live."
      fi
      summary "$out" "photos"
    else
      echo "   photos not replayed: this checkout has no \`outrn ingest photos\`"
    fi
  fi

  overture="fixtures/live/${slug}-overture.json"
  if [ -f "$overture" ]; then
    if ! out="$(pnpm -s outrn ingest overture --area "$slug" --from-file "$overture")"; then
      if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
      fail "${slug}: ${overture} did not replay (see above), so nothing is served. Re-record it with pnpm capture ${slug}, or move it out of fixtures/live."
    fi
    summary "$out" "places|claims"
  fi

  # `areas launch` refuses an area with no eligible venues; any other failure is a real one.
  if out="$(pnpm -s outrn areas launch "$slug" 2>&1)"; then
    served="${served:+${served} }${slug}"
  else
    case "$out" in
      *"no eligible venues"*) echo "   not served: no eligible venues" ;;
      *)
        if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
        fail "${slug}: could not switch the area on (see above), so nothing is served."
        ;;
    esac
  fi
done

cat <<EOF

Serving ${served:-no areas} on http://${HOST}:${PORT}  (ctrl-c stops it)

  Web:     OUTRN_API_URL=http://localhost:${PORT} pnpm web:dev      → http://localhost:3000
  Mobile:  in apps/mobile/.env set EXPO_PUBLIC_API_URL=http://<this computer's address>:${PORT}
           and EXPO_PUBLIC_DEMO_MODE=false, then pnpm mobile:dev   (start this with HOST=0.0.0.0 for a phone)
  Browser preview of the mobile app (pnpm mobile:web) is allowed from http://localhost:8081.

Recommendations are for right now, where the area is. Only areas with a capture in fixtures/live
are served; \`pnpm capture\` records the rest (needs network access).
EOF
export OUTRN_WEB_ORIGINS="${OUTRN_WEB_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000,http://localhost:8081,http://127.0.0.1:8081}"
HOST="$HOST" PORT="$PORT" exec pnpm --silent --filter @outrn/api start
