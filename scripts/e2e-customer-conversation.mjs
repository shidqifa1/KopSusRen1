import postgres from 'postgres';

const baseUrl = process.argv[2] || 'https://kopsusren-v2.vercel.app';
const databaseUrl = process.env.DATABASE_URL;
const sharedSecret = process.env.WA_SHARED_SECRET;
const ownerPhone = String(process.env.WA_OWNER_NUMBERS || '')
  .split(',')
  .map(value => value.replace(/\D/g, ''))
  .find(Boolean);
const customerPhone = '6280000009913';

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

async function send(phone, text, suffix, fixedMessageId = null) {
  const messageId = fixedMessageId || `e2e-customer-${Date.now()}-${suffix}`;
  const response = await fetch(`${baseUrl}/api/v2/commands`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sharedSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'chat_inbound',
      payload: {
        provider: 'e2e',
        phone,
        pushName: phone === ownerPhone ? 'Owner E2E' : 'Customer E2E',
        text,
        waMessageId: messageId,
        messageId,
        receivedAt: new Date().toISOString(),
      },
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

try {
  const openBefore = await db`select id from po_sessions where status='OPEN' limit 1`;
  if (openBefore.length) throw new Error('E2E customer hanya boleh dijalankan saat tidak ada PO aktif');

  await resetConversation(ownerPhone);
  await resetConversation(customerPhone);

  const owner = await send(
    ownerPhone,
    'buat hari ini buka dari sekarang, tutup satu jam setelah buka, max 4 cup, susu 1000 ml',
    'open-po',
  );
  const newPos = await db`select id::text id,status from po_sessions order by created_at desc`;
  const testPo = newPos.find(row => !beforePoIds.has(row.id));
  if (!testPo || testPo.status !== 'OPEN') {
    throw new Error(`Owner AI tidak membuka PO test: ${owner.replyText}`);
  }
  testPoId = testPo.id;

  const start = await send(customerPhone, 'hai, gue mau pesen dong', 'start');
  if (!/menu|pesan apa/i.test(start.replyText || '')) throw new Error(`Start order tidak natural: ${start.replyText}`);

  const recommendation = await send(
    customerPhone,
    'gue mau yang ada kopinya tapi nggak terlalu pahit, enaknya apa?',
    'recommendation',
  );
  if (!/latte|kopi susu|kopsus/i.test(recommendation.replyText || '')) {
    throw new Error(`Rekomendasi tidak relevan: ${recommendation.replyText}`);
  }

  const selection = await send(
    customerPhone,
    'oke kopsus aja 2, yang satu no ice buat Faadhil 8.2, cash',
    'selection',
  );
  if (!/2x|1x/i.test(selection.replyText || '') || !/Faadhil/i.test(selection.replyText || '')) {
    throw new Error(`Draft multi-intent tidak lengkap: ${selection.replyText}`);
  }

  const correction = await send(customerPhone, 'eh namanya Budi aja', 'name-correction');
  if (!/Budi/i.test(correction.replyText || '') || /Nama:\s*Faadhil/i.test(correction.replyText || '')) {
    throw new Error(`Koreksi nama tidak diterapkan: ${correction.replyText}`);
  }

  const confirmMessageId = `e2e-customer-confirm-${Date.now()}`;
  const confirmed = await send(customerPhone, 'gas', 'confirm', confirmMessageId);
  if (!Array.isArray(confirmed.orderIds) || confirmed.orderIds.length !== 1) {
    throw new Error(`Konfirmasi tidak menghasilkan tepat satu order: ${confirmed.replyText}`);
  }
  testOrderId = confirmed.orderIds[0];

  const duplicate = await send(customerPhone, 'gas', 'confirm-duplicate', confirmMessageId);
  if (!duplicate.duplicate) throw new Error('Webhook duplikat tidak dikenali');

  const orderRows = await db`
    select o.id,o.source,o.status,o.customer_phone,o.total_amount::float8 total_amount,
           c.name,c.class_name,p.method,p.status payment_status,
           count(oi.id)::int item_rows,coalesce(sum(oi.qty),0)::int cups,
           count(*) filter(where oi.no_ice)::int no_ice_rows
    from orders o
    join customers c on c.id=o.customer_id
    join payments p on p.order_id=o.id
    join order_items oi on oi.order_id=o.id
    where o.id=${testOrderId}
    group by o.id,c.id,p.id
  `;
  const order = orderRows[0];
  if (!order) throw new Error('Order hasil chat tidak ditemukan di database utama');
  if (order.source !== 'WHATSAPP' || order.customer_phone !== customerPhone) throw new Error('Identitas/source order WhatsApp salah');
  if (order.name !== 'Budi' || order.class_name !== '8.2') throw new Error('Koreksi identitas customer tidak tersimpan');
  if (order.method !== 'CASH' || order.payment_status !== 'UNPAID') throw new Error('Cash seharusnya tetap UNPAID');
  if (order.cups !== 2 || order.item_rows !== 2 || order.no_ice_rows !== 1) {
    throw new Error(`Varian dua cup/satu no-ice tidak tersimpan benar: ${JSON.stringify({ order, selectionReply: selection.replyText })}`);
  }
  if (order.total_amount !== 16000) throw new Error(`Total order salah: ${order.total_amount}`);

  const reservations = await db`
    select count(*)::int total
    from inventory_reservations
    where order_id=${testOrderId} and status='ACTIVE'
  `;
  if (Number(reservations[0]?.total || 0) === 0) throw new Error('Reservation order tidak dibuat');

  console.log(JSON.stringify({
    ok: true,
    ownerReply: owner.replyText,
    startReply: start.replyText,
    recommendationReply: recommendation.replyText,
    selectionReply: selection.replyText,
    correctionReply: correction.replyText,
    confirmedReply: confirmed.replyText,
    oneOrder: true,
    cups: order.cups,
    itemRows: order.item_rows,
    oneNoIce: order.no_ice_rows === 1,
    cashStillUnpaid: order.payment_status === 'UNPAID',
    reservationCreated: true,
    duplicateBlocked: true,
  }, null, 2));
} finally {
  if (testOrderId) {
    const active = await db`select status from orders where id=${testOrderId}`;
    if (active.length && !['CANCELLED','REJECTED'].includes(active[0].status)) {
      await db`select cancel_order(${testOrderId},'Pembersihan E2E chatbot')`;
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
