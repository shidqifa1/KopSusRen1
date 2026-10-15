# Baristack App

Baristack App dan chatbot WhatsApp memakai database bisnis dan business service yang sama. WhatsApp hanya menjadi antarmuka tambahan; tidak ada stok, order, payment, atau PO versi chatbot.

Development deployment: https://kopsusren-v2.vercel.app

Status data: development/dummy. Jangan menjalankan `supabase/production_reset.sql` atau mengganti `APP_ENV` ke production sebelum fase go-live disetujui.

## Arsitektur

```text
WhatsApp / Baileys -> conversation orchestrator -> Groq structured extraction
                                              -> shared RPC -> Supabase utama
Web App --------------------------------------> shared RPC -> Supabase utama
```

Source of truth:

- produk/harga: `products`;
- resep: `recipes`, `recipe_items`;
- stok: `inventory_stock`, `inventory_movements`;
- reservation: `inventory_reservations`;
- PO: `po_sessions`, `po_product_limits`, `po_ingredient_limits`;
- order/payment: `orders`, `order_items`, `payments`;
- keuangan: `ledger_entries`, `accounts`;
- state komunikasi: `conversation_order_states`, `order_drafts`, `chat_messages`.

RPC utama bersama:

- `evaluate_po_availability`: availability live untuk web, chatbot, validasi order, dan maintenance;
- `create_order_bundle`: membuat satu order multi-item, payment, dan seluruh reservation secara atomik;
- `get_po_summary`: ringkasan menu, kebutuhan produksi, omzet, dan pembayaran;
- `run_po_maintenance`: membuka/menutup PO terjadwal dan menangani QRIS kedaluwarsa secara idempotent.

`create_order` tetap tersedia sebagai wrapper satu-item. Entry point lama tetap dipertahankan untuk compatibility.

## Migration

Jalankan secara berurutan:

1. `001_kopsusren_v2_schema.sql`
2. `002_business_functions.sql`
3. `003_dummy_seed.sql` (development saja)
4. `004_payment_guard_and_void.sql`
5. `005_chat_gateway_approval.sql`
6. `006_po_ingredient_capacity.sql`
7. `007_conversation_order_state.sql`
8. `008_shared_business_layer.sql`
9. `009_whatsapp_order_identity.sql`
10. `010_po_open_lock.sql`
11. `011_history_import.sql`
12. `012_recipe_exact_sync.sql`

Migration 008 bersifat additive dan menjadi business layer authoritative terbaru.
Migration 009 memisahkan identitas nomor WhatsApp per order agar customer bernama/kelas sama tidak saling melihat status pesanan.
Migration 011 menambahkan import riwayat penjualan/kas yang idempotent tanpa mengubah stok hari ini.
Migration 012 membuat penyimpanan resep bersifat exact-sync, termasuk menghapus bahan yang dihapus dari editor.

## Konfigurasi

Salin `.env.example` menjadi `.env.local`, lalu isi seluruh secret hanya di file lokal/Vercel Environment Variables. Jangan menaruh database URL, Groq key, gateway secret, atau password di frontend/repository.

Variabel chatbot penting:

```text
GROQ_API_KEY
GROQ_MODEL=openai/gpt-oss-120b
WA_SHARED_SECRET
WA_OWNER_NUMBERS=6285175403169
QRIS_IMAGE_URL
CHATBOT_V2_ENABLED=true
CHATBOT_MODE=confirmation
```

Gunakan `CHATBOT_MODE=shadow` untuk merekam interpretasi parser tanpa mengirim balasan AI atau mengubah draft, order, stok, reservation, maupun pembayaran customer. Owner commands tetap berjalan normal. Mode default `confirmation` mempertahankan flow chatbot operasional.

## Menjalankan dan memeriksa

```bash
npm install
npm run check
node --env-file=.env.local node_modules/vercel/dist/vc.js dev
```

Gateway WhatsApp dijalankan sebagai proses terpisah:

```bash
npm run gateway:wa
```

Gateway mengirim heartbeat berkala ke API yang sama. Heartbeat menjalankan maintenance PO idempotent dan memperbarui status gateway di web.

### Menjalankan seluruh aplikasi di Docker

`compose.yml` menjalankan frontend/API, gateway Baileys, dan reverse proxy Caddy. Keduanya tetap memakai satu database Supabase yang sama. Petunjuk server lengkap ada di [`DEPLOY-DOCKER.md`](DEPLOY-DOCKER.md).

Jangan memasukkan `.env.local`, `.env.server`, atau folder `baileys_auth` laptop ke image/repository. Semuanya sudah dikecualikan dari Git dan Docker build context. Hanya `.env.example` dan `.env.server.example` yang boleh diunggah.

## Workflow operasional

### PO

1. Di tab **PO & Order**, isi tanggal, jam buka, jam tutup, max cup opsional, batas QRIS, dan alokasi bahan.
2. PO langsung dibuka bila jam buka sudah lewat, atau tetap terjadwal sampai heartbeat berikutnya.
3. Availability dihitung dari stok, recipe, allocation, reservation aktif, product limit, dan max cup.
4. Habisnya satu bahan hanya menutup menu yang membutuhkan bahan tersebut. PO ditutup saat cutoff, ditutup owner, max cup habis, atau tidak ada menu aktif yang dapat dibuat.

### Customer WhatsApp

1. Customer bebas menulis natural, misalnya `3 kopsus buat Faadhil kelas 8.2 qris`.
2. Groq hanya mengekstrak intent/entity terstruktur; backend tetap menentukan produk, harga, availability, dan validasi.
3. Draft persistent menyimpan referensi `product_id`, bukan salinan stok/harga.
4. Saat customer mengonfirmasi, seluruh cart dibuat sebagai satu order atomik melalui `create_order_bundle`.

Cash tetap `UNPAID` sampai kasir mengonfirmasi di web. QRIS tetap `PENDING`; bukti menghentikan expiry dan owner mengonfirmasi atau menolak pembayaran.

### Owner WhatsApp

Nomor owner ditentukan server-side melalui `WA_OWNER_NUMBERS`. Owner dapat menanyakan stok, order, pembayaran, availability, dan production summary. Aksi penting seperti close PO, cancel order, dan adjustment inventory memakai konfirmasi dua langkah. Semua jawaban dan aksi memakai tabel/RPC yang sama dengan web.

### Belanja, pengeluaran, dan kas

Seluruh operasi kas berada di tab **Belanja & Pengeluaran** agar tidak ada dua layar yang mengubah sumber data yang sama. Tab ini memuat saldo kas live, belanja bahan, pemasukan/pengeluaran lain, import/export CSV kas, dan riwayat mutasi. Setiap mutation web mengambil ulang snapshot penuh dari database, sehingga saldo, ledger, pembelian, stok, dan laporan tidak tertinggal pada cache lama.

Export penjualan dan kas mengambil seluruh riwayat dari endpoint database khusus; batas jumlah baris pada dashboard hanya berlaku untuk tampilan, bukan untuk file export.

## Verifikasi sebelum deploy

```bash
npm run check
npx vercel build
npm run vercel:env
vercel deploy --prebuilt --prod --yes
npm run smoke:deployment
```

Acceptance penting: satu cart menghasilkan satu order, rollback bersifat all-or-nothing, dua pemesan stok terakhir tidak oversell, cash tidak auto-paid, QRIS berbukti tidak kedaluwarsa, duplicate message tidak menggandakan order, dan perubahan web/WhatsApp langsung terlihat tanpa proses sync.
