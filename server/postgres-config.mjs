import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export function postgresSslFromEnv(
  env = process.env,
  readRootCert = (path) => readFileSync(path, 'utf8'),
) {
  const mode = String(env.PGSSLMODE || '')
    .trim()
    .toLowerCase();
  const rootCertPath = String(env.PGSSLROOTCERT || '').trim();
  if (!mode) {
    if (rootCertPath)
      throw new Error('PGSSLMODE=verify-full wajib diisi bila PGSSLROOTCERT dikonfigurasi.');
    return undefined;
  }
  if (!['require', 'verify-full'].includes(mode))
    throw new Error('PGSSLMODE hanya menerima nilai kosong, require, atau verify-full.');

  const ssl = { rejectUnauthorized: true };
  if (rootCertPath) {
    const caPath = isAbsolute(rootCertPath) ? rootCertPath : resolve(projectRoot, rootCertPath);
    const ca = readRootCert(caPath);
    if (
      typeof ca !== 'string' ||
      !ca.includes('-----BEGIN CERTIFICATE-----') ||
      !ca.includes('-----END CERTIFICATE-----')
    ) {
      throw new Error('PGSSLROOTCERT harus menunjuk file sertifikat CA format PEM.');
    }
    ssl.ca = ca;
  }
  return ssl;
}

export function postgresConnectionTlsStatus(client) {
  const stream = client?.connection?.stream;
  if (!stream?.encrypted) return 'disabled';
  return stream.authorized === true ? 'verified' : 'unverified';
}
