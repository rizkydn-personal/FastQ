import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  mergeStockBalances,
  mergeStockSnapshot,
  prepareSyncOutbox,
} from '../shared/sync-policy.js';
import { roleEventTypes } from '../shared/sync-role-policy.mjs';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('../app/pos/runtime.js', import.meta.url), 'utf8');
const posPageSource = await readFile(new URL('../app/pos/index.html', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const productXlsxSource = await readFile(
  new URL('../app/pos/product-xlsx.js', import.meta.url),
  'utf8',
);
const executableRuntimeSource = runtimeSource
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '')
  .replace('export async function createPosRuntime', 'async function createPosRuntime')
  .concat('\nglobalThis.createPosRuntime = createPosRuntime;');
function loadPosRuntime(context) {
  if (!context.structuredClone) context.structuredClone = structuredClone;
  runInNewContext(executableRuntimeSource, context);
  return context.createPosRuntime;
}
async function createClearRuntime(savedState, { online = false, fetchImpl } = {}) {
  const operations = [];
  const storedValues = new Map();
  let uuid = 0;
  const context = {
    AbortController,
    AbortSignal,
    TextEncoder,
    setTimeout: () => 1,
    clearTimeout() {},
    prepareSyncOutbox,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
      clear: async () => operations.push('clear'),
    }),
    createUuid: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    fetch: async (...args) => {
      operations.push(args[0]);
      if (fetchImpl) return fetchImpl(...args);
      throw new Error('Unexpected network request.');
    },
    localStorage: {
      getItem: (key) => storedValues.get(key) || null,
      setItem: (key, value) => storedValues.set(key, value),
      removeItem: (key) => storedValues.delete(key),
    },
    navigator: { onLine: online },
    roleEventTypes,
  };
  loadPosRuntime(context);
  return { runtime: await context.createPosRuntime(), operations };
}
function pendingClearState(syncOutbox = []) {
  return {
    activeOutlet: 'outlet-a',
    catalogInitialized: true,
    syncInitialized: true,
    stockSnapshotVersion: 1,
    syncOutbox,
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-a' },
      },
    },
  };
}
test('POS status strings do not contain common UTF-8 mojibake markers', () => {
  assert.doesNotMatch(runtimeSource, /[ÂÃ]/);
});
test('cashier confirmations use custom dialogs instead of browser prompts', () => {
  assert.doesNotMatch(
    `${posPageSource}\n${appSource}`,
    /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/,
  );
  assert.match(posPageSource, /id="posConfirmDialog"/);
  assert.match(appSource, /role="alertdialog"/);
});
test('product Excel template contains the expected spreadsheet columns', () => {
  const context = { window: { fflate: { strToU8, zipSync } } };
  runInNewContext(productXlsxSource, context);

  const files = unzipSync(context.window.ProductXlsx.createTemplate());
  const worksheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  for (const header of ['SKU', 'Nama Produk', 'Kategori', 'Harga Jual', 'Modal', 'Stok'])
    assert.ok(worksheet.includes(`<t>${header}</t>`));
  for (const unsupportedField of ['Barcode', 'Satuan', 'Stok Minimum'])
    assert.ok(!worksheet.includes(`<t>${unsupportedField}</t>`));
});
test('POS runtime preserves a saved catalog when restoring state', async () => {
  const savedState = {
    products: [{ id: 'cached-product' }],
    sales: [{ id: 'cached-sale' }],
    activeOutlet: 'outlet-a',
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    settings: {
      localDataOutletId: 'outlet-a',
      offlineSession: { user: { outletId: 'outlet-a' } },
    },
  };
  const context = {
    createPosStorage: () => ({ readSavedState: async () => savedState }),
    createUuid: () => 'device-id',
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  const restored = JSON.parse(JSON.stringify(runtime.state));
  assert.deepEqual(restored.products, savedState.products);
  assert.deepEqual(restored.sales, savedState.sales);
  assert.equal(restored.catalogInitialized, true);
  assert.equal(restored.settings.localDataOutletId, 'outlet-a');
});
test('refreshing recent sales updates report data without changing older-page cursor', async () => {
  const olderCursor = { before: '2026-11-20T10:00:00.000Z', beforeId: 'older-sale' };
  const savedState = {
    sales: [{ id: 'older-sale', at: '2026-11-20T10:00:00.000Z' }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-a' },
      },
      salesCursor: olderCursor,
    },
    activeOutlet: 'outlet-a',
  };
  let requestedPath;
  const context = {
    AbortSignal,
    URLSearchParams,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    navigator: { onLine: true },
    fetch: async (path) => {
      requestedPath = path;
      return {
        ok: true,
        json: async () => ({
          sales: [{ id: 'new-sale', at: '2026-11-24T10:00:00.000Z', items: [], refunds: [] }],
          next: { before: '2026-11-23T10:00:00.000Z', beforeId: 'new-sale' },
          hasMore: true,
        }),
      };
    },
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.refreshSalesHistory();

  assert.equal(requestedPath, '/api/sales?limit=50');
  assert.deepEqual(
    runtime.state.sales.map((sale) => sale.id),
    ['new-sale', 'older-sale'],
  );
  assert.deepEqual(runtime.state.settings.salesCursor, olderCursor);
});
test('product import updates matching SKU and name, and suffixes conflicting SKUs', async () => {
  const savedState = {
    products: [
      {
        id: 'existing-match',
        sku: 'MATCH',
        name: 'Produk Sama',
        category: 'Kategori Lama',
        unit: 'pcs',
        price: 1000,
        cost: 500,
        stock: 2,
        stockByOutlet: { 'outlet-a': 2 },
        createdOutletId: 'outlet-a',
      },
      {
        id: 'existing-conflict',
        sku: 'BASE',
        name: 'Nama Lama',
        category: 'Kategori',
        price: 1000,
        cost: 500,
        stock: 1,
        createdOutletId: 'outlet-a',
      },
    ],
    settings: {
      serverSession: {
        user: { id: 'admin-a', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
  };
  let uuid = 0;
  const context = {
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => `generated-${++uuid}`,
    navigator: { onLine: false },
    roleEventTypes,
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  const result = await runtime.importProducts([
    {
      rowNumber: 2,
      sku: 'MATCH',
      name: 'produk sama',
      category: 'Jangan ubah',
      price: 1200,
      cost: 600,
      stock: 5,
    },
    {
      rowNumber: 3,
      sku: 'BASE',
      name: 'Nama Baru',
      category: 'Kategori',
      price: 900,
      cost: 400,
      stock: 3,
    },
    {
      rowNumber: 4,
      sku: 'BASE',
      name: 'Nama Ketiga',
      category: 'Kategori',
      price: 800,
      cost: 300,
      stock: 4,
    },
    {
      rowNumber: 5,
      sku: 'INVALID',
      name: 'Harga kosong',
      category: 'Kategori',
      price: '',
      cost: 0,
      stock: 0,
    },
    {
      rowNumber: 6,
      sku: 'DUP',
      name: 'Produk Duplikat',
      category: 'Kategori',
      price: 700,
      cost: 300,
      stock: 5,
    },
    {
      rowNumber: 7,
      sku: 'DUP',
      name: 'Produk Duplikat',
      category: 'Kategori',
      price: 700,
      cost: 300,
      stock: 10,
    },
  ]);

  assert.equal(result.added, 3);
  assert.equal(result.updated, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, 5);
  assert.equal(
    runtime.state.products.find((product) => product.id === 'existing-match').price,
    1200,
  );
  assert.equal(
    runtime.state.products.find((product) => product.id === 'existing-match').category,
    'Kategori Lama',
  );
  assert.ok(runtime.state.products.some((product) => product.sku === 'BASE-D'));
  assert.ok(runtime.state.products.some((product) => product.sku === 'BASE-D2'));
  const duplicateProduct = runtime.state.products.find((product) => product.sku === 'DUP');
  assert.equal(duplicateProduct.stock, 10);
  const duplicateUpserts = runtime.state.syncOutbox.filter(
    (event) => event.type === 'product.upsert' && event.payload.sku === 'DUP',
  );
  assert.equal(duplicateUpserts.length, 2);
  assert.equal(duplicateUpserts[0].payload.stock, 5);
  assert.equal(duplicateUpserts[0].payload.stockByOutlet['outlet-a'], 5);
  assert.equal(duplicateUpserts[1].payload.stock, 10);
  assert.equal(duplicateUpserts[1].payload.stockByOutlet['outlet-a'], 5);
  const duplicateDeltas = runtime.state.syncOutbox.filter(
    (event) => event.type === 'stock.delta' && event.payload.productId === duplicateProduct.id,
  );
  assert.equal(duplicateDeltas.length, 1);
  assert.equal(duplicateDeltas[0].payload.delta, 5);
});
test('clearing local data skips sync when no events are pending', async () => {
  const { runtime, operations } = await createClearRuntime(pendingClearState());

  await runtime.clearLocalDataAfterSync();

  assert.deepEqual(operations, ['clear']);
  assert.equal(runtime.getLocalPendingCount(), 0);
});
test('clearing local data preserves pending events while offline', async () => {
  const event = {
    id: '20000000-0000-4000-8000-000000000001',
    type: 'audit.append',
    outletId: 'outlet-a',
    at: '2026-11-25T00:00:00.000Z',
    payload: { id: '20000000-0000-4000-8000-000000000001', action: 'Test' },
  };
  const { runtime, operations } = await createClearRuntime(pendingClearState([event]));

  await assert.rejects(runtime.clearLocalDataAfterSync(), /perangkat sedang offline/);

  assert.deepEqual(operations, []);
  assert.equal(runtime.getLocalPendingCount(), 1);
});
test('clearing local data syncs pending events before storage and server logout', async () => {
  const event = {
    id: '20000000-0000-4000-8000-000000000001',
    type: 'audit.append',
    outletId: 'outlet-a',
    at: '2026-11-25T00:00:00.000Z',
    payload: { id: '20000000-0000-4000-8000-000000000001', action: 'Test' },
  };
  const { runtime, operations } = await createClearRuntime(pendingClearState([event]), {
    online: true,
    fetchImpl: async (url, options) => {
      if (url === '/api/health/live') return { ok: true };
      if (url === '/api/auth/logout') return { ok: true, json: async () => ({}) };
      const request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ accepted: request.events.map((item) => item.id), cursor: 1 }),
      };
    },
  });

  await runtime.clearLocalDataAfterSync();

  assert.deepEqual(operations, ['/api/health/live', '/api/sync', 'clear', '/api/auth/logout']);
  assert.equal(runtime.getLocalPendingCount(), 0);
});
test('incremental sync without a stock snapshot preserves the cached balances', async () => {
  const savedState = {
    products: [{ id: 'product-a', stock: 7, stockByOutlet: { 'outlet-a': 7 } }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    deviceId: 'device-a',
  };
  const context = {
    AbortController,
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path) => {
      if (path === '/api/health/live') return { ok: true };
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events: [],
          stockBalances: [],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: () => ({ pending: [], issues: [] }),
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize();
  assert.equal(runtime.state.products[0].stock, 7);
  assert.equal(runtime.state.products[0].stockByOutlet['outlet-a'], 7);
});

test('sync conflict response exposes negative stock and flags the local sale', async () => {
  const savedState = {
    products: [
      { id: 'product-a', stock: 1, stockByOutlet: { 'outlet-a': 1 } },
      { id: 'product-b', stock: 1, stockByOutlet: { 'outlet-a': 1 } },
    ],
    sales: [{ id: 'sale-a', status: 'Lunas' }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    deviceId: 'device-a',
  };
  const context = {
    AbortController,
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockBalances,
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path) => {
      if (path === '/api/health/live') return { ok: true };
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events: [
            {
              event_type: 'stock.delta',
              payload: {
                productId: 'product-b',
                variantId: null,
                outletId: 'outlet-a',
                delta: -2,
              },
            },
          ],
          stockBalances: [],
          stockConflicts: [
            {
              saleId: 'sale-a',
              stockConflict: true,
              stockBalances: [
                { outletId: 'outlet-a', productId: 'product-a', variantId: null, quantity: -1 },
              ],
            },
          ],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: () => ({ pending: [], issues: [] }),
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize();
  assert.equal(runtime.state.products[0].stock, -1);
  assert.equal(runtime.state.sales[0].stockConflict, true);
  assert.equal(runtime.state.products[1].stock, -1);
});

test('manual sync retries quarantined stock conflict events without retrying unrelated issues', async () => {
  const saleEvent = {
    id: 'sale-event',
    type: 'sale.upsert',
    outletId: 'outlet-a',
    payload: { id: 'sale-a' },
  };
  const deltaEvent = {
    id: 'stock-event',
    type: 'stock.delta',
    outletId: 'outlet-a',
    payload: { saleId: 'sale-a', reason: 'Penjualan TRX-1', delta: -2 },
  };
  const savedState = {
    products: [],
    sales: [{ id: 'sale-a' }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [
      {
        eventId: saleEvent.id,
        message:
          'new row for relation "stock_balances" violates check constraint "stock_balances_quantity_check"',
        event: saleEvent,
      },
      {
        eventId: deltaEvent.id,
        message: 'Delta akan membuat stok server menjadi negatif.',
        event: deltaEvent,
      },
      {
        eventId: 'other-event',
        message: 'Payload produk tidak valid.',
        event: { id: 'other-event', type: 'product.upsert', payload: {} },
      },
    ],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    stockSnapshotVersion: 1,
    deviceId: 'device-a',
  };
  let sentEvents = [];
  const context = {
    AbortController,
    AbortSignal,
    TextEncoder,
    clearTimeout: () => {},
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockBalances,
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path, options = {}) => {
      if (path === '/api/health/live') return { ok: true };
      const body = JSON.parse(options.body);
      sentEvents = body.events;
      return {
        ok: true,
        json: async () => ({
          accepted: sentEvents.map((event) => event.id),
          rejected: [],
          events: [],
          stockBalances: [],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: false,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: ({ events, issues }) => ({ pending: events, issues }),
    setTimeout: () => 1,
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize(true);
  assert.deepEqual(
    sentEvents.map((event) => event.id),
    ['sale-event', 'stock-event'],
  );
  assert.deepEqual(
    runtime.state.syncIssues.map((issue) => issue.eventId),
    ['other-event'],
  );
});

test('legacy catalog cache refreshes stock from the next full bootstrap', async () => {
  const savedState = {
    products: [{ id: 'product-a', stock: 0, stockByOutlet: { 'outlet-a': 0 } }],
    settings: {
      serverSession: {
        user: { id: 'admin-a', name: 'Admin', role: 'Admin', outletId: 'outlet-a' },
      },
    },
    activeOutlet: 'outlet-a',
    syncOutbox: [],
    syncIssues: [],
    syncCursor: 0,
    syncInitialized: true,
    catalogInitialized: true,
    deviceId: 'device-a',
  };
  let bootstrapRequested = false;
  const context = {
    AbortController,
    AbortSignal,
    createPosStorage: () => ({
      readSavedState: async () => savedState,
      queueEncryptedState() {},
      flushEncryptedWrites: async () => {},
    }),
    createUuid: () => 'device-id',
    mergeStockSnapshot,
    navigator: { onLine: true },
    fetch: async (path, options = {}) => {
      if (path === '/api/health/live') return { ok: true };
      bootstrapRequested = JSON.parse(options.body).bootstrap;
      return {
        ok: true,
        json: async () => ({
          accepted: [],
          rejected: [],
          events: [],
          stockBalances: [
            { outletId: 'outlet-a', productId: 'product-a', variantId: null, quantity: 8 },
          ],
          transfers: [],
          outlets: [],
          bootstrapProducts: [],
          catalogBootstrapped: true,
          bootstrapTruncated: false,
          activeShift: null,
          knownShift: null,
          cursor: 0,
          hasMore: false,
        }),
      };
    },
    prepareSyncOutbox: () => ({ pending: [], issues: [] }),
  };
  loadPosRuntime(context);

  const runtime = await context.createPosRuntime();
  await runtime.synchronize();
  assert.equal(bootstrapRequested, true);
  assert.equal(runtime.state.products[0].stock, 8);
  assert.equal(runtime.state.stockSnapshotVersion, 1);
});
for (const [path, expected] of [
  ['/pos', './index.html'],
  ['/dashboard', './index.html'],
]) {
  test(`offline navigation ${path} uses the correct shell`, async () => {
    const handlers = {};
    let response;
    runInNewContext(source, {
      URL,
      self: {
        location: { origin: 'https://pos.test' },
        addEventListener: (name, handler) => {
          handlers[name] = handler;
        },
      },
      fetch: async () => {
        throw new Error('Offline');
      },
      caches: { match: async (key) => (typeof key === 'string' ? key : undefined) },
    });
    handlers.fetch({
      request: { method: 'GET', mode: 'navigate', url: `https://pos.test${path}` },
      respondWith: (value) => {
        response = value;
      },
    });
    assert.equal(await response, expected);
  });
}

test('authentication requests never use the offline cache', () => {
  const handlers = {};
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = input.url;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
  });
  handlers.fetch({
    request: { method: 'GET', url: 'https://pos.test/api/auth/session' },
    respondWith: () => assert.fail('API response must not be cached'),
  });
});

test('POS runtime and sync policy are cached for offline startup without legacy assets', async () => {
  const handlers = {};
  let cachedPaths = [];
  let installation;
  const cache = {
    addAll: async (requests) => {
      cachedPaths = requests.map((request) => request.url);
    },
    match: async () => null,
    add: async () => {},
  };
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = new URL(input, 'https://pos.test').href;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
      skipWaiting: async () => {},
    },
    caches: { open: async () => cache },
  });
  handlers.install({
    waitUntil: (promise) => {
      installation = promise;
    },
  });
  await installation;
  assert.ok(cachedPaths.some((path) => path.endsWith('/pos-runtime.js')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/vendor/product-xlsx.js')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/vendor/fflate.js')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/shift-utils.mjs')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/sync-policy.js')));
  assert.ok(cachedPaths.every((path) => !path.includes('/legacy/')));
});

test('service worker activates updates only after an explicit user request', async () => {
  const handlers = {};
  let skipWaitingCount = 0;
  runInNewContext(source, {
    self: {
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
      skipWaiting: async () => {
        skipWaitingCount += 1;
      },
    },
  });
  assert.equal(skipWaitingCount, 0);
  handlers.message({ data: { type: 'OTHER' } });
  assert.equal(skipWaitingCount, 0);
  await handlers.message({ data: { type: 'FASTQ_ACTIVATE_UPDATE' } });
  assert.equal(skipWaitingCount, 1);
});

test('service worker tolerates optional build-asset cache misses', () => {
  assert.match(source, /Promise\.allSettled\(BUILD_ASSETS\.map/);
  assert.match(source, /await cache\.addAll\(CORE_ASSETS/);
  assert.doesNotMatch(source, /clients\.claim/);
});

test('service worker install fails when a required core asset cannot be cached', async () => {
  const handlers = {};
  let installation;
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = new URL(input, 'https://pos.test').href;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
    caches: {
      open: async () => ({
        addAll: async () => {
          throw new Error('404 core asset');
        },
      }),
    },
  });
  handlers.install({
    waitUntil: (promise) => {
      installation = promise;
    },
  });
  await assert.rejects(installation, /404 core asset/);
});

test('cold offline module requests are fulfilled from the current service-worker cache', async () => {
  const handlers = {};
  let response;
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = input.url;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
    caches: {
      match: async (request) =>
        request.url.endsWith('/sync-policy.js') ? 'cached module' : undefined,
    },
    fetch: async () => {
      throw new Error('offline');
    },
  });
  handlers.fetch({
    request: { method: 'GET', mode: 'cors', url: 'https://pos.test/sync-policy.js' },
    respondWith: (value) => {
      response = value;
    },
  });
  assert.equal(await response, 'cached module');
});
