import { filterRemoteSyncEvents } from './attendance-policy.mjs';
import { applyShiftEvent } from './sync-shift-handler.mjs';
import { applyTransferAndAuditEvent } from './sync-audit-transfer-handler.mjs';
import { applyReceivableEvent } from './sync-receivable-handler.mjs';
import { applyStockEvent } from './sync-stock-handler.mjs';
import { applyAttendanceEvent } from './sync-attendance-handler.mjs';
import { applyDiscountEvent } from './sync-discount-handler.mjs';
import { applyCashEvent } from './sync-cash-handler.mjs';
import { applySaleEvent } from './sync-sale-handler.mjs';
import { applyCatalogEvent } from './sync-catalog-handler.mjs';
import { roleEventTypes } from '../shared/sync-role-policy.mjs';
import { collectScopedEntityIds } from './sync-scope-policy.mjs';
import { matchesStoredSyncEvent } from './sync-event-policy.mjs';

export function createSyncHandler({
  pool,
  activeSession,
  json,
  readJson,
  requireSameOrigin,
  isUuid,
  createHash,
}) {
  return async function syncEvents(req, res, url) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    const actor = await activeSession(req);
    const scope = actor.outlet_id;
    if (req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      const after = Number(url.searchParams.get('after') || 0);
      if (!Number.isSafeInteger(after) || after < 0)
        return json(res, 400, { error: 'Cursor sinkronisasi tidak valid.' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fastq-sync-retention'))");
        const retention = await client.query(
          'SELECT minimum_cursor FROM sync_event_retention WHERE outlet_id=$1',
          [scope],
        );
        const minimumCursor = Number(retention.rows[0]?.minimum_cursor || 0);
        if (after < minimumCursor) {
          await client.query('ROLLBACK');
          return json(res, 409, {
            error:
              'Perangkat melewati batas retensi event. Data lokal tetap tersimpan; hubungi administrator untuk sinkronisasi ulang.',
            code: 'SYNC_RESYNC_REQUIRED',
            minimumCursor,
          });
        }
        if (deviceId && isUuid(deviceId)) {
          const knownDevice = await client.query(
            'SELECT last_cursor FROM sync_devices WHERE outlet_id=$1 AND device_id=$2',
            [scope, deviceId],
          );
          if (knownDevice.rowCount && after < Number(knownDevice.rows[0].last_cursor)) {
            await client.query('ROLLBACK');
            return json(res, 409, {
              error:
                'Cursor perangkat mundur dari sinkronisasi terakhir. Data lokal tetap tersimpan; hubungi administrator sebelum melanjutkan.',
              code: 'SYNC_CURSOR_ROLLBACK',
            });
          }
        }
        const result = scope
          ? await client.query(
              `SELECT server_cursor, event_id, device_id, outlet_id, event_type, payload, occurred_at
           FROM sync_events WHERE outlet_id=$2 AND server_cursor>$1 ORDER BY server_cursor LIMIT 1000`,
              [after, scope],
            )
          : await client.query(
              `SELECT server_cursor, event_id, device_id, outlet_id, event_type, payload, occurred_at
           FROM sync_events WHERE server_cursor>$1 ORDER BY server_cursor LIMIT 1000`,
              [after],
            );
        const cursor = result.rows.length ? Number(result.rows.at(-1).server_cursor) : after;
        await client.query('COMMIT');
        return json(res, 200, {
          events: result.rows.filter((event) => event.device_id !== deviceId),
          cursor,
          hasMore: result.rows.length === 1000,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method tidak didukung.' });
    requireSameOrigin(req);
    const body = await readJson(req);
    if (
      !isUuid(body.deviceId) ||
      !Number.isSafeInteger(body.cursor) ||
      body.cursor < 0 ||
      !Array.isArray(body.events) ||
      body.events.length > 100 ||
      (body.bootstrap != null && typeof body.bootstrap !== 'boolean') ||
      (body.activeShiftId != null && !isUuid(body.activeShiftId))
    )
      return json(res, 400, {
        error: 'deviceId, cursor, activeShiftId valid, dan maksimum 100 event wajib dikirim.',
      });
    const roleEvents = roleEventTypes[actor.role] || new Set();
    const client = await pool.connect();
    const accepted = [];
    let remote;
    let stockBalances;
    let transfers;
    let outlets;
    let bootstrapProducts = [];
    let cursor;
    let needsBootstrap = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fastq-sync-retention'))");
      const retention = await client.query(
        'SELECT minimum_cursor FROM sync_event_retention WHERE outlet_id=$1',
        [scope],
      );
      const minimumCursor = Number(retention.rows[0]?.minimum_cursor || 0);
      const knownDevice = await client.query(
        'SELECT last_cursor FROM sync_devices WHERE outlet_id=$1 AND device_id=$2',
        [scope, body.deviceId],
      );
      needsBootstrap = body.bootstrap === true || (!knownDevice.rowCount && body.cursor === 0);
      if (body.cursor < minimumCursor && !needsBootstrap)
        throw Object.assign(
          new Error(
            'Perangkat melewati batas retensi event. Data lokal tetap tersimpan; hubungi administrator untuk sinkronisasi ulang.',
          ),
          { status: 409, code: 'SYNC_RESYNC_REQUIRED' },
        );
      if (
        knownDevice.rowCount &&
        body.cursor < Number(knownDevice.rows[0].last_cursor) &&
        !needsBootstrap
      )
        throw Object.assign(
          new Error(
            'Cursor perangkat mundur dari sinkronisasi terakhir. Data lokal tetap tersimpan; hubungi administrator sebelum melanjutkan.',
          ),
          { status: 409, code: 'SYNC_CURSOR_ROLLBACK' },
        );
      const batchEventIds = new Set();
      const scopeValidationBudget = { inspectedObjects: 0, entityIds: 0 };
      for (const event of body.events) {
        const validTimestamp =
          event?.at == null ||
          (typeof event.at === 'string' &&
            event.at.length <= 40 &&
            Number.isFinite(Date.parse(event.at)));
        if (
          !event ||
          typeof event !== 'object' ||
          Array.isArray(event) ||
          !isUuid(event.id) ||
          typeof event.type !== 'string' ||
          !event.type ||
          !event.payload ||
          typeof event.payload !== 'object' ||
          Array.isArray(event.payload) ||
          !validTimestamp
        )
          throw Object.assign(new Error('Format event tidak valid.'), { status: 400 });
        if (batchEventIds.has(event.id))
          throw Object.assign(new Error('ID event duplikat dalam satu batch sinkronisasi.'), {
            status: 400,
          });
        batchEventIds.add(event.id);
        if (!roleEvents.has(event.type))
          throw Object.assign(
            new Error(`Role ${actor.role} tidak dapat mengirim perubahan ${event.type}.`),
            { status: 403 },
          );
        if (
          event.type === 'outlet.upsert' &&
          (actor.role !== 'Admin' || event.payload.id !== scope)
        )
          throw Object.assign(
            new Error(
              'Hanya Pemilik yang dapat membuat toko; Admin hanya dapat menyinkronkan toko aktif.',
            ),
            { status: 403 },
          );
        if (
          event.type === 'cash.upsert' &&
          (!['in', 'out'].includes(event.payload.type) ||
            (actor.role === 'Pemilik' && event.payload.type !== 'out'))
        )
          throw Object.assign(
            new Error('Jenis pergerakan kas tidak diizinkan untuk role akun ini.'),
            { status: 403 },
          );
        if (
          event.type === 'stock.delta' &&
          actor.role === 'Kasir' &&
          Number(event.payload.delta) >= 0
        )
          throw Object.assign(
            new Error('Kasir hanya dapat menyinkronkan pengurangan stok dari transaksi.'),
            { status: 403 },
          );
        if (
          event.type === 'sale.upsert' &&
          actor.role === 'Kasir' &&
          (['Dikembalikan', 'Void'].includes(event.payload.status) ||
            event.payload.refunds?.length ||
            event.payload.voidReason ||
            event.payload.voidAt)
        )
          throw Object.assign(
            new Error('Kasir tidak dapat membatalkan atau me-refund transaksi.'),
            { status: 403 },
          );
        if (scope) {
          const deny = () => {
            throw Object.assign(
              new Error(
                `Event ${event.type} (${event.id}) memuat data di luar toko akun. Data tetap disimpan di perangkat; gunakan akun toko yang sesuai.`,
              ),
              { status: 403 },
            );
          };
          if (event.outletId !== scope) deny();
          if (event.type === 'outlet.upsert' && event.payload.id !== scope) deny();
          const ids = collectScopedEntityIds(event, {
            scope,
            isUuid,
            budget: scopeValidationBudget,
          });
          const foreign = await client.query(
            `SELECT id FROM (
          SELECT id,outlet_id FROM products UNION ALL SELECT id,outlet_id FROM customers
          UNION ALL SELECT id,outlet_id FROM shifts UNION ALL SELECT id,outlet_id FROM sales
          UNION ALL SELECT movement.id,shift.outlet_id FROM cash_movements movement JOIN shifts shift ON shift.id=movement.shift_id
          UNION ALL SELECT id,outlet_id FROM attendance
          UNION ALL SELECT v.id,p.outlet_id FROM product_variants v JOIN products p ON p.id=v.product_id
        ) entities WHERE id=ANY($1::uuid[]) AND outlet_id IS DISTINCT FROM $2::uuid LIMIT 1`,
            [[...ids], scope],
          );
          if (foreign.rowCount) deny();
        }
        const inserted = await client.query(
          `INSERT INTO sync_events(event_id,device_id,outlet_id,event_type,payload,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,event_id) DO NOTHING RETURNING server_cursor`,
          [
            event.id,
            body.deviceId,
            event.outletId || null,
            event.type,
            event.payload,
            event.at || new Date().toISOString(),
          ],
        );
        if (!inserted.rowCount) {
          const existing = await client.query(
            `SELECT event_type,outlet_id,payload,occurred_at FROM sync_events WHERE device_id=$1 AND event_id=$2`,
            [body.deviceId, event.id],
          );
          if (!existing.rowCount || !matchesStoredSyncEvent(existing.rows[0], event)) {
            throw Object.assign(
              new Error('ID event sudah pernah dipakai untuk perubahan yang berbeda.'),
              {
                status: 409,
                code: 'SYNC_EVENT_ID_CONFLICT',
                conflict: {
                  type: 'sync-event-id',
                  eventId: event.id,
                  eventType: existing.rows[0]?.event_type || event.type,
                  outletId: existing.rows[0]?.outlet_id || event.outletId || null,
                  occurredAt: existing.rows[0]?.occurred_at || null,
                  storedEvent: existing.rowCount
                    ? {
                        event_type: existing.rows[0].event_type,
                        outlet_id: existing.rows[0].outlet_id,
                        occurred_at: existing.rows[0].occurred_at,
                        payload: existing.rows[0].payload,
                      }
                    : null,
                },
              },
            );
          }
          accepted.push(event.id);
          continue;
        }
        accepted.push(event.id);
        if (
          [
            'outlet.upsert',
            'product.upsert',
            'product.favorite',
            'product.delete',
            'customer.upsert',
          ].includes(event.type)
        ) {
          await applyCatalogEvent({ client, event, scope, deviceId: body.deviceId, isUuid });
        } else if (event.type === 'shift.upsert') {
          await applyShiftEvent({ client, event, scope, actor, deviceId: body.deviceId, isUuid });
        } else if (event.type === 'sale.upsert') {
          await applySaleEvent({
            client,
            event,
            scope,
            actor,
            deviceId: body.deviceId,
            isUuid,
            createHash,
          });
        } else if (event.type === 'cash.upsert' || event.type === 'cash.approval') {
          await applyCashEvent({ client, event, scope, actor, deviceId: body.deviceId, isUuid });
        } else if (
          event.type === 'discount.request' ||
          event.type === 'discount.approval' ||
          event.type === 'discount.cancel'
        ) {
          await applyDiscountEvent({
            client,
            event,
            scope,
            actor,
            deviceId: body.deviceId,
            isUuid,
          });
        } else if (event.type === 'attendance.upsert') {
          await applyAttendanceEvent({
            client,
            event,
            scope,
            actor,
            deviceId: body.deviceId,
            isUuid,
          });
        } else if (event.type === 'receivable.payment') {
          await applyReceivableEvent({
            client,
            event,
            scope,
            actor,
            deviceId: body.deviceId,
            isUuid,
          });
        } else if (event.type === 'transfer.upsert' || event.type === 'audit.append') {
          await applyTransferAndAuditEvent({
            client,
            event,
            scope,
            actor,
            deviceId: body.deviceId,
            isUuid,
          });
        } else if (event.type === 'stock.delta' || event.type === 'stock.reconcile') {
          await applyStockEvent({ client, event, scope, actor, deviceId: body.deviceId, isUuid });
        }
      }
      remote = needsBootstrap
        ? { rows: [] }
        : await client.query(
            `SELECT server_cursor,event_id,device_id,outlet_id,event_type,payload,occurred_at
       FROM sync_events WHERE server_cursor>$1 AND outlet_id=$2 ORDER BY server_cursor LIMIT 1000`,
            [body.cursor, scope],
          );
      const balances = await client.query(
        `SELECT product_id,variant_id,quantity::text AS quantity
       FROM stock_balances WHERE outlet_id=$1 ORDER BY product_id,variant_id NULLS FIRST`,
        [scope],
      );
      stockBalances = balances.rows.map((balance) => ({
        outletId: scope,
        productId: balance.product_id,
        variantId: balance.variant_id,
        quantity: Number(balance.quantity),
      }));
      const transferRows = await client.query(
        `SELECT transfer.id,transfer.product_id AS "productId",
                transfer.variant_id AS "variantId",transfer.from_outlet_id AS "from",
                transfer.to_outlet_id AS "to",transfer.quantity::text AS quantity,
                transfer.note,transfer.occurred_at AS at,product.name AS "productName"
         FROM stock_transfers transfer
         LEFT JOIN products product ON product.id=transfer.product_id
         WHERE transfer.from_outlet_id=$1 OR transfer.to_outlet_id=$1
         ORDER BY transfer.occurred_at DESC,transfer.id DESC LIMIT 500`,
        [scope],
      );
      transfers = transferRows.rows.map((transfer) => ({
        ...transfer,
        quantity: Number(transfer.quantity),
        at: new Date(transfer.at).toISOString(),
      }));
      const outletRows = await client.query(
        `SELECT outlet.id,outlet.name,outlet.code
         FROM outlets outlet
         WHERE outlet.id=$1 OR outlet.id IN (
           SELECT transfer.from_outlet_id FROM stock_transfers transfer
           WHERE transfer.from_outlet_id=$1 OR transfer.to_outlet_id=$1
           UNION
           SELECT transfer.to_outlet_id FROM stock_transfers transfer
           WHERE transfer.from_outlet_id=$1 OR transfer.to_outlet_id=$1
         )
         ORDER BY outlet.name,outlet.id`,
        [scope],
      );
      outlets = outletRows.rows;
      if (needsBootstrap) {
        const products = await client.query(
          `SELECT p.id,p.sku,p.barcode,p.name,p.unit,p.price_rupiah::text AS price,
                    p.cost_rupiah::text AS cost,p.min_stock::text AS min_stock,p.metadata,
                    c.name AS category
             FROM products p LEFT JOIN categories c ON c.id=p.category_id
             WHERE p.outlet_id=$1 AND p.deleted_at IS NULL ORDER BY p.name LIMIT 5000`,
          [scope],
        );
        const variants = await client.query(
          `SELECT v.id,v.product_id,v.sku,v.barcode,v.name,v.price_rupiah::text AS price,
                    v.cost_rupiah::text AS cost,v.metadata
             FROM product_variants v JOIN products p ON p.id=v.product_id
             WHERE p.outlet_id=$1 AND p.deleted_at IS NULL ORDER BY v.name`,
          [scope],
        );
        const latestCursor = await client.query(
          'SELECT COALESCE(MAX(server_cursor),0)::text AS cursor FROM sync_events WHERE outlet_id=$1',
          [scope],
        );
        const balancesById = new Map(
          stockBalances.map((balance) => [
            `${balance.productId}|${balance.variantId || ''}`,
            balance.quantity,
          ]),
        );
        bootstrapProducts = products.rows.map((product) => {
          const metadata = product.metadata || {};
          const productVariants = variants.rows
            .filter((variant) => variant.product_id === product.id)
            .map((variant) => ({
              id: variant.id,
              sku: variant.sku,
              barcode: variant.barcode,
              name: variant.name,
              price: Number(variant.price),
              ...(actor.role === 'Kasir' ? {} : { cost: Number(variant.cost) }),
              unit: variant.metadata?.unit || product.unit,
              retired: !!variant.metadata?.retired,
              stock: balancesById.get(`${product.id}|${variant.id}`) || 0,
              stockByOutlet: {
                ...(metadata.variants?.[variant.id]?.stockByOutlet || {}),
                [scope]: balancesById.get(`${product.id}|${variant.id}`) || 0,
              },
            }));
          const stock = productVariants.length
            ? productVariants.reduce(
                (sum, variant) => sum + (variant.retired ? 0 : variant.stock),
                0,
              )
            : balancesById.get(`${product.id}|`) || 0;
          return {
            id: product.id,
            sku: product.sku,
            barcode: product.barcode,
            name: product.name,
            category: product.category || 'Lainnya',
            unit: product.unit,
            price: Number(product.price),
            ...(actor.role === 'Kasir' ? {} : { cost: Number(product.cost) }),
            minStock: Number(product.min_stock),
            favorite: !!metadata.favorite,
            stock,
            stockByOutlet: { ...(metadata.stockByOutlet || {}), [scope]: stock },
            variants: productVariants,
          };
        });
        cursor = Number(latestCursor.rows[0]?.cursor || 0);
      } else cursor = remote.rows.length ? Number(remote.rows.at(-1).server_cursor) : body.cursor;
      await client.query(
        `INSERT INTO sync_devices(outlet_id,device_id,last_seen_at,last_cursor) VALUES($1,$2,now(),$3)
       ON CONFLICT(outlet_id,device_id) DO UPDATE SET last_seen_at=now(),last_cursor=GREATEST(sync_devices.last_cursor,EXCLUDED.last_cursor)`,
        [scope, body.deviceId, cursor],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const events = filterRemoteSyncEvents(remote.rows, actor.role, body.deviceId);
    const active = await pool.query(
      `SELECT id,outlet_id,user_id,opened_at,closed_at,opening_cash_rupiah,expected_cash_rupiah,physical_cash_rupiah,difference_rupiah,metadata
     FROM shifts WHERE outlet_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
      [scope],
    );
    const known = body.activeShiftId
      ? await pool.query(
          `SELECT id,outlet_id,user_id,opened_at,closed_at,opening_cash_rupiah,expected_cash_rupiah,physical_cash_rupiah,difference_rupiah,metadata
     FROM shifts WHERE id=$1 AND outlet_id=$2`,
          [body.activeShiftId, scope],
        )
      : null;
    const toShift = (row) => {
      if (!row) return null;
      const metadata = row.metadata || {};
      return {
        id: row.id,
        outletId: row.outlet_id,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        openingCash: Number(row.opening_cash_rupiah),
        expectedCash: row.expected_cash_rupiah === null ? null : Number(row.expected_cash_rupiah),
        physicalCash: row.physical_cash_rupiah === null ? null : Number(row.physical_cash_rupiah),
        difference: row.difference_rupiah === null ? null : Number(row.difference_rupiah),
        cashier: metadata.cashier || null,
        openedBy: metadata.openedBy || metadata.cashier || null,
        openedById: metadata.openedById || row.user_id,
        closedBy: metadata.closedBy || null,
        cashiers: Array.isArray(metadata.cashiers) ? metadata.cashiers : [],
      };
    };
    const activeShift = toShift(active.rows[0]);
    const knownShift = known?.rows[0]?.id !== activeShift?.id ? toShift(known?.rows[0]) : null;
    return json(res, 200, {
      accepted,
      events,
      stockBalances,
      transfers,
      outlets,
      bootstrapProducts,
      catalogBootstrapped: needsBootstrap,
      activeShift,
      knownShift,
      cursor,
      hasMore: remote.rows.length === 1000,
    });
  };
}
