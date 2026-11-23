export function createSalesHandler({ pool, activeSession, json, isUuid }) {
  return async function sales(req, res, url) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method tidak didukung.' });
    const actor = await activeSession(req);
    const requestedOutlet = url.searchParams.get('outletId');
    if (requestedOutlet && requestedOutlet !== actor.outlet_id)
      return json(res, 403, { error: 'Outlet berada di luar akses akun.' });

    const rawLimit = url.searchParams.get('limit') || '50';
    if (!/^\d{1,3}$/.test(rawLimit)) return json(res, 400, { error: 'Batas halaman tidak valid.' });
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 100)
      return json(res, 400, { error: 'Batas halaman harus antara 1 dan 100.' });
    const requestedId = url.searchParams.get('id');
    if (requestedId && !isUuid(requestedId))
      return json(res, 400, { error: 'ID transaksi tidak valid.' });
    const before = url.searchParams.get('before');
    const beforeId = url.searchParams.get('beforeId');
    if (
      (before == null) !== (beforeId == null) ||
      (before != null && (!Number.isFinite(Date.parse(before)) || !isUuid(beforeId)))
    ) {
      return json(res, 400, { error: 'Cursor transaksi tidak valid.' });
    }
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const validDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if ((from != null && !validDate(from)) || (to != null && !validDate(to))) {
      return json(res, 400, { error: 'Rentang tanggal harus menggunakan YYYY-MM-DD.' });
    }
    if (from && to && from > to)
      return json(res, 400, { error: 'Tanggal awal melewati tanggal akhir.' });
    if (requestedId && (before || from || to))
      return json(res, 400, {
        error: 'Pencarian ID transaksi tidak dapat digabungkan dengan filter halaman atau tanggal.',
      });

    const page = await pool.query(
      `SELECT s.id,s.outlet_id,s.shift_id,s.customer_id,c.name AS customer_name,s.cashier_name,o.timezone,
              s.sale_number,s.status,s.subtotal_rupiah,s.discount_rupiah,s.tax_rupiah,s.service_rupiah,
              s.total_rupiah,s.occurred_at,s.metadata
       FROM sales s JOIN outlets o ON o.id=s.outlet_id LEFT JOIN customers c ON c.id=s.customer_id
       WHERE s.outlet_id=$1
         AND ($6::uuid IS NULL OR s.id=$6)
         AND ($2::timestamptz IS NULL OR (s.occurred_at,s.id)<($2::timestamptz,$3::uuid))
         AND ($4::date IS NULL OR s.occurred_at >= ($4::date::timestamp AT TIME ZONE o.timezone))
         AND ($5::date IS NULL OR s.occurred_at < (($5::date + interval '1 day') AT TIME ZONE o.timezone))
       ORDER BY s.occurred_at DESC,s.id DESC LIMIT $7`,
      [actor.outlet_id, before, beforeId, from, to, requestedId, requestedId ? 1 : limit + 1],
    );
    const hasMore = !requestedId && page.rows.length > limit;
    const rows = page.rows.slice(0, limit);
    const ids = rows.map((row) => row.id);
    if (!ids.length) return json(res, 200, { sales: [], next: null, hasMore: false });

    const [items, payments, refunds] = await Promise.all([
      pool.query(
        `SELECT sale_id,id,product_id,variant_id,product_name,sku,quantity,unit_price_rupiah,unit_cost_rupiah,discount_rupiah,note
         FROM sale_items WHERE sale_id=ANY($1::uuid[]) ORDER BY sale_id,id`,
        [ids],
      ),
      pool.query(
        `SELECT id,sale_id,method,status,amount_rupiah,reference,occurred_at,metadata
         FROM payments WHERE sale_id=ANY($1::uuid[]) ORDER BY sale_id,occurred_at,id`,
        [ids],
      ),
      pool.query(
        `SELECT id,sale_id,amount_rupiah,cancelled_outstanding_rupiah,method,reference,reason,approved_by,occurred_at
         FROM sale_refunds WHERE sale_id=ANY($1::uuid[]) ORDER BY sale_id,occurred_at,id`,
        [ids],
      ),
    ]);
    const group = (rows) =>
      rows.reduce((map, row) => {
        const list = map.get(row.sale_id) || [];
        list.push(row);
        map.set(row.sale_id, list);
        return map;
      }, new Map());
    const itemsBySale = group(items.rows);
    const paymentsBySale = group(payments.rows);
    const refundsBySale = group(refunds.rows);
    const number = (value) => Number(value || 0);
    const output = rows.map((sale) => {
      const saleItems = (itemsBySale.get(sale.id) || []).map((item) => ({
        id: item.id,
        productId: item.product_id,
        variantId: item.variant_id,
        name: item.product_name,
        sku: item.sku,
        qty: number(item.quantity),
        price: number(item.unit_price_rupiah),
        ...(['Pemilik', 'Admin', 'Manajer'].includes(actor.role)
          ? { cost: number(item.unit_cost_rupiah) }
          : {}),
        discountAmount: number(item.discount_rupiah),
        note: item.note,
      }));
      const itemDiscount = saleItems.reduce((sum, item) => sum + item.discountAmount, 0);
      return {
        id: sale.id,
        number: sale.sale_number,
        outletId: sale.outlet_id,
        shiftId: sale.shift_id,
        customerId: sale.customer_id,
        customerName: sale.customer_name || 'Umum',
        cashier: sale.cashier_name,
        status: sale.status,
        at: sale.occurred_at,
        subtotal: number(sale.subtotal_rupiah),
        discount: number(sale.discount_rupiah),
        itemDiscount,
        transactionDiscount: Math.max(0, number(sale.discount_rupiah) - itemDiscount),
        tax: number(sale.tax_rupiah),
        service: number(sale.service_rupiah),
        total: number(sale.total_rupiah),
        outstanding: number(sale.metadata?.outstanding),
        voidReason: sale.metadata?.voidReason || null,
        voidAt: sale.metadata?.voidAt || null,
        items: saleItems,
        payments: (paymentsBySale.get(sale.id) || []).map((payment) => ({
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amount: number(payment.amount_rupiah),
          reference: payment.reference,
          at: payment.occurred_at,
          received: payment.metadata?.received == null ? null : number(payment.metadata.received),
          change: payment.metadata?.change == null ? null : number(payment.metadata.change),
          shiftId: payment.metadata?.shiftId || null,
        })),
        refunds: (refundsBySale.get(sale.id) || []).map((refund) => ({
          id: refund.id,
          amount: number(refund.amount_rupiah),
          cancelledOutstanding: number(refund.cancelled_outstanding_rupiah),
          method: refund.method,
          reference: refund.reference,
          reason: refund.reason,
          approvedBy: refund.approved_by,
          at: refund.occurred_at,
        })),
      };
    });
    const last = rows.at(-1);
    return json(res, 200, {
      sales: output,
      hasMore,
      next: hasMore ? { before: last.occurred_at, beforeId: last.id } : null,
    });
  };
}
