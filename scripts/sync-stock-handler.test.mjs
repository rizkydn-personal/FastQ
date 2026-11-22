import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStockEvent } from '../sync-stock-handler.mjs';

test('stock handler rejects invalid deltas before database access', async () => {
  let queries = 0;
  await assert.rejects(applyStockEvent({ client: { query: async () => { queries++; return { rows: [], rowCount: 0 }; } }, event: { type: 'stock.delta', payload: { outletId: '', productId: '', delta: 0 } }, scope: '00000000-0000-4000-8000-000000000001', actor: { role: 'Admin' }, isUuid: value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) }), error => error.status === 400);
  assert.equal(queries, 0);
});

const outletId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000010';
const saleId = '00000000-0000-4000-8000-000000000020';
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function stockDeltaClient({ matching = 1, prior = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async query(text) {
      const sql = typeof text === 'string' ? text : text.text;
      calls.push(sql);
      if (sql.includes('FROM sales WHERE id=$1')) return { rows: [{ sale_number: 'TRX-T3', status: 'Lunas' }], rowCount: 1 };
      if (sql.includes('FROM sale_items')) return { rows: [{ count: matching }], rowCount: 1 };
      if (sql.includes('FROM stock_movements')) return { rows: [{ count: prior }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('stock handler accepts a sale-linked delta the server already deducted, without deducting twice', async () => {
  const client = stockDeltaClient({ matching: 1, prior: 1 });
  await applyStockEvent({
    client,
    event: { type: 'stock.delta', payload: { outletId, productId, variantId: null, delta: -2, reason: 'Penjualan TRX-T3', saleId } },
    scope: outletId,
    actor: { role: 'Kasir' },
    isUuid,
  });
  assert.ok(!client.calls.some(sql => sql.includes('UPDATE stock_balances')));
});

test('stock handler still rejects a sale-linked delta that matches no sale item', async () => {
  const client = stockDeltaClient({ matching: 0, prior: 0 });
  await assert.rejects(
    applyStockEvent({
      client,
      event: { type: 'stock.delta', payload: { outletId, productId, variantId: null, delta: -2, reason: 'Penjualan TRX-T3', saleId } },
      scope: outletId,
      actor: { role: 'Kasir' },
      isUuid,
    }),
    error => error.status === 409,
  );
});
