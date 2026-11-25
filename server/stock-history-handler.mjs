const movementKinds = new Set(['Penjualan', 'Penyesuaian', 'Impor', 'Transfer', 'Refund', 'Semua']);

export function createStockHistoryHandler({ pool, activeSession, json, isUuid }) {
  return async function stockHistory(req, res, url) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method tidak didukung.' });
    const actor = await activeSession(req);
    if (!['Pemilik', 'Admin', 'Manajer'].includes(actor.role))
      return json(res, 403, { error: 'Peran akun ini tidak dapat melihat riwayat stok.' });

    const rawLimit = url.searchParams.get('limit') || '10';
    if (!/^\d{1,3}$/.test(rawLimit)) return json(res, 400, { error: 'Batas halaman tidak valid.' });
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 10)
      return json(res, 400, { error: 'Batas halaman harus antara 1 dan 10.' });
    const productId = url.searchParams.get('productId');
    if (productId && !isUuid(productId)) return json(res, 400, { error: 'ID produk tidak valid.' });
    const before = url.searchParams.get('before');
    const beforeId = url.searchParams.get('beforeId');
    if (
      (before == null) !== (beforeId == null) ||
      (before != null && (!Number.isFinite(Date.parse(before)) || !isUuid(beforeId)))
    )
      return json(res, 400, { error: 'Cursor riwayat stok tidak valid.' });
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const validDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if ((from != null && !validDate(from)) || (to != null && !validDate(to)))
      return json(res, 400, { error: 'Rentang tanggal harus menggunakan YYYY-MM-DD.' });
    if (from && to && from > to)
      return json(res, 400, { error: 'Tanggal awal melewati tanggal akhir.' });
    const kind = url.searchParams.get('kind') || 'Semua';
    if (!movementKinds.has(kind))
      return json(res, 400, { error: 'Jenis pergerakan stok tidak valid.' });

    const result = await pool.query(
      `SELECT m.id,m.product_id,m.variant_id,m.delta,m.reason,m.occurred_at,
              p.name AS product_name,p.sku,u.name AS actor_name,
              CASE
                WHEN m.reason LIKE 'Penjualan %' THEN 'Penjualan'
                WHEN m.reason LIKE 'Impor %' THEN 'Impor'
                WHEN m.reason LIKE 'Transfer %' THEN 'Transfer'
                WHEN m.reason LIKE 'Refund %' THEN 'Refund'
                WHEN m.reason LIKE 'Perubahan stok %' OR m.reason LIKE 'Penyesuaian %'
                  OR m.reason = 'Stok awal' THEN 'Penyesuaian'
                ELSE 'Penyesuaian'
              END AS kind
       FROM stock_movements m
       JOIN products p ON p.id=m.product_id AND p.outlet_id=m.outlet_id
       JOIN outlets o ON o.id=m.outlet_id
       LEFT JOIN users u ON u.id=m.user_id
       WHERE m.outlet_id=$1
         AND ($2::uuid IS NULL OR m.product_id=$2)
         AND ($3::timestamptz IS NULL OR (m.occurred_at,m.id)<($3::timestamptz,$4::uuid))
         AND ($5::date IS NULL OR m.occurred_at >= ($5::date::timestamp AT TIME ZONE o.timezone))
         AND ($6::date IS NULL OR m.occurred_at < (($6::date + interval '1 day') AT TIME ZONE o.timezone))
         AND ($7::text='Semua' OR
           CASE
             WHEN m.reason LIKE 'Penjualan %' THEN 'Penjualan'
             WHEN m.reason LIKE 'Impor %' THEN 'Impor'
             WHEN m.reason LIKE 'Transfer %' THEN 'Transfer'
             WHEN m.reason LIKE 'Refund %' THEN 'Refund'
             ELSE 'Penyesuaian'
           END=$7)
       ORDER BY m.occurred_at DESC,m.id DESC LIMIT $8`,
      [actor.outlet_id, productId, before, beforeId, from, to, kind, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return json(res, 200, {
      movements: rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        variantId: row.variant_id,
        productName: row.product_name,
        sku: row.sku,
        delta: Number(row.delta),
        reason: row.reason,
        kind: row.kind,
        actor: row.actor_name || 'Tidak tercatat',
        at: row.occurred_at,
      })),
      hasMore,
      next: hasMore && last ? { before: last.occurred_at, beforeId: last.id } : null,
    });
  };
}
