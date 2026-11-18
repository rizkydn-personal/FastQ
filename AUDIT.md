# Audit Teknis FastQ POS

**Tanggal audit awal:** 15 November 2026  
**Pembaruan implementasi:** 16 November 2026  
**Cakupan:** pemeriksaan statis source, konfigurasi, skema database, penyimpanan/sinkronisasi, deployment, dan dependensi produksi.  
**Batas:** tidak menjalankan simulasi beban, uji perangkat, atau pemulihan database. Suite aplikasi dan jalur transaksi sinkronisasi tertentu telah diuji; tiga migrasi skema diterapkan ke database `.env` atas instruksi eksplisit. Tidak ada data uji yang tersisa karena transaksi tes di-rollback. Backup pra-migrasi tidak tersedia di workspace.

## Ringkasan

Project sudah memiliki fondasi baik untuk POS kecil: query SQL umumnya memakai parameter, password memakai PBKDF2, sesi ditandatangani HMAC, TOTP dienkripsi AES-GCM, snapshot POS dienkripsi, API dibatasi ke loopback, dan tersedia rancangan backup PITR/offsite. Perintah npm audit --omit=dev melaporkan 0 kerentanan pada dependensi produksi saat audit.

Source untuk temuan P1 utama sudah diperbaiki: server tidak lagi menyajikan source saat build hilang, transaksi divalidasi server, diskon Kasir dibatasi server, dan backup dibatasi ke sesi/outlet. Migrasi database 1, 2, dan 3 telah diterapkan ke database `.env`; `DATABASE_URL` memakai role runtime terbatas dan readiness lulus pada schema 3. Credential operator lama yang sempat bocor masih perlu dicabut di penyedia database setelah akses migrasi alternatif disiapkan. Backup offsite/restore belum dibuktikan. Retensi event tetap nonaktif demi melindungi perangkat offline sampai bootstrap snapshot tersedia; ukuran snapshot dan kompatibilitas perangkat juga belum diukur. Temuan prioritas berikut mencatat baseline audit; status kode terbaru ada di tabel tindak lanjut dan bagian validasi terbaru.

## Temuan prioritas

### P1 — Server dapat menyajikan source/config jika build tidak tersedia

**Bukti:** server.mjs:12-13 memakai direktori project sebagai static root bila dist/index.html tidak ada. Handler server.mjs:975-989 menyajikan file yang ditemukan di root tersebut. Dalam kondisi itu, URL seperti /server.mjs dapat menampilkan source, dan file sensitif perlu diblokir secara eksplisit.

**Dampak:** deployment yang lupa build atau kehilangan folder dist berisiko mengekspos source dan, bergantung nama file/konfigurasi, secret.

**Saran:** server produksi hanya boleh menyajikan direktori build yang ditentukan dan harus gagal startup bila direktori itu tidak ada. Gunakan allowlist file statis, tolak dotfile/path sensitif, dan pastikan pemeriksaan deployment membuktikan .env serta source tidak bisa diminta melalui HTTP.

### P1 — Backend menerima nilai transaksi dari klien sebagai data otoritatif

**Bukti:** cabang sale.upsert di server.mjs:530-586 menyimpan subtotal, diskon, pajak, biaya layanan, total, item, dan pembayaran dari payload klien. Backend tidak menghitung ulang total dari harga produk tersimpan atau memvalidasi kecocokan total pembayaran secara menyeluruh.

**Dampak:** klien yang dimodifikasi dapat menyinkronkan angka transaksi palsu. Dashboard/laporan kemudian menampilkan angka itu sebagai data server.

**Saran:** validasi bentuk dan rentang angka; hitung ulang total di server dari item dan aturan harga; verifikasi pembayaran dan transisi status. Untuk transaksi offline, tetapkan rekonsiliasi server yang jelas dan catat perbedaan untuk ditinjau.

### P1 — Endpoint backup memakai token bersama dan tidak membatasi outlet

**Bukti:** /api/backup memakai POS_API_TOKEN (server.mjs:897-929). GET memilih backup dari outletId tanpa mengikat outlet ke sesi pengguna. Enkripsi backup di klien memperoleh kunci dari state.settings.syncToken (index.html:141).

**Dampak:** pemegang token dapat meminta backup outlet lain. Jika syncToken sama dengan token API, pemegang token mungkin juga memiliki bahan untuk membuka backup.

**Saran:** gunakan sesi pengguna dan cek hak akses outlet; pisahkan kredensial backup dari token printer/API; gunakan kunci backup per outlet/perangkat yang tidak dikirim dalam request dan siapkan rotasi/pemulihan. Verifikasi apakah token yang dipakai untuk enkripsi memang sama pada deployment.

### P2 — Rate limit login dapat mengunci semua pengguna di balik proxy

**Bukti:** server.mjs:33-35,83-96 membatasi login berdasarkan req.socket.remoteAddress. Server mendengarkan di 127.0.0.1 (server.mjs:996); pada reverse proxy alamat socket dapat selalu alamat proxy.

**Dampak:** lima kegagalan login dapat memblokir pengguna lain yang berbagi proxy selama 15 menit. Map kegagalan juga tersimpan di memori dan tidak memiliki batas jumlah entri.

**Saran:** batasi bertingkat per akun dan sumber melalui proxy tepercaya yang dikonfigurasi eksplisit; tambahkan retensi/batas entri, logging, dan pemulihan agar satu pengguna tidak dapat mengunci satu jaringan.

### P2 — Token dashboard tersimpan di localStorage, CSP belum tampak

**Bukti:** token sesi disimpan di localStorage pada app/src/App.tsx:52-72. Header file statis di server.mjs:985-989 memiliki nosniff dan Referrer-Policy, tetapi tidak CSP atau kebijakan frame yang jelas.

**Dampak:** script injeksi dapat membaca token yang berlaku sampai 30 hari. Tanpa CSP, lapisan pembatasan dampak injeksi lebih lemah.

**Saran:** pertimbangkan cookie HttpOnly, Secure, SameSite dan rotasi sesi. Terapkan CSP bertahap setelah inline script/style dan iframe dipetakan; tambahkan kebijakan frame dan Permissions-Policy yang kompatibel dengan aplikasi.

### P2 — POS menyimpan ulang seluruh snapshot aplikasi

**Bukti:** index.html:121,125 menyerialisasi semua state, mengenkripsi, lalu menulis satu record IndexedDB. Native juga menyimpan satu payload di app/src/nativeStorage.ts:31-47.

**Dampak:** waktu serialisasi/enkripsi/tulis dan memori bertambah bersama riwayat penjualan. Antrean simpan dapat tertinggal; error simpan hanya mengubah status UI.

**Saran:** ukur durasi simpan dan ukuran snapshot dengan data realistis. Lalu pindah bertahap ke penyimpanan per entitas/perubahan, batching yang tetap memastikan transaksi tersimpan sebelum dianggap berhasil, dan arsip/retensi riwayat. Buat kegagalan simpan terlihat jelas.

### P2 — Event sinkronisasi tidak memiliki retensi/arsip

**Bukti:** sync_events dan indeksnya dibuat di db/schema.sql:253-265. Endpoint membaca berdasarkan cursor dalam batch maksimal 1.000 (server.mjs:321-334,856-861), namun tidak tampak pembersihan atau arsip event.

**Dampak:** tabel dan indeks akan terus tumbuh, menambah waktu query, backup, dan kebutuhan disk.

**Saran:** tetapkan retensi berdasarkan kebutuhan audit dan durasi offline terlama. Arsipkan atau hapus event setelah aman dikonsumsi semua perangkat; pertahankan watermark dan prosedur resinkronisasi perangkat lama.

### P2 — Migrasi database berjalan saat server mulai

**Bukti:** server.mjs:37-41 menjalankan seluruh db/schema.sql serta pembersihan backup saat startup. Skema mencampur create table dan alter table.

