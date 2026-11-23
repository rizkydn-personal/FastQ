import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCashEvent } from '../server/sync-cash-handler.mjs';

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

test('cash handlers reject malformed movement and approval payloads before database access', async () => {
  for (const event of [
    { type: 'cash.upsert', payload: { id: 'bad' } },
    { type: 'cash.approval', payload: { id: 'bad', approvalStatus: 'approved' } },
  ]) {
    let queries = 0;
    await assert.rejects(
      applyCashEvent({
        client: {
          query: async () => {
            queries++;
            return { rows: [], rowCount: 0 };
          },
        },
        event,
        scope: '00000000-0000-4000-8000-000000000001',
        actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Admin', name: 'Audit' },
        deviceId: '00000000-0000-4000-8000-000000000003',
        isUuid,
      }),
      (error) => error.status === 400,
    );
    assert.equal(queries, 0);
  }
});
