# Audit FastQ POS

Tanggal audit: 25 November 2026
Cakupan: kecepatan sinkron, impor produk via Excel, tombol yang tidak mengikuti status, dan aturan tampilan tanpa dot serta badge.

## Cara membaca dokumen ini

Audit ini hasil membaca kode dari FastQ-main.zip. Aplikasi belum dijalankan di perangkat dan tes belum dieksekusi. Karena itu:

- Temuan tentang logika (tombol statis, kolom yang tidak dikirim, jumlah query) sudah dicek langsung di kode dan pasti ada.
- Angka waktu (detik, milidetik) adalah perkiraan dari jumlah query dan jarak VPS ke Supabase. Ukur dulu memakai langkah di bagian 6 sebelum menjadikannya patokan.
- Nomor baris mengacu pada isi zip saat ini dan bisa bergeser setelah perubahan.

Istilah "responsive" dalam permintaan saya baca sebagai antarmuka yang tidak merespons perubahan status (tombol tidak berubah setelah diklik). Tata letak untuk berbagai ukuran layar belum diperiksa karena butuh dijalankan dan dilihat langsung.

## 1. Ringkasan temuan

| No | Temuan | Dampak | Prioritas |
|----|--------|--------|-----------|
| A1 | Server memproses sinkron satu event demi satu event, sekitar 8 sampai 10 query per event | Impor 150 produk bisa memakan puluhan detik sampai beberapa menit | Prioritas 1 |
| A2 | Satu permintaan sinkron berisi 100 event dalam satu transaksi, sementara batas waktu klien 60 detik | Permintaan bisa terputus lalu diulang, terasa macet | Prioritas 1 |
| A3 | Setiap perubahan status memicu render ulang seluruh halaman, tanpa penjadwalan | UI berat dan tersendat saat sinkron, termasuk tiap 15 detik walau tidak ada perubahan | Prioritas 2 |
| A4 | Setiap simpan lokal menserialisasi dan mengenkripsi seluruh state | Makin lambat seiring riwayat transaksi bertambah | Prioritas 3 |
| B1 | Kartu shift selalu menampilkan "Shift aktif" dan tombol "Tutup shift" | Tombol tampak tutup terus | Prioritas 1 |
| B2 | Tombol absen Masuk dan Pulang tidak punya status | Tidak ada tanda sudah absen, tidak ada loading saat mengambil lokasi | Prioritas 1 |
| B3 | Absensi tidak pernah masuk ke server karena kolom capturedAt tidak dikirim klien | Data absen hanya ada di perangkat | Prioritas 1 |
| B4 | Label tombol Tahan tidak pernah berubah di mode runtime | Setelah menahan transaksi, tombol tetap berstatus Tahan | Prioritas 1 |
| B5 | Data contoh tertanam di UI absen | Filter staf dan nama toko salah untuk toko lain | Prioritas 2 |
| C1 | Dot, badge, dan pemisah titik tengah masih dipakai | Bertentangan dengan aturan tampilan yang diminta | Prioritas 2 |

## 2. Kecepatan sinkron dan impor Excel

### A1. Satu event sama dengan banyak query ke database

Berkas: server/sync-handler.mjs (perulangan event), server/sync-catalog-handler.mjs, server/sync-stock-handler.mjs

Untuk setiap event, server menjalankan berurutan, masing-masing satu kali pulang pergi ke Supabase:

Event product.upsert tanpa varian, sekitar 10 query:
1. SAVEPOINT
2. pemeriksaan kepemilikan entitas (UNION ALL tujuh tabel)
3. INSERT ke sync_events
4. SELECT identitas produk FOR UPDATE
5. upsert kategori
6. INSERT atau UPDATE produk
7. UPDATE varian yang pensiun (tetap dijalankan walau produk tanpa varian)
8. INSERT stock_balances
9. UPDATE saldo induk stock_balances (tetap dijalankan walau tanpa varian)
10. RELEASE SAVEPOINT

Event stock.delta, sekitar 8 query: SAVEPOINT, pemeriksaan kepemilikan, INSERT sync_events, INSERT saldo, SELECT FOR UPDATE, UPDATE saldo, INSERT stock_movements, RELEASE.

Dampak pada impor Excel 150 produk:

| Skenario | Event | Perkiraan query | Perkiraan waktu pada 30 sampai 100 ms per query |
|----------|-------|-----------------|-----------------------------------------------|
| 150 produk baru | 150 product.upsert dan 1 audit | sekitar 1.500 | 45 sampai 150 detik |
| 150 produk lama diperbarui | 150 product.upsert dan 150 stock.delta dan 1 audit | sekitar 2.700 | 80 sampai 270 detik |

Jadi masalahnya bukan parser Excel. Parser membaca 150 baris dalam milidetik. Waktu habis di jalur sinkron karena pola satu event satu rangkaian query.

Perbaikan yang disarankan:

