import {
  CASHIER_ITEM_DISCOUNT_MAX_PERCENT,
  CASHIER_TRANSACTION_DISCOUNT_MAX_PERCENT,
} from './cart-utils.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && uuidPattern.test(value);

export { CASHIER_ITEM_DISCOUNT_MAX_PERCENT, CASHIER_TRANSACTION_DISCOUNT_MAX_PERCENT };

export function lineDiscountRupiah(item) {
  const amount = item.price * item.qty;
  if (item.discount?.kind === 'percent') return Math.round((amount * item.discount.value) / 100);
  if (item.discount?.kind === 'amount')
    return Math.min(amount, Math.round(item.discount.value || 0));
  return 0;
}

export function createRefundRecord({
  sale,
  reason,
  method = 'Tunai',
  reference = null,
  restocked = false,
  approvedByName,
  id,
  at,
}) {
  if (!sale || !['Lunas', 'Piutang'].includes(sale.status))
    throw new TypeError('Transaksi tidak dapat direfund.');
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500)
    throw new TypeError('Alasan refund wajib diisi (maksimal 500 karakter).');
  if (typeof method !== 'string' || !method.trim() || method.length > 40)
    throw new TypeError('Metode refund tidak valid.');
  if (reference != null && (typeof reference !== 'string' || reference.length > 120))
    throw new TypeError('Referensi refund tidak valid.');
  if (typeof approvedByName !== 'string' || !approvedByName.trim() || approvedByName.length > 80)
    throw new TypeError('Nama pengelola yang menyetujui refund wajib diisi.');
  if (!isUuid(id) || !Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.now() + 5 * 60_000)
    throw new TypeError('Identitas atau waktu refund tidak valid.');
  const outstanding = sale.status === 'Piutang' ? Number(sale.outstanding || 0) : 0;
  const total = Number(sale.total);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(outstanding) ||
    outstanding < 0 ||
    outstanding > total
  )
    throw new TypeError('Nilai piutang transaksi tidak valid.');
  return {
    id,
    amount: total - outstanding,
    cancelledOutstanding: outstanding,
    method: method.trim(),
    reference: typeof reference === 'string' && reference.trim() ? reference.trim() : null,
    reason: reason.trim(),
    approvedByName: approvedByName.trim(),
    at,
    restocked: !!restocked,
  };
}

function itemDiscountExceedsCashierLimit(item) {
  if (!item.discount) return false;
  const lineAmount = item.price * item.qty;
  if (item.discount.kind === 'percent')
    return item.discount.value > CASHIER_ITEM_DISCOUNT_MAX_PERCENT;
  if (item.discount.kind === 'amount')
    return (
      Math.round(item.discount.value) >
      Math.round((lineAmount * CASHIER_ITEM_DISCOUNT_MAX_PERCENT) / 100)
    );
  return false;
}

// Mengembalikan pesan pelanggaran bila transaksi kasir melampaui kewenangan
// diskonnya, atau null bila masih dalam batas. Dipanggil server-side di
// applySaleEvent untuk transaksi baru dari Kasir; asumsikan payload sudah lolos
// validateSalePayload.
export function cashierDiscountViolation(s) {
  for (const item of s.items) {
    if (itemDiscountExceedsCashierLimit(item)) {
      if (item.discount?.pendingApproval !== true || !isUuid(item.discount.approvalRequestId)) {
        return 'Diskon item di atas 10% hanya dapat diberikan kasir dengan permintaan persetujuan yang tercatat.';
      }
    }
  }
  const itemDiscountTotal = Math.min(
    s.subtotal,
    Math.round(s.items.reduce((sum, item) => sum + lineDiscountRupiah(item), 0)),
  );
  const transactionDiscount = Math.max(0, s.discount - itemDiscountTotal);
  const transactionBase = Math.max(0, s.subtotal - itemDiscountTotal);
  if (
    transactionDiscount >
    Math.round((transactionBase * CASHIER_TRANSACTION_DISCOUNT_MAX_PERCENT) / 100)
  ) {
    return 'Diskon transaksi di atas 10% tidak dapat diberikan kasir; terapkan sebagai diskon item yang dimintakan persetujuan, atau minta Admin.';
  }
  return null;
}

