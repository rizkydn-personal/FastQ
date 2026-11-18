import { esc } from './pos-utils.mjs';

export function attendanceDateKey(value){
  if(value instanceof Date)return Number.isNaN(value.getTime())?'':`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  const raw=String(value??''),isoDate=raw.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
  if(isoDate)return isoDate[1];
  const date=new Date(raw);
  return Number.isNaN(date.getTime())?'':`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function attendanceDateLabel(value){
  const key=attendanceDateKey(value);
  if(!key)return'—';
  const[year,month,day]=key.split('-').map(Number);
  return new Date(year,month-1,day).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});
}
export function attendanceTimeLabel(value){
  const date=value instanceof Date?value:new Date(value);
  return Number.isNaN(date.getTime())?'—':date.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
}
export function attendanceLocationText(location){
  if(!location||!Number.isFinite(Number(location.latitude))||!Number.isFinite(Number(location.longitude)))return'';
  return`${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)} (akurasi ±${Math.round(Number(location.accuracy)||0)} m)`;
}
export function attendanceLocationMarkup(location){
  if(!location||!Number.isFinite(Number(location.latitude))||!Number.isFinite(Number(location.longitude)))return'<span class="attendance-location-unavailable">Tidak tersedia</span>';
  const latitude=Number(location.latitude),longitude=Number(location.longitude),coordinates=`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  return`<div class="attendance-location"><a href="https://www.google.com/maps?q=${latitude},${longitude}" target="_blank" rel="noopener noreferrer">Lihat peta</a><small>${coordinates} · ±${Math.round(Number(location.accuracy)||0)} m</small></div>`;
}