1. Tambah event gabungan `product.bulkUpsert` yang membawa banyak produk dalam satu event (disarankan maksimum 500 produk atau sekitar 400 KB per event, mengikuti batas 512 KB yang sudah ada).
2. Di server, tangani event gabungan dengan perintah berbasis himpunan: satu pemeriksaan kepemilikan untuk semua id, satu upsert kategori (unnest nama), satu INSERT ... SELECT dari jsonb_to_recordset untuk produk, satu INSERT untuk saldo stok awal, satu INSERT untuk pergerakan stok. Targetnya sekitar 8 query per batch, berapa pun jumlah produknya.
3. Untuk produk yang diperbarui, bawa selisih stok di dalam payload gabungan, jangan kirim stock.delta terpisah per produk.
4. Hentikan query yang tidak perlu bila produk tidak punya varian (langkah 7 dan 9 di atas).
5. Perbaikan cepat tanpa mengubah format event: gabungkan pemeriksaan kepemilikan untuk seluruh batch menjadi satu query, bukan satu per event.

Kriteria selesai:
- Impor 150 produk baru tersinkron ke server dalam kurang dari 5 detik pada jaringan normal.
- Jumlah query per permintaan sinkron untuk impor tidak bergantung linear pada jumlah produk (cek lewat log durasi).
- Tes baru di scripts: event gabungan menolak id produk milik toko lain, menolak SKU ganda, dan idempoten bila dikirim ulang.

### A2. Satu transaksi besar dan batas waktu klien

Berkas: app/pos/runtime.js (sendApiRequest, synchronizeState), server/index.mjs (konfigurasi pool)

- Klien membatasi /api/sync selama 60 detik. Satu batch bisa berisi 100 event, atau sekitar 1.000 query. Pada 60 ms per query itu sudah 60 detik.
- Bila klien membatalkan, server tetap bisa menyelesaikan transaksi. Klien lalu mengirim ulang event yang sama. Hasilnya aman karena ada ON CONFLICT, tetapi kerja berulang dan pengguna melihat status macet.
- Setelah setiap batch, klien menunggu 700 ms sebelum batch berikutnya. Setelah kegagalan sementara, jeda naik sampai 60 detik.
- Seluruh batch memegang lock baris produk dan lock penasihat bersama selama transaksi berjalan, sehingga kasir lain yang menyinkronkan pada saat yang sama ikut menunggu.

Perbaikan yang disarankan:
1. Selesaikan A1 lebih dulu, karena itu memperpendek transaksi secara drastis.
2. Tampilkan progres nyata di UI (contoh teks: "Mengunggah produk 100 dari 150") dari data prepared.pending yang sudah ada.
3. Untuk impor besar, kirim potongan bergantian dan jangan memicu sinkron berkala di tengah impor.
4. Catat durasi tiap fase di server (lihat bagian 6).

### A3. Render ulang seluruh halaman tanpa penjadwalan

Berkas: app/pos/index.html (refreshPosFromRuntime, sekitar baris 6105), app/pos/runtime.js (updateSyncStatus, publishStateChange, getStateSnapshot)

- updateSyncStatus memanggil publishStateChange, dan itu memanggil refreshPosFromRuntime yang merender katalog, tabel produk, laporan, shift, absen, outlet, dan pengguna sekaligus, bahkan untuk halaman yang tidak sedang dibuka.
- Satu siklus sinkron memanggilnya setidaknya dua kali (mulai dan selesai), ditambah panggilan dari persistState. Siklus ini berjalan tiap 15 detik walau tidak ada perubahan.
- getStateSnapshot menyalin seluruh daftar produk di setiap panggilan.

Perbaikan yang disarankan:
1. Gabungkan banyak perubahan dalam satu frame memakai requestAnimationFrame atau throttle sekitar 100 ms.
2. Render hanya halaman yang sedang tampil, dan sisanya saat halaman dibuka.
3. Perubahan hanya pada status sinkron cukup memperbarui teks dan ikon sinkron, tanpa render ulang halaman.
4. Lewati sinkron berkala bila antrean kosong dan kursor tidak berubah (atau gunakan jeda lebih panjang saat tidak ada aktivitas).

### A4. Simpan lokal menserialisasi seluruh state

Berkas: shared/pos-storage.mjs (queueEncryptedState, drainEncryptedQueue), app/pos/runtime.js (persistState)

- Setiap persistState menjalankan JSON.stringify atas seluruh state (produk, penjualan, audit, pergerakan stok, antrean) lalu mengenkripsi dan menulis ke IndexedDB atau SQLite. Antrean sudah menggabungkan tulisan menjadi snapshot terakhir, itu bagus, tetapi ukuran snapshot terus tumbuh bersama riwayat.
- Tidak berpengaruh besar pada 150 produk, tetapi akan terasa pada toko dengan ribuan transaksi.

Perbaikan yang disarankan (Prioritas 3, pekerjaan lebih besar):
1. Pisahkan penyimpanan per koleksi (produk, penjualan, audit, antrean) agar hanya koleksi yang berubah yang ditulis.
2. Pangkas riwayat lama dari state aktif (arsipkan penjualan lama dan audit lama).
3. Pakai metrik yang sudah ada (getWriteDiagnostics) untuk memantau ukuran dan durasi tulis.

