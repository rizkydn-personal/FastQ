function renderAttendance(){
  const records=state.attendance.filter(record=>!record.outletId||record.outletId===state.activeOutlet).sort((a,b)=>String(b.checkIn).localeCompare(String(a.checkIn)));
  const userId=state.settings.activeUserId,workDate=today(),current=records.find(record=>record.userId===userId&&attendanceDateKey(record.workDate)===workDate),canPunch=hasRole('Kasir','Admin'),canViewLocations=hasRole('Admin','Pemilik','Manajer');
  $('attendanceIn').hidden=!canPunch||!!current;
  $('attendanceOut').hidden=!canPunch||!current||!!current.checkOut;
  $('attendanceLocationInHeader').hidden=!canViewLocations;
  $('attendanceLocationOutHeader').hidden=!canViewLocations;
  $('attendanceStatus').innerHTML=`<div class="detail-row"><span>Status hari ini</span><strong>${!current?'Belum absen masuk':current.checkOut?'Absen selesai':'Sedang bekerja'}</strong></div>${current?`<div class="detail-row"><span>Jam masuk</span><strong>${attendanceTimeLabel(current.checkIn)}</strong></div>${current.checkOut?`<div class="detail-row"><span>Jam pulang</span><strong>${attendanceTimeLabel(current.checkOut)}</strong></div>`:''}`:''}`;
  $('attendanceBody').innerHTML=records.map(record=>`<tr><td>${esc(record.userName)}</td><td>${esc(attendanceDateLabel(record.workDate))}</td><td>${attendanceTimeLabel(record.checkIn)}</td><td>${record.checkOut?attendanceTimeLabel(record.checkOut):'—'}</td>${canViewLocations?`<td>${attendanceLocationMarkup(record.checkInLocation)}</td><td>${attendanceLocationMarkup(record.checkOutLocation)}</td>`:''}</tr>`).join('')||`<tr><td colspan="${canViewLocations?6:4}" class="empty-row">Belum ada data absensi.</td></tr>`;
}
let attendanceSubmitting=false;
function getAttendanceLocation(){
  if(!navigator.geolocation)return Promise.reject(new Error('Perangkat ini tidak mendukung lokasi. Aktifkan lokasi di perangkat atau gunakan browser yang mendukung GPS.'));
  return new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(position=>{
    const{latitude,longitude,accuracy}=position.coords;
    if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180||!Number.isFinite(accuracy)||accuracy<0)return reject(new Error('Data lokasi tidak valid. Coba aktifkan GPS lalu ulangi.'));
    const capturedAt=new Date(position.timestamp);
    if(Number.isNaN(capturedAt.getTime()))return reject(new Error('Waktu lokasi tidak valid. Coba ulangi.'));
    resolve({latitude,longitude,accuracy,capturedAt:capturedAt.toISOString()});
  },error=>{
    const message=error.code===1?'Izin lokasi ditolak. Izinkan akses lokasi di pengaturan browser atau perangkat.':error.code===2?'Lokasi tidak tersedia. Periksa GPS atau koneksi perangkat.':'Pengambilan lokasi terlalu lama. Coba aktifkan GPS lalu ulangi.';
    reject(new Error(message));
  },{enableHighAccuracy:true,maximumAge:0,timeout:20000}));
}
async function setAttendance(direction){
  if(!requireRole(['Kasir','Admin'])||attendanceSubmitting)return;
  const userId=state.settings.activeUserId,workDate=today(),record=state.attendance.find(item=>item.userId===userId&&attendanceDateKey(item.workDate)===workDate&&item.outletId===state.activeOutlet);
  if(direction==='in'&&record)return toast('Absensi masuk hari ini sudah tercatat.');
  if(direction==='out'&&!record)return toast('Catat absensi masuk terlebih dahulu.');
  if(direction==='out'&&record.checkOut)return toast('Absensi pulang hari ini sudah tercatat.');
  const button=$(direction==='in'?'attendanceIn':'attendanceOut'),buttonLabel=button.textContent;
  attendanceSubmitting=true;
  button.disabled=true;button.textContent='Mengambil lokasi...';
  let location;
  try{location=await getAttendanceLocation()}catch(error){attendanceSubmitting=false;button.disabled=false;button.textContent=buttonLabel;toast(error.message);return}
  const at=new Date().toISOString();
  let event,entry;
  if(direction==='in'){
    entry={id:uid(),outletId:state.activeOutlet,userId,userName:currentUserName(),workDate,checkIn:at,checkOut:null,checkInLocation:location,checkOutLocation:null};
    state.attendance.unshift(entry);
    event=enqueueEvent('attendance.upsert',entry);
  }else{
    record.checkOut=at;record.checkOutLocation=location;
    entry=record;
    event=enqueueEvent('attendance.upsert',record);
  }
  save();
  log(direction==='in'?'Absensi masuk':'Absensi pulang',currentUserName());
  const audit=state.audit.at(-1);
  button.textContent=navigator.onLine?'Menyimpan...':'Menyimpan offline...';
  let synced=false;
  try{
    if(navigator.onLine)synced=await submitCriticalEvent(event);
  }catch(error){
    if(direction==='in')state.attendance=state.attendance.filter(item=>item.id!==entry.id);
    else{record.checkOut=null;record.checkOutLocation=null}
    removeCriticalEventAndAudit(event,audit);
    attendanceSubmitting=false;
    button.disabled=false;button.textContent=buttonLabel;
    renderAttendance();
    toast(`Absensi belum tercatat di database: ${error.message}`);
    return;
  }
  attendanceSubmitting=false;
  button.disabled=false;button.textContent=buttonLabel;
  renderAttendance();
  const action=direction==='in'?'Absensi masuk':'Absensi pulang';
  toast(synced?`${action} tercatat di database.`:`${action} disimpan offline; akan disinkronkan saat internet tersedia.`);
}
$('attendanceIn').onclick=()=>setAttendance('in');$('attendanceOut').onclick=()=>setAttendance('out');
$('exportAttendance').onclick=()=>{if(!requireRole(['Admin','Pemilik','Manajer']))return;const quote=value=>`"${String(value??'').replace(/"/g,'""')}"`,records=state.attendance.filter(record=>!record.outletId||record.outletId===state.activeOutlet),csv=[['Nama','Tanggal','Masuk','Pulang','Lokasi masuk','Lokasi pulang'],...records.map(record=>[record.userName,record.workDate,new Date(record.checkIn).toLocaleString('id-ID'),record.checkOut?new Date(record.checkOut).toLocaleString('id-ID'):'',attendanceLocationText(record.checkInLocation),attendanceLocationText(record.checkOutLocation)])].map(row=>row.map(quote).join(',')).join('\r\n'),url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`absensi-${today()}.csv`;link.click();URL.revokeObjectURL(url)};
const mergeSyncEventBeforeAttendance=mergeSyncEvent;
mergeSyncEvent=function(event){const data=event.payload||{};if(event.event_type==='attendance.upsert'){state.attendance||=[];const current=state.attendance.find(record=>record.id===data.id)||state.attendance.find(record=>record.userId===data.userId&&record.outletId===data.outletId&&attendanceDateKey(record.workDate)===attendanceDateKey(data.workDate));if(current)Object.assign(current,data);else state.attendance.push(data);renderAttendance()}else if(event.event_type==='cash.upsert'){const current=state.cashMovements.find(movement=>movement.id===data.id);if(current)Object.assign(current,data);else state.cashMovements.push(data);renderShift()}else if(event.event_type==='cash.approval'){const current=state.cashMovements.find(movement=>movement.id===data.id);if(current)Object.assign(current,data);renderShift()}else if(event.event_type==='shift.upsert'){mergeShiftEvent(state,data);renderShift()}else mergeSyncEventBeforeAttendance(event)};
