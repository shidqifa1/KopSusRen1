import postgres from 'postgres';

const baseUrl=process.argv[2]||'https://kopsusren-v2.vercel.app';
const phone='6280000009921';
if (!process.env.DATABASE_URL||!process.env.WA_SHARED_SECRET) throw new Error('Environment test belum lengkap');
const db=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
let orderId=null;

async function send(text,label,{hasImage=false}={}) {
  const messageId=`e2e-qris-active-${Date.now()}-${label}`;
  const response=await fetch(`${baseUrl}/api/v2/commands`,{
    method:'POST',
    headers:{Authorization:`Bearer ${process.env.WA_SHARED_SECRET}`,'Content-Type':'application/json'},
    body:JSON.stringify({action:'chat_inbound',payload:{provider:'e2e-qris-active',phone,text,hasImage,waMessageId:messageId,messageId,receivedAt:new Date().toISOString()}}),
  });
  const result=await response.json();
  if (!response.ok||!result.ok) throw new Error(result.error||`HTTP ${response.status}`);
  return result;
}

async function resetConversation() {
  await db`delete from order_drafts where customer_phone=${phone} and created_order_id is null`;
  await db`delete from conversation_order_states where channel='whatsapp' and customer_phone=${phone}`;
  await db`delete from chat_messages where customer_phone=${phone} and provider='e2e-qris-active'`;
}

try {
  const po=await db`select id from po_sessions where status='OPEN' and (cutoff_at is null or cutoff_at>now()) limit 1`;
  if (!po.length) throw new Error('Butuh satu PO aktif untuk E2E QRIS');
  await resetConversation();

  const draft=await send('americano 1 qris','draft');
  if (!/QRIS/i.test(draft.replyText||'')) throw new Error(`Draft QRIS tidak terbentuk: ${draft.replyText}`);
  const named=await send('E2E Buyer','name');
  if (!/E2E Buyer/i.test(named.replyText||'')) throw new Error(`Nama customer tidak tersimpan: ${named.replyText}`);
  const confirmed=await send('gas','confirm');
  if (!confirmed.orderIds?.length||!confirmed.qrisImageUrl) throw new Error(`Order QRIS/gambar tidak terbentuk: ${confirmed.replyText}`);
  orderId=confirmed.orderIds[0];

  const image=await fetch(confirmed.qrisImageUrl,{method:'HEAD'});
  if (!image.ok||!String(image.headers.get('content-type')).startsWith('image/')) throw new Error('URL QRIS bukan gambar yang valid');

  const proof=await send('','proof',{hasImage:true});
  if (!/bukti QRIS.*diterima/i.test(proof.replyText||'')) throw new Error(`Bukti QRIS tidak diterima: ${proof.replyText}`);
  if (!(proof.ownerNotifications||[]).length) throw new Error('Owner tidak mendapat notifikasi bukti QRIS');

  const rows=await db`select method,status,proof_received_at from payments where order_id=${orderId}`;
  if (rows[0]?.method!=='QRIS'||rows[0]?.status!=='PENDING'||!rows[0]?.proof_received_at) throw new Error(`State payment QRIS salah: ${JSON.stringify(rows[0])}`);

  console.log(JSON.stringify({ok:true,orderId,qrisImageUrl:confirmed.qrisImageUrl,imageContentType:image.headers.get('content-type'),proofReceived:true,ownerNotified:true,paymentStatus:rows[0].status},null,2));
} finally {
  if (orderId) {
    const rows=await db`select status from orders where id=${orderId}`;
    if (rows.length&&!['CANCELLED','REJECTED'].includes(rows[0].status)) await db`select cancel_order(${orderId},'Pembersihan E2E QRIS')`;
  }
  await resetConversation();
  await db.end();
}
