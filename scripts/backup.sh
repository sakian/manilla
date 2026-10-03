#!/usr/bin/env bash
#
# A backup of every ledger's database, and of the node's identity (NF-7).
#
#   bash scripts/backup.sh
#
# Writes a compressed pg_dump of each ledger to $MANILLA_BACKUP_DIR (./backups by
# default), verifies that each file it just wrote can actually be read back, and
# prunes anything older than the retention count, per ledger.
#
# It also copies .env and the Tailscale sidecar's state, both small and both
# load-bearing:
# it is what makes this machine `manilla.<tailnet>.ts.net` rather than some other
# name. Lose it and Tailscale issues a new one - and a passkey is bound to an
# exact hostname, so every registered passkey would stop working at the same
# moment. A ledger restored under a name nobody can sign in to is not a restore.
#
# .env is the other half of that: it is what says which hostname the passkeys are
# bound to. Restoring onto a new machine without it means reconstructing the
# deployment from memory. It also holds an API key, so the file this writes was
# already the most sensitive thing on the disk - it holds the whole ledger - and
# is now sensitive in one more way. Treat it accordingly, or set
# MANILLA_BACKUP_ENV=0 to leave it out.
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

# Postgres runs in Compose here, so its own client tools are used rather than
# asking the host to have a matching version installed - a dump written by an
# older pg_dump than the server is a restore that fails when it is needed.
if docker compose ps --status running --services 2>/dev/null | grep -qx "$CONTAINER"; then
  dump() { docker compose exec -T "$CONTAINER" \
    pg_dump --format=custom --compress=6 --username="$DB_USER" "$1" > "$2"; }
  query() { docker compose exec -T "$CONTAINER" \
    psql --username="$DB_USER" --dbname="$DB_NAME" --no-align --tuples-only --command "$1"; }
  VERIFY=(docker compose exec -T "$CONTAINER" pg_restore --list)
elif command -v pg_dump >/dev/null; then
  : "${DATABASE_URL:?Set DATABASE_URL, or start the database with docker compose up -d db}"
  # The same server and credentials, another database; any ?options carry over.
  URL_BASE="${DATABASE_URL%%\?*}"
  URL_QUERY="${DATABASE_URL#"$URL_BASE"}"
  DB_NAME="${URL_BASE##*/}"
  dump() { pg_dump --format=custom --compress=6 --file="$2" "${URL_BASE%/*}/$1$URL_QUERY"; }
  query() { psql --no-align --tuples-only --command "$1" "$DATABASE_URL"; }
  VERIFY=(pg_restore --list)
else
  echo "backup: no running database container and no pg_dump on this machine" >&2
  exit 1
fi

