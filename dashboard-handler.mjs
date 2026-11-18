export function createDashboardHandler({ pool, activeSession, json }) {
  return async function ownerDashboard(req, res, url) {
  if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
  const active = await activeSession(req);
  const user = { ...active, outletId: active.outlet_id };
  if (!user || !['Pemilik','Manajer','Admin'].includes(user.role)) return json(res, 403, { error: 'Dashboard hanya tersedia untuk Pemilik, Manajer, atau Admin.' });
  const requestedOutlet = url.searchParams.get('outletId');
  if (requestedOutlet && requestedOutlet !== user.outletId) return json(res, 403, { error: 'Outlet berada di luar akses akun.' });
  const outletId = user.outletId;
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || 30)));
  const sales = await pool.query(
    `SELECT s.id,s.sale_number,s.status,s.total_rupiah,s.occurred_at,s.cashier_name,
            COALESCE(json_agg(json_build_object('method',p.method,'amount',p.amount_rupiah))
              FILTER (WHERE p.id IS NOT NULL),'[]') AS payments
     FROM sales s LEFT JOIN payments p ON p.sale_id=s.id
     WHERE ($1::uuid IS NULL OR s.outlet_id=$1) AND s.occurred_at >= now()-($2::text||' days')::interval
     GROUP BY s.id ORDER BY s.occurred_at DESC LIMIT 250`, [outletId || null, days],
  );
  const totals = await pool.query(
    `SELECT count(*) FILTER (WHERE status IN ('Lunas','Piutang'))::int AS transactions,
            COALESCE(sum(total_rupiah) FILTER (WHERE status IN ('Lunas','Piutang')),0)::text AS revenue,
            COALESCE(sum(COALESCE(NULLIF(metadata->>'outstanding','')::bigint,total_rupiah)) FILTER (WHERE status='Piutang'),0)::text AS receivables
     FROM sales WHERE ($1::uuid IS NULL OR outlet_id=$1) AND occurred_at >= now()-($2::text||' days')::interval`, [outletId || null, days],
  );
  const outlets = await pool.query('SELECT id,name,timezone FROM outlets WHERE id=$1 ORDER BY name', [user.outletId]);
  const byCashier = await pool.query(
    `SELECT cashier_name AS label,COALESCE(sum(total_rupiah),0)::text AS value
     FROM sales WHERE ($1::uuid IS NULL OR outlet_id=$1) AND occurred_at>=now()-($2::text||' days')::interval
       AND status IN ('Lunas','Piutang') GROUP BY cashier_name ORDER BY sum(total_rupiah) DESC LIMIT 10`, [outletId || null, days],
  );
  const byPayment = await pool.query(
    `SELECT p.method AS label,COALESCE(sum(p.amount_rupiah),0)::text AS value
     FROM payments p JOIN sales s ON s.id=p.sale_id
     WHERE ($1::uuid IS NULL OR s.outlet_id=$1) AND s.occurred_at>=now()-($2::text||' days')::interval
       AND s.status IN ('Lunas','Piutang') GROUP BY p.method ORDER BY sum(p.amount_rupiah) DESC`, [outletId || null, days],
  );
  const byCategory = await pool.query(
    `SELECT COALESCE(c.name,'Lainnya') AS label,COALESCE(sum(si.quantity*si.unit_price_rupiah-si.discount_rupiah),0)::text AS value
     FROM sale_items si JOIN sales s ON s.id=si.sale_id LEFT JOIN products p ON p.id=si.product_id
       LEFT JOIN categories c ON c.id=p.category_id
     WHERE ($1::uuid IS NULL OR s.outlet_id=$1) AND s.occurred_at>=now()-($2::text||' days')::interval
       AND s.status IN ('Lunas','Piutang') GROUP BY c.name ORDER BY sum(si.quantity*si.unit_price_rupiah-si.discount_rupiah) DESC LIMIT 10`, [outletId || null, days],
  );
  const trend = await pool.query(
    `SELECT date_trunc('day',occurred_at)::date::text AS day,COALESCE(sum(total_rupiah),0)::text AS value,
            count(*)::int AS transactions FROM sales
     WHERE ($1::uuid IS NULL OR outlet_id=$1) AND occurred_at>=now()-($2::text||' days')::interval
       AND status IN ('Lunas','Piutang') GROUP BY 1 ORDER BY 1`, [outletId || null, days],
  );
  const lowStock = await pool.query(
    `SELECT p.name,p.sku,COALESCE(b.quantity,0)::text AS quantity,p.min_stock::text AS min_stock
     FROM products p LEFT JOIN stock_balances b ON b.product_id=p.id AND b.variant_id IS NULL
       AND ($1::uuid IS NULL OR b.outlet_id=$1)
     WHERE p.deleted_at IS NULL AND ($1::uuid IS NULL OR p.outlet_id=$1)
       AND COALESCE(b.quantity,0)<=p.min_stock ORDER BY p.name LIMIT 100`, [outletId || null],
  );
  return json(res, 200, { ...totals.rows[0], outlets: outlets.rows, lowStock: lowStock.rows,
    byCashier: byCashier.rows, byPayment: byPayment.rows, byCategory: byCategory.rows, trend: trend.rows,
    sales: sales.rows.map(s => ({ ...s, total_rupiah: String(s.total_rupiah) })), days });
}
}
