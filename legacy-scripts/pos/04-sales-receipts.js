async function completePayment(){
  if(!state.activeShift)return toast('Buka shift sebelum menerima pembayaran');
  const productsById=new Map(state.products.map(product=>[product.id,product]));
  for(const item of cart){
    const p=productsById.get(item.productId),v=item.variantId?p?.variants?.find(x=>x.id===item.variantId):null,available=v?Number(v.stock)||0:Number(p?.stock)||0;
    if(!p||available<item.qty)return toast("Stok "+item.name+" tersisa "+available+"; sesuaikan keranjang.");
  }
  const t=totals(),got=parseRupiahInput($("cashReceived").value);
  if(!Number.isSafeInteger(got)||got<0)return toast("Jumlah tunai harus berupa Rupiah bulat");
  if(got<t.total)return toast("Jumlah diterima masih kurang");
  if(!beginLocalCommit("checkout"))return;
  const saleId=uid(),at=new Date().toISOString(),sale={id:saleId,number:createSaleNumber(saleId,at),at,cashier:currentUserName(),shiftId:state.activeShift.id,outletId:state.activeOutlet,items:cart.map(i=>({...i})),subtotal:t.subtotal,discount:t.d+t.itemDiscount,tax:t.tax,service:t.service,total:t.total,payments:[{method:"Tunai",amount:t.total,received:got,change:got-t.total}],status:"Lunas",outstanding:0};
  for(const item of cart){
    const p=productsById.get(item.productId);
    if(!p)continue;
    if(item.variantId){const v=p.variants?.find(x=>x.id===item.variantId);if(v)v.stock=Math.max(0,v.stock-item.qty);p.stock=p.variants.reduce((a,x)=>a+x.stock,0)}
    else p.stock=Math.max(0,p.stock-item.qty);
  }
  state.sales.push(sale);
  log("Transaksi selesai",sale.number);
  cart=[];cartDiscount=null;
  save();
  try{await flushEncryptedWrites()}
  catch{
    closeModal();renderProducts();renderCart();
    endLocalCommit("checkout");
    toast("Transaksi belum tersimpan lokal. Jangan tutup aplikasi; penyimpanan akan dicoba ulang.");
    return null;
  }
  endLocalCommit("checkout");
  closeModal();renderProducts();renderCart();
  toast("Transaksi tersimpan");receiptModal(sale);
  return sale;
}
function receiptStoreName(s){const outlet=state.outlets.find(item=>item.id===s.outletId);return String(outlet?.name||state.settings.storeName||'Toko').trim()||'Toko'}
function receiptModal(s){modal('Transaksi tersimpan',`<div style="text-align:center;border:1px dashed #CBD2DE;padding:18px 16px;color:#3A4356"><strong style="font-size:16px;color:#0B2A5B">${esc(receiptStoreName(s))}</strong>${state.settings.storeAddress?`<div style="font-size:14px;margin-top:4px">${esc(state.settings.storeAddress)}</div>`:''}<div style="font-size:14px;margin-top:8px;color:#3A4356">Tanggal: ${new Date(s.at).toLocaleString('id-ID')}</div><div style="font-size:14px;margin-top:3px;color:#3A4356">ID TRX: ${esc(s.number)}</div><div style="border-top:1px dashed #CBD2DE;margin:13px 0"></div>${s.items.map(i=>`<div style="display:flex;justify-content:space-between;gap:10px;text-align:left;font-size:14px;padding:4px 0"><span>${esc(i.name)} · ${i.qty}</span><strong>${rupiah(i.price*i.qty)}</strong></div>`).join('')}<div style="border-top:1px dashed #CBD2DE;margin:9px 0"></div><div style="display:flex;justify-content:space-between;font-size:16px;color:#0B2A5B"><strong>Total</strong><strong>${rupiah(s.total)}</strong></div><div style="font-size:14px;color:#3A4356;margin-top:5px">${esc(s.payments.map(p=>p.method).join(' + '))}</div></div>`,[{label:'Share',action:()=>shareReceiptImage(s)},{label:'Print',action:()=>printBluetooth(s)},{label:'Selesai',primary:true,action:closeModal}]);setTimeout(()=>{document.querySelector('.modal-foot .button.primary')?.focus()},30);primeReceiptImage(s)}

