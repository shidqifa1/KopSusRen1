import Groq from 'groq-sdk';

export const OWNER_AI_FALLBACK='Sistem AI lagi sibuk. Pakai /help untuk melihat command manual.';
export const OWNER_OUT_OF_SCOPE_REPLY='Gue khusus bantu operasional Baristack: stok, PO, pesanan, pembayaran, produksi, dan strategi usaha minuman.';
export const OWNER_ROUTES=Object.freeze(['READ_QUERY','WRITE_INTENT','CONSULTATION','OUT_OF_SCOPE']);

export const OWNER_READ_COMMANDS=Object.freeze([
  '/help',
  '/menu list',
  '/stok list',
  '/stok lihat <item>',
  '/po list',
  '/po status <aktif|hari-ini|besok|po-id>',
  '/order list <aktif|hari-ini|besok|po-id>',
  '/order unpaid <aktif|hari-ini|besok|po-id>',
  '/produksi <aktif|hari-ini|besok|po-id>',
]);

export const OWNER_WRITE_COMMANDS=Object.freeze([
  '/stok tambah <item> <qty> <unit>',
  '/stok kurang <item> <qty> <unit>',
  '/po buka <tanggal> <jam-buka> <jam-tutup> <max-cup>',
  '/po tutup <aktif|hari-ini|besok|po-id>',
  '/bayar konfirmasi <order-number>',
  '/bayar tolak <order-number>',
  '/order batal <order-number>',
]);

const routeSchema={
  type:'object',additionalProperties:false,required:['route'],
  properties:{route:{type:'string',enum:OWNER_ROUTES}},
};
const commandSchema={
  type:'object',additionalProperties:false,required:['command'],
  properties:{command:{type:'string',minLength:2,maxLength:180}},
};

function contentOf(completion) {
  const value=completion?.choices?.[0]?.message?.content;
  if (typeof value!=='string'||!value.trim()) throw new Error('Owner LLM returned empty content');
  return value;
}

