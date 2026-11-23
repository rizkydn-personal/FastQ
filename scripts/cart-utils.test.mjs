import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCartTotals } from '../shared/cart-utils.mjs';

test('cart totals include subtotal and rounded service charge with zero tax', () => {
  const result = calculateCartTotals(
    [
      { price: 1999, qty: 3 },
      { price: 500, qty: 2 },
    ],
    null,
    { service: 5 },
  );

  assert.deepEqual(result, {
    subtotal: 6997,
    itemDiscount: 0,
    d: 0,
    tax: 0,
    service: 350,
    total: 7347,
  });
});

test('item discounts are capped, rounded, and followed by transaction discount and service', () => {
  const result = calculateCartTotals(
    [
      { price: 1000, qty: 2, discount: { kind: 'percent', value: 10 } },
      { price: 500, qty: 2, discount: { kind: 'amount', value: 2000 } },
    ],
    { kind: 'percent', value: 10 },
    { service: 2 },
  );

  assert.deepEqual(result, {
    subtotal: 3000,
    itemDiscount: 1200,
    d: 180,
    tax: 0,
    service: 32,
    total: 1652,
  });
});

test('discounts cannot reduce a cart below zero', () => {
  const result = calculateCartTotals(
    [{ price: 100, qty: 1, discount: { kind: 'percent', value: 50 } }],
    { kind: 'amount', value: 1000 },
    { service: 0 },
  );

  assert.deepEqual(result, {
    subtotal: 100,
    itemDiscount: 50,
    d: 50,
    tax: 0,
    service: 0,
    total: 0,
  });
});
