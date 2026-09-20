const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

const INTENTS = [
  'GREETING','SHOW_MENU','ASK_RECOMMENDATION','START_ORDER','ADD_ITEM','REMOVE_ITEM','UPDATE_ITEM',
  'PROVIDE_NAME','PROVIDE_CLASS','SET_PAYMENT_METHOD','SHOW_ORDER_DRAFT','CONFIRM_ORDER','CANCEL_ORDER',
  'CHECK_ORDER_STATUS','CHECK_PO_STATUS','GENERAL_BUSINESS_QUESTION','OWNER_INVENTORY_QUERY','OWNER_PO_QUERY',
  'OWNER_PRODUCTION_QUERY','OWNER_PAYMENT_QUERY','OWNER_OPEN_PO','OWNER_CLOSE_PO','OWNER_PAYMENT_CONFIRM','OWNER_PAYMENT_REJECT',
  'OWNER_CANCEL_ORDER','OWNER_INVENTORY_UPDATE','IDENTITY','CONVERSATION_ACK','REQUEST_QRIS_CODE','RESET_ORDER_DRAFT','OUT_OF_SCOPE','UNKNOWN',
];

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intents','entities','reply_hint','confidence'],
  properties: {
    intents: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', enum: INTENTS } },
    entities: {
      type: 'object', additionalProperties: false,
      required: ['name','class_name','payment_method','item_operations','order_number','po_date','open_time','close_date','close_time','duration_minutes','schedule_mode','max_cups','ingredient_name','ingredient_quantity','ingredient_unit','inventory_change','confirmation'],
      properties: {
        name: { type: ['string','null'] },
        class_name: { type: ['string','null'] },
        payment_method: { type: ['string','null'], enum: ['CASH','QRIS',null] },
        item_operations: {
          type: ['array','null'], maxItems: 12,
          items: {
            type: 'object', additionalProperties: false,
            required: ['action','product_query','quantity','modifiers','notes'],
            properties: {
              action: { type: 'string', enum: ['ADD','REMOVE','UPDATE'] },
              product_query: { type: 'string' },
              quantity: { type: ['integer','null'], minimum: 1, maximum: 100 },
              modifiers: { type: ['array','null'], maxItems: 6, items: { type: 'string' } },
              notes: { type: ['string','null'] },
            },
          },
        },
        order_number: { type: ['integer','null'], minimum: 1 },
        po_date: { type: ['string','null'] },
        open_time: { type: ['string','null'] },
        close_date: { type: ['string','null'] },
        close_time: { type: ['string','null'] },
        duration_minutes: { type: ['integer','null'], minimum: 1, maximum: 1440 },
        schedule_mode: { type: ['string','null'], enum: ['ABSOLUTE','DURATION',null] },
        max_cups: { type: ['integer','null'], minimum: 1 },
        ingredient_name: { type: ['string','null'] },
        ingredient_quantity: { type: ['number','null'] },
        ingredient_unit: { type: ['string','null'], enum: ['ML','L','G','KG','PCS',null] },
        inventory_change: { type: ['string','null'], enum: ['INCREASE','DECREASE',null] },
        confirmation: { type: ['boolean','null'] },
      },
    },
    reply_hint: { type: ['string','null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const CUSTOMER_INTENTS = [
  'GREETING','SHOW_MENU','ASK_RECOMMENDATION','START_ORDER','ADD_ITEM','REMOVE_ITEM','UPDATE_ITEM',
  'PROVIDE_NAME','PROVIDE_CLASS','SET_PAYMENT_METHOD','SHOW_ORDER_DRAFT','CONFIRM_ORDER','CANCEL_ORDER',
  'CHECK_ORDER_STATUS','CHECK_PO_STATUS','IDENTITY','CONVERSATION_ACK','OUT_OF_SCOPE','UNKNOWN',
  'REQUEST_QRIS_CODE','RESET_ORDER_DRAFT',
];
const OWNER_INTENTS = [
  'GREETING','SHOW_MENU','CHECK_PO_STATUS','GENERAL_BUSINESS_QUESTION','OWNER_INVENTORY_QUERY','OWNER_PO_QUERY',
  'OWNER_PRODUCTION_QUERY','OWNER_PAYMENT_QUERY','OWNER_OPEN_PO','OWNER_CLOSE_PO','OWNER_PAYMENT_CONFIRM',
  'OWNER_PAYMENT_REJECT','OWNER_CANCEL_ORDER','OWNER_INVENTORY_UPDATE','IDENTITY','OUT_OF_SCOPE','UNKNOWN',
];

export function responseSchemaForRole(role) {
  const schema=structuredClone(RESPONSE_SCHEMA);
  const owner=role==='OWNER';
  schema.properties.intents.items.enum=owner?OWNER_INTENTS:CUSTOMER_INTENTS;
  const keep=owner
    ? ['name','order_number','po_date','open_time','close_date','close_time','duration_minutes','schedule_mode','max_cups','ingredient_name','ingredient_quantity','ingredient_unit','inventory_change','confirmation']
    : ['name','class_name','payment_method','item_operations','order_number','confirmation'];
  const properties=schema.properties.entities.properties;
  for (const key of Object.keys(properties)) if (!keep.includes(key)) delete properties[key];
  schema.properties.entities.required=keep;
  return schema;
}

function cleanText(value, max = 120) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0,max) : null;
}

