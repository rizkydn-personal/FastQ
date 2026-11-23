export const numberFormatter = new Intl.NumberFormat('id-ID');

export const formatRupiah = (amount) =>
  `Rp ${numberFormatter.format(Math.round(Number(amount) || 0))}`;

export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
