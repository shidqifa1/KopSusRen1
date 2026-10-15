import postgres from 'postgres';

if(!process.env.DATABASE_URL||!process.env.GROQ_API_KEY) throw new Error('DATABASE_URL dan GROQ_API_KEY wajib tersedia');
process.env.CHATBOT_MODE='confirmation';
process.env.WA_OWNER_NUMBERS=process.env.WA_OWNER_NUMBERS||'6285175403169';
process.env.QRIS_IMAGE_URL=process.env.QRIS_IMAGE_URL||'http://127.0.0.1:3000/assets/qris-baristack.jpeg';

const {handleChatInbound}=await import('../dist/services/chatbot/orchestrator.js');
const db=postgres(process.env.DATABASE_URL,{prepare:false,max:2});
const stamp=Date.now();
const owner=process.env.WA_OWNER_NUMBERS.split(',')[0].replace(/\D/g,'');
const cashPhone='6280000099101';
const qrisPhone='6280000099102';
const unclearPhone='6280000099103';
const rejectedPhone='6280000099104';
const expiredPhone='6280000099105';
let poId=null;
const orderIds=[];

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function send(phone,text,label,{hasImage=false,messageId=null,pause=2200}={}) {
  if(pause) await wait(pause);
  return handleChatInbound({provider:'e2e-runtime',phone,text,hasImage,
    waMessageId:messageId||`e2e-runtime-${stamp}-${label}`,receivedAt:new Date().toISOString()});
}
async function reset(phone) {
  await db`delete from chat_messages where customer_phone=${phone} and provider='e2e-runtime'`;
  await db`delete from order_drafts where customer_phone=${phone} and created_order_id is null`;
  await db`delete from conversation_order_states where channel='whatsapp' and customer_phone=${phone}`;
}
async function orderRow(id) {
  const rows=await db`select o.id,o.order_number,o.source,o.status,o.customer_phone,o.total_amount::float8 total_amount,
    c.name,c.class_name,p.method,p.status payment_status,p.proof_received_at,
    count(oi.id)::int item_rows,sum(oi.qty)::int cups,count(*) filter(where oi.no_ice)::int no_ice_rows
    from orders o join customers c on c.id=o.customer_id join payments p on p.order_id=o.id
    join order_items oi on oi.order_id=o.id where o.id=${id} group by o.id,c.id,p.id`;
  return rows[0];
}
function expect(value,message) { if(!value) throw new Error(message); }

