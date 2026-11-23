import { lazy, Suspense, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import './style.css';

const OwnerDashboard = lazy(() => import('./pages/OwnerDashboard'));
const MarketingLanding = lazy(() => import('./pages/MarketingLanding'));

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    try {
      localStorage.removeItem('pos-owner-session');
    } catch {}
  }, []);

  useEffect(() => {
    let active = true;
    let cleanupBridges: (() => void) | undefined;
    void (async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const { initializeNativeStorage } = await import('./nativeStorage');
          await initializeNativeStorage();

          if (Capacitor.getPlatform() === 'android') {
            try {
              const { installNativeBridges } = await import('./nativeBridges');
              if (!active) return;
              cleanupBridges = installNativeBridges();
            } catch {
              throw new Error('native-bridges-unavailable');
            }
          }
        }
        if (active) setReady(true);
      } catch (error) {
        if (active)
          setError(
            error instanceof Error && error.message === 'native-bridges-unavailable'
              ? 'Fitur scanner/printer Android belum dapat disiapkan. Mulai ulang aplikasi atau hubungi administrator.'
              : 'Penyimpanan lokal terenkripsi belum dapat dibuka. Data tidak dihapus. Coba mulai ulang aplikasi atau hubungi administrator.',
          );
      }
    })();
    return () => {
      active = false;
      cleanupBridges?.();
    };
  }, []);

  if (error)
    return (
      <main className="status">
        <img className="brand-mark" src={`${import.meta.env.BASE_URL}fastq-mark.png`} alt="" />
        <h1>Penyimpanan terkunci</h1>
        <p>{error}</p>
      </main>
    );
  if (!ready)
    return (
      <main className="status">
        <img className="brand-mark" src={`${import.meta.env.BASE_URL}fastq-mark.png`} alt="" />
        <p>Membuka FastQ…</p>
      </main>
    );

  const pageLoading = (
    <main className="status">
      <p role="status">Memuat halaman…</p>
    </main>
  );
  if (!import.meta.env.BASE_URL.includes('capacitor')) {
    if (location.pathname === '/dashboard') {
      return (
        <Suspense fallback={pageLoading}>
          <OwnerDashboard />
        </Suspense>
      );
    }
    if (location.pathname === '/' || location.pathname.startsWith('/landing')) {
      return (
        <Suspense fallback={pageLoading}>
          <MarketingLanding />
        </Suspense>
      );
    }
  }
  return (
    <iframe className="pos-frame" src={`${import.meta.env.BASE_URL}pos.html`} title="FastQ POS" />
  );
}
