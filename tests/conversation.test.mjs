import test from 'node:test';
import assert from 'node:assert/strict';
import { applyParserAmbiguities, applyStructuredPatch, deterministicCustomerTurn, draftItemsForRpc, emptyDraft, groundedRecommendation, missingFields, nextReply, resolveProductQuery, simpleNameAnswer, sanitizeCustomerParsedResult } from '../services/chatbot/conversation.js';

const menu=[
  {id:'p-kopsus',code:'KSGA',name:'Kopi Susu Gula Aren',price:8000,chatbot_metadata:{aliases:['kopsus','kopi susu','gula aren'],tags:['creamy','manis','kopi','susu'],description:'Creamy, manis gula aren, dan rasa kopi tidak terlalu pahit.'}},
  {id:'p-latte',code:'LATTE',name:'Latte',price:8000,chatbot_metadata:{aliases:['latte'],tags:['creamy','kopi','susu','tidak manis'],description:'Creamy, tidak terlalu pahit, dan tanpa pemanis pada resep standar.'}},
  {id:'p-matcha',code:'MATCHA',name:'Matcha Latte',price:12000,chatbot_metadata:{aliases:['matcha','yang ijo'],tags:['creamy','manis','non kopi','susu'],description:'Matcha creamy dengan susu dan bukan minuman kopi.'}},
];

test('punctuated order opening asks for menu without inventing an item', () => {
  for (const text of ['mau. pesen', 'mau pesen dong mass']) {
    const parsed=deterministicCustomerTurn(text,emptyDraft('po-1'),menu);
    assert.deepEqual(parsed?.intents,['START_ORDER']);
    assert.deepEqual(parsed.entities.item_operations,[]);
    const patch=applyStructuredPatch(emptyDraft('po-1'),parsed,menu);
    assert.match(nextReply(patch.draft,menu,patch),/mau pesan apa/i);
    assert.equal(patch.draft.awaiting_confirmation,false);
  }
  assert.equal(deterministicCustomerTurn('mau pesen coklat',emptyDraft(),menu),null);
});

test('opening-time question is a PO status query rather than an order', () => {
  assert.deepEqual(deterministicCustomerTurn('kapan kira kira bukanya',emptyDraft(),menu)?.intents,['CHECK_PO_STATUS']);
  assert.equal(deterministicCustomerTurn('kapan kirim ke rumah',emptyDraft(),menu),null);
});

test('qriss selects QRIS and survives the payment guard without confirming an order', () => {
  const draft={...emptyDraft('po-1'),customer_name:'Customer',pending_question:'payment',items:[{productId:'p-latte',quantity:2,modifiers:[]}]};
  const parsed=deterministicCustomerTurn('qriss',draft,menu);
  assert.equal(parsed?.entities.payment_method,'QRIS');
  const sanitized=sanitizeCustomerParsedResult('qriss',draft,parsed);
  assert.equal(sanitized.entities.payment_method,'QRIS');
  assert.deepEqual(sanitized.intents,['SET_PAYMENT_METHOD']);
  assert.equal(sanitized.entities.confirmation,null);
  assert.equal(deterministicCustomerTurn('qriss sudah lunas',draft,menu),null);
});

function message({intents=['ADD_ITEM'],name=null,className=null,payment=null,operations=[]}={}) {
  return {intents,entities:{name,class_name:className,payment_method:payment,item_operations:operations},confidence:.95};
}

test('multi-intent message resolves aliases to existing product ids', () => {
  const result=applyStructuredPatch(emptyDraft('po-1'),message({
    intents:['ADD_ITEM','PROVIDE_NAME','PROVIDE_CLASS','SET_PAYMENT_METHOD'],name:'Faadhil',className:'8.2',payment:'QRIS',
    operations:[{action:'ADD',product_query:'kopsus',quantity:3,modifiers:[],notes:null}],
  }),menu);
  assert.equal(result.draft.items[0].productId,'p-kopsus');
  assert.equal(result.draft.items[0].price,undefined);
  assert.equal(result.draft.customer_name,'Faadhil');
  assert.deepEqual(missingFields(result.draft),[]);
  assert.equal(result.draft.awaiting_confirmation,true);
});

test('draft supports add update modifier and remove without independent product data', () => {
  let draft=applyStructuredPatch(emptyDraft('po-1'),message({operations:[{action:'ADD',product_query:'matcha',quantity:1,modifiers:[],notes:null}]}),menu).draft;
  draft=applyStructuredPatch(draft,message({intents:['UPDATE_ITEM'],operations:[{action:'UPDATE',product_query:'matcha',quantity:1,modifiers:['no ice'],notes:null}]}),menu).draft;
  assert.equal(draft.items[0].quantity,1);
  assert.equal(draft.items[0].noIce,true);
  assert.deepEqual(draftItemsForRpc(draft),[{productId:'p-matcha',quantity:1,noIce:true,notes:null}]);
  draft=applyStructuredPatch(draft,message({intents:['REMOVE_ITEM'],operations:[{action:'REMOVE',product_query:'matcha',quantity:null,modifiers:[],notes:null}]}),menu).draft;
  assert.equal(draft.items.length,0);
});

