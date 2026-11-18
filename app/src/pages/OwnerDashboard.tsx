import { useEffect, useState, type FormEvent } from 'react';
import './dashboard.css';

type Dashboard = {
  transactions: number;
  revenue: string;
  receivables: string;
  days: number;
  outlets: { id: string; name: string }[];
  lowStock: { name: string; sku: string; quantity: string; min_stock: string }[];
  byCashier: { label: string; value: string }[];
  byPayment: { label: string; value: string }[];
  byCategory: { label: string; value: string }[];
  trend: { day: string; value: string; transactions: number }[];
  sales: { sale_number: string; status: string; total_rupiah: string; occurred_at: string; cashier_name: string }[];
};

const rupiah = (amount: string | number) => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0,
}).format(Number(amount) || 0);

export default function OwnerDashboard({ initiallyAuthenticated = false }: { initiallyAuthenticated?: boolean }) {
  const [authenticated, setAuthenticated] = useState(initiallyAuthenticated);
  const [checkingSession, setCheckingSession] = useState(!initiallyAuthenticated);
  const [login, setLogin] = useState({ identifier: '', password: '', totp: '' });
  const [requiresTotp, setRequiresTotp] = useState(false);
  useEffect(() => {
    setRequiresTotp(false);
    setLogin(current => ({ ...current, totp: '' }));
  }, [login.identifier, login.password]);
  const [outlet, setOutlet] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initiallyAuthenticated) return;
    let active = true;
    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(response => { if (active) setAuthenticated(response.ok); })
      .catch(() => { if (active) setAuthenticated(false); })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [initiallyAuthenticated]);

