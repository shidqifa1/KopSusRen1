import postgres from 'postgres';

const baseUrl = process.argv[2] || 'https://kopsusren-v2.vercel.app';
const databaseUrl = process.env.DATABASE_URL;
const sharedSecret = process.env.WA_SHARED_SECRET;
const ownerPhone = String(process.env.WA_OWNER_NUMBERS || '')
  .split(',')
  .map(value => value.replace(/\D/g, ''))
  .find(Boolean);

if (!databaseUrl || !sharedSecret || !ownerPhone) {
  throw new Error('DATABASE_URL, WA_SHARED_SECRET, dan WA_OWNER_NUMBERS wajib tersedia');
}

const db = postgres(databaseUrl, { prepare: false, max: 1 });

async function resetOwnerConversation() {
  await db`
    insert into conversation_order_states(channel, customer_phone, order_state, status, last_message_at)
    values('whatsapp', ${ownerPhone}, '{}'::jsonb, 'confirmed', now())
    on conflict(channel, customer_phone) do update
      set order_state='{}'::jsonb, status='confirmed', last_message_at=now(), updated_at=now()
  `;
}

async function send(text, suffix) {
  const messageId = `e2e-owner-po-${Date.now()}-${suffix}`;
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
        phone: ownerPhone,
        pushName: 'Owner E2E',
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

async function ownerState() {
  const rows = await db`
    select order_state
    from conversation_order_states
    where channel='whatsapp' and customer_phone=${ownerPhone}
    limit 1
  `;
  return rows[0]?.order_state || {};
}

async function poCount() {
  const rows = await db`select count(*)::int total from po_sessions`;
  return Number(rows[0]?.total || 0);
}

try {
  const before = await poCount();

  await resetOwnerConversation();
  const midnightReply = await send(
    'buat hari ini buka dari sekarang tutupnya nanti jam 12 malem aja dan susu gua cuma bawa 2000ml',
    'midnight',
  );
  const midnightState = await ownerState();
  const midnight = midnightState.pending_owner_po || {};
  if (midnight.closeTime !== '00:00') throw new Error(`12 malam tidak menjadi 00:00: ${midnight.closeTime}`);
  if (!midnight.closeDate || midnight.closeDate <= midnight.date) {
    throw new Error(`12 malam tidak bergeser ke hari berikutnya: ${midnight.date} -> ${midnight.closeDate}`);
  }
  if (midnight.maxCups) throw new Error('E2E midnight tidak boleh mempunyai max cup');

  await resetOwnerConversation();
  const durationReply = await send(
    'buat hari ini buka dari sekarang, tutup satu jam setelah buka, susu 2000 ml',
    'duration',
  );
  const durationState = await ownerState();
  const duration = durationState.pending_owner_po || {};
  const openAt = new Date(`${duration.date}T${duration.openTime}:00+07:00`);
  const closeAt = new Date(`${duration.closeDate || duration.date}T${duration.closeTime}:00+07:00`);
  const representedMinutes = Number(duration.durationMinutes)
    || Math.round((closeAt.getTime() - openAt.getTime()) / 60_000);
  if (representedMinutes !== 60) {
    throw new Error(`Durasi relatif tidak menjadi 60 menit: ${JSON.stringify({ reply: durationReply.replyText, state: durationState })}`);
  }
  if (duration.maxCups) throw new Error('E2E duration tidak boleh mempunyai max cup');

  const after = await poCount();
  if (after !== before) throw new Error(`E2E tidak boleh membuat PO: ${before} -> ${after}`);

  console.log(JSON.stringify({
    ok: true,
    poCountUnchanged: true,
    midnight: {
      openTime: midnight.openTime,
      closeTime: midnight.closeTime,
      closeDate: midnight.closeDate,
      reply: midnightReply.replyText,
    },
    relativeDuration: {
      representedMinutes,
      openTime: duration.openTime,
      closeTime: duration.closeTime,
      closeDate: duration.closeDate,
      reply: durationReply.replyText,
    },
  }, null, 2));
} finally {
  await resetOwnerConversation();
  await db.end();
}
