#!/usr/bin/env bash
# deploy/backup.sh — nightly backup of the Safeer stack (DEPLOYMENT-VPS.md,
# "Backups"). Lives in /srv/safeer next to docker-compose.yml.
#
# Writes to $BACKUP_DIR (default /srv/safeer/backups, mode 700):
#   safeer-db-<UTC>.sql.gz         mysqldump of `safeer` (consistent snapshot)
#   safeer-storage-<UTC>.tar.gz    the `storage` volume (uploads, documents)
# and deletes files there older than $RETENTION_DAYS (default 14).
# Both files hold applicant personal data: they're created 600, and any
# offsite copy must be encrypted.
#
# Cron (root's crontab; the host clock must be UTC — `timedatectl` — so this
# runs after the app's own 03:00 UTC maintenance job):
#   30 3 * * * /srv/safeer/backup.sh >> /var/log/safeer-backup.log 2>&1
#
# Offsite: set OFFSITE_HOOK to an executable; it's called with the two new
# file paths, e.g. a script that runs `rclone copy` to an encrypted remote.
#
# Restore (test it once before go-live, and again after any change here):
#   cd /srv/safeer
#   docker compose stop api web
#   # database: into the existing `safeer` schema (drops and recreates each table)
#   gunzip -c backups/safeer-db-<UTC>.sql.gz \
#     | docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" safeer'
#   # files: empty the volume, then unpack into it
#   docker run --rm --user 0 --entrypoint sh -v safeer_storage:/s \
#     -v "$PWD/backups":/b:ro "ghcr.io/lotfi029/safeer-api:$SAFEER_API_TAG" \
#     -c 'find /s -mindepth 1 -delete && tar -xzf /b/safeer-storage-<UTC>.tar.gz -C /s && chown -R node:node /s'
#   docker compose up -d
# The restored data needs the SAME APP_ENCRYPTION_KEY it was written with
# (app.env); with another key the encrypted ID numbers can't be read and the
# API refuses to start (A7). For a test restore into a scratch schema, create
# it first and pipe the dump into `mysql … safeer_restore_test` instead.
set -euo pipefail
umask 077
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-/srv/safeer/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PROJECT="${COMPOSE_PROJECT_NAME:-safeer}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

log() { echo "$(date -u +%FT%TZ) $*"; }

db_file="$BACKUP_DIR/safeer-db-$STAMP.sql.gz"
storage_file="$BACKUP_DIR/safeer-storage-$STAMP.tar.gz"

# --- database --------------------------------------------------------------
# The root password never reaches a command line: inside the db container it
# is written (printf is a shell builtin, so no process sees it either) to a
# 600 temp file that mysqldump reads with --defaults-extra-file, then removed.
# --single-transaction gives a consistent InnoDB snapshot without locking
# the live site. Written to .part and renamed, so a failed run never leaves
# a truncated file that looks like a good one.
log "dumping database"
docker compose exec -T db sh -c '
  umask 077
  cnf=$(mktemp)
  trap "rm -f \"$cnf\"" EXIT
  printf "[client]\nuser=root\npassword=\"%s\"\n" "$MYSQL_ROOT_PASSWORD" > "$cnf"
  mysqldump --defaults-extra-file="$cnf" \
    --single-transaction --quick --routines --triggers --events \
    --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 \
    safeer
' | gzip -9 > "$db_file.part"
mv "$db_file.part" "$db_file"
log "wrote $db_file ($(du -h "$db_file" | cut -f1))"

# --- storage volume --------------------------------------------------------
# Reuses the API image (already on the host, nothing extra pulled), mounting
# the volume read-only. Running as root inside only to read every file.
log "archiving the storage volume"
api_image="$(docker compose config --images | grep -m1 'safeer-api')"
docker run --rm --user 0 --entrypoint sh \
  -v "${PROJECT}_storage:/s:ro" -v "$BACKUP_DIR:/b" "$api_image" \
  -c "umask 077 && tar -czf /b/$(basename "$storage_file").part -C /s ."
mv "$storage_file.part" "$storage_file"
log "wrote $storage_file ($(du -h "$storage_file" | cut -f1))"

# --- offsite ---------------------------------------------------------------
if [ -n "${OFFSITE_HOOK:-}" ]; then
  log "offsite: $OFFSITE_HOOK"
  "$OFFSITE_HOOK" "$db_file" "$storage_file"
fi

# --- retention -------------------------------------------------------------
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'safeer-*' -mtime +"$RETENTION_DAYS" -print -delete \
  | sed 's/^/removed /'
log "done"
