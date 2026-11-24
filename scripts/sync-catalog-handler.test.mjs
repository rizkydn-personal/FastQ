import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCatalogEvent } from '../server/sync-catalog-handler.mjs';

const outletId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000002';
const eventId = '00000000-0000-4000-8000-000000000003';
const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function queryRecorder(rowCount = 1) {
  const calls = [];
  return {
    calls,
    client: {
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rowCount, rows: [] };
      },
    },
  };
}

test('catalog outlet upsert stays in the catalog handler', async () => {
  const { calls, client } = queryRecorder();
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: { type: 'outlet.upsert', payload: { id: outletId, name: 'Toko audit' } },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO outlets/);
  assert.deepEqual(calls[0].values, [outletId, 'Toko audit']);
});

test('catalog handlers reject malformed product, deletion, and customer payloads before database writes', async () => {
  const cases = [
    { type: 'product.upsert', payload: { id: 'bad' }, expected: 400 },
    { type: 'product.delete', payload: {}, expected: 400 },
    { type: 'customer.upsert', payload: { id: customerId, name: '  ' }, expected: 400 },
  ];
  for (const event of cases) {
    const { calls, client } = queryRecorder();
    await assert.rejects(
      applyCatalogEvent({ client, scope: outletId, deviceId: eventId, isUuid, event }),
      (error) => error.status === event.expected,
    );
    assert.equal(calls.length, 0);
  }
});

test('customer upsert stores a canonical outlet-scoped payload', async () => {
  const { calls, client } = queryRecorder();
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: {
      id: eventId,
      type: 'customer.upsert',
      payload: { id: customerId, name: '  Ayu  ', phone: ' 0812 ', email: ' ayu@example.test ' },
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, [customerId, outletId, 'Ayu', '0812', 'ayu@example.test']);
  assert.deepEqual(calls[1].values, [
    { id: customerId, name: 'Ayu', phone: '0812', email: 'ayu@example.test', outletId },
    eventId,
    eventId,
  ]);
});

test('product upsert accepts a negative stock balance after an offline sale conflict', async () => {
  const { calls, client } = queryRecorder();
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: {
      id: eventId,
      type: 'product.upsert',
      outletId,
      payload: {
        id: '00000000-0000-4000-8000-000000000004',
        sku: 'SKU-NEG',
        name: 'Produk konflik',
        price: 100,
        stockByOutlet: { [outletId]: -2 },
        category: 'Uji',
      },
    },
  });
  const stockInsert = calls.find((call) => call.sql.includes('INSERT INTO stock_balances'));
  assert.equal(JSON.parse(stockInsert.values[0])[0].quantity, -2);
});
