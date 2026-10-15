# Tes WhatsApp Lokal

Backend web dan WhatsApp memakai database development yang sama. Tes ini akan menulis draft, order, pembayaran, dan reservation ke database tersebut. Groq hanya menerjemahkan chat menjadi JSON; harga, stok, dan transaksi ditentukan backend/RPC.

## Jalankan backend

```bash
npm run build:docker
HOST=127.0.0.1 PORT=3187 node --env-file=.env.local server/http.mjs
```

Buka http://127.0.0.1:3187 dan login dengan akun yang sudah dikonfigurasi. `.env.local` memakai pooler project development yang sama, `WA_BACKEND_URL=http://127.0.0.1:3187/api/v2/commands`, dan gambar QRIS lokal. Jangan mengunggah file konfigurasi atau `baileys_auth`.

Di terminal lain, cek API dan DB:

```bash
node --env-file=.env.local scripts/smoke-deployment.mjs http://127.0.0.1:3187
```

## Siapkan PO dan gateway

Di **PO & Order**, pastikan stok dan resep tersedia, tutup PO lama bila masih OPEN, lalu buka PO dengan waktu tutup yang belum lewat. Tanpa PO aktif, bot tetap menjawab menu tetapi menolak order baru.

```bash
npm run gateway:wa
```

Gateway langsung membalas pesan masuk dan dapat mengirim notifikasi owner/customer. Jika sesi belum terhubung, scan QR lewat WhatsApp > Linked devices. Gunakan nomor WhatsApp lain untuk chat ke nomor bot; pesan dari akun bot sendiri dilewati. Nomor pengirim tes customer jangan termasuk `WA_OWNER_NUMBERS`.

## Coba percakapan

Kirim bertahap: `menu`, lalu `dua kopsus buat Budi cash`, lalu `yang satu tanpa es`. Periksa ringkasan sebelum membalas `gas`. Satu cart harus menjadi satu order dua cup dengan satu cup tanpa es, berstatus pembayaran `UNPAID`.

Untuk QRIS, buat pesanan baru dengan `qris`, konfirmasi, lalu kirim gambar bukti. Pembayaran harus tetap `PENDING` sampai owner memverifikasi. Periksa order dan pembayaran di web. Coba produk yang tidak ada; bot harus meminta klarifikasi.

## Pemeriksaan dan batas verifikasi

```bash
npm run check
node evals/run-parser-slice1.mjs --mode=mock
node --env-file=.env.local evals/run-parser-slice1.mjs --mode=live
npm run eval:chatbot
```

Mock memeriksa validasi/safety, bukan akurasi bahasa Groq. `eval:chatbot` hanya deterministic fast path; hasilnya bukan skor live Groq. Mode shadow belum tersedia pada DB yang diperiksa karena migration 013 belum diterapkan; penerapannya perlu persetujuan perubahan skema.

Hentikan gateway dan backend dengan Ctrl+C. Membatalkan order tes harus lewat alur aplikasi agar reservation ikut dilepas.
