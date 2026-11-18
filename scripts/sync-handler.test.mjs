import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHandler } from '../sync-handler.mjs';

test('sync response returns the outlet stock snapshot after committing', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('minimum_cursor')) return { rows: [{ minimum_cursor: 0 }], rowCount: 1 };
      if (sql.includes('last_cursor')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT server_cursor')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT product_id,variant_id,quantity')) {
        return { rows: [{ product_id: 'product-a', variant_id: null, quantity: '12' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const handler = createSyncHandler({
    pool,
    activeSession: async () => ({ outlet_id: 'outlet-a', role: 'Admin' }),
    json: (_res, status, body) => ({ status, body }),
    readJson: async () => ({
      deviceId: '00000000-0000-4000-8000-000000000001',
      cursor: 0,
      activeShiftId: null,
      events: [],
    }),
    requireSameOrigin() {},
    isUuid: value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    createHash() {},
  });

  const response = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.stockBalances, [{
    outletId: 'outlet-a',
    productId: 'product-a',
    variantId: null,
    quantity: 12,
  }]);
  assert.ok(calls.includes('COMMIT'));
});
