import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applySaleEvent } from '../server/sync-sale-handler.mjs';

const outletId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000010';
const saleId = '00000000-0000-4000-8000-000000000020';
const shiftId = '00000000-0000-4000-8000-000000000030';
const paymentId = '00000000-0000-4000-8000-000000000040';
const deviceId = '00000000-0000-4000-8000-000000000003';
const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function salePayload(overrides = {}) {
  return {
    id: saleId,
    number: 'TRX-T3',
    status: 'Lunas',
    at: new Date().toISOString(),
    shiftId,
    outletId,
    subtotal: 20000,
    discount: 0,
    tax: 0,
    service: 0,
    total: 20000,
    items: [{ productId, name: 'Barang uji', qty: 2, price: 10000 }],
    payments: [{ id: paymentId, method: 'Tunai', amount: 20000 }],
    ...overrides,
  };
}

function mockClient({ stock = 5 } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      const sql = typeof text === 'string' ? text : text.text;
      calls.push({ sql, params });
      if (sql.includes('FROM products WHERE id=ANY')) {
        return {
          rows: [
            {
              id: productId,
              sku: 'SKU-1',
              name: 'Barang uji',
              price_rupiah: 10000,
              cost_rupiah: 5000,
              updated_at: '2020-01-01T00:00:00.000Z',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('DISTINCT ON'))
        return {
          rows: [{ payload: { id: productId, price: 10000, name: 'Barang uji' } }],
          rowCount: 1,
        };
      if (sql.includes('FROM sales WHERE id=$1')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM stock_balances'))
        return { rows: [{ quantity: String(stock) }], rowCount: 1 };
      if (sql.includes('SELECT metadata FROM shifts')) return { rows: [], rowCount: 0 };
      if (
        sql.includes('INSERT INTO sales') ||
        sql.includes('INSERT INTO sale_items') ||
        sql.includes('INSERT INTO payments')
      )
        return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function runSale(client, payload, actorRole = 'Kasir') {
  return applySaleEvent({
    client,
    event: { id: '00000000-0000-4000-8000-000000000050', outletId, payload },
    scope: outletId,
    actor: { id: '00000000-0000-4000-8000-000000000002', role: actorRole, name: 'Kasir Uji' },
    deviceId,
    isUuid,
    createHash,
  });
}

test('sale handler rejects invalid sale payload before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applySaleEvent({
      client: {
        query: async () => {
          queries++;
          return { rows: [], rowCount: 0 };
        },
      },
      event: { payload: { id: 'invalid' } },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Admin', name: 'Audit' },
      deviceId: '00000000-0000-4000-8000-000000000003',
      isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
      createHash: () => {
        throw new Error('must not be called for invalid payload');
      },
    }),
    (error) => error.status === 400,
  );
  assert.equal(queries, 0);
});

test('sale handler rejects a Kasir sale with a large unmarked discount before writing', async () => {
  const client = mockClient({ stock: 5 });
  const payload = salePayload({
    discount: 10000,
    total: 10000,
    items: [
      {
        productId,
        name: 'Barang uji',
        qty: 2,
        price: 10000,
        discount: { kind: 'percent', value: 50 },
      },
    ],
    payments: [{ id: paymentId, method: 'Tunai', amount: 10000 }],
  });
  await assert.rejects(
    runSale(client, payload),
    (error) => error.status === 403 && /10%/.test(error.message),
  );
  assert.ok(!client.calls.some((call) => call.sql.includes('INSERT INTO sales')));
  assert.ok(!client.calls.some((call) => call.sql.includes('UPDATE stock_balances')));
});

test('sale handler rejects a sale that exceeds server stock', async () => {
  const client = mockClient({ stock: 1 });
  await assert.rejects(
    runSale(client, salePayload()),
    (error) => error.status === 409 && error.code === 'INSUFFICIENT_STOCK',
  );
  assert.ok(!client.calls.some((call) => call.sql.includes('INSERT INTO sale_items')));
});

test('sale handler deducts stock atomically for a normal sale', async () => {
  const client = mockClient({ stock: 5 });
  await runSale(client, salePayload());
  const stockUpdate = client.calls.find((call) => call.sql.includes('UPDATE stock_balances'));
  assert.equal(stockUpdate.params[3], 3);
  const movement = client.calls.find((call) => call.sql.includes('INSERT INTO stock_movements'));
  assert.equal(movement.params[4], -2);
  assert.equal(movement.params[5], 'Penjualan TRX-T3');
  assert.ok(client.calls.some((call) => call.sql.includes('INSERT INTO sale_items')));
});

test('sale handler accepts a complete refund record and persists the receivable cancellation', async () => {
  const client = mockClient({ stock: 5 });
  const refundId = '00000000-0000-4000-8000-000000000060';
  const payload = salePayload({
    status: 'Dikembalikan',
    refunds: [
      {
        id: refundId,
        amount: 15000,
        cancelledOutstanding: 5000,
        method: 'Tunai',
        reference: null,
        reason: 'Barang rusak',
        approvedByName: 'Admin Uji',
        at: new Date().toISOString(),
      },
    ],
    refundedAmount: 15000,
  });
  await runSale(client, payload, 'Admin');
  const refundInsert = client.calls.find((call) => call.sql.includes('INSERT INTO sale_refunds'));
  assert.ok(refundInsert);
  assert.equal(refundInsert.params[2], 15000);
  assert.equal(refundInsert.params[3], 5000);
  assert.equal(refundInsert.params[7], 'Admin Uji');
  assert.ok(!client.calls.some((call) => call.sql.includes('UPDATE stock_balances')));
});
