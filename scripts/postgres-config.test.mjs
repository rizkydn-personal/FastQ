import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { postgresConnectionTlsStatus, postgresSslFromEnv } from '../postgres-config.mjs';

const ca = '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----';

test('PostgreSQL TLS stays disabled for local configuration without SSL settings', () => {
  assert.equal(postgresSslFromEnv({}), undefined);
});

test('PostgreSQL TLS requires certificate verification when enabled', () => {
  assert.deepEqual(postgresSslFromEnv({ PGSSLMODE: 'require' }), { rejectUnauthorized: true });
  assert.deepEqual(postgresSslFromEnv({ PGSSLMODE: 'verify-full' }), { rejectUnauthorized: true });
});

test('PostgreSQL TLS loads a configured provider CA certificate', () => {
  assert.deepEqual(
    postgresSslFromEnv({ PGSSLMODE: 'require', PGSSLROOTCERT: 'provider-ca.pem' }, path => {
      assert.equal(basename(path), 'provider-ca.pem');
      return ca;
    }),
    { rejectUnauthorized: true, ca },
  );
});

test('PostgreSQL TLS rejects unsupported modes and a CA path without TLS', () => {
  assert.throws(() => postgresSslFromEnv({ PGSSLMODE: 'prefer' }), /nilai kosong, require, atau verify-full/);
  assert.throws(() => postgresSslFromEnv({ PGSSLROOTCERT: 'provider-ca.pem' }), /PGSSLMODE=verify-full/);
});

test('PostgreSQL TLS rejects a configured CA file without PEM certificate markers', () => {
  assert.throws(() => postgresSslFromEnv({ PGSSLMODE: 'require', PGSSLROOTCERT: 'bad.pem' }, () => 'not a PEM certificate'), /format PEM/);
});

test('PostgreSQL TLS status reports the actual client socket state', () => {
  assert.equal(postgresConnectionTlsStatus({ connection: { stream: { encrypted: true, authorized: true } } }), 'verified');
  assert.equal(postgresConnectionTlsStatus({ connection: { stream: { encrypted: true, authorized: false } } }), 'unverified');
  assert.equal(postgresConnectionTlsStatus({ connection: { stream: {} } }), 'disabled');
});
