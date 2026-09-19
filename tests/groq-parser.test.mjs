import test from 'node:test';
import assert from 'node:assert/strict';
import { aiOutputToNaturalText, parseWithGroq, responseSchemaForRole, validateOutput } from '../services/parser/groqOrderParser.js';

test('validates multi-intent structured output without converting it to text', () => {
  const parsed=validateOutput({
    intents:['ADD_ITEM','PROVIDE_NAME','PROVIDE_CLASS','SET_PAYMENT_METHOD'],
    entities:{name:'Faadhil',class_name:'8.2',payment_method:'QRIS',item_operations:[
      {action:'ADD',product_query:'kopsus',quantity:3,modifiers:[],notes:null},
    ],order_number:null,po_date:null,open_time:null,close_date:null,close_time:null,duration_minutes:null,schedule_mode:null,max_cups:null,ingredient_name:null,ingredient_quantity:null,ingredient_unit:null,inventory_change:null,confirmation:null},
    reply_hint:null,confidence:.96,
  });
  assert.deepEqual(parsed.intents,['ADD_ITEM','PROVIDE_NAME','PROVIDE_CLASS','SET_PAYMENT_METHOD']);
  assert.equal(parsed.entities.item_operations[0].product_query,'kopsus');
  assert.equal(parsed.entities.payment_method,'QRIS');
  assert.equal(aiOutputToNaturalText(parsed),null);
});

test('normalizes conversational AI clocks and accepts null owner cart operations', () => {
  const parsed=validateOutput({
    intents:['OWNER_OPEN_PO'],
    entities:{name:null,class_name:null,payment_method:null,item_operations:null,order_number:null,
      po_date:'2026-09-13',open_time:'22:40:57',close_date:null,close_time:'23.00',duration_minutes:null,schedule_mode:'ABSOLUTE',max_cups:null,
      ingredient_name:null,ingredient_quantity:null,ingredient_unit:null,inventory_change:null,confirmation:null},
    reply_hint:null,confidence:.99,
  });
  assert.equal(parsed.entities.open_time,'22:40');
  assert.equal(parsed.entities.close_time,'23:00');
  assert.deepEqual(parsed.entities.item_operations,[]);
});

test('uses smaller role-specific schemas without exposing owner tools to customers', () => {
  const customer=responseSchemaForRole('CUSTOMER');
  const owner=responseSchemaForRole('OWNER');
  assert.equal(customer.properties.entities.properties.open_time,undefined);
  assert.ok(customer.properties.entities.properties.item_operations);
  assert.equal(owner.properties.entities.properties.item_operations,undefined);
  assert.ok(owner.properties.entities.properties.open_time);
  assert.equal(customer.properties.intents.items.enum.includes('OWNER_CLOSE_PO'),false);
  assert.equal(customer.properties.intents.items.enum.includes('CONVERSATION_ACK'),true);
  assert.equal(customer.properties.intents.items.enum.includes('REQUEST_QRIS_CODE'),true);
  assert.equal(customer.properties.intents.items.enum.includes('RESET_ORDER_DRAFT'),true);
});

test('Groq request uses strict json schema and live database menu', async () => {
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  let body;
  process.env.GROQ_API_KEY='test-key';
  globalThis.fetch=async (_url,options)=>{
    body=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      intents:['SHOW_MENU'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,po_date:null,open_time:null,close_date:null,close_time:null,duration_minutes:null,schedule_mode:null,max_cups:null,ingredient_name:null,ingredient_quantity:null,ingredient_unit:null,inventory_change:null,confirmation:null},reply_hint:null,confidence:.99,
    })}}]}),{status:200});
  };
  try {
    const result=await parseWithGroq({text:'mana menu',currentOrder:{},history:[{role:'assistant',content:'Mau lihat menu?'}],menu:[{id:'p1',code:'LIVE',name:'Menu Live',price:9000,chatbot_metadata:{aliases:['live']}}]});
    assert.deepEqual(result.intents,['SHOW_MENU']);
    assert.equal(body.response_format.type,'json_schema');
    assert.equal(body.response_format.json_schema.strict,true);
    assert.match(body.messages[1].content,/Menu Live/);
    assert.match(body.messages[1].content,/Mau lihat menu/);
    assert.doesNotMatch(body.messages[0].content,/Kopi Susu Gula Aren.*Latte.*Americano/);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY=originalKey;
  }
});

test('explicit entity guard never treats self-reference or schedule as customer name', async () => {
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY='test-key';
  globalThis.fetch=async ()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
    intents:['UPDATE_ITEM'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,po_date:null,open_time:null,close_date:null,close_time:null,duration_minutes:null,schedule_mode:null,max_cups:null,ingredient_name:null,ingredient_quantity:null,ingredient_unit:null,inventory_change:null,confirmation:null},reply_hint:null,confidence:.9,
  })}}]}),{status:200});
  try {
    const self=await parseWithGroq({text:'1 aja buat sendiri',currentOrder:{},menu:[]});
    const later=await parseWithGroq({text:'buat nanti',currentOrder:{},menu:[]});
    assert.equal(self.entities.name,null);
    assert.equal(later.entities.name,null);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY=originalKey;
  }
});
