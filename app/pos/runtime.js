import { createPosStorage } from './pos-storage.mjs';
import { calculateCartTotals } from './cart-utils.mjs';
import { createSaleNumber, createUuid } from './pos-utils.mjs';
import { createRefundRecord } from './sale-policy.mjs';
import { expectedCashForShift } from './shift-utils.mjs';
import { roleEventTypes } from './sync-role-policy.mjs';
import {
  collectPendingStockDeltas,
  mergeShiftEvent,
  mergeStockSnapshot,
  prepareSyncOutbox,
  restoreActiveShift,
  switchOutletLocalState,
} from './sync-policy.js';

const PENDING_SERVER_LOGOUT_KEY = 'fastq-pending-server-logout-v1';
const OFFLINE_SESSION_KEY = 'fastq-offline-session-v1';

function readOfflineSessionProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(OFFLINE_SESSION_KEY) || 'null');
    return profile?.user ? profile : null;
  } catch {
    return null;
  }
}

function saveOfflineSessionProfile(session) {
  try {
    const { id, name, role, outletId, outletName, outletCode } = session.user || {};
    localStorage.setItem(
      OFFLINE_SESSION_KEY,
      JSON.stringify({
        user: { id, name, role, outletId, outletName, outletCode },
        expiresAt: session.expiresAt,
      }),
    );
  } catch {}
}

const createEmptyState = () => ({
  products: [],
  sales: [],
  holds: [],
  cashMovements: [],
  shifts: [],
  activeShift: null,
  settings: { service: 0, role: 'Kasir' },
  audit: [],
  stockMovements: [],
  users: [],
  customers: [],
  receivablePayments: [],
  outlets: [],
  activeOutlet: '',
  transfers: [],
  attendance: [],
  discountRequests: [],
  syncOutbox: [],
  syncIssues: [],
  syncCursor: 0,
  deviceId: createUuid(),
  syncInitialized: false,
  catalogInitialized: false,
});
const getLocalDateKey = () => new Date().toLocaleDateString('en-CA');

