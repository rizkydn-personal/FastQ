import { timestampMs } from './timestamp-utils.mjs';

export async function applyCashEvent({ client, event, scope, actor, deviceId, isUuid }) {
  if (event.type === 'cash.upsert') {
    const m = event.payload;
    if (!isUuid(m.id) || !isUuid(m.shiftId) || !Number.isSafeInteger(m.amount) || m.amount <= 0 || typeof m.reason !== 'string' || !m.reason.trim() || m.reason.length > 240 || m.category != null && (typeof m.category !== 'string' || m.category.length > 80) || typeof m.at !== 'string' || m.at.length > 40 || !Number.isFinite(Date.parse(m.at)) || Date.parse(m.at) > Date.now() + 5 * 60_000) throw Object.assign(new Error('Data pergerakan kas tidak valid.'), { status: 400 });
    if (actor.role === 'Kasir' && m.requestedById && m.requestedById !== actor.id) throw Object.assign(new Error('Kasir hanya dapat mencatat kas atas nama akunnya sendiri.'), { status: 403 });
    const existingMovement = await client.query(
      `SELECT m.id,m.shift_id,m.direction,m.amount_rupiah,m.reason,m.category,m.occurred_at,m.approval_status,m.requested_by,m.approved_by,m.approved_at,s.outlet_id
       FROM cash_movements m JOIN shifts s ON s.id=m.shift_id WHERE m.id=$1 FOR UPDATE OF m`, [m.id],
    );
    if (existingMovement.rowCount && existingMovement.rows[0].outlet_id !== scope) throw Object.assign(new Error('ID pergerakan kas sudah digunakan.'), { status: 409 });
    if (existingMovement.rowCount) {
      const saved = existingMovement.rows[0];
      const sameMovement = saved.shift_id === m.shiftId && saved.direction === m.type
        && Number(saved.amount_rupiah) === m.amount && saved.reason === m.reason.trim()
        && saved.category === (m.category || 'Operasional') && timestampMs(saved.occurred_at) === timestampMs(m.at);
      if (!sameMovement) throw Object.assign(new Error('ID pergerakan kas sudah digunakan dengan isi berbeda.'), { status: 409 });
      if (actor.role === 'Kasir' && saved.requested_by !== actor.id) throw Object.assign(new Error('Kasir hanya dapat menyinkronkan pergerakan kas miliknya sendiri.'), { status: 403 });
    }
    if (!existingMovement.rowCount) {
      const shiftStatus = await client.query('SELECT closed_at FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE', [m.shiftId, scope]);
      if (!shiftStatus.rowCount) throw Object.assign(new Error('Shift kas tidak ditemukan di toko aktif.'), { status: 404 });
      if (shiftStatus.rows[0].closed_at) throw Object.assign(new Error('Pergerakan kas tidak dapat ditambahkan ke shift yang sudah ditutup.'), { status: 409 });
    }
    let requestedBy = actor.id, approvalStatus = 'approved', approvedBy = actor.name, approvedAt = event.at || new Date().toISOString();
    if (m.type === 'out' && actor.role === 'Kasir') {
      approvalStatus = 'pending'; approvedBy = null; approvedAt = null;
    } else if (m.type === 'out' && ['Admin','Pemilik'].includes(actor.role) && m.approvalStatus === 'pending' && isUuid(m.requestedById) && m.requestedById !== actor.id) {
      const requester = await client.query('SELECT role FROM users WHERE id=$1 AND outlet_id=$2 AND active=true', [m.requestedById, scope]);
      if (requester.rows[0]?.role === 'Kasir') { requestedBy = m.requestedById; approvalStatus = 'pending'; approvedBy = null; approvedAt = null; }
    }
    let canonical;
    if (existingMovement.rowCount) {
      const saved = existingMovement.rows[0];
      canonical = { id: saved.id, shiftId: saved.shift_id, type: saved.direction, amount: Number(saved.amount_rupiah), reason: saved.reason, category: saved.category, at: saved.occurred_at, approvalStatus: saved.approval_status, requestedById: saved.requested_by, approvedBy: saved.approved_by, approvedAt: saved.approved_at };
    } else {
      const inserted = await client.query(
        `INSERT INTO cash_movements(id,shift_id,direction,amount_rupiah,reason,category,occurred_at,approval_status,requested_by,approved_by,approved_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id,shift_id,direction,amount_rupiah,reason,category,occurred_at,approval_status,requested_by,approved_by,approved_at`,
        [m.id, m.shiftId, m.type, m.amount, m.reason.trim(), m.category || 'Operasional', m.at, approvalStatus, requestedBy, approvedBy, approvedAt],
      );
      const saved = inserted.rows[0];
      canonical = { id: saved.id, shiftId: saved.shift_id, type: saved.direction, amount: Number(saved.amount_rupiah), reason: saved.reason, category: saved.category, at: saved.occurred_at, approvalStatus: saved.approval_status, requestedById: saved.requested_by, approvedBy: saved.approved_by, approvedAt: saved.approved_at };
    }
    const shift = await client.query('SELECT metadata FROM shifts WHERE id=$1 AND outlet_id=$2 FOR UPDATE', [m.shiftId, scope]);
    if (shift.rowCount) {
      const metadata = shift.rows[0].metadata || {};
      metadata.cashiers = [...new Set([...(metadata.cashiers || []), actor.name])];
      await client.query('UPDATE shifts SET metadata=$2 WHERE id=$1', [m.shiftId, metadata]);
    }
    canonical.cashier = actor.name;
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [canonical, deviceId, event.id]);
  } else if (event.type === 'cash.approval') {
    const approval = event.payload;
    if (!isUuid(approval.id) || !['approved','rejected'].includes(approval.approvalStatus)) throw Object.assign(new Error('Keputusan persetujuan kas tidak valid.'), { status: 400 });
    const existing = await client.query(
      `SELECT m.id,m.approval_status FROM cash_movements m JOIN shifts s ON s.id=m.shift_id
       WHERE m.id=$1 AND s.outlet_id=$2 FOR UPDATE OF m`, [approval.id, scope],
    );
    if (!existing.rowCount) throw Object.assign(new Error('Permintaan kas keluar tidak ditemukan.'), { status: 404 });
    if (existing.rows[0].approval_status !== 'pending') throw Object.assign(new Error('Permintaan kas keluar sudah diproses.'), { status: 409 });
    const decidedAt = new Date().toISOString();
    const updated = await client.query(
      `UPDATE cash_movements SET approval_status=$2,approved_by=$3,approved_at=$4 WHERE id=$1
       RETURNING id,approval_status,approved_by,approved_at`, [approval.id, approval.approvalStatus, actor.name, decidedAt],
    );
    const saved = updated.rows[0], canonical = { id: saved.id, approvalStatus: saved.approval_status, approvedBy: saved.approved_by, approvedAt: saved.approved_at };
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [canonical, deviceId, event.id]);
  }
}

