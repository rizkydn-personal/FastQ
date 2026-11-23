import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaleNumber, createUuid } from '../shared/pos-utils.mjs';
import { parseCSV } from './test-support/csv-parser.mjs';

test('createUuid returns UUID v4 values from crypto.randomUUID when available', () => {
  assert.match(
    createUuid(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('createUuid uses Web Crypto to produce UUID v4 when randomUUID is unavailable', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let sequence = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues(bytes) {
        bytes.fill(++sequence);
        return bytes;
      },
    },
  });
  try {
    const first = createUuid(),
      second = createUuid();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(first, second);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
});

test('sale numbers stay compact while retaining a date and UUID-derived suffix', () => {
  const number = createSaleNumber(
    '550e8400-e29b-41d4-a716-446655440000',
    new Date(2026, 10, 19, 17, 26),
  );
  assert.equal(number, 'TRX-261119-550E8400E29B41D4');
  assert.equal(number.length, 27);
});

test('sale number generation rejects invalid IDs and dates', () => {
  assert.throws(() => createSaleNumber('invalid-id', new Date(2026, 10, 19)), TypeError);
  assert.throws(
    () => createSaleNumber('550e8400-e29b-41d4-a716-446655440000', 'invalid date'),
    TypeError,
  );
});

test('CSV parser handles quoted commas, escaped quotes, and CRLF records', () => {
  assert.deepEqual(parseCSV('nama,catatan\r\n"Teh, hijau","Daun ""pilihan"""\r\n'), [
    ['nama', 'catatan'],
    ['Teh, hijau', 'Daun "pilihan"'],
  ]);
});

test('CSV parser preserves newlines inside quoted fields and drops blank rows', () => {
  assert.deepEqual(parseCSV('sku,note\nA-1,"baris satu\nbaris dua"\n\n'), [
    ['sku', 'note'],
    ['A-1', 'baris satu\nbaris dua'],
  ]);
});

test('CSV parser preserves an empty final column and a final record without newline', () => {
  assert.deepEqual(parseCSV('sku,name,\nA-1,Teh,'), [
    ['sku', 'name', ''],
    ['A-1', 'Teh', ''],
  ]);
});

test('CSV parser removes the UTF-8 BOM written by the product export', () => {
  assert.deepEqual(parseCSV('\uFEFFnama,sku\r\nTeh,A-1'), [
    ['nama', 'sku'],
    ['Teh', 'A-1'],
  ]);
});