### Catatan kecil untuk skala impor

importProducts di app/pos/runtime.js (sekitar baris 1103) mencari produk dengan state.products.find untuk setiap baris. Untuk 150 baris tidak masalah, tetapi pada batas 5.000 baris menjadi puluhan juta perbandingan. Ganti dengan Map berdasarkan SKU huruf kecil yang dibuat sekali di awal.

Status impor di UI hanya menampilkan "Membaca file Excel…" lalu diam sampai selesai. Tambahkan teks progres per tahap: membaca, memeriksa, menyimpan lokal, mengunggah.

## 3. Tombol dan status yang tidak mengikuti keadaan

### B1. Kartu shift selalu berstatus aktif dan tombolnya selalu "Tutup shift"

Berkas: app/pos/index.html, sekitar baris 1457 sampai 1481. Fungsi renderShiftPage sekitar baris 5519.

- Teks "Shift aktif" dan tombol "Tutup shift" ditulis langsung di HTML. renderShiftPage mengisi waktu buka, pembuka, dan jumlah kasir, tetapi tidak mengubah judul kartu maupun label tombol.
- Akibatnya tombol terlihat "tutup" terus, termasuk saat belum ada shift. openCloseShiftModal memang membuka dialog Buka shift bila tidak ada shift aktif, tetapi label tombol tidak memberi tahu pengguna.

Perbaikan:
1. Di renderShiftPage, turunkan keadaan dari activeShift:
   - Tidak ada shift: judul "Belum ada shift", tombol "Buka shift", nilai kas dikosongkan.
   - Ada shift: judul "Shift aktif", tombol "Tutup shift".
2. Nonaktifkan tombol selama proses buka atau tutup berjalan, lalu kembalikan setelah selesai.
3. Pastikan perubahan shift dari perangkat lain (hasil sinkron) ikut memperbarui kartu, karena renderShiftPage dipanggil dari refreshPosFromRuntime.

Kriteria selesai: tombol berganti antara Buka shift dan Tutup shift mengikuti activeShift, diuji untuk keadaan awal, setelah buka, setelah tutup, dan setelah sinkron dari perangkat lain.

### B2. Tombol absen Masuk dan Pulang tidak punya status

Berkas: app/pos/index.html (tombol sekitar baris 1653 sampai 1665, recordAttendance sekitar baris 5792), app/pos/runtime.js (setAttendance sekitar baris 1446)

- Kedua tombol selalu aktif dan tidak berubah setelah absen. Satu-satunya umpan balik adalah toast.
- setAttendance menunggu lokasi sampai 20 detik (enableHighAccuracy dan maximumAge 0) tanpa penanda apa pun di tombol. Pengguna cenderung menekan berulang.
- Setelah selesai, tidak ada perubahan pada tombol yang menandakan sudah masuk atau sudah pulang.

Perbaikan:
1. Turunkan keadaan dari catatan absen milik pengguna aktif pada hari ini:
   - Belum masuk: Masuk aktif, Pulang nonaktif.
   - Sudah masuk, belum pulang: Masuk nonaktif dengan teks "Sudah masuk pukul HH.MM", Pulang aktif.
   - Sudah pulang: keduanya nonaktif dengan teks "Absen hari ini selesai".
2. Saat mengambil lokasi, ubah teks tombol menjadi "Mengambil lokasi" dan nonaktifkan kedua tombol, dengan batas waktu yang jelas (misalnya 10 detik, lalu tampilkan pesan dan izinkan coba lagi).
3. Hanya peran Kasir dan Admin yang boleh absen (aturan sudah ada di setAttendance). Untuk peran lain, sembunyikan atau nonaktifkan tombol dengan alasan, jangan biarkan aktif lalu menolak lewat toast.
4. Pada Android, uji alur izin lokasi di perangkat nyata. Manifest sudah memuat ACCESS_FINE_LOCATION dan ACCESS_COARSE_LOCATION, tetapi perilaku izin pada WebView perlu dibuktikan di perangkat.

### B3. Absensi tidak pernah tersinkron ke server

Berkas: server/attendance-policy.mjs (isAttendanceLocation), app/pos/runtime.js (setAttendance), server/sync-attendance-handler.mjs

- Validator server mewajibkan objek lokasi memuat capturedAt berupa string tanggal yang valid.
- Klien hanya mengirim latitude, longitude, dan accuracy. Pencarian di seluruh kode menunjukkan capturedAt hanya muncul di validator dan di tes, tidak pernah dibuat oleh klien.
- Hasilnya, setiap event attendance.upsert yang memuat lokasi ditolak dengan "Data absensi tidak valid" (status 400, tidak dapat diulang). Event pindah ke daftar masalah sinkron dan absensi hanya tersimpan di perangkat pembuatnya.
- Tes scripts/attendance-policy.test.mjs lolos karena datanya sudah memuat capturedAt, sehingga celah ini tidak terdeteksi.

