import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresSslFromEnv } from '../server/postgres-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const envFile = await readFile(resolve(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]])
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum dikonfigurasi.');
const { Pool } = await import('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15000,
  ssl: postgresSslFromEnv(),
});
try {
  const result = await pool.query(
    "DELETE FROM daily_backups WHERE backup_date < CURRENT_DATE - INTERVAL '90 days'",
  );
  console.log(`${result.rowCount} backup aplikasi berusia lebih dari 90 hari dihapus.`);
  console.log(
    'Event sinkronisasi dipertahankan sampai API bootstrap snapshot untuk perangkat baru tersedia.',
  );
} finally {
  await pool.end();
}
