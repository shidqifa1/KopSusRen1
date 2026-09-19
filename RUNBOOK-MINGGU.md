# Runbook operasional KopSusRen

Target penggunaan: Minggu, 20 September 2026.

## 1. Nyalakan gateway WhatsApp

PC gateway harus menyala, tersambung internet, dan tidak sleep selama PO dibuka.

PowerShell:

```powershell
Set-Location "\\192.168.1.110\kerjaan\kopsusren-v2"
npm install
npm run check
npm run gateway:wa
```

Biarkan terminal terakhir tetap terbuka. Log yang sehat menampilkan:

```text
KopSusRen WhatsApp gateway connected.
```

Di web buka **Status WhatsApp**. Status harus **Terhubung** dan waktu heartbeat tidak lebih dari 90 detik.

## 2. Buka PO dari web

1. Buka <https://kopsusren-v2.vercel.app> dan login.
2. Masuk ke **PO & Orders**.
3. Isi nama PO, jam buka, jam tutup, susu yang dibawa, dan max cup.
4. Klik **Buka PO sekarang**.
5. Pastikan status berubah menjadi **OPEN** sebelum menerima order.

Sistem memvalidasi stok/resep saat PO dibuka. Order WhatsApp akan masuk ke database dan daftar order web yang sama.

## 3. Tes customer sebelum menyebarkan nomor

Gunakan nomor selain nomor owner, lalu kirim:

```text
gua mau mesen dong
```

Pilih satu menu, misalnya:

```text
kopsus 1
```

Lanjutkan nama dan pembayaran:

```text
Faadhil 8.2
cash
gas
```

Hasil yang benar:

- bot tidak menanyakan informasi yang sudah diberikan;
- satu cart menjadi satu order;
- order muncul di **PO & Orders**;
- bahan langsung berstatus reserved;
- cash berstatus belum lunas sampai dikonfirmasi kasir.

## 4. Proses cash

1. Customer memilih cash dan order langsung diterima bila PO/stok masih tersedia.
2. Saat customer membayar, buka order terkait di **PO & Orders**.
3. Klik **Konfirmasi tunai**.
4. Setelah minuman dibuat/diserahkan, klik **Pesanan selesai**.

## 5. Proses QRIS

QRIS hanya boleh dipakai setelah `QRIS_IMAGE_URL` berisi URL publik gambar QRIS asli di Vercel Environment Variables. Jika belum diset, bot akan meminta customer memilih cash dan tidak membuat janji pembayaran palsu.

Setelah QRIS aktif:

1. Customer memilih QRIS lalu mengonfirmasi cart.
2. Bot mengirim gambar QRIS.
3. Customer mengirim bukti pembayaran.
4. Owner menerima notifikasi order.
5. Owner membalas `confirm qris #NOMOR_ORDER` setelah uang benar-benar masuk.

## 6. Owner mode

Nomor `6285175403169` dikenali sebagai owner. Contoh pertanyaan:

```text
stok susu berapa?
berapa pesanan yang masuk?
siapa yang belum bayar?
ringkasin kebutuhan produksi
close po
```

Aksi penting seperti menutup PO meminta konfirmasi kedua.

## 7. Tutup PO

PO tertutup otomatis saat jam tutup. Owner juga dapat menutup lewat web atau WhatsApp. Setelah tutup, cek ringkasan menu, kebutuhan bahan, pembayaran, dan produksi sebelum mematikan gateway.

## Checklist hari-H

- [ ] PC gateway menyala dan tidak sleep.
- [ ] `npm run gateway:wa` menunjukkan connected.
- [ ] Status WhatsApp di web Terhubung.
- [ ] PO yang benar berstatus OPEN.
- [ ] Satu order cash dummy berhasil dan terlihat di web.
- [ ] Reservation bahan bertambah sesuai resep.
- [ ] QRIS dimatikan/dihindari bila gambar belum dipasang.
- [ ] Jam tutup PO sudah benar.
