#!/bin/sh
set -eu
: "${BASE_BACKUP:?Set BASE_BACKUP to the base-YYYYMMDDTHHMMSSZ directory name}"
: "${RECOVERY_TARGET_TIME:?Set RECOVERY_TARGET_TIME in UTC, for example 2026-11-14 04:30:00+00}"
case "$BASE_BACKUP" in
  base-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) echo "Nama base backup tidak valid." >&2; exit 2 ;;
esac
case "$RECOVERY_TARGET_TIME" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]+00) ;;
  *) echo "Waktu target harus berformat YYYY-MM-DD HH:MM:SS+00 (UTC)." >&2; exit 2 ;;
esac

base_dir="/backups/pitr/$BASE_BACKUP"
restore_dir="${PGDATA:-/restore-data}"
test -d "$base_dir" || { echo "Base backup tidak ditemukan: $base_dir" >&2; exit 1; }
pg_verifybackup "$base_dir"
if [ -n "$(find "$restore_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Volume staging tidak kosong; pemulihan dibatalkan agar data yang ada tidak tertimpa." >&2
  exit 1
fi

cp -a "$base_dir"/. "$restore_dir"/
chown -R postgres:postgres "$restore_dir"
printf "\nrestore_command = 'gzip -dc /wal-archive/%%f.gz > %%p'\nrecovery_target_time = '%s'\nrecovery_target_action = 'pause'\n" \
  "$RECOVERY_TARGET_TIME" >> "$restore_dir/postgresql.auto.conf"
touch "$restore_dir/recovery.signal"
chown postgres:postgres "$restore_dir/postgresql.auto.conf" "$restore_dir/recovery.signal"
echo "Base backup disiapkan di $restore_dir untuk target $RECOVERY_TARGET_TIME. Jalankan service postgres-restore dengan profile restore."
