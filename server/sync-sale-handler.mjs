import {
  validateSalePayload,
  cashierDiscountViolation,
  lineDiscountRupiah,
} from '../shared/sale-policy.mjs';
import { timestampMs } from './timestamp-utils.mjs';

function stockMovementId(createHash, saleId, index) {
  return createHash('sha256')
    .update(`sale-stock:${saleId}:${index}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

// Mengurangi stok secara atomik untuk transaksi baru (T3). Berjalan di dalam
// transaksi sinkronisasi yang sama dengan penyimpanan transaksi, dengan baris
// stock_balances dikunci FOR UPDATE. Transaksi offline yang melampaui stok tetap
// diterima dan saldo negatif dipertahankan agar konflik terlihat. Pergerakan
// dicatat dengan alasan yang sama seperti stock.delta klien
// (`Penjualan <nomor>`) agar event stock.delta yang datang belakangan dikenali
// sebagai sudah diterapkan dan tidak mengurangi stok dua kali.
async function decrementStockForSale({ client, sale, scope, actor, productById, createHash }) {
  const movements = [];
  let stockConflict = false;
  for (const [index, item] of sale.items.entries()) {
    const variantId = item.variantId || null;
    await client.query(
      `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
       VALUES($1,$2,$3,0) ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING`,
      [scope, item.productId, variantId],
    );
    const current = await client.query(
      `SELECT quantity FROM stock_balances
       WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
      [scope, item.productId, variantId],
    );
    const available = Number(current.rows[0]?.quantity || 0);
    const nextQuantity = available - item.qty;
    if (nextQuantity < -0.0000001) stockConflict = true;
    await client.query(
      `UPDATE stock_balances SET quantity=$4,updated_at=now()
       WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3`,
      [scope, item.productId, variantId, nextQuantity],
    );
    movements.push({
      id: stockMovementId(createHash, sale.id, index),
      productId: item.productId,
      variantId,
      delta: -item.qty,
    });
    if (variantId) {
      await client.query(
        `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
         VALUES($1,$2,NULL,0) ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING`,
        [scope, item.productId],
      );
      await client.query(
        `UPDATE stock_balances SET quantity=(
           SELECT COALESCE(sum(balance.quantity),0) FROM stock_balances balance
           JOIN product_variants variant ON variant.id=balance.variant_id
           WHERE balance.outlet_id=$1 AND balance.product_id=$2
             AND COALESCE((variant.metadata->>'retired')::boolean,FALSE)=FALSE
         ),updated_at=now()
         WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NULL`,
        [scope, item.productId],
      );
    }
  }
  for (const movement of movements) {
    await client.query(
      `INSERT INTO stock_movements(id,outlet_id,product_id,variant_id,delta,reason,occurred_at,user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [
        movement.id,
        scope,
        movement.productId,
        movement.variantId,
        movement.delta,
        `Penjualan ${sale.number}`,
        sale.at,
        actor.id,
      ],
    );
  }
  return stockConflict;
}

export async function applySaleEvent({
  client,
  event,
  scope,
  actor,
  deviceId,
  isUuid,
  createHash,
}) {
  const s = event.payload;
  validateSalePayload(s);
  const productIds = [...new Set(s.items.map((item) => item.productId))];
  const products = await client.query(
    'SELECT id,sku,name,price_rupiah,cost_rupiah,updated_at FROM products WHERE id=ANY($1::uuid[]) AND outlet_id=$2 AND deleted_at IS NULL',
    [productIds, scope],
  );
  const productById = new Map(products.rows.map((product) => [product.id, product]));
  if (productById.size !== productIds.length)
    throw Object.assign(new Error('Produk transaksi tidak ditemukan di outlet akun.'), {
      status: 409,
    });
  const variantIds = [...new Set(s.items.map((item) => item.variantId).filter(Boolean))];
  const variants = variantIds.length
    ? await client.query(
        'SELECT v.id,v.product_id,v.name,v.price_rupiah,v.cost_rupiah FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=ANY($1::uuid[]) AND p.outlet_id=$2 AND p.deleted_at IS NULL',
        [variantIds, scope],
      )
    : { rows: [] };
  const variantById = new Map(variants.rows.map((variant) => [variant.id, variant]));
  const priceHistory = await client.query(
    `SELECT DISTINCT ON (payload->>'id') payload
     FROM sync_events WHERE outlet_id=$1 AND event_type='product.upsert'
       AND payload->>'id'=ANY($2::text[]) AND occurred_at<=$3
     ORDER BY payload->>'id',occurred_at DESC,server_cursor DESC`,
    [scope, productIds, s.at],
  );
  const historicalProductById = new Map(
    priceHistory.rows.map((row) => [row.payload.id, row.payload]),
  );
  for (const item of s.items) {
    const product = productById.get(item.productId);
    const variant = item.variantId ? variantById.get(item.variantId) : null;
    if (item.variantId && (!variant || variant.product_id !== item.productId))
      throw Object.assign(new Error('Varian produk transaksi tidak valid.'), { status: 400 });
    const historicalProduct = historicalProductById.get(item.productId);
    const historicalVariant = historicalProduct?.variants?.find(
      (candidate) => candidate.id === item.variantId,
    );
    const historyIsAvailable =
      Boolean(historicalProduct) || timestampMs(product.updated_at) <= timestampMs(s.at);
    const expectedPrice = Number(
      historicalVariant?.price ??
        historicalProduct?.price ??
        variant?.price_rupiah ??
        product.price_rupiah,
    );
    if (!historyIsAvailable || !Number.isSafeInteger(expectedPrice) || item.price !== expectedPrice)
      throw Object.assign(
        new Error(
          'Harga transaksi tidak cocok dengan katalog server pada waktu transaksi. Data tetap lokal untuk ditinjau.',
        ),
        { status: 409, code: 'PRICE_CHANGED' },
      );
    const productName = historicalProduct?.name || product.name;
    const variantName = historicalVariant?.name || variant?.name;
    const canonicalName = variantName ? `${productName} \u00b7 ${variantName}` : productName;
    if (typeof canonicalName !== 'string' || !canonicalName.trim() || canonicalName.length > 204) {
      throw Object.assign(new Error('Nama produk historis tidak valid untuk transaksi.'), {
        status: 409,
      });
    }
    item.name = canonicalName;
    item.sku = item.sku || product.sku;
    item.cost = Number(
      historicalVariant?.cost ??
        historicalProduct?.cost ??
        variant?.cost_rupiah ??
        product.cost_rupiah,
    );
  }
  const existingSale = await client.query(
    'SELECT status,metadata,cashier_name,subtotal_rupiah,discount_rupiah,tax_rupiah,service_rupiah,total_rupiah FROM sales WHERE id=$1 AND outlet_id=$2 FOR UPDATE',
    [s.id, scope],
  );
  if (
    existingSale.rowCount &&
    (Number(existingSale.rows[0].subtotal_rupiah) !== s.subtotal ||
      Number(existingSale.rows[0].discount_rupiah) !== s.discount ||
      Number(existingSale.rows[0].tax_rupiah) !== s.tax ||
      Number(existingSale.rows[0].service_rupiah) !== s.service ||
      Number(existingSale.rows[0].total_rupiah) !== s.total)
  )
    throw Object.assign(new Error('Nilai transaksi yang sudah tersimpan tidak dapat diubah.'), {
      status: 409,
    });
  // T2: transaksi baru dari Kasir yang melampaui kewenangan diskon wajib
  // tercatat sebagai permintaan persetujuan; transaksi yang sudah tersimpan
  // (replay idempotent) tidak diperiksa ulang.
  if (!existingSale.rowCount && actor.role === 'Kasir' && ['Lunas', 'Piutang'].includes(s.status)) {
    const violation = cashierDiscountViolation(s);
    if (violation) throw Object.assign(new Error(violation), { status: 403 });
  }
  // T3: kurangi stok secara atomik untuk transaksi baru yang lunas/piutang,
  // sebelum baris transaksi ditulis. Transaksi Void/Dikembalikan tidak
  // mengurangi stok di sini (pengembalian stok void ditangani lewat
  // stock.delta `Void <nomor>` dari klien).
  let stockConflict = !!existingSale.rows[0]?.metadata?.stock_conflict;
  if (!existingSale.rowCount && ['Lunas', 'Piutang'].includes(s.status))
    stockConflict = await decrementStockForSale({
      client,
      sale: s,
      scope,
      actor,
      productById,
      createHash,
    });
  s.cashier = existingSale.rows[0]?.cashier_name || actor.name;
  let newPayments = s.payments;
  if (existingSale.rowCount) {
    const existingItems = await client.query(
      'SELECT product_id,variant_id,quantity,unit_price_rupiah,discount_rupiah FROM sale_items WHERE sale_id=$1',
      [s.id],
    );
    const signatureCounts = new Map();
    const addSignature = (signature) =>
      signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
    const saleItemSignature = (item) => {
      const amount = item.price * item.qty;
      const discount =
        item.discount?.kind === 'percent'
          ? Math.round((amount * item.discount.value) / 100)
          : Math.min(amount, Math.round(item.discount?.value || 0));
      return JSON.stringify([
        item.productId,
        item.variantId || null,
        Number(item.qty),
        item.price,
        discount,
      ]);
    };
    for (const item of existingItems.rows)
      addSignature(
        JSON.stringify([
          item.product_id,
          item.variant_id,
          Number(item.quantity),
          Number(item.unit_price_rupiah),
          Number(item.discount_rupiah),
        ]),
      );
    for (const item of s.items) {
      const signature = saleItemSignature(item),
        count = signatureCounts.get(signature) || 0;
      if (!count)
        throw Object.assign(new Error('Item transaksi yang sudah tersimpan tidak dapat diubah.'), {
          status: 409,
        });
      signatureCounts.set(signature, count - 1);
    }
    if ([...signatureCounts.values()].some((count) => count !== 0))
      throw Object.assign(new Error('Item transaksi yang sudah tersimpan tidak dapat dihapus.'), {
        status: 409,
      });

    const existingPayments = await client.query(
      'SELECT method,amount_rupiah,reference,occurred_at FROM payments WHERE sale_id=$1',
      [s.id],
    );
    const paymentSignature = (payment) =>
      JSON.stringify([
        payment.method,
        Number(payment.amount),
        payment.reference || null,
        timestampMs(payment.at || s.at),
      ]);
    const paymentCounts = new Map();
    const addPaymentSignature = (signature) =>
      paymentCounts.set(signature, (paymentCounts.get(signature) || 0) + 1);
    for (const payment of existingPayments.rows)
      addPaymentSignature(
        JSON.stringify([
          payment.method,
          Number(payment.amount_rupiah),
          payment.reference,
          timestampMs(payment.occurred_at),
        ]),
      );
    const unmatched = [];
    for (const payment of s.payments) {
      const signature = paymentSignature(payment),
        count = paymentCounts.get(signature) || 0;
      if (count) paymentCounts.set(signature, count - 1);
      else unmatched.push(payment);
    }
    if ([...paymentCounts.values()].some((count) => count !== 0))
      throw Object.assign(
        new Error('Pembayaran transaksi yang sudah tersimpan tidak dapat diubah atau dihapus.'),
        { status: 409 },
      );
    if (unmatched.some((payment) => !isUuid(payment.id)))
      throw Object.assign(new Error('Pembayaran baru harus memiliki ID unik.'), { status: 400 });
    newPayments = unmatched;
  }
  const paymentIds = newPayments.map((payment) => payment.id).filter(isUuid);
  if (new Set(paymentIds).size !== paymentIds.length)
    throw Object.assign(new Error('ID pembayaran dalam transaksi harus unik.'), { status: 400 });
  if (paymentIds.length) {
    const conflictingPayment = await client.query(
      'SELECT id FROM payments WHERE id=ANY($1::uuid[]) AND sale_id<>$2 LIMIT 1',
      [paymentIds, s.id],
    );
    if (conflictingPayment.rowCount)
      throw Object.assign(new Error('ID pembayaran sudah dipakai transaksi lain.'), {
        status: 409,
        code: 'PAYMENT_ID_CONFLICT',
      });
  }
  if (existingSale.rowCount && ['Dikembalikan', 'Void'].includes(existingSale.rows[0].status)) {
    s.status = existingSale.rows[0].status;
    s.voidReason = existingSale.rows[0].metadata?.voidReason || s.voidReason || null;
    s.voidAt = existingSale.rows[0].metadata?.voidAt || s.voidAt || null;
    s.outstanding = Number(existingSale.rows[0].metadata?.outstanding || 0);
    if (s.status === 'Dikembalikan') {
      const existingRefund = await client.query(
        'SELECT id,amount_rupiah,cancelled_outstanding_rupiah,method,reference,reason,approved_by,occurred_at FROM sale_refunds WHERE sale_id=$1',
        [s.id],
      );
      s.refunds = existingRefund.rows.map((refund) => ({
        ...refund,
        amount: Number(refund.amount_rupiah),
        cancelledOutstanding: Number(refund.cancelled_outstanding_rupiah),
        approvedByName: refund.approved_by,
        at: refund.occurred_at,
      }));
      s.refundedAmount = s.refunds[0]?.amount ?? 0;
    }
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [
      s,
      deviceId,
      event.id,
    ]);
  }
  const refunds = s.refunds || [];
  if (!Array.isArray(refunds) || refunds.length > 1)
    throw Object.assign(new Error('Data refund tidak valid.'), { status: 400 });
  for (const refund of refunds) {
    if (
      !refund ||
      typeof refund !== 'object' ||
      Array.isArray(refund) ||
      !isUuid(refund.id) ||
      !Number.isFinite(Date.parse(refund.at)) ||
      Date.parse(refund.at) > Date.now() + 5 * 60_000 ||
      !Number.isSafeInteger(refund.amount) ||
      refund.amount < 0 ||
      !Number.isSafeInteger(refund.cancelledOutstanding || 0) ||
      (refund.cancelledOutstanding || 0) < 0 ||
      !refund.method ||
      typeof refund.method !== 'string' ||
      refund.method.length > 40 ||
      (refund.reference != null &&
        (typeof refund.reference !== 'string' || refund.reference.length > 120)) ||
      typeof refund.reason !== 'string' ||
      !refund.reason.trim() ||
      refund.reason.length > 500 ||
      typeof refund.approvedByName !== 'string' ||
      !refund.approvedByName.trim() ||
      refund.approvedByName.length > 80
    ) {
      throw Object.assign(
        new Error('Refund perlu jumlah, metode, alasan, persetujuan, dan waktu yang valid.'),
        { status: 400 },
      );
    }
  }
  const refundIds = refunds.map((refund) => refund.id);
  if (new Set(refundIds).size !== refundIds.length)
    throw Object.assign(new Error('ID refund dalam transaksi harus unik.'), { status: 400 });
  if (refundIds.length) {
    const conflictingRefund = await client.query(
      'SELECT id FROM sale_refunds WHERE id=ANY($1::uuid[]) AND sale_id<>$2 LIMIT 1',
      [refundIds, s.id],
    );
    if (conflictingRefund.rowCount)
      throw Object.assign(new Error('ID refund sudah dipakai transaksi lain.'), {
        status: 409,
        code: 'REFUND_ID_CONFLICT',
      });
  }
  if (
    s.status === 'Dikembalikan' &&
    (refunds.length !== 1 ||
      !Number.isSafeInteger(s.refundedAmount) ||
      refunds[0].amount !== s.refundedAmount ||
      refunds[0].amount + (refunds[0].cancelledOutstanding || 0) !== Math.round(Number(s.total)))
  ) {
    throw Object.assign(new Error('Nilai refund dan pembatalan piutang tidak valid.'), {
      status: 400,
    });
  }
  await client.query(
    `INSERT INTO sales(id,outlet_id,shift_id,customer_id,cashier_name,sale_number,status,subtotal_rupiah,discount_rupiah,tax_rupiah,service_rupiah,total_rupiah,occurred_at,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT(id) DO UPDATE SET status=CASE WHEN sales.status IN ('Dikembalikan','Void') THEN sales.status ELSE EXCLUDED.status END,
     discount_rupiah=EXCLUDED.discount_rupiah,tax_rupiah=EXCLUDED.tax_rupiah,
     service_rupiah=EXCLUDED.service_rupiah,total_rupiah=EXCLUDED.total_rupiah,metadata=EXCLUDED.metadata`,
    [
      s.id,
      s.outletId || event.outletId,
      s.shiftId || null,
      s.customerId || null,
      s.cashier,
      s.number,
      s.status,
      Math.round(s.subtotal),
      Math.round(s.discount),
      Math.round(s.tax),
      Math.round(s.service || 0),
      Math.round(s.total),
      s.at,
      {
        table: s.table || null,
        outstanding: s.outstanding || 0,
        voidReason: s.voidReason || null,
        voidAt: s.voidAt || null,
        cashier: s.cashier,
        stock_conflict: stockConflict,
      },
    ],
  );
  if (!existingSale.rowCount) {
    const saleItemRows = s.items.map((item) => ({
      product_id: item.productId,
      variant_id: item.variantId || null,
      product_name: item.name,
      sku: item.sku || item.productId,
      quantity: item.qty,
      unit_price_rupiah: Math.round(item.price),
      unit_cost_rupiah: Math.round(item.cost || 0),
      discount_rupiah: lineDiscountRupiah(item),
      note: item.note || null,
    }));
    const savedItems = await client.query(
      `INSERT INTO sale_items(id,sale_id,product_id,variant_id,product_name,sku,quantity,unit_price_rupiah,unit_cost_rupiah,discount_rupiah,note)
       SELECT gen_random_uuid(),$1,incoming.product_id,incoming.variant_id,incoming.product_name,incoming.sku,incoming.quantity,
         incoming.unit_price_rupiah,incoming.unit_cost_rupiah,incoming.discount_rupiah,incoming.note
       FROM jsonb_to_recordset($2::jsonb) AS incoming(product_id uuid,variant_id uuid,product_name text,sku text,quantity numeric,
         unit_price_rupiah bigint,unit_cost_rupiah bigint,discount_rupiah bigint,note text)
       WHERE true`,
      [s.id, JSON.stringify(saleItemRows)],
    );
    if (savedItems.rowCount !== saleItemRows.length)
      throw Object.assign(new Error('Item transaksi tidak lengkap saat disimpan.'), {
        status: 409,
      });
  }
  if (newPayments.length) {
    const paymentRows = newPayments.map((payment, index) => ({
      id:
        payment.id ||
        createHash('sha256')
          .update(`${s.id}:payment:${index}`)
          .digest('hex')
          .slice(0, 32)
          .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
      sale_id: s.id,
      method: payment.method,
      status: payment.status || (s.status === 'Dikembalikan' ? 'Lunas' : s.status),
      amount_rupiah: Math.round(payment.amount),
      reference: payment.reference || null,
      occurred_at: payment.at || s.at,
      metadata: {
        received: payment.received ?? null,
        change: payment.change ?? null,
        shiftId: payment.shiftId || null,
      },
    }));
    const savedPayments = await client.query(
      `INSERT INTO payments(id,sale_id,method,status,amount_rupiah,reference,occurred_at,metadata)
       SELECT incoming.id,incoming.sale_id,incoming.method,incoming.status,incoming.amount_rupiah,incoming.reference,incoming.occurred_at,incoming.metadata
       FROM jsonb_to_recordset($1::jsonb) AS incoming(id uuid,sale_id uuid,method text,status text,amount_rupiah bigint,reference text,occurred_at timestamptz,metadata jsonb)
       WHERE true
       ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,amount_rupiah=EXCLUDED.amount_rupiah,
       reference=EXCLUDED.reference,metadata=EXCLUDED.metadata
       WHERE payments.sale_id=EXCLUDED.sale_id AND payments.method=EXCLUDED.method
         AND payments.amount_rupiah=EXCLUDED.amount_rupiah AND payments.reference IS NOT DISTINCT FROM EXCLUDED.reference
         AND payments.occurred_at=EXCLUDED.occurred_at RETURNING sale_id`,
      [JSON.stringify(paymentRows)],
    );
    if (savedPayments.rowCount !== paymentRows.length)
      throw Object.assign(new Error('ID pembayaran sudah dipakai transaksi lain.'), {
        status: 409,
        code: 'PAYMENT_ID_CONFLICT',
      });
  }
  for (const refund of s.refunds || []) {
    const savedRefund = await client.query(
      `INSERT INTO sale_refunds(id,sale_id,amount_rupiah,cancelled_outstanding_rupiah,method,reference,reason,approved_by,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING sale_id`,
      [
        refund.id,
        s.id,
        Math.round(refund.amount),
        Math.round(refund.cancelledOutstanding || 0),
        refund.method,
        refund.reference || null,
        refund.reason,
        refund.approvedByName || 'Manajer/Pemilik',
        refund.at,
      ],
    );
    if (!savedRefund.rowCount) {
      const existingRefund = await client.query(
        'SELECT sale_id FROM sale_refunds WHERE id=$1 OR sale_id=$2 LIMIT 1',
        [refund.id, s.id],
      );
      if (existingRefund.rowCount && existingRefund.rows[0].sale_id !== s.id)
        throw Object.assign(new Error('ID refund sudah dipakai transaksi lain.'), {
          status: 409,
          code: 'REFUND_ID_CONFLICT',
        });
    }
  }
  await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [
    s,
    deviceId,
    event.id,
  ]);
  if (s.shiftId && s.cashier) {
    const shift = await client.query(
      'SELECT metadata FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE',
      [s.shiftId, scope],
    );
    if (shift.rowCount) {
      const metadata = shift.rows[0].metadata || {};
      metadata.cashiers = [...new Set([...(metadata.cashiers || []), s.cashier])];
      await client.query('UPDATE shifts SET metadata=$2 WHERE id=$1', [s.shiftId, metadata]);
    }
  }
  const stockBalances = stockConflict
    ? await client.query(
        `SELECT product_id,variant_id,quantity::text AS quantity FROM stock_balances
         WHERE outlet_id=$1 AND product_id=ANY($2::uuid[])`,
        [scope, productIds],
      )
    : { rows: [] };
  return {
    saleId: s.id,
    stockConflict,
    stockBalances: stockBalances.rows.map((balance) => ({
      outletId: scope,
      productId: balance.product_id,
      variantId: balance.variant_id,
      quantity: Number(balance.quantity),
    })),
  };
}
