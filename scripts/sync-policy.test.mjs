import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectPendingStockProductIds,
  collectPendingStockDeltas,
  isServerReachable,
  mergeStockBalances,
  mergeShiftEvent,
  mergeStockSnapshot,
  prepareSyncOutbox,
  restoreOfflineOutletState,
  restoreActiveShift,
  shiftCashierNames,
  switchOutletLocalState,
} from '../shared/sync-policy.js';

const event = (id, type, payload = {}, outletId = 'outlet') => ({ id, type, payload, outletId });

test('cross-outlet transfer reachability skips offline probes and rejects failed probes', async () => {
  let probes = 0;
  const probe = async () => {
    probes += 1;
  };

  assert.equal(await isServerReachable(false, probe), false);
  assert.equal(probes, 0);
  assert.equal(
    await isServerReachable(true, async () => {
      throw new Error('offline');
    }),
    false,
  );
  assert.equal(await isServerReachable(true, probe), true);
  assert.equal(probes, 1);
});

test('role-specific event filtering matches server permissions', () => {
  const events = [
    event('1', 'discount.request', {
      id: 'request',
      saleId: '00000000-0000-0000-0000-000000000001',
    }),
    event('2', 'discount.approval', { id: 'request' }),
    event('3', 'product.upsert'),
  ];

  assert.deepEqual(
    prepareSyncOutbox({
      events,
      sales: [],
      issues: [],
      outletId: 'outlet',
      role: 'Admin',
    }).pending.map((item) => item.id),
    ['2', '3'],
  );
  assert.deepEqual(
    prepareSyncOutbox({
      events,
      sales: [],
      issues: [],
      outletId: 'outlet',
      role: 'Pemilik',
    }).pending.map((item) => item.id),
    ['2'],
  );
});

test('malformed outbox entries are skipped without removing them or blocking valid events', () => {
  const valid = event('sale', 'sale.upsert');
  const malformed = [null, 'bad-entry', []];
  const prepared = prepareSyncOutbox({
    events: [...malformed, valid],
    sales: [],
    issues: [],
    outletId: 'outlet',
    role: 'Admin',
  });

  assert.deepEqual(prepared.pending, [valid]);
  assert.deepEqual(malformed, [null, 'bad-entry', []]);
});

test('permanent sync issues stay visible after their outbox event is quarantined', () => {
  const issue = {
    eventId: 'blocked',
    message: 'Invalid payload',
    event: event('blocked', 'sale.upsert'),
  };
  const prepared = prepareSyncOutbox({
    events: [],
    sales: [],
    issues: [issue],
    outletId: 'outlet',
    role: 'Kasir',
  });
  assert.deepEqual(prepared.issues, [issue]);
  assert.equal(prepared.pending.length, 0);
});

test('bootstrap stock delta collection skips malformed entries and preserves valid adjustment totals', () => {
  const events = [
    null,
    'bad-entry',
    { type: 'stock.delta', payload: null },
    {
      type: 'stock.delta',
      outletId: 'outlet-a',
      payload: { productId: 'product-a', delta: 'invalid' },
    },
    {
      type: 'stock.delta',
      outletId: 'outlet-a',
      payload: { productId: 'product-a', variantId: 'variant-a', delta: -2 },
    },
    {
      type: 'stock.reconcile',
      outletId: 'outlet-a',
      payload: {
        productId: 'product-a',
        variantId: 'variant-a',
        quantity: 5,
        expectedServerQuantity: 2,
      },
    },
  ];
  const deltas = collectPendingStockDeltas(events);

  assert.equal(deltas.size, 1);
  assert.equal(deltas.get('outlet-a|product-a|variant-a'), 1);
  assert.equal(events[0], null);
  assert.equal(events[1], 'bad-entry');
});

test('bulk catalog events retain new and updated stock while pending offline', () => {
  const pending = [
    event('bulk', 'product.bulkUpsert', {
      products: [
        { id: 'new-product', stock: 5, stockDelta: null },
        { id: 'updated-product', stock: 8, stockDelta: 3 },
      ],
    }),
  ];
  assert.deepEqual(
    [...collectPendingStockDeltas(pending)],
    [
      ['outlet|new-product|', 5],
      ['outlet|updated-product|', 3],
    ],
  );
  assert.deepEqual([...collectPendingStockProductIds(pending)], ['new-product', 'updated-product']);

  const state = {
    products: [
      { id: 'new-product', stock: 0 },
      { id: 'updated-product', stock: 0 },
    ],
  };
  mergeStockSnapshot(state, 'outlet', [], pending);
  assert.equal(state.products[0].stock, 5);
  assert.equal(state.products[1].stock, 3);
});

