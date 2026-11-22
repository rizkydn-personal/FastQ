function closeCustomSelect(binding,restoreFocus=false){binding.menu.hidden=true;binding.trigger.setAttribute('aria-expanded','false');if(activeCustomSelect===binding)activeCustomSelect=null;if(restoreFocus)binding.trigger.focus()}
function focusCustomOption(binding,index){const options=[...binding.menu.querySelectorAll('[role="option"]:not(:disabled)')];if(!options.length)return;options[(index+options.length)%options.length].focus()}
function openCustomSelect(binding){if(activeCustomSelect&&activeCustomSelect!==binding)closeCustomSelect(activeCustomSelect);binding.menu.hidden=false;binding.trigger.setAttribute('aria-expanded','true');activeCustomSelect=binding;const options=[...binding.menu.querySelectorAll('[role="option"]:not(:disabled)')],selected=options.findIndex(option=>option.getAttribute('aria-selected')==='true');focusCustomOption(binding,selected<0?0:selected)}
function syncCustomSelect(select,label,variant=''){if(!select)return;let binding=customSelectBindings.get(select);if(!binding){select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');const wrapper=document.createElement('div'),trigger=document.createElement('button'),value=document.createElement('span'),icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path'),menu=document.createElement('div');wrapper.className=`custom-select${variant?` custom-select-${variant}`:''}`;trigger.type='button';trigger.className='custom-select-trigger';trigger.setAttribute('aria-label',label);trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.id=`customSelect-${select.id}-trigger`;trigger.setAttribute('aria-controls',`customSelect-${select.id}-menu`);value.className='custom-select-value';icon.setAttribute('viewBox','0 0 20 20');icon.setAttribute('aria-hidden','true');path.setAttribute('d','m5 7.5 5 5 5-5');icon.append(path);trigger.append(value,icon);menu.className='custom-select-menu';menu.id=`customSelect-${select.id}-menu`;menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label);menu.hidden=true;wrapper.append(trigger,menu);select.after(wrapper);binding={select,label,wrapper,trigger,value,menu};customSelectBindings.set(select,binding);wrapper.addEventListener('click',event=>{const option=event.target.closest('[role="option"]');if(option&&wrapper.contains(option)){select.value=option.dataset.value;syncCustomSelect(select,label,variant);closeCustomSelect(binding);select.dispatchEvent(new Event('change',{bubbles:true}));trigger.focus();return}if(event.target.closest('.custom-select-trigger')){if(activeCustomSelect===binding)closeCustomSelect(binding);else openCustomSelect(binding)}});wrapper.addEventListener('keydown',event=>{if(event.target===trigger){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openCustomSelect(binding)}else if(event.key==='Escape'&&activeCustomSelect===binding){event.preventDefault();closeCustomSelect(binding,true)}return}if(!event.target.matches('[role="option"]'))return;if(event.key==='Escape'){event.preventDefault();closeCustomSelect(binding,true)}else if(event.key==='Tab'){closeCustomSelect(binding)}else if(event.key==='ArrowDown'||event.key==='ArrowUp'||event.key==='Home'||event.key==='End'){event.preventDefault();const options=[...menu.querySelectorAll('[role="option"]:not(:disabled)')],current=options.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?options.length-1:current+(event.key==='ArrowDown'?1:-1);focusCustomOption(binding,next)}})}binding.label=label;binding.wrapper.className=`custom-select${variant?` custom-select-${variant}`:''}`;binding.menu.setAttribute('aria-label',label);binding.menu.replaceChildren();const options=[...select.options];binding.value.textContent=options.find(option=>option.value===select.value)?.textContent?.trim()||label;options.forEach(option=>{const item=document.createElement('button');item.type='button';item.className='custom-select-option';item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.value===select.value));item.dataset.value=option.value;item.disabled=option.disabled;item.tabIndex=option.value===select.value?0:-1;item.textContent=option.textContent.trim();binding.menu.append(item)});return binding.trigger}
document.addEventListener('click',event=>{if(activeCustomSelect&&!activeCustomSelect.wrapper.contains(event.target))closeCustomSelect(activeCustomSelect)});
const modalBeforeCustomSelect=modal;
modal=function(...args){const result=modalBeforeCustomSelect.apply(this,args),select=$('idKind')||$('discountKind');if(select){const trigger=syncCustomSelect(select,'Jenis diskon');setTimeout(()=>trigger.focus(),0)}return result};
const renderOutletsBeforeCustomSelect=renderOutlets;
renderOutlets=function(...args){const result=renderOutletsBeforeCustomSelect.apply(this,args);syncCustomSelect($('outletSelect'),'Pilih outlet','outlet');return result};
let activeReportChart='sales';
function productDonutMarkup(products){
  const palette=['#1D4ED8','#0B2A5B','#4F7CF3','#82A4F8','#CBD5E1'];
  const total=products.reduce((sum,product)=>sum+(Number(product.value)||0),0);
  if(!total)return '<div class="report-chart-empty">Belum ada produk terjual pada periode ini.</div>';
  let offset=0;
  const segments=products.map((product,index)=>{
    const value=Number(product.value)||0,share=value/total*100,color=palette[index%palette.length],dash=Math.max(0,share-0.8),segment={...product,value,color,share};
    segment.offset=offset;offset+=share;return segment;
  });
  const circles=segments.map(segment=>{const dash=Math.max(0,segment.share-0.8);return `<circle cx="110" cy="110" r="72" pathLength="100" fill="none" stroke="${segment.color}" stroke-width="30" stroke-dasharray="${dash} ${100-dash}" stroke-dashoffset="${-segment.offset}"><title>${esc(segment.label)}: ${fmt.format(segment.value)} unit (${segment.share.toFixed(1)}%)</title></circle>`}).join('');
  const legend=segments.map(segment=>`<li class="product-donut-item"><span class="product-donut-dot" style="--donut-color:${segment.color}" aria-hidden="true"></span><span class="product-donut-copy"><strong title="${esc(segment.label)}">${esc(segment.label)}</strong><small>${fmt.format(segment.value)} unit · ${segment.share.toFixed(1)}%</small></span></li>`).join('');
  return `<div class="product-donut-layout"><svg class="product-donut-svg" viewBox="0 0 220 220" role="img" aria-label="Komposisi ${segments.length} produk terlaris, total ${fmt.format(total)} unit"><g transform="rotate(-90 110 110)"><circle cx="110" cy="110" r="72" pathLength="100" fill="none" stroke="var(--blue-soft)" stroke-width="30"/>${circles}</g><text x="110" y="103" class="product-donut-total">${fmt.format(total)}</text><text x="110" y="126" class="product-donut-caption">unit terjual</text></svg><ul class="product-donut-legend">${legend}</ul></div>`;
}
const reportPaginationPages=new Map();
const reportPaginationLists=[['salesBody','salesPagination'],['lowStockBody','lowStockPagination'],['forecastBody','forecastPagination']];
const reportTableRows=new Map();
const reportTableEmpty=new Map();
const reportTableRenderers=new Map();
const reportPageSize=8;
function updateReportPagination(tbodyId,paginationId){
  const tbody=$(tbodyId),pagination=$(paginationId);
  if(!tbody||!pagination)return;
  const rows=reportTableRows.get(tbodyId)||[],totalPages=Math.max(1,Math.ceil(rows.length/reportPageSize));
  const page=Math.min(reportPaginationPages.get(tbodyId)||0,totalPages-1);
  reportPaginationPages.set(tbodyId,page);
  const renderRow=reportTableRenderers.get(tbodyId);
  tbody.innerHTML=rows.slice(page*reportPageSize,(page+1)*reportPageSize).map(renderRow).join('')||reportTableEmpty.get(tbodyId)||'';
  pagination.hidden=rows.length<=reportPageSize;
  pagination.querySelector('[data-report-page-current]').textContent=`${page+1} / ${totalPages}`;
  pagination.querySelector('[data-report-page="prev"]').disabled=page===0;
  pagination.querySelector('[data-report-page="next"]').disabled=page>=totalPages-1;
  pagination.querySelector('[data-report-page="prev"]').onclick=()=>{reportPaginationPages.set(tbodyId,Math.max(0,page-1));updateReportPagination(tbodyId,paginationId)};
  pagination.querySelector('[data-report-page="next"]').onclick=()=>{reportPaginationPages.set(tbodyId,Math.min(totalPages-1,page+1));updateReportPagination(tbodyId,paginationId)};
}
function updateReportPaginations(){reportPaginationLists.forEach(([tbodyId,paginationId])=>updateReportPagination(tbodyId,paginationId))}
function setReportTableRows(tbodyId,rows,emptyHtml,renderRow){reportTableRows.set(tbodyId,rows);reportTableEmpty.set(tbodyId,emptyHtml);reportTableRenderers.set(tbodyId,renderRow);updateReportPagination(tbodyId,reportPaginationLists.find(([id])=>id===tbodyId)[1])}
const reportSalesBody=$('salesBody');
reportSalesBody.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-settle-sale],[data-void-sale],[data-refund-sale],[data-receivable-sale]');
  if(button){
    const sale=state.sales.find(item=>item.id===(button.dataset.settleSale||button.dataset.voidSale||button.dataset.refundSale||button.dataset.receivableSale));
    if(!sale)return;
    if(button.dataset.settleSale)settleSale(sale);
    else if(button.dataset.voidSale)voidSale(sale);
    else if(button.dataset.refundSale)refundSale(sale);
    else receiveReceivable(sale);
    return;
  }
  const row=event.target.closest?.('tr[data-sale-id]');
  if(!row)return;
  const sale=state.sales.find(item=>item.id===row.dataset.saleId);
  if(sale){receiptModal(sale);polishReceiptDetailLabels(sale);}
});
function renderReportCharts(sales,monthValue){
  $('salesTrendChart').innerHTML=reportChartSvg(buildSalesTrend(sales,monthValue),{money:true,color:'#2563EB',label:'Trend penjualan bulanan'});
  const products=new Map();
  sales.forEach(sale=>sale.items.forEach(item=>{const key=item.productId||item.name,current=products.get(key)||{label:item.name,value:0};current.value+=Number(item.qty)||0;products.set(key,current)}));
  const best=Array.from(products.values()).sort((a,b)=>b.value-a.value).slice(0,5).map(point=>({...point,shortLabel:point.label.length>12?`${point.label.slice(0,11)}…`:point.label}));
  $('topProductsChart').innerHTML=productDonutMarkup(best);
  const grid=$('reportChartGrid');
  if(grid.clientWidth)updateReportChartLayout();
}
function renderReportData(){
  if(!$('page-reports').classList.contains('active'))return;
  const period=$('reportPeriod').value,chosen=$('reportDate').value||today();
  const monthInput=$('reportChartMonth');
  if(!monthInput.value)monthInput.value=currentReportMonth();
  const chartMonth=monthInput.value;
  const all=[],sales=[],chartSales=[],dailyTotals=new Map(),productTotals=new Map(),methods=new Map(),cashiers=new Map(),categories=new Map(),sold=new Map();
  const forecastSince=Date.now()-30*86400000;
  let revenue=0,capital=0,profit=0,itemCount=0;
  const categoryByProduct=new Map(state.products.map(product=>[product.id,product.category||'Lainnya']));
  for(const sale of state.sales){
    if(sale.outletId&&sale.outletId!==state.activeOutlet)continue;
    const date=new Date(sale.at),saleMonth=reportMonthKey(date),paid=sale.status==='Lunas'||sale.status==='Piutang';
    if(dateWithin(sale.at,period,chosen)){
      all.push(sale);
      if(paid){sales.push(sale);revenue+=Number(sale.total)||0;cashiers.set(sale.cashier,(cashiers.get(sale.cashier)||0)+(Number(sale.total)||0));}
    }
    if(paid&&saleMonth===chartMonth)chartSales.push(sale);
    if(paid&&date.getTime()>=forecastSince)for(const item of sale.items||[])sold.set(item.productId,(sold.get(item.productId)||0)+(Number(item.qty)||0));
    if(!paid)continue;
    if(Number.isNaN(date.getTime()))continue;
    if(dateWithin(sale.at,period,chosen)){
      let saleProfit=0;
      for(const item of sale.items||[]){
        const quantity=Number(item.qty)||0,price=Number(item.price)||0,cost=Number(item.cost)||0,amount=price*quantity;
        itemCount+=quantity;capital+=cost*quantity;saleProfit+=(price-cost)*quantity;
        const key=item.productId||item.name,product=productTotals.get(key)||{name:item.name,quantity:0,revenue:0};
        product.quantity+=quantity;product.revenue+=amount;productTotals.set(key,product);
        const category=categoryByProduct.get(item.productId)||'Lainnya';categories.set(category,(categories.get(category)||0)+amount);
      }
      profit+=saleProfit-(Number(sale.discount)||0);
      for(const payment of sale.payments||[])methods.set(payment.method,(methods.get(payment.method)||0)+(Number(payment.amount)||0));
      const dateKey=reportDateKey(date),day=dailyTotals.get(dateKey)||{key:dateKey,total:0,transactions:0};
      day.total+=Number(sale.total)||0;day.transactions++;dailyTotals.set(dateKey,day);
    }
  }
  $('reportRevenue').textContent=rupiah(revenue);
  $('reportTxnCount').textContent=fmt.format(sales.length);
  $('reportAverage').textContent=rupiah(capital);
  $('reportItems').textContent=fmt.format(itemCount);
  $('reportProfit').textContent=rupiah(profit);
  all.reverse();
  const reportFilteredAll=reportTrxQuery?all.filter(sale=>saleMatchesReportQuery(sale,reportTrxQuery)):all;
  const canManage=hasRole('Admin');
  const renderTransaction=s=>`<tr class="sale-row" data-sale-id="${esc(s.id)}" style="cursor:pointer"><td>${new Date(s.at).toLocaleString('id-ID',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}<div class="hint" title="${esc(s.number)}">${esc(formatSaleNumber(s.number))}</div></td><td>${esc(s.cashier||'—')}</td><td>${esc([...new Set((s.payments||[]).map(p=>p.method))].join(' + ')||'—')}</td><td><span class="status ${s.status==='Lunas'?'':s.status==='Gagal'||s.status==='Void'||s.status==='Dikembalikan'?'danger':'pending'}">${esc(s.status)}</span></td><td class="numeric"><strong>${rupiah(s.total)}</strong> ${canManage&&s.status==='Menunggu'?`<button class="button small" data-settle-sale="${esc(s.id)}">Tandai lunas</button>`:''} ${canManage&&['Menunggu','Gagal'].includes(s.status)?`<button class="button small danger" data-void-sale="${esc(s.id)}">Void</button>`:''} ${canManage&&s.status==='Piutang'?`<button class="button small primary" data-receivable-sale="${esc(s.id)}">Terima piutang</button>`:''} ${canManage&&['Lunas','Piutang'].includes(s.status)?`<button class="button small danger" data-refund-sale="${esc(s.id)}">Refund</button>`:''}</td></tr>`;
  setReportTableRows('salesBody',reportFilteredAll,reportTrxQuery?'<tr><td colspan="5" class="empty-row">Transaksi tidak ditemukan.</td></tr>':'<tr><td colspan="5" class="empty-row">Belum ada transaksi pada periode ini.</td></tr>',renderTransaction);
  const summaries=[['methodSummary',Array.from(methods)],['categorySummary',Array.from(categories)],['cashierSummary',Array.from(cashiers)]];
  summaries.forEach(([id,entries])=>{$(id).innerHTML=entries.sort((a,b)=>b[1]-a[1]).map(([label,value])=>`<div class="detail-row"><span>${esc(label||'Tidak diketahui')}</span><strong>${rupiah(value)}</strong></div>`).join('')||'<div class="empty" style="padding:18px">Belum ada data.</div>'});
  $('topProducts').innerHTML=Array.from(productTotals.values()).sort((a,b)=>b.quantity-a.quantity).slice(0,8).map(product=>`<div class="detail-row"><span>${esc(product.name)}<div class="hint">${fmt.format(product.quantity)} unit terjual</div></span><strong>${rupiah(product.revenue)}</strong></div>`).join('')||'<div class="empty" style="padding:18px">Belum ada item terjual.</div>';
  $('auditSummary').innerHTML=state.audit.slice(-5).reverse().map(item=>`<div class="detail-row"><span>${esc(item.action)}<div class="hint">${esc(item.detail||'')}</div></span><strong>${new Date(item.at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}</strong></div>`).join('')||'<div class="hint">Belum ada aktivitas.</div>';
  const lowStock=state.products.filter(product=>Number(product.stock)<=Number(product.minStock));
  setReportTableRows('lowStockBody',lowStock,'<tr><td colspan="4" class="empty-row">Semua stok berada di atas batas minimum.</td></tr>',product=>`<tr><td>${esc(product.name)}</td><td>${esc(product.sku)}</td><td>${fmt.format(Number(product.stock)||0)}</td><td>${fmt.format(Number(product.minStock)||0)}</td></tr>`);
  const forecast=state.products.map(product=>{const daily=(sold.get(product.id)||0)/30,days=daily?Math.floor((Number(product.stock)||0)/daily):null,reorder=Math.max(0,Math.ceil(daily*14-(Number(product.stock)||0)));return{product,daily,days,reorder}}).sort((a,b)=>(a.days??Infinity)-(b.days??Infinity)||b.daily-a.daily);
  setReportTableRows('forecastBody',forecast,'<tr><td colspan="4" class="empty-row">Belum ada produk.</td></tr>',({product,daily,days,reorder})=>`<tr><td>${esc(product.name)}</td><td>${daily.toFixed(1)}</td><td>${days===null?'Data belum cukup':`${fmt.format(days)} hari`}</td><td>${fmt.format(reorder)} ${esc(product.unit||'pcs')}</td></tr>`);
  const topDays=Array.from(dailyTotals.values()).sort((a,b)=>b.total-a.total||b.key.localeCompare(a.key)).slice(0,3);
  $('topDatesSummary').innerHTML=topDays.map((day,index)=>{
    const[year,monthNumber,dayNumber]=day.key.split('-');
    const label=new Date(Number(year),Number(monthNumber)-1,Number(dayNumber)).toLocaleDateString('id-ID',{weekday:'short',day:'2-digit',month:'short'});
    return`<li><span class="report-rank-number">${String(index+1).padStart(2,'0')}</span><span class="report-rank-copy"><strong>${esc(label)}</strong><small>${fmt.format(day.transactions)} transaksi</small></span><strong class="report-rank-value">${rupiah(day.total)}</strong></li>`;
  }).join('')||'<li class="report-rank-empty">Belum ada penjualan pada periode ini.</li>';
  const bestProducts=Array.from(productTotals.values()).sort((a,b)=>b.quantity-a.quantity||b.revenue-a.revenue||a.name.localeCompare(b.name,'id')).slice(0,3);
  $('bestProductsSummary').innerHTML=bestProducts.map((product,index)=>`<li><span class="report-rank-number">${String(index+1).padStart(2,'0')}</span><span class="report-rank-copy"><strong>${esc(product.name)}</strong><small>${fmt.format(product.quantity)} unit terjual</small></span><strong class="report-rank-value">${rupiah(product.revenue)}</strong></li>`).join('')||'<li class="report-rank-empty">Belum ada item terjual.</li>';
  $('bestProductsSummary').closest('.report-summary-block').hidden=bestProducts.length===0;
  const slowProducts=productTotals.size?rankLeastSellingProducts(state.products,productTotals,3):[];
  $('slowProductsSummary').innerHTML=slowProducts.map((product,index)=>`<li><span class="report-rank-number">${String(index+1).padStart(2,'0')}</span><span class="report-rank-copy"><strong>${esc(product.name)}</strong><small>${fmt.format(product.quantity)} unit terjual</small></span><strong class="report-rank-value">${rupiah(product.revenue)}</strong></li>`).join('')||'<li class="report-rank-empty">Belum ada data produk.</li>';
  $('slowProductsSummary').closest('.report-summary-block').hidden=slowProducts.length===0;
  updateReportPaginations();
  renderReportCharts(chartSales,chartMonth);
}
let reportRenderQueued=false;
renderReports=function(){
  if(!$('page-reports').classList.contains('active')||reportRenderQueued)return;
  reportRenderQueued=true;
  requestAnimationFrame(()=>{reportRenderQueued=false;if($('page-reports').classList.contains('active'))renderReportData()});
};
if(!$('reportChartMonth').value)$('reportChartMonth').value=currentReportMonth();
$('reportChartMonth').onchange=()=>{
  const month=$('reportChartMonth').value,chartSales=[];
  if(/^\d{4}-\d{2}$/.test(month))for(const sale of state.sales){if((sale.outletId&&sale.outletId!==state.activeOutlet)||!['Lunas','Piutang'].includes(sale.status))continue;if(reportMonthKey(sale.at)===month)chartSales.push(sale)}
  renderReportCharts(chartSales,month);
};
function resetReportPagination(){reportPaginationLists.forEach(([tbodyId])=>reportPaginationPages.set(tbodyId,0))}
$('reportDate').style.display=$('reportPeriod').value==='today'?'':'none';
$('reportPeriod').onchange=()=>{$('reportDate').style.display=$('reportPeriod').value==='today'?'':'none';resetReportPagination();renderReports()};
$('reportDate').onchange=()=>{resetReportPagination();renderReports()};
let reportChartLayoutKey='';
function updateReportChartLayout(){
  const grid=$('reportChartGrid'),switcher=$('reportChartSwitch'),compact=grid.clientWidth<720;
  const layoutKey=`${compact}:${activeReportChart}`;
  if(layoutKey===reportChartLayoutKey)return;
  reportChartLayoutKey=layoutKey;
  switcher.hidden=!compact;
  grid.classList.toggle('report-charts-compact',compact);
  $('salesTrendPanel').hidden=compact&&activeReportChart!=='sales';
  $('topProductsChartPanel').hidden=compact&&activeReportChart!=='products';
  document.querySelectorAll('[data-report-chart]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.reportChart===activeReportChart)));
}
document.querySelectorAll('[data-report-chart]').forEach(button=>button.onclick=()=>{activeReportChart=button.dataset.reportChart;updateReportChartLayout()});
if(window.ResizeObserver)new ResizeObserver(updateReportChartLayout).observe($('reportChartRegion'));
else window.addEventListener('resize',updateReportChartLayout);
/* ==========================================================================
   GEMINI3 (2026-11-22) — samakan Laporan ke render Gemini
   (~/workspace/user/files/FastQ_POS_-_Polished_UI__1__0_xch2.html § Laporan
   baris 362-740; modal Detail Transaksi baris 1208-1236).
   - Kolom pencarian transaksi (#laporanTrxSearch + tombol clear) di atas
     tabel; filter live berdasarkan ID transaksi / kasir / metode / produk
     (juga nomor, status, waktu — sama seperti render).
   - Teks ke render: tombol "Cetak" (dari "Cetak / PDF"), "Produk terlaris ·
     3 teratas" / "Produk kurang laris · 3 terbawah" (dari 5), hint "Klik
     transaksi untuk detail", badge "Top 5" di panel donut (donut tetap 5
     produk — "5 produk kontribusi tertinggi" seperti render).
   - Modal detail transaksi (hanya yang dibuka dari baris laporan):
     judul "Detail Transaksi" + label "Waktu" / "Kasir / Metode" /
     "Total Bayar". TETAP 3 tombol Share / Print / Selesai (fungsi tidak
     diubah); modal struk dari kasir tidak kena relabel ini.
   - "Bulan ini" / "Hari ini" sudah menjadi opsi #reportPeriod — tidak
     diubah. Forecast "Perkiraan kebutuhan stok (30 hari)" sudah ada dengan
     data asli — tidak diubah.
   Hanya file ini yang diubah JS-nya (aturan tugas); file JS lain, HTML,
   dan index.html tidak disentuh.
   ========================================================================== */
let reportTrxQuery='';
function saleMatchesReportQuery(sale,query){
  if(!query)return true;
  const methods=[...new Set((sale.payments||[]).map(payment=>payment.method))].join(' + ');
  const products=(sale.items||[]).map(item=>item.name||'').join(' ');
  const haystack=[sale.number,formatSaleNumber(sale.number),sale.id,sale.cashier,methods,sale.status,products,new Date(sale.at).toLocaleString('id-ID')].join(' ').toLowerCase();
  return haystack.includes(query);
}
function polishReceiptDetailLabels(sale){
  const title=$('modalTitle');
  if(title)title.textContent='Detail Transaksi';
  const body=$('modalBody');
  if(!body)return;
  const box=body.querySelector(':scope > div');
  if(!box)return;
  const dateDiv=[...box.querySelectorAll(':scope > div')].find(div=>div.textContent.trim().startsWith('Tanggal:'));
  if(dateDiv){
    const dateValue=dateDiv.textContent.replace(/^Tanggal:\s*/,'').trim();
    const methods=[...new Set((sale.payments||[]).map(payment=>payment.method))].join(' + ')||'—';
    dateDiv.className='receipt-detail-meta';
    dateDiv.textContent='';
    const timeCell=document.createElement('div');
    const timeLabel=document.createElement('span');timeLabel.className='receipt-detail-label';timeLabel.textContent='Waktu';
    const timeValue=document.createElement('span');timeValue.className='receipt-detail-value';timeValue.textContent=dateValue;
    timeCell.append(timeLabel,timeValue);
    const metaCell=document.createElement('div');
    const metaLabel=document.createElement('span');metaLabel.className='receipt-detail-label';metaLabel.textContent='Kasir / Metode';
    const metaValue=document.createElement('span');metaValue.className='receipt-detail-value';metaValue.textContent=`${sale.cashier||'—'} · ${methods}`;
    metaCell.append(metaLabel,metaValue);
    dateDiv.append(timeCell,metaCell);
  }
  const totalStrong=[...box.querySelectorAll('strong')].find(strong=>strong.textContent.trim()==='Total');
  if(totalStrong)totalStrong.textContent='Total Bayar';
}
function initReportTrxSearch(){
  const panel=$('salesBody')?.closest('.panel');
  if(!panel||$('laporanTrxSearch'))return;
  const wrap=document.createElement('div');
  wrap.className='report-trx-search';
  wrap.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg><input class="field" id="laporanTrxSearch" type="text" placeholder="Cari ID transaksi, kasir, metode, atau produk" aria-label="Cari transaksi" autocomplete="off"><button id="laporanTrxSearchClear" type="button" title="Bersihkan pencarian" aria-label="Bersihkan pencarian" hidden>×</button>';
  const tableWrap=panel.querySelector('.table-wrap');
  if(tableWrap)tableWrap.before(wrap);else panel.append(wrap);
  const input=$('laporanTrxSearch'),clear=$('laporanTrxSearchClear');
  input.addEventListener('input',()=>{
    reportTrxQuery=input.value.trim().toLowerCase();
    clear.hidden=!input.value;
    reportPaginationPages.set('salesBody',0);
    renderReportData();
  });
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&input.value){input.value='';reportTrxQuery='';clear.hidden=true;reportPaginationPages.set('salesBody',0);renderReportData();input.focus();}
  });
  clear.addEventListener('click',()=>{
    input.value='';reportTrxQuery='';clear.hidden=true;
    reportPaginationPages.set('salesBody',0);
    renderReportData();
    input.focus();
  });
}
function initReportGemini3Texts(){
  const printButton=$('printReports');
  if(printButton)printButton.textContent='Cetak';
  document.querySelectorAll('#page-reports .report-summary-block h3').forEach(heading=>{
    if(heading.textContent.includes('5 teratas'))heading.textContent=heading.textContent.replace('5 teratas','3 teratas');
    if(heading.textContent.includes('5 terbawah'))heading.textContent=heading.textContent.replace('5 terbawah','3 terbawah');
  });
  const trxPanel=$('salesBody')?.closest('.panel');
  const trxTitle=trxPanel?.querySelector('.panel-title');
  if(trxTitle&&!trxTitle.querySelector('.report-trx-hint')){
    const hint=document.createElement('span');
    hint.className='report-trx-hint';
    hint.textContent='Klik transaksi untuk detail';
    trxTitle.append(hint);
  }
  const donutTitle=document.querySelector('#topProductsChartPanel .panel-title');
  if(donutTitle&&!donutTitle.querySelector('.report-top5-badge')){
    const badge=document.createElement('span');
    badge.className='report-top5-badge';
    badge.textContent='Top 5';
    donutTitle.append(badge);
  }
}
initReportTrxSearch();
initReportGemini3Texts();
updateReportChartLayout();
renderCart();renderShift();
renderOutlets();
renderReports();
$('clearCartButton').onclick=confirmClearCart;
})();
