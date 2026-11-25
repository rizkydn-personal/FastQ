import { createHash } from 'node:crypto';
import { timestampMs } from './timestamp-utils.mjs';

function transferMovementId(transferId, outletId) {
  return createHash('sha256')
    .update(`transfer-stock:${transferId}:${outletId}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

export async function applyTransferAndAuditEvent({
  client,
  event,
  scope,
  actor,
  deviceId,
  isUuid,
}) {
  if (event.type === 'transfer.upsert') {
    const t = event.payload;
    const quantity = Number(t?.quantity);
    const variantId = t?.variantId || null;
    if (
      !isUuid(t?.id) ||
      !isUuid(t?.productId) ||
      (variantId && !isUuid(variantId)) ||
      !isUuid(t?.from) ||
      !isUuid(t?.to) ||
      t.from === t.to ||
      t.from !== scope ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity >= 1e15 ||
      typeof t.at !== 'string' ||
      !Number.isFinite(Date.parse(t.at)) ||
      Date.parse(t.at) > Date.now() + 5 * 60_000 ||
      (t.note != null && (typeof t.note !== 'string' || t.note.length > 1000))
    ) {
      throw Object.assign(new Error('Data transfer stok tidak valid.'), { status: 400 });
    }
    const inserted = await client.query(
      `INSERT INTO stock_transfers(id,product_id,variant_id,from_outlet_id,to_outlet_id,quantity,note,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [t.id, t.productId, variantId, t.from, t.to, quantity, t.note?.trim() || null, t.at],
    );
    if (inserted.rowCount) {
      await client.query(
        `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
         VALUES($1,$3,$4,0),($2,$3,$4,0)
         ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING`,
        [t.from, t.to, t.productId, variantId],
      );
      const balances = await client.query(
        `SELECT outlet_id,quantity FROM stock_balances
         WHERE product_id=$1 AND variant_id IS NOT DISTINCT FROM $2::uuid
           AND outlet_id=ANY($3::uuid[]) ORDER BY outlet_id FOR UPDATE`,
        [t.productId, variantId, [t.from, t.to]],
      );
      const source = balances.rows.find((row) => row.outlet_id === t.from);
      const destination = balances.rows.find((row) => row.outlet_id === t.to);
      if (!source || !destination || Number(source.quantity) < quantity) {
        throw Object.assign(new Error('Stok outlet sumber tidak mencukupi.'), {
          status: 409,
          conflict: {
            type: 'stock',
            eventId: event.id,
            productId: t.productId,
            variantId,
            outletId: t.from,
            serverQuantity: Number(source?.quantity || 0),
          },
        });
      }
      await client.query(
        `UPDATE stock_balances SET quantity=CASE outlet_id
           WHEN $1::uuid THEN quantity-$4::numeric
           WHEN $2::uuid THEN quantity+$4::numeric END, updated_at=now()
         WHERE product_id=$3 AND variant_id IS NOT DISTINCT FROM $5::uuid
           AND outlet_id=ANY($6::uuid[])`,
        [t.from, t.to, t.productId, quantity, variantId, [t.from, t.to]],
      );
      await client.query(
        `INSERT INTO stock_movements(id,outlet_id,product_id,variant_id,delta,reason,occurred_at,user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$9),($8,$10,$3,$4,$11,$12,$7,$9)
         ON CONFLICT(id) DO NOTHING`,
        [
          transferMovementId(t.id, t.from),
          t.from,
          t.productId,
          variantId,
          -quantity,
          `Transfer ke ${t.to}`,
          t.at,
          transferMovementId(t.id, t.to),
          actor.id,
          t.to,
          quantity,
          `Transfer dari ${t.from}`,
        ],
      );
      if (variantId) {
        for (const outletId of [t.from, t.to])
          await client.query(
            `UPDATE stock_balances parent SET quantity=COALESCE((
               SELECT sum(child.quantity) FROM stock_balances child
               JOIN product_variants variant ON variant.id=child.variant_id
               WHERE child.outlet_id=$1 AND child.product_id=$2 AND child.variant_id IS NOT NULL
                 AND COALESCE((variant.metadata->>'retired')::boolean,FALSE)=FALSE
             ),0),updated_at=now()
             WHERE parent.outlet_id=$1 AND parent.product_id=$2 AND parent.variant_id IS NULL`,
            [outletId, t.productId],
          );
      }
    }
  } else if (event.type === 'audit.append') {
    const a = event.payload;
    if (
      !isUuid(a.id) ||
      typeof a.action !== 'string' ||
      !a.action.trim() ||
      a.action.length > 120 ||
      (a.detail != null && (typeof a.detail !== 'string' || a.detail.length > 1000)) ||
      typeof a.at !== 'string' ||
      a.at.length > 40 ||
      !Number.isFinite(Date.parse(a.at)) ||
      Date.parse(a.at) > Date.now() + 5 * 60_000
    ) {
      throw Object.assign(new Error('Entri audit tidak valid.'), { status: 400 });
    }
    let canonical = {
      id: a.id,
      outletId: scope,
      userId: actor.id,
      role: actor.role,
      action: a.action.trim(),
      detail: a.detail?.trim() || null,
      at: a.at,
    };
    const insertedAudit = await client.query(
      `INSERT INTO audit_log(id,outlet_id,user_id,role,action,detail,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(id) DO NOTHING RETURNING id`,
      [canonical.id, scope, actor.id, actor.role, canonical.action, canonical.detail, canonical.at],
    );
    if (!insertedAudit.rowCount) {
      const existingAudit = await client.query(
        'SELECT outlet_id,user_id,role,action,detail,occurred_at FROM audit_log WHERE id=$1 FOR UPDATE',
        [canonical.id],
      );
      const saved = existingAudit.rows[0];
      if (
        !saved ||
        saved.outlet_id !== scope ||
        saved.action !== canonical.action ||
        saved.detail !== canonical.detail ||
        timestampMs(saved.occurred_at) !== timestampMs(canonical.at)
      ) {
        throw Object.assign(new Error('ID entri audit sudah digunakan dengan isi berbeda.'), {
          status: 409,
        });
      }
      canonical = {
        id: saved.id,
        outletId: saved.outlet_id,
        userId: saved.user_id,
        role: saved.role,
        action: saved.action,
        detail: saved.detail,
        at: saved.occurred_at,
      };
    }
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [
      canonical,
      deviceId,
      event.id,
    ]);
  }
}
