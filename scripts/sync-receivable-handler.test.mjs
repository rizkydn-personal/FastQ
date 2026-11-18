import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReceivableEvent } from '../sync-receivable-handler.mjs';

test('receivable payment rejects invalid ids before database access', async () => {
  let queries = 0;
  await assert.rejects(applyReceivableEvent({ client: { query: async () => { queries++; return { rows: [], rowCount: 0 }; } }, event: { payload: { id: 'bad' } }, scope: '00000000-0000-4000-8000-000000000001', actor: { role: 'Admin' }, deviceId: '00000000-0000-4000-8000-000000000002', isUuid: value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) }), error => error.status === 400);
  assert.equal(queries, 0);
});
