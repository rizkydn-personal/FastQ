import { readdir, readFile } from 'node:fs/promises';
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

const migrationUrl = process.env.POS_MIGRATION_DATABASE_URL;
if (!migrationUrl)
  throw new Error(
    'POS_MIGRATION_DATABASE_URL wajib dikonfigurasi. Migrasi DDL tidak memakai DATABASE_URL runtime.',
  );
const { Pool } = await import('pg');
const pool = new Pool({
  connectionString: migrationUrl,
  max: 1,
  connectionTimeoutMillis: 15000,
  ssl: postgresSslFromEnv(),
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('fastq-pos-schema-migrations'))");
  await client.query('CREATE SCHEMA IF NOT EXISTS public');
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app_runtime`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO pos_app_runtime`);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const applied = await client.query('SELECT version FROM schema_migrations');
  const versions = new Set(applied.rows.map((row) => Number(row.version)));
  if (!versions.has(1)) {
    await client.query(await readFile(resolve(root, 'db/schema.sql'), 'utf8'));
    await client.query(
      "INSERT INTO schema_migrations(version,name) VALUES(1,'baseline') ON CONFLICT(version) DO NOTHING",
    );
    versions.add(1);
    console.log('Migrasi 1 (baseline) diterapkan.');
  }

  const directory = resolve(root, 'db/migrations');
  let files = [];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const migrations = files
    .map((name) => ({ name, version: Number(name.match(/^(\d+)_.*\.sql$/)?.[1]) }))
    .filter((item) => Number.isSafeInteger(item.version) && item.version > 1)
    .sort((a, b) => a.version - b.version);
  let latestVersion = Math.max(0, ...versions);
  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    if (migration.version !== latestVersion + 1)
      throw new Error(`Urutan migrasi terputus setelah versi ${latestVersion}.`);
    await client.query(await readFile(resolve(directory, migration.name), 'utf8'));
    await client.query('INSERT INTO schema_migrations(version,name) VALUES($1,$2)', [
      migration.version,
      migration.name,
    ]);
    console.log(`Migrasi ${migration.version} (${migration.name}) diterapkan.`);
    latestVersion = migration.version;
  }
  await client.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pos_app_runtime',
  );
  await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pos_app_runtime');
  await client.query(
    'REVOKE INSERT, UPDATE, DELETE ON TABLE public.schema_migrations FROM pos_app_runtime',
  );
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
