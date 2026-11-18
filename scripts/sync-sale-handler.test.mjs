import test from 'node:test';
import assert from 'node:assert/strict';
import { applySaleEvent } from '../sync-sale-handler.mjs';

test('sale handler rejects invalid sale payload before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applySaleEvent({
      client: { query: async () => { queries++; return { rows: [], rowCount: 0 }; } },
      event: { payload: { id: 'invalid' } },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Admin', name: 'Audit' },
      deviceId: '00000000-0000-4000-8000-000000000003',
      isUuid: value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
      createHash: () => { throw new Error('must not be called for invalid payload'); },
    }),
    error => error.status === 400,
  );
  assert.equal(queries, 0);
});
