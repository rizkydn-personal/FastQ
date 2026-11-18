export async function applyDiscountEvent({ client, event, scope, actor, deviceId, isUuid }) {
  if (event.type === 'discount.request') {

  const request = event.payload;
  if (actor.role !== 'Kasir' || !isUuid(request.id) || !isUuid(request.shiftId) || !isUuid(request.saleId) || !isUuid(request.productId)
    || (request.variantId != null && !isUuid(request.variantId)) || request.requestedById !== actor.id
    || request.requestDeviceId !== deviceId || request.approvalStatus !== 'pending'
    || !['percent','amount'].includes(request.kind) || !Number.isFinite(request.value) || request.value <= 0
    || (request.kind === 'percent' && request.value > 100)
    || (request.kind === 'amount' && !Number.isSafeInteger(request.value))) {
    throw Object.assign(new Error('Permintaan diskon tidak valid.'), { status: 400 });
  }
  const shift = await client.query('SELECT closed_at FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE', [request.shiftId, scope]);
  if (!shift.rowCount) throw Object.assign(new Error('Shift permintaan diskon tidak ditemukan di toko aktif.'), { status: 404 });
  if (shift.rows[0].closed_at) throw Object.assign(new Error('Diskon tidak dapat diminta untuk shift yang sudah ditutup.'), { status: 409 });
  const sale = await client.query('SELECT shift_id,status FROM sales WHERE id=$1 AND outlet_id=$2 FOR UPDATE', [request.saleId, scope]);
  if (!sale.rowCount) throw Object.assign(new Error('Transaksi diskon belum tersinkron atau tidak ditemukan.'), { status: 409 });
  if (sale.rows[0].status !== 'Lunas' || sale.rows[0].shift_id !== request.shiftId) {
    throw Object.assign(new Error('Permintaan diskon harus terkait transaksi lunas pada shift yang sama.'), { status: 409 });
  }
  const saleItems = await client.query(
    `SELECT product_name,quantity::text AS quantity,unit_price_rupiah::text AS unit_price_rupiah,discount_rupiah::text AS discount_rupiah
     FROM sale_items WHERE sale_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid`,
    [request.saleId, request.productId, request.variantId || null],
  );
  const expectedDiscount = request.kind === 'percent'
    ? Math.round(request.baseAmount * request.value / 100)
    : Math.min(request.value, request.baseAmount);
  const matchingItem = saleItems.rows.find(item => {
    const quantity = Number(item.quantity), unitPrice = Number(item.unit_price_rupiah);
    return Number.isSafeInteger(quantity) && quantity === request.quantity
      && Number.isSafeInteger(unitPrice) && unitPrice * quantity === request.baseAmount
      && Number(item.discount_rupiah) === expectedDiscount;
  });
  if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0 || !Number.isSafeInteger(request.baseAmount)
    || request.baseAmount <= 0 || (request.kind === 'amount' && request.value > request.baseAmount) || !matchingItem) {
    throw Object.assign(new Error('Jumlah dan nilai dasar permintaan diskon tidak valid.'), { status: 400 });
  }
  const duplicate = await client.query(
    `SELECT event_id FROM sync_events
     WHERE event_type='discount.request' AND outlet_id=$1 AND payload->>'id'=$2
     ORDER BY server_cursor LIMIT 2 FOR UPDATE`,
    [scope, request.id],
  );
  if (duplicate.rowCount > 1) throw Object.assign(new Error('ID permintaan diskon sudah digunakan.'), { status: 409 });
  const canonical = {
    ...request,
    outletId: scope,
    productName: matchingItem.product_name,
    approvalStatus: 'pending',
    approvedBy: null,
    approvedAt: null,
  };
  await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [canonical, deviceId, event.id]);

  } else if (event.type === 'discount.approval' || event.type === 'discount.cancel') {

  const decision = event.payload;
  const approvalStatus = event.type === 'discount.cancel' ? 'cancelled' : decision.approvalStatus;
  if (!isUuid(decision.id) || !['approved','rejected','cancelled'].includes(approvalStatus)
    || (event.type === 'discount.approval' && approvalStatus === 'cancelled')
    || (event.type === 'discount.cancel' && approvalStatus !== 'cancelled')) {
    throw Object.assign(new Error('Keputusan persetujuan diskon tidak valid.'), { status: 400 });
  }
  const existing = await client.query(
    `SELECT event_id,device_id,payload FROM sync_events
     WHERE event_type='discount.request' AND outlet_id=$1 AND payload->>'id'=$2
     ORDER BY server_cursor DESC LIMIT 1 FOR UPDATE`,
    [scope, decision.id],
  );
  if (!existing.rowCount) throw Object.assign(new Error('Permintaan diskon tidak ditemukan.'), { status: 404 });
  const request = existing.rows[0].payload;
  if (request.approvalStatus !== 'pending') throw Object.assign(new Error('Permintaan diskon sudah diproses.'), { status: 409 });
  if (actor.role === 'Kasir' && (event.type !== 'discount.cancel'
    || request.requestedById !== actor.id || request.requestDeviceId !== deviceId)) {
    throw Object.assign(new Error('Kasir hanya dapat membatalkan permintaan diskonnya sendiri dari perangkat pengaju.'), { status: 403 });
  }
  const canonical = { ...request, approvalStatus, approvedBy: actor.name, approvedAt: new Date().toISOString() };
  await client.query('UPDATE sync_events SET payload=$1 WHERE event_type=$2 AND device_id=$3 AND event_id=$4', [canonical, 'discount.request', existing.rows[0].device_id, existing.rows[0].event_id]);
  await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [canonical, deviceId, event.id]);

  }
}
