import './marketing.css';

export default function MarketingLanding() {
  return (
    <main className="marketing-page">
      <header className="marketing-nav">
        <a className="marketing-brand" href="/" aria-label="FastQ, beranda">
          <img src={`${import.meta.env.BASE_URL}fastq-mark.png`} alt="" />
          <strong>FastQ</strong>
        </a>
        <a className="marketing-login" href="/dashboard">
          Masuk
        </a>
      </header>
      <section className="marketing-hero">
        <div className="marketing-copy">
          <span className="eyebrow">APLIKASI KASIR DAN OPERASIONAL TOKO</span>
          <h1>
            Urus toko lebih cepat.
            <br />
            <span>Fokus pada transaksi.</span>
          </h1>
          <p>
            Kelola penjualan, stok, shift, dan laporan toko lewat satu aplikasi kasir yang siap
            dipakai di berbagai perangkat.
          </p>
          <div className="marketing-actions">
            <a className="primary-action" href="/pos">
              Buka aplikasi kasir
            </a>
            <a className="secondary-action" href="/dashboard">
              Dashboard pemilik
            </a>
          </div>
          <div className="marketing-note">
            <span>
              <span className="offline-first-text">Offline-first</span> — dirancang untuk membantu
              transaksi tetap berjalan, bahkan saat koneksi internet terbatas.
            </span>
          </div>
        </div>
        <div className="marketing-visual" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}fastq-mark.png`} alt="" />
        </div>
      </section>
      <section className="marketing-features" aria-label="Fitur FastQ">
        <article>
          <span>01</span>
          <h2>Transaksi praktis</h2>
          <p>
            Pilih produk, kelola keranjang, dan selesaikan pembayaran dengan alur kasir yang
            ringkas.
          </p>
        </article>
        <article>
          <span>02</span>
          <h2>Operasional teratur</h2>
          <p>Pantau stok, shift, kas, dan aktivitas pengguna dari aplikasi yang sama.</p>
        </article>
        <article>
          <span>03</span>
          <h2>Laporan penjualan</h2>
          <p>Lihat ringkasan penjualan dan performa outlet melalui dashboard pemilik.</p>
        </article>
      </section>
      <footer className="marketing-footer">FastQ | Aplikasi kasir dan operasional toko</footer>
    </main>
  );
}