**Dampak:** aplikasi memerlukan hak DDL saat runtime; beberapa instance dapat memulai perubahan bersamaan; sulit meninjau/rollback versi skema. Housekeeping backup juga menjadi efek samping startup.

**Saran:** buat migrasi bernomor yang dijalankan terpisah sebelum deploy dengan akun migrasi. Jadwalkan housekeeping sebagai tugas terpantau.

### P2 — Backup lokal satu host tidak melindungi dari kehilangan host

**Bukti:** volume backup dan WAL pada docker-compose.yml tersimpan di host Docker yang sama. README juga menyatakan backup offsite opsional dan restore perlu diuji.

**Dampak:** kehilangan host/disk atau insiden yang merusak volume dapat menghilangkan database beserta backup lokal.

**Saran:** jadwalkan backup terenkripsi ke S3-compatible storage terpisah dengan retensi dan alert kegagalan. Jika anggaran nol, salin terenkripsi ke host/perangkat fisik terpisah. Uji restore staging berkala.

### P2 — Logika POS/server sulit dirawat sebagai file besar

**Bukti:** index.html sekitar 218 KB/652 baris dan memuat banyak logika POS; server.mjs sekitar 75 KB/996 baris. scripts/copy-legacy.mjs menyalin file legacy ke public dan public/legacy.

**Dampak:** perubahan sulit diisolasi dan ditinjau, risiko regresi bertambah, dan tes/unit/type checking pada POS utama sulit dilakukan. Salinan legacy berisiko berbeda.

**Saran:** pecah bertahap ke modul berdasarkan transaksi, inventori, shift, sinkronisasi, dan laporan; pisahkan API handler dari bootstrap server. Pertahankan kontrak data serta migrasi penyimpanan, ukur ukuran build.

## Urutan perbaikan berbiaya rendah

1. Sebelum produksi: hilangkan fallback static root; batasi backup per outlet; validasi transaksi di server; pastikan HTTPS dan proxy tepercaya.
2. Lindungi data: uji backup dan restore staging ujung-ke-ujung, serta pasang alert kegagalan backup dan kapasitas disk.
3. Ukur POS: uji katalog dan riwayat besar; catat ukuran snapshot serta waktu save/sinkron sebelum memilih optimasi.
4. Kurangi beban pemeliharaan: migrasi database bernomor; dokumentasikan deploy, rollback, rotasi secret, dan pemulihan perangkat.
5. Keamanan web: evaluasi sesi HttpOnly dan tambahkan CSP bertahap setelah cek kompatibilitas.
6. Dependensi: audit npm produksi saat ini bersih. Pertahankan lockfile dan lakukan pemindaian berkala; tidak perlu mengganti library hanya untuk mengurangi jumlah paket.

## Hal yang sudah baik

- Query SQL yang diperiksa umumnya memakai parameter.
- Password/PIN menggunakan PBKDF2 dengan salt dan perbandingan hash timingSafeEqual.
- Sesi memakai HMAC; sinkronisasi memeriksa role/outlet dan beberapa batas jenis event.
- Snapshot web memakai AES-GCM; penyimpanan native memakai SQLite terenkripsi.
- Ada rancangan backup dump, PITR, Restic offsite terenkripsi, dan restore terpisah.
- npm audit --omit=dev melaporkan 0 advisory dependensi produksi saat audit.

## Batas kepastian

Audit berbasis source dan konfigurasi yang tersedia. Folder ini tidak memiliki metadata Git, sehingga status tracking file dan riwayat perubahan tidak dapat dipastikan. Sebagian jalur transaksi runtime diuji pada database `.env` dengan rollback, tetapi seluruh jenis event, data lama, transaksi bersamaan, performa perangkat, konfigurasi TLS/proxy, login akun valid, dan keberhasilan backup/restore belum divalidasi. Android SDK dan `adb` tidak tersedia untuk membangun/menguji APK pada emulator atau perangkat. Role `pos_app_runtime` lulus pemeriksaan readiness; uji HTTP origin lokal pada instance aktif melewati validasi origin dengan kredensial tes yang sengaja tidak valid. Temuan P1 tetap perlu diverifikasi pada deployment sebenarnya sebelum rilis.

## Tindak lanjut implementasi

