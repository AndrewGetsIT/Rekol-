#!/usr/bin/env bash
# Spins up a throwaway Postgres 16, applies the Supabase stub, the migrations
# (twice each, to prove they are idempotent), seeds data and runs the isolation tests.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# Locate the Postgres 16 binaries (override with PGBIN=...). Covers Debian/Ubuntu and Homebrew.
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  for d in /usr/lib/postgresql/16/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin; do
    if [ -x "$d/initdb" ]; then PGBIN="$d"; break; fi
  done
fi
[ -n "$PGBIN" ] || { echo "Postgres 16 not found. Install it or set PGBIN=/path/to/bin" >&2; exit 1; }
# macOS's postmaster refuses to start without a valid LC_ALL.
if [ -z "${LC_ALL:-}" ]; then
  LOCALES="$(locale -a 2>/dev/null || true)"
  case "$LOCALES" in
    *en_US.UTF-8*) export LC_ALL=en_US.UTF-8 ;;
    *C.UTF-8*|*C.utf8*) export LC_ALL=C.UTF-8 ;;
  esac
fi
DATA="$(mktemp -d)"
PORT=55432

if [ "$(id -u)" = "0" ]; then
  chown -R postgres "$DATA"
  RUN() { su postgres -s /bin/bash -c "$*"; }
else
  RUN() { bash -c "$*"; }
fi

cleanup() { RUN "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

RUN "$PGBIN/initdb -D $DATA -U postgres -A trust --no-locale -E UTF8 >/dev/null"
RUN "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log -w start >/dev/null"

PSQL="$PGBIN/psql -h /tmp -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t"
$PSQL -f "$HERE/00_supabase_stub.sql"
echo "== applying migration (1st run)"
$PSQL -f "$ROOT/migrations/20261011_multitenant_partners.sql"
echo "== applying migration (2nd run, idempotency check)"
$PSQL -f "$ROOT/migrations/20261011_multitenant_partners.sql"
echo "== applying profile billing guard (1st run)"
$PSQL -f "$ROOT/migrations/20261017_protect_profile_billing.sql"
echo "== applying profile billing guard (2nd run, idempotency check)"
$PSQL -f "$ROOT/migrations/20261017_protect_profile_billing.sql"
$PSQL -f "$HERE/10_seed.sql"
echo "== running isolation tests"
$PSQL -f "$HERE/20_rls_isolation_test.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //'
echo "== running profile guard tests"
$PSQL -f "$HERE/30_profile_guard_test.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //'
