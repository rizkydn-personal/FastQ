import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReceivableEvent } from '../server/sync-receivable-handler.mjs';

test('receivable payment rejects invalid ids before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applyReceivableEvent({
      client: {
        query: async () => {
          queries++;
          return { rows: [], rowCount: 0 };
        },
      },
      event: { payload: { id: 'bad' } },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { role: 'Admin' },
      deviceId: '00000000-0000-4000-8000-000000000002',
      isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    }),
    (error) => error.status === 400,
  );
  assert.equal(queries, 0);
});

test('receivable payment cannot be posted to a closed shift', async () => {
  const saleId = '00000000-0000-4000-8000-000000000010';
  const paymentId = '00000000-0000-4000-8000-000000000011';
  const shiftId = '00000000-0000-4000-8000-000000000012';
  const at = '2026-11-23T03:00:00.000Z';
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM payments payment'))
        return {
          rows: [
            {
              sale_id: saleId,
              method: 'Tunai',
              status: 'Lunas',
              amount_rupiah: '1000',
              occurred_at: new Date(at),
              metadata: { shiftId },
              customer_id: null,
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('FROM shifts')) return { rows: [{ closed_at: new Date(at) }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  await assert.rejects(
    applyReceivableEvent({
      client,
      event: {
        payload: {
          id: paymentId,
          saleId,
          customerId: null,
          shiftId,
          method: 'Tunai',
          amount: 1000,
          at,
        },
      },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { role: 'Admin' },
      deviceId: '00000000-0000-4000-8000-000000000002',
      isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    }),
    (error) => error.status === 409 && /sudah ditutup/.test(error.message),
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((sql) => !sql.includes('INSERT INTO receivable_payments')));
});
