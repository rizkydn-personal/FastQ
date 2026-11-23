import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShiftEvent } from '../server/sync-shift-handler.mjs';

test('shift handler rejects invalid identity and opening cash before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applyShiftEvent({
      client: {
        query: async () => {
          queries++;
          return { rows: [], rowCount: 0 };
        },
      },
      event: { type: 'shift.upsert', payload: { id: 'bad', openingCash: -1 } },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Admin' },
      deviceId: '00000000-0000-4000-8000-000000000003',
      isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    }),
    (error) => error.status === 400,
  );
  assert.equal(queries, 0);
});
