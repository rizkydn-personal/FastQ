import test from 'node:test';
import assert from 'node:assert/strict';
import { collectScopedEntityIds } from '../server/sync-scope-policy.mjs';
import { matchesStoredSyncEvent } from '../server/sync-event-policy.mjs';

const outletId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const variantId = '00000000-0000-4000-8000-000000000003';
const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

test('scope traversal collects valid entity references and counts the request budget', () => {
  const budget = { inspectedObjects: 0, entityIds: 0 };
  const ids = collectScopedEntityIds(
    {
      id: 'event',
      type: 'product.upsert',
      payload: {
        id: productId,
        outletId,
        stockByOutlet: { [outletId]: 5 },
        variants: [{ id: variantId, productId }],
      },
    },
    { scope: outletId, isUuid, budget },
  );
  assert.deepEqual([...ids].sort(), [productId, variantId].sort());
  assert.equal(budget.inspectedObjects, 4);
  assert.equal(budget.entityIds, 3);
});

test('scope traversal rejects empty and foreign outlet identifiers', () => {
  for (const payload of [
    { outletId: '' },
    { createdOutletId: 'other' },
    { stockByOutlet: { [outletId]: 1, other: 2 } },
  ]) {
    assert.throws(
      () =>
        collectScopedEntityIds({ id: 'event', type: 'test', payload }, { scope: outletId, isUuid }),
      (error) => error.status === 403,
    );
  }
});

test('scope traversal enforces per-event object and entity ID limits', () => {
  const root = {};
  let cursor = root;
  for (let index = 0; index < 20_000; index++) {
    cursor.child = {};
    cursor = cursor.child;
  }
  assert.throws(
    () =>
      collectScopedEntityIds(
        { id: 'event', type: 'test', payload: root },
        { scope: outletId, isUuid },
      ),
    (error) => error.status === 400,
  );

  const ids = Array.from({ length: 2_001 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
  }));
  assert.throws(
    () =>
      collectScopedEntityIds(
        { id: 'event', type: 'test', payload: { ids } },
        { scope: outletId, isUuid },
      ),
    (error) => error.status === 400,
  );
});

test('scope traversal enforces aggregate object and entity ID request budgets', () => {
  const objectBudget = { inspectedObjects: 100_000, entityIds: 0 };
  assert.throws(
    () =>
      collectScopedEntityIds(
        { id: 'event', type: 'test', payload: {} },
        { scope: outletId, isUuid, budget: objectBudget },
      ),
    (error) => error.status === 400,
  );
  const entityBudget = { inspectedObjects: 0, entityIds: 10_000 };
  assert.throws(
    () =>
      collectScopedEntityIds(
        { id: 'event', type: 'test', payload: { id: productId } },
        { scope: outletId, isUuid, budget: entityBudget },
      ),
    (error) => error.status === 400,
  );
});

test('idempotent event retries accept reordered JSON keys and same-entity changes, but reject a different entity', () => {
  const stored = {
    event_type: 'customer.upsert',
    outlet_id: outletId,
    occurred_at: new Date('2026-11-16T10:00:00.750Z'),
    payload: { id: productId, contact: { phone: '0812', name: 'Ayu' } },
  };
  const same = {
    id: 'event',
    type: 'customer.upsert',
    outletId,
    at: '2026-11-16T10:00:00.750Z',
    payload: { contact: { name: 'Ayu', phone: '0812' }, id: productId },
  };
  assert.equal(matchesStoredSyncEvent(stored, same), true);
  // Sama event id + entitas yang sama = duplikat, walau field non-identitas
  // berbeda: handler server menulis ulang payload tersimpan dengan versi
  // kanoniknya, jadi retry yang sah tidak pernah sama persis. Yang tetap
  // konflik adalah ID yang sama untuk entitas yang BERBEDA.
  assert.equal(
    matchesStoredSyncEvent(stored, {
      ...same,
      payload: { ...same.payload, contact: { ...same.payload.contact, name: 'Budi' } },
    }),
    true,
  );
  assert.equal(
    matchesStoredSyncEvent(stored, {
      ...same,
      payload: { ...same.payload, id: '00000000-0000-4000-8000-000000000099' },
    }),
    false,
  );
  assert.equal(
    matchesStoredSyncEvent(stored, { ...same, outletId: '00000000-0000-4000-8000-000000000004' }),
    false,
  );
  assert.equal(matchesStoredSyncEvent(stored, { ...same, at: '2026-11-16T10:01:00.000Z' }), false);
  assert.equal(matchesStoredSyncEvent(stored, { ...same, at: '2026-11-16T10:00:00.751Z' }), false);
});