export async function createPosRuntime({ onChange = () => {}, onToast = () => {}, ui = {} } = {}) {
  const storage = createPosStorage(() => updateSyncStatus('Penyimpanan lokal gagal', 'error'));
  let state = (await storage.readSavedState()) || createEmptyState();
  Object.assign(state, createEmptyState(), state);
  state.settings ||= {};
  state.settings.service = Number(state.settings.service) || 0;
  state.syncOutbox ||= [];
  state.syncIssues ||= [];
  state.audit ||= [];
  state.syncCursor ||= 0;
  state.deviceId ||= createUuid();
  state.products ||= [];
  state.sales ||= [];
  state.shifts ||= [];
  state.cashMovements ||= [];
  state.outlets ||= [];
  state.attendance ||= [];
  state.users ||= [];
  state.transfers ||= [];
  state.holds ||= [];
  let cart = Array.isArray(state.settings.cartDraft)
      ? structuredClone(state.settings.cartDraft)
      : [],
    cartDiscount = state.settings.cartDiscountDraft
      ? structuredClone(state.settings.cartDiscountDraft)
      : null,
    session =
      state.settings.serverSession || state.settings.offlineSession || readOfflineSessionProfile(),
    syncing = false,
    syncAbortController = null,
    syncTimer = null,
    salesLoading = false,
    salesHasMore = false,
    disposed = false,
    status = { label: 'Lokal', state: 'local' };
  const getCurrentRole = () => session?.user?.role || 'Kasir';
  const getCurrentUserName = () => session?.user?.name || 'Kasir';
  const getActiveOutletId = () => session?.user?.outletId || state.activeOutlet;
  const catalogNeedsBootstrap = () => !state.catalogInitialized && state.products.length === 0;
  const offlineStatusLabel = () =>
    catalogNeedsBootstrap()
      ? 'Katalog belum tersimpan · perlu sinkronisasi online'
      : `Offline · ${state.syncOutbox.length} antrean`;
  const publishStateChange = () => {
    if (!disposed) onChange(getStateSnapshot());
  };
  function updateSyncStatus(label, kind = 'local') {
    status = { label, state: kind };
    publishStateChange();
  }
  function showToast(message) {
    onToast(String(message));
  }
  function hasPendingServerLogout() {
    try {
      return localStorage.getItem(PENDING_SERVER_LOGOUT_KEY) === '1';
    } catch {
      return false;
    }
  }
  function setPendingServerLogout(pending) {
    try {
      if (pending) localStorage.setItem(PENDING_SERVER_LOGOUT_KEY, '1');
      else localStorage.removeItem(PENDING_SERVER_LOGOUT_KEY);
    } catch {}
  }
  async function revokePendingServerLogout() {
    if (!navigator.onLine || !hasPendingServerLogout()) return;
    try {
      await sendApiRequest('/api/auth/logout', 'POST', {});
      setPendingServerLogout(false);
    } catch (error) {
      if (error.status === 401) setPendingServerLogout(false);
    }
  }
  function persistState() {
    state.settings.cartDraft = cart.map((item) => ({ ...item }));
    state.settings.cartDiscountDraft = cartDiscount ? { ...cartDiscount } : null;
    state.products.forEach((p) => {
      p.stockByOutlet ||= {};
      p.stockByOutlet[state.activeOutlet] = p.stock;
      (p.variants || []).forEach((v) => {
        v.stockByOutlet ||= {};
        v.stockByOutlet[state.activeOutlet] = v.stock;
      });
    });
    storage.queueEncryptedState(state);
    updateSyncStatus(
      !navigator.onLine
        ? offlineStatusLabel()
        : state.syncOutbox.length
          ? `${state.syncOutbox.length} event menunggu`
          : 'Tersimpan lokal',
      !navigator.onLine ? 'offline' : state.syncOutbox.length ? 'pending' : 'local',
    );
  }
  async function flushPendingWrites() {
    await storage.flushEncryptedWrites();
  }
  function enqueueSyncEvent(type, payload, scope = state.activeOutlet) {
    const event = {
      id: createUuid(),
      type,
      outletId: scope,
      payload,
      at: new Date().toISOString(),
    };
    state.syncOutbox.push(event);
    return event;
  }
  function recordAuditEntry(action, detail = '') {
    const entry = {
      id: createUuid(),
      at: new Date().toISOString(),
      role: getCurrentRole(),
      action,
      detail,
    };
    state.audit.push(entry);
    enqueueSyncEvent('audit.append', entry);
    return entry;
  }
  function sendApiRequest(path, method = 'GET', body, requestSignal = null) {
    const timeoutMs = path === '/api/sync' ? 60000 : path === '/api/auth/logout' ? 3000 : 15000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal,
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = Object.assign(
          new Error(result.error || `Permintaan gagal (HTTP ${response.status})`),
          { status: response.status, code: result.code, conflict: result.conflict },
        );
        throw error;
      }
      return result;
    });
  }
  async function clearSession(clearData = false) {
    session = null;
    delete state.settings.serverSession;
    state.settings.activeUserId = null;
    state.settings.sessionExpiresAt = null;
    if (clearData) {
      await storage.clear();
      state = createEmptyState();
      cart = [];
      cartDiscount = null;
      salesHasMore = false;
    } else persistState();
    publishStateChange();
  }
  function getStateSnapshot() {
    return {
      ready: true,
      authenticated: !!session?.user,
      user: session?.user || null,
      role: getCurrentRole(),
      currentUser: getCurrentUserName(),
      outletId: state.activeOutlet,
      outlet:
        state.outlets.find((x) => x.id === state.activeOutlet)?.name ||
        session?.user?.outletName ||
        'Toko',
      outlets: state.outlets,
      products: state.products.map((p) => ({ ...p, fav: !!p.favorite })),
      cart: cart.map((x) => ({
        ...x,
        itemDiscount:
          x.discount?.kind === 'amount'
            ? x.discount.value
            : x.discount?.kind === 'percent'
              ? Math.round((x.price * x.qty * x.discount.value) / 100)
              : 0,
      })),
      cartDiscount,
      globalDiscount: cartDiscount?.kind === 'amount' ? cartDiscount.value : 0,
      sales: state.sales,
      salesHasMore,
      shifts: state.shifts,
      activeShift: state.activeShift,
      cash: state.cashMovements,
      attendance: state.attendance,
      transfers: state.transfers,
      users: state.users,
      audit: state.audit,
      holds: state.holds,
      syncOutbox: state.syncOutbox,
      status,
    };
  }
  function mergeSyncEvent(event) {
    const d = event.payload || {};
    switch (event.event_type) {
      case 'audit.append':
        if (!state.audit.some((x) => x.id === d.id)) state.audit.push(d);
        break;
      case 'outlet.upsert':
        if (!state.outlets.some((x) => x.id === d.id)) state.outlets.push(d);
        break;
      case 'product.upsert': {
        const old = state.products.find((x) => x.id === d.id);
        if (old) {
          const stock = old.stock,
            byOutlet = old.stockByOutlet;
          Object.assign(old, d);
          old.stock = stock;
          old.stockByOutlet = byOutlet;
        } else state.products.push(d);
        break;
      }
      case 'product.favorite': {
        const p = state.products.find((x) => x.id === d.productId);
        if (p) p.favorite = !!d.favorite;
        break;
      }
      case 'product.delete':
        state.products = state.products.filter((x) => x.id !== d.id && x.sku !== d.sku);
        break;
      case 'stock.delta':
      case 'stock.reconcile': {
        const p = state.products.find((x) => x.id === d.productId),
          v = p?.variants?.find((x) => x.id === d.variantId);
        if (!p) break;
        const item = v || p;
        item.stockByOutlet ||= {};
        const before = Number(item.stockByOutlet[d.outletId] ?? item.stock) || 0;
        item.stockByOutlet[d.outletId] =
          event.event_type === 'stock.reconcile'
            ? Number(d.quantity)
            : Math.max(0, before + Number(d.delta));
        if (d.outletId === state.activeOutlet) item.stock = item.stockByOutlet[d.outletId];
        if (v) p.stock = (p.variants || []).reduce((n, x) => n + Number(x.stock) || 0, 0);
        break;
      }
      case 'sale.upsert': {
        const old = state.sales.find((x) => x.id === d.id);
        if (old) Object.assign(old, d);
        else state.sales.push(d);
        break;
      }
      case 'shift.upsert':
        mergeShiftEvent(state, d);
        break;
      case 'cash.upsert':
      case 'cash.approval': {
        const old = state.cashMovements.find((x) => x.id === d.id);
        if (old) Object.assign(old, d);
        else state.cashMovements.push(d);
        break;
      }
      case 'transfer.upsert':
        if (!state.transfers.some((x) => x.id === d.id)) state.transfers.push(d);
        break;
      case 'attendance.upsert': {
        const old =
          state.attendance.find((x) => x.id === d.id) ||
          state.attendance.find((x) => x.userId === d.userId && x.workDate === d.workDate);
        if (old) Object.assign(old, d);
        else state.attendance.push(d);
        break;
      }
      case 'receivable.payment':
        state.receivablePayments.push(d);
        break;
    }
  }
  async function synchronizeState(manual = false) {
    if (syncing) return;
    if (!session?.user) {
      if (manual) showToast('Login kembali untuk menyinkronkan.');
      return;
    }
    if (!navigator.onLine) {
      updateSyncStatus(offlineStatusLabel(), 'offline');
      if (manual)
        showToast(
          catalogNeedsBootstrap()
            ? 'Katalog belum tersimpan. Sambungkan ke server untuk memulihkan data toko.'
            : 'Perubahan tersimpan di perangkat dan menunggu koneksi.',
        );
      return;
    }
    syncing = true;
    const currentSyncController = new AbortController();
    syncAbortController = currentSyncController;
    updateSyncStatus('Menyinkronkan…', 'syncing');
    try {
      const outlet = getActiveOutletId();
      const prepared = prepareSyncOutbox({
        events: state.syncOutbox,
        sales: state.sales,
        issues: state.syncIssues,
        outletId: outlet,
        role: getCurrentRole(),
      });
      state.syncIssues = prepared.issues;
      if (getCurrentRole() === 'Admin' && !state.syncInitialized) {
        state.syncInitialized = true;
        const pending = state.syncOutbox.slice(),
          deltas = collectPendingStockDeltas(pending);
        for (const store of state.outlets) enqueueSyncEvent('outlet.upsert', store, store.id);
        for (const original of state.products) {
          const p = structuredClone(original);
          p.stockByOutlet = { ...(p.stockByOutlet || {}) };
          for (const id of Object.keys(p.stockByOutlet)) {
            const adjust = Number(deltas.get(`${id}|${p.id}|`) || 0);
            p.stockByOutlet[id] = Math.max(0, Number(p.stockByOutlet[id] || 0) - adjust);
          }
          for (const v of p.variants || []) {
            v.stockByOutlet = { ...(v.stockByOutlet || {}) };
            for (const id of Object.keys(v.stockByOutlet))
              v.stockByOutlet[id] = Math.max(
                0,
                Number(v.stockByOutlet[id] || 0) - Number(deltas.get(`${id}|${p.id}|${v.id}`) || 0),
              );
          }
          p.stock = Number(p.stockByOutlet[outlet] ?? p.stock ?? 0);
          enqueueSyncEvent('product.upsert', p, p.createdOutletId || outlet);
        }
        for (const shift of state.shifts)
          enqueueSyncEvent('shift.upsert', shift, shift.outletId || outlet);
        for (const movement of state.cashMovements)
          enqueueSyncEvent('cash.upsert', movement, movement.outletId || outlet);
        for (const transfer of state.transfers)
          enqueueSyncEvent('transfer.upsert', transfer, transfer.from);
        for (const sale of state.sales)
          enqueueSyncEvent('sale.upsert', sale, sale.outletId || outlet);
        persistState();
      }
      await flushPendingWrites();
      const result = await sendApiRequest(
        '/api/sync',
        'POST',
        {
          deviceId: state.deviceId,
          cursor: state.syncCursor,
          activeShiftId: state.activeShift?.id || null,
          bootstrap: !state.catalogInitialized,
          events: prepared.pending.slice(0, 5),
        },
        currentSyncController.signal,
      );
      const accepted = new Set(result.accepted || []);
      const acceptedTransfers = state.syncOutbox
        .filter((event) => accepted.has(event.id) && event.type === 'transfer.upsert')
        .map((event) => event.payload);
      state.syncOutbox = state.syncOutbox.filter((event) => {
        if (accepted.has(event.id)) return false;
        if (event.type !== 'stock.delta') return true;
        const delta = event.payload || {};
        return !acceptedTransfers.some(
          (transfer) =>
            delta.productId === transfer.productId &&
            (delta.variantId || null) === (transfer.variantId || null) &&
            ((delta.outletId === transfer.from &&
              Number(delta.delta) === -Number(transfer.quantity) &&
              delta.reason === `Transfer ke ${transfer.to}`) ||
              (delta.outletId === transfer.to &&
                Number(delta.delta) === Number(transfer.quantity) &&
                delta.reason === `Transfer dari ${transfer.from}`)),
        );
      });
      state.syncIssues = state.syncIssues.filter((e) => !accepted.has(e.eventId));
      for (const event of result.events || []) mergeSyncEvent(event);
      for (const product of result.bootstrapProducts || [])
        mergeSyncEvent({ event_type: 'product.upsert', payload: product });
      for (const outlet of result.outlets || []) {
        const existing = state.outlets.find((item) => item.id === outlet.id);
        if (existing) Object.assign(existing, outlet);
        else state.outlets.push(outlet);
      }
      if (result.stockBalances)
        mergeStockSnapshot(state, outlet, result.stockBalances, state.syncOutbox);
      for (const transfer of result.transfers || []) {
        const existing = state.transfers.find((item) => item.id === transfer.id);
        if (existing) Object.assign(existing, transfer);
        else state.transfers.push(transfer);
      }
      if (result.activeShift)
        mergeSyncEvent({ event_type: 'shift.upsert', payload: result.activeShift });
      if (result.knownShift)
        mergeSyncEvent({ event_type: 'shift.upsert', payload: result.knownShift });
      state.syncCursor = result.cursor ?? state.syncCursor;
      if (result.catalogBootstrapped) state.catalogInitialized = true;
      persistState();
      await flushPendingWrites();
      if (!state.catalogInitialized)
        throw Object.assign(new Error('Server belum mengonfirmasi bootstrap katalog.'), {
          code: 'CATALOG_BOOTSTRAP_UNCONFIRMED',
        });
      updateSyncStatus(
        state.syncOutbox.length ? `${state.syncOutbox.length} event menunggu` : 'Tersinkron',
        state.syncOutbox.length ? 'pending' : 'synced',
      );
      publishStateChange();
      if (result.hasMore || state.syncOutbox.some((e) => e.outletId === outlet))
        syncTimer = setTimeout(() => synchronizeState(), 700);
    } catch (error) {
      if (error.code === 'LOCAL_STORAGE_WRITE_FAILED') {
        updateSyncStatus('Penyimpanan lokal gagal', 'error');
        if (manual) showToast(error.message);
      } else if (error.code === 'CATALOG_BOOTSTRAP_UNCONFIRMED') {
        updateSyncStatus('Server belum mengirim konfirmasi katalog', 'error');
        if (manual) showToast(error.message);
      } else if (error.status === 401 && session) {
        if (manual) {
          await clearSession(false);
          showToast('Sesi server berakhir. Masuk kembali untuk melanjutkan sinkronisasi.');
        } else {
          updateSyncStatus('Sesi server berakhir Â· data lokal tetap tersedia', 'offline');
        }
      } else {
        const serverUnavailable =
          !navigator.onLine || !Number.isInteger(error.status) || error.status >= 500;
        updateSyncStatus(
          catalogNeedsBootstrap()
            ? 'Katalog belum tersimpan · server perlu dijangkau'
            : serverUnavailable
              ? 'Server tidak terjangkau Â· data lokal'
              : 'Sinkronisasi gagal',
          serverUnavailable ? 'offline' : 'error',
        );
        if (manual) showToast(error.message || 'Sinkronisasi gagal. Data tetap tersimpan lokal.');
      }
    } finally {
      if (syncAbortController === currentSyncController) syncAbortController = null;
      syncing = false;
    }
  }
  async function login(identifier, password, totp = '') {
    const result = await sendApiRequest('/api/auth/login', 'POST', { identifier, password, totp });
    if (result.requiresTotp) return result;
    setPendingServerLogout(false);
    saveOfflineSessionProfile(result);
    session = result;
    state.settings.serverSession = result;
    state.settings.offlineSession = { user: result.user, expiresAt: result.expiresAt };
    state.activeOutlet = result.user.outletId;
    state.outlets ||= [];
    if (!state.outlets.some((item) => item.id === result.user.outletId))
      state.outlets.push({
        id: result.user.outletId,
        name: result.user.outletName,
        code: result.user.outletCode,
      });
    state.settings.activeUserId = result.user.id;
    state.settings.sessionExpiresAt = result.expiresAt;
    if (!state.users.some((user) => user.id === result.user.id))
      state.users.push({ ...result.user, twoFa: '?' });
    restoreActiveShift(state, state.activeOutlet);
    persistState();
    await flushPendingWrites();
    publishStateChange();
    await synchronizeState();
    await loadSalesHistory(true);
    return result;
  }
  async function registerAccount(input) {
    if (state.products.length || state.sales.length)
      throw new Error('Gunakan profil perangkat baru untuk mendaftarkan toko.');
    if (input.password !== input.confirm) throw new Error('Konfirmasi password tidak sama.');
    if (String(input.password || '').length < 10) throw new Error('Password minimal 10 karakter.');
    const result = await sendApiRequest('/api/auth/register', 'POST', {
      storeName: input.storeName,
      name: input.name,
      identifier: input.identifier,
      password: input.password,
    });
    state.activeOutlet = result.user.outletId;
    state.outlets = [
      { id: result.user.outletId, name: result.user.outletName, code: result.user.outletCode },
    ];
    persistState();
    return result;
  }
  async function initialize() {
    const pendingLogout = hasPendingServerLogout();
    if (pendingLogout) {
      session = null;
      state = createEmptyState();
      cart = [];
      cartDiscount = null;
      updateSyncStatus('Logout lokal · menunggu koneksi', 'offline');
      if (navigator.onLine) void revokePendingServerLogout();
    }
    const cachedSession = session?.user ? session : null;
    if (!pendingLogout && cachedSession) {
      if (!state.settings.offlineSession) {
        state.settings.offlineSession = {
          user: cachedSession.user,
          expiresAt: cachedSession.expiresAt,
        };
        persistState();
      }
      restoreActiveShift(state, state.activeOutlet || cachedSession.user.outletId);
    }
    if (!pendingLogout && navigator.onLine) {
      if (cachedSession) {
        session = cachedSession;
        status = { label: 'Membuka data lokal', state: 'validating' };
        publishStateChange();
      }
      try {
        const result = await sendApiRequest('/api/auth/session');
        session = {
          ...cachedSession,
          ...result,
          user: { ...(cachedSession?.user || {}), ...result.user },
        };
        state.settings.serverSession = session;
        state.settings.offlineSession = { user: session.user, expiresAt: session.expiresAt };
        saveOfflineSessionProfile(session);
        state.activeOutlet = session.user.outletId;
        restoreActiveShift(state, state.activeOutlet);
        state.settings.activeUserId = session.user.id;
        state.settings.sessionExpiresAt = session.expiresAt;
        if (!state.users.some((user) => user.id === session.user.id))
          state.users.push({ ...session.user, twoFa: '?' });
        persistState();
      } catch (error) {
        if (error.status === 401 && cachedSession) {
          session = cachedSession;
          updateSyncStatus('Sesi server perlu diperbarui Â· data lokal', 'offline');
        } else if (error.status === 401) {
          session = null;
          delete state.settings.serverSession;
          state.settings.activeUserId = null;
          state.settings.sessionExpiresAt = null;
        } else if (cachedSession) {
          session = cachedSession;
          updateSyncStatus(
            catalogNeedsBootstrap()
              ? 'Katalog belum tersimpan · server perlu dijangkau'
              : 'Server tidak terjangkau · data lokal',
            'offline',
          );
        } else {
          session = null;
          updateSyncStatus('Offline · login diperlukan', 'offline');
        }
      }
    } else if (!pendingLogout && cachedSession) {
      session = cachedSession;
      updateSyncStatus(offlineStatusLabel(), 'offline');
    } else if (!pendingLogout) session = null;
    if (!session && !pendingLogout)
      updateSyncStatus(
        navigator.onLine ? 'Login diperlukan' : 'Offline · login diperlukan',
        navigator.onLine ? 'local' : 'offline',
      );
    publishStateChange();
    if (session) {
      void synchronizeState();
      void loadSalesHistory(true);
    }
    window.addEventListener('online', () => {
      if (hasPendingServerLogout()) void revokePendingServerLogout();
      else {
        void synchronizeState();
        void refreshAccounts();
      }
    });
    window.addEventListener('offline', () => updateSyncStatus(offlineStatusLabel(), 'offline'));
    return getStateSnapshot();
  }
  async function logout() {
    if (!session) return;
    clearTimeout(syncTimer);
    syncTimer = null;
    if (syncing) {
      syncAbortController?.abort();
      while (syncing) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await clearSession(true);
    setPendingServerLogout(true);
    await revokePendingServerLogout();
    updateSyncStatus('Keluar', 'local');
  }
  function findProductById(id) {
    return state.products.find((p) => String(p.id) === String(id) || p.sku === id || p.name === id);
  }
  function addProductToCart(id, variantId = null) {
    const p = findProductById(id);
    if (!p) return showToast('Produk tidak ditemukan.');
    if (p.variants?.length && !variantId) return { variants: p.variants };
    const v = variantId ? p.variants?.find((x) => x.id === variantId) : null;
    const available = Number(v?.stock ?? p.stock) || 0;
    if (available <= 0) return showToast('Stok produk habis.');
    const line = cart.find(
      (x) => x.productId === p.id && (x.variantId || null) === (v?.id || null),
    );
    if (line) {
      if (line.qty >= available) return showToast('Melebihi stok tersedia.');
      line.qty++;
    } else
      cart.push({
        productId: p.id,
        variantId: v?.id || null,
        name: v ? `${p.name} · ${v.name}` : p.name,
        price: Number(v?.price ?? p.price) || 0,
        qty: 1,
        discount: null,
      });
    persistState();
  }
  function updateCartQuantity(id, delta, variantId = null) {
    const line = cart.find(
      (x) => x.productId === id && (x.variantId || null) === (variantId || null),
    );
    if (!line) return;
    const p = findProductById(id),
      v = variantId ? p?.variants?.find((x) => x.id === variantId) : null;
    if (line.qty + delta <= 0) cart = cart.filter((x) => x !== line);
    else if (line.qty + delta <= Number(v?.stock ?? p?.stock ?? 0)) line.qty += delta;
    else return showToast('Stok maksimal tercapai.');
    persistState();
  }
  function getCartTotals() {
    return calculateCartTotals(cart, cartDiscount, { service: state.settings.service });
  }
  function removeProductFromCart(id, variantId = null) {
    cart = cart.filter((x) => x.productId !== id || (variantId && x.variantId !== variantId));
    persistState();
  }
  function clearCart() {
    cart = [];
    cartDiscount = null;
    persistState();
  }
  function setItemDiscount(id, value, variantId = null) {
    const line = cart.find(
      (x) => x.productId === id && (x.variantId || null) === (variantId || null),
    );
    if (!line) return showToast('Produk tidak ditemukan di keranjang.');
    value = Number(value);
    const lineTotal = Math.round(Number(line.price) * Number(line.qty));
    if (!Number.isSafeInteger(value) || value < 0 || value > lineTotal)
      return showToast('Nominal diskon harus sesuai dengan nilai produk.');
    if (value > 0 && getCurrentRole() === 'Kasir' && value > Math.round((lineTotal * 10) / 100))
      return showToast('Diskon item kasir maksimal 10% dari nilai produk.');
    line.discount = value ? { kind: 'amount', value } : null;
    persistState();
    return true;
  }
  function changeDiscount(kind, value) {
    value = Number(value);
    if (!Number.isFinite(value) || value < 0 || (kind === 'percent' && value > 100))
      return showToast('Diskon tidak valid.');
    const base = getCartTotals().subtotal - getCartTotals().itemDiscount;
    if (
      getCurrentRole() === 'Kasir' &&
      (kind === 'percent' ? value > 10 : value > Math.round(base * 0.1))
    )
      return showToast('Diskon di atas 10% memerlukan persetujuan Admin.');
    cartDiscount = value ? { kind, value } : null;
    persistState();
  }
  function holdCurrentSale(name) {
    if (!cart.length) return showToast('Keranjang masih kosong.');
    state.holds.push({
      id: createUuid(),
      name:
        name ||
        `Pesanan ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`,
      at: new Date().toISOString(),
      items: cart.map((x) => ({ ...x })),
      discount: cartDiscount,
    });
    cart = [];
    cartDiscount = null;
    recordAuditEntry('Transaksi ditahan', state.holds.at(-1).name);
    persistState();
    publishStateChange();
  }
  function resumeHeldSale(id) {
    const item = state.holds.find((x) => x.id === id);
    if (!item) return;
    state.holds = state.holds.filter((x) => x.id !== id);
    cart = item.items.map((x) => ({ ...x }));
    cartDiscount = item.discount || null;
    persistState();
    publishStateChange();
  }
  async function checkout({ method = 'Tunai', received = 0 } = {}) {
    if (!roleEventTypes[getCurrentRole()]?.has('sale.upsert'))
      throw new Error('Peran akun ini tidak dapat menyelesaikan transaksi kasir.');
    if (!cart.length) return showToast('Keranjang masih kosong.');
    if (!state.activeShift) return showToast('Buka shift sebelum menerima pembayaran.');
    const t = getCartTotals();
    received = Number(received);
    if (method === 'Tunai' && (!Number.isSafeInteger(received) || received < t.total))
      return showToast('Uang diterima belum mencukupi.');
    for (const item of cart) {
      const p = findProductById(item.productId),
        v = item.variantId ? p?.variants?.find((x) => x.id === item.variantId) : null;
      if (!p || Number(v?.stock ?? p.stock) < item.qty)
        return showToast(`Stok ${item.name} tidak mencukupi.`);
    }
    const id = createUuid(),
      at = new Date().toISOString(),
      sale = {
        id,
        number: createSaleNumber(id, at),
        at,
        cashier: getCurrentUserName(),
        shiftId: state.activeShift.id,
        outletId: state.activeOutlet,
        items: cart.map((x) => ({ ...x })),
        subtotal: t.subtotal,
        discount: t.d + t.itemDiscount,
        itemDiscount: t.itemDiscount,
        transactionDiscount: t.d,
        tax: t.tax,
        service: t.service,
        total: t.total,
        payments: [
          {
            method,
            amount: t.total,
            ...(method === 'Tunai' ? { received, change: received - t.total } : {}),
          },
        ],
        status: 'Lunas',
        outstanding: 0,
      };
    for (const item of cart) {
      const p = findProductById(item.productId),
        v = item.variantId ? p.variants.find((x) => x.id === item.variantId) : null;
      if (v) v.stock = Math.max(0, v.stock - item.qty);
      else p.stock = Math.max(0, p.stock - item.qty);
    }
    state.sales.push(sale);
    enqueueSyncEvent('sale.upsert', sale, state.activeOutlet);
    for (const item of sale.items)
      enqueueSyncEvent(
        'stock.delta',
        {
          productId: item.productId,
          variantId: item.variantId || null,
          outletId: state.activeOutlet,
          delta: -item.qty,
          reason: `Penjualan ${sale.number}`,
          saleId: sale.id,
        },
        state.activeOutlet,
      );
    recordAuditEntry('Transaksi selesai', sale.number);
    cart = [];
    cartDiscount = null;
    persistState();
    await flushPendingWrites();
    publishStateChange();
    void synchronizeState();
    return sale;
  }
  function toggleFavorite(id) {
    const p = findProductById(id);
    if (!p) return;
    p.favorite = !p.favorite;
    enqueueSyncEvent('product.favorite', { productId: p.id, favorite: p.favorite });
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function saveProduct(data, id = null) {
    if (!roleEventTypes[getCurrentRole()]?.has('product.upsert'))
      return showToast('Peran akun ini tidak dapat mengubah produk.');
    const existing = id ? findProductById(id) : null;
    if (
      state.products.some((p) => p !== existing && p.sku.toLowerCase() === data.sku.toLowerCase())
    )
      return showToast('SKU sudah digunakan.');
    const before = Number(existing?.stock) || 0;
    if (existing) {
      Object.assign(existing, data);
      enqueueSyncEvent('product.upsert', existing, existing.createdOutletId || state.activeOutlet);
      if (before !== Number(data.stock)) {
        state.stockMovements.unshift({
          id: createUuid(),
          productId: existing.id,
          at: new Date().toISOString(),
          before,
          after: Number(data.stock),
          delta: Number(data.stock) - before,
          reason: 'Perubahan stok dari formulir produk',
          role: getCurrentRole(),
        });
        enqueueSyncEvent('stock.delta', {
          productId: existing.id,
          variantId: null,
          outletId: state.activeOutlet,
          delta: Number(data.stock) - before,
          reason: 'Perubahan stok dari formulir produk',
        });
      }
    } else {
      const p = {
        id: createUuid(),
        ...data,
        stockByOutlet: { [state.activeOutlet]: Number(data.stock) || 0 },
        variants: [],
        favorite: false,
        createdOutletId: state.activeOutlet,
      };
      state.products.unshift(p);
      enqueueSyncEvent('product.upsert', p, state.activeOutlet);
    }
    recordAuditEntry(existing ? 'Produk diperbarui' : 'Produk ditambahkan', data.sku);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function adjustStock(id, { kind = 'in', amount = 0, reason = '' }) {
    if (!roleEventTypes[getCurrentRole()]?.has('stock.delta') || getCurrentRole() === 'Kasir')
      return showToast('Peran akun ini tidak dapat mengubah stok.');
    const p = findProductById(id);
    if (!p) return;
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount < 0 || !reason.trim())
      return showToast('Jumlah dan alasan wajib diisi.');
    const before = p.stock,
      after = kind === 'in' ? before + amount : amount;
    p.stock = after;
    const movement = {
      id: createUuid(),
      productId: id,
      at: new Date().toISOString(),
      before,
      after,
      delta: after - before,
      reason,
      role: getCurrentRole(),
    };
    state.stockMovements.unshift(movement);
    enqueueSyncEvent('stock.delta', {
      productId: id,
      variantId: null,
      outletId: state.activeOutlet,
      delta: after - before,
      reason,
    });
    recordAuditEntry('Stok diperbarui', `${p.sku}: ${before} → ${after}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function openCashShift(amount) {
    if (!roleEventTypes[getCurrentRole()]?.has('shift.upsert'))
      return showToast('Peran akun ini tidak dapat membuka shift.');
    if (state.activeShift) return showToast('Shift sedang aktif.');
    amount = Number(amount);
    if (!Number.isSafeInteger(amount) || amount < 0)
      return showToast('Modal awal harus Rupiah bulat.');
    const shift = {
      id: createUuid(),
      openedAt: new Date().toISOString(),
      openingCash: amount,
      cashier: getCurrentUserName(),
      openedBy: getCurrentUserName(),
      openedById: session.user.id,
      cashiers: [getCurrentUserName()],
      outletId: state.activeOutlet,
    };
    mergeShiftEvent(state, shift);
    enqueueSyncEvent('shift.upsert', shift);
    recordAuditEntry('Shift dibuka', String(amount));
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function calculateExpectedCash() {
    return expectedCashForShift(state.activeShift, state.sales, state.cashMovements);
  }
  function closeCashShift(actual) {
    if (!roleEventTypes[getCurrentRole()]?.has('shift.upsert'))
      return showToast('Peran akun ini tidak dapat menutup shift.');
    const shift = state.activeShift;
    if (!shift) return;
    actual = Number(actual);
    if (!Number.isSafeInteger(actual) || actual < 0)
      return showToast('Jumlah uang fisik tidak valid.');
    const closed = {
      ...shift,
      closedAt: new Date().toISOString(),
      expectedCash: calculateExpectedCash(),
      actualCash: actual,
      difference: actual - calculateExpectedCash(),
    };
    mergeShiftEvent(state, closed);
    enqueueSyncEvent('shift.upsert', closed);
    recordAuditEntry('Shift ditutup', `Selisih ${closed.difference}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function recordCashMovement(type, amount, reason) {
    if (
      !roleEventTypes[getCurrentRole()]?.has('cash.upsert') ||
      (getCurrentRole() === 'Pemilik' && type !== 'out')
    )
      return showToast('Peran akun ini tidak dapat mencatat jenis pergerakan kas tersebut.');
    amount = Number(amount);
    if (!state.activeShift) return showToast('Buka shift terlebih dahulu.');
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason.trim())
      return showToast('Jumlah dan alasan wajib diisi.');
    const movement = {
      id: createUuid(),
      at: new Date().toISOString(),
      shiftId: state.activeShift.id,
      outletId: state.activeOutlet,
      type,
      amount,
      reason,
      cashier: getCurrentUserName(),
      approvalStatus: type === 'out' && getCurrentRole() === 'Kasir' ? 'pending' : 'approved',
    };
    state.cashMovements.unshift(movement);
    enqueueSyncEvent('cash.upsert', movement);
    recordAuditEntry(type === 'in' ? 'Kas masuk' : 'Kas keluar', `${amount} · ${reason}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function decideCashApproval(index, action) {
    const movement = state.cashMovements[index];
    if (!roleEventTypes[getCurrentRole()]?.has('cash.approval') || !movement)
      return showToast('Peran akun ini tidak dapat menyetujui kas keluar.');
    movement.approvalStatus = action === 'approve' ? 'approved' : 'rejected';
    movement.approvedBy = getCurrentUserName();
    movement.approvedAt = new Date().toISOString();
    enqueueSyncEvent(
      'cash.approval',
      {
        id: movement.id,
        approvalStatus: movement.approvalStatus,
        approvedBy: movement.approvedBy,
        approvedAt: movement.approvedAt,
      },
      movement.outletId,
    );
    recordAuditEntry(
      movement.approvalStatus === 'approved' ? 'Kas keluar disetujui' : 'Kas keluar ditolak',
      movement.reason,
    );
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function transferStockBetweenOutlets({
    from,
    to,
    productId,
    product: productValue,
    qty,
    note = '',
  }) {
    if (!roleEventTypes[getCurrentRole()]?.has('transfer.upsert'))
      return showToast('Peran akun ini tidak dapat mentransfer stok.');
    const src = state.outlets.find((x) => x.id === from || x.name === from)?.id || from,
      dst = state.outlets.find((x) => x.id === to || x.name === to)?.id || to,
      pid = String(productId || productValue || '').split(':')[0],
      variantId = String(productId || productValue || '').split(':')[1] || null,
      p = findProductById(pid),
      v = variantId ? p?.variants?.find((x) => x.id === variantId) : null;
    qty = Math.floor(Number(qty));
    if (!state.outlets.some((outlet) => outlet.id === src))
      return showToast('Outlet sumber tidak tersedia. Sinkronkan data outlet lalu coba lagi.');
    if (!state.outlets.some((outlet) => outlet.id === dst))
      return showToast('Outlet tujuan belum tersedia. Pastikan outlet sudah terdaftar.');
    if (src === dst) return showToast('Outlet sumber dan tujuan harus berbeda.');
    if (!p || qty < 1) return showToast('Produk dan jumlah transfer tidak valid.');
    const source = v || p;
    source.stockByOutlet ||= {};
    if (source.stockByOutlet[src] == null) {
      if (src !== state.activeOutlet)
        return showToast(
          'Stok outlet sumber belum tersedia di perangkat ini. Sinkronkan data lalu coba lagi.',
        );
      source.stockByOutlet[src] = Number(source.stock) || 0;
    }
    source.stockByOutlet[dst] ??= 0;
    if (Number(source.stockByOutlet[src]) < qty)
      return showToast(`Stok outlet sumber hanya ${source.stockByOutlet[src]}.`);
    source.stockByOutlet[src] = Number(source.stockByOutlet[src]) - qty;
    source.stockByOutlet[dst] = Number(source.stockByOutlet[dst]) + qty;
    if (v) {
      if (src === state.activeOutlet) v.stock = source.stockByOutlet[src];
      const variants = p.variants || [];
      for (const outletId of [src, dst]) {
        if (variants.every((variant) => variant.stockByOutlet?.[outletId] != null)) {
          p.stockByOutlet ||= {};
          p.stockByOutlet[outletId] = variants.reduce(
            (total, variant) => total + Number(variant.stockByOutlet[outletId] || 0),
            0,
          );
        }
      }
      if (src === state.activeOutlet)
        p.stock = variants.reduce((total, variant) => total + Number(variant.stock || 0), 0);
    } else if (src === state.activeOutlet) {
      p.stock = source.stockByOutlet[src];
    }
    const entry = {
      id: createUuid(),
      at: new Date().toISOString(),
      productId: p.id,
      variantId,
      productName: p.name,
      from: src,
      to: dst,
      quantity: qty,
      note,
    };
    state.transfers.push(entry);
    enqueueSyncEvent('transfer.upsert', entry, src);
    recordAuditEntry('Transfer stok', `${p.name}: ${qty}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function setActiveOutlet(id) {
    const next = state.outlets.find((x) => x.id === id || x.name === id);
    if (!next) return showToast('Outlet tidak ditemukan.');
    if (next.id !== state.activeOutlet) {
      salesHasMore = false;
      state.settings.salesCursor = null;
    }
    switchOutletLocalState(state, next.id);
    state.activeOutlet = next.id;
    restoreActiveShift(state, next.id);
    persistState();
    publishStateChange();
    void synchronizeState();
    void loadSalesHistory(true);
  }
  async function setAttendance(direction) {
    if (!session) return showToast('Login kembali untuk mencatat absensi.');
    if (!['Kasir', 'Admin'].includes(getCurrentRole()))
      return showToast('Peran akun ini tidak dapat mencatat absensi.');
    if (!navigator.geolocation) return showToast('Perangkat ini tidak mendukung lokasi.');
    const location = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          }),
        () => reject(new Error('Lokasi diperlukan untuk mencatat absensi.')),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      ),
    );
    const userId = session.user.id,
      workDate = getLocalDateKey(),
      record = state.attendance.find(
        (x) => x.userId === userId && x.workDate === workDate && x.outletId === state.activeOutlet,
      );
    if (direction === 'in' && record) return showToast('Absensi masuk hari ini sudah tercatat.');
    if (direction === 'out' && !record) return showToast('Catat absensi masuk terlebih dahulu.');
    const at = new Date().toISOString(),
      entry = record || {
        id: createUuid(),
        userId,
        userName: getCurrentUserName(),
        role: getCurrentRole(),
        outletId: state.activeOutlet,
        workDate,
        checkIn: at,
      };
    if (direction === 'out') {
      if (record.checkOut) return showToast('Absensi pulang hari ini sudah tercatat.');
      entry.checkOut = at;
      entry.checkOutLocation = location;
    } else {
      entry.checkIn = at;
      entry.checkInLocation = location;
      state.attendance.push(entry);
    }
    enqueueSyncEvent('attendance.upsert', entry);
    recordAuditEntry(direction === 'in' ? 'Absensi masuk' : 'Absensi pulang', getCurrentUserName());
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function refundSale(saleId, form = {}) {
    if (getCurrentRole() !== 'Admin' || !roleEventTypes[getCurrentRole()]?.has('sale.upsert'))
      return showToast('Refund hanya dapat diproses oleh Admin.');
    const sale = state.sales.find((x) => x.id === saleId || x.number === saleId);
    if (!sale || !['Lunas', 'Piutang'].includes(sale.status) || sale.refunds?.length)
      return showToast('Transaksi tidak dapat direfund.');
    if (!String(form.reason || '').trim()) return ui.refund?.(saleId);
    const refundRecord = createRefundRecord({
      sale,
      ...form,
      approvedByName: getCurrentUserName(),
      id: createUuid(),
      at: new Date().toISOString(),
    });
    if (refundRecord.method === 'Tunai' && refundRecord.amount > 0 && !state.activeShift)
      throw new Error('Buka shift untuk mencatat uang refund yang keluar dari kas.');
    sale.refunds = [refundRecord];
    sale.refundedAmount = refundRecord.amount;
    sale.outstanding = 0;
    sale.status = 'Dikembalikan';
    if (form.restock)
      for (const item of sale.items) {
        const p = findProductById(item.productId),
          v = item.variantId ? p?.variants?.find((x) => x.id === item.variantId) : null;
        if (v) v.stock += item.qty;
        else if (p) p.stock += item.qty;
        enqueueSyncEvent(
          'stock.delta',
          {
            productId: item.productId,
            variantId: item.variantId || null,
            outletId: sale.outletId,
            delta: item.qty,
            reason: `Refund ${sale.number}`,
            saleId: sale.id,
          },
          sale.outletId,
        );
      }
    if (refundRecord.method === 'Tunai' && refundRecord.amount > 0) {
      const movement = {
        id: createUuid(),
        at: refundRecord.at,
        shiftId: state.activeShift.id,
        outletId: sale.outletId || state.activeOutlet,
        type: 'out',
        amount: refundRecord.amount,
        reason: `Refund ${sale.number}: ${refundRecord.reason}`,
        cashier: getCurrentUserName(),
        approvalStatus: 'approved',
      };
      state.cashMovements.unshift(movement);
      enqueueSyncEvent('cash.upsert', movement, movement.outletId);
    }
    enqueueSyncEvent('sale.upsert', sale, sale.outletId);
    recordAuditEntry('Transaksi refund', `${sale.number}: ${form.reason}`);
    persistState();
    publishStateChange();
    void synchronizeState();
  }
  function settleSaleReceivable(saleId, { amount, method = 'Tunai', reference = '' } = {}) {
    if (
      !roleEventTypes[getCurrentRole()]?.has('receivable.payment') ||
      !roleEventTypes[getCurrentRole()]?.has('sale.upsert')
    )
      throw new Error('Peran akun ini tidak dapat menerima pembayaran piutang.');
    if (!state.activeShift) throw new Error('Buka shift untuk menerima pembayaran piutang.');
    const sale = state.sales.find((item) => item.id === saleId || item.number === saleId);
    if (!sale || sale.status !== 'Piutang' || Number(sale.outstanding) <= 0)
      throw new Error('Transaksi tidak memiliki sisa piutang.');
    amount = Number(amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Number(sale.outstanding))
      throw new Error('Jumlah pembayaran harus lebih dari nol dan tidak melebihi sisa piutang.');
    method = String(method || '').trim();
    if (!method || method.length > 40) throw new Error('Metode pembayaran tidak valid.');
    reference = String(reference || '').trim();
    if (reference.length > 120) throw new Error('Referensi pembayaran maksimal 120 karakter.');
    const id = createUuid(),
      at = new Date().toISOString(),
      payment = {
        id,
        method,
        status: 'Lunas',
        amount,
        reference: reference || null,
        at,
        shiftId: state.activeShift.id,
      };
    sale.payments ||= [];
    sale.payments.push(payment);
    sale.outstanding -= amount;
    if (sale.outstanding === 0) sale.status = 'Lunas';
    enqueueSyncEvent('sale.upsert', sale, sale.outletId || state.activeOutlet);
    enqueueSyncEvent(
      'receivable.payment',
      {
        id,
        saleId: sale.id,
        customerId: sale.customerId || sale.customer?.id || null,
        shiftId: payment.shiftId,
        method,
        amount,
        at,
      },
      sale.outletId || state.activeOutlet,
    );
    recordAuditEntry('Pembayaran piutang', `${sale.number}: ${amount} (${method})`);
    persistState();
    publishStateChange();
    void synchronizeState();
    return sale;
  }
  function normalizeServerSale(remote) {
    return {
      ...remote,
      items: (remote.items || []).map((item) => ({
        ...item,
        discount: item.discountAmount ? { kind: 'amount', value: item.discountAmount } : null,
      })),
      refunds: (remote.refunds || []).map((refund) => ({
        ...refund,
        approvedByName: refund.approvedBy,
      })),
    };
  }
  async function loadSalesHistory(reset = false) {
    if (salesLoading || !session || !navigator.onLine) return;
    if (reset) {
      state.settings.salesCursor = null;
      salesHasMore = false;
    }
    salesLoading = true;
    try {
      const cursor = state.settings.salesCursor;
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) {
        params.set('before', cursor.before);
        params.set('beforeId', cursor.beforeId);
      }
      const result = await sendApiRequest(`/api/sales?${params}`);
      for (const remote of result.sales || []) {
        const normalized = normalizeServerSale(remote),
          index = state.sales.findIndex((item) => item.id === normalized.id);
        if (index < 0) state.sales.push(normalized);
        else state.sales[index] = { ...state.sales[index], ...normalized };
      }
      state.sales.sort((a, b) => new Date(b.at) - new Date(a.at));
      state.settings.salesCursor = result.next || null;
      salesHasMore = !!result.hasMore;
      persistState();
      await flushPendingWrites();
      publishStateChange();
    } catch (error) {
      if (!session) return;
      if (error.status === 401 && navigator.onLine) return;
      updateSyncStatus(
        error.code === 'LOCAL_STORAGE_WRITE_FAILED'
          ? 'Penyimpanan lokal gagal'
          : 'Riwayat transaksi belum diperbarui Â· data lokal',
        error.code === 'LOCAL_STORAGE_WRITE_FAILED' ? 'error' : 'offline',
      );
    } finally {
      salesLoading = false;
    }
  }
  async function loadSaleDetails(id) {
    let sale = state.sales.find((item) => item.id === id || item.number === id);
    if (navigator.onLine && session) {
      try {
        const result = await sendApiRequest(`/api/sales?id=${encodeURIComponent(sale?.id || id)}`);
        const remote = result.sales?.[0];
        if (remote) {
          const normalized = normalizeServerSale(remote);
          const index = state.sales.findIndex((item) => item.id === normalized.id);
          if (index < 0) state.sales.push(normalized);
          else state.sales[index] = { ...state.sales[index], ...normalized };
          sale = normalized;
          persistState();
          await flushPendingWrites();
          publishStateChange();
        }
      } catch (error) {
        if (error.status === 401) throw error;
      }
    }
    if (!sale) return null;
    const itemDiscount = sale.items.reduce(
      (sum, item) => sum + Number(item.discountAmount || 0),
      0,
    );
    return {
      ...sale,
      id: sale.number || sale.id,
      time: new Date(sale.at).toLocaleString('id-ID'),
      discount: Number(sale.discount) || 0,
      itemDiscount: Number(sale.itemDiscount) || itemDiscount,
      transactionDiscount:
        Number(sale.transactionDiscount) || Math.max(0, Number(sale.discount || 0) - itemDiscount),
    };
  }
  async function refreshAccounts() {
    if (!navigator.onLine || !['Pemilik', 'Admin', 'Manajer'].includes(getCurrentRole())) return;
    try {
      const r = await sendApiRequest(
        `/api/auth/users?outletId=${encodeURIComponent(state.activeOutlet)}`,
      );
      state.users = (r.users || []).map((user) => ({
        ...user,
        twoFa: user.hasTotp ? 'Aktif' : '?',
        scope: user.role,
      }));
      persistState();
      await flushPendingWrites();
    } catch (error) {
      if (error.code === 'LOCAL_STORAGE_WRITE_FAILED') {
        updateSyncStatus('Penyimpanan lokal gagal', 'error');
        return;
      }
      if (Number.isInteger(error.status) && error.status < 500) showToast(error.message);
    }
  }
  async function createUser(input) {
    if (!/^[0-9]{4,8}$/.test(input.pin || '')) throw new Error('PIN harus 4–8 angka.');
    if (String(input.password || '').length < 10) throw new Error('Password minimal 10 karakter.');
    if (getCurrentRole() !== 'Pemilik') throw new Error('Hanya Pemilik yang dapat membuat akun.');
    const salt = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
        x.toString(16).padStart(2, '0'),
      ).join('');
    const derive = async (value, keySalt) => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(value),
        'PBKDF2',
        false,
        ['deriveBits'],
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: new TextEncoder().encode(keySalt),
          iterations: 210000,
          hash: 'SHA-256',
        },
        key,
        256,
      );
      return Array.from(new Uint8Array(bits), (x) => x.toString(16).padStart(2, '0')).join('');
    };
    const pinSalt = salt();
    const payload = {
      id: createUuid(),
      name: input.name.trim(),
      role: input.role,
      identifier: input.identifier.trim(),
      password: input.password,
      pinSalt,
      pinHash: await derive(input.pin, pinSalt),
    };
    await sendApiRequest('/api/auth/accounts', 'POST', payload);
    await refreshAccounts();
    showToast('Akun ditambahkan ke server.');
  }
  async function deleteUser(id) {
    if (!['Pemilik', 'Admin'].includes(getCurrentRole()))
      throw new Error('Akun ini tidak memiliki izin menghapus pengguna.');
    await sendApiRequest('/api/auth/accounts', 'DELETE', { id });
    state.users = state.users.filter((user) => user.id !== id);
    publishStateChange();
    showToast('Akun dinonaktifkan di server.');
  }
  async function init() {
    const result = await initialize();
    if (session) void refreshAccounts();
    return result;
  }
  return {
    ready: true,
    init,
    initialize,
    login,
    registerAccount,
    logout,
    synchronize: synchronizeState,
    getStateSnapshot,
    getStorageDiagnostics: () => ({
      ...storage.getWriteDiagnostics(),
      catalogInitialized: !!state.catalogInitialized,
      productCount: state.products.length,
    }),
    loadSaleDetails,
    loadSalesHistory,
    addProductToCart,
    updateCartQuantity,
    toggleFavorite,
    setItemDiscount,
    removeProductFromCart,
    clearCart,
    getCartTotals,
    changeDiscount,
    holdCurrentSale,
    resumeHeldSale,
    checkout,
    saveProduct,
    adjustStock,
    openCashShift,
    closeCashShift,
    calculateExpectedCash,
    recordCashMovement,
    decideCashApproval,
    transferStockBetweenOutlets,
    setActiveOutlet,
    setAttendance,
    refundSale,
    settleSaleReceivable,
    refreshAccounts,
    createUser,
    deleteUser,
    flushPendingWrites,
    get state() {
      return state;
    },
    get cart() {
      return cart;
    },
    get role() {
      return getCurrentRole();
    },
    get status() {
      return status;
    },
    pay: () => ui.checkout?.(),
    discount: () => ui.discount?.(),
    cash: (kind) => ui.cash?.(kind),
    shiftOpen: () => ui.shiftOpen?.(),
    shiftClose: () => ui.shiftClose?.(),
    users: () => ui.users?.(),
    outlet: () => ui.outlet?.(),
    outlets: () => ui.navigate?.('outlet'),
    scanner: () => ui.scanner?.(),
    holdForm: () => ui.hold?.(),
    logoutForm: () => ui.logout?.(),
    refundForm: (id) => ui.refund?.(id),
  };
}
