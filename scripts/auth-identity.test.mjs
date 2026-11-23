import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIdentity } from '../server/auth-identity.mjs';

test('email normalization prevents case/space duplicates', () => {
  assert.equal(normalizeIdentity(' Owner@Example.com '), 'owner@example.com');
});
test('Indonesian mobile formats resolve to the same identity', () => {
  for (const value of ['0812-3456-7890', '6281234567890', '+62 812 3456 7890'])
    assert.equal(normalizeIdentity(value), '+6281234567890');
});
test('rejects missing or malformed identities', () => {
  for (const value of [null, {}, '', 'owner@', '0812abc34567890', '123456', '+0123456789'])
    assert.equal(normalizeIdentity(value), null);
});
