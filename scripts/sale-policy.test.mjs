import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSalePayload,
  cashierDiscountViolation,
  createRefundRecord,
} from '../shared/sale-policy.mjs';

const requestId = '00000000-0000-4000-8000-000000000099';

test('refund record pays settled value and cancels remaining receivable with server-required approval data', () => {
  const refund = createRefundRecord({
    sale: { id: requestId, status: 'Piutang', total: 10000, outstanding: 2500 },
    reason: 'Barang rusak',
    method: 'Tunai',
    restocked: true,
    approvedByName: 'Admin',
    id: '00000000-0000-4000-8000-000000000098',
    at: new Date().toISOString(),
  });
  assert.equal(refund.amount, 7500);
  assert.equal(refund.cancelledOutstanding, 2500);
  assert.equal(refund.approvedByName, 'Admin');
  assert.equal(refund.restocked, true);
});

test('refund record rejects a Piutang balance beyond the sale total', () => {
  assert.throws(
    () =>
      createRefundRecord({
        sale: { status: 'Piutang', total: 1000, outstanding: 1001 },
        reason: 'Alasan',
        approvedByName: 'Admin',
        id: requestId,
        at: new Date().toISOString(),
      }),
    /Nilai piutang/,
  );
});

test('cashier item discount within 10% needs no approval marker', () => {
  const sale = {
    subtotal: 10000,
    discount: 1000,
    items: [{ price: 10000, qty: 1, discount: { kind: 'percent', value: 10 } }],
  };
  assert.equal(cashierDiscountViolation(sale), null);
});

test('cashier item discount above 10% without an approval marker is a violation', () => {
  const sale = {
    subtotal: 10000,
    discount: 5000,
    items: [{ price: 10000, qty: 1, discount: { kind: 'percent', value: 50 } }],
  };
  assert.match(cashierDiscountViolation(sale), /10%/);
});

test('cashier item discount above 10% with a recorded approval request is allowed', () => {
  const sale = {
    subtotal: 10000,
    discount: 5000,
    items: [
      {
        price: 10000,
        qty: 1,
        discount: {
          kind: 'percent',
          value: 50,
          pendingApproval: true,
          approvalRequestId: requestId,
        },
      },
    ],
  };
  assert.equal(cashierDiscountViolation(sale), null);
});

test('cashier item discount above 10% with an invalid approval request id is a violation', () => {
  const sale = {
    subtotal: 10000,
    discount: 5000,
    items: [
      {
        price: 10000,
        qty: 1,
        discount: {
          kind: 'percent',
          value: 50,
          pendingApproval: true,
          approvalRequestId: 'bukan-uuid',
        },
      },
    ],
  };
  assert.match(cashierDiscountViolation(sale), /10%/);
});

test('cashier amount discount above 10% of the line needs an approval marker', () => {
  const sale = {
    subtotal: 10000,
    discount: 2000,
    items: [{ price: 10000, qty: 1, discount: { kind: 'amount', value: 2000 } }],
  };
  assert.match(cashierDiscountViolation(sale), /10%/);
});

test('cashier transaction discount above 10% is a violation', () => {
  const sale = { subtotal: 10000, discount: 2000, items: [{ price: 10000, qty: 1 }] };
  assert.match(cashierDiscountViolation(sale), /transaksi/);
});

test('cashier transaction discount within 10% is allowed', () => {
  const sale = { subtotal: 10000, discount: 1000, items: [{ price: 10000, qty: 1 }] };
  assert.equal(cashierDiscountViolation(sale), null);
});

const uuid = '00000000-0000-4000-8000-000000000001';
const validSale = (payment) => ({
  id: uuid,
  number: 'TRX-TEST',
  status: 'Lunas',
  at: new Date().toISOString(),
  subtotal: 100,
  discount: 0,
  tax: 0,
  service: 0,
  total: 100,
  items: [{ productId: uuid, name: 'Barang uji', qty: 1, price: 100 }],
  payments: [
    { id: '00000000-0000-4000-8000-000000000002', method: 'Tunai', amount: 100, ...payment },
  ],
});

test('sale payment status accepts bounded strings and omitted legacy values', () => {
  assert.doesNotThrow(() => validateSalePayload(validSale({ status: 'Lunas' })));
  assert.doesNotThrow(() => validateSalePayload(validSale({})));
  assert.doesNotThrow(() => validateSalePayload(validSale({ status: 'x'.repeat(40) })));
});

test('sale rejects nonzero tax', () => {
  const sale = validSale({});
  sale.tax = 1;
  sale.total = 101; // konsisten dengan rumus, jadi hanya aturan tax-nol yang menolak
  assert.throws(() => validateSalePayload(sale), /Nilai tax transaksi harus 0/);
});

test('sale payment status rejects non-string and oversized values', () => {
  assert.throws(
    () => validateSalePayload(validSale({ status: { value: 'Lunas' } })),
    /Pembayaran transaksi tidak valid/,
  );
  assert.throws(
    () => validateSalePayload(validSale({ status: 'x'.repeat(41) })),
    /Pembayaran transaksi tidak valid/,
  );
});

test('sale payment rejects a malformed shift reference before it reaches database metadata', () => {
  assert.throws(
    () => validateSalePayload(validSale({ shiftId: 'invalid-shift-id' })),
    /Pembayaran transaksi tidak valid/,
  );
  assert.doesNotThrow(() => validateSalePayload(validSale({ shiftId: uuid })));
});
