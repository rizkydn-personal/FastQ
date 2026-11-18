#!/bin/sh
set -eu

restored_backups=/restore/source/backups
restored_wal=/restore/source/wal-archive

for path in "$restored_backups" "$restored_wal" /backups /wal-archive; do
  if [ ! -d "$path" ]; then
    echo "Direktori restore tidak ditemukan: $path" >&2
    exit 1
  fi
done

for target in /backups /wal-archive; do
  if [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "Volume tujuan $target tidak kosong; impor dibatalkan." >&2
    exit 1
  fi
done

base_backup=$(find "$restored_backups/pitr" -mindepth 1 -maxdepth 1 -type d -name 'base-*' ! -name '*.partial' | sort | tail -n 1)
if [ -z "$base_backup" ] || ! pg_verifybackup "$base_backup"; then
  echo "Base backup offsite tidak ada atau gagal diverifikasi." >&2
  exit 1
fi

dump_file=$(find "$restored_backups" -type f -name 'pos-*.dump' | sort | tail -n 1)
if [ -n "$dump_file" ]; then
  dump_dir=$(dirname "$dump_file")
  dump_name=$(basename "$dump_file")
  (
    cd "$dump_dir"
    sha256sum --check "$dump_name.sha256"
    pg_restore --list "$dump_name" >/dev/null
  )
fi

cp -a "$restored_backups/." /backups/
cp -a "$restored_wal/." /wal-archive/
echo "Backup offsite berhasil diverifikasi dan diimpor ke volume lokal yang kosong."
