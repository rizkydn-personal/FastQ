import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAttendanceEvent } from '../sync-attendance-handler.mjs';

test('attendance handler rejects invalid identity and date before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applyAttendanceEvent({
      client: { query: async () => { queries++; return { rows: [], rowCount: 0 }; } },
      event: { type: 'attendance.upsert', payload: { id: 'bad', userId: 'bad', workDate: '2026-02-30' } },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Kasir' },
      deviceId: '00000000-0000-4000-8000-000000000003',
      isUuid: value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    }),
    error => error.status === 400,
  );
  assert.equal(queries, 0);
});
