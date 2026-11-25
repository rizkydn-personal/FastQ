export function isAttendanceLocation(value) {
  if (value == null) return true;
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    Number.isFinite(value.accuracy) &&
    value.accuracy >= 0 &&
    typeof value.capturedAt === 'string' &&
    Number.isFinite(Date.parse(value.capturedAt))
  );
}

export function filterRemoteSyncEvents(events, role, deviceId) {
  return events
    .filter((event) => event.device_id !== deviceId)
    .map((event) => {
      if (role !== 'Kasir') return event;
      if (event.event_type === 'attendance.upsert') {
        const { checkInLocation, checkOutLocation, ...payload } = event.payload || {};
        return { ...event, payload };
      }
      if (event.event_type === 'sale.upsert') {
        const payload = event.payload || {};
        return {
          ...event,
          payload: {
            ...payload,
            items: Array.isArray(payload.items)
              ? payload.items.map(({ cost, ...item }) => item)
              : payload.items,
          },
        };
      }
      if (event.event_type === 'product.upsert') {
        const { cost, cost_rupiah, ...product } = event.payload || {};
        if (Array.isArray(product.variants)) {
          product.variants = product.variants.map(
            ({ cost: variantCost, cost_rupiah: variantCostRupiah, ...variant }) => variant,
          );
        }
        return { ...event, payload: product };
      }
      if (event.event_type === 'product.bulkUpsert') {
        const payload = event.payload || {};
        return {
          ...event,
          payload: {
            ...payload,
            products: Array.isArray(payload.products)
              ? payload.products.map(({ cost, ...product }) => product)
              : payload.products,
          },
        };
      }
      return event;
    });
}
