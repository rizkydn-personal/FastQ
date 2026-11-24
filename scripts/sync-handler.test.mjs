import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHandler } from '../server/sync-handler.mjs';

test('sync event id conflict rejects only that event and reports its stored-event conflict code', async () => {
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
      bootstrap: true,
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

  const response = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));
  assert.equal(response.status, 200);
  assert.equal(response.body.bootstrapTruncated, false);
  assert.deepEqual(response.body.rejected, [
    {
      id: eventId,
      code: 'SYNC_EVENT_ID_CONFLICT',
      message: 'ID event sudah pernah dipakai untuk perubahan yang berbeda.',
      retryable: false,
    },
  ]);
  assert.deepEqual(response.body.accepted, []);
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
      bootstrap: true,
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
  assert.equal(response.body.bootstrapTruncated, false);
  assert.ok(calls.includes('COMMIT'));
});

test('incremental sync returns authoritative balances for products in remote stock events', async () => {
  const outletId = '00000000-0000-4000-8000-000000000001';
  const productId = '00000000-0000-4000-8000-000000000002';
  let stockQueryParameters;
  const client = {
    async query(sql, parameters) {
      if (sql.includes('minimum_cursor')) return { rows: [{ minimum_cursor: 0 }], rowCount: 1 };
      if (sql.includes('last_cursor')) return { rows: [{ last_cursor: 1 }], rowCount: 1 };
      if (sql.includes('SELECT server_cursor,event_id,device_id,outlet_id,event_type,payload')) {
        return {
          rows: [
            {
              server_cursor: 2,
              event_id: '00000000-0000-4000-8000-000000000003',
              device_id: '00000000-0000-4000-8000-000000000004',
              outlet_id: outletId,
              event_type: 'stock.delta',
              payload: { productId, outletId, delta: 2 },
              occurred_at: '2026-11-22T05:00:00.000Z',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('COALESCE(balance.quantity,0)')) {
        stockQueryParameters = parameters;
        return {
          rows: [{ product_id: productId, variant_id: null, quantity: '7' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const handler = createSyncHandler({
    pool: { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) },
    activeSession: async () => ({ outlet_id: outletId, role: 'Admin' }),
    json: (_res, status, body) => ({ status, body }),
    readJson: async () => ({
      deviceId: '00000000-0000-4000-8000-000000000005',
      cursor: 1,
      bootstrap: false,
      activeShiftId: null,
      events: [],
    }),
    requireSameOrigin() {},
    isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    createHash() {},
  });

  const response = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));
  assert.equal(response.status, 200);
  assert.deepEqual(stockQueryParameters, [outletId, [productId]]);
  assert.deepEqual(response.body.stockBalances, [
    { outletId, productId, variantId: null, quantity: 7 },
  ]);
});

test('sync response flags remote sales with stock conflicts', async () => {
  const outletId = '00000000-0000-4000-8000-000000000001';
  const saleId = '00000000-0000-4000-8000-000000000022';
  const productId = '00000000-0000-4000-8000-000000000023';
  const client = {
    async query(sql) {
      if (sql.includes('minimum_cursor')) return { rows: [{ minimum_cursor: 0 }], rowCount: 1 };
      if (sql.includes('SELECT last_cursor')) return { rows: [{ last_cursor: 0 }], rowCount: 1 };
      if (sql.includes('SELECT server_cursor,event_id,device_id,outlet_id,event_type,payload')) {
        return {
          rows: [
            {
              server_cursor: 1,
              event_id: '00000000-0000-4000-8000-000000000024',
              device_id: '00000000-0000-4000-8000-000000000025',
              outlet_id: outletId,
              event_type: 'sale.upsert',
              payload: { id: saleId },
              occurred_at: '2026-11-22T05:00:00.000Z',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT DISTINCT sale.id AS sale_id')) {
        return {
          rows: [
            {
              sale_id: saleId,
              product_id: productId,
              variant_id: null,
              quantity: '-1',
            },
          ],
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
    activeSession: async () => ({ outlet_id: outletId, role: 'Admin' }),
    json: (_res, status, body) => ({ status, body }),
    readJson: async () => ({
      deviceId: '00000000-0000-4000-8000-000000000026',
      cursor: 0,
      bootstrap: false,
      activeShiftId: null,
      events: [],
    }),
    requireSameOrigin() {},
    isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    createHash() {},
  });

  const response = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.stockConflicts, [
    {
      saleId,
      stockConflict: true,
      stockBalances: [{ outletId, productId, variantId: null, quantity: -1 }],
    },
  ]);
});

test('a rejected event rolls back to its savepoint while the rest of its batch is accepted', async () => {
  const validId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const events = Array.from({ length: 5 }, (_, index) => ({
    id: validId(100 + index),
    type: 'audit.append',
    outletId: validId(9),
    at: new Date().toISOString(),
    payload: {
      id: validId(200 + index),
      action: index === 2 ? '' : `Audit ${index}`,
      detail: '',
      at: new Date().toISOString(),
    },
  }));
  const client = {
    async query(sql) {
      if (sql.includes('minimum_cursor')) return { rows: [{ minimum_cursor: 0 }], rowCount: 1 };
      if (sql.includes('last_cursor')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id FROM (')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT COALESCE(MAX(server_cursor)'))
        return { rows: [{ cursor: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const handler = createSyncHandler({
    pool: { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) },
    activeSession: async () => ({
      outlet_id: validId(9),
      role: 'Admin',
      id: validId(8),
      name: 'Admin',
    }),
    json: (_res, status, body) => ({ status, body }),
    readJson: async () => ({ deviceId: validId(1), cursor: 0, bootstrap: true, events }),
    requireSameOrigin() {},
    isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    createHash() {},
  });

  const response = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.accepted,
    events.filter((_, index) => index !== 2).map((event) => event.id),
  );
  assert.equal(response.body.rejected.length, 1);
  assert.equal(response.body.rejected[0].id, events[2].id);
  assert.equal(response.body.rejected[0].code, 'SYNC_EVENT_REJECTED');
  assert.equal(response.body.rejected[0].retryable, false);
});