Perbaikan:
1. Di setAttendance, tambahkan capturedAt: new Date().toISOString() pada objek lokasi, atau gunakan pos.timestamp dari Geolocation API.
2. Tambahkan tes yang membentuk payload persis seperti yang dibuat klien dan mengirimkannya ke handler.
3. Tampilkan masalah sinkron absensi ke pengguna (saat ini hanya jumlah masalah di tombol sinkron), dan sediakan cara mengirim ulang event yang tertahan setelah perbaikan dirilis.
4. Periksa perangkat yang sudah punya antrean atau daftar masalah berisi absensi lama. Event itu perlu dibentuk ulang dengan capturedAt bila ingin tetap dikirim.

### B4. Tombol Tahan tidak berubah setelah transaksi ditahan

Berkas: app/pos/index.html (tombol sekitar baris 241, holdCurrentOrder sekitar baris 3833)

- Label diubah (ke "Pulihkan (1)") hanya pada cabang cadangan tanpa runtime. Pada mode runtime, yang dipakai di aplikasi nyata, elemen holdBtnLabel tidak pernah diperbarui. Setelah menahan, tombol tetap bertuliskan "Tahan".
- Pada mode runtime, tombol yang sama punya dua fungsi tersembunyi: keranjang berisi berarti menahan, keranjang kosong dan ada tahanan berarti memulihkan. Pengguna tidak bisa menebaknya dari label, dan saat keranjang berisi mereka tidak bisa memulihkan tahanan lain.

Perbaikan:
1. Di refreshPosFromRuntime, atur label dan keadaan dari snapshot.cart dan snapshot.holds:
   - Keranjang berisi: "Tahan".
   - Keranjang kosong dan ada tahanan: "Pulihkan (n)" dengan n dari jumlah tahanan.
   - Keranjang kosong dan tidak ada tahanan: "Tahan" dalam keadaan nonaktif.
2. Pertimbangkan dua tombol terpisah, "Tahan" dan "Daftar tahanan (n)", agar tahanan tetap dapat dibuka saat keranjang berisi.
3. Hapus duplikasi dialog Tahan (ada di holdCurrentOrder dan openHoldDialog) menjadi satu fungsi.

Kriteria selesai: setelah menahan transaksi, label berubah menjadi Pulihkan dengan jumlah yang benar. Setelah memulihkan atau menahan lagi, label dan jumlah selalu sesuai holds.

### B5. Data contoh tertanam di UI

Berkas: app/pos/index.html

- Filter staf pada halaman absen berisi nama tetap "Admin Uji", "Kasir Uji", dan "Manajer Uji" (sekitar baris 1753 sampai 1787). Fungsi syncAttendanceStaffDropdown sebenarnya sudah dapat mengisi daftar dari data nyata. Hapus pilihan yang tertanam.
- Rincian absen menulis nama toko "Rnp Store" secara tetap (di openAttendanceDetails). Ganti dengan nama outlet aktif dari snapshot.
- Jalur cadangan recordAttendance memakai tanggal tetap "22 Nov 2026" dan pengguna "Admin Uji". Bila jalur cadangan tidak lagi dipakai, hapus. Bila masih dipakai, gunakan tanggal dan pengguna sebenarnya.

### Pola yang sama di tempat lain

B1, B2, dan B4 punya akar yang sama: label dan status ditulis di HTML, lalu hanya sebagian kasus yang diperbarui dari data. Lakukan penyisiran sekali untuk semua tombol yang labelnya punya dua keadaan atau lebih (buka dan tutup, aktif dan nonaktif, simpan dan tersimpan) dan pastikan setiap keadaan diturunkan dari snapshot di refreshPosFromRuntime. Permintaan "dll" belum bisa dituntaskan tanpa menjalankan aplikasi. Daftar tombol lain yang bermasalah dari penggunaan sehari-hari akan memperkaya bagian ini.

## 4. Aturan tampilan: tanpa dot dan tanpa badge

Aturan untuk seluruh UI, README, dan komponen baru:

- Dot: tidak ada penanda lingkaran kecil berwarna, termasuk yang memakai ring, bayangan berdenyut, atau animasi.
- Titik tengah sebagai pemisah teks: tidak memakai karakter titik tengah di antara bagian teks.
- Badge: tidak ada label kecil berlatar warna berbentuk kapsul atau lencana angka, dan tidak ada gambar badge dari layanan eksternal.
- Pengganti: tampilkan status sebagai teks biasa yang jelas (misalnya "Shift aktif", "Offline", "Menunggu"), dengan bobot atau warna teks bila perlu. Pisahkan bagian informasi dengan tanda hubung, koma, baris baru, atau jarak. Jumlah ditulis di dalam teks, misalnya "Pulihkan (2)" atau "3 antrean".

Hasil pemeriksaan kode saat ini:

