#!/usr/bin/env bash
# Records real data for every area (or the ones named) into fixtures/live, for `pnpm real` and the
# golden scenarios to replay offline. Needs network access: overpass-api.de for places, and
# www.wikidata.org + commons.wikimedia.org for photos.
#
#   pnpm capture                    # every area
#   pnpm capture yonkers white_plains
#
# Captures are OpenStreetMap data (ODbL, © OpenStreetMap contributors) and Wikimedia metadata.
# fixtures/live is gitignored: add a capture on purpose (git add -f) to share it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# OUTRN_USER_AGENT and OVERPASS_URL may be in .env; the database is this script's own.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ -z "${OUTRN_USER_AGENT:-}" ]; then
  echo "Set OUTRN_USER_AGENT (in .env or the environment) to something that identifies you: Overpass and Wikimedia ask for it." >&2
  exit 1
fi

BASE="postgres://outrn@127.0.0.1:${PGPORT_OUTRN:-54329}"
# The local cluster (pnpm db:start), unless one already answers on the port.
psql "$BASE/postgres" -qAtc "select 1" >/dev/null 2>&1 || bash scripts/db-start.sh
PGOPTIONS=--client-min-messages=warning psql "$BASE/postgres" -qc "drop database if exists outrn_capture" -c "create database outrn_capture" >/dev/null
psql "$BASE/outrn_capture" -qc "create extension if not exists postgis; create extension if not exists pgcrypto;" >/dev/null
export DATABASE_URL="$BASE/outrn_capture"
pnpm -s db:migrate >/dev/null

if [ "$#" -gt 0 ]; then slugs=("$@"); else mapfile -t slugs < <(psql "$DATABASE_URL" -Atc "select slug from service_areas order by slug"); fi
photos_supported=false
if pnpm -s outrn ingest photos --help >/dev/null 2>&1; then photos_supported=true; fi
mkdir -p fixtures/live

failed=()
for slug in "${slugs[@]}"; do
  echo
  echo "== ${slug}"
  if ! pnpm -s outrn ingest osm --area "$slug" --save "fixtures/live/${slug}.json"; then
    failed+=("$slug")
    continue
  fi
  if $photos_supported && ! pnpm -s outrn ingest photos --area "$slug" --save "fixtures/live/${slug}-photos.json"; then
    failed+=("${slug} (photos)")
  fi
  sleep 10 # Overpass is a shared, free service: space the queries out
done

echo
ls -la fixtures/live
if [ "${#failed[@]}" -gt 0 ]; then
  echo "Failed: ${failed[*]}. Run them again: pnpm capture <slug>…" >&2
  exit 1
fi
echo "Done. Replay them with: pnpm real"
