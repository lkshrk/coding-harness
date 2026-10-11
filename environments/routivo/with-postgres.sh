#!/usr/bin/env bash
# Usage: with-postgres <command...>  runs the command with ROUTIVO_DATABASE_URL on a throwaway PostgreSQL 18.
set -euo pipefail

bin=/usr/lib/postgresql/18/bin
dir=$(mktemp -d /tmp/pg.XXXXXX)
port=${PGPORT:-55432}
chown postgres "$dir"
as_pg() { if [[ $(id -u) -eq 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }
trap 'as_pg "$bin/pg_ctl" -D "$dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

as_pg "$bin/initdb" -D "$dir/data" -U routivo --auth=trust -E UTF8 >/dev/null
as_pg "$bin/pg_ctl" -D "$dir/data" -l "$dir/log" -w \
  -o "-k $dir -c listen_addresses=127.0.0.1 -p $port -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
as_pg "$bin/createdb" -h 127.0.0.1 -p "$port" -U routivo routivo

ROUTIVO_DATABASE_URL="postgresql+psycopg://routivo@127.0.0.1:$port/routivo" "$@"
