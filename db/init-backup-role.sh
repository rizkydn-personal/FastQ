#!/bin/sh
set -eu
: "${POS_BACKUP_PASSWORD:?POS_BACKUP_PASSWORD wajib diatur}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=backup_password="$POS_BACKUP_PASSWORD" <<'SQL'
CREATE ROLE pos_backup LOGIN REPLICATION PASSWORD :'backup_password';
GRANT CONNECT ON DATABASE pos TO pos_backup;
GRANT pg_read_all_data TO pos_backup;
SQL
