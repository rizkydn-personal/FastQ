import { timestampMs } from './timestamp-utils.mjs';

export async function applyReceivableEvent({ client, event, scope, actor, deviceId, isUuid }) {
  const p = event.payload;
  if (
    !isUuid(p.id) ||
    !isUuid(p.saleId) ||
    (p.customerId != null && !isUuid(p.customerId)) ||
    (p.shiftId != null && !isUuid(p.shiftId)) ||
    typeof p.method !== 'string' ||
    !p.method.trim() ||
    p.method.length > 40 ||
    !Number.isSafeInteger(p.amount) ||
    p.amount <= 0 ||
    typeof p.at !== 'string' ||
    p.at.length > 40 ||
    !Number.isFinite(Date.parse(p.at)) ||
    Date.parse(p.at) > Date.now() + 5 * 60_000
  ) {
    throw Object.assign(new Error('Data pembayaran piutang tidak valid.'), { status: 400 });
  }
  const sourcePayment = await client.query(
    `SELECT payment.sale_id,payment.method,payment.status,payment.amount_rupiah,payment.occurred_at,payment.metadata,s.customer_id
           FROM payments payment JOIN sales s ON s.id=payment.sale_id
           WHERE payment.id=$1 AND s.outlet_id=$2 FOR UPDATE OF payment,s`,
    [p.id, scope],
  );
  if (!sourcePayment.rowCount)
    throw Object.assign(
      new Error('Pembayaran piutang harus berasal dari pembayaran transaksi di toko aktif.'),
      { status: 409 },
    );
  const source = sourcePayment.rows[0];
  if (
    source.sale_id !== p.saleId ||
    source.method !== p.method ||
    source.status !== 'Lunas' ||
    Number(source.amount_rupiah) !== p.amount ||
    timestampMs(source.occurred_at) !== timestampMs(p.at) ||
    (source.customer_id || null) !== (p.customerId || null) ||
    (source.metadata?.shiftId || null) !== (p.shiftId || null)
  ) {
    throw Object.assign(
      new Error('Pembayaran piutang tidak cocok dengan transaksi dan pembayaran yang tersimpan.'),
      { status: 409 },
    );
  }
  if (p.shiftId) {
    const paymentShift = await client.query(
      'SELECT closed_at FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE',
      [p.shiftId, scope],
    );
    if (!paymentShift.rowCount)
      throw Object.assign(new Error('Shift penerima pembayaran tidak ditemukan di toko aktif.'), {
        status: 409,
      });
    if (paymentShift.rows[0].closed_at)
      throw Object.assign(new Error('Shift penerima pembayaran sudah ditutup.'), { status: 409 });
  }
  const savedReceivable = await client.query(
    `INSERT INTO receivable_payments(id,sale_id,customer_id,shift_id,method,amount_rupiah,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [p.id, p.saleId, p.customerId || null, p.shiftId || null, p.method, Math.round(p.amount), p.at],
  );
  if (!savedReceivable.rowCount) {
    const existingReceivable = await client.query(
      `SELECT sale_id,customer_id,shift_id,method,amount_rupiah,occurred_at FROM receivable_payments WHERE id=$1 FOR UPDATE`,
      [p.id],
    );
    const saved = existingReceivable.rows[0];
    if (
      !saved ||
      saved.sale_id !== p.saleId ||
      (saved.customer_id || null) !== (p.customerId || null) ||
      (saved.shift_id || null) !== (p.shiftId || null) ||
      saved.method !== p.method ||
      Number(saved.amount_rupiah) !== p.amount ||
      timestampMs(saved.occurred_at) !== timestampMs(p.at)
    ) {
      throw Object.assign(new Error('ID pembayaran piutang sudah digunakan dengan data berbeda.'), {
        status: 409,
      });
    }
  }
}
