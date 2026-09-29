#!/usr/bin/env bash
# Records real data for every area (or the ones named) into fixtures/live, for `pnpm real` and the
# golden scenarios to replay offline. Needs network access: overpass-api.de for places,
# www.wikidata.org + commons.wikimedia.org for photos, and overturemaps-us-west-2.s3.us-west-2.amazonaws.com
# for Overture Maps places (whether each place still operates, websites, phones).
#
#   pnpm capture                    # every area
#   pnpm capture yonkers white_plains
#   CAPTURE_PAUSE_SECONDS=30 pnpm capture   # seconds between areas (default 10)
#
# Each area is recorded into a staging directory next to fixtures/live and replaces
# fixtures/live/<area>.json, <area>-photos.json and <area>-overture.json only once every step for it
# has succeeded, so a failed capture leaves the previous set exactly as it was. The database is the script's own
# (outrn_capture on the local cluster, recreated each run). It runs on macOS's Bash 3.2.
#
# Captures are OpenStreetMap data (ODbL, © OpenStreetMap contributors), Wikimedia metadata, and
# Overture Maps places (CDLA-Permissive-2.0; Foursquare's records Apache-2.0).
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
PAUSE="${CAPTURE_PAUSE_SECONDS:-10}"
case "$PAUSE" in
  "" | *[!0123456789]*)
    echo "CAPTURE_PAUSE_SECONDS must be a whole number of seconds" >&2
    exit 1
    ;;
esac

BASE="postgres://outrn@127.0.0.1:${PGPORT_OUTRN:-54329}"
# The URLs below name the server: don't let the environment send psql to another one.
unset PGHOSTADDR PGSERVICE
# The local cluster (pnpm db:start), unless one already answers on the port.
psql -X "$BASE/postgres" -qAtc "select 1" >/dev/null 2>&1 || bash scripts/db-start.sh
PGOPTIONS=--client-min-messages=warning psql -X -v ON_ERROR_STOP=1 "$BASE/postgres" -qc "drop database if exists outrn_capture" -c "create database outrn_capture" >/dev/null
psql -X -v ON_ERROR_STOP=1 "$BASE/outrn_capture" -qc "create extension if not exists postgis; create extension if not exists pgcrypto;" >/dev/null
export DATABASE_URL="$BASE/outrn_capture"
pnpm -s db:migrate >/dev/null

# Bash 3.2 has no mapfile, and under set -u treats "${slugs[@]}" of an empty array as unbound:
# read the list line by line and count it before expanding it.
slugs=()
count=0
if [ "$#" -gt 0 ]; then
  slugs=("$@")
  count=$#
else
  list="$(psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -qAtc "select slug from service_areas order by slug")"
  while IFS= read -r slug; do
    if [ -n "$slug" ]; then
      slugs+=("$slug")
      count=$((count + 1))
    fi
  done <<EOF
$list
EOF
fi
if [ "$count" -eq 0 ]; then
  echo "No service areas in outrn_capture: nothing to capture." >&2
  exit 1
fi

# Only a checkout with `outrn ingest photos` records photos. An older CLI asked for that command's
# help prints the help of `ingest` and succeeds, so look for the command's own usage line.
photos_supported=false
photos_help="$(pnpm -s outrn ingest photos --help 2>/dev/null || true)"
case "$photos_help" in *"ingest photos"*) photos_supported=true ;; esac

mkdir -p fixtures/live
# The staging directory of the area being captured; whatever is left of it goes on exit.
stage=""
cleanup() {
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

failed=""
retry=""
done_count=0
for slug in "${slugs[@]}"; do
  if [ "$done_count" -gt 0 ] && [ "$PAUSE" -gt 0 ]; then
    sleep "$PAUSE" # Overpass is a shared, free service: space the queries out
  fi
  done_count=$((done_count + 1))
  echo
  echo "== ${slug}"
  case "$slug" in
    "" | *[!abcdefghijklmnopqrstuvwxyz0123456789_]*)
      echo "   not an area slug: ${slug}" >&2
      failed="${failed:+${failed}, }${slug}"
      continue
      ;;
  esac
  osm="fixtures/live/${slug}.json"
  photos="fixtures/live/${slug}-photos.json"
  # Same filesystem as fixtures/live, so the final mv is a rename.
  stage="$(mktemp -d "${ROOT}/fixtures/live/.staging.XXXXXX")"
  new_osm="${stage}/${slug}.json"
  new_photos="${stage}/${slug}-photos.json"
  overture="fixtures/live/${slug}-overture.json"
  new_overture="${stage}/${slug}-overture.json"

  problem=""
  if ! pnpm -s outrn ingest osm --area "$slug" --save "$new_osm"; then
    problem="places"
  elif [ ! -s "$new_osm" ]; then
    problem="places: nothing saved"
  elif $photos_supported; then
    if ! pnpm -s outrn ingest photos --area "$slug" --save "$new_photos"; then
      problem="photos"
    elif [ ! -s "$new_photos" ]; then
      problem="photos: nothing saved"
    fi
  fi

  # Overture reads the venues the places step just stored: only after it succeeded.
  if [ -z "$problem" ]; then
    if ! pnpm -s outrn ingest overture --area "$slug" --save "$new_overture"; then
      problem="overture"
    elif [ ! -s "$new_overture" ]; then
      problem="overture: nothing saved"
    fi
  fi

  if [ -n "$problem" ]; then
    echo "   ${slug} (${problem}) failed: kept the previous capture as it was" >&2
    failed="${failed:+${failed}, }${slug} (${problem})"
    retry="${retry:+${retry} }${slug}"
  else
    if $photos_supported; then
      mv -f "$new_photos" "$photos"
    fi
    mv -f "$new_overture" "$overture"
    mv -f "$new_osm" "$osm"
    if $photos_supported; then
      echo "   saved ${osm}, ${photos} and ${overture}"
    else
      echo "   saved ${osm} and ${overture}"
      if [ -f "$photos" ]; then
        echo "   note: ${photos} is from an earlier capture (this checkout has no \`outrn ingest photos\`)"
      fi
    fi
  fi
  rm -rf "$stage"
  stage=""
done

echo
ls -la fixtures/live
if [ -n "$failed" ]; then
  echo "Failed: ${failed}. Run them again: pnpm capture ${retry:-<slug>…}" >&2
  exit 1
fi
echo "Done. Replay them with: pnpm real"
