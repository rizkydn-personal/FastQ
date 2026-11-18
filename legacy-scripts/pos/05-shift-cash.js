function shiftOpenModal(){
  if(!sessionAuthenticated){rolePicker();return toast('Login sebelum membuka shift.')}
  if(state.activeShift)return toast('Shift outlet ini sudah dibuka. Gunakan shift yang sedang aktif.');
  modal('Buka shift',`<div class="form-field"><label>Modal awal (Rp)</label><input id="openingCash" class="field" type="text" value="${state.activeShift?'':0}" inputmode="numeric"></div><p class="hint">Pastikan jumlah uang di laci kas sesuai sebelum mulai menerima transaksi.</p>`,[
    {label:'Batal',action:closeModal},
    {label:'Buka shift',primary:true,action:async()=>{
      const amount=parseRupiahInput($('openingCash').value);
      if(!Number.isSafeInteger(amount)||amount<0)return toast('Modal awal harus berupa Rupiah bulat yang tidak negatif');
      const commitKey='shift-open:'+state.activeOutlet;
      if(!beginLocalCommit(commitKey))return;
      const opened={id:uid(),openedAt:new Date().toISOString(),openingCash:amount,cashier:currentUserName(),openedBy:currentUserName(),openedById:state.settings.activeUserId,cashiers:[currentUserName()],outletId:state.activeOutlet,salesIds:[]};
      mergeShiftEvent(state,opened);
      const event=enqueueEvent('shift.upsert',opened,opened.outletId);
      save();
      log('Shift dibuka',rupiah(amount));
      const audit=state.audit.at(-1);
      removeDuplicateShiftEvent(event);
      save();
      try{await flushEncryptedWrites()}
      catch{
        endLocalCommit(commitKey);closeModal();renderCart();renderShift();
        toast('Shift belum tersimpan lokal. Jangan tutup aplikasi; penyimpanan akan dicoba ulang.');
        return;
      }
      let synced=false;
      if(navigator.onLine){
        const button=$('modalFoot').querySelector('[data-modal-action="1"]');
        if(button){button.disabled=true;button.textContent='Menyimpan...'}
        try{synced=await submitCriticalEvent(event)}
        catch(error){
          if(button){button.disabled=false;button.textContent='Buka shift'}
          const rejected=Number.isInteger(error.status)&&error.status>=400&&error.status<500&&error.status!==408;
          if(!rejected){
            endLocalCommit(commitKey);closeModal();renderCart();renderShift();
            toast('Status shift belum dapat dipastikan. Data tersimpan lokal dan sinkronisasi akan dicoba lagi.');
            void syncNow();
            return;
          }
          if(state.activeShift?.id===opened.id)state.activeShift=null;
          state.shifts=state.shifts.filter(item=>item.id!==opened.id);
          removeCriticalEventAndAudit(event,audit);
          let rollbackSaved=true;
          try{await flushEncryptedWrites()}catch{rollbackSaved=false}
          endLocalCommit(commitKey);
          renderCart();renderShift();
          toast(rollbackSaved?`Shift belum dibuka ke database: ${error.message}`:'Shift ditolak server, tetapi pembatalan lokal belum tersimpan. Jangan tutup aplikasi; penyimpanan akan dicoba ulang.');
          void syncNow();
          return;
        }
      }
      endLocalCommit(commitKey);
      closeModal();renderCart();renderShift();
      toast(synced?'Shift dibuka dan tercatat di database.':'Shift dibuka offline; akan disinkronkan saat internet tersedia.');
    }}
  ]);
  $('openingCash').oninput=()=>formatRupiahInput($('openingCash'));
}
function expectedCash(shift){return expectedCashForShift(shift,state.sales,state.cashMovements)}
function shiftCloseModal(){
  if(!sessionAuthenticated){rolePicker();return toast('Login sebelum menutup shift.')}
  const shift=state.activeShift;
  if(!shift)return;
  if(role!=='Admin'&&shift.openedById&&shift.openedById!==state.settings.activeUserId)return toast(`Shift dibuka oleh ${shift.openedBy||shift.cashier||'kasir lain'}; hanya perwakilan pembuka yang dapat menutupnya.`);
  const expected=expectedCash(shift);
  modal('Tutup shift',`<div class="detail-list"><div class="detail-row"><span>Modal awal</span><strong>${rupiah(shift.openingCash)}</strong></div><div class="detail-row"><span>Kas yang diharapkan</span><strong>${rupiah(expected)}</strong></div></div><div class="form-field" style="margin-top:16px"><label>Uang fisik dihitung (Rp)</label><input id="physicalCash" class="field" type="text" inputmode="numeric" placeholder="0"></div><div class="cash-difference-preview" id="cashDifferencePreview" data-state="empty" role="status" aria-live="polite" aria-label="Preview selisih"><span class="cash-difference-preview-label">Preview selisih</span><strong id="cashDifferenceValue">—</strong></div>`,[
    {label:'Batal',action:closeModal},
    {label:'Tutup shift',primary:true,action:async()=>{
      const physicalInput=$('physicalCash').value,physical=parseRupiahInput(physicalInput);
      if(!physicalInput.trim()||!Number.isSafeInteger(physical)||physical<0)return toast('Masukkan jumlah uang fisik dalam Rupiah bulat');
      const commitKey='shift-close:'+shift.id;
      if(!beginLocalCommit(commitKey))return;
      const closed={...shift,closedAt:new Date().toISOString(),closedBy:currentUserName(),cashiers:shiftCashierNames(state,shift),expectedCash:expected,physicalCash:physical,difference:physical-expected,saleCount:state.sales.filter(s=>s.shiftId===shift.id).length};
      mergeShiftEvent(state,closed);
      const event=enqueueEvent('shift.upsert',closed,closed.outletId||state.activeOutlet);
      save();
      log('Shift ditutup',`Selisih ${rupiah(closed.difference)}`);
      const audit=state.audit.at(-1);
      removeDuplicateShiftEvent(event);
      save();
      try{await flushEncryptedWrites()}
      catch{
        endLocalCommit(commitKey);closeModal();renderShift();renderCart();
        toast('Penutupan shift belum tersimpan lokal. Jangan tutup aplikasi; penyimpanan akan dicoba ulang.');
        return;
      }
      let synced=false;
      if(navigator.onLine){
        const button=$('modalFoot').querySelector('[data-modal-action="1"]');
        if(button){button.disabled=true;button.textContent='Menyimpan...'}
        try{synced=await submitCriticalEvent(event)}
        catch(error){
          if(button){button.disabled=false;button.textContent='Tutup shift'}
          const rejected=Number.isInteger(error.status)&&error.status>=400&&error.status<500&&error.status!==408;
          if(!rejected){
            endLocalCommit(commitKey);closeModal();renderShift();renderCart();
            toast('Status penutupan shift belum dapat dipastikan. Data tersimpan lokal dan sinkronisasi akan dicoba lagi.');
            void syncNow();
            return;
          }
          state.activeShift=shift;
          const history=state.shifts.find(item=>item.id===shift.id);
          if(history)Object.assign(history,shift);
          removeCriticalEventAndAudit(event,audit);
          let rollbackSaved=true;
          try{await flushEncryptedWrites()}catch{rollbackSaved=false}
          endLocalCommit(commitKey);
          renderShift();renderCart();
          toast(rollbackSaved?`Shift belum ditutup di database: ${error.message}`:'Shift ditolak server, tetapi pembatalan lokal belum tersimpan. Jangan tutup aplikasi; penyimpanan akan dicoba ulang.');
          return;
        }
      }
      endLocalCommit(commitKey);
      closeModal();renderShift();renderCart();
      modal('Shift ditutup',`<p class="hint">${synced?'Perubahan tercatat di database.':'Disimpan offline dan akan disinkronkan saat internet tersedia.'}</p><div class="detail-list"><div class="detail-row"><span>Kas seharusnya</span><strong>${rupiah(expected)}</strong></div><div class="detail-row"><span>Kas fisik</span><strong>${rupiah(physical)}</strong></div><div class="detail-row"><span>Selisih</span><strong style="color:${closed.difference===0?'#0B2A5B':'#D92D20'}">${cashDifferenceText(closed.difference)}</strong></div></div>`,[{label:'Selesai',primary:true,action:closeModal}]);
    }}
  ]);
  const physicalCash=$('physicalCash'),preview=$('cashDifferencePreview'),differenceValue=$('cashDifferenceValue');
  physicalCash.oninput=()=>{
    formatRupiahInput(physicalCash);
    const raw=physicalCash.value.trim();
    if(!raw){preview.dataset.state='empty';differenceValue.textContent='—';return}
    const physical=parseRupiahInput(raw),difference=physical-expected;
    if(!Number.isSafeInteger(physical)||!Number.isSafeInteger(difference)){preview.dataset.state='invalid';differenceValue.textContent='Tidak valid';return}
    preview.dataset.state=difference===0?'balanced':difference<0?'shortage':'surplus';
    differenceValue.textContent=cashDifferenceText(difference);
  };
}
function cashModal(direction){const petty=direction==='petty',type=petty?'out':direction;if(!sessionAuthenticated){rolePicker();return toast('Login sebelum mencatat kas.')}if(!state.activeShift)return toast('Buka shift terlebih dahulu');modal(petty?'Kas kecil / petty cash':type==='in'?'Kas masuk':'Kas keluar',`<div class="form-grid">${petty?`<div class="form-field"><label>Arah kas</label><select id="cashDirection"><option value="out">Kas keluar</option><option value="in">Kas masuk</option></select></div><div class="form-field"><label>Kategori</label><select id="cashCategory"><option>Belanja operasional</option><option>Transportasi</option><option>Perawatan</option><option>Konsumsi</option><option>Lainnya</option></select></div>`:''}<div class="form-field"><label>Jumlah (Rp)</label><input class="field" id="cashAmount" type="text" inputmode="numeric" placeholder="0"></div><div class="form-field"><label>Alasan</label><input class="field" id="cashReason" maxlength="100" placeholder="${type==='in'?'Contoh: modal tambahan':'Contoh: pembelian operasional'}"></div></div>`,[{label:'Batal',action:closeModal},{label:'Simpan',primary:true,action:()=>{const amount=parseRupiahInput($('cashAmount').value),reason=$('cashReason').value.trim(),actualType=petty?$('cashDirection').value:type,category=petty?$('cashCategory').value:'Operasional';if(!Number.isSafeInteger(amount)||amount<=0)return toast('Jumlah harus berupa Rupiah bulat di atas nol');if(!reason)return toast('Alasan wajib diisi');state.cashMovements.unshift({id:uid(),at:new Date().toISOString(),shiftId:state.activeShift.id,type:actualType,category,amount,reason,cashier:currentUserName()});save();log(actualType==='in'?'Kas masuk':'Kas keluar',`${petty?'Kas kecil - '+category+' - ':''}${rupiah(amount)} - ${reason}`);closeModal();renderShift();toast(petty?'Kas kecil tersimpan':'Pergerakan kas tersimpan')}}]);$('cashAmount').oninput=()=>formatRupiahInput($('cashAmount'))}
const shiftCardPageSize=3;
let cashCardPage=0,shiftCardPage=0,cashCardContext='',discountApprovalPage=0,discountApprovalDate='';
function cashMovementsForActiveShift(){return state.activeShift?state.cashMovements.filter(movement=>movement.shiftId===state.activeShift.id):[]}
function mobilePaginationMarkup(page,pageCount){if(pageCount<=1)return'';return`<nav class="mobile-card-pagination" aria-label="Navigasi daftar"><button type="button" class="button small" data-card-page="previous" ${page===0?'disabled':''}>Sebelumnya</button><span>Halaman ${page+1} dari ${pageCount}</span><button type="button" class="button small" data-card-page="next" ${page===pageCount-1?'disabled':''}>Berikutnya</button></nav>`}
function bindMobilePagination(listId,page,pageCount,setPage){if(pageCount<=1)return;const list=$(listId);list.querySelector('[data-card-page="previous"]')?.addEventListener('click',()=>{setPage(page-1);renderShift()});list.querySelector('[data-card-page="next"]')?.addEventListener('click',()=>{setPage(page+1);renderShift()})}
