import { roleEventTypes } from './sync-role-policy.mjs';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const outletStateDefaults = {
  products: [],
  sales: [],
  holds: [],
  cashMovements: [],
  shifts: [],
  activeShift: null,
  stockMovements: [],
  transfers: [],
  customers: [],
  receivablePayments: [],
  attendance: [],
  discountRequests: [],
  audit: [],
  users: [],
  syncOutbox: [],
  syncIssues: [],
  syncCursor: 0,
  syncInitialized: false,
  syncConflict: null,
};
const outletStateFields = Object.keys(outletStateDefaults);

export function collectPendingStockDeltas(events) {
  const deltas = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || event.type !== 'stock.delta' && event.type !== 'stock.reconcile') continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const quantity = event.type === 'stock.reconcile'
      ? Number(payload.quantity) - Number(payload.expectedServerQuantity)
      : Number(payload.delta);
    if (!Number.isFinite(quantity)) continue;
    const key = `${payload.outletId || event.outletId}|${payload.productId}|${payload.variantId || ''}`;
    deltas.set(key, (deltas.get(key) || 0) + quantity);
  }
  return deltas;
}

export function mergeStockSnapshot(state, outletId, balances, pendingEvents = []) {
  if (!state || !Array.isArray(state.products) || typeof outletId !== 'string' || !outletId || !Array.isArray(balances)) {
    throw new TypeError('Stock snapshot requires valid state, outlet, and balances.');
  }
  const serverQuantities = new Map();
  for (const balance of balances) {
    if (!balance || typeof balance.productId !== 'string' || !balance.productId
      || balance.variantId != null && typeof balance.variantId !== 'string'
      || balance.outletId !== outletId) {
      throw new TypeError('Stock snapshot contains an invalid balance identity.');
    }
    const quantity = Number(balance.quantity);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity >= 1e15) {
      throw new TypeError('Stock snapshot contains an invalid quantity.');
    }
    serverQuantities.set(`${balance.productId}|${balance.variantId || ''}`, quantity);
  }

  const pendingDeltas = collectPendingStockDeltas(pendingEvents);
  const quantityFor = (productId, variantId) =>
    (serverQuantities.get(`${productId}|${variantId || ''}`) || 0)
    + (pendingDeltas.get(`${outletId}|${productId}|${variantId || ''}`) || 0);

  for (const product of state.products) {
    if (!product || typeof product.id !== 'string') continue;
    product.stockByOutlet ||= {};
    if (Array.isArray(product.variants) && product.variants.length) {
      let total = 0;
      for (const variant of product.variants) {
        if (!variant || typeof variant.id !== 'string') continue;
        const quantity = quantityFor(product.id, variant.id);
        variant.stockByOutlet ||= {};
        variant.stockByOutlet[outletId] = quantity;
        variant.stock = quantity;
        if (!variant.retired) total += quantity;
      }
      product.stockByOutlet[outletId] = total;
      product.stock = total;
    } else {
      const quantity = quantityFor(product.id, null);
      product.stockByOutlet[outletId] = quantity;
      product.stock = quantity;
    }
  }
}

export function switchOutletLocalState(state, outletId) {
  if (!state || typeof outletId !== 'string' || !outletId) throw new TypeError('Outlet state requires a valid outlet ID.');
  state.settings ||= {};
  if (!state.localOutletPartitions || typeof state.localOutletPartitions !== 'object' || Array.isArray(state.localOutletPartitions)) {
    state.localOutletPartitions = {};
  }
  const currentOutletId = state.settings.localDataOutletId || state.settings.serverSession?.user?.outletId || state.activeOutlet || 'unbound';
  if (currentOutletId === outletId) {
    state.settings.localDataOutletId = outletId;
    state.activeOutlet = outletId;
    return false;
  }
  state.localOutletPartitions[currentOutletId] = Object.fromEntries(outletStateFields.map(field => [
    field,
    structuredClone(state[field] ?? outletStateDefaults[field]),
  ]));
  const next = state.localOutletPartitions[outletId] || {};
  for (const field of outletStateFields) state[field] = structuredClone(next[field] ?? outletStateDefaults[field]);
  state.settings.localDataOutletId = outletId;
  state.activeOutlet = outletId;
  return true;
}

export function mergeShiftEvent(state, shift) {
  if (!shift?.id) return null;
  state.shifts ||= [];
  let current = state.shifts.find(item => item.id === shift.id);
  if (current?.closedAt && !shift.closedAt) {
    if (state.activeShift?.id === shift.id) state.activeShift = null;
    return state.activeShift;
  }
  if (current) Object.assign(current, shift);
  else {
    current = shift;
    state.shifts.push(current);
  }
  state.shifts.sort((a, b) => Date.parse(b.openedAt || 0) - Date.parse(a.openedAt || 0));
  if (shift.closedAt) {
    if (state.activeShift?.id === shift.id) state.activeShift = null;
  } else {
    state.activeShift = current;
  }
  return state.activeShift;
}

export function restoreActiveShift(state, outletId) {
  state.shifts ||= [];
  const closedIds = new Set(state.shifts.filter(shift => shift.closedAt).map(shift => shift.id));
  const current = state.activeShift;
  if (current && !current.closedAt && !closedIds.has(current.id) && (!current.outletId || current.outletId === outletId)) return current;
  const open = state.shifts
    .filter(shift => !shift.closedAt && !closedIds.has(shift.id) && (!shift.outletId || shift.outletId === outletId))
    .sort((a, b) => Date.parse(a.openedAt || 0) - Date.parse(b.openedAt || 0))
    .at(-1) || null;
  state.activeShift = open;
  return open;
}

