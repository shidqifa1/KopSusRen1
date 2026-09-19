import postgres from 'postgres';

const baseUrl=process.argv[2]||'https://kopsusren-v2.vercel.app';
if (!process.env.DATABASE_URL||!process.env.WA_SHARED_SECRET||!process.env.WA_OWNER_NUMBERS) throw new Error('Environment test belum lengkap');
const db=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
const ownerPhone=process.env.WA_OWNER_NUMBERS.split(',')[0].replace(/\D/g,'');
const customerPhone='6280000009915';
const beforeIds=new Set((await db`select id::text id from po_sessions`).map(row=>row.id));
let poId=null;

async function reset(phone) {
  await db`insert into conversation_order_states(channel,customer_phone,order_state,status,last_message_at)
    values('whatsapp',${phone},'{}'::jsonb,'confirmed',now())
    on conflict(channel,customer_phone) do update set order_state='{}'::jsonb,status='confirmed',updated_at=now(),last_message_at=now()`;
}

async function send(phone,text,label) {
  const id=`e2e-qris-disabled-${Date.now()}-${label}`;
  const response=await fetch(`${baseUrl}/api/v2/commands`,{method:'POST',headers:{Authorization:`Bearer ${process.env.WA_SHARED_SECRET}`,'Content-Type':'application/json'},body:JSON.stringify({action:'chat_inbound',payload:{provider:'e2e',phone,text,waMessageId:id,messageId:id,receivedAt:new Date().toISOString()}})});
  const result=await response.json();
  if (!response.ok||!result.ok) throw new Error(result.error||`HTTP ${response.status}`);
  return result;
}

try {
  if ((await db`select id from po_sessions where status='OPEN' limit 1`).length) throw new Error('Tutup PO aktif sebelum test QRIS disabled');
  await reset(ownerPhone);
  await reset(customerPhone);
  await send(ownerPhone,'buka PO hari ini dari sekarang sampai satu jam lagi, max 2 cup, susu 500 ml','open');
  const created=await db`select id::text id from po_sessions order by created_at desc`;
  poId=created.find(row=>!beforeIds.has(row.id))?.id||null;
  if (!poId) throw new Error('PO test tidak terbentuk');
  const before=await db`select count(*)::int total from orders where customer_phone=${customerPhone}`;
  const response=await send(customerPhone,'matcha satu buat Citra 8.3 bayarnya qris','select');
  if (!/QRIS belum aktif|pilih cash/i.test(response.replyText||'')) throw new Error(`Guard QRIS tidak jelas: ${response.replyText}`);
  const after=await db`select count(*)::int total from orders where customer_phone=${customerPhone}`;
  if (Number(after[0].total)!==Number(before[0].total)) throw new Error('Order QRIS terbentuk tanpa gambar QRIS terkonfigurasi');
  console.log(JSON.stringify({ok:true,customerWasToldQrisIsUnavailable:true,noOrderCreated:true,reply:response.replyText},null,2));
} finally {
  if (poId) {
    const rows=await db`select status from po_sessions where id=${poId}`;
    if (rows[0]?.status==='OPEN') await db`select set_po_status(${poId},'CLOSED')`;
  }
  await reset(ownerPhone);
  await reset(customerPhone);
  await db.end();
}