function cleanClock(value) {
  const match=String(value||'').trim().match(/^(\d{1,2})[.:](\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hour=Number(match[1]);
  const minute=Number(match[2]);
  if (hour<0||hour>23||minute<0||minute>59) return null;
  return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

function validateOutput(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.intents) || !raw.entities) return null;
  const intents = [...new Set(raw.intents.filter(value => INTENTS.includes(value)))];
  if (!intents.length) intents.push('UNKNOWN');
  const entities = raw.entities;
  return {
    intents,
    entities: {
      name: cleanText(entities.name,40),
      class_name: cleanText(entities.class_name,20),
      payment_method: ['CASH','QRIS'].includes(entities.payment_method) ? entities.payment_method : null,
      item_operations: Array.isArray(entities.item_operations) ? entities.item_operations.map(operation => ({
        action: ['ADD','REMOVE','UPDATE'].includes(operation?.action) ? operation.action : 'ADD',
        product_query: cleanText(operation?.product_query,80),
        quantity: Number.isInteger(operation?.quantity) && operation.quantity > 0 && operation.quantity <= 100 ? operation.quantity : null,
        modifiers: Array.isArray(operation?.modifiers) ? operation.modifiers.map(value => String(value).trim().toLowerCase()).filter(Boolean).slice(0,6) : [],
        notes: cleanText(operation?.notes,160),
      })).filter(operation => operation.product_query) : [],
      order_number: Number.isInteger(entities.order_number) && entities.order_number > 0 ? entities.order_number : null,
      po_date: cleanText(entities.po_date,20),
      open_time: cleanClock(entities.open_time),
      close_date: cleanText(entities.close_date,20),
      close_time: cleanClock(entities.close_time),
      duration_minutes: Number.isInteger(entities.duration_minutes)&&entities.duration_minutes>0&&entities.duration_minutes<=1440?entities.duration_minutes:null,
      schedule_mode: ['ABSOLUTE','DURATION'].includes(entities.schedule_mode)?entities.schedule_mode:null,
      max_cups: Number.isInteger(entities.max_cups) && entities.max_cups > 0 ? entities.max_cups : null,
      ingredient_name: cleanText(entities.ingredient_name,80),
      ingredient_quantity: Number.isFinite(entities.ingredient_quantity) ? Number(entities.ingredient_quantity) : null,
      ingredient_unit: ['ML','L','G','KG','PCS'].includes(entities.ingredient_unit)?entities.ingredient_unit:null,
      inventory_change: ['INCREASE','DECREASE'].includes(entities.inventory_change) ? entities.inventory_change : null,
      confirmation: typeof entities.confirmation === 'boolean' ? entities.confirmation : null,
    },
    reply_hint: cleanText(raw.reply_hint,400),
    confidence: Math.max(0,Math.min(1,Number(raw.confidence || 0))),
  };
}

export function groqEnabled() {
  return Boolean(process.env.GROQ_API_KEY);
}

function compactConversationState(role,state={}) {
  if (role==='OWNER') return {
    pending_owner_po:state.pending_owner_po||null,
    pending_owner_action:state.pending_owner_action||null,
    pending_question:state.pending_question||null,
  };
  return {
    po_session_id:state.po_session_id||null,
    customer_name:state.customer_name||null,
    class_name:state.class_name||null,
    payment_method:state.payment_method||null,
    items:Array.isArray(state.items)?state.items.map(item=>({
      productId:item.productId,quantity:item.quantity,modifiers:item.modifiers||[],notes:item.notes||null,
    })):[],
    pending_question:state.pending_question||null,
    last_product_id:state.last_product_id||null,
    awaiting_confirmation:Boolean(state.awaiting_confirmation),
    last_order_id:state.last_order_id||null,
    last_order_number:state.last_order_number||null,
    last_order_status:state.last_order_status||null,
  };
}

function systemPromptForRole(role) {
  const common=[
    `Kamu adalah otak percakapan Baristack App untuk role ${role}. Output wajib sesuai JSON schema.`,
    'Pahami bahasa Indonesia natural, slang, typo ringan, riwayat, dan koreksi lintas pesan. Jangan tanya ulang data yang sudah ada di STATE.',
    'Ambil semua intent/entity dari pesan terbaru. Jangan menjalankan aksi atau memutuskan stok, harga, pembayaran, dan kapasitas; backend yang memvalidasi.',
    'IDENTITY untuk pertanyaan siapa kamu/Groq. OUT_OF_SCOPE untuk hal di luar menu, PO, order, payment, dan operasional Baristack.',
    'reply_hint singkat, natural, sesuai gaya user, dan tidak boleh mengklaim mutation berhasil.',
  ];
  if (role==='OWNER') return [...common,
    'Pilih owner intent yang paling tepat. confirmation=true hanya untuk konfirmasi aksi pending sebelumnya.',
    'Saat STATE punya pending_owner_po, pesan koreksi/detail PO menjadi OWNER_OPEN_PO; pertanyaan lain tetap intent aslinya.',
    'OWNER_OPEN_PO: po_date YYYY-MM-DD; jam HH:MM zona Asia/Jakarta. Hari ini/besok/sekarang dihitung dari CURRENT_JAKARTA.',
    'po_date adalah tanggal buka. “12 malam” adalah 00:00 hari berikutnya jika buka malam; “12 siang” adalah 12:00.',
    'Jam tutup eksplisit memakai schedule_mode=ABSOLUTE. “N menit/jam setelah buka” memakai DURATION + duration_minutes dan jangan mengarang close_time.',
    'Angka cup/ml/liter/gram/kg/pcs adalah jumlah, bukan jam. Ambil seluruh tanggal, jam, max cup, bahan, jumlah, dan satuannya.',
    'Pesan yang hanya mengoreksi satu field tidak boleh menghilangkan field PO lama. Untuk update stok isi arah INCREASE/DECREASE, bukan stok akhir.',
  ].join('\n');
  return [...common,
    'Gunakan item_operations untuk cart; pertahankan kata menu user di product_query karena backend yang resolve ke product id.',
    'Permintaan minuman yang tidak ada di liveMenu tetap START_ORDER/ADD_ITEM dengan product_query asli, bukan OUT_OF_SCOPE. Backend yang akan menjelaskan menu itu tidak tersedia.',
    'Kalimat yang merujuk pesanan sebelumnya seperti “lah tadi 5”, “udah tadi”, atau “pesanan gue tadi” adalah SHOW_ORDER_DRAFT/CHECK_ORDER_STATUS; jangan mengarang entity baru.',
    'Payment method hanya boleh diisi jika pesan TERBARU secara eksplisit menyebut cash/tunai atau QRIS. Jangan menyalin atau menyimpulkan payment dari riwayat.',
    'CONVERSATION_ACK untuk ucapan terima kasih, apresiasi, atau penutup singkat setelah interaksi/order, termasuk slang dan typo seperti “okee siapp thanks”, “makasii”, “sip bro”, atau “mantap”. Jangan ubah menjadi GREETING, SHOW_MENU, atau OUT_OF_SCOPE.',
    'REQUEST_QRIS_CODE jika user meminta kode/gambar QRIS dikirim atau diulang. RESET_ORDER_DRAFT jika user jelas ingin mengosongkan draft lalu mengganti pesanannya.',
    'GREETING hanya untuk sapaan. Sapaan tidak otomatis berarti user meminta daftar menu. START_ORDER jika user jelas ingin memesan.',
    'Jika user memilih satu menu, ADD item itu. Quantity null hanya jika jumlah belum disebut. Nama hanya jika jelas nama customer, bukan preferensi/catatan.',
    'Kelas opsional tapi ekstrak jika disebut: “Faadhil 8.2” berarti name=Faadhil dan class_name=8.2.',
    'Es normal default. Modifier hanya jika disebut. Angka di depan produk adalah TOTAL, bukan jumlah normal ditambah modifier.',
    'Contoh “2 kopsus, yang satu no ice” = ADD 1 normal + ADD 1 no_ice (total tetap 2). “3 kopsus, satu no ice” = 2 normal + 1 no_ice.',
    'Hanya jika user eksplisit bilang “2 kopsus dan tambah 1 kopsus no ice”, totalnya 3.',
    'CONFIRM_ORDER hanya untuk persetujuan ringkasan (gas/jadi/iya), bukan saat memilih cash/QRIS. ASK_RECOMMENDATION hanya jika user meminta saran.',
  ].join('\n');
}

// Kept only so older deployments importing the symbol still load. The V2
// orchestrator applies structured output directly and never calls this bridge.
export function aiOutputToNaturalText() {
  return null;
}

export async function parseWithGroq({ text, currentOrder, menu, role = 'CUSTOMER', pendingQuestion = null, history = [] }) {
  if (!process.env.GROQ_API_KEY) return null;
  const liveMenu = (menu || []).map(product => ({
    id: product.id, code: product.code, name: product.name, price: Number(product.price),
    aliases: product.chatbot_metadata?.aliases || [], tags: product.chatbot_metadata?.tags || [],
    description: product.chatbot_metadata?.description || '', availableQty: product.availableQty ?? null,
  }));
  const requestBody = {
      model: process.env.GROQ_MODEL || DEFAULT_MODEL,
      temperature: 0.05,
      reasoning_effort: 'low',
      // gpt-oss spends part of this budget reasoning before emitting JSON.
      // A larger budget prevents intermittent empty/partial strict documents.
      max_tokens: 500,
      response_format: { type: 'json_schema', json_schema: { name: `baristack_${role.toLowerCase()}_intents`, strict: true, schema: responseSchemaForRole(role) } },
      messages: [
        {
          role: 'system',
          content: systemPromptForRole(role),
        },
        { role: 'user', content: JSON.stringify({
          currentJakarta: new Date().toLocaleString('sv-SE',{timeZone:'Asia/Jakarta'}),
          recentConversation: (history || []).slice(-12).map(item=>({role:item.role,content:String(item.content||'').slice(0,240)})),
          message: String(text || '').slice(0,600),
          pendingQuestion,
          conversationState: compactConversationState(role,currentOrder),
          liveMenu,
        }) },
      ],
    };
  let response;
  let detail='';
  let modelUsed=requestBody.model;
  for (let attempt=1;attempt<=3;attempt+=1) {
    requestBody.model=modelUsed;
    response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(7000),
    });
    if (response.ok) break;
    detail=(await response.text().catch(()=>''))
      .replace(/\s+/g,' ')
      .slice(0,300);
    const invalidJson=response.status===400&&/json_validate_failed|failed to validate json|does not match the expected schema/i.test(detail);
    const rateLimited=response.status===429;
    if ((rateLimited||invalidJson)&&modelUsed==='openai/gpt-oss-120b') {
      modelUsed='openai/gpt-oss-20b';
      continue;
    }
    if (rateLimited&&attempt<3) {
      const retryAfter=Math.min(Number(response.headers.get('retry-after')||0)*1000||750*attempt,2500);
      await new Promise(resolve=>setTimeout(resolve,retryAfter));
      continue;
    }
    if (!invalidJson||attempt===3) throw new Error(`Groq structured parser gagal (${response.status})${detail?`: ${detail}`:''}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  const parsed=validateOutput(JSON.parse(content));
  if (parsed) parsed._model=modelUsed;
  return parsed;
}

export { INTENTS, RESPONSE_SCHEMA, validateOutput };
