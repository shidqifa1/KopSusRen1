import { sql } from '../../db/index.js';
import { createHash,randomUUID } from 'node:crypto';
import { applyMessage, emptyOrder } from '../parser/orderParser.js';
import { groqEnabled, parseWithGroq } from '../parser/groqOrderParser.js';
import {
  SAFETY_CLASSIFICATION, applyParserAmbiguities, applyStructuredPatch, authorizeOrderCommit, classifyDraftSafety, deterministicCustomerTurn, draftItemsForRpc, emptyDraft,
  groundedRecommendation, isExplicitOrderConfirmation, menuText, mentionsSupportedPaymentMethod, missingFields, nextReply, sanitizeCustomerParsedResult, summarizeDraft,
  orderConfirmationSnapshot, parseUsualOrderRequest, usualOrderReply,
} from './conversation.js';
import { extractOwnerPoFields, jakartaTime, validateOwnerPoSchedule } from './ownerPo.js';
import { decideParsedResultApplicability,runInboundPipeline } from './transactionFlow.js';
import { buildShadowObservation } from './shadow.js';
import { handleOwnerTurn,prepareOwnerTurn } from '../owner/pipeline.js';

const PROCESSING_LEASE_SECONDS=60;

function chatbotMode() {
  return String(process.env.CHATBOT_MODE||'confirmation').trim().toLowerCase()==='shadow'?'shadow':'confirmation';
}

function shadowCustomerRef(phone) {
  const salt=process.env.SHADOW_HASH_SALT||process.env.AUTH_SECRET||process.env.WA_SHARED_SECRET||'baristack-shadow';
  return createHash('sha256').update(`${salt}:${normalizePhone(phone)}`).digest('hex').slice(0,32);
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g,'').replace(/^0/,'62');
}

function ownerPhones() {
  return String(process.env.WA_OWNER_NUMBERS || '').split(',').map(normalizePhone).filter(Boolean);
}

function isOwnerPhone(phone) {
  return ownerPhones().includes(normalizePhone(phone));
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error || 'Operasi gagal');
}

function hashPhoneForLog(phone) {
  const value = normalizePhone(phone);
  return value ? `***${value.slice(-4)}` : 'unknown';
}

