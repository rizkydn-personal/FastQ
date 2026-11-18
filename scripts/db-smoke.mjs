import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createSyncHandler } from '../sync-handler.mjs';
import { checkDatabaseReadiness } from '../database-policy.mjs';
import { postgresSslFromEnv } from '../postgres-config.mjs';

for (const line of (await readFile(new URL('../.env', import.meta.url), 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum dikonfigurasi.');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  ssl: postgresSslFromEnv(),
});
let heldClient;
let transactionClosed = true;

try {
  const readiness = await checkDatabaseReadiness(pool, 3);
  if (!readiness.ready) throw new Error(`Database belum siap: ${readiness.reason}`);
  const cashier = await pool.query(
    `SELECT id,outlet_id,role,name FROM users
     WHERE active=true AND role='Kasir' AND outlet_id IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  if (!cashier.rowCount) throw new Error('Perlu akun Kasir aktif yang terhubung ke outlet untuk smoke test.');

  const actor = cashier.rows[0];
  const ownerResult = await pool.query(
    `SELECT id,outlet_id,role,name FROM users
     WHERE active=true AND role='Pemilik' AND outlet_id=$1 ORDER BY created_at LIMIT 1`, [actor.outlet_id],
  );
  if (!ownerResult.rowCount) throw new Error('Perlu akun Pemilik aktif pada outlet yang sama untuk uji persetujuan.');
  const ownerActor = ownerResult.rows[0];
  const openShift = await pool.query(
    'SELECT id FROM shifts WHERE outlet_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
    [actor.outlet_id],
  );
  const shiftId = openShift.rows[0]?.id || randomUUID();
  const createShift = !openShift.rowCount;
  const fixture = await pool.query(
    `SELECT p.id,p.name,p.sku,p.price_rupiah::text,p.cost_rupiah::text,b.quantity::text AS quantity
     FROM products p JOIN stock_balances b ON b.product_id=p.id AND b.outlet_id=p.outlet_id AND b.variant_id IS NULL
     WHERE p.outlet_id=$1 AND p.deleted_at IS NULL AND b.quantity>=1 AND p.price_rupiah>=2
       AND NOT EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND COALESCE((v.metadata->>'retired')::boolean,FALSE)=FALSE)
     ORDER BY p.id LIMIT 1`, [actor.outlet_id],
  );
  if (!fixture.rowCount) throw new Error('Perlu produk aktif tanpa varian dengan stok minimal 1 untuk smoke test penjualan.');
  const product = fixture.rows[0];
  const productPrice = Number(product.price_rupiah);
  if (!Number.isSafeInteger(productPrice) || productPrice < 1) throw new Error('Produk fixture harus memiliki harga positif berupa Rupiah bulat.');
  const auditEventId = randomUUID(), auditId = randomUUID(), attendanceEventId = randomUUID();
  const saleEventId = randomUUID(), saleRetryEventId = randomUUID(), stockEventId = randomUUID();
  const receivableSaleEventId = randomUUID(), receivableEventId = randomUUID();
  const discountSaleEventId = randomUUID(), discountRequestEventId = randomUUID(), discountCancelEventId = randomUUID();
  const discountApprovalSaleEventId = randomUUID(), discountApprovalRequestEventId = randomUUID();
  const cashApprovalEventId = randomUUID(), discountApprovalEventId = randomUUID();
  const shiftEventId = createShift ? randomUUID() : null, cashEventId = randomUUID();
  const cashMovementId = randomUUID(), saleId = randomUUID(), paymentId = randomUUID();
  const receivableSaleId = randomUUID(), receivableSourcePaymentId = randomUUID();
  const discountSaleId = randomUUID(), discountRequestId = randomUUID(), discountPaymentId = randomUUID();
  const discountApprovalSaleId = randomUUID(), discountApprovalRequestId = randomUUID();
  const discountApprovalPaymentId = randomUUID();
  const attendanceId = randomUUID(), deviceId = randomUUID();
  const at = new Date().toISOString();
  const workDate = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const saleNumber = `DB-SMOKE-${saleId}`;
  const receivableSaleNumber = `DB-SMOKE-${receivableSaleId}`;
  const discountSaleNumber = `DB-SMOKE-${discountSaleId}`;
  const discountApprovalSaleNumber = `DB-SMOKE-${discountApprovalSaleId}`;
  const itemDiscount = Math.round(productPrice / 10);
  const discountedTotal = productPrice - itemDiscount;
  const salePayload = (id, number, status, paid, outstanding) => ({
    id, outletId: actor.outlet_id, shiftId, number, status, at,
    subtotal: productPrice, discount: 0, tax: 0, service: 0, total: productPrice,
    items: [{ productId: product.id, variantId: null, name: product.name, sku: product.sku, qty: 1, price: productPrice, cost: Number(product.cost_rupiah) || 0 }],
    payments: [{ id: paid.id, method: 'Tunai', amount: paid.amount, status: 'Lunas', shiftId, at }],
    refunds: [], outstanding,
  });
  const events = [];
  if (createShift) events.push({
    id: shiftEventId,
    type: 'shift.upsert',
    outletId: actor.outlet_id,
    at,
    payload: { id: shiftId, outletId: actor.outlet_id, openedAt: at, closedAt: null, openingCash: 0, cashier: actor.name, openedBy: actor.name, openedById: actor.id, cashiers: [actor.name] },
  });
  events.push({
    id: auditEventId,
    type: 'audit.append',
    outletId: actor.outlet_id,
    at,
    payload: { id: auditId, action: 'DB smoke test', detail: 'rollback-only', at },
  }, {
    id: attendanceEventId,
    type: 'attendance.upsert',
    outletId: actor.outlet_id,
    at,
    payload: { id: attendanceId, outletId: actor.outlet_id, userId: actor.id, workDate, checkIn: at, checkOut: null, checkInLocation: null, checkOutLocation: null },
  }, {
    id: cashEventId,
    type: 'cash.upsert',
    outletId: actor.outlet_id,
    at,
    payload: { id: cashMovementId, shiftId, type: 'out', amount: 1, reason: 'DB smoke rollback', category: 'Operasional', requestedById: actor.id, at },
  }, {
    id: saleEventId,
    type: 'sale.upsert',
    outletId: actor.outlet_id,
    at,
    payload: salePayload(saleId, saleNumber, 'Lunas', { id: paymentId, amount: productPrice }, 0),
  }, {
    id: saleRetryEventId,
    type: 'sale.upsert',
    outletId: actor.outlet_id,
    at,
    payload: salePayload(saleId, saleNumber, 'Lunas', { id: paymentId, amount: productPrice }, 0),
  }, {
    id: stockEventId,
    type: 'stock.delta',
    outletId: actor.outlet_id,
    at,
    payload: { productId: product.id, variantId: null, outletId: actor.outlet_id, saleId, delta: -1, reason: `Penjualan ${saleNumber}` },
  }, {
    id: receivableSaleEventId,
    type: 'sale.upsert',
    outletId: actor.outlet_id,
    at,
    payload: salePayload(receivableSaleId, receivableSaleNumber, 'Piutang', { id: receivableSourcePaymentId, amount: 1 }, productPrice - 1),
  }, {
    id: receivableEventId,
    type: 'receivable.payment',
    outletId: actor.outlet_id,
    at,
    payload: { id: receivableSourcePaymentId, saleId: receivableSaleId, customerId: null, shiftId, method: 'Tunai', amount: 1, at },
  }, {
    id: discountSaleEventId,
    type: 'sale.upsert',
    outletId: actor.outlet_id,
    at,
    payload: {
      id: discountSaleId, outletId: actor.outlet_id, shiftId, number: discountSaleNumber, status: 'Lunas', at,
      subtotal: productPrice, discount: itemDiscount, tax: 0, service: 0, total: discountedTotal,
      items: [{ productId: product.id, variantId: null, name: product.name, sku: product.sku, qty: 1, price: productPrice, cost: Number(product.cost_rupiah) || 0, discount: { kind: 'percent', value: 10 } }],
      payments: [{ id: discountPaymentId, method: 'Tunai', amount: discountedTotal, status: 'Lunas', shiftId, at }],
      refunds: [], outstanding: 0,
    },
  }, {
    id: discountRequestEventId,
    type: 'discount.request',
    outletId: actor.outlet_id,
    at,
    payload: { id: discountRequestId, outletId: actor.outlet_id, shiftId, saleId: discountSaleId, productId: product.id, variantId: null, requestedById: actor.id, requestDeviceId: deviceId, approvalStatus: 'pending', kind: 'percent', value: 10, quantity: 1, baseAmount: productPrice, at },
  }, {
    id: discountCancelEventId,
    type: 'discount.cancel',
    outletId: actor.outlet_id,
    at,
    payload: { id: discountRequestId, approvalStatus: 'cancelled' },
  }, {
    id: discountApprovalSaleEventId,
    type: 'sale.upsert',
    outletId: actor.outlet_id,
    at,
    payload: {
      id: discountApprovalSaleId, outletId: actor.outlet_id, shiftId, number: discountApprovalSaleNumber, status: 'Lunas', at,
      subtotal: productPrice, discount: itemDiscount, tax: 0, service: 0, total: discountedTotal,
      items: [{ productId: product.id, variantId: null, name: product.name, sku: product.sku, qty: 1, price: productPrice, cost: Number(product.cost_rupiah) || 0, discount: { kind: 'percent', value: 10 } }],
      payments: [{ id: discountApprovalPaymentId, method: 'Tunai', amount: discountedTotal, status: 'Lunas', shiftId, at }],
      refunds: [], outstanding: 0,
    },
  }, {
    id: discountApprovalRequestEventId,
    type: 'discount.request',
    outletId: actor.outlet_id,
    at,
    payload: { id: discountApprovalRequestId, outletId: actor.outlet_id, shiftId, saleId: discountApprovalSaleId, productId: product.id, variantId: null, requestedById: actor.id, requestDeviceId: deviceId, approvalStatus: 'pending', kind: 'percent', value: 10, quantity: 1, baseAmount: productPrice, at },
  });
  const allEvents = [...events, {
    id: cashApprovalEventId,
    type: 'cash.approval',
    outletId: actor.outlet_id,
    at,
    payload: { id: cashMovementId, approvalStatus: 'approved' },
  }, {
    id: discountApprovalEventId,
    type: 'discount.approval',
    outletId: actor.outlet_id,
    at,
    payload: { id: discountApprovalRequestId, approvalStatus: 'approved' },
  }];
  const approvalEvents = allEvents.slice(events.length);
  let rolledBack = false;
  let began = false;
  let commits = 0;
  heldClient = await pool.connect();
  const handlerPool = {
    query: (...args) => pool.query(...args),
    async connect() { return handlerClient; },
  };
  const handlerClient = {
    async query(sql, params) {
      const command = String(sql).trim();
      if (command === 'BEGIN') {
        if (began) return { rows: [], rowCount: null };
        began = true;
        transactionClosed = false;
      }
      if (command === 'COMMIT') {
        commits++;
        if (commits < 3) return { rows: [], rowCount: null };
        rolledBack = true;
        transactionClosed = true;
        return heldClient.query('ROLLBACK');
      }
      if (command === 'ROLLBACK') transactionClosed = true;
      return heldClient.query(sql, params);
    },
    release() {},
  };
  const handler = createSyncHandler({
    pool: handlerPool,
    activeSession: async req => req.smokeActor,
    json: (_res, status, body) => ({ status, body }),
    readJson: async req => req.smokeBody,
    requireSameOrigin: () => {},
    isUuid: value => typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    createHash,
  });

  const response = await handler({ method: 'POST', headers: {}, smokeActor: actor, smokeBody: { deviceId, cursor: 0, events } }, {}, new URL('http://localhost/api/sync'));
  const approvalResponse = await handler({ method: 'POST', headers: {}, smokeActor: ownerActor, smokeBody: { deviceId, cursor: 0, events: approvalEvents } }, {}, new URL('http://localhost/api/sync'));
  const applied = await heldClient.query(
    `SELECT
       (SELECT count(*) FROM cash_movements WHERE id=$1 AND approval_status='approved')::int AS cash_approved,
       (SELECT count(*) FROM sync_events WHERE event_id=$2 AND event_type='discount.request' AND payload->>'approvalStatus'='cancelled')::int AS discount_cancelled,
       (SELECT count(*) FROM sync_events WHERE event_id=$3 AND event_type='discount.request' AND payload->>'approvalStatus'='approved')::int AS discount_approved,
       (SELECT count(*) FROM receivable_payments WHERE id=$4)::int AS receivable_saved,
       (SELECT count(*) FROM sales WHERE id=ANY($5::uuid[]))::int AS sales_saved,
       (SELECT quantity::text FROM stock_balances WHERE outlet_id=$6 AND product_id=$7 AND variant_id IS NULL) AS stock_after`,
    [cashMovementId, discountRequestEventId, discountApprovalRequestEventId, receivableSourcePaymentId, [saleId, receivableSaleId, discountSaleId, discountApprovalSaleId], actor.outlet_id, product.id],
  );
  const effects = applied.rows[0];
  const syncedStock = response.body.stockBalances?.find(balance =>
    balance.productId === product.id && !balance.variantId);
  if (effects.cash_approved !== 1 || effects.discount_cancelled !== 1 || effects.discount_approved !== 1
      || effects.receivable_saved !== 1 || effects.sales_saved !== 4
      || Number(effects.stock_after) !== Number(product.quantity) - 1
      || Number(syncedStock?.quantity) !== Number(product.quantity) - 1) {
    throw new Error(`Smoke test tidak menerapkan efek transaksi yang diharapkan: ${JSON.stringify(effects)}`);
  }
  const rollbackResponse = await handler({ method: 'POST', headers: {}, smokeActor: ownerActor, smokeBody: { deviceId, cursor: 0, events: [] } }, {}, new URL('http://localhost/api/sync'));
  const residue = await pool.query(
    `SELECT
       (SELECT count(*) FROM sync_events WHERE device_id=$1 AND event_id=ANY($2::uuid[]))::int AS events,
       (SELECT count(*) FROM audit_log WHERE id=$3)::int AS audits,
       (SELECT count(*) FROM sync_devices WHERE outlet_id=$4 AND device_id=$1)::int AS devices,
       (SELECT count(*) FROM attendance WHERE id=$5)::int AS attendance,
       (SELECT count(*) FROM sales WHERE id=$6)::int AS sales,
       (SELECT count(*) FROM sales WHERE id=$12)::int AS receivable_sales,
       (SELECT count(*) FROM sale_items WHERE sale_id IN ($6,$12))::int AS sale_items,
       (SELECT count(*) FROM payments WHERE id=$7)::int AS payments,
       (SELECT count(*) FROM payments WHERE id=$13)::int AS receivable_source_payments,
       (SELECT count(*) FROM receivable_payments WHERE id=$13)::int AS receivable_payments,
       (SELECT count(*) FROM stock_movements WHERE id=$8)::int AS stock_movements,
       (SELECT count(*) FROM stock_balances WHERE outlet_id=$4 AND product_id=$9 AND variant_id IS NULL AND quantity=$10::numeric)::int AS stock_balance_unchanged,
       (SELECT count(*) FROM cash_movements WHERE id=$11)::int AS cash_movements,
       (SELECT count(*) FROM shifts WHERE id=$14)::int AS test_shifts,
       (SELECT count(*) FROM sales WHERE id=ANY($15::uuid[]))::int AS discount_sales,
       (SELECT count(*) FROM payments WHERE id=ANY($16::uuid[]))::int AS discount_payments,
       (SELECT count(*) FROM sync_events WHERE event_id=ANY($17::uuid[]) AND event_type='discount.request' AND payload->>'id'=ANY($18::text[]))::int AS discount_requests`,
    [deviceId, allEvents.map(event => event.id), auditId, actor.outlet_id, attendanceId, saleId, paymentId, stockEventId, product.id, product.quantity, cashMovementId, receivableSaleId, receivableSourcePaymentId, createShift ? shiftId : null, [discountSaleId, discountApprovalSaleId], [discountPaymentId, discountApprovalPaymentId], [discountRequestEventId, discountApprovalRequestEventId], [discountRequestId, discountApprovalRequestId]],
  );
  const counts = residue.rows[0];
  const retention = await pool.query('SELECT minimum_cursor FROM sync_event_retention WHERE outlet_id=$1', [actor.outlet_id]);
  const minimumCursor = Number(retention.rows[0]?.minimum_cursor || 0);
  const pullHandler = createSyncHandler({
    pool,
    activeSession: async () => actor,
    json: (_res, status, body) => ({ status, body }),
    readJson: async () => ({}),
    requireSameOrigin: () => {},
    isUuid: value => typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    createHash,
  });
  const pullResponse = await pullHandler({ method: 'GET', headers: {} }, {}, new URL(`http://localhost/api/sync?after=${minimumCursor}`));
  if (response?.status !== 200 || response.body?.accepted?.length !== events.length
      || !events.every(event => response.body.accepted.includes(event.id))
      || approvalResponse?.status !== 200 || approvalResponse.body?.accepted?.length !== approvalEvents.length
      || !approvalEvents.every(event => approvalResponse.body.accepted.includes(event.id))
      || rollbackResponse?.status !== 200 || rollbackResponse.body?.accepted?.length !== 0
      || pullResponse?.status !== 200 || !Array.isArray(pullResponse.body?.events)
      || !Number.isSafeInteger(pullResponse.body?.cursor) || pullResponse.body.cursor < minimumCursor
      || !rolledBack || counts.events || counts.audits || counts.devices || counts.attendance
      || counts.sales || counts.receivable_sales || counts.sale_items || counts.payments
      || counts.receivable_source_payments || counts.receivable_payments || counts.stock_movements
      || counts.stock_balance_unchanged !== 1 || counts.cash_movements || counts.test_shifts
      || counts.discount_sales || counts.discount_requests) {
    throw new Error(`Smoke test gagal: status=${response?.status ?? 'none'}, rollback=${rolledBack}, residu=${JSON.stringify(counts)}`);
  }
  console.log('Database transaction smoke: cashier and owner shift/cash/discount approvals, audit, attendance, sale retry, payment, receivable, discount cancel, and stock events accepted; all test rows rolled back and the original stock balance verified unchanged.');
} finally {
  if (heldClient) {
    if (!transactionClosed) await heldClient.query('ROLLBACK').catch(() => {});
    heldClient.release();
  }
  await pool.end();
}
