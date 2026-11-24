import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Capacitor } from '@capacitor/core';
import './style.css';

const OwnerDashboard = lazy(() => import('./pages/OwnerDashboard'));
const MarketingLanding = lazy(() => import('./pages/MarketingLanding'));

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="status">
        <h1>Halaman belum dapat dimuat</h1>
        <p>Periksa koneksi lalu coba lagi.</p>
        <button onClick={() => location.reload()}>Coba lagi</button>
      </main>
    );
  }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInProgress, setUpdateInProgress] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);

  async function activateUpdate() {
    setUpdateInProgress(true);
    setUpdateError('');
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('Service worker registration is unavailable');

      let waiting = registration.waiting;
      if (!waiting) {
        await registration.update();
        waiting = registration.waiting;
      }
      if (!waiting) throw new Error('No waiting service worker is available');

      const reloadWhenActivated = () => {
        if (waiting.state !== 'activated') return;
        waiting.removeEventListener('statechange', reloadWhenActivated);
        window.location.reload();
      };
      waiting.addEventListener('statechange', reloadWhenActivated);
      reloadWhenActivated();
      waiting.postMessage({ type: 'FASTQ_ACTIVATE_UPDATE' });
    } catch (error) {
      console.error('Unable to activate service worker update:', error);
      setUpdateError('Pembaruan belum dapat dimulai. Periksa koneksi lalu coba lagi.');
      setUpdateInProgress(false);
    }
  }

  useEffect(() => {
    if (!updateConfirmOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setUpdateConfirmOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [updateConfirmOpen]);

  useEffect(() => {
    const showUpdate = () => setUpdateAvailable(true);
    window.addEventListener('fastq:sw-update', showUpdate);
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .getRegistration()
        .then((registration) => {
          if (registration?.waiting && navigator.serviceWorker.controller) showUpdate();
        })
        .catch((error) => console.error('Unable to inspect service worker update:', error));
    }
    return () => window.removeEventListener('fastq:sw-update', showUpdate);
  }, []);
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
  if (!Capacitor.isNativePlatform()) {
    if (location.pathname === '/dashboard') {
      return (
        <ErrorBoundary>
          <Suspense fallback={pageLoading}>
            <OwnerDashboard />
          </Suspense>
        </ErrorBoundary>
      );
    }
    if (location.pathname === '/' || location.pathname.startsWith('/landing')) {
      return (
        <ErrorBoundary>
          <Suspense fallback={pageLoading}>
            <MarketingLanding />
          </Suspense>
        </ErrorBoundary>
      );
    }
  }
  return (
    <>
      {updateAvailable && (
        <aside
          role="status"
          style={{
            position: 'fixed',
            zIndex: 1000,
            inset: '0 0 auto',
            padding: '10px 16px',
            background: '#fff3cd',
            color: '#543d00',
            textAlign: 'center',
            fontSize: 13,
          }}
        >
          Versi baru tersedia. Selesaikan transaksi dan kosongkan keranjang sebelum memperbarui.
          <button
            type="button"
            disabled={updateInProgress}
            style={{
              marginLeft: 12,
              padding: 0,
              border: 0,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontWeight: 700,
              textDecoration: 'underline',
              cursor: 'pointer',
            }}
            onClick={() => setUpdateConfirmOpen(true)}
          >
            {updateInProgress ? 'Memperbarui…' : 'Perbarui sekarang'}
          </button>
          {updateError && (
            <span role="alert" style={{ marginLeft: 12 }}>
              {updateError}
            </span>
          )}
        </aside>
      )}
      {updateConfirmOpen && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setUpdateConfirmOpen(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            background: 'rgba(15, 23, 42, 0.55)',
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="update-confirm-title"
            aria-describedby="update-confirm-message"
            style={{
              width: 'min(100%, 420px)',
              padding: 20,
              borderRadius: 16,
              background: '#fff',
              boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
            }}
          >
            <h2
              id="update-confirm-title"
              style={{ margin: 0, color: '#0f2544', fontSize: 17, fontWeight: 700 }}
            >
              Perbarui FastQ?
            </h2>
            <p
              id="update-confirm-message"
              style={{ margin: '10px 0 20px', color: '#475569', fontSize: 14, lineHeight: 1.6 }}
            >
              Pastikan transaksi selesai dan keranjang kosong sebelum memuat versi baru.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => setUpdateConfirmOpen(false)}
                style={{
                  padding: '9px 14px',
                  border: '1px solid #cbd5e1',
                  borderRadius: 10,
                  background: '#fff',
                  color: '#334155',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  setUpdateConfirmOpen(false);
                  void activateUpdate();
                }}
                style={{
                  padding: '9px 14px',
                  border: 0,
                  borderRadius: 10,
                  background: '#1447e6',
                  color: '#fff',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Perbarui sekarang
              </button>
            </div>
          </section>
        </div>
      )}
      <iframe className="pos-frame" src={`${import.meta.env.BASE_URL}pos.html`} title="FastQ POS" />
    </>
  );
}
