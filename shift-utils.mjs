const excludedSaleStatuses = new Set(['Void', 'Gagal', 'Menunggu']);

export function expectedCashForShift(shift, sales = [], cashMovements = []) {
  if (!shift || typeof shift.id !== 'string') return 0;
  const cashSales = sales
    .filter(sale => !excludedSaleStatuses.has(sale.status))
    .flatMap(sale => (sale.payments || []).filter(payment => payment.method === 'Tunai'
      && (payment.shiftId || sale.shiftId) === shift.id))
    .reduce((total, payment) => total + payment.amount, 0);
  const movementTotal = cashMovements
    .filter(movement => movement.shiftId === shift.id)
    .reduce((total, movement) => total + (movement.type === 'in' ? movement.amount : -movement.amount), 0);
  return shift.openingCash + cashSales + movementTotal;
}
