import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceDateKey, attendanceDateLabel, attendanceLocationMarkup, attendanceLocationText, attendanceTimeLabel } from '../attendance-utils.mjs';

test('attendance date and time helpers handle valid and invalid input', () => {
  assert.equal(attendanceDateKey('2026-11-16T10:30:00.000Z'), '2026-11-16');
  assert.equal(attendanceDateKey('not-a-date'), '');
  assert.match(attendanceDateLabel('2026-11-16'), /2026/);
  assert.equal(attendanceDateKey(new Date(2026, 10, 16, 12)), '2026-11-16');
  assert.equal(typeof attendanceTimeLabel(new Date(2026, 10, 16, 12, 30)), 'string');
});

test('attendance location output accepts coordinates and rejects invalid values', () => {
  const location = { latitude: -6.2, longitude: 106.8, accuracy: 18 };
  assert.match(attendanceLocationText(location), /-6\.200000, 106\.800000/);
  assert.equal(attendanceLocationText({ latitude: 'invalid', longitude: 106.8 }), '');
  assert.match(attendanceLocationMarkup(location), /rel="noopener noreferrer"/);
  assert.match(attendanceLocationMarkup(null), /attendance-location-unavailable/);
});