test('stock snapshots refresh outlet balances while retaining pending local stock changes', () => {
  const outletId = 'outlet-a';
  const state = {
    products: [
      { id: 'plain', stock: 0, stockByOutlet: { [outletId]: 0 } },
      {
        id: 'variants',
        stock: 0,
        stockByOutlet: { [outletId]: 0 },
        variants: [
          { id: 'variant-a', stock: 0, stockByOutlet: { [outletId]: 0 } },
          { id: 'variant-b', stock: 0, stockByOutlet: { [outletId]: 0 } },
          { id: 'retired', retired: true, stock: 0, stockByOutlet: { [outletId]: 0 } },
        ],
      },
    ],
  };
  const pending = [
    event('plain-pending', 'stock.delta', { productId: 'plain', outletId, delta: -2 }, outletId),
    event(
      'variant-pending',
      'stock.delta',
      { productId: 'variants', variantId: 'variant-a', outletId, delta: 3 },
      outletId,
    ),
  ];

  mergeStockSnapshot(
    state,
    outletId,
    [
      { outletId, productId: 'plain', variantId: null, quantity: 8 },
      { outletId, productId: 'variants', variantId: 'variant-a', quantity: 4 },
      { outletId, productId: 'variants', variantId: 'variant-b', quantity: 6 },
      { outletId, productId: 'variants', variantId: 'retired', quantity: 10 },
    ],
    pending,
  );

  assert.equal(state.products[0].stock, 6);
  assert.equal(state.products[1].stock, 13);
  assert.equal(state.products[1].variants[0].stock, 7);
  assert.equal(state.products[1].variants[1].stock, 6);
  assert.equal(state.products[1].variants[2].stock, 10);
});

test('pending stock product IDs cover product, sale, transfer, and stock events', () => {
  const productIds = collectPendingStockProductIds([
    event('product', 'product.upsert', { id: 'product-a' }),
    event('sale', 'sale.upsert', {
      items: [{ productId: 'product-b' }, { productId: 'product-c' }],
    }),
    event('transfer', 'transfer.upsert', { productId: 'product-d' }),
    event('stock', 'stock.delta', { productId: 'product-e' }),
    event('audit', 'audit.append', { id: 'product-f' }),
  ]);
  assert.deepEqual(
    [...productIds],
    ['product-a', 'product-b', 'product-c', 'product-d', 'product-e'],
  );
});

test('stock snapshots reset absent outlet balances to zero and reject malformed rows', () => {
  const product = { id: 'product', stock: 25, stockByOutlet: { 'outlet-a': 25 } };
  const state = { products: [product] };

  mergeStockSnapshot(state, 'outlet-a', []);
  assert.equal(product.stock, 0);

  assert.throws(
    () =>
      mergeStockSnapshot(state, 'outlet-a', [
        { outletId: 'outlet-b', productId: 'product', variantId: null, quantity: 5 },
      ]),
    /invalid balance identity/,
  );
});

test('stock snapshots and conflict updates preserve negative server balances', () => {
  const outletId = 'outlet-a';
  const state = {
    activeOutlet: outletId,
    products: [{ id: 'product', stock: 1, stockByOutlet: { [outletId]: 1 } }],
  };
  mergeStockSnapshot(state, outletId, [
    { outletId, productId: 'product', variantId: null, quantity: -2 },
  ]);
  assert.equal(state.products[0].stock, -2);

  mergeStockBalances(
    state,
    outletId,
    [{ outletId, productId: 'product', variantId: null, quantity: -3 }],
    [event('pending-stock', 'stock.delta', { productId: 'product', outletId, delta: 1 })],
  );
  assert.equal(state.products[0].stock, -2);
});

