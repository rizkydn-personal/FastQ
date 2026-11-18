#!/bin/sh
set -eu
umask 077
: "${POSTGRES_USER:?POSTGRES_USER wajib diatur}"
: "${POSTGRES_DB:?POSTGRES_DB wajib diatur}"
: "${PGPASSWORD:?PGPASSWORD wajib diatur}"
backup_dir="${POS_BACKUP_DIR:-/backups/pitr}"
archive_dir="${POS_WAL_ARCHIVE:-/wal-archive}"
mkdir -p "$backup_dir"

create_base_backup() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$backup_dir/base-$stamp"
  partial="$target.partial"
  rm -rf "$partial"
  if ! pg_basebackup --host=postgres --username="$POSTGRES_USER" \
    --pgdata="$partial" --format=plain --wal-method=stream --checkpoint=fast --no-password; then
    echo "pg_basebackup gagal; percobaan berikutnya dalam lima menit." >&2
    rm -rf "$partial"
    return 1
  fi
  if ! pg_verifybackup "$partial"; then
    echo "Verifikasi base backup gagal; percobaan berikutnya dalam lima menit." >&2
    rm -rf "$partial"
    return 1
  fi
  if ! mv "$partial" "$target"; then
    rm -rf "$partial"
    return 1
  fi
  find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name 'base-*' -mtime +7 -exec rm -rf -- {} +
  find "$archive_dir" -regextype posix-extended -maxdepth 1 -type f \
    -regex '.*/[0-9A-F]{24}\.gz' -mtime +10 -delete
  touch "$backup_dir/.last-success"
  echo "Base backup PITR diverifikasi: $target"
}

while :; do
  if create_base_backup; then
    sleep 86400
  else
    sleep 300
  fi
done
