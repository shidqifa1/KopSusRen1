import postgres from 'postgres';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL wajib tersedia');

const db = postgres(process.env.DATABASE_URL, { prepare: false, max: 4 });
const suffix = Date.now();
const deliveryDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const openAt = new Date(Date.now() - 60_000).toISOString();
const cutoffAt = new Date(Date.now() + 60 * 60_000).toISOString();
let poId = null;
const createdOrderIds = new Set();

async function createOrder(productId, quantity, key, phone) {
  const rows = await db`select create_order_bundle(
    ${`Concurrency ${phone.slice(-2)}`}, ${'TEST'}, ${poId},
    ${db.json([{ productId, quantity, noIce: false, notes: null }])},
    ${'CASH'}, ${'Tes concurrency otomatis'}, ${'WHATSAPP'}, ${key}, ${phone}
  ) as id`;
  createdOrderIds.add(rows[0].id);
  return rows[0].id;
}

try {
  const existing = await db`select id from po_sessions where status='OPEN' limit 1`;
  if (existing.length) throw new Error('Tutup PO aktif sebelum menjalankan tes concurrency');

  const productRows = await db`select id from products where is_active order by code limit 1`;
  if (!productRows.length) throw new Error('Tidak ada produk aktif untuk dites');
  const productId = productRows[0].id;

  const poRows = await db`select create_po(
    ${`E2E Concurrency ${suffix}`}, ${deliveryDate}, ${openAt}, ${cutoffAt},
    ${2}, ${db.json([])}, ${30}
  ) as id`;
  poId = poRows[0].id;
  await db`select set_po_status(${poId}, 'OPEN')`;

  const contention = await Promise.allSettled([
    createOrder(productId, 2, `e2e-race-a-${suffix}`, '6280000010001'),
    createOrder(productId, 2, `e2e-race-b-${suffix}`, '6280000010002'),
  ]);
  const contentionSuccess = contention.filter(result => result.status === 'fulfilled');
  const contentionFailure = contention.filter(result => result.status === 'rejected');
  if (contentionSuccess.length !== 1 || contentionFailure.length !== 1) {
    throw new Error(`Race kapasitas tidak aman: ${JSON.stringify(contention.map(result => result.status))}`);
  }

  for (const id of [...createdOrderIds]) {
    await db`select cancel_order(${id}, ${'Pembersihan fase contention'})`;
  }
  createdOrderIds.clear();

  const duplicateKey = `e2e-same-key-${suffix}`;
  const duplicates = await Promise.allSettled([
    createOrder(productId, 1, duplicateKey, '6280000010003'),
    createOrder(productId, 1, duplicateKey, '6280000010003'),
  ]);
  if (!duplicates.every(result => result.status === 'fulfilled')) {
    throw new Error(`Retry idempotent bersamaan gagal: ${duplicates.map(result => result.status==='rejected'?`${result.reason.code}: ${result.reason.message}`:result.status).join(', ')}`);
  }
  const duplicateIds = duplicates.map(result => result.value);
  if (new Set(duplicateIds).size !== 1) throw new Error('Idempotency key yang sama menghasilkan order berbeda');

  const rows = await db`select count(*)::int total from orders where idempotency_key=${duplicateKey}`;
  if (Number(rows[0].total) !== 1) throw new Error('Database menyimpan order duplikat');

  console.log(JSON.stringify({
    ok: true,
    lastCapacityOnlyAcceptedOnce: true,
    concurrentIdempotentRetryReturnedSameOrder: true,
    duplicateOrderRows: Number(rows[0].total),
  }, null, 2));
} finally {
  for (const id of createdOrderIds) {
    const rows = await db`select status from orders where id=${id}`;
    if (rows.length && !['CANCELLED', 'REJECTED'].includes(rows[0].status)) {
      await db`select cancel_order(${id}, ${'Pembersihan E2E concurrency'})`;
    }
  }
  if (poId) {
    const rows = await db`select status from po_sessions where id=${poId}`;
    if (rows.length && !['CLOSED', 'COMPLETED', 'CANCELLED'].includes(rows[0].status)) {
      await db`select set_po_status(${poId}, 'CLOSED')`;
    }
  }
  await db.end();
}