test('cross-outlet transfer and its stock delta are deferred without blocking valid events', () => {
  const transfer = event(
    'transfer',
    'transfer.upsert',
    {
      id: 'transfer-id',
      productId: 'product-id',
      variantId: null,
      from: 'outlet-a',
      to: 'outlet-b',
      quantity: 3,
    },
    'outlet-a',
  );
  const outgoing = event(
    'outgoing',
    'stock.delta',
    {
      productId: 'product-id',
      variantId: null,
      outletId: 'outlet-a',
      delta: -3,
      reason: 'Transfer ke outlet-b',
    },
    'outlet-a',
  );
  const unrelated = event('sale', 'sale.upsert', { id: 'sale-id' }, 'outlet-a');
  const prepared = prepareSyncOutbox({
    events: [transfer, outgoing, unrelated],
    sales: [],
    issues: [],
    outletId: 'outlet-a',
    role: 'Admin',
  });

  assert.deepEqual(
    prepared.pending.map((item) => item.id),
    ['transfer', 'sale'],
  );
  assert.equal(prepared.deferredCount, 1);
  assert.deepEqual(
    [transfer, outgoing].map((item) => item.id),
    ['transfer', 'outgoing'],
  );
});

test('cross-outlet transfer stock delta is deferred at the destination outlet too', () => {
  const transfer = event(
    'transfer',
    'transfer.upsert',
    {
      id: 'transfer-id',
      productId: 'product-id',
      variantId: null,
      from: 'outlet-a',
      to: 'outlet-b',
      quantity: 3,
    },
    'outlet-a',
  );
  const incoming = event(
    'incoming',
    'stock.delta',
    {
      productId: 'product-id',
      variantId: null,
      outletId: 'outlet-b',
      delta: 3,
      reason: 'Transfer dari outlet-a',
    },
    'outlet-b',
  );
  const unrelated = event('sale', 'sale.upsert', { id: 'sale-id' }, 'outlet-b');
  const prepared = prepareSyncOutbox({
    events: [transfer, incoming, unrelated],
    sales: [],
    issues: [],
    outletId: 'outlet-b',
    role: 'Admin',
  });

  assert.deepEqual(
    prepared.pending.map((item) => item.id),
    ['sale'],
  );
  assert.equal(prepared.deferredCount, 1);
});

test('unlinked legacy discount requests are retained but excluded from sync', () => {
  const legacy = event('legacy', 'discount.request', { id: 'request', shiftId: 'shift' });
  const cancellation = event('cancel', 'discount.cancel', {
    id: 'request',
    approvalStatus: 'cancelled',
  });
  const valid = event('sale', 'sale.upsert');
  const prepared = prepareSyncOutbox({
    events: [legacy, cancellation, valid],
    sales: [],
    issues: [],
    outletId: 'outlet',
    role: 'Kasir',
  });

  assert.deepEqual(
    prepared.pending.map((item) => item.id),
    ['sale'],
  );
  assert.equal(prepared.reviewCount, 2);
  assert.equal(prepared.newIssues[0], 'legacy');
  assert.ok(prepared.newIssues.includes('cancel'));
  assert.equal(legacy.payload.saleId, undefined);
});

test('a uniquely matching paid sale repairs a legacy discount request', () => {
  const legacy = event('legacy', 'discount.request', {
    saleId: 'invalid-sale-id',
    shiftId: 'shift',
    productId: 'product',
    quantity: 1,
    baseAmount: 6000,
    kind: 'amount',
    value: 2000,
  });
  const sale = {
    id: 'sale-id',
    number: 'TRX-1',
    at: '2026-11-14T13:00:00.000Z',
    outletId: 'outlet',
    shiftId: 'shift',
    status: 'Lunas',
    items: [
      { productId: 'product', qty: 1, price: 6000, discount: { kind: 'amount', value: 2000 } },
    ],
  };
  const prepared = prepareSyncOutbox({
    events: [legacy],
    sales: [sale],
    issues: [],
    outletId: 'outlet',
    role: 'Kasir',
  });

  assert.equal(legacy.payload.saleId, sale.id);
  assert.equal(legacy.payload.saleNumber, sale.number);
  assert.deepEqual(
    prepared.pending.map((item) => item.id),
    ['legacy'],
  );
  assert.equal(prepared.reviewCount, 0);
});

