export function isAttendanceLocation(value) {
  if (value == null) return true;
  return typeof value === 'object' && !Array.isArray(value) &&
    Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 &&
    Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180 &&
    Number.isFinite(value.accuracy) && value.accuracy >= 0 &&
    typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt));
}

export function filterRemoteSyncEvents(events, role, deviceId) {
  return events.filter(event => event.device_id !== deviceId).map(event => {
    if (role !== 'Kasir' || event.event_type !== 'attendance.upsert') return event;
    const { checkInLocation, checkOutLocation, ...payload } = event.payload || {};
    return { ...event, payload };
  });
}