| Temuan | Status source/config | Verifikasi deployment |
|---|---|---|
| File source terekspos melalui fallback | Ditutup di source: static root `dist`, file statis allowlist, dotfile/path sensitif ditolak | Uji HTTP lokal pada port 4173 untuk `/server.mjs`, `/.env`, `/sync-handler.mjs`, dan `/db/schema.sql` semuanya menghasilkan 404; produksi tetap perlu diverifikasi setelah deployment. |
| Angka transaksi dipercaya dari klien | Validasi dan penguncian data transaksi ditambahkan; konflik harga historis ditolak; transaksi Kasir baru dibatasi diskon agregat 10% di server dan POS; field status pembayaran dibatasi ke string maksimal 40 karakter | Belum diuji dengan database dan alur POS nyata; diskon di atas batas harus dikirim lewat akun Admin yang terautentikasi server |
| Item penjualan ditulis dengan satu query database per item | Item transaksi baru ditulis satu batch SQL dari recordset JSON dalam transaksi yang sama; hasil jumlah baris diperiksa | Belum diuji dengan database aktif atau transaksi 500 item |
| Pembayaran transaksi ditulis satu query per pembayaran dan konflik ID dalam transaksi yang sama tidak memeriksa kolom identitas | Pembayaran baru ditulis satu batch SQL; ID hanya idempoten bila transaksi, metode, jumlah, referensi, dan waktu sama | Belum diuji dengan database aktif, pembayaran gabungan, atau ID lama yang bentrok |
| Pengurangan stok Kasir tidak terikat ke transaksi | Event stok Kasir harus merujuk transaksi dan baris item dengan kuantitas cocok; ID jurnal duplikat menggagalkan transaksi database | Belum diuji dengan database aktif atau beberapa perangkat bersamaan |
| ID pergerakan kas dapat berbenturan lintas outlet | Pembacaan gerakan kas memeriksa outlet shift; server menolak ID milik outlet lain dan payload berbeda pada ID yang sama | Belum diuji pada database dengan beberapa outlet/perangkat |
| Pembayaran piutang tidak terikat ke pembayaran transaksi | Event harus cocok dengan pembayaran tersimpan di sale dan outlet yang sama; konflik ID diterima hanya bila datanya identik | Belum diuji dengan database transaksi atau sinkronisasi offline |
| Event absensi menerima tanggal/waktu tidak valid atau benturan ID | Validasi kalender/timestamp diperketat; ID absensi dikunci ke outlet, pengguna, dan tanggal yang sama | Belum diuji pada database aktif atau sinkronisasi lintas perangkat |
| Audit log dapat memuat role palsu dan teks tak terbatas | Server menetapkan role/pengguna dari sesi, membatasi panjang dan waktu, serta menolak ID audit dengan isi berbeda | Belum diuji pada database aktif atau pemulihan outbox lama |
| UPSERT SKU/varian dapat mengubah entitas produk lain dan menulis satu query per varian | Server memeriksa benturan SKU/barcode dan kepemilikan ID varian; varian dan saldo awal stok ditulis per batch SQL, sedangkan harga, unit, stok, dan bentuk dasar katalog dibatasi sebelum menulis | Belum diuji dengan database aktif, impor katalog lama, atau 500 varian |
| Data pelanggan belum dibatasi dan UPSERT ID tidak mengunci outlet | Panjang/tipe data divalidasi; UPSERT hanya dapat memperbarui pelanggan pada outlet yang sama dan payload disimpan kanonis | Belum diuji pada database aktif atau data pelanggan lama |
| UPSERT shift memakai ID global tanpa syarat outlet saat konflik | Konflik ID shift kini hanya memperbarui baris dari outlet yang sama; konflik lintas outlet ditolak | Belum diuji dengan database aktif atau sinkronisasi bersamaan |
| Penghapusan produk dapat cocok dengan ID dan SKU sekaligus | Server menerima tepat satu identitas dan hanya menghapus satu produk aktif dari outlet sesi | Belum diuji pada database aktif atau event lama yang malformed |
| Nama varian dapat membuat item penjualan melebihi batas 80 karakter | Batas item diselaraskan dengan nama produk+varian; server menyimpan nama kanonis dari katalog memakai pemisah POS dan menolak hasil kanonis yang melewati batas | Belum diuji untuk katalog lama dengan nama varian panjang |
| Retry event sinkronisasi memakai ID sama dapat menyembunyikan payload yang berbeda | Konflik unik membaca event tersimpan dan hanya mengakui retry bila tipe, outlet, waktu (jika dikirim), serta payload kanonis sama; konflik berbeda memberi 409 `SYNC_EVENT_ID_CONFLICT`. POS mempertahankan outbox dan menahan retry otomatis sampai dicoba manual; pesannya tidak salah dilabeli sebagai konflik stok | Policy lulus uji unit payload sama/berubah; belum diuji dengan database aktif atau dua perangkat mengirim ID bentrok |
| Pemeriksaan ruang lingkup event sinkronisasi menelusuri objek payload secara rekursif dua kali dan batas satu event dapat dikalikan 100 event per request | Validasi outlet dan pengumpulan ID memakai satu traversal iteratif; batas 20.000 objek/2.000 ID per event dan 100.000 objek/10.000 referensi ID per request diterapkan di `sync-scope-policy.mjs` | Uji unit mencakup scope, ID, payload dalam, serta budget; belum diuji dengan payload besar melalui API aktif |
| Backup lintas outlet/token bersama | Endpoint memakai sesi dan outlet akun; enkripsi backup tidak memakai token printer | Belum diuji pada beberapa outlet/perangkat |
| Rate limit login di belakang proxy dapat dilewati dengan merotasi alamat atau identitas | Pembatasan kini berlaku per pasangan, per identitas lintas alamat (20/15 menit), dan per sumber lintas akun (120/15 menit); map dibatasi dan proxy hanya dipercaya jika dikonfigurasi | Perlu verifikasi header reverse proxy dan ambang jaringan toko ramai; penyimpanan limiter hanya di memori proses, sehingga multi-instance memerlukan store bersama |
| Waktu respons login dapat membedakan akun tanpa password dari akun aktif | Akun yang tidak memiliki password menjalankan PBKDF2 dummy dengan iterasi yang sama sebelum respons gagal | Belum diukur dengan timing jaringan pada deployment |
| Sesi localStorage dan CSP | Sesi cookie HttpOnly; script nonce, frame dan policy header ditambahkan; parser menolak token dengan segmen tambahan atau klaim sesi yang tidak valid | Interaksi halaman/perangkat belum diuji di browser |
| Snapshot penuh | Serialisasi, enkripsi, dan tulis digabung; kegagalan mempertahankan snapshot terbaru di memori dan menjadwalkan retry otomatis bertingkat. Diagnostik in-memory mengukur karakter snapshot, waktu serialisasi, enkripsi, tulis durable, jumlah sukses/gagal, backend, dan retry tanpa menyimpan data transaksi tambahan. Konfirmasi transaksi, refund, pembayaran piutang, pelunasan, void, penyesuaian stok, transfer stok, serta buka/tutup shift menunggu tulis lokal berhasil; aksi duplikat saat commit berjalan ditahan | Format snapshot penuh tetap; metrik harus diamati pada perangkat dan data nyata. Ketahanan saat aplikasi ditutup sebelum retry belum diukur |
| Pertumbuhan event | Penghapusan event otomatis dinonaktifkan sampai bootstrap snapshot tersedia | Event masih tumbuh; retensi aman belum selesai |
| DDL saat startup | Migrasi bernomor terpisah; server memeriksa role runtime tanpa superuser/CREATE/ownership, memeriksa tabel sync dan versi migrasi, mempertahankan liveness, dan mencoba ulang tiap 5 detik. Bootstrap lokal memisahkan password role migrasi `POS_ADMIN_PASSWORD` dari password superuser `POSTGRES_PASSWORD` | Migrasi 1–3 sudah diterapkan ke database `.env`; `pos_app_runtime` tidak punya hak elevated dan tidak lagi dapat menulis `schema_migrations`. `npm run db:status` lulus (schema 3). Compose/Docker tidak tersedia untuk bootstrap lokal |
| Backup hanya satu host | Profil Restic offsite tersedia; dump/base backup diverifikasi, file lokal dibatasi umask 077, dan loop backup menyediakan heartbeat healthcheck Compose | Perlu kredensial S3, Docker, dan uji restore terpisah; alert eksternal belum disambungkan |
| File POS/server besar | Script POS utama diekstrak dari HTML ke `pos.js`; helper murni POS, penyimpanan terenkripsi, laporan, dan format absensi dipisah ke modul; static delivery, pemeriksaan database, keamanan sesi, dashboard, dan handler sinkronisasi juga dipisahkan; event katalog, penjualan, kas, diskon, absensi, pembayaran piutang, stok, transfer, dan audit kini berada di modul domain tersendiri; implementasi provisioning lama yang tidak terjangkau dihapus; proses copy/allowlist/cache offline ikut diperbarui | Tampilan dan alur dipertahankan; `pos.js` dan domain tersisa di `sync-handler.mjs` masih perlu dipecah bertahap |
| Daftar jenis event sinkronisasi per role berduplikasi antara klien dan server | Role/event map kini berasal dari `sync-role-policy.mjs` yang dipakai POS dan handler server; file ikut dicopy, di-allowlist, dan diprecache untuk web, legacy, serta Android | Perlu uji API dan perangkat saat kelak ada perubahan kebijakan role; audit source memastikan dua jalur membaca modul yang sama |

Perubahan kode setelah audit:

