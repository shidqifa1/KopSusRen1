import { OWNER_AI_FALLBACK,OWNER_OUT_OF_SCOPE_REPLY,OwnerCommandGenerator,OwnerConsultant,OwnerRouter,OwnerSummarizer } from './llm.js';
import { executeOwnerReadCommand,executeOwnerWriteCommand,formatOwnerReadResult,parseOwnerCommand,loadOwnerConsultationContext,formatOwnerProductionSimulation } from './commands.js';

const PENDING_TTL_MS=5*60*1000;

function exactConfirmation(text) {
  const value=String(text||'').trim().toUpperCase();
  return value==='Y'||value==='N'?value:null;
}

function pendingActive(state,now=Date.now()) {
  const pending=state?.pending_owner_command;
  return Boolean(pending&&pending.status==='PENDING'&&new Date(pending.expires_at).getTime()>now);
}

function safeOperationalJson(result) {
  return JSON.parse(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?value.toString():value));
}

function looksLikeBatchOrder(text) {
  return String(text||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).length>=2;
}

export async function prepareOwnerTurn({payload,snapshot,db,llm={OwnerRouter,OwnerCommandGenerator,OwnerSummarizer,OwnerConsultant}}) {
  const text=String(payload.text||'').trim();
  const state=snapshot?.orderState||{};
  if (payload.hasImage) return {role:'OWNER',ownerMode:'DIRECT_REPLY',replyText:'Kirim perintah teks atau pakai /help ya.',stateVersion:snapshot?.stateVersion};
  if (exactConfirmation(text)) return {role:'OWNER',ownerMode:'CONFIRMATION',confirmation:exactConfirmation(text),stateVersion:snapshot?.stateVersion};
  if (pendingActive(state)) return {role:'OWNER',ownerMode:'PENDING_BLOCK',stateVersion:snapshot?.stateVersion};

  if (text.startsWith('/')) {
    const parsed=parseOwnerCommand(text);
    if (!parsed.ok) return {role:'OWNER',ownerMode:'DIRECT_REPLY',replyText:parsed.error,stateVersion:snapshot?.stateVersion};
    if (parsed.kind==='WRITE') return {role:'OWNER',ownerMode:'WRITE_COMMAND',command:parsed,stateVersion:snapshot?.stateVersion};
    try {
      const result=await executeOwnerReadCommand(db,parsed);
      return {role:'OWNER',ownerMode:'READ_RESULT',command:parsed,result,replyText:formatOwnerReadResult(result),manual:true,stateVersion:snapshot?.stateVersion};
    } catch(error) {
      return {role:'OWNER',ownerMode:'DIRECT_REPLY',replyText:error instanceof Error?error.message:'Command gagal.',stateVersion:snapshot?.stateVersion};
    }
  }

  try {
    const history=(state.owner_consultation_history||[]).slice(-6);
    const simpleSimulation=/\b\d+\s*(?:cup|gelas)\b/i.test(text)
      &&/\b(?:kalau|kalo|simulasi|target|tambahan|butuh|perlu|cukup|kebutuhan)\b/i.test(text)
      &&!/\b(?:buka|tutup|konfirmasi|bayar|batal|batalkan|pesankan|orderkan|kurangi|tambahkan)\b/i.test(text);
    const route=simpleSimulation?'CONSULTATION':await llm.OwnerRouter(text,history);
    if (route==='OUT_OF_SCOPE') {
      return {role:'OWNER',ownerMode:'DIRECT_REPLY',route,replyText:OWNER_OUT_OF_SCOPE_REPLY,stateVersion:snapshot?.stateVersion};
    }
    if (route==='CONSULTATION') {
      let context=null;
      try { if (db) context=await loadOwnerConsultationContext(db,text); }
      catch { return {role:'OWNER',ownerMode:'DIRECT_REPLY',route,replyText:'Data usaha terbaru belum bisa dibaca. Coba lagi sebentar; aku belum bisa memastikan stok atau hitungannya.',stateVersion:snapshot?.stateVersion}; }
      const answer=context?.simulation?.target_cups?formatOwnerProductionSimulation(context)
        :await llm.OwnerConsultant(text,safeOperationalJson(context),history);
      const timestamp=context?new Date(context.observed_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',dateStyle:'short',timeStyle:'short'}):null;
      const replyText=timestamp?`${answer}\n\nData ${timestamp} WIB · penjualan 7×24 jam terakhir.`:answer;
      return {role:'OWNER',ownerMode:'CONSULTATION',route,replyText,stateVersion:snapshot?.stateVersion};
    }
    const generated=await llm.OwnerCommandGenerator(route,text);
    const parsed=parseOwnerCommand(generated);
    if (!parsed.ok||(route==='READ_QUERY'&&parsed.kind!=='READ')||(route==='WRITE_INTENT'&&parsed.kind!=='WRITE')) {
      if (route==='WRITE_INTENT'&&looksLikeBatchOrder(text)) {
        return {role:'OWNER',ownerMode:'DIRECT_REPLY',route,replyText:'Ini terbaca sebagai batch order. Input batch lewat WhatsApp belum dieksekusi karena PO dan metode bayar tiap order belum jelas. Untuk sekarang masukkan lewat form penjualan di web—satu customer tetap menjadi satu order.',stateVersion:snapshot?.stateVersion};
      }
      return {role:'OWNER',ownerMode:'DIRECT_REPLY',route,replyText:'Command hasil AI tidak valid. Pakai /help untuk melihat command manual.',stateVersion:snapshot?.stateVersion};
    }
    if (route==='WRITE_INTENT') return {role:'OWNER',ownerMode:'WRITE_COMMAND',route,command:parsed,stateVersion:snapshot?.stateVersion};
    const result=await executeOwnerReadCommand(db,parsed);
    try {
      const replyText=await llm.OwnerSummarizer(safeOperationalJson(result.data),text);
      return {role:'OWNER',ownerMode:'READ_RESULT',route,command:parsed,result,replyText,stateVersion:snapshot?.stateVersion};
    } catch {
      return {role:'OWNER',ownerMode:'DIRECT_REPLY',route,replyText:`${OWNER_AI_FALLBACK} Command read-nya: ${parsed.command}`,stateVersion:snapshot?.stateVersion};
    }
  } catch {
    return {role:'OWNER',ownerMode:'DIRECT_REPLY',replyText:OWNER_AI_FALLBACK,stateVersion:snapshot?.stateVersion};
  }
}

async function loadOwnerState(db,phone) {
  const rows=await db`select order_state from conversation_order_states where channel='whatsapp' and customer_phone=${phone} limit 1`;
  return rows[0]?.order_state||{};
}

async function replaceOwnerState(db,phone,state,status) {
  await db`insert into conversation_order_states(channel,customer_phone,order_state,status,last_message_at)
    values('whatsapp',${phone},${db.json(state)}::jsonb,${status},now())
    on conflict(channel,customer_phone) do update set order_state=excluded.order_state,status=excluded.status,last_message_at=now(),updated_at=now()`;
}

function withoutPending(state) {
  const next={...state};
  delete next.pending_owner_command;
  return next;
}

export async function handleOwnerTurn(db,payload,messageId,prepared) {
  const phone=String(payload.phone||'').replace(/\D/g,'').replace(/^0/,'62');
  const current=await loadOwnerState(db,phone);
  const pending=current.pending_owner_command;
  const isExpired=pending&&new Date(pending.expires_at).getTime()<=Date.now();

  if (prepared.ownerMode==='CONFIRMATION') {
    if (!pending||pending.status!=='PENDING') return {replyText:'Tidak ada command yang menunggu konfirmasi. Pakai /help untuk melihat command.'};
    if (isExpired) {
      await replaceOwnerState(db,phone,withoutPending(current),'expired');
      return {replyText:'Command sudah kedaluwarsa. Kirim ulang command-nya ya.'};
    }
    if (prepared.confirmation==='N') {
      await replaceOwnerState(db,phone,withoutPending(current),'cancelled');
      return {replyText:'Command dibatalkan.'};
    }
    const parsed=parseOwnerCommand(pending.command);
    if (!parsed.ok||parsed.kind!=='WRITE') {
      await replaceOwnerState(db,phone,withoutPending(current),'cancelled');
      return {replyText:'Pending command tidak valid dan sudah dibatalkan.'};
    }
    try {
      const result=await executeOwnerWriteCommand(db,parsed);
      await replaceOwnerState(db,phone,{...withoutPending(current),last_owner_command:{command:pending.command,status:'EXECUTED',executed_at:new Date().toISOString(),source_message_id:pending.source_message_id}},'confirmed');
      return result;
    } catch(error) {
      await replaceOwnerState(db,phone,{...withoutPending(current),last_owner_command:{command:pending.command,status:'FAILED',failed_at:new Date().toISOString()}},'cancelled');
      return {replyText:error instanceof Error?error.message:'Command gagal dijalankan.'};
    }
  }

  if (pending&&!isExpired) return {replyText:`Masih ada command pending: ${pending.command}. Balas Y atau N dulu.`};
  const base=isExpired?withoutPending(current):current;
  if (prepared.ownerMode==='WRITE_COMMAND') {
    const now=Date.now();
    const next={...base,pending_owner_command:{command:prepared.command.command,kind:'WRITE',source_message_id:String(payload.waMessageId||messageId),created_at:new Date(now).toISOString(),expires_at:new Date(now+PENDING_TTL_MS).toISOString(),status:'PENDING'}};
    await replaceOwnerState(db,phone,next,'ready_to_confirm');
    return {replyText:`Eksekusi command ini? ${prepared.command.command} (Balas Y/N)`};
  }
  if (isExpired) await replaceOwnerState(db,phone,base,'expired');
  if (prepared.ownerMode==='PENDING_BLOCK') return {replyText:'Command sebelumnya sudah kedaluwarsa. Kirim ulang command-nya ya.'};
  if (prepared.ownerMode==='CONSULTATION') {
    const history=[...(base.owner_consultation_history||[]),
      {role:'user',content:String(payload.text||'').slice(0,1200)},
      {role:'assistant',content:String(prepared.replyText||'').slice(0,2400)}].slice(-6);
    await replaceOwnerState(db,phone,{...base,owner_consultation_history:history},'collecting_information');
  }
  return {replyText:prepared.replyText||OWNER_AI_FALLBACK};
}

export { PENDING_TTL_MS,exactConfirmation,pendingActive };
