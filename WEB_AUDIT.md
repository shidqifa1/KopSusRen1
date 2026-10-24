# Pemeriksaan web, 17 Oktober 2026

Branch: `codex/whatsapp-order-reliability`. Perubahan lokal untuk diuji pemilik; belum diterapkan ke production. Tidak ada perubahan skema database atau dependency.

## Perbaikan

- Refresh otomatis menunggu form, dialog, dan mutation; permintaan refresh tidak bertumpuk. Input kalkulator, tanggal laporan, serta pilihan menu/bahan/akun tetap dipertahankan saat render ulang.
- Dialog edit stok dan resep tetap terbuka ketika command gagal.
- Penyimpanan yang sudah dikonfirmasi server tetap dianggap berhasil jika pengambilan snapshot berikutnya gagal. Form dibersihkan dan muncul pesan bahwa tampilan belum sinkron, sehingga pengguna tidak didorong mengirim ulang transaksi. Ini belum menyelesaikan kasus koneksi putus sebelum respons command diterima.
- Bootstrap yang gagal tanpa cache menampilkan state V2 kosong beserta pesan gagal sinkronisasi, bukan stok/menu contoh dari mode lama.
- Detail transaksi menggunakan nilai modal yang dihitung untuk sale tersebut, termasuk pengurangan es untuk no-ice.
- Grafik dashboard menggunakan tanggal WIB; laporan bulanan mengikuti bulan WIB. Dashboard tetap dapat digunakan ketika library grafik dari CDN gagal dimuat.
- Riwayat kas/pengeluaran diurutkan terbaru dahulu sebelum dibatasi 30 baris.
- Generate ulang laporan memperbarui salinan laporan tersimpan. Estimasi pemakaian bahan mengecualikan es untuk no-ice. Snapshot kas/stok disebut sebagai kondisi saat laporan dibuat, bukan saldo/stok penutupan historis.
- Dashboard, jarak antarelemen, angka ringkasan, kartu stok/resep, dropdown, label form, indikator sinkronisasi, dan ukuran input HP dirapikan mengikuti warna krem/cokelat/hijau yang sudah ada.

## Verifikasi otomatis

16 tes regresi baru di `tests/ui-behavior.test.mjs`, termasuk smoke render sembilan halaman data dari skrip aplikasi utuh dalam DOM stub. Tes ini tidak menggantikan pengujian browser dengan database.

Output asli `npm run check`:

```text
1..244
# tests 258
# suites 0
# pass 257
# fail 0
# cancelled 0
# skipped 1
# todo 0
```

Satu skip merupakan tes database live opsional. Tes tersebut kemudian dijalankan terpisah saat import aktif dengan `OWNER_LIVE_DB_TEST=1 node --env-file=.env.local tests/owner-purchases.test.mjs`:

```text
# tests 14
# pass 14
# fail 0
# skipped 0
```

Termasuk dua bootstrap concurrent yang tetap mempertahankan bentuk hasil tabel dengan benar (9,75 detik).

Output asli `npm run eval:chatbot`:

```text
Acceptance:
Complete-order accuracy >=95%: FAIL
Critical silent error <1%: PASS
Ambiguous detection >=95%: FAIL
False-order safe acceptance ~0%: PASS
Critical failures: 0; recoverable: 114
```

Evaluasi deterministic chatbot masih gagal target akurasi dan deteksi ambigu seperti baseline sebelumnya. Tidak diperbaiki dengan perubahan UI ini.

Bootstrap database development diuji read-only melalui server lokal:

```json
{"httpStatus":200,"environment":"development","products":4,"ingredients":8,"purchases":0,"gatewayStatus":"CONNECTED","heartbeatAgeSeconds":27}
```

## Pemeriksaan browser

Preview dummy terpisah di port 3190, tanpa endpoint mutation dan tanpa akses database. Skrip/index dan CSS berasal dari working tree yang sama. Ini tidak mengganti autentikasi web utama di port 3187.

- Dashboard diperiksa pada desktop 1366x900; stok diperiksa pada HP 390x844.
- Sepuluh tujuan navigasi dibuka: dashboard, PO, WhatsApp, riwayat, kalkulator, stok, resep, belanja, laporan, dan pengaturan.
- Kalkulator dua Latte menghasilkan susu 300 ml, kopi 30 gram, es 500 gram, dua cup, omzet Rp16.000 dari fixture resep.
- Preview belanja susu 12.000 ml senilai Rp270.000 menghasilkan Rp22,50/ml.
- Tiga tab transaksi berganti dengan benar. Dukungan Arrow/Home/End ditambahkan dan diuji lewat tes regresi.
- Dialog stok terbuka, Escape menutup dan mengembalikan fokus ke bahan yang dipilih.

## Batas pemeriksaan dan tindak lanjut

Import pengguna terkonfirmasi selesai di browser dengan pesan “322 baris diproses.” Sesudah database tidak memiliki transaksi aktif, backend lokal di-restart untuk mengaktifkan build optimasi batch. Setelah restart, dashboard akun asli berhasil dimuat dengan indikator “Data tersinkron”, ringkasan kas dan pelanggan hasil import tampil. Health bootstrap HTTP 200 dan gateway CONNECTED dengan heartbeat 5 detik. Submit PO/penjualan/pembelian, pembayaran, refund, dan download/export melalui browser masih belum diuji end-to-end pada data asli.

Import penjualan dan kas di `api/v2/commands.ts` sekarang mengirim satu query SQL berparameter berisi JSON batch. RPC dan schema tetap sama, transaksi dan kunci idempotency per baris tetap dipakai. Dua regresi memastikan jumlah query tidak tumbuh per baris. SQL dari source aktual diuji pada database development: 100 penjualan + replay sekitar 3.962 ms, 100 mutasi kas + replay sekitar 3.659 ms. Semua data uji di-rollback dan pemeriksaan setelahnya memastikan tidak tersimpan. Tidak ada transaksi aktif ketika backend di-restart. Durasi tersebut pengujian lokal, bukan jaminan semua file atau koneksi.

Modal/untung historis masih dihitung dari HPP dan resep saat ini, bukan snapshot biaya transaksi pada tanggal penjualan. Karena itu tampilannya sekarang menyebut estimasi. Angka tersebut dapat berubah ketika HPP/resep berubah.
