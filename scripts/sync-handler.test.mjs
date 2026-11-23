import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHandler } from '../server/sync-handler.mjs';

test('sync event id conflict returns the stored event so the client can reconcile', async () => {
  const eventId = '00000000-0000-4000-8000-000000000021';
  const storedSaleId = '00000000-0000-4000-8000-000000000022';
  const incomingSaleId = '00000000-0000-4000-8000-000000000023';
  const client = {
    async query(sql) {
      if (sql.includes('minimum_cursor')) return { rows: [{ minimum_cursor: 0 }], rowCount: 1 };
      if (sql.includes('last_cursor')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO sync_events')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT event_type,outlet_id,payload,occurred_at FROM sync_events')) {
        return {
          rows: [
            {
              event_type: 'sale.upsert',
              outlet_id: 'outlet-a',
              payload: { id: storedSaleId, number: 'TRX-STORED', status: 'Lunas' },
              occurred_at: '2026-11-22T05:00:00.000Z',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT id FROM (')) return { rows: [], rowCount: 0 };
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
      events: [
        {
          id: eventId,
          type: 'sale.upsert',
          outletId: 'outlet-a',
          at: '2026-11-22T05:00:00.000Z',
          payload: { id: incomingSaleId, number: 'TRX-OTHER', status: 'Lunas' },
        },
      ],
    }),
    requireSameOrigin() {},
    isUuid: (value) =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    createHash() {},
  });

  await assert.rejects(
    handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync')),
    (error) =>
      error.status === 409 &&
      error.code === 'SYNC_EVENT_ID_CONFLICT' &&
      error.conflict?.type === 'sync-event-id' &&
      error.conflict?.eventId === eventId &&
      error.conflict?.storedEvent?.payload?.id === storedSaleId,
  );
});

test('sync response returns the outlet stock snapshot after committing', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('minimum_cursor')) return { rows: [{ minimum_cursor: 0 }], rowCount: 1 };
      if (sql.includes('last_cursor')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT server_cursor')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT product_id,variant_id,quantity')) {
        return {
          rows: [{ product_id: 'product-a', variant_id: null, quantity: '12' }],
          rowCount: 1,
        };
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
    isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    createHash() {},
  });

  const response = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.stockBalances, [
    {
      outletId: 'outlet-a',
      productId: 'product-a',
      variantId: null,
      quantity: 12,
    },
  ]);
  assert.ok(calls.includes('COMMIT'));
});
