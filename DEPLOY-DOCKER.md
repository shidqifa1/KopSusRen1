# Deploy KopSusRen V2 ke server Docker

Stack ini menjalankan aplikasi dalam tiga container:

- `web`: frontend dan API Kopi Manager;
- `gateway`: koneksi WhatsApp Baileys;
- `proxy`: Caddy untuk HTTP/HTTPS.

Database tidak diduplikasi. Web dan gateway tetap memakai database Supabase Kopi Manager yang sama melalui `DATABASE_URL`.

## 1. Persiapan server

Pasang Git, Docker Engine, dan Docker Compose plugin. Buka port TCP `80` dan `443`, serta UDP `443` jika HTTP/3 ingin digunakan.

Clone repository lalu masuk ke folder project:

```bash
git clone git@github.com:shidqifa1/kopsusren-v2.git
cd kopsusren-v2
./setup-server.sh
```

Setup interaktif tersebut akan meminta domain/IP, koneksi Supabase, login web,
nomor WhatsApp, Groq API key, dan URL QRIS. Secret internal dan hash password
dibuat otomatis. Setelah validasi, setup dapat langsung membangun dan menyalakan
seluruh stack Docker.

Jalankan script di **host server Docker**, bukan dari dalam container `web` atau
`gateway`, karena script ini mengelola seluruh stack dan volume.

Jika tidak ingin memakai setup interaktif, konfigurasi manual tetap dapat dibuat:

```bash
cp .env.server.example .env.server
chmod 600 .env.server
```

Isi `.env.server` langsung di server. Jangan commit atau mengirim file tersebut melalui GitHub.

Untuk domain dengan HTTPS otomatis:

```text
APP_ADDRESS=kopi.domainkamu.com
QRIS_IMAGE_URL=https://kopi.domainkamu.com/assets/qris-kopsusren.jpeg
```

Untuk tes memakai IP tanpa domain:

```text
APP_ADDRESS=:80
QRIS_IMAGE_URL=http://IP_SERVER/assets/qris-kopsusren.jpeg
```

`DATABASE_URL`, `AUTH_SECRET`, `VALID_PASSWORD_HASH`, `WA_SHARED_SECRET`, dan `GROQ_API_KEY` harus disimpan hanya di `.env.server`. Jangan menyalinnya ke source code.

## 2. Build dan start

Pastikan gateway di laptop sudah dihentikan. Satu akun WhatsApp tidak boleh dijalankan oleh dua gateway bersamaan.

```bash
docker compose --env-file .env.server config
docker compose --env-file .env.server up -d --build
docker compose ps
```

Pantau pairing WhatsApp pertama:

```bash
docker compose logs -f gateway
```

Masukkan pairing code di WhatsApp → Perangkat tertaut. Sesi disimpan di volume `whatsapp_session`, sehingga restart container tidak meminta pairing ulang.

Periksa web:

```bash
curl -fsS http://127.0.0.1/healthz
```

## 3. Update berikutnya

```bash
git pull --ff-only
docker compose --env-file .env.server up -d --build
docker compose ps
```

## 4. Operasional

Lihat log tanpa menampilkan secret:

```bash
docker compose logs --tail=200 web
docker compose logs --tail=200 gateway
docker compose logs --tail=100 proxy
```

Restart service tertentu:

```bash
docker compose restart web
docker compose restart gateway
```

Backup sesi WhatsApp:

```bash
docker run --rm -v kopsusren-v2_whatsapp_session:/data -v "$PWD":/backup alpine tar czf /backup/whatsapp-session-backup.tgz -C /data .
```

File backup sesi WhatsApp bersifat rahasia. Jangan upload ke GitHub atau cloud publik.

## 5. Cutover

1. Pastikan web container sehat dan login berfungsi.
2. Pastikan `gateway` menampilkan `KopSusRen WhatsApp gateway connected.`.
3. Kirim satu pesan tes WhatsApp dan pastikan order muncul pada web server.
4. Pastikan hanya gateway server yang hidup.
5. Setelah stabil, arahkan domain ke IP server. Deployment Vercel boleh dipertahankan sementara sebagai fallback, tetapi jangan menyalakan gateway kedua.
