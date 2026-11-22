import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscountEvent } from '../sync-discount-handler.mjs';

const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

test('discount handlers reject malformed requests and decisions before database access', async () => {
  for (const event of [
    { type: 'discount.request', payload: { id: 'bad' } },
    { type: 'discount.approval', payload: { id: 'bad', approvalStatus: 'approved' } },
  ]) {
    let queries = 0;
    await assert.rejects(
      applyDiscountEvent({
        client: { query: async () => { queries++; return { rows: [], rowCount: 0 }; } },
        event,
        scope: '00000000-0000-4000-8000-000000000001',
        actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Kasir', name: 'Audit' },
        deviceId: '00000000-0000-4000-8000-000000000003',
        isUuid,
      }),
      error => error.status === 400,
    );
    assert.equal(queries, 0);
  }
});

test('discount request accepts a Piutang sale on the same shift', async () => {
  const outletId = '00000000-0000-4000-8000-000000000001';
  const shiftId = '00000000-0000-4000-8000-000000000030';
  const saleId = '00000000-0000-4000-8000-000000000020';
  const productId = '00000000-0000-4000-8000-000000000010';
  const kasirId = '00000000-0000-4000-8000-000000000002';
  const deviceId = '00000000-0000-4000-8000-000000000003';
  const client = {
    async query(text) {
      const sql = typeof text === 'string' ? text : text.text;
      if (sql.includes('FROM shifts WHERE id=$1')) return { rows: [{ closed_at: null }], rowCount: 1 };
      if (sql.includes('FROM sales WHERE id=$1')) return { rows: [{ shift_id: shiftId, status: 'Piutang' }], rowCount: 1 };
      if (sql.includes('FROM sale_items WHERE sale_id=$1')) {
        return { rows: [{ product_name: 'Barang uji', quantity: '1', unit_price_rupiah: '10000', discount_rupiah: '1000' }], rowCount: 1 };
      }
      if (sql.includes("event_type='discount.request'")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  await applyDiscountEvent({
    client,
    event: {
      type: 'discount.request',
      payload: {
        id: '00000000-0000-4000-8000-000000000099', shiftId, saleId, productId, variantId: null,
        requestedById: kasirId, requestDeviceId: deviceId, approvalStatus: 'pending',
        kind: 'percent', value: 10, quantity: 1, baseAmount: 10000,
      },
    },
    scope: outletId,
    actor: { id: kasirId, role: 'Kasir', name: 'Kasir Uji' },
    deviceId,
    isUuid,
  });
});
