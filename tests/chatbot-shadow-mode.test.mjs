import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildShadowObservation } from '../services/chatbot/shadow.js';
import { emptyDraft } from '../services/chatbot/conversation.js';
import { runInboundPipeline } from '../services/chatbot/transactionFlow.js';

const menu=[
  {id:'product-kopsus',code:'KSGA',name:'Kopi Susu Gula Aren',price:8000,chatbot_metadata:{aliases:['kopsus']}},
];

function preparedFor(parsed) {
  return {parsed,parsedByAi:Boolean(parsed),parserLatencyMs:42,products:menu,previousDraft:emptyDraft('po-1'),stateVersion:'v1'};
}

function parsedOrder(intents=['ADD_ITEM']) {
  return {
    intents,
    entities:{name:'Faadhil',class_name:'8.2',payment_method:'CASH',item_operations:[{
      action:'ADD',product_query:'kopsus',quantity:2,modifiers:['NO_ICE','LESS_SWEET'],notes:'private note',
    }]},
    confidence:.98,needs_clarification:false,ambiguities:[],_model:'openai/gpt-oss-20b',
  };
}

test('shadow evaluation parses and records queryable sanitized metadata',()=>{
  const observation=buildShadowObservation({text:'2 kopsus buat Faadhil 8.2 cash 081234567890',prepared:preparedFor(parsedOrder())});
  assert.deepEqual(observation.parserIntents,['ADD_ITEM']);
  assert.deepEqual(observation.resolvedItems,[{productCode:'KSGA',quantity:2,modifiers:['NO_ICE','LESS_SWEET']}]);
  assert.equal(observation.parserProvider,'GROQ');
  assert.equal(observation.parserModel,'openai/gpt-oss-20b');
  assert.equal(observation.parserLatencyMs,42);
  assert.equal(observation.parserFailed,false);
  assert.doesNotMatch(observation.normalizedInput,/faadhil|081234567890|8\.2/i);
  assert.equal(observation.parserResult.entities.name,undefined);
  assert.equal(observation.parserResult.entities.class_name,undefined);
  assert.equal(observation.parserResult.entities.item_operations[0].notes,undefined);
});

test('provider failure is recorded as unsafe without inventing parser data',()=>{
  const observation=buildShadowObservation({text:'pesan yang tidak terurai',prepared:preparedFor(null)});
  assert.equal(observation.parserFailed,true);
  assert.equal(observation.parserProvider,'NONE');
  assert.equal(observation.wouldBeSafe,false);
  assert.equal(observation.parserResult,null);
  assert.ok(observation.clarificationReason);
});

function shadowHarness() {
  let now=1000;
  let lease=0;
  const messages=new Map();
  const observations=new Map();
  const mutations={orders:0,reservations:0,payments:0,drafts:0,replies:0};
  const register=async payload=>{
    const row=messages.get(payload.waMessageId);
    if (row&&row.state!=='PENDING') return {duplicate:true};
    if (row&&row.expires>now) return {duplicate:true};
    if (row) {
      row.lease=`lease-${++lease}`; row.expires=now+100;
      return {messageId:payload.waMessageId,messageCreatedAt:new Date(row.createdAt).toISOString(),leaseId:row.lease,recovered:true};
    }
    const created={state:'PENDING',lease:`lease-${++lease}`,expires:now+100,createdAt:now};
    messages.set(payload.waMessageId,created);
    return {messageId:payload.waMessageId,messageCreatedAt:new Date(now).toISOString(),leaseId:created.lease,recovered:false};
  };
  const prepare=async()=>preparedFor(parsedOrder(['CONFIRM_ORDER']));
  const apply=async (payload,registration,prepared)=>{
    const row=messages.get(registration.messageId);
    if (!row||row.state!=='PENDING'||row.lease!==registration.leaseId) return {status:'STALE',result:{duplicate:true,shadow:true}};
    if (!observations.has(payload.waMessageId)) observations.set(payload.waMessageId,buildShadowObservation({text:payload.text,prepared}));
    row.state='APPLIED';
    return {status:'APPLIED',result:{shadow:true}};
  };
  return {register,prepare,apply,messages,observations,mutations,advance:value=>{now+=value;}};
}

test('confirmation word is observed but cannot mutate business state or send a reply',async()=>{
  const harness=shadowHarness();
  const result=await runInboundPipeline({payload:{phone:'a',waMessageId:'gas-1',text:'gas'},...harness});
  assert.equal(result.shadow,true);
  assert.equal(result.replyText,undefined);
  assert.equal(harness.observations.size,1);
  assert.deepEqual(harness.mutations,{orders:0,reservations:0,payments:0,drafts:0,replies:0});
});

test('duplicate webhook creates only one shadow observation',async()=>{
  const harness=shadowHarness();
  const payload={phone:'a',waMessageId:'duplicate-shadow',text:'2 kopsus'};
  const first=await runInboundPipeline({payload,...harness});
  const duplicate=await runInboundPipeline({payload,...harness});
  assert.equal(first.shadow,true);
  assert.equal(duplicate.duplicate,true);
  assert.equal(harness.observations.size,1);
});

test('abandoned shadow processing is reclaimed and recorded exactly once',async()=>{
  const harness=shadowHarness();
  const payload={phone:'a',waMessageId:'recover-shadow',text:'2 kopsus'};
  await harness.register(payload); // process crashes after persistence
  harness.advance(101);
  const recovered=await runInboundPipeline({payload,...harness});
  assert.equal(recovered.shadow,true);
  assert.equal(harness.observations.size,1);
});

test('production shadow branch has no authoritative mutation or customer reply primitive',async()=>{
  const source=await readFile(new URL('../services/chatbot/orchestrator.js',import.meta.url),'utf8');
  const shadowBlock=source.slice(source.indexOf('async function applyShadowTurn'),source.indexOf('async function finalizeShadowContention'));
  assert.doesNotMatch(shadowBlock,/create_order_bundle|cancel_order|confirm_cash_payment|inventory_reservations|persistConversation|storeOutboundReply/);
  assert.doesNotMatch(shadowBlock,/(insert into|update) conversation_order_states/i);
  assert.match(source,/processingMode:requestedMode/);
  assert.match(source,/registration\.processingMode==='shadow'[\s\S]{0,80}applyShadowTurn/);

  const migration=await readFile(new URL('../supabase/migrations/013_chat_shadow_observations.sql',import.meta.url),'utf8');
  assert.match(migration,/unique\(source_message_id\)/i);
  assert.match(migration,/unique\(wa_message_id\)/i);
  assert.match(migration,/revoke all on public\.chat_shadow_observations/i);
});