export function validateSalePayload(s) {
  const fail = (message) => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  if (
    !isUuid(s.id) ||
    typeof s.number !== 'string' ||
    !s.number.trim() ||
    s.number.length > 80 ||
    !['Lunas', 'Piutang', 'Void', 'Dikembalikan'].includes(s.status)
  )
    fail('Identitas atau status transaksi tidak valid.');
  if (!Number.isFinite(Date.parse(s.at)) || Date.parse(s.at) > Date.now() + 5 * 60_000)
    fail('Waktu transaksi tidak valid.');
  for (const field of ['subtotal', 'discount', 'tax', 'service', 'total']) {
    if (!Number.isSafeInteger(s[field]) || s[field] < 0)
      fail(`Nilai ${field} harus berupa Rupiah bulat yang valid.`);
  }
  if (s.tax !== 0) fail('Nilai tax transaksi harus 0.');
  if (s.discount > s.subtotal || s.total !== s.subtotal - s.discount + s.tax + s.service)
    fail('Total transaksi tidak sesuai dengan subtotal, diskon, dan biaya layanan.');
  if (!Array.isArray(s.items) || !s.items.length || s.items.length > 500)
    fail('Transaksi harus memiliki 1 sampai 500 item.');
  for (const item of s.items) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !isUuid(item.productId) ||
      (item.variantId != null && !isUuid(item.variantId)) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 204 ||
      (item.sku != null && (typeof item.sku !== 'string' || item.sku.length > 40)) ||
      (item.note != null && (typeof item.note !== 'string' || item.note.length > 100)) ||
      !Number.isFinite(item.qty) ||
      item.qty <= 0 ||
      item.qty > 1_000_000 ||
      Math.abs(item.qty * 1000 - Math.round(item.qty * 1000)) > 1e-6 ||
      !Number.isSafeInteger(item.price) ||
      item.price < 0 ||
      !Number.isSafeInteger(item.cost || 0) ||
      (item.cost || 0) < 0
    )
      fail('Item transaksi tidak valid.');
    const lineAmount = item.price * item.qty;
    if (!Number.isSafeInteger(Math.round(lineAmount))) fail('Nilai item melebihi batas Rupiah.');
    const discount = item.discount;
    if (
      discount &&
      (discount.kind === 'percent'
        ? !Number.isFinite(discount.value) || discount.value < 0 || discount.value > 100
        : discount.kind === 'amount'
          ? !Number.isSafeInteger(discount.value) ||
            discount.value < 0 ||
            discount.value > lineAmount
          : true)
    )
      fail('Diskon item tidak valid.');
  }
  const calculatedSubtotal = Math.round(
    s.items.reduce((sum, item) => sum + item.price * item.qty, 0),
  );
  if (calculatedSubtotal !== s.subtotal) fail('Subtotal tidak sama dengan jumlah item transaksi.');
  const calculatedItemDiscount = Math.min(
    s.subtotal,
    Math.round(
      s.items.reduce((sum, item) => {
        const amount = item.price * item.qty;
        if (item.discount?.kind === 'percent') return sum + (amount * item.discount.value) / 100;
        if (item.discount?.kind === 'amount') return sum + Math.min(amount, item.discount.value);
        return sum;
      }, 0),
    ),
  );
  if (s.discount < calculatedItemDiscount)
    fail('Diskon transaksi lebih kecil dari diskon item yang tercatat.');
  if (!Array.isArray(s.payments) || s.payments.length > 20) fail('Daftar pembayaran tidak valid.');
  let paid = 0;
  for (const payment of s.payments) {
    if (
      !payment ||
      typeof payment !== 'object' ||
      Array.isArray(payment) ||
      (payment.id != null && !isUuid(payment.id)) ||
      (payment.shiftId != null && !isUuid(payment.shiftId)) ||
      typeof payment.method !== 'string' ||
      !payment.method.trim() ||
      payment.method.length > 40 ||
      (payment.status != null &&
        (typeof payment.status !== 'string' || payment.status.length > 40)) ||
      (payment.reference != null &&
        (typeof payment.reference !== 'string' || payment.reference.length > 120)) ||
      (payment.at != null &&
        (typeof payment.at !== 'string' ||
          payment.at.length > 40 ||
          !Number.isFinite(Date.parse(payment.at)) ||
          Date.parse(payment.at) > Date.now() + 5 * 60_000)) ||
      !Number.isSafeInteger(payment.amount) ||
      payment.amount < 0
    )
      fail('Pembayaran transaksi tidak valid.');
    for (const field of ['received', 'change'])
      if (payment[field] != null && (!Number.isSafeInteger(payment[field]) || payment[field] < 0))
        fail('Jumlah diterima atau kembalian tidak valid.');
    if (
      (payment.received != null || payment.change != null) &&
      (!Number.isSafeInteger(payment.received) ||
        !Number.isSafeInteger(payment.change) ||
        payment.received - payment.amount !== payment.change)
    )
      fail('Jumlah diterima dan kembalian tidak sesuai dengan pembayaran.');
    paid += payment.amount;
    if (!Number.isSafeInteger(paid)) fail('Jumlah pembayaran melebihi batas Rupiah.');
  }
  const outstanding = s.status === 'Piutang' ? s.outstanding : s.outstanding || 0;
  const settlement = paid + outstanding;
  if (
    !Number.isSafeInteger(outstanding) ||
    outstanding < 0 ||
    (s.status === 'Void' ? settlement > s.total : settlement !== s.total)
  )
    fail('Pembayaran dan sisa piutang tidak sesuai dengan total transaksi.');
}
