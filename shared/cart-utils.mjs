// Batas kewenangan diskon kasir (T2) — satu-satunya sumber nilai ambang ini.
// Dipakai server (sale-policy.mjs) dan klien kasir (app/pos).
// Diskon item di atas ambang ini hanya boleh masuk ke transaksi bila tercatat
// sebagai permintaan persetujuan (pendingApproval + approvalRequestId);
// diskon transaksi di atas ambang ini tidak dapat diberikan kasir sama sekali
// karena skema saat ini tidak punya alur persetujuan untuk diskon transaksi.
export const CASHIER_ITEM_DISCOUNT_MAX_PERCENT = 10;
export const CASHIER_TRANSACTION_DISCOUNT_MAX_PERCENT = 10;

export function calculateCartTotals(cart = [], cartDiscount = null, settings = {}) {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const itemDiscount = Math.min(
    subtotal,
    Math.round(
      cart.reduce(
        (sum, item) =>
          sum +
          item.price *
            item.qty *
            (item.discount?.kind === 'percent' ? item.discount.value / 100 : 0) +
          (item.discount?.kind === 'amount'
            ? Math.min(item.discount.value, item.price * item.qty)
            : 0),
        0,
      ),
    ),
  );
  const discountBase = Math.max(0, subtotal - itemDiscount);
  const d = Math.min(
    discountBase,
    Math.round(
      cartDiscount
        ? cartDiscount.kind === 'percent'
          ? (discountBase * cartDiscount.value) / 100
          : cartDiscount.value
        : 0,
    ),
  );
  const serviceBase = Math.max(0, subtotal - itemDiscount - d);
  const tax = 0;
  const service = Math.round((serviceBase * (settings.service || 0)) / 100);
  return {
    subtotal,
    itemDiscount,
    d,
    tax,
    service,
    total: Math.max(0, subtotal - itemDiscount - d + service),
  };
}