| Lokasi | Temuan | Tindakan |
|--------|--------|----------|
| app/pos/index.html sekitar baris 1464 | Dot hijau berlingkar pada kartu shift (h-2.5 w-2.5 rounded-full dengan ring) | Hapus, cukup teks "Shift aktif" atau "Belum ada shift" |
| app/pos/index.html sekitar baris 4447 | Dot indikator pada carousel produk | Ganti dengan teks "1 dari 5" atau tombol sebelumnya dan berikutnya |
| app/pos/index.html | Sekitar 40 pemisah titik tengah | Ganti dengan koma atau tanda hubung |
| app/pos/runtime.js | Sekitar 15 pemisah titik tengah pada label status, contoh "Offline" diikuti jumlah antrean, dan "Katalog belum tersimpan" diikuti "perlu sinkronisasi online" | Tulis dengan koma, misalnya "Offline, 3 antrean" |
| app/src/pages/OwnerDashboard.tsx | 3 pemisah titik tengah | Ganti |
| app/pos/index.html | Sekitar 21 elemen berpola badge (latar warna tipis, sudut membulat, teks 9 sampai 11 px). Angka ini hasil pencarian pola kelas, jadi periksa satu per satu | Jadikan teks biasa |
| app/pos/index.html, id shiftPreviewBadge dan stockPreviewBadge | Hanya nama id, tampilannya teks biru biasa | Ganti nama id menjadi shiftPreviewLabel dan stockPreviewLabel agar tidak membingungkan |
| README.md | 10 badge shields.io di bagian atas (JavaScript, TypeScript, HTML5, CSS3, SQL, React, Node.js, Vite, Capacitor, Offline-first) | Hapus, ganti satu kalimat teknologi yang dipakai |

Penegakan aturan:
1. Tambahkan skrip pemeriksaan di scripts (misalnya check-style-rules.mjs) yang gagal bila menemukan karakter titik tengah di teks UI, pola dot (lingkaran kecil dengan rounded-full pada ukuran w dan h kecil), atau img.shields.io di berkas dokumen.
2. Jalankan skrip itu di npm run build agar pelanggaran baru tertahan sebelum rilis.
3. Tuliskan aturan ini di styles/README.md sebagai bagian dari sistem desain.

## 5. Urutan pengerjaan

Prioritas 1 (dampak langsung ke pengguna, perubahan relatif kecil):
1. B3 kirim capturedAt dan tambah tes payload nyata.
2. B1, B2, B4 status tombol shift, absen, dan tahan, diturunkan dari snapshot.
3. A1 bagian perbaikan cepat (satu pemeriksaan kepemilikan per batch, lewati query varian bila tanpa varian), lalu event gabungan product.bulkUpsert.
4. A2 progres impor dan sinkron yang terlihat.

Prioritas 2:
5. A3 penjadwalan render dan render halaman aktif saja.
6. B5 buang data contoh.
7. C1 hapus dot, badge, titik tengah, dan pasang skrip penegak aturan.
8. Fitur baru D1 riwayat perubahan stok (bagian 7), mulai dari endpoint server lalu halaman terpisah.
9. Fitur baru D2 ikon produk, preset dan gambar unggahan (bagian 8), dikerjakan setelah A1 karena menyentuh handler produk yang sama.

Prioritas 3:
10. A4 penyimpanan lokal per koleksi dan pemangkasan riwayat.
11. Penyisiran tombol berstatus ganda yang lain.

## 6. Pengukuran sebelum dan sesudah

Supaya klaim "cepat" bisa dibuktikan, tambahkan pengukuran dulu sebelum mengubah apa pun:

1. Server: catat durasi total permintaan /api/sync, jumlah event, jumlah query, dan durasi per jenis event. Catat juga waktu satu query sederhana ke Supabase dari VPS (db:smoke bisa dipakai sebagai dasar). Hasilnya menentukan apakah jarak VPS ke database ikut berperan, selain jumlah query.
2. Klien: catat waktu dari klik Impor sampai antrean kosong, dan waktu render per siklus sinkron.
3. Skenario uji tetap:
   - impor 150 produk baru
   - impor 150 produk yang sudah ada (stok berubah)
   - impor 1.000 produk
   - sinkron kosong (tanpa perubahan) saat halaman Produk terbuka
4. Target:
   - impor 150 produk terlihat selesai di layar dalam kurang dari 2 detik (penyimpanan lokal) dan tersinkron dalam kurang dari 5 detik
   - sinkron kosong tidak memicu render ulang halaman
   - tidak ada permintaan sinkron yang melewati 10 detik pada skenario di atas

## 7. Fitur baru D1: riwayat perubahan stok

Permintaan: halaman terpisah untuk riwayat perubahan stok, dibuka lewat tombol di halaman Produk.

### Kondisi sekarang

- Aplikasi punya state.stockMovements, tetapi tidak ada satu pun tampilan yang membacanya.
- Daftar lokal itu hanya terisi dari tiga jalur: ubah produk lewat formulir, impor Excel, dan penyesuaian stok. Penjualan, refund dengan restock, transfer antar toko, dan perubahan dari perangkat lain tidak masuk ke daftar ini.
- Daftar lokal bertambah tanpa batas dan ikut diserialisasi di setiap simpan (menambah beban A4).
- Server sudah punya tabel stock_movements berisi semua pergerakan yang diterima, termasuk penjualan, lengkap dengan alasan dan waktu. Indeks yang ada urut per produk (outlet, produk, waktu).
- Kekurangan di server: kolom user_id ada tetapi tidak pernah diisi oleh kedua INSERT, sehingga tidak diketahui siapa yang mengubah. Server juga tidak menyimpan saldo sebelum dan sesudah, dan stok awal produk baru tidak tercatat sebagai pergerakan. Belum ada endpoint untuk membaca riwayat.

