#!/usr/bin/env bash
#
# A backup of the whole database (NF-7).
#
#   bash scripts/backup.sh
#
# Writes a compressed pg_dump to $MANILLA_BACKUP_DIR (./backups by default),
# verifies that the file it just wrote can actually be read back, and prunes
# anything older than the retention count.
#
# The verification matters more than it looks. A dump that failed halfway is
# still a file of plausible size sitting in the right directory, and the only
# moment anyone would notice is the one moment it must not happen. This reads
# the archive's table of contents back and fails loudly if it cannot.
#
# Restoring is scripts/restore.sh, and it is worth running now and then rather
# than trusting that it would work.

set -euo pipefail

cd "$(dirname "$0")/.."

DIR="${MANILLA_BACKUP_DIR:-./backups}"
KEEP="${MANILLA_BACKUP_KEEP:-14}"
CONTAINER="${MANILLA_DB_CONTAINER:-db}"
DB_NAME="${POSTGRES_DB:-manilla}"
DB_USER="${POSTGRES_USER:-manilla}"

mkdir -p "$DIR"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
FILE="$DIR/manilla-$STAMP.dump"

# Postgres runs in Compose here, so its own client tools are used rather than
# asking the host to have a matching version installed - a dump written by an
# older pg_dump than the server is a restore that fails when it is needed.
if docker compose ps --status running --services 2>/dev/null | grep -qx "$CONTAINER"; then
  docker compose exec -T "$CONTAINER" \
    pg_dump --format=custom --compress=6 --username="$DB_USER" "$DB_NAME" > "$FILE"
  VERIFY=(docker compose exec -T "$CONTAINER" pg_restore --list)
  verify_input() { cat "$FILE"; }
elif command -v pg_dump >/dev/null; then
  : "${DATABASE_URL:?Set DATABASE_URL, or start the database with docker compose up -d db}"
  pg_dump --format=custom --compress=6 --file="$FILE" "$DATABASE_URL"
  VERIFY=(pg_restore --list)
  verify_input() { cat "$FILE"; }
else
  echo "backup: no running database container and no pg_dump on this machine" >&2
  exit 1
fi

if [[ ! -s "$FILE" ]]; then
  echo "backup: $FILE is empty" >&2
  rm -f "$FILE"
  exit 1
fi

# Read the archive back. A truncated or half-written dump fails here.
TABLES=$(verify_input | "${VERIFY[@]}" 2>/dev/null | grep -c 'TABLE DATA' || true)
if [[ "${TABLES:-0}" -lt 1 ]]; then
  echo "backup: $FILE could not be read back - refusing to keep it" >&2
  rm -f "$FILE"
  exit 1
fi

SIZE=$(du -h "$FILE" | cut -f1)
echo "backup: $FILE ($SIZE, $TABLES tables)"

# Prune, newest first, keeping $KEEP.
mapfile -t OLD < <(ls -1t "$DIR"/manilla-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))")
for stale in "${OLD[@]:-}"; do
  [[ -n "$stale" ]] || continue
  rm -f "$stale"
  echo "backup: pruned $(basename "$stale")"
done

echo "backup: $(ls -1 "$DIR"/manilla-*.dump 2>/dev/null | wc -l) kept, restore with scripts/restore.sh"