test('partial modifier and removal preserve the remaining cups as separate lines', () => {
  let draft=applyStructuredPatch(emptyDraft('po-1'),message({operations:[{action:'ADD',product_query:'kopsus',quantity:3,modifiers:[],notes:null}]}),menu).draft;
  draft=applyStructuredPatch(draft,message({intents:['UPDATE_ITEM'],operations:[{action:'UPDATE',product_query:'kopsus',quantity:1,modifiers:['no ice'],notes:null}]}),menu).draft;
  assert.deepEqual(draft.items.map(item=>({quantity:item.quantity,noIce:item.noIce})),[
    {quantity:2,noIce:false},{quantity:1,noIce:true},
  ]);
  draft=applyStructuredPatch(draft,message({intents:['REMOVE_ITEM'],operations:[{action:'REMOVE',product_query:'kopsus',quantity:1,modifiers:['no ice'],notes:null}]}),menu).draft;
  assert.equal(draft.items.reduce((total,item)=>total+item.quantity,0),2);
});

test('complete modifier set defines variant identity and preserves split quantities',()=>{
  const parsed=message({operations:[
    {action:'ADD',product_query:'matcha',quantity:1,modifiers:[],notes:null},
    {action:'ADD',product_query:'matcha',quantity:2,modifiers:['less sweet'],notes:null},
  ]});
  let draft=applyStructuredPatch(emptyDraft('po-1'),parsed,menu).draft;
  assert.deepEqual(draft.items.map(item=>({quantity:item.quantity,modifiers:item.modifiers})),[
    {quantity:1,modifiers:[]},{quantity:2,modifiers:['LESS_SWEET']},
  ]);

  draft=applyStructuredPatch(draft,message({operations:[
    {action:'ADD',product_query:'matcha',quantity:1,modifiers:['NO_ICE','LESS_SWEET'],notes:null},
    {action:'ADD',product_query:'matcha',quantity:2,modifiers:['less sweet','no ice'],notes:null},
  ]}),menu).draft;
  const combined=draft.items.find(item=>item.modifiers.includes('NO_ICE')&&item.modifiers.includes('LESS_SWEET'));
  assert.equal(combined.quantity,3);
});

test('normal no-ice less-ice and less-sweet remain separate variants',()=>{
  const draft=applyStructuredPatch(emptyDraft('po-1'),message({operations:[
    {action:'ADD',product_query:'matcha',quantity:1,modifiers:[],notes:null},
    {action:'ADD',product_query:'matcha',quantity:1,modifiers:['no ice'],notes:null},
    {action:'ADD',product_query:'matcha',quantity:1,modifiers:['less ice'],notes:null},
    {action:'ADD',product_query:'matcha',quantity:1,modifiers:['less sweet'],notes:null},
  ]}),menu).draft;
  assert.equal(draft.items.length,4);
  assert.deepEqual(draft.items.map(item=>item.modifiers),[[],['NO_ICE'],['LESS_ICE'],['LESS_SWEET']]);
});

test('natural split example retains normal and less-sweet matcha plus aren',()=>{
  const parsed=message({name:'Arthur',operations:[
    {action:'ADD',product_query:'yang ijo',quantity:1,modifiers:[],notes:null},
    {action:'ADD',product_query:'yang ijo',quantity:1,modifiers:['less sweet'],notes:null},
    {action:'ADD',product_query:'aren',quantity:1,modifiers:[],notes:null},
  ]});
  const draft=applyStructuredPatch(emptyDraft('po-1'),parsed,menu).draft;
  assert.equal(draft.customer_name,'Arthur');
  assert.deepEqual(draft.items.map(item=>({productId:item.productId,quantity:item.quantity,modifiers:item.modifiers})),[
    {productId:'p-matcha',quantity:1,modifiers:[]},
    {productId:'p-matcha',quantity:1,modifiers:['LESS_SWEET']},
    {productId:'p-kopsus',quantity:1,modifiers:[]},
  ]);
});

test('compact-exact alias resolution accepts whitespace only without fuzzy guessing',()=>{
  assert.equal(resolveProductQuery('kop sus',menu).product?.id,'p-kopsus');
  assert.equal(resolveProductQuery('lat',menu).product,null);
});

