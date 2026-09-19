import postgres from 'postgres';

const baseUrl=process.argv[2]||'https://kopsusren-v2.vercel.app';
const phone='6280000009920';
if (!process.env.DATABASE_URL||!process.env.WA_SHARED_SECRET) throw new Error('Environment test belum lengkap');
const db=postgres(process.env.DATABASE_URL,{prepare:false,max:1});

async function send(text,label) {
  const messageId=`e2e-memory-${Date.now()}-${label}`;
  const response=await fetch(`${baseUrl}/api/v2/commands`,{
    method:'POST',
    headers:{Authorization:`Bearer ${process.env.WA_SHARED_SECRET}`,'Content-Type':'application/json'},
    body:JSON.stringify({action:'chat_inbound',payload:{provider:'e2e-memory',phone,text,waMessageId:messageId,messageId,receivedAt:new Date().toISOString()}}),
  });
  const result=await response.json();
  if (!response.ok||!result.ok) throw new Error(result.error||`HTTP ${response.status}`);
  return result.replyText||'';
}

async function reset() {
  await db`delete from order_drafts where customer_phone=${phone} and created_order_id is null`;
  await db`delete from conversation_order_states where channel='whatsapp' and customer_phone=${phone}`;
  await db`delete from chat_messages where customer_phone=${phone} and provider='e2e-memory'`;
}

try {
  const po=await db`select id from po_sessions where status='OPEN' and (cutoff_at is null or cutoff_at>now()) limit 1`;
  if (!po.length) throw new Error('Butuh satu PO aktif untuk E2E memori');
  await reset();
  const replies=[];
  replies.push(await send('gue mau mesen dong','start'));
  replies.push(await send('saya mau pesan coklat susu','unknown-menu'));
  replies.push(await send('yang gula aren aja','menu'));
  replies.push(await send('5 aja','quantity'));
  replies.push(await send('Takbir','name'));
  replies.push(await send('Paypal','unsupported-payment'));
  replies.push(await send('kapan kopi dikirim','draft-status'));
  replies.push(await send('lah tadi 5','memory-reference'));
  replies.push(await send('keris aja','qris-disabled'));
  replies.push(await send('lah tadi nawarin','no-invented-payment'));

  if (!/coklat susu.*belum tersedia/is.test(replies[1])) throw new Error(`Menu tidak tersedia masih salah: ${replies[1]}`);
  if (!/paypal.*belum didukung/is.test(replies[5])) throw new Error(`Metode unsupported tidak jelas: ${replies[5]}`);
  if (!/5 cup.*tersimpan|5x Kopi Susu/is.test(replies[6])) throw new Error(`Status draft hilang: ${replies[6]}`);
  if (!/tersimpan|5x Kopi Susu/is.test(replies[7])) throw new Error(`Rujukan percakapan hilang: ${replies[7]}`);
  if (!/QRIS.*belum aktif|kode pembayarannya belum dipasang/is.test(replies[8])) throw new Error(`Guard QRIS tidak jelas: ${replies[8]}`);
  if (/Bayar:\s*CASH/i.test(replies[9])) throw new Error(`AI mengarang CASH: ${replies[9]}`);

  const stateRows=await db`select order_state from conversation_order_states where channel='whatsapp' and customer_phone=${phone}`;
  const state=stateRows[0]?.order_state||{};
  if (state.payment_method) throw new Error(`Payment terisi tanpa pilihan valid: ${state.payment_method}`);
  if (state.customer_name!=='Takbir'||Number(state.items?.[0]?.quantity)!==5) throw new Error(`Draft tidak bertahan: ${JSON.stringify(state)}`);

  console.log(JSON.stringify({ok:true,replies,memory:{customerName:state.customer_name,quantity:state.items[0].quantity,paymentMethod:state.payment_method||null}},null,2));
} finally {
  await reset();
  await db.end();
}