- File statis hanya dilayani dari dist melalui allowlist path untuk halaman, shell legacy, PWA, dan aset build; implementasinya berada di `static-files.mjs`. Script utama POS dimuat dari `pos.js` eksternal same-origin; helper rupiah, tanggal, ID, dan escaping berada di `pos-utils.mjs`; penyimpanan terenkripsi, migrasi penyimpanan lama, antrean tulis, dan clear data berada di `pos-storage.mjs`. Kedua modul dipreload; proses copy legacy, allowlist, precache service worker, dan aset Android diperbarui. Nonce yang diberikan pada script POS juga dipakai pada script dokumen struk cetak. Server API memberi 503 untuk permintaan statis bila build belum tersedia; rute `/api/` yang tidak dikenal memberi JSON 404 dan tidak jatuh ke halaman SPA. Path URL dengan encoding rusak ditolak sebagai 400. HTML menerima CSP dengan nonce per respons, pembatasan frame, dan Permissions-Policy. Karena POS lama memakai atribut handler inline, CSP mengizinkan atribut handler melalui `script-src-attr`; elemen script tetap memerlukan nonce atau sumber same-origin.
- Jika koneksi, role runtime, atau skema database gagal saat startup, server tetap hidup untuk liveness; endpoint readiness melaporkan 503 dan API ditahan dengan 503. Hak role runtime dan versi skema diperiksa kembali paling lama tiap 5 detik saat ada request API/readiness, termasuk setelah server sudah siap; jika pemeriksaan gagal API langsung ditahan, dan pulih otomatis setelah konfigurasi siap.
- Sesi dashboard dan POS memakai cookie HttpOnly/SameSite; token sesi tidak lagi dikirim di body login atau disimpan dalam localStorage/snapshot. Request perubahan data memeriksa Origin.
- Parser cookie sesi memerlukan tepat dua segmen HMAC dan memvalidasi UUID subjek/outlet, role, nama, serta expiry sebelum menerima klaim.
- Login limiter membatasi percobaan per pasangan alamat-identitas, total identitas lintas alamat, dan total sumber lintas akun; semua map punya batas entri. `POS_TRUST_PROXY` hanya membaca header alamat/host proxy bila operator mengaktifkannya.
- Login akun tidak ditemukan atau belum memiliki password menjalankan PBKDF2 dummy 210.000 iterasi sebelum respons gagal, menyamakan pekerjaan kriptografi dengan verifikasi password akun aktif.
- Handler endpoint provisioning akun yang sudah dihentikan dengan respons 410 kini tidak lagi memuat implementasi lama yang tidak dapat dicapai setelah `return`.
- Aturan cookie sesi, validasi Origin, token printer, HMAC sesi, dan TOTP dipisahkan ke `auth-security.mjs`; server menginjeksi konfigurasi cookie/proxy ke modul tersebut.
- Penanganan sinkronisasi dipisahkan ke `sync-handler.mjs` dengan dependensi server diinjeksi; bersama pemisahan route dashboard, bootstrap HTTP utama kini sekitar 22 KB dan tidak lagi memuat query laporan atau logika sinkronisasi transaksi.
- Query dashboard dipisahkan ke `dashboard-handler.mjs`; route menjaga pemeriksaan sesi/role/outlet yang sama sebelum menjalankan query laporan.
- Sinkronisasi transaksi memeriksa aritmetika subtotal, diskon, total, pembayaran, kepemilikan katalog, dan harga historis yang tercatat di server. Nilai transaksi yang sudah tersimpan dikunci; konflik harga tetap berada di antrean lokal untuk ditinjau.
- Item transaksi baru dimasukkan ke `sale_items` melalui satu `jsonb_to_recordset` statement, menggantikan query per item; transaksi database tetap atomik dan jumlah baris hasil harus sama dengan jumlah item yang akan disimpan.
- Pembayaran baru dimasukkan dalam satu statement batch. Konflik ID hanya dapat memperbarui status/metadata pada pembayaran transaksi yang sama dengan metode, jumlah, referensi, dan waktu identik; konflik lain menyebabkan transaksi dibatalkan.
- Total diskon pada transaksi baru dari akun Kasir dibatasi server maksimal 10% dari subtotal; validasi POS menerapkan batas agregat yang sama supaya diskon item dan transaksi tidak dapat menumpuk melewati batas. Akun Admin tetap dapat membuat transaksi dengan diskon lebih besar. Persetujuan PIN Admin yang hanya diverifikasi pada perangkat Kasir tidak dianggap sebagai bukti otorisasi server.
- Pengurangan stok dari akun Kasir kini wajib merujuk transaksi lunas/piutang serta item dan kuantitas yang cocok; server menolak pemakaian ulang item transaksi, dan konflik ID gerakan stok menggagalkan seluruh sinkronisasi agar saldo tidak berubah tanpa jurnal. Antrean lokal lama ditautkan ke transaksi satu kali pada pembaruan POS.
- Batch sinkronisasi kini menolak ID event yang sama dua kali di dalam satu request; pengiriman ulang batch yang sama tetap idempoten terhadap event yang sudah tersimpan.
- Event kas memvalidasi waktu dan batas teks, mengunci pencarian ke shift/outlet, dan hanya menerima ulang ID bila nilai transaksi tidak berubah; benturan ID lintas outlet ditolak tanpa menyalin datanya ke event outlet peminta.
- Pembayaran piutang harus mencocokkan ID, sale, metode, jumlah, waktu, pelanggan, dan shift pada pembayaran transaksi yang tersimpan; timestamp dari hasil query PostgreSQL dibandingkan tanpa kehilangan milidetik. ID receivable yang sudah ada hanya idempoten bila semua kolom sama.
- Event absensi memeriksa tanggal kalender yang benar, menolak waktu masuk/pulang lebih dari lima menit ke depan, dan menolak ID yang sudah dimiliki absensi pengguna/outlet/tanggal lain.
- Audit log sinkron menulis pengguna dan role dari sesi server, membatasi action/detail serta timestamp, dan hanya menerima ulang ID bila isinya cocok.
- UPSERT produk/varian menolak SKU atau barcode yang sudah terikat ke ID lain dan memeriksa varian tetap milik produk induk yang sama sebelum memperbarui katalog.
- UPSERT katalog memasukkan/memperbarui seluruh varian dalam satu `jsonb_to_recordset` statement dan saldo stok awal dalam satu statement batch, mengurangi query berulang untuk produk besar sambil mempertahankan konflik kepemilikan serta `DO NOTHING` pada saldo yang sudah ada.
- Payload katalog membatasi harga Rupiah ke integer aman, stok/minimum stok ke nilai non-negatif presisi tiga desimal, serta unit/field teks ke panjang yang wajar.
- Nama item penjualan dikanonisasi dari nama produk/varian pada katalog historis; batas payload mendukung gabungan nama produk 80 karakter, pemisah POS yang ada, dan varian 120 karakter. Nama dari katalog lama yang melampaui batas ditolak agar data transaksi tidak menyimpan label di luar batas.
- UPSERT pelanggan membatasi nama/telepon/email, membersihkan spasi, dan menolak konflik ID lintas outlet.
- UPSERT shift membatasi konflik ID ke outlet asal, sehingga ID shift tidak dapat menimpa catatan shift outlet lain saat ada konkurensi.
- Penghapusan produk memvalidasi satu kunci (ID atau SKU), membatasi pencarian ke outlet sesi, dan memerlukan tepat satu baris aktif.
- Arsip WAL kini hanya menerima nama segmen heksadesimal 24 karakter atau nama timeline 8 karakter berakhiran `.history`, serta menolak argumen/file sumber tidak valid. Dump harian diverifikasi checksum dan dapat dibaca `pg_restore` kembali setelah dipublikasikan sebelum marker sukses diperbarui.
- Skrip dump dan base backup PITR menetapkan `umask 077` agar dump, checksum, isi base backup, dan marker lokal baru tidak dibuat dengan izin baca untuk pengguna lain.
- Identitas kasir untuk transaksi yang sudah tercatat dikunci ke nilai server; payload event disimpan kembali dalam bentuk kanonis. Cursor pull divalidasi sebagai bilangan bulat aman non-negatif sebelum dipakai dalam query.
- Backup aplikasi dibatasi ke Pemilik/Admin dan outlet akun; POS_API_TOKEN hanya dipakai layanan printer. Fungsi enkripsi backup lama yang memakai token API dihapus.
- Loop dump, base backup PITR, dan Restic menandai waktu sukses; healthcheck Compose mendeteksi lebih dari 26 jam tanpa sukses. Status Docker perlu dipantau/di-alert oleh operator.
- Migrasi schema dipisahkan dari startup. Baseline menggunakan db/schema.sql; migrasi berikutnya berada di db/migrations. Role runtime pos_app tidak memiliki DDL; pos_admin memiliki database dan objek aplikasi tanpa hak superuser setelah bootstrap. Maintenance menghapus backup aplikasi berusia 90 hari. Penghapusan event sinkronisasi otomatis dinonaktifkan sampai API bootstrap snapshot siap.
- Server memeriksa flag superuser/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, kepemilikan database/objek, privilege CREATE, dan role lain yang dapat diaktifkan melalui keanggotaan role oleh akun `DATABASE_URL`; readiness gagal tertutup jika role runtime terlalu luas. Pemeriksaan `SET ROLE` menyesuaikan versi PostgreSQL (PG16+, atau keanggotaan pada versi lebih lama).
- `npm run db:status` menjalankan pemeriksaan read-only yang sama dan memberi alasan aman untuk status role/skema tanpa mencetak connection string atau secret.
- Pemeriksaan database 16 November 2026: migrasi 1 dan 2 diterapkan; `DATABASE_URL` menggunakan role terbatas `pos_app_runtime`, dan `npm run db:status` lulus pada schema 2. Role admin lama yang kredensialnya bocor belum dicabut oleh operator. Migrasi berikutnya tetap memerlukan URL/role migrasi terpisah; jangan memakai role runtime untuk DDL.
- Penulisan snapshot terenkripsi menunda serialisasi ke antrean microtask dan menggabungkan perubahan yang berdekatan; saat ada tulis berjalan, hanya snapshot state terbaru yang menunggu untuk ditulis.
- Saat penulisan snapshot gagal, snapshot terakhir tidak lagi dibuang dari antrean memori; error tetap terlihat melalui status penyimpanan, dan pemanggilan save berikutnya mencoba snapshot terbaru lagi.
- Transaksi Kasir, refund, pembayaran piutang, pelunasan, void, penyesuaian stok, dan transfer stok menunggu commit snapshot terenkripsi sebelum menampilkan konfirmasi sukses; aksi duplikat untuk operasi yang sama diabaikan saat commit berjalan. Untuk transaksi Kasir, struk juga menunggu commit. Kegagalan tulis menampilkan pesan bahwa perubahan belum tersimpan lokal sambil mempertahankan retry otomatis. Ini menutup celah konfirmasi sukses sebelum IndexedDB/SQLite menyelesaikan tulis.
- Buka/tutup shift menunggu snapshot lokal sebelum dikirim atau dikonfirmasi offline. Jika respons server tidak memastikan hasil, perubahan dan event lokal dipertahankan untuk retry idempoten; penolakan klien yang pasti membatalkan perubahan dan menyimpan rollback lokal.
- Bootstrap PostgreSQL lokal memakai password `pos_app`, `pos_admin`, dan superuser yang berbeda. Script menolak konfigurasi password yang sama; Compose menyediakan variabel admin tersendiri. README dan `.env.example` menjelaskan URL migrasi dengan password role admin. Volume lama memerlukan pengisian password dan URL baru sebelum menjalankan ulang bootstrap.
- Laporan utama kini membentuk daftar tabel dan menghitung omzet dalam satu traversal; perhitungan item/laba lama yang selalu ditimpa ringkasan tambahan dihapus. Ringkasan tambahan menyaring data untuk grafik dan ringkasan produk; metode pembayaran, produk terlaris, kategori, dan kasir diagregasi dalam satu loop. Kategori produk memakai indeks, menghindari pencarian katalog berulang untuk setiap item. Elemen DOM dan markup tetap sama. `pos.js` lolos pemeriksaan sintaks; `npm run cap:sync` berhasil membangun web serta menyinkronkan aset Android.
- Penyelesaian pembayaran dan pengembalian stok kini membangun indeks produk sekali per operasi; proses tidak lagi mencari ulang seluruh katalog untuk setiap item transaksi.
- Script penyalinan legacy kini mewajibkan semua shell dan modul POS sumber tersedia; `favicon.ico` dikecualikan dari daftar itu karena disalin dari `assets/branding`. Build tidak lagi diam-diam melanjutkan saat file sumber wajib hilang.
- Dekoder ikon produk membatasi gambar hingga 16 megapiksel sebelum canvas dibuat, selain batas ukuran file dan dimensi sisi yang sudah ada, untuk mengurangi risiko lonjakan RAM dari file gambar terkompresi.
- `README.md` kini meminta password unik untuk role superuser, migrasi, aplikasi, dan backup serta menjelaskan pemetaan password ke kedua URL database. `npm audit --omit=dev` terbaru melaporkan 0 kerentanan.
- Endpoint POST sinkronisasi kini menolak event bukan objek, payload array, ID event non-UUID, dan timestamp tak valid/panjang sebelum menulis event ke database; `sync-handler.mjs` lolos pemeriksaan sintaks.
- Pemeriksaan payload sinkronisasi kini menelusuri struktur secara iteratif satu kali, membatasi 20.000 objek serta 2.000 ID entitas per event, memvalidasi outlet/stock map, dan mengumpulkan ID entitas dalam traversal yang sama; payload terlalu kompleks mendapat 400 tanpa rekursi dalam atau query outlet lintas data terlalu besar.
- Parser body server kini mengubah JSON rusak, payload kosong, array, dan nilai primitif menjadi respons 400 terkontrol; hal ini menghindari 500 dan stack log untuk input klien yang tidak valid. `server.mjs` lolos pemeriksaan sintaks.
- Pemeriksaan Origin untuk perubahan data kini membandingkan origin lengkap (protokol, host, dan port). Saat `POS_TRUST_PROXY=true`, skema dan host menggunakan `X-Forwarded-Proto`/`X-Forwarded-Host`; README mensyaratkan proxy tepercaya menimpa header tersebut. `auth-security.mjs` lolos pemeriksaan sintaks.
- Policy transaksi kini membatasi nama/SKU/catatan item, ID dan metadata pembayaran, timestamp, serta konsistensi jumlah tunai/kembalian. Handler sinkronisasi turut memvalidasi ID UUID, waktu, metode, referensi, alasan, dan panjang nama penyetuju refund sebelum query penulisan. `sale-policy.mjs` dan `sync-handler.mjs` lolos pemeriksaan sintaks.
- Script migrasi kini hanya menerima `POS_MIGRATION_DATABASE_URL` dan berhenti dengan pesan yang jelas bila tidak disetel; DDL tidak lagi dapat fallback ke kredensial runtime `DATABASE_URL`. README menjelaskan pemisahan tersebut.
- Nomor transaksi kini menggunakan UUID transaksi penuh sebagai akhiran, menghilangkan akhiran 3 karakter `Math.random()` yang dapat bertabrakan; nomor dan waktu transaksi memakai timestamp yang sama. `pos.js` lolos pemeriksaan sintaks dan aset web/Android berhasil dibangun ulang lewat `npm run cap:sync`.
- Snapshot lokal yang gagal ditulis kini mencoba ulang otomatis dengan jeda 1, 3, 10, 30, lalu 60 detik (jeda maksimum berulang 60 detik); snapshot terbaru tetap menggantikan antrean lama. Status kegagalan lokal dipulihkan saat retry berhasil, dan penghapusan data membatalkan retry tertunda agar tidak menulis kembali data yang dihapus.
- Service worker v22 kini memperlakukan `.mjs` seperti modul `.js` dengan strategi network-first dan fallback cache, sehingga helper POS/storage yang berubah dapat diperbarui setelah online dan tetap dapat dipakai offline. Pemeriksaan sintaks `pos-storage.mjs`, `pos.js`, `sw.js` dan `npm run cap:sync` berhasil; aset web/Android dibangun ulang.
- Sinkronisasi transaksi kini menolak ID pembayaran/refund duplikat dan konflik dengan transaksi lain; UPSERT pembayaran membatasi konflik ke transaksi yang sama, dan insert refund menangani konflik unik tanpa menimpa data transaksi lain. Ini menutup jalur perubahan nilai pembayaran melalui ID yang dipasok klien. `sync-handler.mjs` lolos pemeriksaan sintaks; validasi database runtime belum dilakukan.
- Helper laporan untuk kunci tanggal/bulan, agregasi tren penjualan, dan SVG grafik dipisahkan dari `pos.js` ke `report-utils.mjs`; markup dan perilaku tampilan tetap sama. Modul disertakan pada salinan web/legacy, allowlist static server, cache offline service worker, serta aset Android. Pemeriksaan sintaks `pos.js`, `report-utils.mjs`, `scripts/copy-legacy.mjs`, `static-files.mjs`, dan `sw.js` berhasil; `npm run cap:sync` berhasil.
- `pos-storage.mjs` kini mengukur jumlah karakter snapshot serta waktu serialisasi, enkripsi, dan tulis durable; jumlah tulis sukses/gagal, backend, serta retry tersedia melalui `window.PosLocalStorage.getWriteDiagnostics()` hanya di memori. Tidak ada data penjualan yang masuk ke metrik atau log. README menjelaskan cara mengamati ukuran dan latensi pada perangkat nyata; format snapshot dan UI tidak berubah.
- Peta izin jenis event untuk sinkronisasi POS/server dipusatkan di `sync-role-policy.mjs`; `sync-policy.js` dan `sync-handler.mjs` mengimpor definisi role yang sama. Modul baru masuk allowlist server, proses copy legacy, dan precache root/legacy agar aturan izin tetap tersedia saat offline.
- Traversal pembatasan outlet dan pengumpulan UUID entitas dipindah dari handler utama ke `sync-scope-policy.mjs`; satu traversal iteratif memakai batas 20.000 objek/2.000 ID per event dan anggaran agregat 100.000 objek/10.000 referensi ID per request, tanpa mengubah query kepemilikan entitas. Nilai outlet kosong non-null kini juga ditolak.
- Retry ID event sinkronisasi kini dibandingkan dengan row tersimpan melalui `sync-event-policy.mjs`; ID yang sama hanya diakui bila tipe, outlet, payload kanonis, dan timestamp yang dikirim cocok. Konflik payload tidak lagi dianggap sukses dan tidak menimpa row lama.
- POS mempertahankan event lokal saat server memberi `SYNC_EVENT_ID_CONFLICT`, menghentikan retry otomatis sampai ada sinkronisasi manual, dan tidak lagi melabeli konflik tersebut sebagai konflik stok; pesan server menjelaskan konflik ID.
- `database-policy.mjs` kini memeriksa tabel sinkronisasi yang wajib dan mengumpulkan blocker role, tabel, serta versi migrasi sekaligus. `npm run db:status` tetap aman/read-only tetapi kini menampilkan seluruh penghalang yang terdeteksi, bukan berhenti setelah blocker role pertama.
- `scripts/sync-hardening.test.mjs` menguji traversal outlet/batas payload dan idempotensi event kanonis; suite aplikasi sekarang lulus 28/28 termasuk helper absensi.
- Helper format tanggal/waktu dan lokasi absensi dipindah ke `attendance-utils.mjs`; markup yang ada dipertahankan. Modul disalin dan di-cache untuk web/legacy/Android. Tes helper dan policy pembayaran kini membuat suite lulus 30/30.
- Policy transaksi kini menolak `payment.status` non-string atau di atas 40 karakter sebelum nilai disimpan ke PostgreSQL; field legacy yang tidak dikirim tetap memakai fallback sebelumnya. Tes policy transaksi ditambahkan.
- Validasi same-origin memeriksa protokol koneksi aktual (socket langsung atau header proxy tepercaya), terpisah dari flag `Secure` cookie. Ini mencegah login melalui HTTP lokal ditolak hanya karena cookie sesi tetap `Secure`; pengujian mencakup HTTP localhost, HTTPS langsung, dan reverse proxy tepercaya.
- String mojibake yang tersisa dinormalisasi di sumber dan salinan build web/legacy/Android; pola minus, elipsis, dash, tanda kali, dan centang kini menjadi simbol Unicode yang benar. Pemindaian teks proyek tidak menemukan lagi pola encoding rusak atau karakter pengganti.
- Event katalog, penjualan, kas, diskon, absensi, pembayaran piutang, stok, transfer, audit, dan shift dipisah ke modul domain; `sync-handler.mjs` kini sekitar 185 baris. Tes domain memeriksa payload tidak valid sebelum query database.

