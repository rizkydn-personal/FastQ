# FastQ POS

Aplikasi kasir web untuk toko ritel dan F&B. Frontend dibangun dengan Vite/React, API berjalan pada Node.js, dan PostgreSQL Supabase menyimpan akun serta data sinkronisasi. Data kerja POS juga disimpan terenkripsi pada perangkat/browser; database tidak menggantikan backup perangkat.

## Production: VPS + Supabase

### 1. Siapkan Supabase

Ambil connection string dari **Supabase Dashboard → Connect** untuk project yang benar.

#### Buat role database

Di **SQL Editor** Supabase, jalankan sekali sebagai role `postgres`. Ganti kedua placeholder password dengan secret yang berbeda dan kuat; jangan commit nilai aslinya.

```sql
CREATE ROLE pos_app_runtime
  WITH LOGIN PASSWORD 'GANTI_PASSWORD_RUNTIME'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE pos_admin
  WITH LOGIN PASSWORD 'GANTI_PASSWORD_MIGRASI'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE postgres TO pos_app_runtime, pos_admin;
GRANT CREATE ON DATABASE postgres TO pos_admin;
GRANT USAGE ON SCHEMA public TO pos_app_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO pos_admin;
```

Jalankan `CREATE ROLE` hanya jika role belum ada. Jika role sudah ada dan hanya perlu mengganti password, gunakan `ALTER ROLE pos_app_runtime WITH PASSWORD 'PASSWORD_BARU';` atau `ALTER ROLE pos_admin WITH PASSWORD 'PASSWORD_BARU';`. Jangan memberikan membership ke role `postgres`, `service_role`, atau role istimewa Supabase.

Migrator mengatur default privileges objek yang dibuat `pos_admin`, memberi role runtime hak DML pada tabel dan sequence aplikasi, lalu membatasi tabel `schema_migrations` menjadi read-only. Karena itu, migrasikan database menggunakan `pos_admin` setelah kedua role dibuat.

Ambil connection string dari **Connect** untuk masing-masing role dan pilih pooler **Session mode** (port `5432`) jika VPS tidak mendukung koneksi IPv6 langsung. Connection string pooler biasanya memakai nama login `nama_role.project_ref`; salin format persis yang ditampilkan dashboard.

