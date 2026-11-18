#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo "archive-wal.sh memerlukan path file WAL dan nama arsip." >&2
  exit 2
fi
source_file="$1"
wal_name="$2"
if [ ! -f "$source_file" ]; then
  echo "File WAL tidak ditemukan atau bukan file biasa." >&2
  exit 1
fi
case "$wal_name" in
  ????????????????????????)
    case "$wal_name" in *[!0-9A-Fa-f]*) echo "Nama segmen WAL tidak valid." >&2; exit 2 ;; esac
    ;;
  ????????.history)
    timeline="${wal_name%.history}"
    case "$timeline" in *[!0-9A-Fa-f]*) echo "Nama timeline WAL tidak valid." >&2; exit 2 ;; esac
    ;;
  *) echo "Nama arsip WAL tidak valid." >&2; exit 2 ;;
esac
archive_dir="${POS_WAL_ARCHIVE:-/wal-archive}"
destination="$archive_dir/$wal_name.gz"
temporary="$destination.partial.$$"

if [ -e "$destination" ]; then
  if gzip -t "$destination" && gzip -dc "$destination" | cmp -s "$source_file" -; then
    exit 0
  fi
  echo "Arsip WAL $wal_name sudah ada tetapi isinya berbeda atau rusak." >&2
  exit 1
fi

if ! gzip -c "$source_file" > "$temporary"; then
  rm -f "$temporary"
  exit 1
fi
chmod 0600 "$temporary"
if ! mv -n -- "$temporary" "$destination"; then
  rm -f "$temporary"
  exit 1
fi
if [ -e "$temporary" ]; then
  rm -f "$temporary"
  gzip -t "$destination" && gzip -dc "$destination" | cmp -s "$source_file" -
fi
