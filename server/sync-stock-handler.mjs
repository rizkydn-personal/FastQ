export async function applyStockEvent({ client, event, scope, actor, deviceId, isUuid }) {
  if (event.type === 'stock.delta' || event.type === 'stock.reconcile') {
    const d = event.payload;
    const isReconciliation = event.type === 'stock.reconcile';
    const expectedQuantity = Number(d.expectedServerQuantity);
    const requestedQuantity = Number(d.quantity);
    const delta = isReconciliation ? requestedQuantity - expectedQuantity : Number(d.delta);
    if (
      !d.outletId ||
      !d.productId ||
      !Number.isFinite(delta) ||
      Math.abs(delta) >= 1e15 ||
      !String(d.reason || '').trim() ||
      (isReconciliation &&
        (!Number.isFinite(expectedQuantity) ||
          expectedQuantity < 0 ||
          expectedQuantity >= 1e15 ||
          !Number.isFinite(requestedQuantity) ||
          requestedQuantity < 0 ||
          requestedQuantity >= 1e15))
    ) {
      throw Object.assign(new Error('Event pergerakan stok tidak valid.'), { status: 400 });
    }
    const variantId = d.variantId || null;
    if (actor.role === 'Kasir') {
      if (isReconciliation || !isUuid(d.saleId) || delta >= 0) {
        throw Object.assign(
          new Error('Kasir hanya dapat mengurangi stok melalui item penjualan yang tercatat.'),
          { status: 403 },
        );
      }
      const sale = await client.query(
        'SELECT sale_number,status FROM sales WHERE id=$1 AND outlet_id=$2 FOR UPDATE',
        [d.saleId, scope],
      );
      if (
        !sale.rowCount ||
        !['Lunas', 'Piutang'].includes(sale.rows[0].status) ||
        d.reason !== `Penjualan ${sale.rows[0].sale_number}`
      ) {
        throw Object.assign(
          new Error('Pengurangan stok Kasir harus terkait dengan transaksi lunas yang sama.'),
          { status: 409 },
        );
      }
      const matchingItems = await client.query(
        `SELECT count(*)::int AS count FROM sale_items
               WHERE sale_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid AND quantity=$4::numeric`,
        [d.saleId, d.productId, variantId, Math.abs(delta)],
      );
      const priorMovements = await client.query(
        `SELECT count(*)::int AS count FROM stock_movements
               WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid
                 AND delta=$4::numeric AND reason=$5`,
        [d.outletId, d.productId, variantId, delta, d.reason],
      );
      const matching = Number(matchingItems.rows[0].count);
      const prior = Number(priorMovements.rows[0].count);
      if (matching <= 0) {
        throw Object.assign(
          new Error('Item penjualan ini tidak cocok dengan jumlah pengurangan stok.'),
          { status: 409 },
        );
      }
      if (prior >= matching) {
        // Pengurangan sudah diterapkan server saat sale.upsert diterima (T3)
        // atau oleh event sebelumnya; terima event ini tanpa mengurangi stok
        // dua kali (idempotent).
        return;
      }
    }
    if (
      actor.role !== 'Kasir' &&
      !isReconciliation &&
      delta < 0 &&
      typeof d.reason === 'string' &&
      d.reason.startsWith('Penjualan ')
    ) {
      // Peran selain Kasir juga menerima stock.delta klien untuk transaksi
      // yang sama; kenali pengurangan yang sudah diterapkan server (T3)
      // lewat nomor transaksi di alasan agar stok tidak berkurang dua kali.
      const saleNumber = d.reason.slice('Penjualan '.length);
      const sale = await client.query(
        `SELECT id FROM sales WHERE outlet_id=$1 AND sale_number=$2 AND status IN ('Lunas','Piutang')`,
        [scope, saleNumber],
      );
      if (sale.rowCount) {
        const matchingItems = await client.query(
          `SELECT count(*)::int AS count FROM sale_items
                 WHERE sale_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid AND quantity=$4::numeric`,
          [sale.rows[0].id, d.productId, variantId, Math.abs(delta)],
        );
        const priorMovements = await client.query(
          `SELECT count(*)::int AS count FROM stock_movements
                 WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid
                   AND delta=$4::numeric AND reason=$5`,
          [d.outletId, d.productId, variantId, delta, d.reason],
        );
        const matching = Number(matchingItems.rows[0].count);
        if (matching > 0 && Number(priorMovements.rows[0].count) >= matching) return;
      }
    }
    await client.query(
      `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
           VALUES($1,$2,$3,0) ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING`,
      [d.outletId, d.productId, variantId],
    );
    const current = await client.query(
      `SELECT quantity FROM stock_balances
           WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
      [d.outletId, d.productId, variantId],
    );
    const serverQuantity = Number(current.rows[0]?.quantity || 0);
    const nextQuantity = isReconciliation ? requestedQuantity : serverQuantity + delta;
    const reconciliationStale =
      isReconciliation && Math.abs(serverQuantity - expectedQuantity) > 0.0001;
    if (reconciliationStale || nextQuantity < -0.0000001) {
      throw Object.assign(
        new Error(
          reconciliationStale
            ? 'Stok server berubah sejak konflik ditampilkan; hitung ulang stok fisik sebelum menerapkan rekonsiliasi.'
            : 'Delta akan membuat stok server menjadi negatif.',
        ),
        {
          status: 409,
          conflict: {
            type: 'stock',
            eventId: event.id,
            productId: d.productId,
            variantId,
            outletId: d.outletId,
            delta: isReconciliation ? requestedQuantity - serverQuantity : delta,
            serverQuantity,
          },
        },
      );
    }
    if (nextQuantity >= 1e15)
      throw Object.assign(new Error('Jumlah stok melebihi batas penyimpanan.'), { status: 400 });
    await client.query(
      `UPDATE stock_balances SET quantity=$4,updated_at=now()
           WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3`,
      [d.outletId, d.productId, variantId, Math.max(0, nextQuantity)],
    );
    if (variantId) {
      await client.query(
        `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
             VALUES($1,$2,NULL,0) ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING`,
        [d.outletId, d.productId],
      );
      await client.query(
        `UPDATE stock_balances SET quantity=(
               SELECT COALESCE(sum(balance.quantity),0) FROM stock_balances balance
               JOIN product_variants variant ON variant.id=balance.variant_id
               WHERE balance.outlet_id=$1 AND balance.product_id=$2
                 AND COALESCE((variant.metadata->>'retired')::boolean,FALSE)=FALSE
             ),updated_at=now()
             WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NULL`,
        [d.outletId, d.productId],
      );
    }
    const insertedMovement = await client.query(
      `INSERT INTO stock_movements(id,outlet_id,product_id,variant_id,delta,reason,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [
        event.id,
        d.outletId,
        d.productId,
        variantId,
        delta,
        d.reason,
        event.at || new Date().toISOString(),
      ],
    );
    if (!insertedMovement.rowCount)
      throw Object.assign(new Error('ID pergerakan stok sudah digunakan.'), { status: 409 });
  }
}