- Parser CSV produk dipindah dari pos.js ke pos-utils.mjs tanpa mengubah aturan parsing; tiga tes mencakup kutip/koma, baris baru, CRLF, baris kosong, dan kolom kosong akhir. Pemeriksaan sintaks, npm test (46/46), serta npm run cap:sync berhasil.

- Perintah npm run db:smoke memakai DATABASE_URL untuk melewati handler POST audit.append dengan akun Kasir aktif; Kasir mengirim event shift.upsert (bila belum ada shift aktif), audit.append, attendance.upsert, cash.upsert, sale.upsert/retry, receivable.payment, discount.request/cancel, dan stock.delta; Pemilik lalu menyetujui kas keluar serta permintaan diskon. Dua request persetujuan dijalankan dalam transaksi yang sama setelah batch Kasir; sebelum rollback, smoke test memastikan status kas/diskon berubah sesuai keputusan, pembayaran piutang dan empat penjualan tersimpan, serta saldo stok turun satu unit. Request kosong ketiga memicu rollback; pemeriksaan setelahnya memastikan semua row uji hilang dan saldo stok fixture kembali sama. Eksekusi berhasil.

- Parser CSV sekarang menghapus BOM UTF-8 awal yang ditambahkan ekspor aplikasi; tes memastikan header CSV ekspor dapat dibaca kembali tanpa karakter tambahan. npm test lulus 47/47 dan npm run cap:sync berhasil memperbarui build web/Android.

