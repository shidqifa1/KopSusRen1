## Aturan anti-halu
- Sebelum mengubah apa pun, baca file terkait dulu. Sebut path dan nama fungsi yang benar-benar ada.
- Jangan mengarang nama tabel, kolom, RPC, atau API. Cek di supabase/migrations dan db/schema.
- Kalau tidak yakin, bilang "tidak tahu" dan tanya. Jangan menebak.
- Setiap klaim "selesai" harus disertai output asli dari `npm run check` dan `npm run eval:chatbot`.

## Aturan anti-overengineering
- Kerjakan hanya yang diminta di tugas. Hal lain dicatat sebagai saran, tidak dikerjakan.
- Dilarang menambah dependency, framework, atau layer abstraksi baru tanpa persetujuan.
- Abstraksi baru hanya boleh kalau sudah dipakai di 2+ tempat.
- Ikuti pola kode yang sudah ada. Lebih baik menghapus kode daripada menambah.
- Satu perubahan = maksimal sekitar 5 file. Kalau lebih, berhenti dan minta dipecah.

## Aturan anti-rusak
- Tulis tes regresi dulu untuk setiap bug atau perilaku baru.
- Jangan ubah tes yang sudah ada supaya lolos. Kalau tes harus berubah, jelaskan alasannya.
- Jangan sentuh skema DB, RPC yang sudah ada, atau konfigurasi production tanpa persetujuan.
- Output LLM selalu divalidasi schema. Ada batas retry dan timeout.
