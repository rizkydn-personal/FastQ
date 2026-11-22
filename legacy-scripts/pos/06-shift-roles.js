function parseDdMmYyyy(value){
  const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value||'').trim());
  if(!m)return '';
  const d=Number(m[1]),mo=Number(m[2]),y=Number(m[3]);
  if(mo<1||mo>12||d<1||d>31)return '';
  const dt=new Date(y,mo-1,d);
  if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d)return '';
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function renderShift(){
  const sh=state.activeShift;
  const parsedDate=value=>{if(!value)return null;const date=new Date(value);return Number.isNaN(date.getTime())?null:date};
  const dateTime=value=>parsedDate(value)?.toLocaleString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})||'—';
  const dateOnly=value=>parsedDate(value)?.toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric'})||'—';
  const timeOnly=value=>parsedDate(value)?.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})||'—';
  const shortDateTime=value=>parsedDate(value)?.toLocaleString('id-ID',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})||'—';
  if(sh){
    const expected=expectedCash(sh),cashierCount=shiftCashierNames(state,sh).length;
    $('shiftOverview').innerHTML=`<div class="shift-banner shift-banner-active"><div class="shift-banner-header"><span class="shift-live-dot" aria-hidden="true"></span><div class="shift-banner-heading"><strong>Shift aktif</strong><span class="shift-copy-date"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>${shortDateTime(sh.openedAt)}</span></div></div><div class="shift-banner-content"><div class="shift-copy-row"><span>Dibuka oleh</span><span class="shift-copy-cashier">${esc(sh.openedBy||sh.cashier||'Kasir')} · ${cashierCount} kasir</span></div><div class="shift-metrics"><div class="shift-metric shift-metric-expected"><span>Kas diharapkan</span><strong>${rupiah(expected)}</strong></div><div class="shift-metric shift-metric-applied"><span>Kas diterapkan</span><strong>${rupiah(Number(sh.openingCash)||0)}</strong></div></div><button class="button shift-close-button" id="closeShift">Tutup shift</button></div></div>`;
    $('closeShift').onclick=shiftCloseModal;
  }else{
    $('shiftOverview').innerHTML=`<div class="shift-banner"><div class="shift-icon"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="15" rx="1"/><path d="M7 5V3h10v2m-5 5v5m-2.5-2.5h5"/></svg></div><div class="shift-copy"><strong>Belum ada shift aktif</strong><span>Buka shift untuk mulai mencatat penjualan dan kas.</span></div><button class="button primary" id="openShift">Buka shift</button></div>`;
    $('openShift').onclick=shiftOpenModal;
  }
  const movements=cashMovementsForActiveShift(),cashContext=`${state.activeOutlet}|${sh?.id||''}`;
  if(cashContext!==cashCardContext){cashCardContext=cashContext;cashCardPage=0}
  const cashPageCount=Math.ceil(movements.length/shiftCardPageSize);
  cashCardPage=Math.min(cashCardPage,Math.max(0,cashPageCount-1));
  const cashPageStart=cashCardPage*shiftCardPageSize,visibleMovements=movements.slice(cashPageStart,cashPageStart+shiftCardPageSize);
  $('cashBody').innerHTML=movements.map(m=>`<tr><td><span class="cash-time-full">${dateTime(m.at)}</span><span class="cash-time-short">${parsedDate(m.at)?.toLocaleString('id-ID',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})||'&mdash;'}</span></td><td>${m.type==='in'?'Kas masuk':'Kas keluar'}</td><td>${esc(m.reason)}</td><td class="numeric">${m.type==='out'?''+minus:''}${rupiah(m.amount)}</td><td class="cash-status-cell"></td></tr>`).join('')||'<tr><td colspan="5" class="empty-row">Belum ada pergerakan kas.</td></tr>';
  $('cashMobileList').innerHTML=visibleMovements.map(m=>`<article class="inventory-mobile-item cash-mobile-item"><div class="inventory-mobile-product"><strong>${m.type==='in'?'Kas masuk':'Kas keluar'}</strong><span>${dateTime(m.at)}</span></div><strong class="cash-mobile-amount${m.type==='out'?' cash-out':''}">${m.type==='out'?''+minus:''}${rupiah(m.amount)}</strong><div class="inventory-mobile-summary"><span>${esc(m.reason)}</span></div><div class="cash-mobile-status"><span>Status</span><div class="cash-mobile-status-value">—</div></div></article>`).join('')||'<div class="empty">Belum ada pergerakan kas.</div>';
  $('cashMobileList').innerHTML+=mobilePaginationMarkup(cashCardPage,cashPageCount);
  bindMobilePagination('cashMobileList',cashCardPage,cashPageCount,page=>{cashCardPage=page});
  relabelShiftPagination('cashMobileList');
  const rawShiftDate=($('shiftHistoryDate').value||'').trim();
  const selectedDate=parseDdMmYyyy(rawShiftDate);
  const dateKey=value=>{const date=parsedDate(value);return date?`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`:''};
  const shifts=state.shifts.filter(shift=>(!shift.outletId||shift.outletId===state.activeOutlet)&&(!rawShiftDate||(selectedDate&&dateKey(shift.openedAt)===selectedDate)));
  const emptyHistory=rawShiftDate?'Tidak ada shift pada tanggal ini.':'Belum ada riwayat shift.';
  const historyPageCount=Math.ceil(shifts.length/shiftCardPageSize);
  shiftCardPage=Math.min(shiftCardPage,Math.max(0,historyPageCount-1));
  const historyPageStart=shiftCardPage*shiftCardPageSize,visibleShifts=shifts.slice(historyPageStart,historyPageStart+shiftCardPageSize);
  $('shiftHistory').innerHTML=shifts.map(s=>`<tr><td>${dateTime(s.openedAt)}</td><td>${s.closedAt?dateTime(s.closedAt):'Belum ditutup'}</td><td>${esc(shiftCashierNames(state,s).join(', ')||'—')}</td><td class="numeric" style="color:${s.closedAt&&s.difference<0?'var(--red)':'inherit'}">${s.closedAt?cashDifferenceText(s.difference):'—'}</td></tr>`).join('')||`<tr><td colspan="4" class="empty-row">${emptyHistory}</td></tr>`;
  $('shiftHistoryCards').innerHTML=visibleShifts.map(s=>`<article class="inventory-mobile-item shift-history-card"><div class="inventory-mobile-product"><strong>${esc(s.openedBy||s.cashier||'—')}</strong><span>${dateOnly(s.openedAt)}</span></div><div class="cash-mobile-amount shift-history-difference${s.closedAt&&s.difference<0?' cash-out':''}"><span>${s.closedAt?'Selisih':'Status'}</span><strong>${s.closedAt?cashDifferenceText(s.difference):'Belum ditutup'}</strong></div><div class="inventory-mobile-summary"><div><span>Kasir bertugas</span><strong>${esc(shiftCashierNames(state,s).join(', ')||'—')}</strong></div><div><span>Mulai</span><strong>${timeOnly(s.openedAt)}</strong></div><div><span>Selesai</span><strong>${s.closedAt?timeOnly(s.closedAt):'Belum ditutup'}</strong></div></div></article>`).join('')||`<div class="empty">${emptyHistory}</div>`;
  $('shiftHistoryCards').innerHTML+=mobilePaginationMarkup(shiftCardPage,historyPageCount);
  bindMobilePagination('shiftHistoryCards',shiftCardPage,historyPageCount,page=>{shiftCardPage=page});
  relabelShiftPagination('shiftHistoryCards');
  ensureShiftGemini3();
  document.querySelectorAll('[data-cash]').forEach(b=>b.onclick=()=>cashModal(b.dataset.cash));
}
$('shiftHistoryDate').onchange=()=>{shiftCardPage=0;renderShift()};
$('shiftHistoryDate').addEventListener('input',e=>{
  const digits=e.target.value.replace(/\D/g,'').slice(0,8);
  let out=digits;
  if(digits.length>4)out=digits.slice(0,2)+'/'+digits.slice(2,4)+'/'+digits.slice(4);
  else if(digits.length>2)out=digits.slice(0,2)+'/'+digits.slice(2);
  if(out!==e.target.value)e.target.value=out;
  syncShiftDateReset();
});
function relabelShiftPagination(listId){
  // Render memakai "‹ Prev" / "n / m" / "Next ›" (bukan "Sebelumnya" /
  // "Halaman n dari m"). Hanya ubah label — tombol tetap memakai
  // data-card-page + bindMobilePagination dari 05-shift-cash.js.
  const nav=document.getElementById(listId)?.querySelector('.mobile-card-pagination');
  if(!nav)return;
  const prev=nav.querySelector('[data-card-page="previous"]'),next=nav.querySelector('[data-card-page="next"]'),info=nav.querySelector('span');
  if(prev)prev.textContent='‹ Prev';
  if(next)next.textContent='Next ›';
  if(info){const m=/Halaman (\d+) dari (\d+)/.exec(info.textContent||'');if(m)info.textContent=`${m[1]} / ${m[2]}`;}
}
function ensureShiftGemini3(){
  // Hint "Ketuk baris untuk detail" (render) di judul panel Pergerakan kas.
  const cashTitle=document.querySelector('#page-shift .section-split > .panel:first-child .panel-title');
  if(cashTitle&&!cashTitle.querySelector('.cash-hint')){
    cashTitle.classList.add('cash-title-with-hint');
    const hint=document.createElement('span');hint.className='cash-hint';hint.textContent='Ketuk baris untuk detail';cashTitle.appendChild(hint);
  }
  // Subjudul "Rekap shift selesai dan selisih kas" (render) di panel Riwayat shift.
  const histPanel=document.querySelector('#page-shift .section-split > .panel:last-child');
  const histTitle=histPanel?.querySelector('.panel-title');
  if(histTitle&&!histPanel.querySelector('.shift-history-subtitle')){
    const sub=document.createElement('p');sub.className='shift-history-subtitle';sub.textContent='Rekap shift selesai dan selisih kas';histTitle.after(sub);
  }
  // Tombol "Reset" filter tanggal (render #btnClearShiftDate): membersihkan
  // input tanggal. Input TETAP teks dd/mm/yyyy (bukan type=date).
  const dateInput=$('shiftHistoryDate');
  if(dateInput&&!document.getElementById('btnClearShiftDate')){
    const row=document.createElement('div');row.className='shift-date-row';
    dateInput.before(row);row.appendChild(dateInput);
    const btn=document.createElement('button');btn.type='button';btn.id='btnClearShiftDate';btn.textContent='Reset';
    btn.onclick=()=>{dateInput.value='';shiftCardPage=0;renderShift()};
    row.appendChild(btn);
  }
  syncShiftDateReset();
}
function syncShiftDateReset(){
  // Render menyembunyikan Reset saat tidak ada filter tanggal aktif.
  const btn=document.getElementById('btnClearShiftDate'),input=$('shiftHistoryDate');
  if(btn&&input)btn.hidden=!input.value.trim();
}
function renderRole(skipSave=false){document.body.dataset.role=role;const signedIn=state.users?.find(u=>u.id===state.settings.activeUserId),canEdit=hasRole('Admin'),canView=hasRole('Admin','Pemilik','Manajer'),canCreateUsers=hasRole('Pemilik'),hide=(id,hidden)=>{const control=$(id);if(control)control.hidden=hidden};$('roleName').textContent=signedIn?.name||role;$('avatar').textContent=role==='Kasir'?'KA':role==='Manajer'?'MN':role==='Admin'?'AD':'PM';document.querySelectorAll('.sidebar .nav-link[data-page]').forEach(button=>button.hidden=sessionAuthenticated&&!ROLE_PAGES[role]?.includes(button.dataset.page));for(const id of ['addProductButton','importProducts','receiptSettingsButton'])hide(id,!canEdit);hide('addUserButton',!canCreateUsers);hide('addOutletButton',true);hide('exportProducts',!canView);hide('exportSales',!canView);hide('printReports',!canView);hide('exportAttendance',!canView);hide('mobileMoreButton',!['products','outlets','users'].some(function(p){return ROLE_PAGES[role]&&ROLE_PAGES[role].indexOf(p)>-1;}));document.querySelectorAll('[data-header-action]').forEach(button=>{const action=button.dataset.headerAction;button.hidden=action==='receipt'?!canEdit:['outlets','users'].includes(action)?!canView:false});state.settings.role=role;if(!skipSave)save();renderAttendance()}
function rolePicker(){if(sessionAuthenticated){modal('Akun pengguna',`<p>Masuk sebagai <strong>${esc(state.users.find(u=>u.id===state.settings.activeUserId)?.name||role)}</strong>.</p>`,[{label:'Tutup',action:closeModal},{label:'Keluar',action:()=>{const name=state.users.find(u=>u.id===state.settings.activeUserId)?.name||role;sessionAuthenticated=false;state.settings.activeUserId=null;state.settings.sessionExpiresAt=null;role='Kasir';renderRole();page('pos');log('Logout',name);closeModal();toast('Sesi ditutup')}}]);return}if(!state.users.length){page('users');return toast('Buat akun Kasir, Manajer, atau Pemilik terlebih dahulu.')}modal('Login pengguna',`<div class="form-field"><label>Akun pengguna</label><select id="loginUser">${state.users.map(u=>`<option value="${u.id}">${esc(u.name)} · ${esc(u.role)}</option>`).join('')}</select></div><div class="form-field" style="margin-top:12px"><label>PIN</label><input class="field" id="loginPin" type="password" inputmode="numeric" maxlength="8"></div><div class="form-field" id="loginPasswordWrap" style="margin-top:12px" hidden><label>Password</label><input class="field" id="loginPassword" type="password"></div><div class="form-field" id="loginTotpWrap" style="margin-top:12px" hidden><label>Kode authenticator</label><input class="field" id="loginTotp" inputmode="numeric" maxlength="6"></div>`,[{label:'Batal',action:closeModal},{label:'Login',primary:true,action:async()=>{const u=state.users.find(x=>x.id===$('loginUser').value);if(!u)return toast('Pilih akun pengguna');if(!await verifyCredential($('loginPin').value,u.pinSalt,u.pinHash))return toast('PIN tidak sesuai');if(u.role!=='Kasir'){if(!await verifyCredential($('loginPassword').value,u.passwordSalt,u.passwordHash))return toast('Password tidak sesuai');if(u.twoFactorSecret&&!await verifyTotp(u.twoFactorSecret,$('loginTotp').value))return toast('Kode authenticator tidak sesuai')}role=u.role;sessionAuthenticated=true;state.settings.activeUserId=u.id;state.settings.sessionExpiresAt=Date.now()+30*24*60*60*1000;renderRole();log('Login',u.name);closeModal();toast(`Login sebagai ${u.name}`)}}]);const update=()=>{const user=state.users.find(x=>x.id===$('loginUser').value),privileged=user?.role!=='Kasir';$('loginPasswordWrap').hidden=!privileged;$('loginTotpWrap').hidden=!privileged||!user?.twoFactorSecret};$('loginUser').onchange=update;update()}function receiptSettingsModal(){let logoDraft=state.settings.receiptLogo||'';const preview=()=>{const node=$('receiptLogoPreview');node.innerHTML=logoDraft?`<img src="${esc(logoDraft)}" alt="Pratinjau logo struk" style="display:block;max-width:180px;max-height:80px;object-fit:contain">`:'<span class="hint">Belum ada logo.</span>'};modal('Template struk',`<div class="form-grid"><div class="form-field"><label>Nama toko</label><input class="field" id="receiptStore" maxlength="60" value="${esc(state.settings.storeName||'Toko Utama')}"></div><div class="form-field"><label>Lebar kertas</label><select id="receiptWidth"><option value="58" ${state.settings.receiptWidth==='58'?'selected':''}>58 mm</option><option value="80" ${state.settings.receiptWidth!=='58'?'selected':''}>80 mm</option></select></div><div class="form-field" style="grid-column:1/-1"><label for="receiptLogoInput">Logo struk (PNG, JPEG, atau WebP; maksimal 512 KB)</label><input class="field" id="receiptLogoInput" type="file" accept="image/png,image/jpeg,image/webp"><div id="receiptLogoPreview" style="min-height:48px;display:flex;align-items:center">${logoDraft?`<img src="${esc(logoDraft)}" alt="Pratinjau logo struk" style="display:block;max-width:180px;max-height:80px;object-fit:contain">`:'<span class="hint">Belum ada logo.</span>'}</div><button type="button" class="button small" id="removeReceiptLogo">Hapus logo</button></div><div class="form-field" style="grid-column:1/-1"><label>Alamat / kontak</label><input class="field" id="receiptAddress" maxlength="120" value="${esc(state.settings.storeAddress||'')}" placeholder="Alamat dan nomor telepon toko"></div><div class="form-field" style="grid-column:1/-1"><label>Catatan kaki</label><input class="field" id="receiptFooter" maxlength="120" value="${esc(state.settings.receiptFooter||'Terima kasih atas kunjungan Anda.')}" ></div></div><p class="hint">Struk dibagikan sebagai gambar dan dicetak melalui Bluetooth.</p>`,[{label:'Batal',action:closeModal},{label:'Simpan template',primary:true,action:()=>{state.settings.storeName=$('receiptStore').value.trim()||'Toko';state.settings.storeAddress=$('receiptAddress').value.trim();state.settings.receiptFooter=$('receiptFooter').value.trim();state.settings.receiptWidth=$('receiptWidth').value;state.settings.receiptLogo=logoDraft;save();log('Template struk diperbarui');closeModal();toast('Template struk disimpan')}}],true);$('receiptLogoInput').onchange=async e=>{const file=e.currentTarget.files?.[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type))return toast('Pilih gambar PNG, JPEG, atau WebP.');if(file.size>512*1024){e.currentTarget.value='';return toast('Ukuran logo maksimal 512 KB.')}try{logoDraft=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('Logo tidak dapat dibaca.'));reader.readAsDataURL(file)});preview()}catch(error){toast(error.message||'Logo tidak dapat dibaca.')}};$('removeReceiptLogo').onclick=()=>{logoDraft='';$('receiptLogoInput').value='';preview()}}