Panduan resmi: [Postgres Roles](https://supabase.com/docs/guides/database/postgres/roles) dan [izin migrasi pada database Supabase](https://supabase.com/kb/troubleshooting/resolving-permission-denied-for-database-postgres-during-migrations-78f33a).

- `DATABASE_URL` adalah koneksi runtime role terbatas (`pos_app_runtime`).
- `POS_MIGRATION_DATABASE_URL` hanya digunakan di komputer admin untuk role DDL `pos_admin`. Jangan pasang URL migrasi ini di VPS atau environment aplikasi.
- Set `PGSSLMODE=verify-full` dan `PGSSLROOTCERT` ke file root CA PEM Supabase dari dashboard. Jangan menonaktifkan validasi sertifikat.
- Dari mesin admin, siapkan environment lalu jalankan `npm run db:migrate`. Sesudah migrasi, `npm run db:status` memastikan role runtime, TLS, dan versi skema siap. Migrasi dijalankan sebelum merilis aplikasi baru.

Jangan menaruh connection string atau password database di Git, tiket, atau chat. Simpan environment produksi dengan izin baca terbatas. Password dalam URL harus di-URL-encode bila mengandung karakter khusus.

### 2. Build di VPS

Pasang Node.js 20 atau lebih baru dan Git. Buat direktori deployment milik user khusus aplikasi, lalu:

```sh
git clone <URL-REPOSITORY> /opt/fastq-pos
cd /opt/fastq-pos
npm ci
npm run build
npm prune --omit=dev
```

Build membuat `public/` dari sumber legacy dan frontend pada `dist/`. Setelah build selesai, runtime Node hanya memerlukan dependency produksi. Jangan menghapus `public/` atau `dist/` setelah build.

Simpan environment di `/etc/fastq-pos/fastq-pos.env` dengan pemilik root dan mode `0600`. `.env.example` mencantumkan variabel aplikasi; isi `DATABASE_URL` dengan runtime role, serta buat secret acak berbeda untuk `POS_SESSION_SECRET` dan `POS_API_TOKEN`. Tambahkan `POS_TOTP_ENCRYPTION_KEY` (64 karakter hex) hanya jika TOTP digunakan. Di production, aplikasi otomatis mempercayai header reverse proxy dan memakai cookie secure; mode development menonaktifkan keduanya. Jangan sertakan `POS_MIGRATION_DATABASE_URL` pada server aplikasi.

Contoh `/etc/systemd/system/fastq-pos.service` (sesuaikan user dan path):

```ini
[Unit]
Description=FastQ POS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fastq-pos
Group=fastq-pos
WorkingDirectory=/opt/fastq-pos
EnvironmentFile=/etc/fastq-pos/fastq-pos.env
Environment=HOST=127.0.0.1
Environment=PORT=4173
ExecStart=/usr/bin/node /opt/fastq-pos/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Aktifkan dengan `sudo systemctl daemon-reload && sudo systemctl enable --now fastq-pos`. Node mendengarkan `127.0.0.1:4173`; jangan buka port itu ke internet.

Contoh konfigurasi Nginx di server HTTPS:

```nginx
client_max_body_size 21m;
location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Gunakan sertifikat HTTPS valid dan buka hanya SSH, HTTP, dan HTTPS di firewall. `/` adalah landing page, `/pos` adalah kasir, `/owner` adalah dashboard. `/api/health/live` memeriksa proses; `/api/health` memeriksa database.

Printer LAN dikonfigurasi dari kasir saat memilih **LAN**. Masukkan IP privat printer, port raw ESC/POS (umumnya `9100`), dan token API server. Pengaturan disimpan terenkripsi pada perangkat. Server harus berada pada jaringan yang dapat menjangkau printer; untuk VPS publik, gunakan USB/Bluetooth di perangkat kasir atau printer jaringan yang dapat dijangkau secara privat oleh server.

### 3. Rilis dan operasi

```sh
cd /opt/fastq-pos
git pull --ff-only
npm ci
npm run build
npm prune --omit=dev
sudo systemctl restart fastq-pos
curl --fail https://<DOMAIN>/api/health/live
curl --fail https://<DOMAIN>/api/health
```

Jalankan `npm run db:status` dari mesin admin yang memiliki `DATABASE_URL` runtime untuk diagnosis. Untuk perubahan skema, jalankan migrasi dari mesin admin sebelum mengalihkan aplikasi ke versi baru. Server menolak API saat role runtime terlalu berhak, database tidak tersedia, atau skema tertinggal.

Gunakan backup otomatis dan retensi sesuai paket Supabase. Tinjau [dokumentasi backup Supabase](https://supabase.com/docs/guides/platform/backups); retensi harian dan PITR bergantung pada paket/add-on. Jadwalkan uji restore ke project staging, termasuk pemeriksaan login, transaksi, dan sinkronisasi. Backup database tidak mencakup snapshot POS lokal di perangkat kasir.

## Pengembangan lokal

```sh
npm ci
npm run dev:all
```

Buka `http://localhost:5173`. `dev:all` menjalankan API di port 4173 dan Vite pada port 5173. Untuk web hasil build: `npm run build && npm start`, lalu buka `http://localhost:4173`. `.env.example` adalah templat environment; isi `.env` lokal dengan database pengembangan. Jangan jalankan migrasi produksi tanpa meninjau perubahan.

Untuk Android, pasang seluruh dependency pengembangan lalu gunakan `npm run cap:sync`; Android SDK diperlukan untuk APK.

## Fitur

- POS dengan keranjang, diskon, pembayaran, piutang, struk, barcode, dan dukungan printer browser/native.
- Produk, varian, stok, impor/ekspor CSV, shift, absensi, kas, refund, dan persetujuan role.
- Dashboard pemilik, laporan, antrean sinkronisasi, serta penyimpanan snapshot lokal terenkripsi.

File `legacy-scripts/pos/*.js` adalah fragmen sumber yang digabung berurutan oleh `scripts/copy-legacy.mjs`; file generated di `public/` tidak diedit langsung. Migrasi database bernomor ada di `db/migrations/`; `db/schema.sql` adalah baseline.

## Environment

Lihat [.env.example](.env.example). `DATABASE_URL`, secret sesi, dan token API wajib. `PGSSLMODE=verify-full` dan CA Supabase direkomendasikan untuk koneksi managed PostgreSQL.
