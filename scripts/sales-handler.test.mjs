import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesHandler } from '../server/sales-handler.mjs';

const outletId = '11111111-1111-4111-8111-111111111111';
const saleId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';

function fixture(role = 'Kasir') {
  const calls = [];
  const date = new Date('2026-11-23T01:00:00.000Z');
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM sales s'))
        return {
          rows: [
            {
              id: saleId,
              outlet_id: outletId,
              shift_id: null,
              customer_id: null,
              customer_name: null,
              cashier_name: 'Nadia',
              timezone: 'Asia/Jakarta',
              sale_number: 'TRX-20261123-22222222',
              status: 'Lunas',
              subtotal_rupiah: '25000',
              discount_rupiah: '1000',
              tax_rupiah: '0',
              service_rupiah: '0',
              total_rupiah: '24000',
              occurred_at: date,
              metadata: { outstanding: 0 },
            },
          ],
        };
      if (sql.includes('FROM sale_items'))
        return {
          rows: [
            {
              sale_id: saleId,
              id: itemId,
              product_id: productId,
              variant_id: null,
              product_name: 'Teh',
              sku: 'TEH-1',
              quantity: '2',
              unit_price_rupiah: '12500',
              unit_cost_rupiah: '4000',
              discount_rupiah: '1000',
              note: null,
            },
          ],
        };
      if (sql.includes('FROM payments'))
        return {
          rows: [
            {
              id: itemId,
              sale_id: saleId,
              method: 'Tunai',
              status: 'Lunas',
              amount_rupiah: '24000',
              reference: null,
              occurred_at: date,
              metadata: { received: 25000, change: 1000, shiftId: null },
            },
          ],
        };
      if (sql.includes('FROM sale_refunds')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  let response;
  const handler = createSalesHandler({
    pool,
    activeSession: async () => ({ id: 'user', outlet_id: outletId, role }),
    json: (_res, status, value) => {
      response = { status, value };
    },
    isUuid: (value) => /^[0-9a-f-]{36}$/i.test(value || ''),
  });
  const request = (query = '') =>
    handler({ method: 'GET' }, {}, new URL(`http://pos.test/api/sales${query}`));
  return {
    calls,
    request,
    get response() {
      return response;
    },
  };
}

test('sales history returns transaction item, payment, refund, and discount details', async () => {
  const f = fixture('Pemilik');
  await f.request(`?id=${saleId}`);
  assert.equal(f.response.status, 200);
  const sale = f.response.value.sales[0];
  assert.equal(sale.itemDiscount, 1000);
  assert.equal(sale.transactionDiscount, 0);
  assert.equal(sale.items[0].cost, 4000);
  assert.equal(sale.payments[0].change, 1000);
  assert.deepEqual(sale.refunds, []);
  assert.match(f.calls[0].sql, /AT TIME ZONE o\.timezone/);
});

test('sales history does not expose item cost to cashiers', async () => {
  const f = fixture('Kasir');
  await f.request(`?id=${saleId}`);
  assert.equal(Object.hasOwn(f.response.value.sales[0].items[0], 'cost'), false);
});

test('sales history rejects foreign outlet and malformed date or cursor before queries', async () => {
  const foreign = fixture();
  await foreign.request('?outletId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(foreign.response.status, 403);
  assert.equal(foreign.calls.length, 0);
  const malformedDate = fixture();
  await malformedDate.request('?from=2026-02-30');
  assert.equal(malformedDate.response.status, 400);
  assert.equal(malformedDate.calls.length, 0);
  const malformedCursor = fixture();
  await malformedCursor.request('?before=2026-11-23T00:00:00Z&beforeId=bad');
  assert.equal(malformedCursor.response.status, 400);
  assert.equal(malformedCursor.calls.length, 0);
});
