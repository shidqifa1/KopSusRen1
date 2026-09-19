import postgres from 'postgres';

const baseUrl = process.argv[2] || 'https://kopsusren-v2.vercel.app';
const databaseUrl = process.env.DATABASE_URL;
const sharedSecret = process.env.WA_SHARED_SECRET;
const ownerPhone = String(process.env.WA_OWNER_NUMBERS || '')
  .split(',')
  .map(value => value.replace(/\D/g, ''))
  .find(Boolean);
const customerPhone = '6280000009914';

if (!databaseUrl || !sharedSecret || !ownerPhone) {
  throw new Error('DATABASE_URL, WA_SHARED_SECRET, dan WA_OWNER_NUMBERS wajib tersedia');
}

const db = postgres(databaseUrl, { prepare: false, max: 1 });
const beforePoIds = new Set((await db`select id::text id from po_sessions`).map(row => row.id));
let testPoId = null;
let testOrderId = null;

async function resetConversation(phone) {
  await db`
    insert into conversation_order_states(channel, customer_phone, order_state, status, last_message_at)
    values('whatsapp', ${phone}, '{}'::jsonb, 'confirmed', now())
    on conflict(channel, customer_phone) do update
      set order_state='{}'::jsonb, status='confirmed', last_message_at=now(), updated_at=now()
  `;
}

async function send(phone, { text = '', hasImage = false }, suffix) {
  const messageId = `e2e-qris-${Date.now()}-${suffix}`;
  const response = await fetch(`${baseUrl}/api/v2/commands`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sharedSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'chat_inbound',
      payload: {
        provider: 'e2e', phone, text, hasImage,
        pushName: phone === ownerPhone ? 'Owner E2E' : 'Customer E2E',
        waMessageId: messageId, messageId, receivedAt: new Date().toISOString(),
      },
    }),
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(`Respons non-JSON (${response.status}): ${raw.slice(0,120)}`); }
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function qrisBalance() {
  const rows = await db`select balance::float8 balance from account_balances where type='QRIS' order by name limit 1`;
  return Number(rows[0]?.balance || 0);
}

try {
  const openBefore = await db`select id from po_sessions where status='OPEN' limit 1`;
  if (openBefore.length) throw new Error('E2E QRIS hanya boleh dijalankan saat tidak ada PO aktif');
  const balanceBefore = await qrisBalance();

  await resetConversation(ownerPhone);
  await resetConversation(customerPhone);

  const ownerOpen = await send(ownerPhone, {
    text: 'buka PO hari ini dari sekarang sampai satu jam lagi, max 2 cup, susu 500 ml',
  }, 'open-po');
  const newPos = await db`select id::text id,status from po_sessions order by created_at desc`;
  const testPo = newPos.find(row => !beforePoIds.has(row.id));
  if (!testPo || testPo.status !== 'OPEN') throw new Error(`PO QRIS test gagal dibuka: ${ownerOpen.replyText}`);
  testPoId = testPo.id;

  const selection = await send(customerPhone, {
    text: 'gue mau matcha satu buat Citra 8.3, bayarnya qris',
  }, 'selection');
  if (!/Matcha/i.test(selection.replyText || '') || !/Citra/i.test(selection.replyText || '') || !/QRIS/i.test(selection.replyText || '')) {
    throw new Error(`Draft QRIS multi-intent salah: ${selection.replyText}`);
  }

  const confirmed = await send(customerPhone, { text: 'gas' }, 'confirm');
  if (!Array.isArray(confirmed.orderIds) || confirmed.orderIds.length !== 1 || !confirmed.qrisImageUrl) {
    throw new Error(`Order/QRIS image tidak terbentuk: ${confirmed.replyText}`);
  }
  testOrderId = confirmed.orderIds[0];

  const beforeProofRows = await db`
    select o.order_number,p.status,p.expires_at,p.proof_received_at
    from orders o join payments p on p.order_id=o.id where o.id=${testOrderId}
  `;
  const beforeProof = beforeProofRows[0];
  if (!beforeProof || beforeProof.status !== 'PENDING' || !beforeProof.expires_at || beforeProof.proof_received_at) {
    throw new Error('Payment QRIS awal tidak PENDING dengan timeout');
  }

  const proof = await send(customerPhone, { hasImage: true }, 'proof');
  if (!/bukti.*diterima/i.test(proof.replyText || '') || !proof.ownerNotifications?.some(item => item.phone === ownerPhone)) {
    throw new Error(`Bukti/notifikasi owner salah: ${proof.replyText}`);
  }
  const proofRows = await db`select proof_received_at from payments where order_id=${testOrderId}`;
  if (!proofRows[0]?.proof_received_at) throw new Error('proof_received_at belum tersimpan');

  const ownerConfirm = await send(ownerPhone, {
    text: `yang order #${beforeProof.order_number} qrisnya udah masuk, konfirmasi ya`,
  }, 'owner-confirm');
  if (!/dikonfirmasi/i.test(ownerConfirm.replyText || '') || !ownerConfirm.customerNotifications?.some(item => item.phone === customerPhone)) {
    throw new Error(`Konfirmasi/notifikasi customer salah: ${ownerConfirm.replyText}`);
  }
  const paidRows = await db`select status from payments where order_id=${testOrderId}`;
  if (paidRows[0]?.status !== 'PAID') throw new Error('Payment QRIS tidak berubah menjadi PAID');

  await db`select cancel_order(${testOrderId},'Pembersihan E2E QRIS')`;
  const cleanupRows = await db`
    select p.status payment_status,
           count(*) filter(where ir.status='RELEASED')::int released,
           count(ir.id)::int reservations
    from payments p left join inventory_reservations ir on ir.order_id=p.order_id
    where p.order_id=${testOrderId}
    group by p.id
  `;
  const cleanup = cleanupRows[0];
  if (cleanup?.payment_status !== 'REFUNDED' || cleanup.released !== cleanup.reservations) {
    throw new Error('Cleanup QRIS tidak merefund pembayaran/melepas reservation');
  }
  if (await qrisBalance() !== balanceBefore) throw new Error('Saldo QRIS tidak kembali setelah cleanup');

  console.log(JSON.stringify({
    ok: true,
    ownerOpenReply: ownerOpen.replyText,
    selectionReply: selection.replyText,
    confirmedReply: confirmed.replyText,
    proofReply: proof.replyText,
    ownerConfirmReply: ownerConfirm.replyText,
    pendingWithTimeout: true,
    proofStored: true,
    ownerNotified: true,
    paidAfterOwnerConfirm: true,
    customerNotified: true,
    cleanupRefunded: true,
    balanceUnchanged: true,
  }, null, 2));
} finally {
  if (testOrderId) {
    const active = await db`select status from orders where id=${testOrderId}`;
    if (active.length && !['CANCELLED','REJECTED'].includes(active[0].status)) {
      await db`select cancel_order(${testOrderId},'Pembersihan E2E QRIS')`;
    }
  }
  if (testPoId) {
    const po = await db`select status from po_sessions where id=${testPoId}`;
    if (po.length && !['CLOSED','COMPLETED','CANCELLED'].includes(po[0].status)) {
      await db`select set_po_status(${testPoId},'CLOSED')`;
    }
  }
  await resetConversation(ownerPhone);
  await resetConversation(customerPhone);
  await db.end();
}
