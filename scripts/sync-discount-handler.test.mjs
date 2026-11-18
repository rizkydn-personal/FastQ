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
