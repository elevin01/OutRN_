#!/usr/bin/env bash
# Stand-in for psql in scripts.test.ts: logs every call (and its stdin) and answers the few
# queries the scripts make. STUB_AREAS lists the service areas that exist (space-separated).
set -u
slug=""
reads_stdin=1
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in slug=*) slug="${a#slug=}" ;; esac
  fi
  case "$a" in -c | -[!-]*c) reads_stdin=0 ;; esac
  prev="$a"
done
stdin=""
if [ "$reads_stdin" = 1 ]; then stdin="$(cat)"; fi
printf 'psql %s | stdin=%s\n' "$*" "$stdin" >>"$STUB_LOG"

case "$*" in
  *"select 1"*) exit 0 ;;
  *"select slug from service_areas"*)
    for a in ${STUB_AREAS:-}; do echo "$a"; done
    exit 0
    ;;
esac
if [ -n "$slug" ]; then
  # The slug must reach the query as a bound psql variable, not spliced into it.
  case "$stdin" in
    *":'slug'"*) ;;
    *)
      echo "stub psql: the slug is not bound as :'slug'" >&2
      exit 3
      ;;
  esac
  case " ${STUB_AREAS:-} " in
    *" $slug "*) echo 1 ;;
    *) echo 0 ;;
  esac
fi
exit 0
