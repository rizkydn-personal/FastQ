window.installAccounts = async function ({ state, save, toast, modal, closeModal, esc, uid, hashCredential, setSession, bind, renderUsers, installSessionSync, syncHooks, openCartPreview }) {
  const { mergeStockSnapshot, prepareSyncOutbox, restoreActiveShift, switchOutletLocalState } = await import('./sync-policy.js');
  const shell = document.querySelector('.shell');
  const mobile = matchMedia('(max-width:800px)');
  document.getElementById('mobileCartLink').onclick = openCartPreview;
  const more = document.getElementById('mobileHeaderMenu');
  more.classList.add('mobile-header-menu');
  more.setAttribute('aria-label', 'Buka menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-controls', 'mobileHeaderDropdown');
  const dropdown = document.createElement('div');
  dropdown.id = 'mobileHeaderDropdown';
  dropdown.className = 'mobile-header-dropdown';
  dropdown.hidden = true;
  dropdown.innerHTML = '<strong>Menu toko</strong><button type="button" data-header-action="products">Produk & stok</button><button type="button" data-header-action="profile">Profil & akun</button><button type="button" data-header-action="outlets">Outlet</button><button type="button" data-header-action="users">Pengguna</button><button type="button" data-header-action="receipt">Pengaturan struk</button><button type="button" data-header-action="logout">Keluar</button>';
  document.querySelector('.topbar').append(dropdown);
  const outletSelect = document.getElementById('outletSelect');
  const outletContainer = outletSelect.parentElement;
  const storeName = document.getElementById('mobileStoreName');
  const storePicker = document.createElement('label');
  storePicker.className = 'header-store-picker';
  storePicker.htmlFor = 'outletSelect';
  storePicker.textContent = 'Pindah toko';
  dropdown.querySelector('strong').after(storePicker);
  function updateStoreName() {
    const name = outletSelect.selectedOptions[0]?.textContent?.trim() || state.outlets.find(outlet => outlet.id === state.activeOutlet)?.name || 'Toko';
    storeName.textContent = name;
    storeName.title = name;
  }
  outletSelect.addEventListener('change', () => { updateStoreName(); closeDropdown(); });
  new MutationObserver(updateStoreName).observe(outletSelect, { childList: true, subtree: true, characterData: true });
  const syncButton = document.getElementById('syncPill');
  syncButton.onclick = async () => {
    if (syncButton.disabled) return;
    if (hasEventConflicts()) { openEventConflictModal(); return; }
    syncButton.disabled = true;
    syncButton.classList.add('sync-loading');
    syncButton.setAttribute('aria-busy', 'true');
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (syncing) await new Promise(resolve => setTimeout(resolve, 50));
      await sessionSync(true);
    } finally {
      syncButton.disabled = false;
      if (!syncing) {
        syncButton.classList.remove('sync-loading');
        syncButton.removeAttribute('aria-busy');
      }
    }
  };
  function closeDropdown() { dropdown.hidden = true; more.setAttribute('aria-expanded', 'false'); }
  more.onclick = () => {
    dropdown.hidden = !dropdown.hidden;
    more.setAttribute('aria-expanded', String(!dropdown.hidden));
    if (!dropdown.hidden) {
      for (const action of ['products', 'outlets', 'users', 'receipt']) {
        const button = dropdown.querySelector(`[data-header-action="${action}"]`);
        const nav = document.querySelector(`.sidebar [data-page="${action}"]`);
        button.hidden = action === 'receipt' ? document.getElementById('receiptSettingsButton').hidden : !!nav?.hidden;
      }
      dropdown.querySelector('button:not([hidden])').focus();
    }
  };
  dropdown.onclick = event => {
    const action = event.target.closest('[data-header-action]')?.dataset.headerAction;
    if (!action) return;
    closeDropdown();
    if (action === 'logout') { void logout(); return; }
    const ids = { profile: 'roleButton', receipt: 'receiptSettingsButton' };
    if (ids[action]) document.getElementById(ids[action]).click();
    else document.querySelector(`.sidebar [data-page="${action}"]`).click();
  };
  document.addEventListener('click', event => { if (!dropdown.contains(event.target) && !more.contains(event.target)) closeDropdown(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !dropdown.hidden) { closeDropdown(); more.focus(); } });
  dropdown.addEventListener('focusout', event => { if (!dropdown.contains(event.relatedTarget) && event.relatedTarget !== more) closeDropdown(); });
  function mobileLabels() {
    closeDropdown();
    // Pindahkan select + wrapper custom-select-nya bersama-sama. Wrapper
    // (div.custom-select-outlet, dibuat syncCustomSelect di
    // 15-reports-charts.js) adalah sibling tepat setelah select; bila hanya
    // select yang dipindah, wrapper tertinggal di container mobile yang
    // tersembunyi dan picker outlet hilang setelah resize 390 -> 1440.
    const target = mobile.matches ? storePicker : outletContainer;
    target.append(outletSelect);
    const outletWrapper = document.querySelector('.custom-select-outlet');
    if (outletWrapper) target.append(outletWrapper);
    updateStoreName();
    document.querySelector('[data-page=products] .nav-text').textContent = mobile.matches ? 'Product' : 'Produk & stok';
    document.querySelector('[data-page=shift] .nav-text').textContent = mobile.matches ? 'Shift' : 'Shift & kas';
  }
  mobile.addEventListener('change', mobileLabels);
  mobileLabels();
  const gate = document.createElement('main');
  gate.className = 'account-gate';
  document.body.append(gate);
  let session = state.settings.serverSession;
  if (session?.token) { delete session.token; state.settings.serverSession = session; save(); }
  let busy = false;
  let syncing = false;
  let logoutInProgress = false;
  let syncBlockedError = null;
  let syncRetry;
  let lastSyncError = null;
  const valid = () => session?.expiresAt > Date.now() && session.user?.id;
  const base = () => location.origin;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base() + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path.startsWith('/api/sync') ? 60000 : 15000) });
    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try { result = JSON.parse(responseText); }
      catch {
        const message = response.status >= 500
          ? `Server POS tidak dapat memproses permintaan (HTTP ${response.status}).`
          : `Respons server tidak valid (HTTP ${response.status}).`;
        throw Object.assign(new Error(message), { status: response.status });
      }
    } else if (!response.ok) {
      const message = response.status >= 502
        ? `Server POS tidak dapat dihubungi (HTTP ${response.status}).`
        : `Permintaan akun gagal (HTTP ${response.status}).`;
      throw Object.assign(new Error(message), { status: response.status });
    } else {
      throw new Error('Server mengirim respons kosong.');
    }
    if (!response.ok) throw Object.assign(new Error(result.error || `Permintaan akun gagal (HTTP ${response.status}).`), { status: response.status, code: result.code, conflict: result.conflict });
    return result;
  }
  async function sessionSync(manual = false, quiet = false) {
    if (syncing) return;
    if (syncBlockedError && !manual) return;
    if (manual) syncBlockedError = null;
    if (!valid()) { if (manual) toast('Login kembali untuk menyinkronkan data.'); return; }
    if (!navigator.onLine) {
      syncHooks.status('Offline', 'offline');
      if (manual) toast('Tidak ada koneksi internet. Sambungkan internet lalu sinkronkan kembali.');
      return;
    }
    clearTimeout(syncRetry);
    syncing = true;
    syncButton.classList.add('sync-loading');
    syncButton.setAttribute('aria-busy', 'true');
    lastSyncError = null;
    try {
      if (session.user.role === 'Admin') syncHooks.bootstrap();
      const outletId = session.user.outletId;
      const prepared = prepareSyncOutbox({
        events: state.syncOutbox,
        sales: state.sales,
        issues: state.syncIssues || [],
        outletId,
        role: session.user.role,
      });
      state.syncIssues = prepared.issues;
      if (prepared.changed) save();
      const { pending, deferredCount, newIssues, reviewCount } = prepared;
      const otherOutletCount = state.syncOutbox.length - prepared.scopedOutbox.length;
      syncHooks.status('Menyinkronkan data', 'syncing');
      const result = await request('/api/sync', 'POST', { deviceId: state.deviceId, cursor: state.syncCursor, activeShiftId: state.activeShift?.id || null, events: pending.slice(0,5) });
      const accepted = new Set(result.accepted);
      state.syncOutbox = state.syncOutbox.filter(event => !accepted.has(event.id));
      state.syncIssues = state.syncIssues.filter(issue => !accepted.has(issue.eventId));
      for (const event of result.events || []) syncHooks.merge(event);
      if (result.stockBalances) mergeStockSnapshot(state, outletId, result.stockBalances, state.syncOutbox);
      if (result.activeShift) syncHooks.merge({ event_type: 'shift.upsert', payload: result.activeShift });
      if (result.knownShift) syncHooks.merge({ event_type: 'shift.upsert', payload: result.knownShift });
      state.syncCursor = result.cursor;
      save(); syncHooks.refresh();
      lastSyncError = null;
      const issueIds = new Set(state.syncIssues.map(issue => issue.eventId));
      const remaining = state.syncOutbox.filter(event => event.outletId === outletId && pending.some(item => item.id === event.id) && !issueIds.has(event.id)).length;
      const conflictCount = (state.syncIssues || []).filter(issue => issue.kind === 'event-conflict').length;
      const status = conflictCount ? `${conflictCount} konflik sinkronisasi — ketuk untuk menyelesaikan` : reviewCount ? `${reviewCount} permintaan diskon lama perlu ditinjau` : remaining ? `${remaining} event toko ini menunggu` : deferredCount ? `${deferredCount} event menunggu akun berwenang` : otherOutletCount ? `${otherOutletCount} event toko lain menunggu` : 'Tersinkron';
      syncHooks.status(status, conflictCount ? 'conflict' : reviewCount || remaining || deferredCount || otherOutletCount ? 'pending' : 'synced');
      if (newIssues.length) toast('Permintaan diskon lama tanpa transaksi yang cocok tetap tersimpan di perangkat dan tidak dikirim. Event lainnya tetap disinkronkan.');
      if (!logoutInProgress && (remaining || result.hasMore)) syncRetry = setTimeout(sessionSync, 1200);
    } catch (error) {
      lastSyncError = error;
      if (error.conflict?.type === 'stock') { state.syncConflict = error.conflict; save(); }
      if (error.status === 409 && error.code === 'ACTIVE_SHIFT') {
        try {
          const latest = await request('/api/sync', 'POST', { deviceId: state.deviceId, cursor: state.syncCursor, activeShiftId: state.activeShift?.id || null, events: [] });
          for (const event of latest.events || []) syncHooks.merge(event);
          if (latest.stockBalances) mergeStockSnapshot(state, session.user.outletId, latest.stockBalances, state.syncOutbox);
          if (latest.activeShift) syncHooks.merge({ event_type: 'shift.upsert', payload: latest.activeShift });
          if (latest.knownShift) syncHooks.merge({ event_type: 'shift.upsert', payload: latest.knownShift });
          state.syncCursor = latest.cursor;
          save();
          syncHooks.refresh();
        } catch (refreshError) {
          error.message = `${error.message} Perubahan shift server belum dapat dimuat: ${refreshError.message}`;
        }
      }
      const resyncRequired = ['SYNC_RESYNC_REQUIRED','SYNC_CURSOR_ROLLBACK'].includes(error.code);
      const priceChanged = error.code === 'PRICE_CHANGED';
      const syncEventConflict = error.code === 'SYNC_EVENT_ID_CONFLICT';
      if (resyncRequired || priceChanged || syncEventConflict) syncBlockedError = error;
      if (syncEventConflict) {
        // Catat konflik sebagai issue: prepareSyncOutbox mengesampingkan
        // event ini dari batch berikutnya (event lain tetap tersinkron),
        // dan pengguna mendapat jalan keluar lewat modal konflik —
        // sebelumnya event macet selamanya di outbox dan logout diblokir.
        const eventId = error.conflict?.eventId;
        if (eventId) {
          state.syncIssues = state.syncIssues || [];
          if (!state.syncIssues.some(issue => issue.eventId === eventId && issue.kind === 'event-conflict')) {
            state.syncIssues.push({ eventId, kind: 'event-conflict', message: error.message, storedEvent: error.conflict?.storedEvent || null, eventType: error.conflict?.eventType || null });
            save();
          }
        }
        syncHooks.status('Konflik sinkronisasi — ketuk untuk menyelesaikan', 'conflict');
        if (!quiet) toast(error.message || 'ID event sudah dipakai untuk perubahan yang berbeda.');
        if (manual || logoutInProgress) openEventConflictModal();
      } else {
        const statusMessage = resyncRequired ? 'Perangkat perlu sinkronisasi ulang' : priceChanged ? 'Harga transaksi perlu ditinjau' : error.code === 'ACTIVE_SHIFT' ? 'Shift outlet sudah aktif di server.' : error.status === 409 ? 'Konflik stok. Periksa data sebelum sinkron ulang.' : 'Sinkronisasi gagal';
        syncHooks.status(statusMessage, error.status === 409 ? 'conflict' : 'error');
        if (!quiet) toast(resyncRequired ? `${error.message} Jangan hapus data lokal sebelum dipulihkan.` : error.message || 'Server tidak dapat dijangkau. Data tetap tersimpan di perangkat.');
      }
      if (error.status === 401 && !logoutInProgress) lock();
    } finally {
      syncing = false;
      syncButton.classList.remove('sync-loading');
      syncButton.removeAttribute('aria-busy');
    }
  }
  async function syncCriticalEvent(eventId) {
    if (!navigator.onLine) return { offline: true };
    if (!valid()) throw new Error('Login kembali untuk mencatat data shift dan absensi ke database.');
    const deadline = Date.now() + 90_000;
    while (state.syncOutbox.some(event => event.id === eventId)) {
      if (!navigator.onLine) return { offline: true };
      while (syncing && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (Date.now() >= deadline) throw new Error('Sinkronisasi belum selesai. Coba lagi setelah memeriksa koneksi.');
      const before = state.syncOutbox.length;
      lastSyncError = null;
      await sessionSync(true);
      if (!state.syncOutbox.some(event => event.id === eventId)) return { synced: true };
      if (!navigator.onLine) return { offline: true };
      if (state.syncOutbox.length === before) {
        throw lastSyncError || new Error('Data shift atau absensi belum diterima server. Periksa izin akun dan coba lagi.');
      }
    }
    return { synced: true };
  }
  async function synchronizeBeforeLogout() {
    if (!valid()) throw new Error('Sesi server tidak aktif; data belum dapat dipastikan tersinkron.');
    if (!navigator.onLine) throw new Error('Tidak ada koneksi internet. Sambungkan jaringan sebelum logout.');
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      while (syncing && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (Date.now() >= deadline) break;
      if (!navigator.onLine) throw new Error('Koneksi terputus sebelum sinkronisasi selesai.');
      if (!valid()) throw new Error('Sesi server berakhir sebelum sinkronisasi selesai.');
      const before = new Set(state.syncOutbox.map(event => event.id));
      lastSyncError = null;
      await sessionSync(false, true);
      if (lastSyncError) throw lastSyncError;
      if (!valid()) throw new Error('Sesi server tidak dapat diverifikasi. Data lokal tetap dipertahankan.');
      const remainingIds = new Set(state.syncOutbox.map(event => event.id));
      const remaining = remainingIds.size;
      if (!remaining) return;
      const progressed = [...before].some(id => !remainingIds.has(id));
      if (before.size && !progressed) {
        const conflictCount = (state.syncIssues || []).filter(issue => issue.kind === 'event-conflict').length;
        throw new Error(conflictCount
          ? `${remaining} data belum diterima database. Ada konflik sinkronisasi — buka status sinkron untuk memilih Buang atau Kirim ulang.`
          : `${remaining} data belum diterima database. Periksa koneksi, konflik, atau akses akun.`);
      }
    }
    throw new Error('Sinkronisasi belum selesai dalam batas waktu. Data lokal tetap dipertahankan.');
  }
  async function logout() {
    if (logoutInProgress) return;
    if (busy) return toast('Tunggu proses yang sedang berjalan selesai sebelum logout.');
    if (!valid()) return toast('Sesi server tidak aktif. Data lokal tidak dihapus.');
    logoutInProgress = true;
    clearTimeout(syncRetry);
    closeDropdown();
    shell.inert = true;
    shell.setAttribute('aria-busy', 'true');
    toast('Memastikan semua data tersinkron sebelum logout...');
    try {
      await synchronizeBeforeLogout();
      await request('/api/auth/logout', 'POST', {});
      if (!window.PosLocalStorage || typeof window.PosLocalStorage.clear !== 'function') {
        throw new Error('Penyimpanan lokal tidak dapat dibersihkan. Data lokal tetap dipertahankan.');
      }
      clearTimeout(syncRetry);
      state = await window.PosLocalStorage.clear();
      syncHooks.refresh(true);
      lock(false);
      logoutInProgress = false;
      toast('Logout berhasil. Data lokal sudah dihapus.');
    } catch (error) {
      shell.inert = false;
      shell.removeAttribute('aria-busy');
      logoutInProgress = false;
      toast(`Logout dibatalkan. ${error instanceof Error ? error.message : 'Data belum tersinkron.'}`);
      if (hasEventConflicts()) openEventConflictModal();
    }
  }
  function hasEventConflicts() {
    return (state.syncIssues || []).some(issue => issue.kind === 'event-conflict' && state.syncOutbox.some(event => event.id === issue.eventId));
  }
  function eventConflictLabel(event) {
    const payload = event?.payload || {};
    if (event?.type === 'sale.upsert') return `Transaksi ${payload.number || payload.id || ''}`;
    if (event?.type === 'stock.delta' || event?.type === 'stock.reconcile') return `Stok · ${payload.reason || payload.productId || ''}`;
    if (event?.type === 'discount.request') return `Permintaan diskon · ${payload.productName || payload.id || ''}`;
    if (event?.type === 'discount.approval' || event?.type === 'discount.cancel') return `Keputusan diskon · ${payload.productName || payload.id || ''}`;
    if (event?.type === 'product.upsert') return `Produk ${payload.name || payload.sku || payload.id || ''}`;
    if (event?.type === 'product.delete') return `Hapus produk ${payload.sku || payload.id || ''}`;
    if (event?.type === 'shift.upsert') return `Shift ${payload.id || ''}`;
    if (event?.type === 'cash.upsert' || event?.type === 'cash.approval') return `Kas · ${payload.reason || payload.id || ''}`;
    if (event?.type === 'transfer.upsert') return `Transfer stok ${payload.id || ''}`;
    if (event?.type === 'customer.upsert') return `Pelanggan ${payload.name || payload.id || ''}`;
    if (event?.type === 'attendance.upsert') return `Absensi ${payload.userName || payload.id || ''}`;
    if (event?.type === 'audit.append') return `Audit · ${payload.action || payload.id || ''}`;
    if (event?.type === 'outlet.upsert') return `Toko ${payload.name || payload.id || ''}`;
    if (event?.type === 'receivable.payment') return `Pembayaran piutang ${payload.id || ''}`;
    return `${event?.type || 'Perubahan'} ${payload.id || ''}`;
  }
  function openEventConflictModal() {
    const issues = (state.syncIssues || []).filter(issue => issue.kind === 'event-conflict' && state.syncOutbox.some(event => event.id === issue.eventId));
    if (!issues.length) return toast('Tidak ada konflik sinkronisasi.');
    const rows = issues.map(issue => {
      const event = state.syncOutbox.find(item => item.id === issue.eventId);
      const canReissue = !!(event && event.payload && typeof event.payload.id === 'string');
      return `<div class="detail-row"><span><strong>${esc(eventConflictLabel(event))}</strong><div class="hint">${esc(event?.type || '')} · ID event sudah dipakai server untuk perubahan berbeda.</div></span><span style="display:flex;gap:8px;flex-wrap:wrap"><button class="button small" data-conflict-reissue="${esc(issue.eventId)}" ${canReissue ? '' : 'disabled title="Perubahan ini tidak dapat dikirim ulang dengan aman"'}>Kirim ulang</button><button class="button small danger" data-conflict-discard="${esc(issue.eventId)}">Buang</button></span></div>`;
    }).join('');
    modal('Konflik sinkronisasi', `<p>Server sudah menerima perubahan dengan ID yang sama, tapi isinya berbeda. Pilih salah satu untuk tiap baris:</p><div class="detail-list">${rows}</div><p class="hint"><strong>Buang</strong> memakai data server dan menghapus perubahan lokal yang bentrok. <strong>Kirim ulang</strong> mengirim perubahan lokal sebagai event baru. Logout bisa dilanjutkan setelah semua konflik dibereskan.</p>`, [{ label: 'Tutup', action: closeModal }]);
    document.querySelectorAll('[data-conflict-discard]').forEach(button => { button.onclick = () => discardEventConflict(button.dataset.conflictDiscard); });
    document.querySelectorAll('[data-conflict-reissue]').forEach(button => { button.onclick = () => reissueEventConflict(button.dataset.conflictReissue); });
  }
  function refreshEventConflictModal() {
    const remaining = (state.syncIssues || []).filter(issue => issue.kind === 'event-conflict' && state.syncOutbox.some(event => event.id === issue.eventId));
    if (!remaining.length) { closeModal(); return false; }
    openEventConflictModal();
    return true;
  }
  function discardEventConflict(eventId) {
    const issue = (state.syncIssues || []).find(item => item.eventId === eventId && item.kind === 'event-conflict');
    state.syncOutbox = state.syncOutbox.filter(event => event.id !== eventId);
    state.syncIssues = (state.syncIssues || []).filter(item => item.eventId !== eventId);
    // Sesuaikan data lokal dengan versi server (bila server mengirimnya),
    // supaya perubahan yang dibuang tidak muncul lagi sebagai data lokal.
    if (issue?.storedEvent) syncHooks.merge(issue.storedEvent);
    save(); syncHooks.refresh();
    toast('Perubahan bentrok dibuang; data disesuaikan dengan server.');
    if (!refreshEventConflictModal()) toast('Konflik selesai. Semua data tersinkron — silakan logout kembali.');
    void sessionSync(true);
  }
  function reissueEventConflict(eventId) {
    const index = state.syncOutbox.findIndex(event => event.id === eventId);
    if (index < 0) return;
    const event = state.syncOutbox[index];
    if (!event.payload || typeof event.payload.id !== 'string') return toast('Perubahan ini tidak dapat dikirim ulang dengan aman. Gunakan Buang.');
    state.syncOutbox[index] = { ...event, id: uid() };
    state.syncIssues = (state.syncIssues || []).filter(item => item.eventId !== eventId);
    save();
    toast('Perubahan dikirim ulang sebagai event baru.');
    refreshEventConflictModal();
    void sessionSync(true);
  }
  installSessionSync(sessionSync, syncCriticalEvent);
  const addOutletButton = document.getElementById('addOutletButton');
  if (addOutletButton) addOutletButton.onclick = () => toast('Outlet lokal tidak dapat ditambahkan. Gunakan toko yang sudah terdaftar di server.');
  const mergeRegisteredOutletEvent = syncHooks.merge;
  syncHooks.merge = event => {
    if (event.outlet_id !== session?.user.outletId) return;
    if (event.event_type === 'outlet.upsert' && event.payload?.id !== session.user.outletId) return;
    mergeRegisteredOutletEvent(event);
  };
  function lock(persist = true) {
    const authenticatedOutlet = persist ? session?.user?.outletId : null;
    session = null;
    delete state.settings.serverSession;
    localStorage.removeItem('pos-owner-session');
    if (!persist) {
      state.outlets = [];
      state.activeOutlet = '';
    } else if (authenticatedOutlet) {
      state.outlets = state.outlets.filter(outlet => outlet.id === authenticatedOutlet);
      state.activeOutlet = authenticatedOutlet;
    } else {
      state.outlets = [];
      state.activeOutlet = '';
    }
    setSession(null, null, persist);
    if (persist) save();
    shell.hidden = true;
    shell.inert = true;
    shell.removeAttribute('aria-busy');
    gate.hidden = false;
    closeModal();
    showLogin();
  }
  function unlock() {
    syncBlockedError = null;
    const outletId = session.user.outletId;
    switchOutletLocalState(state, outletId);
    restoreActiveShift(state, outletId);
    const registeredOutlet = state.outlets.find(outlet => outlet.id === outletId) ||
      { id: outletId, name: session.user.outletName, code: session.user.outletCode };
    state.outlets = [registeredOutlet];
    state.activeOutlet = outletId;
    for (const product of state.products) {
      product.stockByOutlet ||= {};
      if (!Object.hasOwn(product.stockByOutlet, outletId)) product.stockByOutlet[outletId] = Number(product.stock) || 0;
      product.variants?.forEach(variant => {
        variant.stockByOutlet ||= {};
        if (!Object.hasOwn(variant.stockByOutlet, outletId)) variant.stockByOutlet[outletId] = Number(variant.stock) || 0;
      });
    }
    const existing = state.users.find(u => u.id === session.user.id);
    if (existing) Object.assign(existing, session.user);
    else state.users.push(session.user);
    state.settings.serverSession = session;
    if (!state.outlets.some(outlet => outlet.id === outletId)) state.outlets.push({ id: outletId, name: session.user.outletName, code: session.user.outletCode });
    syncHooks.renderOutlets();
    setSession(session.user, session.expiresAt);
    document.getElementById('outletSelect').value = outletId;
    updateStoreName();
    gate.hidden = true;
    shell.hidden = false;
    shell.inert = false;
    save();
    void sessionSync();
    if (owner() || admin()) void refreshAccountsFromServer();
  }
  function frame(title, content) {
    const brandMark = new URL('../fastq-mark.png', document.currentScript?.src || location.href).href;
    gate.innerHTML = `<section class="account-card"><img src="${brandMark}" alt="" width="48" height="48"><p class="eyebrow">FASTQ POS</p><h1>${title}</h1>${content}<p id="accountError" role="alert"></p></section>`;
  }
  function setLoading(form, loading, message) {
    form.setAttribute('aria-busy', String(loading));
    form.querySelectorAll('input,select,button').forEach(control => { control.disabled = loading; });
    const submit = form.querySelector('[type=submit]');
    if (loading) {
      submit.dataset.label = submit.textContent;
      submit.innerHTML = `<span class="account-spinner" aria-hidden="true"></span><span>${esc(message)}</span>`;
    } else submit.textContent = submit.dataset.label;
  }
  function registrationComplete(code, identifier) {
    const popup = document.createElement('dialog');
    popup.className = 'account-result';
    popup.setAttribute('aria-labelledby', 'registrationTitle');
    popup.innerHTML = `<h2 id="registrationTitle">Toko berhasil dibuat</h2><p>ID toko Anda: <strong>${esc(code)}</strong></p><p>Masuk menggunakan email atau nomor HP yang didaftarkan.</p><form method="dialog"><button class="button primary" autofocus>Lanjut masuk</button></form>`;
    document.body.append(popup);
    gate.querySelector('[name=identifier]').value = identifier;
    popup.addEventListener('close', () => { popup.remove(); gate.querySelector('[name=password]').focus(); }, { once: true });
    popup.showModal();
  }
  function showLogin() {
    frame('Masuk kasir', `<p>Masuk menggunakan email atau nomor HP dan password.</p><form id="accountForm"><label>Email atau nomor HP<input class="field" name="identifier" required maxlength="254" autocomplete="username"></label><label>Password<input class="field" name="password" type="password" required maxlength="256" autocomplete="current-password"></label><label>Kode authenticator (jika sudah diaktifkan)<input class="field" name="totp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"></label><button class="button primary" type="submit">Masuk kasir</button><button class="button" type="button" id="registerAccount">Daftar dan buat toko</button></form>`);
    const form = gate.querySelector('form');
    const totp = form.elements.totp;
    const totpLabel = totp.closest('label');
    totpLabel.hidden = true;
    const resetTotp = () => { totpLabel.hidden = true; totp.required = false; totp.value = ''; };
    form.elements.identifier.addEventListener('input', resetTotp);
    form.elements.password.addEventListener('input', resetTotp);
    const error = message => { gate.querySelector('#accountError').textContent = message; };
    gate.querySelector('#registerAccount').onclick = showRegister;
    form.onsubmit = async event => {
      event.preventDefault(); if (busy) return;
      busy = true; setLoading(form, true, 'Memeriksa...'); error('');
      try {
        const result = await request('/api/auth/login', 'POST', { identifier: form.elements.identifier.value, password: form.elements.password.value, totp: form.elements.totp.value });
        if (result.requiresTotp) {
          totpLabel.hidden = false;
          totp.required = true;
          totp.focus();
          error('Masukkan kode authenticator untuk menyelesaikan login.');
          return;
        }
        session = result;
        unlock();
        toast('Login berhasil. Kasir siap digunakan.');
      } catch (e) { error(e.message); }
      finally { busy = false; setLoading(form, false); if (!totpLabel.hidden) totp.focus(); }
    };
  }
  function showRegister() {
    frame('Daftar dan buat toko', `<p>ID toko unik 6 angka dibuat otomatis oleh server.</p><form><label>Nama toko<input class="field" name="storeName" required maxlength="100" autocomplete="organization"></label><label>Nama Pemilik<input class="field" name="name" required maxlength="60" autocomplete="name"></label><label>Email atau nomor HP<input class="field" name="identifier" required maxlength="254" autocomplete="username"></label><label>Password<input class="field" name="password" type="password" required minlength="10" maxlength="256" autocomplete="new-password"></label><label>Ulangi password<input class="field" name="confirm" type="password" required autocomplete="new-password"></label><button class="button primary" type="submit">Daftar online</button><button class="button" type="button">Kembali ke login</button></form>`);
    const form = gate.querySelector('form');
    form.querySelector('[type=button]').onclick = showLogin;
    form.onsubmit = async event => {
      event.preventDefault(); if (busy) return;
      const error = gate.querySelector('#accountError');
      if (form.elements.password.value !== form.elements.confirm.value) { error.textContent = 'Konfirmasi password tidak sama.'; return; }
      const input = Object.fromEntries(new FormData(form));
      busy = true; setLoading(form, true, 'Membuat toko...'); error.textContent = '';
      try {
        if (state.products.length || state.sales.length) throw new Error('Gunakan profil browser terpisah untuk outlet baru.');
        const result = await request('/api/auth/register', 'POST', input);
        state.activeOutlet = result.user.outletId;
        state.outlets = [{ id: result.user.outletId, name: result.user.outletName, code: result.user.outletCode }];
        save(); showLogin();
        registrationComplete(result.user.outletCode, input.identifier);
      } catch (e) { error.textContent = e.message; }
      finally { busy = false; setLoading(form, false); }
    };
  }
  const owner = () => valid() && session.user.role === 'Pemilik';
  const admin = () => valid() && session.user.role === 'Admin';
  async function refreshAccountsFromServer() {
    if (!owner() && !admin()) return;
    try {
      const result = await request(`/api/auth/users?outletId=${encodeURIComponent(session.user.outletId)}`);
      state.users = result.users.map(u => ({ ...state.users.find(old => old.id === u.id), ...u }));
      save(); renderUsers();
    } catch (e) { toast(e.message); }
  }
  function create() {
    if (!owner()) return toast('Hanya Pemilik yang dapat membuat akun.');
    modal('Tambah akun server', `<form id="newAccount" class="form-grid"><label class="form-field">Nama<input class="field" name="name" required maxlength="60"></label><label class="form-field">Role<select name="role"><option>Kasir</option><option>Manajer</option><option>Admin</option><option>Pemilik</option></select></label><label class="form-field">PIN (4-8 angka)<input class="field" name="pin" type="password" required pattern="[0-9]{4,8}" maxlength="8" inputmode="numeric"></label><label class="form-field">Password pengelola<input class="field" name="password" type="password" minlength="10" maxlength="256" autocomplete="new-password"></label><p class="hint">Pembuatan akun memerlukan koneksi server.</p></form>`, [{ label: 'Batal', action: closeModal }, { label: 'Simpan', primary: true, action: async () => {
      if (busy) return;
      const form = document.getElementById('newAccount');
      form.elements.password.required = true;
      if (!form.reportValidity()) return;
      busy = true;
      try {
        const salt = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
        const user = { id: uid(), name: form.elements.name.value.trim(), role: form.elements.role.value, pinSalt: salt(), passwordSalt: salt() };
        user.pinHash = await hashCredential(form.elements.pin.value, user.pinSalt);
        user.passwordHash = await hashCredential(form.elements.password.value, user.passwordSalt);
        await request('/api/auth/accounts', 'POST', { ...user, identifier: form.elements.identifier.value, password: form.elements.password.value });
        state.users.push(user); save(); closeModal(); renderUsers(); toast('Akun dibuat di server.');
      } catch (e) { toast(e.message); }
      finally { busy = false; }
    } }]);
    const identity = document.createElement('label');
    identity.className = 'form-field';
    identity.innerHTML = 'Email atau nomor HP<input class="field" name="identifier" required maxlength="254" autocomplete="username">';
    document.getElementById('newAccount').prepend(identity);
  }
  function remove(user) {
    if (!owner() && !admin()) return toast('Hanya Pemilik atau Admin yang dapat menghapus akun.');
    if (!user || user.id === session.user.id) return toast('Akun yang sedang digunakan tidak dapat dihapus.');
    modal('Hapus akun', `<p>Nonaktifkan akun <strong>${esc(user.name)}</strong>? Riwayat transaksi tetap disimpan.</p>`, [{ label: 'Batal', action: closeModal }, { label: 'Hapus akun', danger: true, action: async () => {
      if (busy) return; busy = true;
      try { await request('/api/auth/accounts', 'DELETE', { id: user.id }); state.users = state.users.filter(u => u.id !== user.id); save(); closeModal(); renderUsers(); toast('Akun dinonaktifkan.'); }
      catch (e) { toast(e.message); }
      finally { busy = false; }
    } }]);
  }
  function login() {
    if (!valid()) return lock();
    modal('Akun pengguna', `<p>Masuk sebagai <strong>${esc(session.user.name)}</strong> (${esc(session.user.role)}).</p><p>Sesi berakhir ${new Date(session.expiresAt).toLocaleString('id-ID')}.</p>`, [{ label: 'Tutup', action: closeModal }, { label: 'Keluar', action: logout }]);
  }
  bind({ login, create, remove });
  document.querySelectorAll('button').forEach(button => {
    if (/Tambah pengguna/i.test(button.textContent)) button.onclick = create;
  });
  async function check() {
    if (logoutInProgress) return;
    if (!session) return;
    if (!valid()) return lock();
    if (!navigator.onLine) return;
    try { await request('/api/auth/session'); }
    catch (e) { if (e.status === 401) { if (!logoutInProgress) { lock(); toast(e.message); } } else toast('Validasi server belum tersedia. Sesi offline tetap aktif.'); }
  }
  document.addEventListener('click', event => { if (!logoutInProgress && !valid() && shell.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); lock(); } }, true);
  document.addEventListener('keydown', event => { if (!valid()) event.stopImmediatePropagation(); }, true);
  const backdrop = document.getElementById('modalBackdrop');
  const dialog = document.getElementById('modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'modalTitle');
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !backdrop.classList.contains('open')) return;
    const controls = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  window.addEventListener('online', check);
  window.addEventListener('online', () => { if (!logoutInProgress) void sessionSync(); });
  document.addEventListener('visibilitychange', () => { if (!logoutInProgress && !document.hidden) { void check(); void sessionSync(true); } });
  setInterval(() => { if (!logoutInProgress && valid() && !document.hidden) void sessionSync(false, true); }, 5000);
  setInterval(() => { if (!logoutInProgress && session && !valid()) lock(); }, 1000);
  if (valid()) { unlock(); await check(); } else lock();
};
