import test from 'node:test';
import assert from 'node:assert/strict';
import { timestampMs } from '../server/timestamp-utils.mjs';

test('timestampMs preserves milliseconds from PostgreSQL Date objects', () => {
  const timestamp = '2026-11-16T04:10:04.750Z';
  assert.equal(timestampMs(new Date(timestamp)), Date.parse(timestamp));
  assert.equal(new Date(timestampMs(new Date(timestamp))).getUTCMilliseconds(), 750);
});

test('timestampMs rejects values that are neither Date objects nor strings', () => {
  assert.ok(Number.isNaN(timestampMs(null)));
  assert.ok(Number.isNaN(timestampMs(1794802204750)));
});
