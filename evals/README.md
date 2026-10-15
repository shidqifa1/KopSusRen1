# KopSusRen chatbot evaluation

Harness ini menguji parser dan safety pipeline customer-order secara offline. Dataset berisi ground truth yang ditulis manual dengan stable product code; model tidak pernah membuat atau mengubah expected output.

## Menjalankan evaluasi

```bash
npm run eval:chatbot
npm run eval:chatbot:groq
```

Mode default hanya menguji deterministic fast path dan tidak membutuhkan network. Mode Groq memakai parser produksi, membutuhkan `GROQ_API_KEY`, dan tetap tidak membuka koneksi database atau membuat order. Laporan JSON default ditulis ke `evals/latest-report.json` (diabaikan Git).

Argumen opsional:

```bash
node evals/run-evals.mjs --provider=groq --dataset=evals/chatbot-cases.json --output=/tmp/report.json
```

Evaluasi network tetap sequential. Default memberi jeda 750 ms antarturn network. Pada `429`, model yang sama dicoba ulang lebih dahulu dengan exponential backoff, bounded jitter, dan `Retry-After` bila tersedia. Default maksimum tiga attempt primary, base backoff 1 detik, dan cap 10 detik. Fallback 120b → 20b hanya dilakukan untuk kegagalan kompatibilitas strict schema, bukan karena `429`; fallback memiliki maksimum dua attempt.

Pengaturan dapat diubah untuk run evaluasi tanpa mengubah policy request produksi:

```bash
node evals/run-evals.mjs --provider=groq \
  --pacing-ms=1000 --max-primary-attempts=3 --max-fallback-attempts=2 \
  --base-backoff-ms=1000 --max-backoff-ms=10000 --jitter-ratio=0.2
```

Setiap report menyimpan telemetry aman per attempt: case/turn, nomor attempt, configured/requested/actual model, HTTP status, kategori error, latency, `Retry-After`, waktu backoff, status fallback, dan alasan fallback. Ringkasan report mencakup logical network turns, total model attempts, primary/retry/fallback successes, rate limit dan schema failure per model, serta total waktu backoff. API key, authorization header, dan secret tidak disimpan.

## Dataset

Setiap case memiliki `id`, `category`, dan satu atau lebih `turns`. Tiap turn menyimpan input serta expected intents, items (`productCode`, quantity, modifiers), ambiguity, sifat order/non-order, dan apakah state seharusnya sudah complete. Multi-turn mempertahankan draft hasil turn sebelumnya, tetapi tidak mengubah arsitektur state produksi.

Stable product codes saat ini: `KSGA`, `LATTE`, `AMERICANO`, dan `MATCHA`. UUID database dilarang di dataset.

## Definisi metrik

- **Intent accuracy**: proporsi turn dengan himpunan intent yang sama persis dengan ground truth.
- **Product accuracy**: proporsi turn ber-item dengan daftar product code yang benar, termasuk multiplicity item.
- **Quantity accuracy**: proporsi turn ber-item dengan produk dan kuantitas setiap item yang benar.
- **Modifier accuracy**: proporsi turn ber-item dengan produk dan authoritative modifiers setiap item yang benar.
- **Ambiguity detection**: proporsi pesan yang memang ambigu dan berhasil ditandai ambigu/unresolved oleh pipeline.
- **False-order rate**: proporsi pesan non-order yang menghasilkan item dan dinilai aman untuk dilanjutkan.
- **Complete-order accuracy**: proporsi expected-complete turn yang material interpretation-nya benar dan dinilai `SAFE`.
- **Single-turn slot-complete accuracy** (`singleTurnExpectedCompleteTurns`): expected-complete turn dari case satu turn yang cart-nya tepat dan dinilai `SAFE`.
- **Multi-turn draft-completion accuracy** (`multiTurnExpectedCompleteTurns`): expected-complete turn dari case multi-turn yang mencapai cart/state material tepat dan `SAFE`.
- **Explicit-confirmation success** (`explicitConfirmationTurns`): turn ground truth `CONFIRM_ORDER` yang berakhir material tepat dan `SAFE`.
- **Provider/parser availability** (`networkParserAttempts`): proporsi logical network turn yang menghasilkan structured parse.
- **End-to-end completion accuracy** (`expectedCompleteTurns`): nama eksplisit untuk historical `completeOrderAccuracy`; definisinya tetap sama.
- **Critical silent error rate**: proporsi seluruh turn dengan kesalahan material yang tetap dinilai `SAFE`.
- **Recoverable error rate**: proporsi seluruh turn dengan interpretasi salah/tidak lengkap yang ditahan oleh clarification/handoff.
- **Average parser latency**: rata-rata waktu parser per turn, dalam milidetik.
- **P95 parser latency**: latency persentil ke-95 per turn.