function parseObject(completion) {
  const parsed=JSON.parse(contentOf(completion));
  if (!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error('Owner LLM returned invalid JSON object');
  return parsed;
}

function narrowValue(completion,key) {
  const content=contentOf(completion).trim();
  if (content.startsWith('{')) {
    const value=parseObject(completion)[key];
    if (typeof value!=='string') throw new Error(`Owner LLM returned invalid ${key}`);
    return value.trim();
  }
  return content;
}

export function createOwnerLlm({client=null,model=null,timeoutMs=4500}={}) {
  const configuredModel=model||process.env.OWNER_GROQ_MODEL||process.env.GROQ_MODEL||'openai/gpt-oss-120b';
  const groq=client||new Groq({apiKey:process.env.GROQ_API_KEY,maxRetries:0,timeout:timeoutMs});

  async function oneCall(body) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      return await groq.chat.completions.create(body,{signal:controller.signal});
    } finally {
      clearTimeout(timer);
    }
  }

  async function ownerRouter(message) {
    const completion=await oneCall({
      model:configuredModel,temperature:0,reasoning_effort:'low',max_tokens:180,
      messages:[
        {role:'system',content:[
          'Klasifikasikan pesan owner Baristack ke tepat satu route.',
          'READ_QUERY: meminta data aktual seperti stok, PO, order, pembayaran, atau produksi.',
          'Pertanyaan daftar menu, produk, atau harga selalu READ_QUERY.',
          'WRITE_INTENT: meminta perubahan data seperti buka/tutup PO, ubah stok, konfirmasi/tolak pembayaran, atau batalkan order.',
          'Daftar beberapa nama customer beserta kelas, produk, dan jumlah adalah WRITE_INTENT batch order.',
          'CONSULTATION: meminta saran atau analisis tentang Baristack, penjualan minuman, menu, pemasaran, harga, atau operasional usaha.',
          'OUT_OF_SCOPE: matematika umum, gadget/laptop, biodata orang, politik, hiburan, pelajaran, atau topik lain yang tidak terkait usaha Baristack.',
          'Jangan mengekstrak command atau menjawab pertanyaan.',
          'Output hanya salah satu token berikut tanpa JSON, markdown, atau penjelasan: READ_QUERY, WRITE_INTENT, CONSULTATION, OUT_OF_SCOPE.',
        ].join('\n')},
        {role:'user',content:String(message||'').slice(0,600)},
      ],
    });
    const route=narrowValue(completion,'route');
    if (!OWNER_ROUTES.includes(route)) throw new Error('Owner route is not allowed');
    return route;
  }

  async function ownerCommandGenerator(intent,message) {
    if (!['READ_QUERY','WRITE_INTENT'].includes(intent)) throw new Error('Command generator intent is invalid');
    const commands=intent==='READ_QUERY'?OWNER_READ_COMMANDS:OWNER_WRITE_COMMANDS;
    const completion=await oneCall({
      model:configuredModel,temperature:0,reasoning_effort:'low',max_tokens:320,
      messages:[
        {role:'system',content:[
          `Terjemahkan permintaan owner menjadi tepat satu slash command ${intent==='READ_QUERY'?'read-only':'mutation'}.`,
          'Command yang tersedia:',...commands,
          'Output hanya slash command. Jangan menambah JSON, penjelasan, markdown, newline, placeholder, atau command kedua.',
          'Gunakan selector aktif, hari-ini, atau besok bila owner menyebutkannya. Jangan mengarang UUID atau nomor order.',
        ].join('\n')},
        {role:'user',content:String(message||'').slice(0,600)},
      ],
    });
    const command=narrowValue(completion,'command');
    if (typeof command!=='string') throw new Error('Generated owner command is invalid');
    return command.trim();
  }

  async function ownerSummarizer(jsonData,originalQuery) {
    const completion=await oneCall({
      model:configuredModel,temperature:.1,reasoning_effort:'low',max_tokens:520,
      messages:[
        {role:'system',content:'Ringkas data operasional Baristack secara singkat dan natural dalam Bahasa Indonesia. Gunakan hanya angka/fakta dari DATA. Jangan mengarang, jangan mengklaim mutation, dan jangan menampilkan JSON mentah.'},
        {role:'user',content:JSON.stringify({query:String(originalQuery||'').slice(0,400),data:jsonData}).slice(0,12000)},
      ],
    });
    return contentOf(completion).trim();
  }

  async function ownerConsultant(message) {
    const completion=await oneCall({
      model:configuredModel,temperature:.4,reasoning_effort:'low',max_tokens:700,
      messages:[
        {role:'system',content:'Kamu konsultan operasional usaha minuman Baristack. Jawab hanya tentang strategi usaha Baristack, penjualan minuman, pengembangan menu, harga, pemasaran, dan operasional. Jangan pernah mengarang slash command. Pertanyaan data aktual seperti daftar menu/harga, stok, PO, order, atau produksi seharusnya tidak masuk ke sini; jika terjadi, arahkan ke /menu list, /stok list, /po status aktif, /order list aktif, atau /produksi aktif. Tolak topik umum seperti matematika, gadget, biodata orang, politik, hiburan, atau pelajaran. Kamu tidak memiliki akses database atau kondisi bisnis terkini. Jangan mengarang stok, omzet, order, atau status PO.'},
        {role:'user',content:String(message||'').slice(0,600)},
      ],
    });
    return contentOf(completion).trim();
  }

  return {ownerRouter,ownerCommandGenerator,ownerSummarizer,ownerConsultant};
}

let defaultOwnerLlm=null;
function defaults() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured');
  defaultOwnerLlm||=createOwnerLlm();
  return defaultOwnerLlm;
}

export const OwnerRouter=message=>defaults().ownerRouter(message);
export const OwnerCommandGenerator=(intent,message)=>defaults().ownerCommandGenerator(intent,message);
export const OwnerSummarizer=(jsonData,query)=>defaults().ownerSummarizer(jsonData,query);
export const OwnerConsultant=message=>defaults().ownerConsultant(message);
