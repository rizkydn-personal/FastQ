export const createUuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export function createSaleNumber(id, at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const suffix = String(id ?? '')
    .replace(/-/g, '')
    .slice(0, 16)
    .toUpperCase();
  if (Number.isNaN(date.getTime()) || !/^[0-9A-F]{16}$/.test(suffix)) {
    throw new TypeError('ID transaksi atau waktu tidak valid.');
  }
  const dateCode = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `TRX-${dateCode}-${suffix}`;
}
