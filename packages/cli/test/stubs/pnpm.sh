#!/usr/bin/env bash
# Stand-in for pnpm in scripts.test.ts: logs every call (with the DATABASE_URL it was given) and
# answers the way the real commands do, failing where the test asks it to.
#   STUB_AREAS          the service areas that exist (space-separated)
#   STUB_PHOTOS         set: this checkout has `outrn ingest photos`
#   STUB_FAIL_OSM       areas whose `ingest osm` fails (after --save has written, like the real CLI)
#   STUB_FAIL_PHOTOS    areas whose `ingest photos` fails (after --save has written)
#   STUB_FAIL_OVERTURE  areas whose `ingest overture` fails (--save writes before anything else, like the real CLI)
#   STUB_NO_VENUES      areas `areas launch` refuses for having no eligible venues
#   STUB_FAIL_LAUNCH    areas `areas launch` fails for any other reason
#   STUB_MIGRATE_EXIT   exit status of db:migrate
set -u
printf 'pnpm %s | DATABASE_URL=%s\n' "$*" "${DATABASE_URL:-}" >>"$STUB_LOG"
listed() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    -s | --silent) shift ;;
    *) break ;;
  esac
done
case "${1:-}" in
  db:migrate) exit "${STUB_MIGRATE_EXIT:-0}" ;;
  db:reset) exit 0 ;;
  --filter)
    echo "API STARTED"
    exit 0
    ;;
  outrn) shift ;;
  *)
    echo "stub pnpm: unexpected call: $*" >&2
    exit 97
    ;;
esac

group="${1:-}"
cmd="${2:-}"
shift 2
area=""
from=""
save=""
help=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --area) area="$2"; shift 2 ;;
    --from-file) from="$2"; shift 2 ;;
    --save) save="$2"; shift 2 ;;
    --help) help=1; shift ;;
    *) area="$1"; shift ;;
  esac
done

known() {
  if ! listed "$area" "${STUB_AREAS:-}"; then
    echo "error: unknown service area: $area" >&2
    exit 1
  fi
}
# A replay reads its file first: anything that is not a JSON object fails like a corrupt capture.
replay() {
  if [ -n "$from" ]; then
    case "$(cat "$from")" in
      "{"*) ;;
      *)
        echo "error: Unexpected token in JSON at position 0 ($from)" >&2
        exit 1
        ;;
    esac
  fi
}

case "$group $cmd" in
  "ingest osm")
    known
    replay
    if [ -n "$save" ] && [ -z "$from" ]; then printf '{"osm":"new %s"}' "$area" >"$save"; fi
    if listed "$area" "${STUB_FAIL_OSM:-}"; then
      echo "error: could not write the raw store" >&2
      exit 1
    fi
    echo "fetched 10 elements"
    echo ""
    echo "  venues     5 created · 0 linked to existing"
    echo "  parking    2 public places to park · 0 removed"
    ;;
  "ingest photos")
    if [ "$help" = 1 ]; then
      # The real CLI without the command prints the help of `ingest`, and succeeds.
      if [ -n "${STUB_PHOTOS:-}" ]; then echo "Usage: outrn ingest photos [options]"; else echo "Usage: outrn ingest [options] [command]"; fi
      exit 0
    fi
    if [ -z "${STUB_PHOTOS:-}" ]; then
      echo "error: unknown command 'photos'" >&2
      exit 1
    fi
    known
    replay
    if [ -n "$save" ] && [ -z "$from" ]; then printf '{"photos":"new %s"}' "$area" >"$save"; fi
    if listed "$area" "${STUB_FAIL_PHOTOS:-}"; then
      echo "error: Wikimedia answered 500" >&2
      exit 1
    fi
    echo "  photos     3 for 2 of 5 venues"
    ;;
  "ingest overture")
    known
    replay
    if [ -n "$save" ] && [ -z "$from" ]; then printf '{"outrn_capture":"overture","area":"new %s"}' "$area" >"$save"; fi
    if listed "$area" "${STUB_FAIL_OVERTURE:-}"; then
      echo "error: could not write facts" >&2
      exit 1
    fi
    echo "  places     10 Overture places · 4 of 5 venues matched"
    echo "  claims     4 operating · 0 closed · 1 websites · 1 phones"
    ;;
  "areas launch")
    known
    if listed "$area" "${STUB_NO_VENUES:-}"; then
      echo "error: $area has no eligible venues yet: run pnpm outrn ingest osm --area $area first (or --force)" >&2
      exit 1
    fi
    if listed "$area" "${STUB_FAIL_LAUNCH:-}"; then
      echo "error: Connection terminated unexpectedly" >&2
      exit 1
    fi
    echo "$area test"
    ;;
  *)
    echo "stub pnpm: unexpected call: outrn $group $cmd" >&2
    exit 97
    ;;
esac
