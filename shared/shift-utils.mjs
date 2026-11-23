const excludedSaleStatuses = new Set(['Void', 'Gagal', 'Menunggu']);

export function expectedCashForShift(shift, sales = [], cashMovements = []) {
  if (!shift || typeof shift.id !== 'string') return 0;
  const cashSales = sales
    .filter((sale) => !excludedSaleStatuses.has(sale.status))
    .flatMap((sale) =>
      (sale.payments || []).filter(
        (payment) => payment.method === 'Tunai' && (payment.shiftId || sale.shiftId) === shift.id,
      ),
    )
    .reduce((total, payment) => total + (Number(payment.amount) || 0), 0);
  const movementTotal = cashMovements
    .filter(
      (movement) =>
        movement.shiftId === shift.id &&
        movement.approvalStatus !== 'pending' &&
        movement.approvalStatus !== 'rejected',
    )
    .reduce((total, movement) => {
      const amount = Number(movement.amount) || 0;
      return total + (movement.type === 'in' ? amount : -amount);
    }, 0);
  return (Number(shift.openingCash) || 0) + cashSales + movementTotal;
}