test('switching server outlets isolates local records and sync cursors', () => {
  const state = {
    activeOutlet: 'outlet-a',
    settings: { localDataOutletId: 'outlet-a' },
    products: [{ id: 'product-a' }],
    sales: [{ id: 'sale-a' }],
    syncOutbox: [event('event-a', 'sale.upsert')],
    syncCursor: 42,
  };

  assert.equal(switchOutletLocalState(state, 'outlet-b'), true);
  assert.deepEqual(state.products, []);
  assert.deepEqual(state.sales, []);
  assert.deepEqual(state.syncOutbox, []);
  assert.equal(state.syncCursor, 0);
  assert.equal(state.settings.localDataOutletId, 'outlet-b');

  state.sales.push({ id: 'sale-b' });
  assert.equal(switchOutletLocalState(state, 'outlet-a'), true);
  assert.deepEqual(state.sales, [{ id: 'sale-a' }]);
  assert.deepEqual(
    state.syncOutbox.map((item) => item.id),
    ['event-a'],
  );
  assert.equal(state.syncCursor, 42);
});

test('active outlet owns legacy local records when no partition ID was saved', () => {
  const state = {
    activeOutlet: 'outlet-a',
    settings: { serverSession: { user: { outletId: 'outlet-b' } } },
    products: [{ id: 'product-a' }],
  };

  assert.equal(switchOutletLocalState(state, 'outlet-b'), true);
  assert.deepEqual(state.products, []);
  assert.deepEqual(state.localOutletPartitions['outlet-a'].products, [{ id: 'product-a' }]);
  assert.equal(state.settings.localDataOutletId, 'outlet-b');
});

test('cached offline session restores local records when outlet metadata is missing', () => {
  const state = {
    products: [{ id: 'cached-product' }],
    sales: [{ id: 'cached-sale' }],
    settings: {},
  };

  assert.equal(
    restoreOfflineOutletState(state, {
      user: { id: 'cashier-a', outletId: 'outlet-a' },
      expiresAt: '2026-11-24T00:00:00.000Z',
    }),
    false,
  );
  assert.deepEqual(state.products, [{ id: 'cached-product' }]);
  assert.deepEqual(state.sales, [{ id: 'cached-sale' }]);
  assert.equal(state.activeOutlet, 'outlet-a');
  assert.equal(state.settings.localDataOutletId, 'outlet-a');
});

test('switching within one outlet keeps the active local state', () => {
  const state = {
    activeOutlet: 'outlet-a',
    settings: {},
    sales: [{ id: 'sale-a' }],
  };

  assert.equal(switchOutletLocalState(state, 'outlet-a'), false);
  assert.deepEqual(state.sales, [{ id: 'sale-a' }]);
  assert.equal(state.settings.localDataOutletId, 'outlet-a');
});

test('remote open and close shift events update the shared active shift', () => {
  const state = { shifts: [], sales: [], cashMovements: [], activeShift: null };
  const opened = { id: 'shift-1', outletId: 'outlet', openedAt: '2026-11-14T10:00:00.000Z' };
  const closed = { ...opened, closedAt: '2026-11-14T18:00:00.000Z', cashiers: ['Ayu', 'Budi'] };

  mergeShiftEvent(state, opened);
  assert.equal(state.activeShift.id, 'shift-1');
  mergeShiftEvent(state, closed);
  assert.equal(state.activeShift, null);
  assert.equal(state.shifts.length, 1);
  assert.deepEqual(state.shifts[0].cashiers, ['Ayu', 'Budi']);
  mergeShiftEvent(state, opened);
  assert.equal(state.activeShift, null);
  assert.ok(state.shifts[0].closedAt);
});

test('restores a cached open shift and derives the shift cashier roster', () => {
  const shift = { id: 'shift-1', outletId: 'outlet', openedAt: '2026-11-14T10:00:00.000Z' };
  const state = {
    activeShift: null,
    shifts: [shift],
    sales: [{ shiftId: 'shift-1', cashier: 'Ayu' }],
    cashMovements: [{ shiftId: 'shift-1', cashier: 'Budi' }],
  };

  assert.equal(restoreActiveShift(state, 'outlet'), shift);
  assert.deepEqual(shiftCashierNames(state, shift), ['Ayu', 'Budi']);
  state.shifts.push({ ...shift, closedAt: '2026-11-14T18:00:00.000Z' });
  assert.equal(restoreActiveShift(state, 'outlet'), null);
});
