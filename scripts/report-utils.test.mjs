import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dateWithinReportPeriod, formatSaleNumber, rankLeastSellingProducts } from '../report-utils.mjs';

test('sale number display shortens legacy UUIDs and preserves compact references', () => {
  assert.equal(
    formatSaleNumber('TRX-261119172611-550e8400-e29b-41d4-a716-446655440000'),
    'TRX-261119-550E8400E29B41D4',
  );
  assert.equal(formatSaleNumber('TRX-261119-550E8400E29B41D4'), 'TRX-261119-550E8400E29B41D4');
  assert.equal(formatSaleNumber('TRX-TEST'), 'TRX-TEST');
});

test('least-selling ranking includes unsold products and prioritizes fewer units', () => {
  const products = [
    { id: 'unsold', name: 'Produk belum laku' },
    { id: 'quiet', name: 'Produk kurang laris' },
  ];
  const productTotals = new Map([
    ['quiet', { name: 'Produk kurang laris', quantity: 1, revenue: 10000 }],
    ['popular', { name: 'Produk laris', quantity: 5, revenue: 50000 }],
  ]);
  assert.deepEqual(rankLeastSellingProducts(products, productTotals, 2), [
    { name: 'Produk belum laku', quantity: 0, revenue: 0 },
    { name: 'Produk kurang laris', quantity: 1, revenue: 10000 },
  ]);
});

test('today report period includes its local midnight and excludes the next midnight', () => {
  const start = new Date(2026, 10, 16, 0, 0, 0, 0);
  const end = new Date(2026, 10, 17, 0, 0, 0, 0);
  assert.equal(dateWithinReportPeriod(start.toISOString(), 'today', '2026-11-16', new Date(2026, 10, 20)), true);
  assert.equal(dateWithinReportPeriod(new Date(end.getTime() - 1).toISOString(), 'today', '2026-11-16'), true);
  assert.equal(dateWithinReportPeriod(end.toISOString(), 'today', '2026-11-16'), false);
});

test('week report period retains its six-day inclusive lower bound and future-date behavior', () => {
  const now = new Date(2026, 10, 16, 14);
  const weekStart = new Date(2026, 10, 10, 0);
  assert.equal(dateWithinReportPeriod(weekStart.toISOString(), 'week', '', now), true);
  assert.equal(dateWithinReportPeriod(new Date(weekStart.getTime() - 1).toISOString(), 'week', '', now), false);
  assert.equal(dateWithinReportPeriod(new Date(2026, 11, 1).toISOString(), 'week', '', now), true);
});

test('month and all report periods match existing calendar semantics', () => {
  const now = new Date(2026, 10, 16);
  assert.equal(dateWithinReportPeriod(new Date(2026, 10, 1).toISOString(), 'month', '', now), true);
  assert.equal(dateWithinReportPeriod(new Date(2026, 9, 31, 23, 59).toISOString(), 'month', '', now), false);
  assert.equal(dateWithinReportPeriod('invalid', 'all', '', now), true);
});

test('today and week report periods follow local calendar days across DST', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { dateWithinReportPeriod } from './report-utils.mjs';
    const dayBeforeMidnight = new Date('2026-03-09T03:59:59.999Z');
    const nextMidnight = new Date('2026-03-09T04:00:00.000Z');
    assert.equal(dateWithinReportPeriod(dayBeforeMidnight.toISOString(), 'today', '2026-03-08', new Date('2026-03-08T12:00:00')), true);
    assert.equal(dateWithinReportPeriod(nextMidnight.toISOString(), 'today', '2026-03-08', new Date('2026-03-08T12:00:00')), false);
    const weekStart = new Date(2026, 2, 5, 0, 0, 0, 0);
    assert.equal(dateWithinReportPeriod(weekStart.toISOString(), 'week', '', new Date(2026, 2, 11, 12)), true);
    assert.equal(dateWithinReportPeriod(new Date(weekStart.getTime() - 1).toISOString(), 'week', '', new Date(2026, 2, 11, 12)), false);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' },
    stdio: 'pipe',
  });
});
