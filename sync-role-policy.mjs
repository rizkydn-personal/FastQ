export const roleEventTypes = Object.freeze({
  Pemilik: new Set(['audit.append','cash.upsert','cash.approval','discount.approval','discount.cancel']),
  Manajer: new Set(['audit.append']),
  Admin: new Set(['outlet.upsert','product.upsert','product.favorite','product.delete','customer.upsert','shift.upsert','sale.upsert','cash.upsert','cash.approval','discount.approval','discount.cancel','receivable.payment','transfer.upsert','audit.append','stock.delta','stock.reconcile','attendance.upsert']),
  Kasir: new Set(['shift.upsert','sale.upsert','product.favorite','cash.upsert','attendance.upsert','receivable.payment','audit.append','stock.delta','discount.request','discount.cancel']),
});