let receiptImageCache={number:null,promise:null,blob:null};
// Render gambar struk begitu modal dibuka, supaya saat tombol Share ditekan
// gambarnya (biasanya) sudah siap dan share/unduh/buka-wa.me bisa jalan
// sinkron di dalam gestur klik (unduhan & popup setelah await sering diblokir).
function primeReceiptImage(s){
  receiptImageCache={number:s.number,promise:null,blob:null};
  receiptImageCache.promise=receiptImageBlob(s).then(b=>{receiptImageCache.blob=b;return b;}).catch(()=>null);
}
function downloadReceiptBlob(blob,s){
  try{
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='struk-'+s.number+'.png';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
  }catch{}
  window.open('https://wa.me/','_blank','noopener');
  toast('Gambar struk diunduh — lampirkan di WhatsApp.');
}
async function receiptImageBlob(s){
  const width=480,pad=28,lineH=32,ruleH=18;
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('Canvas tidak tersedia di perangkat ini.');
  let logo=null;
  if(state.settings.receiptLogo){
    try{const img=new Image();img.src=state.settings.receiptLogo;await img.decode();if(img.naturalWidth&&img.naturalHeight)logo=img;}catch{logo=null;}
  }
  const wrap=(text,font)=>{ctx.font=font;const max=width-pad*2,words=String(text).split(/\s+/).filter(Boolean),out=[];let cur='';for(const w of words){const t=cur?cur+' '+w:w;if(ctx.measureText(t).width<=max||!cur)cur=t;else{out.push(cur);cur=w}}if(cur)out.push(cur);return out.length?out:[''];};
  const rows=[];
  const add=(text,opts={})=>{const font=(opts.bold?'bold ':'')+(opts.size||22)+'px Arial';for(const line of wrap(text,font))rows.push({text:line,font,align:opts.align||'left'});};
  const rule=()=>rows.push({rule:true});
  add(receiptStoreName(s),{bold:true,size:30,align:'center'});
  if(state.settings.storeAddress)add(state.settings.storeAddress,{size:20,align:'center'});
  add(new Date(s.at).toLocaleString('id-ID'),{size:20,align:'center'});
  add('ID TRX: '+s.number,{size:20,align:'center'});
  rule();
  for(const item of s.items){add(item.name+' x'+item.qty,{size:22});add(rupiah(item.price)+' x '+item.qty+'  =  '+rupiah(item.price*item.qty),{size:22,align:'right'});}
  rule();
  add('Subtotal  '+rupiah(s.subtotal),{size:22});
  if(s.discount)add('Diskon  -'+rupiah(s.discount),{size:22});
  if(s.service)add('Service  '+rupiah(s.service),{size:22});
  add('TOTAL  '+rupiah(s.total),{bold:true,size:28});
  for(const payment of s.payments)add(payment.method+'  '+rupiah(payment.amount),{size:22});
  if(s.payments.some(p=>Number.isSafeInteger(p.received))){add('Diterima  '+rupiah(s.payments.reduce((a,p)=>a+(Number(p.received)||0),0)),{size:22});add('Kembalian  '+rupiah(s.payments.reduce((a,p)=>a+(Number(p.change)||0),0)),{size:22});}
  add('',{size:22});
  add(state.settings.receiptFooter||'Terima kasih.',{size:20,align:'center'});
  let height=pad;
  if(logo){const scale=Math.min(1,200/logo.naturalWidth,90/logo.naturalHeight);height+=Math.round(logo.naturalHeight*scale)+16;}
  for(const row of rows)height+=row.rule?ruleH:lineH;
  height+=pad;
  canvas.width=width;canvas.height=height;
  ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,width,height);
  ctx.fillStyle='#0B2A5B';ctx.textBaseline='middle';
  let y=pad;
  if(logo){const scale=Math.min(1,200/logo.naturalWidth,90/logo.naturalHeight),w=Math.round(logo.naturalWidth*scale),h=Math.round(logo.naturalHeight*scale);ctx.drawImage(logo,(width-w)/2,y,w,h);y+=h+16;}
  for(const row of rows){
    if(row.rule){ctx.strokeStyle='#3A4356';ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(pad,y+ruleH/2);ctx.lineTo(width-pad,y+ruleH/2);ctx.stroke();ctx.setLineDash([]);y+=ruleH;continue;}
    ctx.font=row.font;ctx.textAlign=row.align;
    ctx.fillText(row.text,row.align==='center'?width/2:row.align==='right'?width-pad:pad,y+lineH/2);
    y+=lineH;
  }
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('Gambar struk tidak dapat dibuat.');
  return blob;
}
async function shareReceiptImage(s){
  // Jalur cepat: gambar sudah dirender saat modal dibuka -> share/unduh/
  // buka-wa.me dipanggil sinkron dalam gestur klik.
  const ready=receiptImageCache.number===s.number?receiptImageCache.blob:null;
  if(ready)return shareReceiptBlob(ready,s,true);
  // Jalur lambat: gambar belum siap (tombol ditekan <~300ms setelah modal
  // dibuka) -> tunggu render; unduhan/popup di sini best-effort.
  let blob;
  try{blob=receiptImageCache.number===s.number&&receiptImageCache.promise?await receiptImageCache.promise:await receiptImageBlob(s);}
  catch(e){toast(e?.message||'Gambar struk tidak dapat dibuat.');return;}
  if(!blob){toast('Gambar struk tidak dapat dibuat.');return;}
  return shareReceiptBlob(blob,s,false);
}
function shareReceiptBlob(blob,s,sync){
  const file=new File([blob],'struk-'+s.number+'.png',{type:'image/png'});
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    const p=navigator.share({files:[file],title:'Struk '+s.number});
    if(sync)p.catch(e=>{if(e&&e.name!=='AbortError')downloadReceiptBlob(blob,s);});
    else p.catch(e=>{if(e&&e.name!=='AbortError')toast('Gagal membagikan struk.');});
    return;
  }
  downloadReceiptBlob(blob,s);
}
async function escposPayload(s){
const clean=value=>String(value??'').normalize('NFKD').replace(/[^\x20-\x7E]/g,'?'),columns=state.settings.receiptWidth==='58'?32:48,rule='-'.repeat(columns),rows=[receiptStoreName(s),state.settings.storeAddress||'',`Tanggal: ${new Date(s.at).toLocaleString('id-ID')}`,`ID TRX: ${s.number}`,rule,...s.items.flatMap(item=>[`${clean(item.name)} x${item.qty}`,`${rupiah(item.price*item.qty)}`]),rule,`Subtotal ${rupiah(s.subtotal)}`,...(s.discount?[`Diskon -${rupiah(s.discount)}`]:[]),...(s.service?[`Service ${rupiah(s.service)}`]:[]),`TOTAL ${rupiah(s.total)}`,...s.payments.map(payment=>`${clean(payment.method)} ${rupiah(payment.amount)}`),...(s.payments.some(payment=>Number.isSafeInteger(payment.received))?[`Diterima ${rupiah(s.payments.reduce((sum,payment)=>sum+(Number(payment.received)||0),0))}`,`Kembalian ${rupiah(s.payments.reduce((sum,payment)=>sum+(Number(payment.change)||0),0))}`]:[]),'',state.settings.receiptFooter||'Terima kasih.','',''];
const text=new TextEncoder().encode('\x1B@\x1Bt\x00'+rows.map(clean).join('\n')+'\n\x1DVA\x00'),logo=state.settings.receiptLogo;if(!logo)return text;
const image=new Image();image.src=logo;await image.decode();if(!image.naturalWidth||!image.naturalHeight)throw new Error('Logo struk tidak dapat dibaca untuk printer thermal.');
const maxWidth=state.settings.receiptWidth==='58'?384:576,maxHeight=256,scale=Math.min(1,maxWidth/image.naturalWidth,maxHeight/image.naturalHeight),width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale)),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('Tidak dapat menyiapkan gambar logo untuk printer thermal.');context.fillStyle='#FFFFFF';context.fillRect(0,0,width,height);context.imageSmoothingEnabled=true;context.drawImage(image,0,0,width,height);
const rgba=context.getImageData(0,0,width,height).data,rowBytes=Math.ceil(width/8),bitmap=new Uint8Array(8+rowBytes*height);bitmap.set([0x1D,0x76,0x30,0,rowBytes&255,(rowBytes>>8)&255,height&255,(height>>8)&255]);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const offset=(y*width+x)*4,luma=.299*rgba[offset]+.587*rgba[offset+1]+.114*rgba[offset+2];if(luma<160)bitmap[8+y*rowBytes+(x>>3)]|=0x80>>(x&7)}
const prefix=Uint8Array.from([0x1B,0x40,0x1B,0x61,0x01]),separator=Uint8Array.from([0x0A,0x1B,0x61,0x00]),payload=new Uint8Array(prefix.length+bitmap.length+separator.length+text.length);let cursor=0;payload.set(prefix,cursor);cursor+=prefix.length;payload.set(bitmap,cursor);cursor+=bitmap.length;payload.set(separator,cursor);cursor+=separator.length;payload.set(text,cursor);return payload}
async function printBluetooth(s){const nativePrinter=window.parent.FastQNativePrinter;if(nativePrinter){try{const devices=await nativePrinter.listBondedBluetooth();if(!devices.length)return toast('Belum ada printer dipasangkan. Pasangkan printer ESC/POS di Pengaturan Bluetooth Android.');modal('Pilih printer Bluetooth',`<p>Pilih printer yang sudah dipasangkan. Sambungan native memakai Bluetooth Classic SPP.</p>`,[...devices.map(device=>({label:`${device.name||'Printer Bluetooth'} ? ${device.address}`,action:async()=>{closeModal();try{const payload=base64(await escposPayload(s));await nativePrinter.printBluetooth({address:device.address,payload});toast('Struk dikirim ke printer Bluetooth')}catch(error){toast(error?.message||'Tidak dapat mencetak melalui Bluetooth. Periksa printer dan koneksi.')}}})),{label:'Batal',action:closeModal}],true)}catch(error){toast(error?.message||'Daftar printer Bluetooth tidak dapat dibuka.')}return}if(!navigator.bluetooth)return toast('Bluetooth LE memerlukan browser yang mendukung Web Bluetooth melalui HTTPS.');let device;try{device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:['0000ffe0-0000-1000-8000-00805f9b34fb','0000ff00-0000-1000-8000-00805f9b34fb','000018f0-0000-1000-8000-00805f9b34fb']});const server=await device.gatt.connect(),services=await server.getPrimaryServices();let characteristic;for(const service of services){for(const candidate of await service.getCharacteristics())if(candidate.properties.write||candidate.properties.writeWithoutResponse){characteristic=candidate;break}if(characteristic)break}if(!characteristic)throw new Error('Printer tidak menyediakan karakteristik GATT tulis yang kompatibel.');const payload=await escposPayload(s),chunkSize=180;for(let offset=0;offset<payload.length;offset+=chunkSize){const chunk=payload.slice(offset,offset+chunkSize);if(characteristic.properties.writeWithoutResponse&&characteristic.writeValueWithoutResponse)await characteristic.writeValueWithoutResponse(chunk);else if(characteristic.writeValueWithResponse)await characteristic.writeValueWithResponse(chunk);else await characteristic.writeValue(chunk)}device.gatt.disconnect();toast('Struk dikirim ke printer Bluetooth LE')}catch(e){try{device?.gatt?.disconnect()}catch{}toast(e?.message||'Printer Bluetooth tidak dapat diakses. Pastikan printer mendukung ESC/POS melalui Bluetooth LE.')}}
function holdCart(){if(!cart.length)return toast('Keranjang masih kosong');const suggestedName=`Pesanan ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`;modal('Tahan transaksi',`<div class="form-field"><label>Nama transaksi</label><input class="field" id="holdName" maxlength="60" value="${esc(suggestedName)}" placeholder="Pesanan ditahan"></div>`,[{label:'Batal',action:closeModal},{label:'Simpan transaksi',primary:true,action:()=>{const name=$('holdName').value.trim()||'Pesanan ditahan';state.holds.push({id:uid(),name,at:new Date().toISOString(),items:cart,discount:cartDiscount});cart=[];cartDiscount=null;save();closeModal();renderCart();toast('Transaksi ditahan')}}])}
function showHolds(){const hasHolds=state.holds.length>0;modal('Transaksi ditahan',hasHolds?state.holds.map(h=>`<div style="display:flex;align-items:center;gap:9px;border-bottom:1px solid #CBD2DE;padding:10px 0"><div style="flex:1"><strong>${esc(h.name)}</strong><div class="hint">${new Date(h.at).toLocaleString('id-ID')} · ${h.items.reduce((a,i)=>a+i.qty,0)} item</div></div><button class="button small" data-resume="${h.id}">Lanjutkan</button><button class="button small danger" data-delete-hold="${h.id}">Hapus</button></div>`).join(''):'<p class="hint">Belum ada transaksi yang ditahan.</p>',[{label:'Selesai',action:closeModal}]);if(!hasHolds)return;$('modalBody').querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>{if(cart.length&&!confirm('Ganti keranjang aktif dengan transaksi ini? Transaksi aktif akan dibuang.'))return;const h=state.holds.find(x=>x.id===b.dataset.resume);cart=h.items;cartDiscount=h.discount;state.holds=state.holds.filter(x=>x.id!==h.id);save();closeModal();renderCart()});$('modalBody').querySelectorAll('[data-delete-hold]').forEach(b=>b.onclick=()=>{state.holds=state.holds.filter(x=>x.id!==b.dataset.deleteHold);save();showHolds()})}
