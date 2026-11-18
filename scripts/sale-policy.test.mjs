import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSalePayload } from '../sale-policy.mjs';

const uuid = '00000000-0000-4000-8000-000000000001';
const validSale = payment => ({
  id: uuid,
  number: 'TRX-TEST',
  status: 'Lunas',
  at: new Date().toISOString(),
  subtotal: 100,
  discount: 0,
  tax: 0,
  service: 0,
  total: 100,
  items: [{ productId: uuid, name: 'Barang uji', qty: 1, price: 100 }],
  payments: [{ id: '00000000-0000-4000-8000-000000000002', method: 'Tunai', amount: 100, ...payment }],
});

test('sale payment status accepts bounded strings and omitted legacy values', () => {
  assert.doesNotThrow(() => validateSalePayload(validSale({ status: 'Lunas' })));
  assert.doesNotThrow(() => validateSalePayload(validSale({})));
  assert.doesNotThrow(() => validateSalePayload(validSale({ status: 'x'.repeat(40) })));
});

test('sale payment status rejects non-string and oversized values', () => {
  assert.throws(() => validateSalePayload(validSale({ status: { value: 'Lunas' } })), /Pembayaran transaksi tidak valid/);
  assert.throws(() => validateSalePayload(validSale({ status: 'x'.repeat(41) })), /Pembayaran transaksi tidak valid/);
});