- Uji database berulang menemukan Date.parse() pada objek Date hasil query PostgreSQL menghilangkan milidetik. Helper timestampMs mempertahankan epoch milidetik dan kini dipakai pada perbandingan event idempoten, pembayaran piutang, pembayaran/penjualan lama, kas, serta audit; smoke test membuktikan pembayaran piutang dan retry transaksi dengan timestamp ber-milidetik berhasil.

- Delapan skrip backup/migrasi shell di db/*.sh lolos pemeriksaan sintaks bash -n melalui Git Bash. Runtime Docker, PostgreSQL CLI, Restic, dan ShellCheck tetap tidak tersedia; backup/restore ujung-ke-ujung belum dapat diuji dari workspace.

- Query GET sinkronisasi kini memakai predicate outlet-spesifik tanpa kondisi OR opsional, sehingga planner dapat memilih indeks outlet/cursor saat distribusi data mendukungnya. Smoke test database juga memverifikasi route pull setelah rollback. EXPLAIN di database saat ini (satu outlet) masih memilih primary-key scan yang wajar untuk distribusi tersebut; manfaat multi-outlet belum terukur.

Pemeriksaan terbaru (16 November 2026): package.json dan README.md menyediakan perintah npm test; eksekusi npm test lulus 49/49. Perintah npm run db:smoke menguji alur Kasir dan persetujuan Pemilik untuk shift, audit, absensi, kas, penjualan/retry, pembayaran piutang, permintaan/persetujuan/pembatalan diskon, dan stok; dua request persetujuan dijalankan pada transaksi DB yang sama; efeknya diperiksa sebelum rollback, lalu seluruh residu dan perubahan saldo diverifikasi hilang. `node --test scripts/*.test.mjs` lulus 49/49, termasuk pengujian parser CSV, presisi timestamp PostgreSQL, origin login, dan handler domain sinkronisasi. `npm run db:status` melaporkan ready (schema 2). Uji POST login dengan origin HTTP lokal dan kredensial palsu pada instance aktif port 4173 melewati validasi origin lalu menjawab 401 kredensial tidak sesuai. Pemindaian seluruh file teks proyek tidak menemukan pola mojibake; pemindaian read-only database .env juga tidak menemukan pola tersebut pada 57 kolom teks/JSON di 19 tabel. Aset browser dapat tertahan di cache service worker lama, jadi cache dinaikkan dari v22 ke v23. npm run cap:sync berhasil membangun ulang web dan menyalin aset Android; pemindaian ulang source serta aset build menghasilkan 0 temuan. Uji transaksi tulis role `pos_app_runtime` ke `sync_events` dan `sync_devices` berhasil di-rollback; pemeriksaan memastikan tidak ada row tersisa. Smoke test integrasi `createSyncHandler` setelah pemisahan modul menerima event `audit.append` dengan HTTP 200, lalu rollback dan memastikan `sync_events` tidak memiliki row uji. Uji serupa untuk `stock.delta` Admin mengembalikan HTTP 200, di-rollback, dan memastikan event/jurnal uji tidak tersisa; saldo produk yang sudah ada dipertahankan. `npm run cap:sync` berhasil membangun web serta menyinkronkan aset Android (entry bundle 259.19 kB, gzip 79.61 kB). `node --check` berhasil pada modul aplikasi/server dan script yang tercantum pada pemeriksaan awal serta handler domain sinkronisasi; `npx tsc --noEmit` berhasil. `npm audit --omit=dev` melaporkan 0 kerentanan; `docker-compose.yml` berhasil diparse sebagai YAML. Atas instruksi pengguna, migrasi bernomor 1 (baseline) dan 2 (`002_sync_retention.sql`) diterapkan ke database dari `.env`; tabel `schema_migrations` mengonfirmasi versi `[1,2]`. Migrator menjalankan setiap migrasi dalam transaksi; `DATABASE_URL` di `.env` kini menunjuk role baru `pos_app_runtime` dengan password acak, bukan role admin lama. `pg_dump`, `pg_restore`, dan Docker tidak tersedia, sehingga backup pra-migrasi tidak dapat dibuat dari workspace ini. `npm run db:status` lulus pada schema 2; `/api/health` pada instance aktif menjawab HTTP 200 `ready`. Pemeriksaan kode juga menemukan escape Unicode mojibake tersembunyi pada nama item produk-varian (`\u00c2\u00b7`); sudah dikoreksi menjadi pemisah `\u00b7`, suite lulus 43/43, dan pemindaian escape rusak tidak menemukan pola serupa lain.

Uji database tambahan memakai `createSyncHandler` terhadap database `.env`: batch produk + penjualan + pembayaran diterima (HTTP 200, dua event) dan melewati jalur pembaruan saldo stok; transaksi handler dialihkan menjadi rollback. Pemeriksaan pasca-rollback memastikan row uji pada `sync_events`, `products`, `sales`, `payments`, dan `stock_balances` semuanya nol. Retry dengan ID/payload event identik diterima (HTTP 200); payload berbeda untuk ID yang sama menghasilkan `409 SYNC_EVENT_ID_CONFLICT`. Kedua skenario idempotensi juga di-rollback dan diverifikasi tidak menyisakan event. Ini membuktikan alur sempit tersebut pada skema aktif, bukan semua event, data lama, beban bersamaan, atau perilaku browser/perangkat. Uji restore dan backup tetap belum dilakukan.

Langkah operasional yang belum dapat dibuktikan dari workspace ini:

- Migrasi database eksternal sudah dijalankan sesuai instruksi pengguna dan mencatat versi 1 serta 2. Tidak tersedia `pg_dump`, `pg_restore`, atau Docker untuk membuat backup pra-migrasi dari workspace; pastikan penyedia memiliki backup/PITR dan uji pemulihan sebelum operasi migrasi berikutnya.
- Role runtime terbatas `pos_app_runtime` kini dipakai `.env`; readiness lokal lulus. Cabut role/login lama `postgres` yang kredensialnya bocor di penyedia database, setelah memastikan akses administrasi/migrasi alternatif tersedia. Jangan menyalin kredensial ke laporan.
- Backup offsite tetap memerlukan repository S3-compatible dan kredensial yang disimpan operator di .env. Uji restore staging sebelum produksi; tidak ada kredensial/provider yang disediakan untuk mengaktifkannya.
- Script utama sudah dipisahkan dari HTML, dan helper laporan/tanggal/grafik mulai dipindahkan ke `report-utils.mjs`; `pos.js` dan `sync-handler.mjs` masih berukuran besar sehingga pemisahan domain/API perlu dilanjutkan bertahap dengan pemeriksaan kompatibilitas sebelum tiap rilis. Tampilan dan alur yang sudah ada sengaja tidak diubah. Snapshot masih menyimpan keseluruhan state sehingga manfaat optimasi tulis masih perlu diukur pada data besar.
- Perangkat baru setelah event lama dibersihkan, perangkat yang melewati retensi, atau perangkat yang mengembalikan cursor lama membutuhkan bootstrap/pemulihan administrator. Sinkronisasi saat ini menolak kondisi tersebut agar tidak menerapkan data parsial; alur bootstrap lengkap masih perlu dibuat dan diuji sebelum penghapusan event diaktifkan pada deployment.

Pemeriksaan lanjutan (16 November 2026): `npm test` kembali lulus 49/49; `npm run db:status` menyatakan `ready (schema 2)`; `npm run db:smoke` menerima alur transaksi yang dicakup dan me-rollback seluruh data uji; `npm audit --omit=dev` melaporkan 0 kerentanan; `npx tsc --noEmit` berhasil. Pemindaian berbasis codepoint membaca 211 file teks di workspace dan tidak menemukan karakter mojibake tersangka. Pemindaian baca-saja database .env pada 57 kolom teks/JSON di 19 tabel public juga tidak menemukan nilai yang mengandung karakter mojibake tersangka.

Persiapan outbox juga melewati entri lokal null/non-objek tanpa menghapusnya atau menghentikan event valid; tes unit mencakup kasus ini.

Penanganan transfer ditingkatkan: `prepareSyncOutbox` kini menunda event `transfer.upsert` lintas outlet dan delta stok sumber/penerima yang cocok, tetap menyimpan event lokal, serta mengizinkan event lain dalam outlet yang sama untuk dikirim. Tes unit mencakup sisi sumber dan tujuan; suite lulus 52/52 dan `npm run cap:sync` membangun web serta menyinkronkan aset Android. Ini mencegah satu transfer yang belum didukung menggagalkan batch lain, tetapi tidak membuat transfer lintas outlet tersinkron; statusnya tetap menunggu dukungan otorisasi dan transaksi atomik.

Cache service worker dinaikkan dari v23 ke v24 agar browser mengambil helper outbox yang baru; source, `dist`, dan aset web Android memuat versi v24 setelah `npm run cap:sync`.

Bootstrap sinkronisasi kini memakai `collectPendingStockDeltas` dari `sync-policy.js`, yang melewati entri outbox null/non-objek serta delta non-finite tanpa menghapus data, sehingga bootstrap Admin tidak gagal sebelum filter outbox berjalan. Tes unit baru memeriksa agregasi dan payload rusak; suite lulus 53/53, `npm run cap:sync` berhasil, dan cache service worker dinaikkan ke v25 pada source/build/aset Android.

Pemeriksaan awal grant runtime menemukan `pos_app_runtime` dapat menulis `schema_migrations`; `db/init-app-role.sh` sudah mencabut grant tersebut dari `pos_app` pada bootstrap, dan migrasi 003 disiapkan untuk role lama maupun baru. Migrasi 003 kemudian diterapkan ke database `.env` menggunakan credential operator yang tersedia di `.env`; credential maupun URL tidak dicetak. Verifikasi sesudahnya memastikan versi schema 3. Credential operator lama tetap perlu dicabut oleh operator setelah akses administrasi/migrasi alternatif disiapkan.

`npm run db:status` memeriksa grant INSERT/UPDATE/DELETE runtime ke `schema_migrations`. Sebelum migrasi 003, pemeriksaan mendeteksi `runtime_can_write_schema_migrations`; sesudah migrasi tersebut, grant hilang dan readiness lulus pada schema 3. Ambang readiness server dan `db:status` mewajibkan schema 3. Jika grant tulis muncul kembali atau pemeriksaan grant gagal, readiness kini memblokir API.

Template `.env.example` dilengkapi `PGSSLMODE` opsional untuk koneksi PostgreSQL terkelola yang mewajibkan TLS; nilai default kosong mempertahankan koneksi local Docker tanpa TLS.

Perhitungan kas harapan shift dipisah dari `pos.js` ke `shift-utils.mjs` dengan perilaku yang sama untuk status penjualan, shift pembayaran, dan gerakan kas. Modul didaftarkan di proses copy legacy, allowlist static server, dan precache service worker v26, lalu tersalin ke aset web/Android. Tes mencakup pembayaran lintas shift, status yang dikecualikan, dan gerakan kas; suite lulus 56/56.

Filter periode laporan `dateWithin` dipindah dari `pos.js` ke `report-utils.mjs` sebagai `dateWithinReportPeriod` dengan tanggal `now` yang dapat diinjeksi untuk tes deterministik. Tes mencakup batas hari lokal, minggu enam hari, bulan berjalan, dan periode semua data; suite lulus 59/59. Build web/Android berhasil dan cache service worker dinaikkan ke v27.

Perhitungan subtotal, diskon item/transaksi, service, dan total keranjang dipindah tanpa perubahan rumus ke `cart-utils.mjs`; UI dan urutan pembulatan dipertahankan. Tes mengunci perhitungan harga, batas diskon, pembulatan, dan total minimum nol. Modul ikut copy legacy, allowlist static server, precache service worker v28, dan aset Android. `npm test` lulus 62/62; `npm run cap:sync` berhasil.

Filter periode hari dan minggu pada laporan kini memakai batas tanggal kalender lokal, sehingga tidak bergeser satu jam saat zona waktu melewati DST. Tes baru menjalankan skenario `America/New_York` pada awal DST; UI dan aturan periode yang ada tetap dipertahankan. Service worker dinaikkan ke v29 agar aset offline mengambil helper terbaru.

Verifikasi terbaru: `npm test` lulus 64/64; `npm run cap:sync` berhasil dan helper laporan di source, `dist`, serta aset Android memiliki hash yang sama. `npm run db:status` menyatakan ready (schema 3) tanpa warning. `npm run db:smoke` setelah migrasi menerima skenario transaksi Kasir/Pemilik yang dicakup, me-rollback seluruh row uji, dan memastikan saldo stok awal kembali sama. Migrasi 003 sudah diterapkan; credential operator yang tersedia masih harus dicabut oleh operator.

Pemeriksaan ulang mojibake membaca 181 file teks source, dokumentasi, build web, dan aset Android; tidak ditemukan `Â`, `Ã`, rangkaian `â€`/`âˆ`, `ï¿½`, atau karakter replacement U+FFFD.

Pemeriksaan terbaru terhadap database memastikan `schema_migrations` versi 3 dan role runtime tidak memiliki INSERT/UPDATE/DELETE pada tabel tersebut. `npm run db:status` lulus (schema 3), `npm audit --omit=dev` melaporkan 0 kerentanan, dan `npm test` lulus 64/64.

Readiness tidak lagi menganggap privilege tulis `schema_migrations` sebagai warning: grant tersebut dan kegagalan membaca privilege menjadi blocker. Tes mencakup kedua kondisi; `npm test` lulus 64/64 dan `npm run db:status` pada database schema 3 tetap ready tanpa warning.

Pemeriksaan alat operasional terbaru: `docker`, `restic`, `pg_dump`, `pg_restore`, `pg_verifybackup`, dan `adb` tidak tersedia. Variabel repository/password Restic serta access key S3 offsite juga belum dikonfigurasi pada `.env`. Karena itu backup offsite dan pemulihan staging belum dapat dijalankan dari workspace; tidak ada nilai secret yang dicetak atau ditambahkan ke laporan.

Fallback pembuat ID POS tidak lagi menggunakan `Math.random()` ketika `crypto.randomUUID()` tidak tersedia. Fallback memakai `crypto.getRandomValues()` dan membentuk UUID v4; tes memeriksa format/bit versi serta ID yang berbeda. Service worker dinaikkan ke v30 agar helper offline diperbarui.

Verifikasi fallback ID: `npm test` lulus 66/66 dan `npm run cap:sync` berhasil. Hash SHA-256 `pos-utils.mjs` sama di source, `public`, `dist`, dan aset Android; service worker v30 tersalin pada source/build/web Android.

Pemeriksaan konfigurasi production awal menemukan koneksi database `.env` tidak memakai TLS (`pg_stat_ssl.ssl=false`). Uji TLS dengan validasi sertifikat sistem gagal pada chain CA Supabase; saat itu sertifikat root CA project belum tersedia di workspace. Kode server dan skrip migrasi/status/maintenance/smoke kini mendukung `PGSSLMODE=verify-full` (serta alias `require`) dengan verifikasi sertifikat dan `PGSSLROOTCERT` untuk CA PEM provider. Jangan set `rejectUnauthorized=false`.

Tes konfigurasi PostgreSQL mencakup mode lokal tanpa TLS, verifikasi TLS, pemuatan CA PEM, dan penolakan mode/sertifikat yang tidak valid. Semua titik koneksi Node (`server`, migrasi, status, maintenance, dan smoke) kini memakai helper konfigurasi yang sama; `npm test` lulus 71/71. Sebelum CA tersedia, koneksi database tetap memakai konfigurasi sebelumnya; setelah CA hadir, TLS diverifikasi dan diaktifkan seperti dicatat berikutnya.

Setelah pengguna menyediakan `prod-ca-2021.crt`, preflight koneksi menunjukkan socket klien PostgreSQL terenkripsi dan sertifikat terotorisasi. `.env` kini memakai `PGSSLMODE=verify-full` dan `PGSSLROOTCERT=prod-ca-2021.crt`; `npm run db:status` lulus pada schema 3, `npm test` lulus 71/71, dan `npm run db:smoke` melalui TLS menerima alur transaksi yang dicakup serta me-rollback seluruh data uji.

Instance sementara dengan source/config terbaru di port 4174 menjawab readiness `ready` dan `database=ok` dengan TLS aktif, lalu dihentikan. Listener lama port 4173 dibuat sebelum `.env` diperbarui sehingga masih perlu restart untuk memakai TLS. Restart otomatis proses lama ditolak oleh kebijakan eksekusi; tidak ada proses lama yang dihentikan. Jalankan ulang server utama sebelum menganggap koneksi aktifnya sudah terenkripsi.

`npm run db:status` kini melaporkan status TLS dari socket client PostgreSQL agar tidak salah menyimpulkan dari sisi backend pooler. Output terbaru: `ready (schema 3); tls=verified`; tes unit mencakup socket TLS verified, unverified, dan disabled. Suite lulus 72/72.

Endpoint `/api/health` kini melaporkan `checks.databaseTls` dari socket klien aktif, sehingga monitor dapat mendeteksi proses lama yang masih berkomunikasi tanpa TLS. `/api/health/live` tetap hanya memeriksa proses dan tidak membuat koneksi database.

Verifikasi instance terbaru di port 4174 menghasilkan `/api/health`: `ready`, `database=ok`, `databaseTls=verified`; server sementara dihentikan setelah pemeriksaan. Suite aplikasi lulus 72/72 dan `npm run db:status` melaporkan `ready (schema 3); tls=verified`.

Keterbatasan sinkronisasi transfer lintas outlet: `pos.js` membuat `transfer.upsert` dengan outlet sumber dan membuat dua event `stock.delta` untuk sumber serta tujuan. `sync-handler.mjs` mengikat seluruh event POST ke outlet sesi, sementara `sync-scope-policy.mjs` menolak referensi `from`/`to` yang tidak sama dengan outlet tersebut. Dengan demikian, transfer lintas outlet tidak dapat disinkronkan melalui kontrak keamanan saat ini. Karena server memproses satu batch dalam satu transaksi, satu event transfer yang ditolak juga me-rollback event lain yang berada dalam batch hingga lima event; outbox lokal dipertahankan. Skema saat ini tidak memiliki organisasi/tenant yang mengelompokkan outlet, dan sesi pengguna hanya memuat satu `outlet_id`; pemeriksaan terhadap dua outlet belum dapat mengidentifikasi apakah keduanya dimiliki akun/tenant yang sama. Jangan melonggarkan pemeriksaan ini saja: dukungan transfer memerlukan model kepemilikan outlet/membership, otorisasi eksplisit untuk kedua endpoint, dan operasi stok atomik di server. Alur UI transfer tetap perlu diuji/dirancang ulang bersama kebijakan otorisasi tersebut sebelum dianggap didukung.


