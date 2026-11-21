export const fmt = new Intl.NumberFormat('id-ID');
export const rupiah = n => 'Rp ' + fmt.format(Math.round(Number(n) || 0));
export const cashDifferenceText = n => n === 0 ? 'Rp. 0' : `${n > 0 ? '+ ' : '- '}${rupiah(Math.abs(n))}`;
export const today = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const uid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export function createSaleNumber(id, at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const suffix = String(id ?? '').replace(/-/g, '').slice(0, 16).toUpperCase();
  if (Number.isNaN(date.getTime()) || !/^[0-9A-F]{16}$/.test(suffix)) {
    throw new TypeError('ID transaksi atau waktu tidak valid.');
  }
  const dateCode = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `TRX-${dateCode}-${suffix}`;
}
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const formatRupiahInputValue = value => String(value ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export const parseRupiahInput = value => Number(String(value ?? '').replace(/\D/g, '')) || 0;
export function parseCSV(text) {
  text = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
