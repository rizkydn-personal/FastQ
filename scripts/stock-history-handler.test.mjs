import test from 'node:test';
import assert from 'node:assert/strict';
import { createStockHistoryHandler } from '../server/stock-history-handler.mjs';

const outletId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const movementId = '33333333-3333-4333-8333-333333333333';
const uuid = (value) => /^[0-9a-f-]{36}$/i.test(value || '');

function fixture(role = 'Admin') {
  const calls = [];
  let response;
  const handler = createStockHistoryHandler({
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              id: movementId,
              product_id: productId,
              variant_id: null,
              delta: '-2.000',
              reason: 'Penjualan TRX-01',
              occurred_at: new Date('2026-11-23T01:00:00.000Z'),
              product_name: 'Teh',
              sku: 'TEH-1',
              actor_name: null,
              kind: 'Penjualan',
            },
          ],
        };
      },
    },
    activeSession: async () => ({ id: 'user-id', outlet_id: outletId, role }),
    json: (_res, status, value) => (response = { status, value }),
    isUuid: uuid,
  });
  const request = (query = '') =>
    handler({ method: 'GET' }, {}, new URL(`http://pos.test/api/stock-movements${query}`));
  return {
    calls,
    request,
    get response() {
      return response;
    },
  };
}

test('stock history applies cursor, type, and date filters within the session outlet', async () => {
  const f = fixture();
  await f.request(
    `?productId=${productId}&kind=Penjualan&from=2026-11-22&to=2026-11-23&before=2026-11-24T00%3A00%3A00Z&beforeId=${movementId}`,
  );
  assert.equal(f.response.status, 200);
  assert.equal(f.response.value.movements[0].actor, 'Tidak tercatat');
  assert.equal(f.response.value.movements[0].delta, -2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params[7], 11);
  assert.match(f.calls[0].sql, /AT TIME ZONE o\.timezone/);
  assert.deepEqual(f.calls[0].params.slice(0, 7), [
    outletId,
    productId,
    '2026-11-24T00:00:00Z',
    movementId,
    '2026-11-22',
    '2026-11-23',
    'Penjualan',
  ]);
});

test('stock history rejects cashiers and invalid filters before querying', async () => {
  const cashier = fixture('Kasir');
  await cashier.request();
  assert.equal(cashier.response.status, 403);
  assert.equal(cashier.calls.length, 0);

  const malformed = fixture();
  await malformed.request(`?productId=${productId}&from=2026-02-30`);
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.calls.length, 0);

  const oversized = fixture();
  await oversized.request('?limit=11');
  assert.equal(oversized.response.status, 400);
  assert.equal(oversized.calls.length, 0);
});
