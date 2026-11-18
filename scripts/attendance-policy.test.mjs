import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRemoteSyncEvents, isAttendanceLocation } from '../attendance-policy.mjs';

const location = { latitude: -6.2, longitude: 106.8, accuracy: 18, capturedAt: '2026-11-15T10:00:00.000Z' };

test('attendance location validates finite coordinates and capture time', () => {
  assert.equal(isAttendanceLocation(location), true);
  assert.equal(isAttendanceLocation(null), true);
  assert.equal(isAttendanceLocation({ ...location, latitude: 91 }), false);
  assert.equal(isAttendanceLocation({ ...location, accuracy: -1 }), false);
  assert.equal(isAttendanceLocation({ ...location, capturedAt: 'not-a-date' }), false);
});

test('cashiers receive attendance events without other users locations', () => {
  const attendance = { device_id: 'device-a', event_type: 'attendance.upsert', payload: { userId: 'user-a', checkInLocation: location, checkOutLocation: location } };
  const sale = { device_id: 'device-b', event_type: 'sale.upsert', payload: { id: 'sale-a' } };
  const events = filterRemoteSyncEvents([attendance, sale], 'Kasir', 'device-b');
  assert.deepEqual(events, [{ ...attendance, payload: { userId: 'user-a' } }]);
});

test('administrators receive attendance locations', () => {
  const attendance = { device_id: 'device-a', event_type: 'attendance.upsert', payload: { checkInLocation: location } };
  assert.deepEqual(filterRemoteSyncEvents([attendance], 'Admin', 'device-b'), [attendance]);
});
