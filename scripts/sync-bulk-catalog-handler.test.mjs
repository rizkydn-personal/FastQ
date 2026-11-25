import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyBulkCatalogEvent } from '../server/sync-bulk-catalog-handler.mjs';
import { createSyncHandler } from '../server/sync-handler.mjs';

const outletId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const newProductId = '00000000-0000-4000-8000-000000000003';
const existingProductId = '00000000-0000-4000-8000-000000000004';
const eventId = '00000000-0000-4000-8000-000000000005';
const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function product(id, sku, stock, stockDelta = null) {
  return {
    id,
    sku,
    name: `Produk ${sku}`,
    category: 'Kategori',
    unit: 'pcs',
    price: 1000,
    cost: 500,
    minStock: 0,
    stock,
    stockDelta,
    variants: [],
  };
}

function recorder({ identityRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (/SELECT id,sku,barcode,outlet_id,metadata FROM products/.test(sql))
          return { rowCount: identityRows.length, rows: identityRows };
        if (/INSERT INTO categories/.test(sql))
          return {
            rowCount: 1,
            rows: [{ id: '00000000-0000-4000-8000-000000000006', name: 'Kategori' }],
          };
        if (/INSERT INTO products/.test(sql))
          return { rowCount: JSON.parse(values[0]).length, rows: [] };
        if (/INSERT INTO stock_balances/.test(sql))
          return { rowCount: JSON.parse(values[0]).length, rows: [] };
        return { rowCount: 0, rows: [] };
      },
    },
  };
}

test('bulk catalog import writes products and stock movements with contiguous SQL parameters', async () => {
  const { calls, client } = recorder({
    identityRows: [
      {
        id: existingProductId,
        sku: 'EXISTING',
        outlet_id: outletId,
        metadata: { stockByOutlet: { [outletId]: 4 }, favorite: true },
      },
    ],
  });
  await applyBulkCatalogEvent({
    client,
    scope: outletId,
    actor: { id: actorId },
    isUuid,
    createHash,
    event: {
      id: eventId,
      at: '2026-01-02T03:04:05.000Z',
      payload: {
        products: [product(existingProductId, 'EXISTING', 7, 3), product(newProductId, 'NEW', 5)],
      },
    },
  });

  assert.equal(calls.length, 5);
  const savedProducts = JSON.parse(calls[2].values[0]);
  assert.equal(savedProducts[0].min_stock, 0);
  assert.deepEqual(savedProducts[0].metadata.stockByOutlet, { [outletId]: 7 });
  assert.equal(savedProducts[0].metadata.favorite, true);
  const stockMovements = calls[4];
  assert.match(stockMovements.sql, /\$3,\$4/);
  assert.equal(stockMovements.values.length, 4);
  assert.equal(stockMovements.values[2], '2026-01-02T03:04:05.000Z');
  assert.equal(stockMovements.values[3], actorId);
  const movements = JSON.parse(stockMovements.values[0]);
  assert.equal(movements.length, 2);
  assert.ok(movements.every((movement) => isUuid(movement.id)));
});

test('bulk catalog import rejects duplicate identities and foreign-outlet products before writes', async () => {
  const duplicate = recorder();
  await assert.rejects(
    applyBulkCatalogEvent({
      client: duplicate.client,
      scope: outletId,
      actor: { id: actorId },
      isUuid,
      createHash,
      event: {
        id: eventId,
        payload: {
          products: [product(newProductId, 'DUP', 1), product(existingProductId, 'dup', 2)],
        },
      },
    }),
    (error) => error.status === 409,
  );
  assert.equal(duplicate.calls.length, 0);

  const foreign = recorder({
    identityRows: [
      {
        id: newProductId,
        sku: 'NEW',
        outlet_id: '00000000-0000-4000-8000-000000000099',
        metadata: {},
      },
    ],
  });
  await assert.rejects(
    applyBulkCatalogEvent({
      client: foreign.client,
      scope: outletId,
      actor: { id: actorId },
      isUuid,
      createHash,
      event: { id: eventId, payload: { products: [product(newProductId, 'NEW', 1)] } },
    }),
    (error) => error.status === 404,
  );
  assert.equal(foreign.calls.length, 1);
});

test('bulk catalog import rejects an SKU already assigned to a different product ID', async () => {
  const { calls, client } = recorder({
    identityRows: [
      {
        id: existingProductId,
        sku: 'USED',
        outlet_id: outletId,
        metadata: {},
      },
    ],
  });
  await assert.rejects(
    applyBulkCatalogEvent({
      client,
      scope: outletId,
      actor: { id: actorId },
      isUuid,
      createHash,
      event: { id: eventId, payload: { products: [product(newProductId, 'used', 1)] } },
    }),
    (error) => error.status === 409,
  );
  assert.equal(calls.length, 1);
});

test('resending a bulk event does not apply its stock twice', async () => {
  const deviceId = '00000000-0000-4000-8000-000000000007';
  const savedEvents = new Map();
  let productInsertCount = 0;
  const client = {
    async query(sql, values) {
      if (sql.includes('sync_event_retention'))
        return { rows: [{ minimum_cursor: 0 }], rowCount: 1 };
      if (sql.includes('SELECT last_cursor FROM sync_devices'))
        return { rows: [{ last_cursor: 0 }], rowCount: 1 };
      if (sql.includes('SELECT id FROM (')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO sync_events')) {
        const key = `${values[1]}|${values[0]}`;
        if (savedEvents.has(key)) return { rows: [], rowCount: 0 };
        savedEvents.set(key, {
          event_type: values[3],
          outlet_id: values[2],
          payload: values[4],
          occurred_at: values[5],
        });
        return { rows: [{ server_cursor: 1 }], rowCount: 1 };
      }
      if (sql.includes('SELECT event_type,outlet_id,payload,occurred_at FROM sync_events')) {
        const stored = savedEvents.get(`${values[0]}|${values[1]}`);
        return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
      }
      if (sql.includes('SELECT id,sku,barcode,outlet_id,metadata FROM products'))
        return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO categories'))
        return {
          rows: [{ id: '00000000-0000-4000-8000-000000000008', name: 'Kategori' }],
          rowCount: 1,
        };
      if (sql.includes('INSERT INTO products')) {
        productInsertCount += 1;
        return { rows: [{ id: newProductId }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO stock_balances'))
        return { rows: [{ product_id: newProductId }], rowCount: 1 };
      if (sql.includes('SELECT product_id,variant_id,quantity::text AS quantity'))
        return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const event = {
    id: eventId,
    type: 'product.bulkUpsert',
    outletId,
    at: '2026-01-02T03:04:05.000Z',
    payload: { products: [product(newProductId, 'NEW', 5)] },
  };
  const handler = createSyncHandler({
    pool: {
      connect: async () => client,
      query: async () => ({ rows: [], rowCount: 0 }),
    },
    activeSession: async () => ({ outlet_id: outletId, role: 'Admin' }),
    json: (_response, status, body) => ({ status, body }),
    readJson: async () => ({
      deviceId,
      cursor: 0,
      bootstrap: false,
      activeShiftId: null,
      events: [event],
    }),
    requireSameOrigin() {},
    isUuid,
    createHash,
  });

  const first = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));
  const retry = await handler({ method: 'POST' }, {}, new URL('http://localhost/api/sync'));

  assert.deepEqual(first.body.accepted, [eventId]);
  assert.deepEqual(retry.body.accepted, [eventId]);
  assert.equal(productInsertCount, 1);
});
