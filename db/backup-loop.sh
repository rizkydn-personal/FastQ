#!/bin/sh
set -eu
umask 077
: "${POSTGRES_USER:?POSTGRES_USER wajib diatur}"
: "${POSTGRES_DB:?POSTGRES_DB wajib diatur}"
: "${PGPASSWORD:?PGPASSWORD wajib diatur}"
backup_dir="${POS_BACKUP_DIR:-/backups}"
mkdir -p "$backup_dir"

create_backup() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="$backup_dir/pos-$stamp.dump"
  partial="$backup_file.partial"
  partial_sum="$partial.sha256"
  if ! pg_dump --host postgres --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --format=custom --no-owner --no-acl --file="$partial"; then
    echo "pg_dump gagal; backup berikutnya dicoba dalam lima menit." >&2
    rm -f "$partial" "$partial_sum"
    return 1
  fi
  if ! pg_restore --list "$partial" >/dev/null; then
    echo "Arsip hasil pg_dump tidak valid; backup berikutnya dicoba dalam lima menit." >&2
    rm -f "$partial" "$partial_sum"
    return 1
  fi
  if ! checksum="$(sha256sum "$partial")"; then
    echo "Checksum backup gagal; backup berikutnya dicoba dalam lima menit." >&2
    rm -f "$partial" "$partial_sum"
    return 1
  fi
  if ! printf '%s  %s\n' "${checksum%% *}" "$(basename "$backup_file")" > "$partial_sum"; then
    rm -f "$partial" "$partial_sum"
    return 1
  fi
  if ! mv "$partial" "$backup_file"; then
    rm -f "$partial" "$partial_sum"
    return 1
  fi
  if ! mv "$partial_sum" "$backup_file.sha256"; then
    rm -f "$backup_file" "$partial_sum"
    return 1
  fi
  if ! (cd "$backup_dir" && sha256sum --check "$(basename "$backup_file").sha256" && pg_restore --list "$backup_file" >/dev/null); then
    echo "Verifikasi backup setelah dipublikasikan gagal; backup sebelumnya dipertahankan." >&2
    rm -f "$backup_file" "$backup_file.sha256"
    return 1
  fi
  find "$backup_dir" -type f \( -name 'pos-*.dump' -o -name 'pos-*.dump.sha256' \) -mtime +30 -delete
  find "$backup_dir" -type f -name 'pos-*.dump.partial*' -mtime +1 -delete
  touch "$backup_dir/.last-success"
  echo "Backup diverifikasi dan disimpan: $backup_file"
}

while :; do
  if create_backup; then
    sleep 86400
  else
    sleep 300
  fi
done
