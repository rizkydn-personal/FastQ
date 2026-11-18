import { lazy, Suspense, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import './style.css';

const OwnerDashboard = lazy(() => import('./pages/OwnerDashboard'));
const MarketingLanding = lazy(() => import('./pages/MarketingLanding'));

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [rootDashboardSession, setRootDashboardSession] = useState(false);

  useEffect(() => {
    try { localStorage.removeItem('pos-owner-session'); } catch {}
    if (location.pathname !== '/') return;
    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json();
        setRootDashboardSession(['Pemilik', 'Manajer', 'Admin'].includes(body.user?.role));
      })
      .catch(() => setRootDashboardSession(false));
  }, []);

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import('./nativeBridges')
      .then(({ installNativeBridges }) => {
        if (!disposed) cleanup = installNativeBridges();
      })
      .catch(() => {
        if (!disposed) setError('Fitur scanner/printer Android belum dapat disiapkan. Mulai ulang aplikasi atau hubungi administrator.');
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const storageReady = Capacitor.isNativePlatform()
      ? import('./nativeStorage').then(({ initializeNativeStorage }) => initializeNativeStorage())
      : Promise.resolve(false);
    void storageReady
      .then(() => { if (active) setReady(true); })
      .catch(() => {
        if (active) setError('Penyimpanan lokal terenkripsi belum dapat dibuka. Data tidak dihapus. Coba mulai ulang aplikasi atau hubungi administrator.');
      });
    return () => { active = false; };
  }, []);

  if (error) return <main className="status"><img className="brand-mark" src={`${import.meta.env.BASE_URL}fastq-mark.png`} alt="" /><h1>Penyimpanan terkunci</h1><p>{error}</p></main>;
  if (!ready) return <main className="status"><img className="brand-mark" src={`${import.meta.env.BASE_URL}fastq-mark.png`} alt="" /><p>Membuka FastQ…</p></main>;

  const pageLoading = <main className="status"><p role="status">Memuat halaman…</p></main>;
  if (!import.meta.env.BASE_URL.includes('capacitor')) {
    if (location.pathname.startsWith('/owner') || (location.pathname === '/' && rootDashboardSession)) {
      return <Suspense fallback={pageLoading}><OwnerDashboard initiallyAuthenticated={location.pathname === '/' && rootDashboardSession} /></Suspense>;
    }
    if (location.pathname === '/' || location.pathname.startsWith('/landing')) {
      return <Suspense fallback={pageLoading}><MarketingLanding /></Suspense>;
    }
  }
  return <iframe className="pos-frame" src={`${import.meta.env.BASE_URL}legacy/index.html`} title="FastQ" />;
}