Karena itu sumber data riwayat yang benar adalah server, bukan daftar lokal.

### Rancangan

Server (berkas: server/index.mjs, handler baru server/stock-history-handler.mjs, db/migrations):
1. Endpoint GET /api/stock-movements yang meniru pola /api/sales: batas 1 sampai 100 (bawaan 50), cursor before dan beforeId berdasarkan waktu dan id, filter productId, from, to, dan jenis. Cakupan outlet selalu diambil dari sesi. Satu query dengan LIMIT, bergabung ke products (nama, SKU) dan users (nama pelaku).
2. Isi user_id (actor.id) pada INSERT stock_movements di server/sync-stock-handler.mjs dan server/sync-sale-handler.mjs. Data lama tetap kosong, tampilkan sebagai "Tidak tercatat".
3. Catat stok awal sebagai satu pergerakan dengan alasan "Stok awal" saat produk baru dibuat dengan stok lebih dari nol, termasuk lewat impor, memakai CTE pada INSERT yang sama agar tidak menambah query. Dengan begitu jumlah pergerakan konsisten dengan saldo.
4. Migrasi baru 007 untuk indeks (outlet_id, occurred_at DESC, id DESC) pada stock_movements. Indeks yang ada tidak efisien untuk daftar seluruh produk menurut waktu.
5. Saldo sesudah perubahan ditampilkan hanya pada tampilan per produk dan dihitung mundur dari stok sekarang. Ini opsional untuk tahap kedua agar tahap pertama tetap kecil.

Klien (berkas: app/pos/index.html, app/pos/runtime.js):
1. Tombol "Riwayat stok" dengan ikon ph-clock-counter-clockwise di header halaman Produk, di sebelah Impor Excel. Pada daftar produk, tambahkan tindakan "Riwayat" per baris yang membuka halaman yang sama dengan filter produk tersebut.
2. Halaman baru page-riwayat-stok, dibuat seperti page-absen, didaftarkan di navigateTo, tidak masuk menu utama, dengan tombol Kembali ke Produk.
3. Isi halaman: pencarian produk atau SKU, filter jenis (Semua, Penjualan, Penyesuaian, Impor, Transfer, Refund), filter tanggal dari dan sampai, dan daftar yang dimuat bertahap 50 baris dengan tombol "Muat lagi". Jangan memuat seluruh riwayat sekaligus.
4. Kolom: waktu, produk dengan SKU, perubahan, alasan, dan pelaku. Perubahan ditulis sebagai teks bertanda plus atau minus dengan warna teks. Jenis cukup terbaca dari kolom alasan. Tanpa dot dan tanpa badge, sesuai bagian 4.
5. Tampilan ponsel berupa daftar kartu satu kolom, mengikuti pola produkMobileList.
6. Saat offline, tampilkan pesan teks bahwa riwayat lengkap membutuhkan koneksi, dan tampilkan data lokal terbatas. Batasi stockMovements lokal ke 500 terbaru supaya state tidak membengkak.
7. Hak akses bawaan: Pemilik, Admin, dan Manajer boleh melihat. Kasir tidak, karena Kasir memang tidak boleh mengubah stok. Server menolak Kasir dengan 403 dan tombol tidak ditampilkan. Ubah bila kebijakan toko berbeda.

### Kriteria selesai

- Halaman terbuka dan menampilkan 50 baris pertama dalam kurang dari 1 detik pada toko dengan puluhan ribu pergerakan.
- Setiap jalur perubahan stok (penjualan, refund, penyesuaian, impor, transfer, perubahan dari perangkat lain) muncul di riwayat, dengan nama pelaku untuk data baru.
- Tes handler: batas dan cursor, cakupan outlet tidak bisa dilewati, Kasir ditolak, dan filter tanggal mengikuti zona waktu outlet seperti /api/sales.
- Tidak ada penambahan query atau muatan pada alur /api/sync, selain satu kolom user_id.

## 8. Fitur baru D2: ikon produk (preset dan gambar unggahan)

Permintaan: ikon produk dapat diubah, termasuk ikon kustom berupa gambar yang diunggah. Gambar dikompres di sisi pengguna (klien) sebelum diunggah, sedangkan server hanya memvalidasi dengan ketat dan menyimpan, agar tetap ringan.

### Kondisi sekarang