try {
  const active=await db`select id from po_sessions where status='OPEN' limit 1`;
  expect(!active.length,'Database test masih memiliki PO OPEN');
  await Promise.all([cashPhone,qrisPhone,unclearPhone,rejectedPhone,expiredPhone,owner].map(reset));
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta'}).format(new Date());
  const created=await db`select create_po(${`E2E Runtime ${stamp}`},${date},${new Date(Date.now()-60000).toISOString()},
    ${new Date(Date.now()+3600000).toISOString()},${20},${db.json([])},${30}) id`;
  poId=created[0].id;
  await db`select set_po_status(${poId},'OPEN')`;

  const cashDraft=await send(cashPhone,'pesen 2 kopsus buat Budi 8.2 cash, satu no ice','cash-draft');
  expect(/Budi/i.test(cashDraft.replyText||'')&&/2x|1x/i.test(cashDraft.replyText||''),`Draft cash tidak lengkap: ${cashDraft.replyText}`);
  const cashConfirmId=`e2e-runtime-${stamp}-cash-confirm`;
  const cashConfirmed=await send(cashPhone,'gas','cash-confirm',{messageId:cashConfirmId,pause:0});
  expect(cashConfirmed.orderIds?.length===1,`Cash tidak menghasilkan satu order: ${cashConfirmed.replyText}`);
  orderIds.push(cashConfirmed.orderIds[0]);
  const duplicate=await send(cashPhone,'gas','cash-duplicate',{messageId:cashConfirmId,pause:0});
  expect(duplicate.duplicate===true,'Replay message id tidak dianggap duplicate');
  const cash=await orderRow(cashConfirmed.orderIds[0]);
  expect(cash.source==='WHATSAPP'&&cash.payment_status==='UNPAID'&&cash.cups===2&&cash.no_ice_rows===1,'State cash/varian salah');
  const cashReservations=await db`select count(*)::int count from inventory_reservations where order_id=${cash.id} and status='ACTIVE'`;
  expect(cashReservations[0].count>0,'Cash tidak membuat reservation');
  await db`select confirm_cash_payment(${cash.id})`;
  await db`select complete_order(${cash.id})`;
  const completedCash=await orderRow(cash.id);
  const consumed=await db`select count(*)::int count from inventory_reservations where order_id=${cash.id} and status='CONSUMED'`;
  const cashLedger=await db`select count(*)::int count from ledger_entries where reference_type='order' and reference_id=${cash.id} and entry_type='SALE'`;
  expect(completedCash.status==='FULFILLED'&&completedCash.payment_status==='PAID'&&consumed[0].count>0&&cashLedger[0].count===1,'Cash payment/fulfillment/ledger tidak konsisten');

  const unclear=await send(unclearPhone,'yang biasa satu','unclear');
  expect(!unclear.orderIds?.length,'Pesan ambigu membuat order');
  const unclearOrders=await db`select count(*)::int count from orders where customer_phone=${unclearPhone}`;
  expect(unclearOrders[0].count===0,'Pesan ambigu tersimpan sebagai order');

  const qrisDraft=await send(qrisPhone,'1 matcha less sweet atas nama Sinta, qris','qris-draft');
  expect(/Sinta/i.test(qrisDraft.replyText||'')&&/QRIS/i.test(qrisDraft.replyText||''),`Draft QRIS tidak lengkap: ${qrisDraft.replyText}`);
  const qrisConfirmed=await send(qrisPhone,'iya','qris-confirm',{pause:0});
  expect(qrisConfirmed.orderIds?.length===1&&qrisConfirmed.qrisImageUrl,'QRIS tidak membuat order/gambar');
  orderIds.push(qrisConfirmed.orderIds[0]);
  let qris=await orderRow(qrisConfirmed.orderIds[0]);
  expect(qris.payment_status==='PENDING'&&!qris.proof_received_at,'QRIS awal bukan PENDING tanpa bukti');
  const proof=await send(qrisPhone,'','qris-proof',{hasImage:true,pause:0});
  expect(/bukti QRIS.*diterima/i.test(proof.replyText||'')&&proof.ownerNotifications?.length,'Bukti QRIS/notifikasi owner gagal');
  qris=await orderRow(qris.id);
  expect(qris.payment_status==='PENDING'&&qris.proof_received_at,'Bukti QRIS tidak tercatat');

  const pending=await send(owner,`/bayar konfirmasi ${qris.order_number}`,'owner-confirm-command',{pause:0});
  expect(/Balas Y\/N/i.test(pending.replyText||''),'Write owner tidak meminta Y/N');
  const ownerState=await db`select order_state,status from conversation_order_states where channel='whatsapp' and customer_phone=${owner}`;
  expect(ownerState[0]?.order_state?.pending_owner_command,`Pending owner command tidak tersimpan: ${JSON.stringify(ownerState[0]||null)}`);
  qris=await orderRow(qris.id);
  expect(qris.payment_status==='PENDING','Payment berubah sebelum Y');
  const paid=await send(owner,'Y','owner-confirm-y',{pause:0});
  expect(paid.customerNotifications?.some(n=>n.phone===qrisPhone),`Konfirmasi owner tidak memberi notifikasi customer: ${JSON.stringify(paid)}`);
  qris=await orderRow(qris.id);
  expect(qris.payment_status==='PAID','QRIS tidak berubah PAID setelah Y');
  const replayY=await send(owner,'Y','owner-confirm-y-replay',{pause:0});
  expect(/tidak ada command/i.test(replayY.replyText||''),'Y kedua masih mengeksekusi command');

  const product=await db`select id from products where code='AMERICANO'`;
  const rejectedOrder=await db`select create_order_bundle(${'Reject Test'},${null},${poId},${db.json([{productId:product[0].id,quantity:1,noIce:false,notes:null}])},
    ${'QRIS'},${'E2E reject'},${'WHATSAPP'},${`e2e-reject-${stamp}`},${rejectedPhone}) id`;
  orderIds.push(rejectedOrder[0].id);
  await db`select record_qris_proof(${rejectedOrder[0].id},${`proof-reject-${stamp}`})`;
  const rejectedNumber=(await orderRow(rejectedOrder[0].id)).order_number;
  const rejectPending=await send(owner,`/bayar tolak ${rejectedNumber}`,'owner-reject-command',{pause:0});
  expect(/Balas Y\/N/i.test(rejectPending.replyText||''),'Reject owner tidak meminta Y/N');
  const rejected=await send(owner,'Y','owner-reject-y',{pause:0});
  expect(rejected.customerNotifications?.some(n=>n.phone===rejectedPhone),'Reject tidak memberi notifikasi customer');
  const rejectedState=await orderRow(rejectedOrder[0].id);
  const released=await db`select count(*)::int count from inventory_reservations where order_id=${rejectedOrder[0].id} and status='RELEASED'`;
  expect(rejectedState.status==='CANCELLED'&&rejectedState.payment_status==='EXPIRED'&&released[0].count>0,'Reject tidak cancel/release reservation');

  const expiredOrder=await db`select create_order_bundle(${'Expiry Test'},${null},${poId},${db.json([{productId:product[0].id,quantity:1,noIce:false,notes:null}])},
    ${'QRIS'},${'E2E expiry'},${'WHATSAPP'},${`e2e-expiry-${stamp}`},${expiredPhone}) id`;
  orderIds.push(expiredOrder[0].id);
  await db`update payments set expires_at=now()-interval '1 minute' where order_id=${expiredOrder[0].id}`;
  const maintenance=await db`select run_po_maintenance() result`;
  const expiredState=await orderRow(expiredOrder[0].id);
  const expiredReleased=await db`select count(*)::int count from inventory_reservations where order_id=${expiredOrder[0].id} and status='RELEASED'`;
  expect(expiredState.status==='CANCELLED'&&expiredState.payment_status==='EXPIRED'&&expiredReleased[0].count>0,'QRIS timeout tidak cancel/release reservation');
  expect((maintenance[0].result.expiredOrderIds||[]).includes(expiredOrder[0].id),'Maintenance tidak melaporkan order expired');

  console.log(JSON.stringify({ok:true,cash:{orderNumber:cash.order_number,cups:cash.cups,payment:completedCash.payment_status,status:completedCash.status,reserved:true,consumed:true,ledgerOnce:true,duplicateBlocked:true},
    ambiguity:{reply:unclear.replyText,noOrder:true},qris:{orderNumber:qris.order_number,proofReceived:Boolean(qris.proof_received_at),payment:qris.payment_status,customerNotified:true},
    qrisReject:{orderNumber:rejectedNumber,status:rejectedState.status,payment:rejectedState.payment_status,reservationReleased:true,customerNotified:true},
    qrisExpiry:{status:expiredState.status,payment:expiredState.payment_status,reservationReleased:true},ownerConfirmationRequired:true},null,2));
} finally {
  for(const id of orderIds) {
    const rows=await db`select status from orders where id=${id}`;
    if(rows.length&&!['CANCELLED','REJECTED','FULFILLED'].includes(rows[0].status)) await db`select cancel_order(${id},'E2E runtime cleanup')`;
  }
  if(poId) {
    const rows=await db`select status from po_sessions where id=${poId}`;
    if(rows.length&&rows[0].status==='OPEN') await db`select set_po_status(${poId},'CLOSED')`;
  }
  await Promise.all([cashPhone,qrisPhone,unclearPhone,rejectedPhone,expiredPhone,owner].map(reset));
  await db.end();
}
