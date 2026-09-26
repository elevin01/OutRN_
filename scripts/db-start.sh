#!/usr/bin/env bash
# Starts a throwaway local Postgres 16 + PostGIS cluster for development.
# Data lives in .pgdata/ (gitignored). Port 54329 so it never collides with a system Postgres.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="$ROOT/.pgdata"
PORT="${PGPORT_OUTRN:-54329}"
RUNAS=""
if [ "$(id -u)" = "0" ]; then RUNAS="sudo -u postgres"; fi

if [ ! -d "$DATA" ]; then
  mkdir -p "$DATA"; [ -n "$RUNAS" ] && chown postgres "$DATA"
  $RUNAS "$PGBIN/initdb" -D "$DATA" -U outrn --auth=trust -E UTF8 >/dev/null
fi
if ! $RUNAS "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  $RUNAS "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/server.log" start >/dev/null
fi
for i in $(seq 1 20); do
  if psql -h 127.0.0.1 -p "$PORT" -U outrn -d postgres -c "select 1" >/dev/null 2>&1; then break; fi; sleep 0.5
done
psql -h 127.0.0.1 -p "$PORT" -U outrn -d postgres -tc "select 1 from pg_database where datname='outrn'" | grep -q 1 \
  || psql -h 127.0.0.1 -p "$PORT" -U outrn -d postgres -c "create database outrn" >/dev/null
psql -h 127.0.0.1 -p "$PORT" -U outrn -d outrn -c "create extension if not exists postgis; create extension if not exists pgcrypto;" >/dev/null
echo "postgres ready: postgres://outrn@127.0.0.1:$PORT/outrn"
