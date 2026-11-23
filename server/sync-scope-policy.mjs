const outletScopeKeys = new Set(['outletId', 'createdOutletId', 'from', 'to']);
const entityIdKeys = new Set(['id', 'productId', 'variantId', 'shiftId', 'customerId', 'saleId']);

export function collectScopedEntityIds(event, { scope, isUuid, budget }) {
  const deny = () => {
    throw Object.assign(
      new Error(
        `Event ${event.type} (${event.id}) memuat data di luar toko akun. Data tetap disimpan di perangkat; gunakan akun toko yang sesuai.`,
      ),
      { status: 403 },
    );
  };
  const ids = new Set();
  const pendingValues = [event.payload];
  let inspectedObjects = 0;
  while (pendingValues.length) {
    const value = pendingValues.pop();
    if (!value || typeof value !== 'object') continue;
    inspectedObjects++;
    if (inspectedObjects > 20_000 || (budget && ++budget.inspectedObjects > 100_000)) {
      throw Object.assign(new Error('Struktur payload sinkronisasi terlalu kompleks.'), {
        status: 400,
      });
    }
    for (const [key, item] of Object.entries(value)) {
      if (outletScopeKeys.has(key) && item != null && item !== scope) deny();
      if (
        key === 'stockByOutlet' &&
        item &&
        typeof item === 'object' &&
        Object.keys(item).some((id) => id !== scope)
      )
        deny();
      if (entityIdKeys.has(key) && isUuid(item)) {
        ids.add(item);
        if (ids.size > 2_000 || (budget && ++budget.entityIds > 10_000)) {
          throw Object.assign(
            new Error('Jumlah referensi entitas dalam sinkronisasi terlalu banyak.'),
            { status: 400 },
          );
        }
      }
      if (item && typeof item === 'object') pendingValues.push(item);
    }
  }
  return ids;
}