# Every ledger is a database of its own (LG-7), so each gets its own dump:
# <database>-<stamp>.dump. The home one is the database above; the others are
# the ones opened in Settings, listed in its `ledgers` table - read here rather
# than kept in a list of this script's own, since a ledger left out would be one
# never backed up with nothing to say so. A home database from before that
# table existed has only itself.
FAILED=()
DATABASES=("$DB_NAME")
if HAS_TABLE=$(query "select to_regclass('public.ledgers') is not null" 2>/dev/null); then
  if [[ "$HAS_TABLE" == "t" ]]; then
    if OPENED=$(query "select database from ledgers order by position, created_at" 2>/dev/null); then
      while IFS= read -r database; do
        [[ -n "$database" ]] || continue
        # The rule the app enforces (src/ledgers/config.ts), which also keeps
        # one ledger's dumps from matching another's names.
        if [[ ! "$database" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
          echo "backup: \"$database\" in the ledgers table is not a ledger database name" >&2
          FAILED+=("$database")
          continue
        fi
        DATABASES+=("$database")
      done <<<"$OPENED"
    else
      echo "backup: could not read the list of ledgers - backing up the home one only" >&2
      FAILED+=("the list of ledgers")
    fi
  fi
else
  echo "backup: could not ask $DB_NAME which ledgers there are - backing up it only" >&2
  FAILED+=("the list of ledgers")
fi

# One ledger. Every step is checked by hand: this runs as an `if` condition,
# where bash ignores `set -e`.
backup_ledger() {
  local database="$1"
  local file="$DIR/$database-$STAMP.dump"

  if ! dump "$database" "$file"; then
    echo "backup: pg_dump of $database failed" >&2
    rm -f "$file"
    return 1
  fi
  if [[ ! -s "$file" ]]; then
    echo "backup: $file is empty" >&2
    rm -f "$file"
    return 1
  fi

  # Read the archive back. A truncated or half-written dump fails here.
  local tables
  tables=$("${VERIFY[@]}" < "$file" 2>/dev/null | grep -c 'TABLE DATA' || true)
  if [[ "${tables:-0}" -lt 1 ]]; then
    echo "backup: $file could not be read back - refusing to keep it" >&2
    rm -f "$file"
    return 1
  fi
  echo "backup: $file ($(du -h "$file" | cut -f1), $tables tables)"

  # Prune this ledger's, newest first, keeping $KEEP. "$database-" cannot
  # match another ledger's files: names have no hyphens of their own.
  local stale
  while IFS= read -r stale; do
    [[ -n "$stale" ]] || continue
    rm -f "$stale"
    echo "backup: pruned $(basename "$stale")"
  done < <(ls -1t "$DIR/$database"-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))")
}

# A ledger that fails does not stop the others being backed up; the run still
# fails at the end, loudly, so a scheduled backup that half-worked is noticed.
for database in "${DATABASES[@]}"; do
  backup_ledger "$database" || FAILED+=("$database")
done

# The node's identity, taken from inside the container so it does not matter
# where Docker keeps the volume. Skipped without complaint when the sidecar is
# not running, because a development checkout has no tailnet node to lose.
TS_CONTAINER="${MANILLA_TS_CONTAINER:-tailscale}"
if docker compose ps --status running --services 2>/dev/null | grep -qx "$TS_CONTAINER"; then
  TS_FILE="$DIR/tailscale-state-$STAMP.tar.gz"
  if docker compose exec -T "$TS_CONTAINER" tar -czf - -C /var/lib/tailscale . > "$TS_FILE" 2>/dev/null &&
     tar -tzf "$TS_FILE" >/dev/null 2>&1 &&
     tar -tzf "$TS_FILE" 2>/dev/null | grep -q tailscaled.state; then
    echo "backup: $TS_FILE ($(du -h "$TS_FILE" | cut -f1), node identity)"
  else
    # Loud, but not fatal: the ledger is backed up either way, and failing the
    # whole run would turn a missing extra into a missing backup.
    echo "backup: could not capture the Tailscale state - the database dump is fine" >&2
    rm -f "$TS_FILE"
  fi

  mapfile -t OLD_TS < <(ls -1t "$DIR"/tailscale-state-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))")
  for stale in "${OLD_TS[@]:-}"; do
    [[ -n "$stale" ]] || continue
    rm -f "$stale"
  done
fi

# The deployment's own configuration: four lines, and the difference between a
# restore and an afternoon of guessing which hostname the passkeys were for.
if [[ "${MANILLA_BACKUP_ENV:-1}" == "1" && -f .env ]]; then
  ENV_FILE="$DIR/env-$STAMP.txt"
  cp .env "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "backup: $ENV_FILE (deployment config; holds your API key)"

  mapfile -t OLD_ENV < <(ls -1t "$DIR"/env-*.txt 2>/dev/null | tail -n "+$((KEEP + 1))")
  for stale in "${OLD_ENV[@]:-}"; do
    [[ -n "$stale" ]] || continue
    rm -f "$stale"
  done
fi

for database in "${DATABASES[@]}"; do
  echo "backup: $database: $(ls -1 "$DIR/$database"-*.dump 2>/dev/null | wc -l) kept"
done
echo "backup: restore one with scripts/restore.sh <file>"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "backup: FAILED for ${FAILED[*]} - the other ledgers were backed up" >&2
  exit 1
fi
