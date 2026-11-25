import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAttendanceEvent } from '../server/sync-attendance-handler.mjs';

test('attendance handler rejects invalid identity and date before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applyAttendanceEvent({
      client: {
        query: async () => {
          queries++;
          return { rows: [], rowCount: 0 };
        },
      },
      event: {
        type: 'attendance.upsert',
        payload: { id: 'bad', userId: 'bad', workDate: '2026-02-30' },
      },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Kasir' },
      deviceId: '00000000-0000-4000-8000-000000000003',
      isUuid: (value) =>
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    }),
    (error) => error.status === 400,
  );
  assert.equal(queries, 0);
});

test('attendance handler inserts check-in and check-out locations', async () => {
  const queries = [];
  let current = null;
  const locationIn = {
    latitude: -6.2,
    longitude: 106.8,
    accuracy: 12,
    capturedAt: '2026-11-25T12:00:00.000Z',
  };
  const locationOut = {
    latitude: -6.21,
    longitude: 106.81,
    accuracy: 10,
    capturedAt: '2026-11-25T14:00:00.000Z',
  };
  const client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('SELECT name FROM users'))
        return { rows: [{ name: 'Admin 1' }], rowCount: 1 };
      if (sql.includes('SELECT outlet_id,user_id,work_date')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id,user_name,work_date,check_in,check_out,check_in_location'))
        return { rows: current ? [current] : [], rowCount: current ? 1 : 0 };
      if (sql.includes('INSERT INTO attendance')) {
        current = {
          id: values[0],
          user_name: values[3],
          work_date: values[4],
          check_in: values[5],
          check_out: null,
          check_in_location: values[6],
          check_out_location: null,
        };
        return { rows: [current], rowCount: 1 };
      }
      if (sql.includes('UPDATE attendance SET check_in_location')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE attendance SET check_out=$2,check_out_location=$3')) {
        current.check_out = values[1];
        current.check_out_location = values[2];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE sync_events')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const base = {
    client,
    scope: '00000000-0000-4000-8000-000000000001',
    actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Admin' },
    deviceId: '00000000-0000-4000-8000-000000000003',
    isUuid: (value) =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  };
  await applyAttendanceEvent({
    ...base,
    event: {
      type: 'attendance.upsert',
      payload: {
        id: '00000000-0000-4000-8000-000000000004',
        userId: base.actor.id,
        workDate: '2026-11-25',
        checkIn: '2026-11-25T12:00:00.000Z',
        checkInLocation: locationIn,
      },
    },
  });
  await applyAttendanceEvent({
    ...base,
    event: {
      type: 'attendance.upsert',
      payload: {
        id: '00000000-0000-4000-8000-000000000004',
        userId: base.actor.id,
        workDate: '2026-11-25',
        checkIn: '2026-11-25T12:00:00.000Z',
        checkOut: '2026-11-25T14:00:00.000Z',
        checkInLocation: locationIn,
        checkOutLocation: locationOut,
      },
    },
  });
  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO attendance')));
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes('UPDATE attendance SET check_out=$2,check_out_location=$3') &&
        query.values[2] === locationOut,
    ),
  );
  assert.deepEqual(current.check_in_location, locationIn);
  assert.deepEqual(current.check_out_location, locationOut);
});
