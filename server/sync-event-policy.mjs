import { timestampMs } from './timestamp-utils.mjs';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function matchesStoredSyncEvent(stored, event) {
  let storedPayload = stored?.payload;
  if (typeof storedPayload === 'string') {
    try {
      storedPayload = JSON.parse(storedPayload);
    } catch {
      return false;
    }
  }
  const outletId = event?.outletId || null;
  const occurredAtMatches =
    event?.at == null || timestampMs(stored?.occurred_at) === timestampMs(event.at);
  if (stored?.event_type !== event?.type || stored?.outlet_id !== outletId || !occurredAtMatches)
    return false;
  const incomingPayload = event?.payload;
  // Handler server selalu menulis ulang payload tersimpan dengan versi
  // kanoniknya (sale: tambah item.sku + timpa item.cost + cashier; diskon:
  // tambah outletId/productName; pelanggan: trim field; shift/kas/absen:
  // tambah outletId/nama; dst). Jadi retry yang sah TIDAK PERNAH sama
  // persis dengan payload tersimpan — perbandingan penuh di sini mengubah
  // setiap retry (mis. respons sync hilang karena offline di tengah jalan)
  // menjadi SYNC_EVENT_ID_CONFLICT: outbox macet, lalu logout diblokir
  // karena data tak pernah terkuras. Identitas yang stabil adalah
  // payload.id: event yang sama untuk entitas yang sama adalah duplikat,
  // walau field non-identitas berbeda (kanonikalisasi server, atau mutasi
  // lokal objek yang sama karena payload outbox adalah referensi objek).
  // ID yang sama untuk entitas yang BERBEDA tetap konflik.
  if (
    storedPayload &&
    incomingPayload &&
    typeof storedPayload === 'object' &&
    typeof incomingPayload === 'object' &&
    !Array.isArray(storedPayload) &&
    !Array.isArray(incomingPayload) &&
    typeof storedPayload.id === 'string' &&
    typeof incomingPayload.id === 'string'
  ) {
    return storedPayload.id === incomingPayload.id;
  }
  // Event tanpa payload.id (stock.delta, stock.reconcile, product.favorite,
  // product.delete): handler-nya tidak menulis ulang payload tersimpan,
  // jadi perbandingan penuh tetap aman dan ketat.
  return canonicalJson(storedPayload) === canonicalJson(incomingPayload);
}
