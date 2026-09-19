import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructuredPatch, deterministicCustomerTurn, draftItemsForRpc, emptyDraft, groundedRecommendation, missingFields, nextReply, simpleNameAnswer } from '../services/chatbot/conversation.js';

const menu=[
  {id:'p-kopsus',code:'KSGA',name:'Kopi Susu Gula Aren',price:8000,chatbot_metadata:{aliases:['kopsus','kopi susu','gula aren'],tags:['creamy','manis','kopi','susu'],description:'Creamy, manis gula aren, dan rasa kopi tidak terlalu pahit.'}},
  {id:'p-latte',code:'LATTE',name:'Latte',price:8000,chatbot_metadata:{aliases:['latte'],tags:['creamy','kopi','susu','tidak manis'],description:'Creamy, tidak terlalu pahit, dan tanpa pemanis pada resep standar.'}},
  {id:'p-matcha',code:'MATCHA',name:'Matcha Latte',price:12000,chatbot_metadata:{aliases:['matcha'],tags:['creamy','manis','non kopi','susu'],description:'Matcha creamy dengan susu dan bukan minuman kopi.'}},
];

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
  draft=applyStructuredPatch(draft,message({intents:['REMOVE_ITEM'],operations:[{action:'REMOVE',product_query:'kopsus',quantity:1,modifiers:[],notes:null}]}),menu).draft;
  assert.equal(draft.items.reduce((total,item)=>total+item.quantity,0),2);
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
