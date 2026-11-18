import { timestampMs } from './timestamp-utils.mjs';

export async function applyTransferAndAuditEvent({ client, event, scope, actor, deviceId, isUuid }) {
  if (event.type === 'transfer.upsert') {
        const t = event.payload;
        await client.query(
          `INSERT INTO stock_transfers(id,product_id,variant_id,from_outlet_id,to_outlet_id,quantity,note,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
          [t.id, t.productId, t.variantId || null, t.from, t.to, t.quantity, t.note || null, t.at],
        );

  } else if (event.type === 'audit.append') {
        const a = event.payload;
        if (!isUuid(a.id) || typeof a.action !== 'string' || !a.action.trim() || a.action.length > 120
          || a.detail != null && (typeof a.detail !== 'string' || a.detail.length > 1000)
          || typeof a.at !== 'string' || a.at.length > 40 || !Number.isFinite(Date.parse(a.at)) || Date.parse(a.at) > Date.now() + 5 * 60_000) {
          throw Object.assign(new Error('Entri audit tidak valid.'), { status: 400 });
        }
        let canonical = { id: a.id, outletId: scope, userId: actor.id, role: actor.role, action: a.action.trim(), detail: a.detail?.trim() || null, at: a.at };
        const insertedAudit = await client.query(
          `INSERT INTO audit_log(id,outlet_id,user_id,role,action,detail,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(id) DO NOTHING RETURNING id`,
          [canonical.id, scope, actor.id, actor.role, canonical.action, canonical.detail, canonical.at],
        );
        if (!insertedAudit.rowCount) {
          const existingAudit = await client.query(
            'SELECT outlet_id,user_id,role,action,detail,occurred_at FROM audit_log WHERE id=$1 FOR UPDATE', [canonical.id],
          );
          const saved = existingAudit.rows[0];
          if (!saved || saved.outlet_id !== scope || saved.action !== canonical.action || saved.detail !== canonical.detail
            || timestampMs(saved.occurred_at) !== timestampMs(canonical.at)) {
            throw Object.assign(new Error('ID entri audit sudah digunakan dengan isi berbeda.'), { status: 409 });
          }
          canonical = { id: saved.id, outletId: saved.outlet_id, userId: saved.user_id, role: saved.role, action: saved.action, detail: saved.detail, at: saved.occurred_at };
        }
        await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [canonical, deviceId, event.id]);

  }
}

