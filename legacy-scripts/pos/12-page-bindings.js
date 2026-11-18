function handleProductSearchEnter(event){if(event.key!=='Enter')return;event.preventDefault();const input=event.currentTarget,code=input.value.trim();if(!code)return;const normalized=code.toLowerCase(),product=state.products.find(item=>item.barcode===code||item.sku.toLowerCase()===normalized||item.variants?.some(variant=>variant.barcode===code||variant.sku.toLowerCase()===normalized));if(product){const variant=product.variants?.find(item=>item.barcode===code||item.sku.toLowerCase()===normalized);if(variant)addLine(product,variant);else addProduct(product);input.value='';renderProducts();return}const matches=shownProducts();if(matches.length===1){addProduct(matches[0]);input.value='';renderProducts()}else if(!matches.length)toast('Produk tidak ditemukan')}
$('productSearch').onkeydown=handleProductSearchEnter;
await window.installAccounts({
  state, save, toast, modal, closeModal, esc, uid, hashCredential, openCartPreview,
  installSessionSync(run, persistCritical) {
    syncNow = run;
    syncCriticalEvent = persistCritical;
  },
  syncHooks: {
    bootstrap: bootstrapSync,
    merge(event) { mergeSyncEvent(event); },
    status: setSyncStatus,
    renderOutlets,
    refresh(clearAll = false) { renderProducts(); renderCart(); renderInventory(); renderReports(); renderOutlets(); if (clearAll) renderShift(); },
  },
  setSession(user, expiresAt, persist = true) {
    sessionAuthenticated = !!user;
    role = user?.role || 'Kasir';
    state.settings.activeUserId = user?.id || null;
    state.settings.sessionExpiresAt = expiresAt || null;
    renderRole(!persist); renderUsers();
    const activePage=document.querySelector('.page.active')?.id.replace('page-','');
    if(user)page(ROLE_PAGES[role]?.includes(activePage)?activePage:ROLE_PAGES[role]?.includes('pos')?'pos':'reports');
  },
  bind({ login, create, remove }) {
    rolePicker = login; userModal = create; deleteUser = remove;
    $('roleButton').onclick = login;
  },
  renderUsers,
});
function guardAction(action,roles,message){return function(...args){if(!requireRole(roles,message))return;return action.apply(this,args)}}
shiftOpenModal=guardAction(shiftOpenModal,['Kasir','Admin']);
shiftCloseModal=guardAction(shiftCloseModal,['Kasir','Admin']);
productModal=guardAction(productModal,['Admin']);
stockModal=guardAction(stockModal,['Admin']);
variantsModal=guardAction(variantsModal,['Admin']);
saveProduct=guardAction(saveProduct,['Admin']);
deleteProduct=guardAction(deleteProduct,['Admin']);
transferStock=guardAction(transferStock,['Admin']);
refundSale=guardAction(refundSale,['Admin']);
completeSaleRefund=guardAction(completeSaleRefund,['Admin']);
paymentModal=guardAction(paymentModal,['Kasir','Admin']);
receiptSettingsModal=guardAction(receiptSettingsModal,['Admin']);
receiveReceivable=guardAction(receiveReceivable,['Admin']);
settleSale=guardAction(settleSale,['Admin']);
voidSale=guardAction(voidSale,['Admin']);
const originalCashModal=cashModal;
cashModal=function(direction){if(!requireRole(['Kasir','Admin','Pemilik']))return;if(role==='Pemilik'&&direction!=='out')return toast('Pemilik hanya dapat mencatat kas keluar.');return originalCashModal(direction)};
const originalLog=log;
log=function(action,detail=''){if(action==='Kas masuk'||action==='Kas keluar'){const movement=state.cashMovements[0];if(movement&&!movement.approvalStatus){movement.requestedById=state.settings.activeUserId;movement.approvalStatus=action==='Kas keluar'&&role==='Kasir'?'pending':'approved';if(movement.approvalStatus==='approved'){movement.approvedBy=currentUserName();movement.approvedAt=movement.at}}}return originalLog(action,detail)};
expectedCash=function(shift){const cashSales=state.sales.filter(s=>!['Void','Gagal','Menunggu'].includes(s.status)).flatMap(s=>(s.payments||[]).filter(p=>p.method==='Tunai'&&(p.shiftId||s.shiftId)===shift.id)).reduce((sum,payment)=>sum+payment.amount,0),moves=state.cashMovements.filter(movement=>movement.shiftId===shift.id&&movement.approvalStatus!=='pending'&&movement.approvalStatus!=='rejected').reduce((sum,movement)=>sum+(movement.type==='in'?movement.amount:-movement.amount),0);return shift.openingCash+cashSales+moves};
const originalShiftCloseModal=shiftCloseModal;
shiftCloseModal=function(){if(!requireRole(['Kasir','Admin']))return;if(state.activeShift&&state.cashMovements.some(movement=>movement.shiftId===state.activeShift.id&&movement.type==='out'&&movement.approvalStatus==='pending'))return toast('Tunggu persetujuan Admin atau Pemilik untuk semua kas keluar sebelum menutup shift.');return originalShiftCloseModal()};
function cashApprovalMarkup(movement){if(movement.type==='in')return'<div class="hint">Tercatat</div>';const approvalStatus=movement.approvalStatus||'approved';if(approvalStatus==='pending')return hasRole('Admin','Pemilik')?`<div class="cash-approval-actions"><button class="button small" data-cash-approval="approved" data-cash-id="${esc(movement.id)}">Setujui</button> <button class="button small danger" data-cash-approval="rejected" data-cash-id="${esc(movement.id)}">Tolak</button></div>`:'<div class="hint">Menunggu persetujuan</div>';return `<div class="hint">${approvalStatus==='approved'?'Disetujui':'Ditolak'}${movement.approvedBy?` · ${esc(movement.approvedBy)}`:''}</div>`}
function decideCashMovement(id,status){if(!requireRole(['Admin','Pemilik']))return;const movement=state.cashMovements.find(item=>item.id===id);if(!movement||movement.type!=='out'||movement.approvalStatus!=='pending')return toast('Kas keluar ini sudah diproses atau tidak ditemukan.');movement.approvalStatus=status;movement.approvedBy=currentUserName();movement.approvedAt=new Date().toISOString();enqueueEvent('cash.approval',{id:movement.id,approvalStatus:status,approvedBy:movement.approvedBy,approvedAt:movement.approvedAt},movement.outletId||state.activeOutlet);save();log(status==='approved'?'Kas keluar disetujui':'Kas keluar ditolak',`${rupiah(movement.amount)} - ${movement.reason}`);renderShift();toast(status==='approved'?'Kas keluar disetujui':'Kas keluar ditolak')}
const originalRenderShift=renderShift;
renderShift=function(){
  originalRenderShift();
  const canManageShift=hasRole('Kasir','Admin'),openButton=$('openShift'),closeButton=$('closeShift'),hasPendingCash=!!state.activeShift&&state.cashMovements.some(movement=>movement.shiftId===state.activeShift.id&&movement.type==='out'&&movement.approvalStatus==='pending');
  if(openButton)openButton.hidden=!canManageShift;
  if(closeButton){closeButton.hidden=!canManageShift;closeButton.disabled=hasPendingCash;closeButton.title=hasPendingCash?'Tunggu keputusan Admin atau Pemilik untuk kas keluar tertunda.':''}
  document.querySelectorAll('[data-cash]').forEach(button=>{button.hidden=!hasRole('Kasir','Admin')&&!(button.dataset.cash==='out'&&hasRole('Pemilik'))});
  const movements=cashMovementsForActiveShift(),rows=$('cashBody').querySelectorAll('tr'),cards=$('cashMobileList').querySelectorAll('.cash-mobile-item');
  movements.forEach((movement,index)=>{
    const statusMarkup=cashApprovalMarkup(movement)||'—',statusCell=rows[index]?.querySelector('.cash-status-cell'),mobileIndex=index-cashCardPage*shiftCardPageSize,mobileStatus=cards[mobileIndex]?.querySelector('.cash-mobile-status-value');
    if(statusCell)statusCell.innerHTML=statusMarkup;
    if(mobileStatus)mobileStatus.innerHTML=statusMarkup;
  });
  document.querySelectorAll('[data-cash-approval]').forEach(button=>button.onclick=()=>decideCashMovement(button.dataset.cashId,button.dataset.cashApproval));
};
const originalRenderInventory=renderInventory;
renderInventory=function(){originalRenderInventory();if(!hasRole('Admin'))document.querySelectorAll('#inventoryBody button,#inventoryMobileList .inventory-action-picker').forEach(button=>button.hidden=true)};
const originalRenderReports=renderReports;
renderReports=function(){originalRenderReports();if(!hasRole('Admin'))document.querySelectorAll('#salesBody button').forEach(button=>button.hidden=true)};
const originalRenderUsers=renderUsers;
renderUsers=function(){originalRenderUsers();if(!hasRole('Admin','Pemilik'))document.querySelectorAll('#usersBody [data-user-delete]').forEach(button=>button.hidden=true)};
new MutationObserver(()=>{if(!hasRole('Admin','Pemilik'))document.querySelectorAll('#usersBody [data-user-delete]').forEach(button=>button.hidden=true)}).observe($('usersBody'),{childList:true});
const originalRenderOutlets=renderOutlets;
renderOutlets=function(){originalRenderOutlets();if(!hasRole('Admin'))document.querySelectorAll('#page-outlets .form-grid,#transferButton').forEach(control=>control.hidden=true)};
state.attendance ||= [];
state.attendance ||= [];
