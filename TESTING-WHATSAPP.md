# Uji branch WhatsApp

Branch: `codex/whatsapp-order-reliability`. Belum ditujukan untuk peluncuran customer.
Tidak ada migration, perubahan RPC, atau konfigurasi production.

## Yang biasa

1. Pakai nomor customer uji yang berbeda dari `WA_OWNER_NUMBERS`.
2. Buat satu order lewat WhatsApp, misalnya 3 aren less ice. Selesaikan proses pembayaran dan order melalui web seperti biasa sampai status order `FULFILLED`.
3. Buka PO uji berikutnya dan kirim `yang biasa ya 1` dari nomor yang sama.
4. Bot menyebut menu/varian dari **order WhatsApp selesai terakhir** dan harga saat ini. Ini usulan, bukan bukti preferensi tetap.
5. Balas `iya`. Bot membuat draft 1 cup, meminta nama dan pembayaran yang belum diisi, lalu memberi ringkasan akhir. Tidak menyalin cara bayar atau jumlah 3 cup dari order lama.
6. Konfirmasi ringkasan akhir dengan `gas`. Cocokkan order, jumlah, catatan, dan reservasi di web.

Skenario tambahan:

| Pesan/kondisi | Hasil yang diharapkan |
| --- | --- |
| `yang biasa` | Sebut menu terakhir, tanya jumlah; sesudah jumlah diisi tetap minta persetujuan menu |
| `bukan` setelah usulan | Hapus usulan, tanya menu baru |
| Nomor baru atau hanya punya order batal/belum selesai | Tanya menu; jangan menebak berdasarkan nama customer |
| Order terakhir punya beberapa menu/varian | Minta pilihan menu dan catatan secara eksplisit |
| Catatan lama bukan modifier standar | Minta customer menjelaskan lagi catatannya |
| Menu nonaktif, stok kurang, atau PO tutup | Jangan membuat order atau mengganti menu otomatis |
| Ada draft berisi item | Jangan menimpa atau menambah pesanan biasa diam-diam |
| `yang biasa 1 tambah matcha 2` | Minta customer menyebut menu dan jumlah secara jelas; pesan campuran ini belum didukung fast path |

Riwayat menggunakan `orders.customer_phone` persis dari nomor pengirim dan `source='WHATSAPP'`, bukan nama/kelas atau nomor master customer.

## Ringkasan dan konfirmasi

- Ringkasan menampilkan modifier dan catatan item.
- Sesudah ringkasan ditampilkan, ubah harga menu melalui web, lalu kirim `gas`: bot harus menampilkan ringkasan terbaru dan meminta konfirmasi ulang. Order dibuat setelah `gas` berikutnya.
- Mengirim `lihat menu` di antara perubahan harga dan konfirmasi tidak boleh melewati pemeriksaan ini.
- Draft dari versi lama yang belum memiliki snapshot konfirmasi diminta konfirmasi ulang satu kali.
- Reservasi dan transaksi tetap melewati `create_order_bundle` yang sudah ada. Pencegahan duplicate webhook dan pemeriksaan kapasitas akhir tetap memakai mekanisme repo.

## Diskusi owner berdasarkan data terbaru

Command manual (`/help`, `/stok list`, `/produksi aktif`, dan lainnya) tetap tanpa panggilan AI. Diskusi bebas sekarang menerima snapshot baca dari database: stok fisik/reservasi/tersedia, menu/harga/resep, PO aktif/terjadwal beserta ringkasannya, nilai order dan ranking menu 7×24 jam terakhir, serta saldo akun. Query tetap ditulis backend; AI tidak mendapat akses SQL atau kredensial. Snapshot dibaca ulang untuk setiap konsultasi dan waktu datanya ditampilkan dalam WIB.

Coba dari nomor owner:

1. `Kalau mau tambahan 15 cup, bahan apa yang kurang?`
2. `Kalau 40 cup?`
3. `Menu mana yang paling laku seminggu ini, dan apa saranmu?`
4. Cocokkan fakta di jawaban dengan web. Ubah stok lewat web, lalu tanyakan ulang: jawaban harus memakai snapshot baru.
5. Matikan akses DB pada lingkungan uji: konsultasi tidak boleh menjawab seolah masih punya data live.

Enam pesan konsultasi terakhir disimpan sebagai konteks lanjutan; snapshot database tidak disimpan sebagai memori. Hitungan kebutuhan bahan dibuat kode dari resep standar dan stok tersedia. Target angka eksplisit `15 cup`/`40 gelas` didukung sampai 1000; tiap menu adalah alternatif skenario, **bukan kapasitas gabungan**. Untuk campuran menu atau variasi khusus, gunakan rekap PO aktual atau minta perincian; simulasi ini tidak menjanjikan kapasitas jual di luar limit PO.

Biaya bahan memakai average cost yang tercatat; biaya belum diketahui ditandai `null`, bukan dianggap gratis. Nilai order tidak sama dengan saldo kas: order belum lunas ikut nilai order, sedangkan saldo dibaca dari ledger akun. Jawaban AI tetap perlu pengujian provider nyata untuk menilai kepatuhan terhadap fakta dan gaya bahasa.

## Ambil alih percakapan

- Dari nomor owner, kirim `/chat ambil 628...`, lalu `Y`. Customer harus sudah pernah menghubungi bot. Bot berhenti membalas teks maupun gambar customer itu dan tidak memanggil AI.
- Tangani customer manual. Kirim `/chat lanjut 628...`, lalu `Y` untuk mengaktifkan lagi. Draft dipertahankan, tetapi persetujuan ringkasan lama dibatalkan.
- Setelah dua kegagalan pemahaman berulang, bot mengirim pemberitahuan owner dan menjeda percakapan otomatis bila `WA_OWNER_NUMBERS` terisi. Notifikasi berisi nomor customer, alasan, draft, dan cara mengaktifkan bot lagi.
- Tanpa nomor owner terkonfigurasi, bot tidak mengunci customer dalam jeda yang tidak bisa dipulihkan.
- Gambar pembayaran selama jeda tetap perlu ditangani owner; bot tidak mencatat buktinya otomatis selama percakapan dijeda.
- Command ini hanya mengontrol percakapan; membalas manual tidak membuat order atau pembayaran otomatis. Catat transaksi yang ditangani manual lewat web.

## Menjalankan

Gunakan database development, nomor WhatsApp uji, dan konfigurasi lokal sesuai `README-V2.md` / `LOCAL-WHATSAPP-TEST.md`. Jangan sambungkan gateway uji ke endpoint production. Jangan menyalakan dua gateway dengan sesi WhatsApp yang sama.

```bash
npm ci
npm run check
npm run eval:chatbot
npm run build:docker
# Dengan .env.local development yang sudah diisi:
npm run eval:chatbot:groq
node --env-file=.env.local node_modules/vercel/dist/vc.js dev
# Terminal terpisah; endpoint gateway diarahkan ke API development:
npm run gateway:wa
```

Tes `usual-order-flow` menjalankan handler produksi dengan fixture SQL; tidak mengakses database sungguhan. Evaluasi default hanya menguji deterministic fast path. Dataset bahasa bebas tetap membutuhkan evaluasi Groq; status proses keluar 0 tidak berarti threshold acceptance lulus. Tanpa konfigurasi lokal, pengujian WhatsApp, database nyata, dan provider AI belum terverifikasi.
