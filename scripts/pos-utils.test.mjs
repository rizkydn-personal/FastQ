import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, uid } from '../pos-utils.mjs';

test('uid returns UUID v4 values from crypto.randomUUID when available', () => {
  assert.match(uid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('uid uses Web Crypto to produce UUID v4 when randomUUID is unavailable', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let sequence = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues(bytes) { bytes.fill(++sequence); return bytes; } },
  });
  try {
    const first = uid(), second = uid();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(first, second);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
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
