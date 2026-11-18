import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedCashForShift } from '../shift-utils.mjs';

test('expected cash includes eligible cash payments and shift movements only', () => {
  const shift = { id: 'shift-a', openingCash: 1000 };
  const sales = [
    { status: 'Lunas', shiftId: 'shift-a', payments: [{ method: 'Tunai', amount: 500, shiftId: 'shift-a' }] },
    { status: 'Piutang', shiftId: 'shift-a', payments: [{ method: 'Tunai', amount: 50 }] },
    { status: 'Lunas', shiftId: 'shift-a', payments: [{ method: 'Tunai', amount: 20 }] },
    { status: 'Lunas', shiftId: 'shift-a', payments: [{ method: 'Tunai', amount: 200, shiftId: 'shift-b' }] },
    { status: 'Gagal', shiftId: 'shift-a', payments: [{ method: 'Tunai', amount: 80 }] },
    { status: 'Void', shiftId: 'shift-a', payments: [{ method: 'Tunai', amount: 70 }] },
    { status: 'Menunggu', shiftId: 'shift-a', payments: [{ method: 'Tunai', amount: 60 }] },
    { status: 'Lunas', shiftId: 'shift-a', payments: [{ method: 'QRIS', amount: 300 }] },
  ];
  const movements = [
    { shiftId: 'shift-a', type: 'in', amount: 100 },
    { shiftId: 'shift-a', type: 'out', amount: 30 },
    { shiftId: 'shift-b', type: 'in', amount: 900 },
  ];

  assert.equal(expectedCashForShift(shift, sales, movements), 1640);
});

test('expected cash returns zero for a missing or invalid shift', () => {
  assert.equal(expectedCashForShift(null, [], []), 0);
  assert.equal(expectedCashForShift({ openingCash: 500 }, [], []), 0);
});