Metrik historis di atas tetap dipertahankan. D.2 menambahkan:

- **Parser success rate** (`allTurns`): turn yang menghasilkan structured parse, termasuk deterministic fast path.
- **Network parser success rate** (`networkParserAttempts`): request Groq/fallback yang menghasilkan structured parse.
- **Parser-success conditional metrics** (`parserSucceededTurns`): metrik material yang dihitung ulang hanya pada turn dengan parse berhasil. Ini tidak menggantikan hasil end-to-end.
- **Raw exact intent accuracy** (`allTurns`): exact intent-set seperti metrik historis.
- **Semantic/action intent accuracy** (`allTurns`): mengabaikan `START_ORDER` yang redundan jika pesan yang sama sudah memiliki item mutation; intent kritis lain tetap dibandingkan exact.
- **Independent product accuracy** (`itemBearingTurns`): kesamaan daftar product code tanpa mensyaratkan quantity/modifier benar.
- **Independent quantity accuracy** (`itemBearingTurns`): kesamaan multiset quantity tanpa digate oleh hasil produk.
- **Independent modifier accuracy** (`itemBearingTurns`): kesamaan multiset modifier-set tanpa digate oleh hasil produk.
- **Exact-cart accuracy** (`itemBearingTurns`): seluruh product, quantity, dan modifier cart harus tepat.
- **Parser-level false-order rate** (`expectedNonOrderTurns`): non-order yang sudah diberi order action atau item, terlepas dari safety gate.
- **Commit-safe false-order rate** (`expectedNonOrderTurns`): non-order salah yang juga dinilai aman; sama dengan historical false-order semantics.
- **Successful/failed network latency** (`successfulNetworkTurns` / `failedNetworkTurns`): average dan p95 dipisahkan agar provider failure tidak tercatat sebagai nol.

Setiap JSON report memiliki `denominators` eksplisit. Multi-turn tetap dihitung end-to-end; `upstreamParserFailure` dan `cascadingFailure` menandai kegagalan turunan tanpa menghapusnya dari score.

Perbedaan intent tanpa dampak pada produk, kuantitas, modifier, atau ambiguity diklasifikasikan `HARMLESS`. Kesalahan material yang dinilai aman adalah `CRITICAL`. Kesalahan yang ditahan safety gate adalah `RECOVERABLE`.

Threshold provisional tidak boleh diubah otomatis:

- complete-order accuracy >= 95%
- critical silent error rate < 1%
- ambiguous-message detection >= 95%
- false-order safe-acceptance kurang lebih 0%

## Shadow observations dan human labeling

Exporter hanya membaca kolom tersanitasi dari `chat_shadow_observations` dan menghasilkan kandidat label. Prediction parser ditempatkan terpisah dari `humanLabel`; prediction tidak pernah dianggap ground truth.

Untuk file JSON hasil ekspor database yang sudah tersedia:

```bash
node evals/export-shadow.mjs --input=/path/shadow-rows.json --output=/tmp/shadow-labeling.json
```

Untuk ekspor read-only langsung, harus diberikan secara eksplisit:

```bash
DATABASE_URL=... node evals/export-shadow.mjs --from-db --limit=500 --output=/tmp/shadow-labeling.json
```

Jangan commit hasil shadow. Review manusia wajib mengisi `humanLabel` sebelum sebuah pesan dianonimkan lebih lanjut dan dipindahkan manual menjadi case evaluasi.

## Contract yang belum diputuskan

Case `antar ke bandung ya` tetap memakai ground truth `UNKNOWN + ambiguous`. Implementasi saat ini dapat menganggapnya `OUT_OF_SCOPE`. Ground truth tidak diubah sampai keputusan produk menentukan apakah permintaan delivery yang tidak didukung harus ditolak langsung atau diklarifikasi.
