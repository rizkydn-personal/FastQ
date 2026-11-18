#!/bin/sh
set -eu

: "${RESTIC_REPOSITORY:?Set POS_OFFSITE_RESTIC_REPOSITORY in .env}"
: "${RESTIC_PASSWORD:?Set a unique POS_OFFSITE_RESTIC_PASSWORD in .env}"
: "${AWS_ACCESS_KEY_ID:?Set POS_OFFSITE_S3_ACCESS_KEY_ID in .env}"
: "${AWS_SECRET_ACCESS_KEY:?Set POS_OFFSITE_S3_SECRET_ACCESS_KEY in .env}"

restic_cmd() {
  restic \
    -o "s3.region=${AWS_DEFAULT_REGION:-us-east-1}" \
    -o "s3.bucket-lookup=${POS_OFFSITE_S3_BUCKET_LOOKUP:-auto}" \
    "$@"
}

# Allow one-shot repository administration and restore commands through Compose.
if [ "$#" -gt 0 ]; then
  if [ "$1" = restore ] && [ -n "$(find /restore -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "Volume restore /restore tidak kosong; bersihkan atau ganti volume sebelum memulihkan lagi." >&2
    exit 1
  fi
  restic_cmd "$@"
  exit $?
fi

backup_once() {
  restic_cmd backup \
    --tag fastq-pos \
    --exclude '*.partial' \
    --exclude '**/*.partial' \
    /source/backups /source/wal-archive || return 1

  if [ "$(date -u +%u)" = 7 ]; then
    restic_cmd forget \
      --keep-daily 30 \
      --keep-weekly 12 \
      --keep-monthly 12 \
      --prune || return 1
  else
    restic_cmd forget \
      --keep-daily 30 \
      --keep-weekly 12 \
      --keep-monthly 12 || return 1
  fi

  restic_cmd check || return 1
  touch /tmp/.last-success
}

while :; do
  if backup_once; then
    echo "Backup offsite FastQ berhasil; percobaan berikutnya dalam 24 jam."
    sleep 86400
  else
    echo "Backup offsite gagal; akan dicoba lagi dalam lima menit." >&2
    sleep 300
  fi
done
