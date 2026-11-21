import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDatabaseReadiness, REQUIRED_SCHEMA_VERSION } from '../database-policy.mjs';
import { postgresConnectionTlsStatus, postgresSslFromEnv } from '../postgres-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const envFile = await readFile(resolve(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

if (!process.env.DATABASE_URL) {
  console.error('Database runtime readiness: database_url_missing');
  process.exitCode = 1;
} else {
  let pool;
  try {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000, query_timeout: 15000, ssl: postgresSslFromEnv() });
    const result = await checkDatabaseReadiness(pool, REQUIRED_SCHEMA_VERSION);
    const client = await pool.connect();
    let tls;
    try { tls = postgresConnectionTlsStatus(client); }
    finally { client.release(); }
    const blockers = result.blockers?.length ? `; blockers=${result.blockers.join(',')}` : '';
    const warnings = result.warnings?.length ? `; warnings=${result.warnings.join(',')}` : '';
    console.log(`Database runtime readiness: ${result.reason}${result.ready ? ` (schema ${result.version})` : blockers}${warnings}; tls=${tls}`);
    if (!result.ready) process.exitCode = 1;
  } catch {
    console.error('Database runtime readiness: database_unavailable');
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