test('idempotent event retries accept server-canonicalized sale payloads (SYNC_EVENT_ID_CONFLICT regression)', () => {
  // Item keranjang klien tidak pernah membawa sku; server menambah item.sku
  // (dan menimpa item.cost/cashier) lalu menulis ulang payload tersimpan.
  // Replay payload ASLI klien harus diterima sebagai duplikat, bukan 409.
  const saleId = '00000000-0000-4000-8000-000000000010';
  const stored = {
    event_type: 'sale.upsert',
    outlet_id: outletId,
    occurred_at: new Date('2026-11-22T05:00:00.000Z'),
    payload: {
      id: saleId,
      number: 'TRX-261122-TEST',
      at: '2026-11-22T05:00:00.000Z',
      cashier: 'Kasir Uji',
      items: [
        {
          key: productId,
          productId,
          variantId: null,
          name: 'DUMMY Teh botol 01',
          price: 5000,
          cost: 0,
          qty: 1,
          sku: 'DUMMY-TB-01',
          discount: null,
        },
      ],
      subtotal: 5000,
      discount: 0,
      tax: 0,
      service: 0,
      total: 5000,
      status: 'Lunas',
    },
  };
  const clientRetry = {
    id: 'event',
    type: 'sale.upsert',
    outletId,
    at: '2026-11-22T05:00:00.000Z',
    payload: {
      id: saleId,
      number: 'TRX-261122-TEST',
      at: '2026-11-22T05:00:00.000Z',
      cashier: 'Kasir Uji',
      items: [
        {
          key: productId,
          productId,
          variantId: null,
          name: 'DUMMY Teh botol 01',
          price: 5000,
          cost: 0,
          qty: 1,
          discount: null,
        },
      ],
      subtotal: 5000,
      discount: 0,
      tax: 0,
      service: 0,
      total: 5000,
      status: 'Lunas',
    },
  };
  assert.equal(matchesStoredSyncEvent(stored, clientRetry), true);
  // ID event yang sama dipakai untuk transaksi yang BERBEDA tetap konflik.
  assert.equal(
    matchesStoredSyncEvent(stored, {
      ...clientRetry,
      payload: { ...clientRetry.payload, id: '00000000-0000-4000-8000-000000000011' },
    }),
    false,
  );
});

test('events without an entity id still compare the full payload', () => {
  const stored = {
    event_type: 'stock.delta',
    outlet_id: outletId,
    occurred_at: new Date('2026-11-22T05:00:00.000Z'),
    payload: {
      productId,
      variantId: null,
      outletId,
      delta: -1,
      reason: 'Penjualan TRX-1',
      saleId: '00000000-0000-4000-8000-000000000010',
    },
  };
  const same = {
    id: 'event',
    type: 'stock.delta',
    outletId,
    at: '2026-11-22T05:00:00.000Z',
    payload: { ...stored.payload },
  };
  assert.equal(matchesStoredSyncEvent(stored, same), true);
  assert.equal(
    matchesStoredSyncEvent(stored, { ...same, payload: { ...same.payload, delta: -2 } }),
    false,
  );
});

test('idempotent event retries without a client timestamp ignore server receive time', () => {
  const stored = {
    event_type: 'audit.append',
    outlet_id: outletId,
    occurred_at: new Date(),
    payload: { id: productId, detail: 'ok' },
  };
  assert.equal(
    matchesStoredSyncEvent(stored, {
      type: 'audit.append',
      outletId,
      payload: { detail: 'ok', id: productId },
    }),
    true,
  );
  assert.equal(
    matchesStoredSyncEvent(
      { ...stored, payload: '{invalid' },
      { type: 'audit.append', outletId, payload: stored.payload },
    ),
    false,
  );
});