- Produk tidak punya field ikon. Katalog kasir memakai ikon ph-cube yang sama untuk semua produk, baik tampilan grid (sekitar baris 3649) maupun daftar (sekitar baris 3670). Carousel produk memakai ph-package.
- Font ikon Phosphor (regular, bold, duotone, fill) sudah dimuat dan disimpan service worker, jadi ikon preset tersedia tanpa biaya tambahan.
- Kebijakan CSP di server/index.mjs sudah mengizinkan gambar dari asal sendiri (img-src 'self'), jadi gambar dari server sendiri bisa tampil tanpa mengubah CSP.
- Service worker (sw.js) melewatkan semua permintaan di bawah /api/ tanpa cache. Gambar yang disajikan dari /api/ tidak akan ikut tersimpan untuk pemakaian offline.
- Server hanya punya pembaca body JSON (readJson, batas 2 MB). Belum ada pembaca body biner, dan belum ada pustaka pengolah gambar di dependensi (hanya fflate dan pg).
- Event sinkron dibatasi 512 KB dan seluruh state lokal diserialisasi serta dienkripsi di setiap simpan. Karena itu gambar tidak boleh ditaruh di event maupun state.

### Prinsip agar tetap ringan

Gambar tidak pernah masuk ke event sinkron atau state lokal. Produk hanya menyimpan imageId, sebuah teks pendek. Gambar diunggah lewat endpoint terpisah, dikompres di klien, divalidasi dan disimpan sekali di server, dimuat malas lewat URL, lalu di-cache. Ikon preset tetap ada sebagai pilihan bawaan dan sebagai cadangan bila gambar tidak tersedia.

### Rancangan

Data dan pilihan di formulir:
1. Tambah dua field pada produk: icon (kunci preset pendek, misalnya "coffee", bawaan "cube") dan imageId (kosong bila tidak ada gambar). Bila imageId terisi, gambar dipakai, bila tidak, ikon preset dipakai.
2. Daftar preset di satu modul bersama shared/product-icons.mjs berisi pemetaan kunci ke kelas Phosphor, sekitar 30 sampai 40 ikon untuk ritel dan F&B. Modul ini dipakai klien dan server agar daftar tidak berbeda.
3. Formulir produk punya bidang "Ikon" dengan dua pilihan berupa tab teks, "Ikon" dan "Gambar". Tab Ikon berisi kisi tombol ikon. Tab Gambar berisi tombol "Unggah gambar", pratinjau, dan tombol "Hapus gambar". Pilihan terpilih ditandai dengan garis tepi dan latar tipis, tanpa dot dan tanpa badge.

Unggah dan kompres (berkas klien: formulir produk dan app/pos/runtime.js; berkas server: server/index.mjs, handler baru server/product-image-handler.mjs, db/migrations/008):
1. Klien mengompres penuh sebelum unggah. Input file menerima JPEG, PNG, dan WebP, maksimal 8 MB sebagai berkas sumber, lalu menampilkan pratinjau lokal. Langkahnya:
   - dekode dengan createImageBitmap memakai imageOrientation 'from-image' (rotasi EXIF terkoreksi) dan resizeWidth serta resizeHeight supaya memori hemat di perangkat lemah
   - potong persegi dari tengah ke 192 x 192 piksel lewat canvas, yang otomatis membuang seluruh metadata termasuk lokasi GPS
   - encode dengan canvas.toBlob WebP kualitas 0,72, turunkan bertahap ke 0,6 lalu 0,5 sampai ukuran di bawah 20 KB
   - bila blob.type bukan image/webp (browser yang tidak bisa encode WebP), pakai JPEG sebagai cadangan, dan server menerima keduanya
2. Endpoint POST /api/product-images menerima body biner mentah (bukan JSON), dengan pembaca body baru yang memotong di batas 30 KB dan menjawab 413 bila terlampaui. Wajib sesi aktif, requireSameOrigin, dan izin yang sama dengan product.upsert. Batas laju sekitar 20 unggahan per menit per akun.
3. Server tidak mempercayai klien dan memvalidasi tanpa pustaka pengolah gambar:
   - periksa byte awal berkas (WebP: RIFF....WEBP, JPEG cadangan: FF D8 FF), bukan header Content-Type dari klien
   - baca lebar dan tinggi dari header berkas, tolak dengan 422 bila bukan 192 x 192
   - tolak SVG, GIF, PNG, dan format lain dengan 415
   - simpan berkas apa adanya, lalu sajikan dengan Content-Type dari kolom content_type dan X-Content-Type-Options: nosniff
4. Tidak ada pemrosesan gambar di server, jadi tidak perlu antrean pemrosesan dan beban CPU VPS tidak bertambah. Konsekuensinya, server tidak menjamin berkas adalah hasil encode ulang dan tidak membuang metadata bila klien dilewati. Risikonya kecil karena unggahan hanya dari akun berizin, ukuran dibatasi 30 KB, dan berkas disajikan dengan nosniff.
5. Penyimpanan: tabel baru product_images (id, outlet_id, sha256, content_type, byte_size, data bytea, created_at) dengan keunikan (outlet_id, sha256) sehingga gambar yang sama tidak tersimpan dua kali. Respons berisi imageId dan ukuran akhir. Ganti gambar berarti imageId baru.
6. Setelah unggah berhasil, klien mengisi imageId pada formulir. saveProduct mengirim product.upsert dengan imageId (sekitar 36 byte), tanpa mengubah format event.
7. Server (server/sync-catalog-handler.mjs): simpan icon dan imageId di metadata jsonb produk seperti favorite, tanpa mengubah skema produk. Validasi icon harus ada di daftar preset atau kosong, dan imageId harus ada serta milik outlet yang sama. Sertakan keduanya pada bootstrapProducts di server/sync-handler.mjs. Di klien, pastikan mergeSyncEvent untuk product.upsert ikut membawa icon dan imageId dari perangkat lain.