test('empty order gets a natural menu prompt without empty-item wording', () => {
  const reply=nextReply(emptyDraft('po-1'),menu);
  assert.match(reply,/mau pesan apa/i);
  assert.doesNotMatch(reply,/belum ada item/i);
});

test('unknown drink is treated as an unavailable menu request and offers live choices', () => {
  const draft=emptyDraft('po-1');
  const parsed=message({operations:[{action:'ADD',product_query:'coklat susu',quantity:1,modifiers:[],notes:null}]});
  const patched=applyStructuredPatch(draft,parsed,menu);
  const reply=nextReply(patched.draft,menu,patched);
  assert.match(reply,/coklat susu.*belum tersedia/is);
  assert.match(reply,/Kopi Susu Gula Aren/);
  assert.doesNotMatch(reply,/di luar|khusus bantu/i);
});

test('mixed valid and unavailable items explain exactly what was retained', () => {
  const parsed=message({operations:[
    {action:'ADD',product_query:'americano',quantity:3,modifiers:[],notes:null},
    {action:'ADD',product_query:'indonesiano',quantity:2,modifiers:[],notes:null},
  ]});
  const patched=applyStructuredPatch(emptyDraft('po-1'),parsed,[...menu,{id:'p-americano',code:'AMER',name:'Americano',price:8000,chatbot_metadata:{aliases:['americano']}}]);
  const reply=nextReply(patched.draft,[...menu,{id:'p-americano',code:'AMER',name:'Americano',price:8000,chatbot_metadata:{aliases:['americano']}}],patched);
  assert.match(reply,/3x Americano/);
  assert.match(reply,/indonesiano.*belum tersedia/is);
});

test('short name answer separates an optional class and rejects self reference', () => {
  const waiting={...emptyDraft('po-1'),pending_question:'name'};
  const parsed=simpleNameAnswer('Faadhil 8.2',waiting,menu);
  assert.equal(parsed.entities.name,'Faadhil');
  assert.equal(parsed.entities.class_name,'8.2');
  assert.equal(simpleNameAnswer('buat sendiri',waiting,menu),null);
});

test('deterministic fast path handles only explicit transaction controls', () => {
  const ready={...emptyDraft('po-1'),customer_name:'Faadhil',payment_method:'CASH',items:[{productId:'p-kopsus',quantity:1}],awaiting_confirmation:true};
  assert.deepEqual(deterministicCustomerTurn('gas',ready,menu).intents,['CONFIRM_ORDER']);
  const waitingPayment={...ready,payment_method:null,pending_question:'payment',awaiting_confirmation:false};
  assert.equal(deterministicCustomerTurn('qris',waitingPayment,menu).entities.payment_method,'QRIS');
  assert.equal(deterministicCustomerTurn('keris aja',waitingPayment,menu).entities.payment_method,'QRIS');
  assert.equal(deterministicCustomerTurn('cas',waitingPayment,menu).entities.payment_method,'CASH');
  assert.equal(deterministicCustomerTurn('eh namanya Budi aja',ready,menu),null);
  assert.equal(deterministicCustomerTurn('kapan kopi dikirim',waitingPayment,menu),null);
  assert.equal(deterministicCustomerTurn('gue mau yang creamy',ready,menu),null);
});

test('recommendation is grounded in live metadata and never calls matcha a coffee drink', () => {
  const reply=groundedRecommendation('yang manis tapi masih ada kopinya apa?',menu);
  assert.match(reply,/Kopi Susu Gula Aren/);
  assert.doesNotMatch(reply,/Matcha Latte/);
  const notSweet=groundedRecommendation('kopi yang nggak manis dan nggak pahit',menu);
  assert.match(notSweet,/Latte/);
});

test('parser clarification asks to rephrase without repeating technical or invented business claims',()=>{
  const draft={...emptyDraft('po-1'),items:[{productId:'p-latte',quantity:2,modifiers:[]}],customer_name:'Rina',payment_method:'CASH'};
  const before=structuredClone(draft);
  const patch=applyParserAmbiguities({draft,unresolved:[],ambiguous:[],invalidModifiers:[]},{
    needs_clarification:true,ambiguities:['SCHEMA_VALIDATION: stok 999, harga Rp1, pembayaran lunas'],
  });
  const reply=nextReply(patch.draft,menu,patch);
  assert.match(reply,/belum (yakin|paham|jelas)/i);
  assert.match(reply,/tulis ulang|jelasin lagi/i);
  assert.match(reply,/2x Latte/);
  assert.doesNotMatch(reply,/Yang kamu maksud|SCHEMA_VALIDATION|999|Rp1\b|lunas|sudah masuk|gas.*iya/i);
  assert.deepEqual(draft,before);
});