export function shiftCashierNames(state, shift) {
  if (!shift?.id) return [];
  const names = new Set(Array.isArray(shift.cashiers) ? shift.cashiers.filter(name => typeof name === 'string' && name) : []);
  if (shift.cashier) names.add(shift.cashier);
  for (const sale of state.sales || []) if (sale.shiftId === shift.id && sale.cashier) names.add(sale.cashier);
  for (const movement of state.cashMovements || []) if (movement.shiftId === shift.id && movement.cashier) names.add(movement.cashier);
  return [...names];
}

function matchesLegacyDiscountSale(sale, event, request) {
  return sale.outletId === event.outletId && sale.shiftId === request.shiftId && sale.status === 'Lunas'
    && sale.items?.some(item => item.productId === request.productId && (item.variantId || null) === (request.variantId || null)
      && item.qty === request.quantity && item.price * item.qty === request.baseAmount
      && item.discount?.kind === request.kind && item.discount?.value === request.value);
}

export function prepareSyncOutbox({ events = [], sales = [], issues = [], outletId, role }) {
  const validEvents = Array.isArray(events) ? events.filter(event => event && typeof event === 'object' && !Array.isArray(event)) : [];
  const scopedOutbox = validEvents.filter(event => event.outletId === outletId);
  const deferredTransferEvents = validEvents.filter(event => event.type === 'transfer.upsert'
    && (!event.payload?.from || !event.payload?.to || event.payload.from === event.payload.to
      || event.payload.from !== outletId || event.payload.to !== outletId));
  const deferredTransfers = deferredTransferEvents.map(event => event.payload).filter(transfer => transfer && typeof transfer === 'object');
  const transferStockKeys = new Set();
  const stockKey = (productId, variantId, stockOutletId, quantity, reason) => JSON.stringify([
    productId, variantId || null, stockOutletId, quantity, reason,
  ]);
  for (const transfer of deferredTransfers) {
    const quantity = Number(transfer.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    transferStockKeys.add(stockKey(transfer.productId, transfer.variantId, transfer.from, quantity, `Transfer ke ${transfer.to}`));
    transferStockKeys.add(stockKey(transfer.productId, transfer.variantId, transfer.to, quantity, `Transfer dari ${transfer.from}`));
  }
  const deferredTransferSet = new Set(deferredTransferEvents);
  const transferStockEvents = new Set(scopedOutbox.filter(event => deferredTransferSet.has(event)));
  for (const event of scopedOutbox) {
    if (event.type !== 'stock.delta') continue;
    const payload = event.payload || {};
    if (transferStockKeys.has(stockKey(payload.productId, payload.variantId, payload.outletId,
      Math.abs(Number(payload.delta)), payload.reason))) {
      transferStockEvents.add(event);
    }
  }
  const activeIssues = (Array.isArray(issues) ? issues : []).filter(issue => validEvents.some(event => event.id === issue.eventId));
  const newIssues = [];
  let changed = activeIssues.length !== issues.length;

  for (const event of scopedOutbox) {
    const request = event.type === 'discount.request' ? event.payload : null;
    if (!request || (typeof request.saleId === 'string' && uuidPattern.test(request.saleId))) continue;

    const matches = sales.filter(sale => matchesLegacyDiscountSale(sale, event, request));
    if (matches.length === 1) {
      request.saleId = matches[0].id;
      request.saleNumber = matches[0].number;
      request.paidAt = matches[0].at;
      const remainingIssues = activeIssues.filter(issue => issue.eventId !== event.id);
      if (remainingIssues.length !== activeIssues.length) {
        activeIssues.splice(0, activeIssues.length, ...remainingIssues);
      }
      changed = true;
    } else if (!activeIssues.some(issue => issue.eventId === event.id)) {
      activeIssues.push({ eventId: event.id, message: 'Permintaan diskon lama tidak terhubung ke transaksi yang dapat diverifikasi.' });
      newIssues.push(event.id);
      changed = true;
    }
  }

  const blockedRequestIds = new Set(scopedOutbox
    .filter(event => event.type === 'discount.request' && event.payload?.id && activeIssues.some(issue => issue.eventId === event.id))
    .map(event => event.payload?.id));
  for (const event of scopedOutbox) {
    if (!['discount.approval','discount.cancel'].includes(event.type) || !blockedRequestIds.has(event.payload?.id)) continue;
    if (!activeIssues.some(issue => issue.eventId === event.id)) {
      activeIssues.push({ eventId: event.id, message: 'Keputusan diskon menunggu permintaan lama yang belum tersinkron.' });
      newIssues.push(event.id);
      changed = true;
    }
  }

  const issueIds = new Set(activeIssues.map(issue => issue.eventId));
  const allowedTypes = roleEventTypes[role] || new Set();
  const canSync = event => allowedTypes.has(event.type);
  const eligible = scopedOutbox.filter(event => !transferStockEvents.has(event));

  return {
    scopedOutbox,
    pending: eligible.filter(event => canSync(event) && !issueIds.has(event.id)),
    deferredCount: scopedOutbox.filter(event => !canSync(event) && !issueIds.has(event.id)).length
      + transferStockEvents.size,
    issues: activeIssues,
    newIssues,
    reviewCount: scopedOutbox.filter(event => issueIds.has(event.id)).length,
    changed,
  };
}