function ownerFallback(text) {
  const low=String(text||'').toLowerCase();
  const intents=[];
  if (/\b(open|buka(?:nya|in|kan)?)\b.*\b(?:po|max|cup|susu|suus|tutup|close)\b/.test(low)) intents.push('OWNER_OPEN_PO');
  else if (/\b(close|tutup)\s+po\b/.test(low)) intents.push('OWNER_CLOSE_PO');
  else if (/\b(confirm|konfirmasi|masuk|lunas)\b.*\b(qris|bayar)|\b(qris|bayar)\b.*\b(masuk|lunas)\b/.test(low)) intents.push('OWNER_PAYMENT_CONFIRM');
  else if (/\b(reject|tolak)\b.*\b(qris|bayar|order)\b/.test(low)) intents.push('OWNER_PAYMENT_REJECT');
  else if (/\bbelum\s*(bayar|lunas)\b/.test(low)) intents.push('OWNER_PAYMENT_QUERY');
  else if (/\b(stok|stock|susu|bahan)\b/.test(low)) intents.push('OWNER_INVENTORY_QUERY');
  else if (/\b(produksi|ringkas)\b/.test(low)) intents.push('OWNER_PRODUCTION_QUERY');
  else if (/\b(po|pesanan|order)\b/.test(low)) intents.push('OWNER_PO_QUERY');
  else intents.push('UNKNOWN');
  const poFields=extractOwnerPoFields(text);
  const name=low.match(/\byang\s+([a-z][a-z .'-]{1,30}?)(?=\s+(?:udah|sudah|qris|bayar)|$)/i);
  return {intents,entities:{name:name?.[1]?.trim()||null,class_name:null,payment_method:null,item_operations:[],order_number:Number(low.match(/#\s*(\d+)/)?.[1]||0)||null,
    po_date:poFields.date,open_time:poFields.openTime,close_time:poFields.closeTime,
    close_date:null,duration_minutes:null,schedule_mode:null,
    max_cups:poFields.maxCups,ingredient_name:poFields.ingredientName,ingredient_quantity:poFields.ingredientQuantity,
    ingredient_unit:poFields.ingredientQuantity?'ML':null,
    inventory_change:/\b(kurangi|buang|minus)\b/.test(low)?'DECREASE':/\b(tambah|beli|plus)\b/.test(low)?'INCREASE':null,
    confirmation:/^(iya|ya|gas|lanjut|konfirmasi|confirm)$/i.test(low)||null},reply_hint:null,confidence:.65};
}

async function loadBusinessContext(db) {
  const [poRows, productRows] = await Promise.all([
    db`select id,name,delivery_date,open_at,cutoff_at,max_total_cups,status,qris_timeout_minutes
       from po_sessions where status='OPEN' and (cutoff_at is null or cutoff_at>now())
       order by open_at desc nulls last,created_at desc limit 1`,
    db`select id,code,name,price::float8 as price,is_active,chatbot_metadata
       from products where is_active order by name`,
  ]);
  const po = poRows[0] || null;
  let availability = null;
  if (po) {
    const rows = await db`select evaluate_po_availability(${po.id},'[]'::jsonb) as value`;
    availability = rows[0]?.value || null;
  }
  const products = productRows.map(product => {
    const live = availability?.products?.find(item => item.productId === product.id) || {};
    return { ...product, availableQty: live.availableQty ?? null, available: live.available ?? true };
  });
  return { po,products,availability };
}

async function loadConversation(db,phone,poId) {
  const rows = await db`select order_state,status,last_message_at from conversation_order_states
    where channel='whatsapp' and customer_phone=${phone} limit 1`;
  const saved = rows[0]?.order_state || emptyDraft(poId);
  if (saved.po_session_id && saved.po_session_id !== poId) return emptyDraft(poId);
  return { ...emptyDraft(poId),...saved,po_session_id:poId,items:Array.isArray(saved.items)?saved.items:[] };
}

async function persistConversation(db,{ phone,draft,messageId,confidence=0,status=null }) {
  const missing = missingFields(draft);
  const conversationStatus = status || (draft.awaiting_confirmation ? 'ready_to_confirm' : 'collecting_information');
  let draftId = draft._draft_id || null;
  if (draftId) {
    const updated = await db`update order_drafts set customer_name=${draft.customer_name},class_name=${draft.class_name},
      customer_phone=${phone},items=${sql.json(draft.items)},state=${draft.awaiting_confirmation?'DRAFT_READY':'INCOMPLETE'},
      missing=${sql.json(missing)},confidence=${confidence},po_session_id=${draft.po_session_id},
      payment_method=${draft.payment_method},updated_at=now() where id=${draftId} returning id`;
    if (!updated.length) draftId=null;
  }
  if (!draftId) {
    const rows = await db`insert into order_drafts(source_message_id,customer_name,class_name,customer_phone,items,state,missing,confidence,po_session_id,payment_method)
      values(${messageId},${draft.customer_name},${draft.class_name},${phone},${sql.json(draft.items)},
      ${draft.awaiting_confirmation?'DRAFT_READY':'INCOMPLETE'},${sql.json(missing)},${confidence},${draft.po_session_id},${draft.payment_method}) returning id`;
    draftId=rows[0].id;
  }
  const state={...draft,_draft_id:draftId,_conversation_started_at:draft._conversation_started_at||new Date().toISOString()};
  await db`insert into conversation_order_states(channel,customer_phone,order_state,status,last_message_at)
    values('whatsapp',${phone},${sql.json(state)},${conversationStatus},now())
    on conflict(channel,customer_phone) do update set order_state=excluded.order_state,status=excluded.status,last_message_at=now(),updated_at=now()`;
  return state;
}

function localFallback(text,previous,products) {
  const catalog=products.map(product=>({
    code:product.code,name:product.name,price:Number(product.price),
    aliases:[product.name,product.code,...(product.chatbot_metadata?.aliases||[])].map(value=>String(value).toLowerCase()),
  }));
  const legacy={...emptyOrder(),customer_name:previous.customer_name,class_name:previous.class_name,
    payment_method:previous.payment_method?.toLowerCase()||null,awaiting_confirmation:previous.awaiting_confirmation,
    items:(previous.items||[]).map(item=>{
      const product=products.find(candidate=>candidate.id===item.productId);
      return { productCode:product?.code,productName:product?.name,quantity:item.quantity,quantityConfirmed:Boolean(item.quantity),
        ice:item.noIce?'no_ice':item.modifiers?.includes('less_ice')?'less_ice':null,notes:item.notes,unitPrice:Number(product?.price||0) };
    }).filter(item=>item.productCode)};
  const result=applyMessage(text,legacy,catalog);
  const draft={...emptyDraft(previous.po_session_id),customer_name:result.order.customer_name,class_name:result.order.class_name,
    payment_method:result.order.payment_method?.toUpperCase()||null,awaiting_confirmation:result.order.awaiting_confirmation,
    items:(result.order.items||[]).map(item=>{
      const product=products.find(candidate=>candidate.code===item.productCode);
      return {productId:product?.id,quantity:item.quantityConfirmed===false?null:item.quantity,
        modifiers:item.ice?[item.ice]:[],noIce:item.ice==='no_ice',notes:item.notes||null};
    }).filter(item=>item.productId)};
  draft.pending_question=missingFields(draft)[0]||null;
  draft.last_product_id=draft.items.at(-1)?.productId||null;
  return { draft,readyToCommit:false,intent:result.intent,confidence:result.confidence };
}

function mentionsPaymentMethod(text) {
  return mentionsSupportedPaymentMethod(text);
}

function mentionsUnsupportedPayment(text) {
  return /\b(?:paypal|kasbon|bon|transfer|debit|kartu|gopay|ovo|dana|shopeepay)\b/i.test(String(text||''));
}

function requestedMenuLabel(text) {
  const cleaned=String(text||'')
    .replace(/^(?:(?:saya|aku|gue|gua)\s+)?(?:(?:mau|ingin|pengen)\s+)?(?:(?:pesan|pesen|mesen|beli)\s+)?/i,'')
    .trim();
  return (cleaned||String(text||'')).slice(0,50);
}

function draftReply(draft,products,patchResult={}) {
  const reply=nextReply(draft,products,patchResult);
  if (!process.env.QRIS_IMAGE_URL&&missingFields(draft)[0]==='payment') {
    return `${summarizeDraft(draft,products).text}\n\nUntuk sekarang pembayarannya baru bisa cash. Balas “cash” kalau lanjut ya.`;
  }
  return reply;
}

function draftStatusReply(draft,products) {
  const summary=summarizeDraft(draft,products).text;
  const missing=missingFields(draft);
  if (!missing.length) return `Pesanan ini masih tersimpan sebagai draft dan belum masuk antrean:\n${summary}\n\nKalau sudah benar, balas “gas” atau “iya”.`;
  if (missing[0]==='payment'&&!process.env.QRIS_IMAGE_URL) {
    const cups=draft.items.reduce((total,item)=>total+Number(item.quantity||0),0);
    return `Pesanan ${cups} cup tadi masih tersimpan sebagai draft, belum hilang:\n${summary}\n\nBelum masuk antrean karena pembayaran belum dipilih. Untuk sekarang pilihannya cash.`;
  }
  return `Pesanan tadi masih tersimpan sebagai draft, belum masuk antrean:\n${draftReply(draft,products)}`;
}

function manualHandoffResult({phone,draft,products,issues,notifyOwner=true}) {
  const summary=summarizeDraft(draft,products).text||'Belum ada item yang berhasil dipastikan.';
  return {
    replyText:'Maaf, aku belum bisa memastikan pesananmu dengan aman. Pesanan ini perlu dibantu manual oleh owner ya.',
    ownerNotifications:notifyOwner?ownerPhones().map(owner=>({
      phone:owner,
      text:[
        'Perlu bantuan manual untuk percakapan customer.',
        `Nomor: ${phone}`,
        `Alasan: ${(issues||[]).join('; ')||'Interpretasi belum dapat dipastikan'}`,
        'Draft saat ini:',
        summary,
        `Bot dijeda bila nomor owner sudah dikonfigurasi. Setelah ditangani, aktifkan lagi dengan /chat lanjut ${phone}, lalu konfirmasi Y.`,
      ].join('\n'),
    })):[],
  };
}

async function customerImage(db,{phone,messageId}) {
  const pending=await db`select o.id,o.order_number,c.name,c.class_name
    from orders o join customers c on c.id=o.customer_id join payments p on p.order_id=o.id
    where coalesce(o.customer_phone,c.phone)=${phone} and p.method='QRIS' and p.status='PENDING' and p.proof_received_at is null
      and o.status not in ('CANCELLED','REJECTED','FULFILLED') order by o.created_at desc limit 3`;
  if (!pending.length) return {replyText:'Buktinya sudah diterima, tapi belum ada order QRIS pending dari nomor ini.'};
  if (pending.length>1) return {replyText:`Ada lebih dari satu QRIS pending. Tulis nomor order yang dibayar: ${pending.map(row=>`#${row.order_number}`).join(', ')}.`};
  await db`select record_qris_proof(${pending[0].id},${messageId}) as id`;
  return {
    replyText:`Bukti QRIS order #${pending[0].order_number} sudah diterima. Sekarang menunggu pengecekan owner ya.`,
    ownerNotifications:ownerPhones().map(owner=>({phone:owner,text:[
      '🔔 Bukti QRIS masuk.',`Order #${pending[0].order_number}`,`Customer: ${pending[0].name}${pending[0].class_name?` · ${pending[0].class_name}`:''}`,
      `Konfirmasi dengan: confirm qris #${pending[0].order_number}`,
    ].join('\n')})),
  };
}

async function customerStatus(db,phone) {
  const rows=await db`select o.order_number,o.status,o.total_amount::float8 total_amount,p.status payment_status,
      coalesce(json_agg(json_build_object('name',pr.name,'quantity',oi.qty)) filter(where oi.id is not null),'[]') items
    from orders o join customers c on c.id=o.customer_id left join payments p on p.order_id=o.id
    left join order_items oi on oi.order_id=o.id left join products pr on pr.id=oi.product_id
    where coalesce(o.customer_phone,c.phone)=${phone} group by o.id,p.status order by o.created_at desc limit 1`;
  if (!rows.length) return 'Belum ada pesanan dari nomor ini.';
  const order=rows[0];
  return [`Order #${order.order_number} · ${order.status}`,...(order.items||[]).map(item=>`• ${item.quantity}x ${item.name}`),
    `Total: Rp${Number(order.total_amount).toLocaleString('id-ID')}`,`Pembayaran: ${order.payment_status}`].join('\n');
}

async function customerClosingReply(db,phone) {
  const rows=await db`select o.order_number,o.status,p.method,p.status payment_status
    from orders o join customers c on c.id=o.customer_id left join payments p on p.order_id=o.id
    where coalesce(o.customer_phone,c.phone)=${phone} and o.status not in ('CANCELLED','REJECTED')
    order by o.created_at desc limit 1`;
  const order=rows[0];
  if (!order) return 'Sama-sama! Senang bisa bantu 😊';
  if (order.payment_status==='PAID') return `Sama-sama! Pembayaran order #${order.order_number} sudah dikonfirmasi dan pesanannya aman. Sampai ketemu ya 😊`;
  if (order.method==='QRIS'&&order.payment_status==='PENDING') return `Sama-sama! Order #${order.order_number} masih menunggu pengecekan pembayaran QRIS. Nanti aku kabari setelah dikonfirmasi ya.`;
  return `Sama-sama! Order #${order.order_number} sudah tercatat. Bayarnya tunai saat ambil ya 😊`;
}

async function resendPendingQris(db,phone) {
  const rows=await db`select o.order_number,o.total_amount::float8 total_amount
    from orders o join payments p on p.order_id=o.id join customers c on c.id=o.customer_id
    where coalesce(o.customer_phone,c.phone)=${phone} and p.method='QRIS' and p.status='PENDING'
      and o.status not in ('CANCELLED','REJECTED','FULFILLED')
    order by o.created_at desc limit 1`;
  if (!rows.length) return {replyText:'Tidak ada order QRIS pending dari nomor ini. Kalau order sebelumnya sudah kedaluwarsa, buat pesanan baru ya.'};
  if (!process.env.QRIS_IMAGE_URL) return {replyText:'QRIS sedang tidak tersedia. Hubungi owner atau pilih cash ya.'};
  const order=rows[0];
  return {
    qrisImageUrl:process.env.QRIS_IMAGE_URL,
    replyText:`Ini QRIS untuk order #${order.order_number}. Totalnya Rp${Number(order.total_amount).toLocaleString('id-ID')}. Setelah bayar, kirim bukti di chat ini ya.`,
  };
}

function stateVersion(value) {
  if (!value) return null;
  const date=value instanceof Date?value:new Date(value);
  return Number.isFinite(date.getTime())?date.toISOString():String(value);
}

async function loadParseSnapshot(db,phone,excludeMessageId=null) {
  const stateRows=await db`select order_state,updated_at from conversation_order_states
    where channel='whatsapp' and customer_phone=${phone} limit 1`;
  const state=stateRows[0]?.order_state||{};
  const sessionStartedAt=state?._conversation_started_at||null;
  const historyRows=sessionStartedAt?await db`select direction,body from chat_messages
    where customer_phone=${phone} and created_at>=${sessionStartedAt}::timestamptz
      and (${excludeMessageId}::uuid is null or id<>${excludeMessageId}::uuid)
    order by created_at desc,case when direction='OUTBOUND' then 0 else 1 end limit 20`:[];
  return {
    orderState:state,
    stateVersion:stateVersion(stateRows[0]?.updated_at),
    history:historyRows.reverse().map(row=>({role:row.direction==='OUTBOUND'?'assistant':'user',content:row.body})),
  };
}

async function prepareChatTurn(payload,registration) {
  const phone=normalizePhone(payload.phone);
  const snapshot=await loadParseSnapshot(sql,phone,registration?.messageId||null);
  const text=String(payload.text||'').trim();
  if (isOwnerPhone(phone)) {
    return {...snapshot,...await prepareOwnerTurn({payload,snapshot,db:sql}),previousDraft:snapshot.orderState,role:'OWNER'};
  }
  if (snapshot.orderState?._manual_handoff) {
    return {...snapshot,parsed:null,parsedByAi:false,parserLatencyMs:0,previousDraft:snapshot.orderState,role:'CUSTOMER',manualHandoff:true};
  }
  const context=await loadBusinessContext(sql);
  if (payload.hasImage) return {...snapshot,parsed:null,parsedByAi:false,parserLatencyMs:0,products:context.products,previousDraft:snapshot.orderState,role:'CUSTOMER'};

  const saved=snapshot.orderState||{};
  const previous=saved.po_session_id&&saved.po_session_id!==context.po?.id
    ? emptyDraft(context.po?.id||null)
    : {...emptyDraft(context.po?.id||null),...saved,po_session_id:context.po?.id||null,items:Array.isArray(saved.items)?saved.items:[]};
  if (parseUsualOrderRequest(text)||usualOrderReply({text,draft:previous,products:context.products,availability:context.availability})) {
    return {...snapshot,parsed:null,parsedByAi:false,parserLatencyMs:0,products:context.products,previousDraft:previous,role:'CUSTOMER',usualOrder:true};
  }
  const parserStarted=performance.now();
  let parsed=deterministicCustomerTurn(text,previous,context.products);
  if (!parsed&&groqEnabled()) {
    try { parsed=await parseWithGroq({text,currentOrder:previous,menu:context.products,role:'CUSTOMER',pendingQuestion:previous.pending_question,history:snapshot.history}); }
    catch(error) { console.warn('chat_ai_fallback',{phone:hashPhoneForLog(phone),error:safeError(error)}); }
  }
  return {...snapshot,parsed,parsedByAi:Boolean(parsed&&!parsed._source),parserLatencyMs:performance.now()-parserStarted,products:context.products,previousDraft:previous,role:'CUSTOMER'};
}

async function handleCustomer(db,payload,messageId,prepared) {
  if (prepared?.manualHandoff) return {replyText:null,manualHandoff:true};
  const phone=normalizePhone(payload.phone);
  if (payload.hasImage) return customerImage(db,{phone,messageId:payload.waMessageId||messageId});
  const {po,products,availability}=await loadBusinessContext(db);
  let previous=await loadConversation(db,phone,po?.id||null);
  const text=String(payload.text||'').trim();

  let parsed=prepared?.parsed||null;
  let qrisUnavailable=false;
  const explicitConfirmation=isExplicitOrderConfirmation(text,previous);
  console.info('customer_ai_intents',{phone:hashPhoneForLog(phone),source:parsed?(parsed._source||'GROQ'):'SAFE_FAILURE',model:parsed?._model||null,intents:parsed?.intents||[],confidence:parsed?.confidence||0});

  // A model-generated confirmation is advisory only. Only the latest customer
  // message, matched by the deterministic allowlist above, can authorize commit.
  parsed=sanitizeCustomerParsedResult(text,previous,parsed);

  if (parsed?.entities?.payment_method==='QRIS'&&!process.env.QRIS_IMAGE_URL) {
    parsed={...parsed,entities:{...parsed.entities,payment_method:null}};
    qrisUnavailable=true;
  }

  const conversationalActionIntents=new Set([
    'START_ORDER','ADD_ITEM','REMOVE_ITEM','UPDATE_ITEM','PROVIDE_NAME','PROVIDE_CLASS',
    'SET_PAYMENT_METHOD','SHOW_ORDER_DRAFT','CONFIRM_ORDER','CANCEL_ORDER',
    'CHECK_ORDER_STATUS','CHECK_PO_STATUS','SHOW_MENU','ASK_RECOMMENDATION',
    'REQUEST_QRIS_CODE','RESET_ORDER_DRAFT',
  ]);
  const hasConversationalAction=(parsed?.intents||[]).some(intent=>conversationalActionIntents.has(intent));
  if (parsed?.intents?.includes('CONVERSATION_ACK')&&!hasConversationalAction) {
    return {replyText:await customerClosingReply(db,phone)};
  }
  if (parsed?.intents?.includes('GREETING')&&!hasConversationalAction&&!previous.items?.length) {
    return {replyText:parsed.reply_hint||'Hai! Mau pesan atau tanya soal menu hari ini?'};
  }

  if (parsed?.intents?.includes('REQUEST_QRIS_CODE')) return resendPendingQris(db,phone);
  if (parsed?.intents?.includes('RESET_ORDER_DRAFT')&&previous.items?.length) {
    const replaced={...previous,items:[],last_product_id:null,pending_question:'menu',awaiting_confirmation:false,_usual_order_suggestion:null,_confirmation_snapshot:null};
    const saved=await persistConversation(db,{phone,draft:replaced,messageId,confidence:parsed.confidence||0.8});
    return {draftId:saved._draft_id,draft:saved,replyText:`Boleh, pesanan lamanya sudah dikosongkan. Mau ganti dengan apa?\n${menuText(products,availability)}`};
  }

  if (parsed?.intents?.includes('CHECK_ORDER_STATUS')) {
    if (previous.items?.length) return {replyText:draftStatusReply(previous,products)};
    return {replyText:await customerStatus(db,phone)};
  }
  if (parsed?.intents?.includes('IDENTITY')) return {replyText:'Aku asisten AI Baristack App yang jalan pakai Groq. Aku khusus bantu soal menu, PO, pesanan, dan pembayaran ya.'};
  if (parsed?.intents?.includes('SHOW_MENU')&&!po) return {replyText:`Menu Baristack:\n${menuText(products,availability)}\n\nPO belum dibuka ya.`};

  if (!po) {
    if (parsed?.intents?.includes('SHOW_MENU')) return {replyText:`Menu Baristack:\n${menuText(products,availability)}\n\nPO belum dibuka ya.`};
    if (parsed?.intents?.includes('ASK_RECOMMENDATION')) return {replyText:`${groundedRecommendation(text,products,availability)}\n\nPO belum dibuka ya, jadi belum bisa menerima pesanan.`};
    return {replyText:'PO belum dibuka atau sudah ditutup ya. Nanti kalau sudah buka, aku bisa bantu pesan.'};
  }

  const usualRequest=parseUsualOrderRequest(text);
  // Never infer identity from a shared customer name/class or the master phone.
  const history=usualRequest?.supported&&!previous.items.length?await db`
    select o.order_number,
      coalesce(json_agg(json_build_object('product_id',oi.product_id,'quantity',oi.qty,
        'no_ice',oi.no_ice,'notes',oi.notes) order by oi.created_at,oi.id)
        filter(where oi.id is not null),'[]') as items
    from orders o left join order_items oi on oi.order_id=o.id
    where o.customer_phone=${phone} and o.source='WHATSAPP' and o.status='FULFILLED'
    group by o.id order by o.created_at desc,o.id desc limit 1`:[];
  const usual=usualOrderReply({text,draft:previous,history,products,availability});
  if (usual) {
    const candidate={...usual.draft,_confirmation_snapshot:usual.draft.awaiting_confirmation
      ?orderConfirmationSnapshot(usual.draft,products):null};
    const saved=await persistConversation(db,{phone,draft:candidate,messageId,confidence:1});
    return {draftId:saved._draft_id,draft:saved,replyText:usual.replyText||draftReply(saved,products)};
  }

  if (!parsed) {
    const safety=classifyDraftSafety(previous,{parserFailed:true});
    let failedDraft={...safety.draft,awaiting_confirmation:false,_parser_failure:true};
    const isHandoff=safety.classification===SAFETY_CLASSIFICATION.OWNER_HANDOFF;
    const notifyOwner=isHandoff&&!failedDraft._handoff_notified;
    if (isHandoff) failedDraft={...failedDraft,_handoff_notified:true,_manual_handoff:ownerPhones().length>0};
    failedDraft=await persistConversation(db,{phone,draft:failedDraft,messageId,confidence:0,status:'collecting_information'});
    if (isHandoff) return {
      draftId:failedDraft._draft_id,
      draft:failedDraft,
      ...manualHandoffResult({phone,draft:failedDraft,products,issues:safety.issues,notifyOwner}),
    };
    return {
      draftId:failedDraft._draft_id,
      draft:failedDraft,
      replyText:'Maaf, aku belum bisa memastikan maksud pesan itu. Coba tulis ulang menu dan jumlahnya dengan singkat ya.',
    };
  }

  let patchResult;
  const readyToCommit=explicitConfirmation;
  const confidence=parsed?.confidence||0.5;
  patchResult=applyParserAmbiguities(applyStructuredPatch(previous,parsed,products),parsed);
  patchResult.draft={...patchResult.draft,_parser_failure:false};
  let draft=patchResult.draft;
  if (patchResult.cancelled) {
    if (previous._draft_id) await db`update order_drafts set state='REJECTED',updated_at=now() where id=${previous._draft_id}`;
    await db`insert into conversation_order_states(channel,customer_phone,order_state,status,last_message_at)
      values('whatsapp',${phone},${sql.json(emptyDraft(po.id))},'cancelled',now())
      on conflict(channel,customer_phone) do update set order_state=excluded.order_state,status='cancelled',last_message_at=now(),updated_at=now()`;
    return {replyText:'Oke, draft pesanannya dibatalkan.'};
  }

  const safety=classifyDraftSafety(draft,patchResult);
  const skipsConfirmation=(parsed?.intents||[]).some(intent=>['CHECK_PO_STATUS','SHOW_MENU','ASK_RECOMMENDATION','OUT_OF_SCOPE','UNKNOWN'].includes(intent));
  draft={...safety.draft,_confirmation_snapshot:safety.draft.awaiting_confirmation
    ?(skipsConfirmation?previous._confirmation_snapshot||null:orderConfirmationSnapshot(safety.draft,products)):null};
  const isHandoff=safety.classification===SAFETY_CLASSIFICATION.OWNER_HANDOFF;
  const notifyOwner=isHandoff&&!draft._handoff_notified;
  if (isHandoff) draft={...draft,_handoff_notified:true,_manual_handoff:ownerPhones().length>0};
  draft=await persistConversation(db,{phone,draft,messageId,confidence,status:isHandoff?'collecting_information':null});
  if (isHandoff) return {
    draftId:draft._draft_id,
    draft,
    ...manualHandoffResult({phone,draft,products,issues:safety.issues,notifyOwner}),
  };
  if (safety.issues.length) {
    return {draftId:draft._draft_id,draft,replyText:draftReply(draft,products,patchResult)};
  }
  if (/\b(?:kok|kenapa|lah)\s+(?:cuma|hanya)\b/i.test(text)&&draft.items?.length) {
    const unavailable=(previous.last_unresolved||draft.last_unresolved||[])[0];
    const reason=unavailable?` “${unavailable}” sebelumnya tidak ditambahkan karena tidak ada di menu.`:'';
    return {replyText:`Yang tersimpan sekarang:\n${summarizeDraft(draft,products).text}\n${reason}`.trim()};
  }
  if (draft.items?.length&&missingFields(draft)[0]==='payment'&&mentionsUnsupportedPayment(text)) {
    const methods=process.env.QRIS_IMAGE_URL?'cash atau QRIS':'cash';
    return {replyText:`Metode “${text.slice(0,40)}” belum didukung. Pesananmu tetap tersimpan; pilih pembayaran ${methods} ya.\n\n${summarizeDraft(draft,products).text}`};
  }
  if (qrisUnavailable) {
    return {replyText:`QRIS memang tadi sempat ditawarkan, tapi saat ini belum aktif karena kode pembayarannya belum dipasang. Draft pesananmu tetap tersimpan. Kalau mau lanjut, balas “cash” ya.`};
  }
  if (parsed?.intents?.some(intent=>['OUT_OF_SCOPE','UNKNOWN'].includes(intent))) {
    if (draft.items?.length) {
      if (missingFields(draft)[0]==='payment') {
        const methods=process.env.QRIS_IMAGE_URL?'cash atau QRIS':'cash';
        const lead=mentionsUnsupportedPayment(text)
          ? `Metode “${text.slice(0,40)}” belum didukung.`
          : 'Pesananmu masih tersimpan kok.';
        return {replyText:`${lead} Tinggal pilih pembayaran ${methods} ya.\n\n${summarizeDraft(draft,products).text}`};
      }
      return {replyText:draftStatusReply(draft,products)};
    }
    if (previous.pending_question==='menu'||/\b(?:pesan|pesen|mesen|beli|menu)\b/i.test(text)) {
      return {replyText:`“${requestedMenuLabel(text)}” belum tersedia di menu sekarang. Pilih salah satu yang ada ya:\n${menuText(products,availability)}`};
    }
    return {replyText:'Aku khusus bantu soal menu, PO, pesanan, dan pembayaran Baristack ya.'};
  }
  if (parsed?.intents?.includes('CHECK_PO_STATUS')) {
    return {replyText:`${po.name} sedang dibuka${po.cutoff_at?` sampai ${new Date(po.cutoff_at).toLocaleTimeString('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit'})}`:''}.`};
  }
  if (parsed?.intents?.includes('SHOW_MENU')) return {replyText:`Menu Baristack:\n${menuText(products,availability)}`};
  if (parsed?.intents?.includes('ASK_RECOMMENDATION')&&!parsed.entities.item_operations.length) {
    return {replyText:groundedRecommendation(text,products,availability)};
  }
  if (readyToCommit) {
    if (!authorizeOrderCommit({text,previousDraft:previous,safety,menu:products})) {
      return {replyText:`Detail atau harga pesanan perlu dikonfirmasi ulang ya.\n\n${draftReply(draft,products,patchResult)}`};
    }
    const rpcItems=draftItemsForRpc(draft);
    const created=await db`select create_order_bundle(${draft.customer_name},${draft.class_name},${po.id},${sql.json(rpcItems)},
      ${draft.payment_method},${null},'WHATSAPP',${`wa-order:${payload.waMessageId||messageId}`},${phone}) as id`;
    const orderId=created[0].id;
    const orderRows=await db`select o.order_number,o.total_amount::float8 total_amount,p.expires_at
      from orders o join payments p on p.order_id=o.id where o.id=${orderId}`;
    if (draft._draft_id) await db`update order_drafts set state='APPROVED',created_order_id=${orderId},updated_at=now() where id=${draft._draft_id}`;
    const order=orderRows[0];
    const completedState={...emptyDraft(po.id),last_order_id:orderId,last_order_number:order.order_number,last_order_status:'ACCEPTED',
      _conversation_started_at:draft._conversation_started_at||new Date().toISOString()};
    await db`update conversation_order_states set order_state=${sql.json(completedState)},status='confirmed',updated_at=now()
      where channel='whatsapp' and customer_phone=${phone}`;
    const summary=summarizeDraft(draft,products).text;
    if (draft.payment_method==='QRIS') return {
      orderIds:[orderId],qrisImageUrl:process.env.QRIS_IMAGE_URL||null,
      replyText:[`Sip, order #${order.order_number} sudah masuk.`,summary,'','Silakan bayar lewat QRIS lalu kirim bukti di chat ini.'].join('\n'),
    };
    return {orderIds:[orderId],replyText:[`Sip, order #${order.order_number} sudah masuk.`,summary,'','Bayarnya tunai saat ambil ya.'].join('\n')};
  }
  return {draftId:draft._draft_id,draft,replyText:draftReply(draft,products,patchResult)};
}

async function resolveOwnerOrder(db,{orderNumber=null,customerName=null,statuses=['PENDING','UNPAID']}={}) {
  if (!orderNumber&&!customerName) return [];
  return db`select o.id,o.order_number,o.payment_method,c.name,c.class_name,coalesce(o.customer_phone,c.phone) phone,p.status payment_status,p.proof_received_at
    from orders o join customers c on c.id=o.customer_id join payments p on p.order_id=o.id
    where ((${orderNumber}::bigint is not null and o.order_number=${orderNumber})
       or (${customerName}::text is not null and lower(c.name)=lower(${customerName})))
      and p.status in ${sql(statuses)}
    order by o.created_at desc limit 3`;
}

async function saveOwnerState(db,phone,state,status='collecting_information') {
  const existing=await db`select order_state from conversation_order_states where channel='whatsapp' and customer_phone=${phone} limit 1`;
  const hasState=state&&Object.keys(state).length>0;
  const nextState=hasState?{
    ...state,
    _conversation_started_at:existing[0]?.order_state?._conversation_started_at||new Date().toISOString(),
  }:{};
  await db`insert into conversation_order_states(channel,customer_phone,order_state,status,last_message_at)
    values('whatsapp',${phone},${sql.json(nextState)},${status},now())
    on conflict(channel,customer_phone) do update set order_state=excluded.order_state,status=excluded.status,last_message_at=now(),updated_at=now()`;
}

function ownerPoQuestion(missing) {
  const questions={
    tanggal:'PO-nya untuk hari ini atau besok?',
    'jam buka':'Mau mulai buka jam berapa?',
    'jam tutup':'Mau ditutup jam berapa?',
    'max cup':'Maksimal mau terima berapa cup?',
  };
  return questions[missing[0]]||`Data ${missing[0]} belum ada. Mau diisi berapa?`;
}

function quantityInDatabaseUnit(quantity,inputUnit,databaseUnit) {
  const amount=Number(quantity);
  const from=String(inputUnit||databaseUnit||'').toUpperCase();
  const to=String(databaseUnit||'').toUpperCase();
  if (!Number.isFinite(amount)||amount<=0) return null;
  if (from===to||!from) return amount;
  if (from==='L'&&to==='ML') return amount*1000;
  if (from==='ML'&&to==='L') return amount/1000;
  if (from==='KG'&&to==='G') return amount*1000;
  if (from==='G'&&to==='KG') return amount/1000;
  return null;
}

async function handleOwner(db,payload,prepared) {
  const phone=normalizePhone(payload.phone);
  const text=String(payload.text||'').trim();
  const savedRows=await db`select order_state from conversation_order_states where channel='whatsapp' and customer_phone=${phone} limit 1`;
  const saved=savedRows[0]?.order_state||{};
  const context=await loadBusinessContext(db);
  const receivedAt=new Date();
  const parsed=prepared?.parsed||ownerFallback(text);
  const parsedByAi=Boolean(prepared?.parsedByAi);
  const intents=parsed?.intents||[];
  console.info('owner_ai_intents',{phone:hashPhoneForLog(phone),source:parsedByAi?'GROQ':'FALLBACK',model:parsed?._model||null,intents,confidence:parsed?.confidence||0});
  if (saved.pending_owner_action && parsed?.entities?.confirmation===true) {
    const action=saved.pending_owner_action;
    if (action.type==='CLOSE_PO') {
      await db`select set_po_status(${action.poId},'CLOSED') as id`;
      await saveOwnerState(db,phone,{},'confirmed');
      return {replyText:`${action.poName} sudah ditutup.`};
    }
    if (action.type==='CANCEL_ORDER') {
      await db`select cancel_order(${action.orderId},${action.reason||'Dibatalkan owner via WhatsApp'}) as id`;
      await saveOwnerState(db,phone,{},'confirmed');
      return {replyText:`Order #${action.orderNumber} sudah dibatalkan.`,customerNotifications:action.customerPhone?[{phone:action.customerPhone,text:`Order #${action.orderNumber} dibatalkan oleh owner.`}]:[]};
    }
    if (action.type==='ADJUST_INVENTORY') {
      await db`select adjust_inventory(${action.ingredientId},${action.delta},${action.reason}) as id`;
      await saveOwnerState(db,phone,{},'confirmed');
      return {replyText:`Stok ${action.ingredientName} sudah disesuaikan ${action.delta>0?'+':''}${action.delta} ${action.unit}.`};
    }
  }
  const explicitPo=parsedByAi?null:extractOwnerPoFields(text,receivedAt);
  if (explicitPo?.wantsOpen&&!intents.includes('OWNER_OPEN_PO')) intents.push('OWNER_OPEN_PO');
  const orderNumber=parsed?.entities?.order_number||null;

  if (intents.includes('OWNER_OPEN_PO')) {
    const ownerPo={...(saved.pending_owner_po||{})};
    const parsedEntities=parsed?.entities||{};
    const entities={
      ...parsedEntities,
      ...(explicitPo?.date?{po_date:explicitPo.date}:{}),
      ...(explicitPo?.openTime?{open_time:explicitPo.openTime}:{}),
      ...(explicitPo?.closeTime?{close_time:explicitPo.closeTime}:{}),
      ...(explicitPo?.maxCups?{max_cups:explicitPo.maxCups}:{}),
      ...(explicitPo?.ingredientName?{ingredient_name:explicitPo.ingredientName}:{}),
      ...(explicitPo?.ingredientQuantity?{ingredient_quantity:explicitPo.ingredientQuantity}:{}),
    };
    if (entities.po_date) ownerPo.date=entities.po_date;
    if (entities.open_time) ownerPo.openTime=entities.open_time;
    if (entities.schedule_mode==='ABSOLUTE'&&entities.close_date) ownerPo.closeDate=entities.close_date;
    if (entities.schedule_mode==='ABSOLUTE'&&entities.close_time) {
      ownerPo.closeTime=entities.close_time;
      delete ownerPo.durationMinutes;
    }
    if (entities.schedule_mode==='DURATION'&&entities.duration_minutes) {
      ownerPo.durationMinutes=entities.duration_minutes;
      delete ownerPo.closeDate;
    }
    // Compatibility for a valid AI response produced before schedule_mode was
    // added. Prefer an explicit absolute timestamp when both are present.
    if (!entities.schedule_mode&&entities.close_time) {
      ownerPo.closeTime=entities.close_time;
      if (entities.close_date) ownerPo.closeDate=entities.close_date;
      delete ownerPo.durationMinutes;
    } else if (!entities.schedule_mode&&entities.duration_minutes) {
      ownerPo.durationMinutes=entities.duration_minutes;
    }
    if (entities.max_cups) ownerPo.maxCups=entities.max_cups;
    if (entities.ingredient_name&&entities.ingredient_quantity>0) {
      const ingredients=await db`select ingredient_id id,name,unit from inventory_stock where lower(name) like ${`%${entities.ingredient_name.toLowerCase()}%`} limit 2`;
      if (ingredients.length!==1) return {replyText:`Bahan “${entities.ingredient_name}” belum ketemu dengan jelas. Sebut nama bahan seperti Susu UHT.`};
      const normalizedQuantity=quantityInDatabaseUnit(entities.ingredient_quantity,entities.ingredient_unit,ingredients[0].unit);
      if (!normalizedQuantity) return {replyText:`Satuan ${entities.ingredient_unit||''} belum cocok dengan ${ingredients[0].name} (${ingredients[0].unit}).`};
      ownerPo.allocations=[...(ownerPo.allocations||[]).filter(item=>item.ingredientId!==ingredients[0].id),{ingredientId:ingredients[0].id,maxQuantity:normalizedQuantity,autoCloseThreshold:90}];
      ownerPo.ingredientLabel=ingredients[0].name;
      ownerPo.ingredientQuantity=normalizedQuantity;
      ownerPo.ingredientUnit=ingredients[0].unit;
    }
    const missing=[];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ownerPo.date||'')) missing.push('tanggal');
    if (!/^\d{2}:\d{2}$/.test(ownerPo.openTime||'')) missing.push('jam buka');
    if (!/^\d{2}:\d{2}$/.test(ownerPo.closeTime||'')&&!ownerPo.durationMinutes) missing.push('jam tutup');
    if (!ownerPo.maxCups) missing.push('max cup');
    if (missing.length) {
      await saveOwnerState(db,phone,{pending_owner_po:ownerPo,pending_question:`PO kurang: ${missing.join(', ')}`},'collecting_information');
      return {replyText:ownerPoQuestion(missing)};
    }
    const schedule=validateOwnerPoSchedule(ownerPo,receivedAt);
    if (!schedule.ok) {
      await saveOwnerState(db,phone,{pending_owner_po:ownerPo,pending_question:'PO perlu jadwal yang valid'},'collecting_information');
      const remembered=[`max ${ownerPo.maxCups} cup`,ownerPo.ingredientQuantity?`${ownerPo.ingredientLabel||'susu'} ${ownerPo.ingredientQuantity} ml`:null].filter(Boolean).join(' dan ');
      if (schedule.code==='CLOSE_IN_PAST') {
        return {replyText:`Jam tutup ${ownerPo.closeTime} untuk ${ownerPo.date} sudah lewat (sekarang ${jakartaTime(receivedAt)}). ${remembered?`Data ${remembered} sudah gue simpan. `:''}Ganti ke “besok” atau kasih jam tutup yang masih akan datang.`};
      }
      return {replyText:`Jam tutup ${ownerPo.closeTime} harus setelah jam buka ${ownerPo.openTime}. ${remembered?`Data ${remembered} sudah gue simpan. `:''}Cukup kirim jam yang mau dikoreksi.`};
    }
    const {openAt,closeAt}=schedule;
    ownerPo.closeDate=schedule.closeDate;
    ownerPo.closeTime=schedule.closeTime;
    const created=await db`select create_po(${`PO ${ownerPo.date}`},${ownerPo.date},${openAt.toISOString()},${closeAt.toISOString()},${ownerPo.maxCups},${sql.json(ownerPo.allocations||[])},${30}) id`;
    if (openAt.getTime()<=Date.now()) await db`select set_po_status(${created[0].id},'OPEN') id`;
    await saveOwnerState(db,phone,{},'confirmed');
    const closeLabel=schedule.closeDate===ownerPo.date?ownerPo.closeTime:`${ownerPo.closeTime} tanggal ${schedule.closeDate}`;
    return {replyText:openAt.getTime()<=Date.now()?`PO sudah dibuka dan akan tutup ${closeLabel}.`:`PO ${ownerPo.date} dijadwalkan buka ${ownerPo.openTime} dan tutup ${closeLabel}.`};
  }

  if (intents.includes('OWNER_PAYMENT_CONFIRM')) {
    const matches=await resolveOwnerOrder(db,{orderNumber,customerName:parsed?.entities?.name,statuses:['PENDING']});
    if (matches.length!==1) return {replyText:orderNumber?'Order QRIS pending itu tidak ditemukan.':'Sebutkan nomor ordernya, misalnya “confirm qris #15”.'};
    if (!matches[0].proof_received_at) return {replyText:`Order #${matches[0].order_number} belum mengirim bukti QRIS.`};
    await db`select confirm_cash_payment(${matches[0].id}) as id`;
    return {replyText:`QRIS order #${matches[0].order_number} sudah dikonfirmasi.`,customerNotifications:matches[0].phone?[{phone:matches[0].phone,text:`Pembayaran QRIS order #${matches[0].order_number} sudah masuk. Pesanan kamu sudah dikonfirmasi ya.`}]:[]};
  }
  if (intents.includes('OWNER_PAYMENT_REJECT')) {
    const matches=await resolveOwnerOrder(db,{orderNumber,customerName:parsed?.entities?.name,statuses:['PENDING']});
    if (matches.length!==1) return {replyText:'Sebutkan nomor order QRIS yang mau ditolak.'};
    await db`select cancel_order(${matches[0].id},'Pembayaran QRIS ditolak owner') as id`;
    return {replyText:`Order #${matches[0].order_number} ditolak dan reservation dilepas.`,customerNotifications:matches[0].phone?[{phone:matches[0].phone,text:`Pembayaran order #${matches[0].order_number} belum ditemukan, jadi pesanannya dibatalkan. Hubungi owner kalau ada kekeliruan.`}]:[]};
  }
  if (intents.includes('OWNER_CLOSE_PO')) {
    if (!context.po) return {replyText:'Tidak ada PO yang sedang dibuka.'};
    await saveOwnerState(db,phone,{pending_owner_action:{type:'CLOSE_PO',poId:context.po.id,poName:context.po.name}},'collecting_information');
    return {replyText:`Tutup ${context.po.name} sekarang? Balas “iya” untuk konfirmasi.`};
  }
  if (intents.includes('OWNER_CANCEL_ORDER')) {
    const matches=await resolveOwnerOrder(db,{orderNumber,customerName:parsed?.entities?.name,statuses:['PENDING','UNPAID','PAID']});
    if (matches.length!==1) return {replyText:'Sebutkan nomor order yang mau dibatalkan.'};
    await saveOwnerState(db,phone,{pending_owner_action:{type:'CANCEL_ORDER',orderId:matches[0].id,orderNumber:matches[0].order_number,customerPhone:matches[0].phone,reason:'Dibatalkan owner via WhatsApp'}},'collecting_information');
    return {replyText:`Batalkan order #${matches[0].order_number} milik ${matches[0].name}? Balas “iya” untuk konfirmasi.`};
  }
  if (intents.includes('OWNER_INVENTORY_UPDATE')) {
    const name=parsed?.entities?.ingredient_name;
    const quantity=Number(parsed?.entities?.ingredient_quantity||0);
    const direction=parsed?.entities?.inventory_change==='DECREASE'?-1:parsed?.entities?.inventory_change==='INCREASE'?1:0;
    if (!name||!quantity||!direction) return {replyText:'Sebut perubahan sebagai penambahan/pengurangan, misalnya “tambah stok susu 946 ml”. Untuk set angka absolut, pakai halaman Stok.'};
    const matches=await db`select ingredient_id id,name,unit from inventory_stock where lower(name) like ${`%${name.toLowerCase()}%`} limit 2`;
    if (matches.length!==1) return {replyText:`Bahan “${name}” belum ketemu dengan jelas.`};
    const normalizedQuantity=quantityInDatabaseUnit(quantity,parsed?.entities?.ingredient_unit,matches[0].unit);
    if (!normalizedQuantity) return {replyText:`Satuan ${parsed?.entities?.ingredient_unit||''} belum cocok dengan ${matches[0].name} (${matches[0].unit}).`};
    const delta=direction*normalizedQuantity;
    await saveOwnerState(db,phone,{pending_owner_action:{type:'ADJUST_INVENTORY',ingredientId:matches[0].id,ingredientName:matches[0].name,unit:matches[0].unit,delta,reason:'Penyesuaian owner via WhatsApp'}},'collecting_information');
    return {replyText:`Ubah stok ${matches[0].name} ${delta>0?'+':''}${delta} ${matches[0].unit}? Balas “iya” untuk konfirmasi.`};
  }
  if (intents.includes('OWNER_INVENTORY_QUERY')) {
    const ingredient=parsed?.entities?.ingredient_name;
    const rows=ingredient
      ? await db`select name,unit,available_stock::float8 available_stock,low_stock_threshold::float8 threshold from inventory_stock where lower(name) like ${`%${ingredient.toLowerCase()}%`} order by name`
      : await db`select name,unit,available_stock::float8 available_stock,low_stock_threshold::float8 threshold from inventory_stock order by name`;
    return {replyText:rows.length?['Stok tersedia:',...rows.map(row=>`• ${row.name}: ${Number(row.available_stock.toFixed(2))} ${row.unit}${row.available_stock<=row.threshold?' ⚠️':''}`)].join('\n'):'Bahannya tidak ditemukan.'};
  }
  if (intents.includes('OWNER_PAYMENT_QUERY')) {
    const rows=await db`select o.order_number,c.name,c.class_name,p.method,p.amount::float8 amount,p.status
      from orders o join customers c on c.id=o.customer_id join payments p on p.order_id=o.id
      where p.status in ('PENDING','UNPAID') and o.status not in ('CANCELLED','REJECTED','FULFILLED') order by o.created_at`;
    return {replyText:rows.length?['Belum lunas:',...rows.map(row=>`• #${row.order_number} ${row.name}${row.class_name?` · ${row.class_name}`:''} — ${row.method} Rp${Number(row.amount).toLocaleString('id-ID')}`)].join('\n'):'Semua order aktif sudah lunas.'};
  }
  if (intents.some(intent=>['OWNER_PO_QUERY','OWNER_PRODUCTION_QUERY','CHECK_PO_STATUS'].includes(intent))) {
    if (!context.po) return {replyText:'Tidak ada PO yang sedang dibuka.'};
    const rows=await db`select get_po_summary(${context.po.id}) as value`;
    const summary=rows[0].value;
    return {replyText:[`${context.po.name} · ${context.po.status}`,`${summary.totalOrders} order / ${summary.totalCups} cup`,
      ...(summary.menuTotals||[]).map(item=>`• ${item.name}: ${item.quantity}`),'Kebutuhan bahan:',
      ...(summary.ingredientTotals||[]).map(item=>`• ${item.name}: ${Number(item.quantity)} ${item.unit}`),
      `Omzet: Rp${Number(summary.revenue||0).toLocaleString('id-ID')} · ${summary.unpaid} belum lunas`].join('\n')};
  }
  if (intents.includes('IDENTITY')) return {replyText:'Gue asisten AI Baristack App yang jalan pakai Groq. Gue bisa bantu ngobrol soal PO, stok, pesanan, produksi, dan pembayaran, tapi keputusan bisnis tetap dicek sistem Baristack App.'};
  if (intents.includes('OUT_OF_SCOPE')) return {replyText:'Gue khusus bantu operasional Baristack: stok, PO, pesanan, produksi, dan pembayaran.'};
  return {replyText:parsed?.reply_hint||'Mau cek stok, PO, kebutuhan produksi, atau pembayaran yang belum lunas?'};
}

async function storeOutboundReply(db,payload,messageId,replyText) {
  if (typeof replyText!=='string'||!replyText.trim()) return;
  await db`insert into chat_messages(provider,customer_phone,direction,body,payload,dedupe_key,delivery_status)
    values(${payload.provider||'baileys'},${normalizePhone(payload.phone)},'OUTBOUND',${replyText.trim()},
      ${sql.json({inReplyTo:payload.waMessageId||messageId})},${`reply:${payload.waMessageId||messageId}`},'PENDING')
    on conflict do nothing`;
}

async function registerInboundMessage(payload) {
  const phone=normalizePhone(payload.phone);
  const text=String(payload.text||'').trim();
  const waMessageId=payload.waMessageId?String(payload.waMessageId):null;
  const leaseId=randomUUID();
  const requestedMode=chatbotMode()==='shadow'&&!isOwnerPhone(phone)?'shadow':'confirmation';
  return sql.begin(async db=>{
    let rows=await db`insert into chat_messages(provider,wa_message_id,customer_phone,customer_name,body,payload)
      values(${payload.provider||'baileys'},${waMessageId},${phone},${payload.pushName||null},${text||'[gambar]'},
        ${sql.json({hasImage:Boolean(payload.hasImage),receivedAt:payload.receivedAt||null,processingMode:requestedMode})}::jsonb||jsonb_build_object(
          'processingState','PENDING','processingLeaseId',${leaseId}::text,
          'processingLeaseExpiresAt',now()+(${PROCESSING_LEASE_SECONDS}*interval '1 second'),'processingAttempt',1))
      on conflict(wa_message_id) do nothing returning id,created_at,payload`;
    let recovered=false;
    if (!rows.length&&waMessageId) {
      rows=await db`update chat_messages set payload=(coalesce(payload,'{}'::jsonb)-'processingLeaseId'-'processingLeaseExpiresAt')||jsonb_build_object(
          'processingState','PENDING','processingLeaseId',${leaseId}::text,
          'processingLeaseExpiresAt',now()+(${PROCESSING_LEASE_SECONDS}*interval '1 second'),
          'processingAttempt',coalesce((payload->>'processingAttempt')::int,0)+1,'recoveredAt',now())
        where wa_message_id=${waMessageId} and direction='INBOUND' and payload->>'processingState'='PENDING'
          and ((payload->>'processingLeaseExpiresAt' is null and created_at<=now()-(${PROCESSING_LEASE_SECONDS}*interval '1 second'))
            or (payload->>'processingLeaseExpiresAt' is not null and (payload->>'processingLeaseExpiresAt')::timestamptz<=now()))
        returning id,created_at,payload`;
      recovered=rows.length>0;
    }
    if (!rows.length) return {duplicate:true};
    const recent=await db`select count(*)::int total from chat_messages
      where direction='INBOUND' and customer_phone=${phone} and created_at>now()-interval '1 minute'`;
    const limit=isOwnerPhone(phone)?60:15;
    const processingMode=rows[0].payload?.processingMode||requestedMode;
    if (processingMode!=='shadow'&&!recovered&&Number(recent[0]?.total||0)>limit) {
      const replyText='Pesannya terlalu cepat. Tunggu sebentar lalu coba lagi ya.';
      await db`update chat_messages set payload=(coalesce(payload,'{}'::jsonb)-'processingLeaseId'-'processingLeaseExpiresAt')||${sql.json({processingState:'APPLIED',rateLimited:true})}::jsonb where id=${rows[0].id}`;
      await storeOutboundReply(db,payload,rows[0].id,replyText);
      return {finalResult:{id:rows[0].id,replyText}};
    }
    return {messageId:rows[0].id,messageCreatedAt:stateVersion(rows[0].created_at),leaseId,recovered,processingMode};
  });
}

async function applyPreparedTurn(payload,registration,prepared) {
  const phone=normalizePhone(payload.phone);
  return sql.begin(async db=>{
    await db`select pg_advisory_xact_lock(hashtextextended(${phone},0))`;
    const messageRows=await db`select id,created_at,payload from chat_messages where id=${registration.messageId} for update`;
    if (!messageRows.length) return {status:'STALE',result:{duplicate:true}};
    const processingState=messageRows[0].payload?.processingState;
    const ownsLease=messageRows[0].payload?.processingLeaseId===registration.leaseId;
    if (processingState!=='PENDING'||!ownsLease) return {status:'STALE',result:{duplicate:true}};

    const stateRows=await db`select order_state,updated_at from conversation_order_states
      where channel='whatsapp' and customer_phone=${phone} limit 1`;
    const currentState=stateRows[0]?.order_state||{};
    const applicability=decideParsedResultApplicability({
      snapshotVersion:prepared.stateVersion,
      currentVersion:stateVersion(stateRows[0]?.updated_at),
      messageCreatedAt:registration.messageCreatedAt,
      lastAppliedAt:currentState._last_applied_message_created_at,
    });
    if (applicability==='STALE') {
      await db`update chat_messages set payload=(coalesce(payload,'{}'::jsonb)-'processingLeaseId'-'processingLeaseExpiresAt')||${sql.json({processingState:'STALE'})}::jsonb where id=${registration.messageId}`;
      return {status:'STALE',result:{id:registration.messageId,superseded:true}};
    }
    if (applicability==='RETRY') return {status:'RETRY'};

    const result=prepared.role==='OWNER'
      ? await handleOwnerTurn(db,payload,registration.messageId,prepared)
      : await handleCustomer(db,payload,registration.messageId,prepared);
    const marker={
      _last_applied_message_id:payload.waMessageId||registration.messageId,
      _last_applied_message_created_at:registration.messageCreatedAt,
    };
    await db`insert into conversation_order_states(channel,customer_phone,order_state,status,last_message_at)
      values('whatsapp',${phone},${sql.json(marker)},'draft',now())
      on conflict(channel,customer_phone) do update set
        order_state=conversation_order_states.order_state||excluded.order_state,
        last_message_at=now(),updated_at=now()`;
    await db`update chat_messages set payload=(coalesce(payload,'{}'::jsonb)-'processingLeaseId'-'processingLeaseExpiresAt')||${sql.json({processingState:'APPLIED'})}::jsonb where id=${registration.messageId}`;
    await storeOutboundReply(db,payload,registration.messageId,result.replyText);
    console.info('chat_message_processed',{messageId:payload.waMessageId||registration.messageId,phone:hashPhoneForLog(phone),role:prepared.role,result:result.orderIds?'ORDER_CREATED':'REPLIED'});
    return {status:'APPLIED',result:{id:registration.messageId,...result}};
  });
}

function newestTimestamp(...values) {
  return values.filter(Boolean).sort((left,right)=>new Date(right).getTime()-new Date(left).getTime())[0]||null;
}

async function insertShadowObservation(db,{payload,registration,observation,customerRef,outcome}) {
  return db`insert into chat_shadow_observations(
      source_message_id,wa_message_id,customer_ref,source_message_created_at,normalized_input,
      parser_intents,resolved_items,unresolved_entities,ambiguities,safety_classification,
      clarification_reason,parser_failed,parser_latency_ms,parser_provider,parser_model,
      would_be_safe,parser_result,processing_outcome)
    values(${registration.messageId},${payload.waMessageId||registration.messageId},${customerRef},${registration.messageCreatedAt},
      ${observation.normalizedInput},${sql.json(observation.parserIntents)},${sql.json(observation.resolvedItems)},
      ${sql.json(observation.unresolvedEntities)},${sql.json(observation.ambiguities)},${observation.safetyClassification},
      ${observation.clarificationReason},${observation.parserFailed},${observation.parserLatencyMs},
      ${observation.parserProvider},${observation.parserModel},${observation.wouldBeSafe},
      ${observation.parserResult?sql.json(observation.parserResult):null},${outcome})
    on conflict do nothing returning id`;
}

async function applyShadowTurn(payload,registration,prepared) {
  const phone=normalizePhone(payload.phone);
  const customerRef=shadowCustomerRef(phone);
  const observation=buildShadowObservation({text:payload.text,prepared});
  return sql.begin(async db=>{
    await db`select pg_advisory_xact_lock(hashtextextended(${phone},0))`;
    const messageRows=await db`select payload from chat_messages where id=${registration.messageId} for update`;
    if (!messageRows.length||messageRows[0].payload?.processingState!=='PENDING'||messageRows[0].payload?.processingLeaseId!==registration.leaseId) {
      return {status:'STALE',result:{duplicate:true,shadow:true}};
    }
    const [stateRows,shadowRows]=await Promise.all([
      db`select order_state,updated_at from conversation_order_states where channel='whatsapp' and customer_phone=${phone} limit 1`,
      db`select source_message_created_at from chat_shadow_observations where customer_ref=${customerRef}
        order by source_message_created_at desc limit 1`,
    ]);
    const currentState=stateRows[0]?.order_state||{};
    const lastAppliedAt=newestTimestamp(currentState._last_applied_message_created_at,shadowRows[0]?.source_message_created_at);
    const applicability=decideParsedResultApplicability({
      snapshotVersion:prepared.stateVersion,
      currentVersion:stateVersion(stateRows[0]?.updated_at),
      messageCreatedAt:registration.messageCreatedAt,
      lastAppliedAt,
    });
    if (applicability==='RETRY') return {status:'RETRY'};
    const outcome=applicability==='STALE'?'STALE':'OBSERVED';
    const inserted=await insertShadowObservation(db,{payload,registration,observation,customerRef,outcome});
    if (!inserted.length) return {status:'STALE',result:{duplicate:true,shadow:true}};
    await db`update chat_messages set payload=(coalesce(payload,'{}'::jsonb)-'processingLeaseId'-'processingLeaseExpiresAt')||
      ${sql.json({processingState:applicability==='STALE'?'STALE':'APPLIED',shadowMode:true})}::jsonb where id=${registration.messageId}`;
    console.info('chat_shadow_observed',{messageId:payload.waMessageId||registration.messageId,safety:observation.safetyClassification,outcome});
    return {status:applicability==='STALE'?'STALE':'APPLIED',result:{id:registration.messageId,shadow:true,superseded:applicability==='STALE'}};
  });
}

async function finalizeShadowContention(payload,registration,prepared) {
  const phone=normalizePhone(payload.phone);
  const customerRef=shadowCustomerRef(phone);
  const observation=buildShadowObservation({text:payload.text,prepared:prepared||{}});
  return sql.begin(async db=>{
    await db`select pg_advisory_xact_lock(hashtextextended(${phone},0))`;
    const rows=await db`select payload from chat_messages where id=${registration.messageId} for update`;
    if (!rows.length||rows[0].payload?.processingState!=='PENDING'||rows[0].payload?.processingLeaseId!==registration.leaseId) return {id:registration.messageId,duplicate:true,shadow:true};
    await insertShadowObservation(db,{payload,registration,observation,customerRef,outcome:'STALE'});
    await db`update chat_messages set payload=(coalesce(payload,'{}'::jsonb)-'processingLeaseId'-'processingLeaseExpiresAt')||
      ${sql.json({processingState:'STALE',shadowMode:true,contentionExhausted:true})}::jsonb where id=${registration.messageId}`;
    return {id:registration.messageId,shadow:true,superseded:true};
  });
}

async function finalizeContention(payload,registration) {
  const phone=normalizePhone(payload.phone);
  const replyText='Pesan lain masuk bersamaan. Coba kirim ulang pesan terakhir ya.';
  return sql.begin(async db=>{
    await db`select pg_advisory_xact_lock(hashtextextended(${phone},0))`;
    const rows=await db`select payload from chat_messages where id=${registration.messageId} for update`;
    if (!rows.length||rows[0].payload?.processingState!=='PENDING'||rows[0].payload?.processingLeaseId!==registration.leaseId) return {id:registration.messageId,duplicate:true};
    const marker={
      _last_applied_message_id:payload.waMessageId||registration.messageId,
      _last_applied_message_created_at:registration.messageCreatedAt,
    };
    await db`insert into conversation_order_states(channel,customer_phone,order_state,status,last_message_at)
      values('whatsapp',${phone},${sql.json(marker)},'draft',now())
      on conflict(channel,customer_phone) do update set
        order_state=conversation_order_states.order_state||excluded.order_state,
        last_message_at=now(),updated_at=now()`;
    await db`update chat_messages set payload=(coalesce(payload,'{}'::jsonb)-'processingLeaseId'-'processingLeaseExpiresAt')||${sql.json({processingState:'APPLIED',contentionExhausted:true})}::jsonb where id=${registration.messageId}`;
    await storeOutboundReply(db,payload,registration.messageId,replyText);
    return {id:registration.messageId,replyText};
  });
}

export async function handleChatInbound(payload) {
  const phone=normalizePhone(payload.phone);
  const text=String(payload.text||'').trim();
  if (!phone) throw new Error('Nomor pengirim tidak valid');
  if (!text&&!payload.hasImage) throw new Error('Isi pesan wajib ada');
  return runInboundPipeline({
    payload,
    register:registerInboundMessage,
    prepare:prepareChatTurn,
    apply:(currentPayload,registration,prepared)=>registration.processingMode==='shadow'
      ?applyShadowTurn(currentPayload,registration,prepared)
      :applyPreparedTurn(currentPayload,registration,prepared),
    onExhausted:(currentPayload,registration,prepared)=>registration.processingMode==='shadow'
      ?finalizeShadowContention(currentPayload,registration,prepared)
      :finalizeContention(currentPayload,registration,prepared),
  });
}

export async function recoverAbandonedInboundMessages(limit=3) {
  const boundedLimit=Math.max(1,Math.min(Number(limit)||3,10));
  const rows=await sql`select provider,wa_message_id,customer_phone,customer_name,body,payload
    from chat_messages
    where direction='INBOUND' and wa_message_id is not null and payload->>'processingState'='PENDING'
      and ((payload->>'processingLeaseExpiresAt' is null and created_at<=now()-(${PROCESSING_LEASE_SECONDS}*interval '1 second'))
        or (payload->>'processingLeaseExpiresAt' is not null and (payload->>'processingLeaseExpiresAt')::timestamptz<=now()))
    order by created_at asc limit ${boundedLimit}`;
  const byCustomer=new Map();
  for (const row of rows) byCustomer.set(row.customer_phone,[...(byCustomer.get(row.customer_phone)||[]),row]);
  const groups=await Promise.all([...byCustomer.values()].map(async customerRows=>{
    const recovered=[];
    for (const row of customerRows) {
      const result=await handleChatInbound({
        provider:row.provider,
        waMessageId:row.wa_message_id,
        phone:row.customer_phone,
        pushName:row.customer_name,
        text:row.body==='[gambar]'?'':row.body,
        hasImage:Boolean(row.payload?.hasImage),
        receivedAt:row.payload?.receivedAt||null,
      });
      recovered.push({phone:row.customer_phone,...result});
    }
    return recovered;
  }));
  return groups.flat();
}

export { normalizePhone, isOwnerPhone, mentionsPaymentMethod, mentionsUnsupportedPayment, requestedMenuLabel, draftReply, draftStatusReply };