test('product ambiguity offers only verified menu names instead of mixing in parser reasons',()=>{
  const reply=nextReply(emptyDraft('po-1'),menu,{ambiguous:['Latte','Matcha Latte','Latte','Produk ambigu, coba tebak Cappuccino']});
  assert.match(reply,/Latte atau Matcha Latte/);
  assert.equal((reply.match(/Matcha Latte/g)||[]).length,1);
  assert.doesNotMatch(reply,/Produk ambigu|Cappuccino|coba tebak/);
});

test('unknown product plus parser ambiguity keeps valid items and uses database menu prices',()=>{
  const liveMenu=menu.map(product=>({...product,price:product.id==='p-latte'?9500:product.price}));
  const parsed={...message({operations:[
    {action:'ADD',product_query:'latte',quantity:2,modifiers:[],notes:null},
    {action:'ADD',product_query:'cappuccino',quantity:1,modifiers:[],notes:null},
  ]}),needs_clarification:true,ambiguities:['Produk “cappuccino” tidak dikenali di menu']};
  const patch=applyParserAmbiguities(applyStructuredPatch(emptyDraft('po-1'),parsed,liveMenu),parsed);
  const before=structuredClone(patch.draft);
  const reply=nextReply(patch.draft,liveMenu,patch);
  assert.match(reply,/2x Latte/);
  assert.match(reply,/cappuccino.*belum tersedia/is);
  assert.match(reply,/Rp19\.000/);
  assert.doesNotMatch(reply,/Rp16\.000|Yang kamu maksud|tidak dikenali/);
  assert.deepEqual(patch.draft,before);
});

test('ambiguous ice assignment asks which drink and how many cups without technical wording',()=>{
  const draft={...emptyDraft('po-1'),items:[{productId:'p-latte',quantity:2,modifiers:[]}]};
  const reply=nextReply(draft,menu,{ambiguous:['Scope modifier NO_ICE pada beberapa item belum jelas']});
  assert.match(reply,/tanpa es/i);
  assert.match(reply,/minuman|menu/i);
  assert.match(reply,/berapa cup/i);
  assert.match(reply,/2x Latte/);
  assert.doesNotMatch(reply,/scope|modifier|NO_ICE|Yang kamu maksud/i);
});

test('unsupported modifier gives understandable supported choices even with parser ambiguity',()=>{
  const reply=nextReply(emptyDraft('po-1'),menu,{invalidModifiers:['extra foam'],ambiguous:['Modifier tidak didukung']});
  assert.match(reply,/tanpa es/);
  assert.match(reply,/es sedikit/);
  assert.match(reply,/kurang manis/);
  assert.doesNotMatch(reply,/modifier produksi|Modifier tidak didukung|Yang kamu maksud|no ice|less sweet/i);
});

test('missing quantity asks specifically for the drink whose count is unknown',()=>{
  const draft={...emptyDraft('po-1'),items:[
    {productId:'p-latte',quantity:2,modifiers:[]},
    {productId:'p-matcha',quantity:null,modifiers:[]},
  ]};
  const before=structuredClone(draft);
  const reply=nextReply(draft,menu);
  assert.match(reply,/Mau berapa cup Matcha Latte\?/);
  assert.doesNotMatch(reply,/Total:|Atas nama|Bayarnya cash/);
  assert.deepEqual(draft,before);
});

test('missing counts for multiple drinks asks for each menu count without guessing one cup',()=>{
  const draft={...emptyDraft('po-1'),items:[
    {productId:'p-latte',quantity:null,modifiers:[]},
    {productId:'p-matcha',quantity:null,modifiers:[]},
  ]};
  const reply=nextReply(draft,menu);
  assert.match(reply,/Masing-masing.*berapa cup.*Latte.*Matcha Latte/is);
  assert.doesNotMatch(reply,/1x |Total:/);
});

test('quantity ambiguity from the parser still asks the missing count for a verified menu',()=>{
  const parsed={...message({operations:[
    {action:'ADD',product_query:'matcha',quantity:null,modifiers:[],notes:null},
  ]}),needs_clarification:true,ambiguities:['Jumlah belum disebut']};
  const patch=applyParserAmbiguities(applyStructuredPatch(emptyDraft('po-1'),parsed,menu),parsed);
  const reply=nextReply(patch.draft,menu,patch);
  assert.match(reply,/Mau berapa cup Matcha Latte\?/);
  assert.doesNotMatch(reply,/Yang kamu maksud|Jumlah belum disebut|Total:/);
});

test('variant ambiguity without a known modifier has a readable clarification',()=>{
  const reply=nextReply(emptyDraft('po-1'),menu,{ambiguous:['Varian Latte yang ingin diubah']});
  assert.match(reply,/Catatan itu untuk minuman yang mana, dan berapa cup\?/);
  assert.doesNotMatch(reply,/itu itu|Varian Latte yang ingin diubah/);
});
