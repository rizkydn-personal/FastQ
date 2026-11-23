import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const design = readFileSync(join(root, 'app/pos/index.html'), 'utf8');
const runtime = readFileSync(join(root, 'app/pos/runtime.js'), 'utf8');
const sales = readFileSync(join(root, 'server/sales-handler.mjs'), 'utf8');

test('transaction detail shows item, discount, payment, shift, customer and refund information', () => {
  for (const id of [
    'detailTrxContext',
    'detailTrxItems',
    'detailTrxSummary',
    'detailTrxPayments',
    'detailTrxRefunds',
  ]) {
    assert.match(design, new RegExp(`id="${id}"`));
  }
  for (const label of [
    'Subtotal',
    'Diskon item',
    'Diskon transaksi',
    'Pelanggan',
    'Shift',
    'Bayar',
  ])
    assert.ok(design.includes(label));
  assert.match(design, /refund\.reason/);
  assert.match(design, /payment\.received/);
});

test('transaction details are loaded from the authenticated server and cached locally', () => {
  assert.match(runtime, /sendApiRequest\(`\/api\/sales\?id=/);
  assert.match(
    runtime,
    /state\.sales\[index\]\s*=\s*\{\s*\.\.\.state\.sales\[index\],\s*\.\.\.normalized\s*\}/,
  );
  assert.match(sales, /FROM sale_items/);
  assert.match(sales, /FROM payments/);
  assert.match(sales, /FROM sale_refunds/);
});

test('transaction detail renders untrusted data through textContent', () => {
  const start = design.indexOf('async function openTransactionDetails(index)');
  const end = design.indexOf('function openLowStockPreview', start);
  const handler = design.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /\.textContent\s*=/);
  assert.doesNotMatch(handler, /\.innerHTML\s*=/);
});

test('POS runtime and published design do not reference the legacy cashier', () => {
  assert.doesNotMatch(design, /legacy\/index\.html|functionalPosEngine|FastQPOS/);
  assert.doesNotMatch(runtime, /legacy\/index\.html|FastQPOS/);
});
