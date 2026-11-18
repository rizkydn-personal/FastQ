import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStockEvent } from '../sync-stock-handler.mjs';

test('stock handler rejects invalid deltas before database access', async () => {
  let queries = 0;
  await assert.rejects(applyStockEvent({ client: { query: async () => { queries++; return { rows: [], rowCount: 0 }; } }, event: { type: 'stock.delta', payload: { outletId: '', productId: '', delta: 0 } }, scope: '00000000-0000-4000-8000-000000000001', actor: { role: 'Admin' }, isUuid: value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) }), error => error.status === 400);
  assert.equal(queries, 0);
});
