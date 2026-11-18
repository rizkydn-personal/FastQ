const cashierDate = $('posDate');
if (cashierDate) cashierDate.textContent = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