async function signIn(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(login) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Login gagal.');
      if (body.requiresTotp) { setRequiresTotp(true); return; }
      setAuthenticated(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Login gagal.'); }
    finally { setLoading(false); }
  }

  async function load(signal?: AbortSignal) {
    if (!authenticated) return;
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ days: String(days) });
      if (outlet) query.set('outletId', outlet);
      const response = await fetch(`/api/dashboard?${query}`, { credentials: 'same-origin', signal });
      const body = await response.json();
      if (!response.ok) { if (response.status === 401) setAuthenticated(false); throw new Error(body.error || 'Dashboard tidak dapat dimuat.'); }
      if (!signal?.aborted) setData(body);
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : 'Koneksi dashboard gagal.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }

  useEffect(() => { const controller = new AbortController(); if (authenticated) void load(controller.signal); return () => controller.abort(); }, [authenticated, outlet, days]);

  async function signOut() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Sesi belum dapat diakhiri. Periksa koneksi lalu coba lagi.');
      setAuthenticated(false); setData(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Sesi belum dapat diakhiri.'); }
  }

  if (checkingSession) return <main className="status"><h1>Dashboard toko</h1><p role="status">Memeriksa sesi...</p></main>;
  if (!authenticated) return <main className="dashboard-page"><header className="dash-header"><strong>FastQ</strong><span>Dashboard toko</span></header><section className="dash-login"><h1>Masuk dashboard</h1><p>Gunakan email atau nomor HP dan password.</p><form onSubmit={signIn}><label>Email atau nomor HP<input value={login.identifier} onChange={e => setLogin({ ...login, identifier: e.target.value })} autoComplete="username" maxLength={254} required /></label><label>Password<input type="password" autoComplete="current-password" maxLength={256} value={login.password} onChange={e => setLogin({ ...login, password: e.target.value })} required /></label>{requiresTotp && <label>Kode authenticator<input autoFocus required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={login.totp} onChange={e => setLogin({ ...login, totp: e.target.value })} /></label>}<button className="primary-action" disabled={loading}>{loading ? 'Memeriksa...' : requiresTotp ? 'Verifikasi' : 'Masuk'}</button></form>{error && <p className="error-text" role="alert">{error}</p>}<p><a href="/pos">Daftar dan buat toko</a></p></section></main>;
  if (!data) return <main className="status"><h1>Dashboard toko</h1>{loading ? <p role="status">Memuat laporan...</p> : <><p className="error-text" role="alert">{error}</p><button className="primary-action" onClick={() => void load()}>Coba lagi</button></>}<button className="logout-action" onClick={() => void signOut()}>Keluar</button></main>;


  const maxTrend = Math.max(1, ...data.trend.map(x => Number(x.value)));
  const breakdown = (title: string, rows: { label: string; value: string }[]) => <section className="dash-panel"><h2>{title}</h2>{rows.length ? rows.map(row => <div className="breakdown-row" key={row.label}><span>{row.label}</span><strong>{rupiah(row.value)}</strong></div>) : <p className="empty-message">Belum ada data pada periode ini.</p>}</section>;

  return <main className="dashboard-page"><header className="dash-header"><img className="brand-mark" src={`${import.meta.env.BASE_URL}fastq-mark.png`} alt="" /><div><strong>FastQ</strong><span>Dashboard toko</span></div><button className="logout-action" onClick={() => void signOut()}>Keluar</button></header><section className="dash-content"><div className="dash-title"><div><h1>Ringkasan penjualan</h1><p>Data transaksi perangkat yang sudah tersinkron ke server.</p></div><button onClick={() => void load()} disabled={loading}>{loading ? 'Memuat...' : 'Muat ulang'}</button></div><div className="dash-filters"><label>Outlet<select value={outlet} onChange={e => setOutlet(e.target.value)}><option value="">Semua outlet</option>{data.outlets.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label><label>Periode<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>7 hari</option><option value={30}>30 hari</option><option value={90}>90 hari</option><option value={365}>12 bulan</option></select></label></div>{error && <p className="error-text">{error}</p>}<div className="metric-grid"><article><span>Omzet</span><strong>{rupiah(data.revenue)}</strong></article><article><span>Transaksi berhasil</span><strong>{data.transactions}</strong></article><article><span>Piutang aktif</span><strong>{rupiah(data.receivables)}</strong></article></div><section className="dash-panel"><h2>Tren omzet harian</h2><div className="trend-chart">{data.trend.map(day => <div className="trend-column" key={day.day} title={`${day.day}: ${rupiah(day.value)} · ${day.transactions} transaksi`}><div className="trend-bar" style={{ height: `${Math.max(3, Number(day.value) / maxTrend * 100)}%` }} /><span>{new Date(`${day.day}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</span></div>)}</div></section><div className="report-grid">{breakdown('Penjualan per kategori', data.byCategory)}{breakdown('Penjualan per kasir', data.byCashier)}{breakdown('Metode pembayaran', data.byPayment)}</div><section className="dash-panel"><h2>Transaksi terbaru</h2><div className="table-scroll"><table><thead><tr><th>Waktu</th><th>Nomor</th><th>Kasir</th><th>Status</th><th className="numeric">Total</th></tr></thead><tbody>{data.sales.map(s => <tr key={s.sale_number}><td>{new Date(s.occurred_at).toLocaleString('id-ID')}</td><td>{s.sale_number}</td><td>{s.cashier_name}</td><td>{s.status}</td><td className="numeric">{rupiah(s.total_rupiah)}</td></tr>)}</tbody></table>{!data.sales.length && <p className="empty-message">Belum ada transaksi pada periode ini.</p>}</div></section><section className="dash-panel"><h2>Stok menipis</h2><div className="table-scroll"><table><thead><tr><th>Produk</th><th>SKU</th><th className="numeric">Stok</th><th className="numeric">Minimum</th></tr></thead><tbody>{data.lowStock.map(p => <tr key={p.sku}><td>{p.name}</td><td>{p.sku}</td><td className="numeric">{p.quantity}</td><td className="numeric">{p.min_stock}</td></tr>)}</tbody></table>{!data.lowStock.length && <p className="empty-message">Tidak ada stok di bawah batas minimum.</p>}</div></section></section></main>;
}