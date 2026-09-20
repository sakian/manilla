#!/usr/bin/env bash
#
# Restore a backup, and check that what came back is a ledger that balances (NF-7).
#
#   bash scripts/restore.sh                      # newest backup -> a scratch database
#   bash scripts/restore.sh backups/xyz.dump     # a particular one
#   bash scripts/restore.sh --into manilla       # over the live database, asks first
#
# By default this restores into `manilla_restore_check` and leaves the live
# database alone, so the restore procedure can be exercised on an ordinary
# Tuesday rather than discovered on the worst day of the year. A backup nobody
# has restored is a hope, not a backup.
#
# After restoring it runs the FR-37 check against the restored copy: envelope
# balances against account balances. That is the difference between "the file
# could be read" and "the books came back".

set -euo pipefail

cd "$(dirname "$0")/.."

DIR="${MANILLA_BACKUP_DIR:-./backups}"
CONTAINER="${MANILLA_DB_CONTAINER:-db}"
DB_USER="${POSTGRES_USER:-manilla}"
TARGET="manilla_restore_check"
FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --into)
      TARGET="$2"
      shift 2
      ;;
    *)
      FILE="$1"
      shift
      ;;
  esac
done

if [[ -z "$FILE" ]]; then
  FILE="$(ls -1t "$DIR"/manilla-*.dump 2>/dev/null | head -1 || true)"
fi

if [[ -z "$FILE" || ! -s "$FILE" ]]; then
  echo "restore: no backup found in $DIR" >&2
  exit 1
fi

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$CONTAINER"; then
  echo "restore: the database container is not running (docker compose up -d db)" >&2
  exit 1
fi

# Restoring over live data is the one operation here that destroys something, so
# it is never the default and never silent.
if [[ "$TARGET" != "manilla_restore_check" ]]; then
  echo "About to replace the contents of \"$TARGET\" with $FILE."
  read -r -p "Type the database name to confirm: " typed
  if [[ "$typed" != "$TARGET" ]]; then
    echo "restore: not confirmed, nothing was touched" >&2
    exit 1
  fi
fi

psql_run() {
  docker compose exec -T "$CONTAINER" psql --username="$DB_USER" --dbname=postgres \
    --quiet --no-align --tuples-only --command "$1"
}

echo "restore: $FILE -> $TARGET"
psql_run "drop database if exists \"$TARGET\" with (force)" >/dev/null
psql_run "create database \"$TARGET\"" >/dev/null

docker compose exec -T "$CONTAINER" \
  pg_restore --username="$DB_USER" --dbname="$TARGET" --no-owner --exit-on-error < "$FILE"

# What came back, and does it add up?
REPORT=$(docker compose exec -T "$CONTAINER" psql --username="$DB_USER" --dbname="$TARGET" \
  --quiet --no-align --tuples-only --field-separator=' ' --command "
  select
    (select count(*) from transactions),
    (select count(*) from envelopes),
    (select count(*) from accounts),
    coalesce((select min(date)::text from transactions), '-'),
    coalesce((select max(date)::text from transactions), '-'),
    (select coalesce(sum(amount_cents), 0) from transactions)
      - (select coalesce(sum(amount_cents), 0) from txn_lines)
      - coalesce((select sum(t.amount_cents) from transactions t
                  where t.kind = 'spending'
                    and not exists (select 1 from txn_lines l where l.transaction_id = t.id)), 0)
")

read -r TXNS ENVS ACCTS FIRST LAST GAP <<<"$REPORT"

echo "restore: $TXNS transactions, $ENVS envelopes, $ACCTS accounts, $FIRST to $LAST"

if [[ "$GAP" == "0" ]]; then
  echo "restore: envelopes and accounts agree in the restored copy (FR-37)"
else
  echo "restore: RESTORED COPY IS OUT OF BALANCE by $GAP cents" >&2
  exit 1
fi

if [[ "$TARGET" == "manilla_restore_check" ]]; then
  echo "restore: the live database was not touched; drop the check copy with"
  echo "         docker compose exec -T $CONTAINER psql -U $DB_USER -d postgres \\"
  echo "           -c 'drop database \"$TARGET\" with (force)'"
fi
