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
  assert.ok(customer.required.includes('needs_clarification'));
  assert.ok(customer.required.includes('ambiguities'));
});

test('structured parser preserves ambiguity signals and canonical modifier guidance', async () => {
  const parsed=validateOutput({
    intents:['ADD_ITEM'],
    entities:{name:null,class_name:null,payment_method:null,item_operations:[
      {action:'ADD',product_query:'yang biasa',quantity:1,modifiers:['NO_ICE'],notes:null},
    ],order_number:null},
    needs_clarification:true,
    ambiguities:['Referensi “yang biasa” belum menunjuk satu produk'],
    reply_hint:null,
    confidence:.6,
  });
  assert.equal(parsed.needs_clarification,true);
  assert.deepEqual(parsed.ambiguities,['Referensi “yang biasa” belum menunjuk satu produk']);

  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  let body;
  process.env.GROQ_API_KEY='test-key';
  globalThis.fetch=async (_url,options)=>{
    body=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      intents:['UNKNOWN'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,confirmation:null},
      needs_clarification:false,ambiguities:[],reply_hint:null,confidence:.5,
    })}}]}),{status:200});
  };
  try {
    await parseWithGroq({text:'test',currentOrder:{},menu:[]});
    assert.match(body.messages[0].content,/NO_ICE, LESS_ICE, dan LESS_SWEET/);
    assert.match(body.messages[0].content,/tidak pernah memberi izin membuat order/);
    assert.match(body.messages[0].content,/Quantity null/);
    assert.match(body.messages[0].content,/scope modifier tidak pasti/);
    assert.match(body.messages[0].content,/memaksa confirm/);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY=originalKey;
  }
});

test('Groq request uses strict json schema and live database menu', async () => {
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  let body;
  process.env.GROQ_API_KEY='test-key';
  globalThis.fetch=async (_url,options)=>{
    body=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      intents:['SHOW_MENU'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,confirmation:null},needs_clarification:false,ambiguities:[],reply_hint:null,confidence:.99,
    })}}]}),{status:200});
  };
  try {
    const result=await parseWithGroq({text:'mana menu',currentOrder:{},history:[{role:'assistant',content:'Mau lihat menu?'}],menu:[{id:'p1',code:'LIVE',name:'Menu Live',price:9000,chatbot_metadata:{aliases:['live']}}]});
    assert.deepEqual(result.intents,['SHOW_MENU']);
    assert.equal(result._diagnostics.configuredModel,'openai/gpt-oss-120b');
    assert.equal(result._diagnostics.actualModel,'openai/gpt-oss-120b');
    assert.equal(result._diagnostics.parserPath,'NETWORK_PARSER');
    assert.equal(body.response_format.type,'json_schema');
    assert.equal(body.response_format.json_schema.strict,true);
    assert.equal(body.max_tokens,1200);
    assert.match(body.messages[1].content,/Menu Live/);
    assert.match(body.messages[1].content,/Mau lihat menu/);
    assert.doesNotMatch(body.messages[0].content,/Kopi Susu Gula Aren.*Latte.*Americano/);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY=originalKey;
  }
});

test('production parser fails fast on rate limit without a second model request',async()=>{
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  const originalModel=process.env.GROQ_MODEL;
  let calls=0;
  process.env.GROQ_API_KEY='test-key';
  process.env.GROQ_MODEL='openai/gpt-oss-120b';
  globalThis.fetch=async (_url,options)=>{
    calls+=1;
    assert.equal(JSON.parse(options.body).model,'openai/gpt-oss-120b');
    return new Response('{"error":"limited"}',{status:429});
  };
  try {
    await assert.rejects(()=>parseWithGroq({text:'test',currentOrder:{},menu:[]}),error=>error.category==='RATE_LIMIT');
    assert.equal(calls,1);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY=originalKey;
    if (originalModel===undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL=originalModel;
  }
});

const validUnknownResponse=(model='openai/gpt-oss-120b')=>new Response(JSON.stringify({model,choices:[{message:{content:JSON.stringify({
  intents:['UNKNOWN'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,confirmation:null},
  needs_clarification:false,ambiguities:[],reply_hint:null,confidence:.5,
})}}]}),{status:200});

test('evaluation policy respects Retry-After, retries same model before fallback, and caps backoff',async()=>{
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  const originalModel=process.env.GROQ_MODEL;
  const requested=[];
  const waits=[];
  process.env.GROQ_API_KEY='test-key';
  process.env.GROQ_MODEL='openai/gpt-oss-120b';
  globalThis.fetch=async (_url,options)=>{
    requested.push(JSON.parse(options.body).model);
    if (requested.length<3) return new Response('limited',{status:429,headers:requested.length===1?{'Retry-After':'0.004'}:{}});
    return validUnknownResponse();
  };
  try {
    const result=await parseWithGroq({text:'test',currentOrder:{},menu:[],evaluationPolicy:{
      maxPrimaryAttempts:3,maxFallbackAttempts:1,baseBackoffMs:4,maxBackoffMs:5,jitterRatio:0,random:()=>.5,sleep:async ms=>waits.push(ms),
    }});
    assert.deepEqual(requested,['openai/gpt-oss-120b','openai/gpt-oss-120b','openai/gpt-oss-120b']);
    assert.deepEqual(waits,[4,5]);
    assert.equal(result._diagnostics.parserPath,'NETWORK_PARSER');
    assert.equal(result._diagnostics.attempts.length,3);
    assert.equal(result._diagnostics.attempts[0].errorCategory,'RATE_LIMIT');
    assert.equal(result._diagnostics.totalBackoffMs,9);
    assert.ok(result._diagnostics.attempts.every(attempt=>attempt.requestedModel==='openai/gpt-oss-120b'));
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY=originalKey;
    if (originalModel===undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL=originalModel;
  }
});

test('evaluation fallback occurs for schema compatibility failure with reason telemetry',async()=>{
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  const originalModel=process.env.GROQ_MODEL;
  const requested=[];
  process.env.GROQ_API_KEY='test-key';
  process.env.GROQ_MODEL='openai/gpt-oss-120b';
  globalThis.fetch=async (_url,options)=>{
    const model=JSON.parse(options.body).model;
    requested.push(model);
    if (requested.length===1) return new Response('json_validate_failed: does not match the expected schema',{status:400});
    return validUnknownResponse('openai/gpt-oss-20b');
  };
  try {
    const result=await parseWithGroq({text:'test',currentOrder:{},menu:[],evaluationPolicy:{maxPrimaryAttempts:2,maxFallbackAttempts:2,baseBackoffMs:0,maxBackoffMs:0,jitterRatio:0,sleep:async()=>{}}});
    assert.deepEqual(requested,['openai/gpt-oss-120b','openai/gpt-oss-20b']);
    assert.equal(result._diagnostics.parserPath,'FALLBACK');
    assert.equal(result._diagnostics.attempts[0].fallbackReason,'SCHEMA_VALIDATION');
    assert.equal(result._diagnostics.attempts[1].fallback,true);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY=originalKey;
    if (originalModel===undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL=originalModel;
  }
});

test('explicit entity guard never treats self-reference or schedule as customer name', async () => {
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY='test-key';
  globalThis.fetch=async ()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
    intents:['UPDATE_ITEM'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,confirmation:null},needs_clarification:false,ambiguities:[],reply_hint:null,confidence:.9,
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