Tampil dan cache:
1. Sajikan gambar dari GET /media/products/IMAGEID (tanpa ekstensi, tipe mengikuti content_type tersimpan), di luar /api/ supaya dapat di-cache service worker. Wajib sesi aktif, header Cache-Control: private, max-age=31536000, immutable. Aman memakai immutable karena imageId berubah setiap gambar berganti.
2. Di klien, render img dengan loading="lazy", decoding="async", serta lebar dan tinggi tetap supaya katalog tidak bergeser. Pakai di katalog grid, daftar, tabel produk, dan carousel lewat satu fungsi helper. Bila gambar gagal dimuat (offline dan belum ter-cache, atau dihapus), tampilkan ikon preset atau ph-cube lewat onerror.
3. Service worker memakai cache terpisah untuk /media/products/ dengan strategi cache dulu, batas sekitar 300 entri (hapus yang terlama), dan dikosongkan saat logout atau hapus data lokal agar gambar toko tidak tertinggal di perangkat bersama.
4. Pastikan URL gambar memakai basis alamat yang sama dengan permintaan API. Konfigurasi Capacitor saat ini tidak memuat server.url, jadi periksa bagaimana aplikasi Android menjangkau server sebelum menetapkan URL gambar di sana.

Pembersihan:
1. Tombol "Hapus gambar" mengosongkan imageId dan kembali ke ikon preset.
2. Tambahkan langkah di scripts/maintenance.mjs yang menghapus gambar yatim (tidak dirujuk produk mana pun) yang berumur lebih dari 7 hari. Pencocokan memakai metadata imageId pada tabel produk.
3. Tetapkan batas per outlet, misalnya 2.000 gambar atau 50 MB, dan tolak unggahan baru dengan pesan yang jelas bila terlampaui.

### Anggaran ringan

- Satu gambar di bawah 20 KB (sasaran rata-rata 8 sampai 12 KB). Untuk 150 produk bergambar totalnya sekitar 1,5 MB di server, dan di perangkat hanya gambar yang tampil di layar yang diunduh, satu kali, lalu di-cache.
- Tidak ada penambahan pada state terenkripsi, event sinkron, maupun jumlah query sinkron. Event product.upsert hanya bertambah puluhan byte.
- Tidak ada dependensi baru di server. Pengolahan gambar memakai API bawaan browser (canvas dan createImageBitmap) di klien.
- Impor Excel tidak membawa gambar. Kolom "Ikon" opsional di templat hanya untuk kunci preset, dan kunci yang tidak dikenal dilaporkan sebagai peringatan, bukan kegagalan baris.

### Kriteria selesai

- Foto 4 MB dari ponsel menjadi WebP 192 x 192 di bawah 20 KB di klien dalam waktu kurang dari 2 detik pada ponsel kelas menengah, EXIF serta lokasi GPS hilang dari hasilnya, dan yang diunggah hanya sekitar 10 KB.
- SVG, berkas yang bukan WebP atau JPEG, berkas di atas 30 KB, dan gambar yang bukan 192 x 192 ditolak server dengan kode yang tepat (415, 413, atau 422).
- Produk tampil dengan gambar di kasir dan tabel produk, juga di perangkat lain setelah sinkron. Saat offline, gambar yang pernah dimuat tetap tampil dan sisanya memakai ikon preset.
- Produk lama tanpa ikon atau gambar tampil seperti sekarang.
- Tes server: unggahan valid, ukuran berlebih 413, format ditolak 415, dimensi salah 422, Kasir 403, imageId dari outlet lain ditolak, dan gambar identik menghasilkan imageId yang sama.
- Pemilih ikon dan gambar lulus skrip pemeriksa aturan tanpa dot dan badge di bagian 4.

## 9. Hal yang belum diperiksa

- Aplikasi belum dijalankan, jadi perilaku tampilan pada berbagai ukuran layar dan perangkat Android belum diamati.
- Tes otomatis (npm test) belum dieksekusi.
- OwnerDashboard.tsx, perangkat cetak (FastQPrinterPlugin), dan alur pemindai kode batang belum diaudit.
- Keamanan dan konfigurasi produksi (peran database, TLS, sesi) hanya dibaca sekilas dan bukan bagian audit ini.
- Daftar tombol lain yang tidak berfungsi ("dll") perlu masukan dari penggunaan nyata.
- Dukungan encode WebP lewat canvas.toBlob di WebView Android (Capacitor) dan Safari belum diuji di perangkat, termasuk jalur cadangan JPEG.
