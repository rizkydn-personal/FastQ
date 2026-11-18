function closeCustomSelect(binding,restoreFocus=false){binding.menu.hidden=true;binding.trigger.setAttribute('aria-expanded','false');if(activeCustomSelect===binding)activeCustomSelect=null;if(restoreFocus)binding.trigger.focus()}
function focusCustomOption(binding,index){const options=[...binding.menu.querySelectorAll('[role="option"]:not(:disabled)')];if(!options.length)return;options[(index+options.length)%options.length].focus()}
function openCustomSelect(binding){if(activeCustomSelect&&activeCustomSelect!==binding)closeCustomSelect(activeCustomSelect);binding.menu.hidden=false;binding.trigger.setAttribute('aria-expanded','true');activeCustomSelect=binding;const options=[...binding.menu.querySelectorAll('[role="option"]:not(:disabled)')],selected=options.findIndex(option=>option.getAttribute('aria-selected')==='true');focusCustomOption(binding,selected<0?0:selected)}
function syncCustomSelect(select,label,variant=''){if(!select)return;let binding=customSelectBindings.get(select);if(!binding){select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');const wrapper=document.createElement('div'),trigger=document.createElement('button'),value=document.createElement('span'),icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path'),menu=document.createElement('div');wrapper.className=`custom-select${variant?` custom-select-${variant}`:''}`;trigger.type='button';trigger.className='custom-select-trigger';trigger.setAttribute('aria-label',label);trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.id=`customSelect-${select.id}-trigger`;trigger.setAttribute('aria-controls',`customSelect-${select.id}-menu`);value.className='custom-select-value';icon.setAttribute('viewBox','0 0 20 20');icon.setAttribute('aria-hidden','true');path.setAttribute('d','m5 7.5 5 5 5-5');icon.append(path);trigger.append(value,icon);menu.className='custom-select-menu';menu.id=`customSelect-${select.id}-menu`;menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label);menu.hidden=true;wrapper.append(trigger,menu);select.after(wrapper);binding={select,label,wrapper,trigger,value,menu};customSelectBindings.set(select,binding);wrapper.addEventListener('click',event=>{const option=event.target.closest('[role="option"]');if(option&&wrapper.contains(option)){select.value=option.dataset.value;syncCustomSelect(select,label,variant);closeCustomSelect(binding);select.dispatchEvent(new Event('change',{bubbles:true}));trigger.focus();return}if(event.target.closest('.custom-select-trigger')){if(activeCustomSelect===binding)closeCustomSelect(binding);else openCustomSelect(binding)}});wrapper.addEventListener('keydown',event=>{if(event.target===trigger){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openCustomSelect(binding)}else if(event.key==='Escape'&&activeCustomSelect===binding){event.preventDefault();closeCustomSelect(binding,true)}return}if(!event.target.matches('[role="option"]'))return;if(event.key==='Escape'){event.preventDefault();closeCustomSelect(binding,true)}else if(event.key==='Tab'){closeCustomSelect(binding)}else if(event.key==='ArrowDown'||event.key==='ArrowUp'||event.key==='Home'||event.key==='End'){event.preventDefault();const options=[...menu.querySelectorAll('[role="option"]:not(:disabled)')],current=options.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?options.length-1:current+(event.key==='ArrowDown'?1:-1);focusCustomOption(binding,next)}})}binding.label=label;binding.wrapper.className=`custom-select${variant?` custom-select-${variant}`:''}`;binding.menu.setAttribute('aria-label',label);binding.menu.replaceChildren();const options=[...select.options];binding.value.textContent=options.find(option=>option.value===select.value)?.textContent?.trim()||label;options.forEach(option=>{const item=document.createElement('button');item.type='button';item.className='custom-select-option';item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.value===select.value));item.dataset.value=option.value;item.disabled=option.disabled;item.tabIndex=option.value===select.value?0:-1;item.textContent=option.textContent.trim();binding.menu.append(item)});return binding.trigger}
document.addEventListener('click',event=>{if(activeCustomSelect&&!activeCustomSelect.wrapper.contains(event.target))closeCustomSelect(activeCustomSelect)});
const modalBeforeCustomSelect=modal;
modal=function(...args){const result=modalBeforeCustomSelect.apply(this,args),select=$('idKind');if(select){const trigger=syncCustomSelect(select,'Jenis diskon');setTimeout(()=>trigger.focus(),0)}return result};
const renderOutletsBeforeCustomSelect=renderOutlets;
renderOutlets=function(...args){const result=renderOutletsBeforeCustomSelect.apply(this,args);syncCustomSelect($('outletSelect'),'Pilih outlet','outlet');return result};
let activeReportChart='sales';
function renderReportCharts(sales,monthValue){
  $('salesTrendChart').innerHTML=reportChartSvg(buildSalesTrend(sales,monthValue),{money:true,color:'#2563EB',label:'Trend penjualan bulanan'});
  const products=new Map();
  sales.forEach(sale=>sale.items.forEach(item=>{const key=item.productId||item.name,current=products.get(key)||{label:item.name,value:0};current.value+=Number(item.qty)||0;products.set(key,current)}));
  const best=Array.from(products.values()).sort((a,b)=>b.value-a.value).slice(0,5).map(point=>({...point,shortLabel:point.label.length>12?`${point.label.slice(0,11)}…`:point.label}));
  $('topProductsChart').innerHTML=reportChartSvg(best,{color:'#0F766E',label:'Produk terlaris dalam unit'});
  const grid=$('reportChartGrid');
  if(grid.clientWidth)updateReportChartLayout();
}
const renderReportsBeforeCharts=renderReports;
renderReports=function(){
  renderReportsBeforeCharts();
  const period=$('reportPeriod').value,chosen=$('reportDate').value||today();
  const monthInput=$('reportChartMonth');
  if(!monthInput.value)monthInput.value=currentReportMonth();
  const chartMonth=monthInput.value,currentMonth=currentReportMonth();
  const sales=[],chartSales=[],dailyTotals=new Map(),productTotals=new Map();
  let capital=0,profit=0,itemCount=0;
  for(const sale of state.sales){
    if((sale.outletId&&sale.outletId!==state.activeOutlet)||(sale.status!=='Lunas'&&sale.status!=='Piutang'))continue;
    const date=new Date(sale.at),saleMonth=reportMonthKey(date);
    if(dateWithin(sale.at,period,chosen)){
      sales.push(sale);
      for(const item of sale.items){const quantity=Number(item.qty)||0,price=Number(item.price)||0,cost=Number(item.cost)||0;itemCount+=quantity;capital+=cost*quantity;profit+=(price-cost)*quantity}
      profit-=Number(sale.discount)||0;
    }
    if(saleMonth===chartMonth)chartSales.push(sale);
    if(Number.isNaN(date.getTime()))continue;
    if(saleMonth===currentMonth){
      const dateKey=reportDateKey(date),day=dailyTotals.get(dateKey)||{key:dateKey,total:0,transactions:0};
      day.total+=Number(sale.total)||0;day.transactions++;dailyTotals.set(dateKey,day);
    }
    for(const item of sale.items){
      const key=item.productId||item.name,product=productTotals.get(key)||{name:item.name,quantity:0,revenue:0};
      product.quantity+=Number(item.qty)||0;product.revenue+=(Number(item.price)||0)*(Number(item.qty)||0);productTotals.set(key,product);
    }
  }
  const topDays=Array.from(dailyTotals.values()).sort((a,b)=>b.total-a.total||b.key.localeCompare(a.key)).slice(0,3);
  $('topDatesSummary').innerHTML=topDays.map((day,index)=>{
    const[year,monthNumber,dayNumber]=day.key.split('-');
    const label=new Date(Number(year),Number(monthNumber)-1,Number(dayNumber)).toLocaleDateString('id-ID',{weekday:'short',day:'2-digit',month:'short'});
    return`<li><span class="report-rank-number">${String(index+1).padStart(2,'0')}</span><span class="report-rank-copy"><strong>${esc(label)}</strong><small>${fmt.format(day.transactions)} transaksi</small></span><strong class="report-rank-value">${rupiah(day.total)}</strong></li>`;
  }).join('')||'<li class="report-rank-empty">Belum ada penjualan bulan ini.</li>';
  const bestProducts=Array.from(productTotals.values()).sort((a,b)=>b.quantity-a.quantity||b.revenue-a.revenue||a.name.localeCompare(b.name,'id')).slice(0,5);
  $('bestProductsSummary').innerHTML=bestProducts.map((product,index)=>`<li><span class="report-rank-number">${String(index+1).padStart(2,'0')}</span><span class="report-rank-copy"><strong>${esc(product.name)}</strong><small>${fmt.format(product.quantity)} unit terjual</small></span><strong class="report-rank-value">${rupiah(product.revenue)}</strong></li>`).join('')||'<li class="report-rank-empty">Belum ada item terjual.</li>';
  $('reportAverage').textContent=rupiah(capital);
  $('reportTxnCount').textContent=fmt.format(sales.length);
  $('reportItems').textContent=fmt.format(itemCount);
  $('reportProfit').textContent=rupiah(profit);
  renderReportCharts(chartSales,chartMonth);
};
if(!$('reportChartMonth').value)$('reportChartMonth').value=currentReportMonth();
$('reportChartMonth').addEventListener('change',()=>renderReports());
function updateReportChartLayout(){
  const grid=$('reportChartGrid'),switcher=$('reportChartSwitch'),compact=grid.clientWidth<720;
  switcher.hidden=!compact;
  grid.classList.toggle('report-charts-compact',compact);
  $('salesTrendPanel').hidden=compact&&activeReportChart!=='sales';
  $('topProductsChartPanel').hidden=compact&&activeReportChart!=='products';
  document.querySelectorAll('[data-report-chart]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.reportChart===activeReportChart)));
}
document.querySelectorAll('[data-report-chart]').forEach(button=>button.onclick=()=>{activeReportChart=button.dataset.reportChart;updateReportChartLayout()});
if(window.ResizeObserver)new ResizeObserver(updateReportChartLayout).observe($('reportChartRegion'));
else window.addEventListener('resize',updateReportChartLayout);
updateReportChartLayout();
renderCart();renderShift();
renderOutlets();
$('clearCartButton').onclick=confirmClearCart;
})();
