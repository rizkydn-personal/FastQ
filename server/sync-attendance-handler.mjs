import { isAttendanceLocation } from './attendance-policy.mjs';

export async function applyAttendanceEvent({ client, event, scope, actor, deviceId, isUuid }) {
  if (event.type === 'attendance.upsert') {
    const attendance = event.payload,
      datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const checkInAt = typeof attendance.checkIn === 'string' ? Date.parse(attendance.checkIn) : NaN;
    const checkOutAt =
      typeof attendance.checkOut === 'string' ? Date.parse(attendance.checkOut) : NaN;
    const workDateAt = datePattern.test(attendance.workDate || '')
      ? Date.parse(`${attendance.workDate}T00:00:00Z`)
      : NaN;
    if (
      !isUuid(attendance.id) ||
      !isUuid(attendance.userId) ||
      !Number.isFinite(workDateAt) ||
      new Date(workDateAt).toISOString().slice(0, 10) !== attendance.workDate ||
      !Number.isFinite(checkInAt) ||
      checkInAt > Date.now() + 5 * 60_000 ||
      (attendance.checkOut != null &&
        (!Number.isFinite(checkOutAt) || checkOutAt > Date.now() + 5 * 60_000)) ||
      !isAttendanceLocation(attendance.checkInLocation) ||
      !isAttendanceLocation(attendance.checkOutLocation)
    ) {
      throw Object.assign(new Error('Data absensi tidak valid.'), { status: 400 });
    }
    if (actor.role === 'Kasir' && attendance.userId !== actor.id)
      throw Object.assign(new Error('Kasir hanya dapat menyinkronkan absensinya sendiri.'), {
        status: 403,
      });
    const employee = await client.query(
      'SELECT name FROM users WHERE id=$1 AND outlet_id=$2 AND active=true',
      [attendance.userId, scope],
    );
    if (!employee.rowCount)
      throw Object.assign(new Error('Pengguna absensi tidak ditemukan di toko aktif.'), {
        status: 404,
      });
    const idOwner = await client.query(
      'SELECT outlet_id,user_id,work_date::text AS work_date FROM attendance WHERE id=$1 FOR UPDATE',
      [attendance.id],
    );
    if (
      idOwner.rowCount &&
      (idOwner.rows[0].outlet_id !== scope ||
        idOwner.rows[0].user_id !== attendance.userId ||
        idOwner.rows[0].work_date !== attendance.workDate)
    ) {
      throw Object.assign(new Error('ID absensi sudah digunakan untuk data lain.'), {
        status: 409,
      });
    }
    const current = await client.query(
      'SELECT id,user_name,work_date,check_in,check_out,check_in_location,check_out_location FROM attendance WHERE outlet_id=$1 AND user_id=$2 AND work_date=$3 FOR UPDATE',
      [scope, attendance.userId, attendance.workDate],
    );
    let canonical;
    if (current.rowCount) {
      const saved = current.rows[0];
      if (!saved.check_in_location && attendance.checkInLocation) {
        await client.query('UPDATE attendance SET check_in_location=$2 WHERE id=$1', [
          saved.id,
          attendance.checkInLocation,
        ]);
        saved.check_in_location = attendance.checkInLocation;
      }
      if (attendance.checkOut && !saved.check_out) {
        if (Date.parse(attendance.checkOut) <= new Date(saved.check_in).getTime())
          throw Object.assign(new Error('Jam pulang harus setelah jam masuk.'), { status: 400 });
        await client.query('UPDATE attendance SET check_out=$2,check_out_location=$3 WHERE id=$1', [
          saved.id,
          attendance.checkOut,
          attendance.checkOutLocation || null,
        ]);
        saved.check_out = new Date(attendance.checkOut);
        saved.check_out_location = attendance.checkOutLocation || null;
      }
      canonical = {
        id: saved.id,
        outletId: scope,
        userId: attendance.userId,
        userName: saved.user_name,
        workDate: String(saved.work_date),
        checkIn: saved.check_in,
        checkOut: saved.check_out,
        checkInLocation: saved.check_in_location,
        checkOutLocation: saved.check_out_location,
      };
    } else {
      if (attendance.checkOut)
        throw Object.assign(new Error('Absensi pulang belum memiliki absensi masuk.'), {
          status: 400,
        });
      const inserted = await client.query(
        `INSERT INTO attendance(id,outlet_id,user_id,user_name,work_date,check_in,check_in_location) VALUES($1,$2,$3,$4,$5,$6,$7)
             RETURNING id,user_name,work_date,check_in,check_out,check_in_location,check_out_location`,
        [
          attendance.id,
          scope,
          attendance.userId,
          employee.rows[0].name,
          attendance.workDate,
          attendance.checkIn,
          attendance.checkInLocation || null,
        ],
      );
      const saved = inserted.rows[0];
      canonical = {
        id: saved.id,
        outletId: scope,
        userId: attendance.userId,
        userName: saved.user_name,
        workDate: String(saved.work_date),
        checkIn: saved.check_in,
        checkOut: saved.check_out,
        checkInLocation: saved.check_in_location,
        checkOutLocation: saved.check_out_location,
      };
    }
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [
      canonical,
      deviceId,
      event.id,
    ]);
  }
}
