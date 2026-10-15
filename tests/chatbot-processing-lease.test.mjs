import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decideParsedResultApplicability,runInboundPipeline } from '../services/chatbot/transactionFlow.js';

function leaseHarness({leaseMs=100}={}) {
  let now=1_700_000_000_000;
  let leaseSequence=0;
  let orderCreates=0;
  const messages=new Map();
  const states=new Map();
  const orderKeys=new Set();
  const register=async payload=>{
    const existing=messages.get(payload.waMessageId);
    if (existing) {
      if (existing.processingState!=='PENDING'||existing.leaseExpiresAt>now) return {duplicate:true};
      existing.leaseId=`lease-${++leaseSequence}`;
      existing.leaseExpiresAt=now+leaseMs;
      existing.attempt+=1;
      return {messageId:payload.waMessageId,messageCreatedAt:new Date(existing.createdAt).toISOString(),leaseId:existing.leaseId,recovered:true};
    }
    const row={processingState:'PENDING',createdAt:now,leaseId:`lease-${++leaseSequence}`,leaseExpiresAt:now+leaseMs,attempt:1};
    messages.set(payload.waMessageId,row);
    return {messageId:payload.waMessageId,messageCreatedAt:new Date(row.createdAt).toISOString(),leaseId:row.leaseId,recovered:false};
  };
  const prepare=async payload=>{
    const state=states.get(payload.phone)||{revision:0,value:null,lastAppliedAt:null};
    return {stateVersion:String(state.revision),value:payload.text,role:'CUSTOMER'};
  };
  const apply=async (payload,registration,prepared)=>{
    const row=messages.get(registration.messageId);
    if (!row||row.processingState!=='PENDING'||row.leaseId!==registration.leaseId) return {status:'STALE',result:{duplicate:true}};
    const state=states.get(payload.phone)||{revision:0,value:null,lastAppliedAt:null};
    const applicability=decideParsedResultApplicability({
      snapshotVersion:prepared.stateVersion,currentVersion:String(state.revision),
      messageCreatedAt:registration.messageCreatedAt,lastAppliedAt:state.lastAppliedAt,
    });
    if (applicability==='STALE') {
      row.processingState='STALE';
      return {status:'STALE',result:{superseded:true}};
    }
    if (applicability==='RETRY') return {status:'RETRY'};
    const orderKey=`wa-order:${payload.waMessageId}`;
    if (payload.createOrder&&!orderKeys.has(orderKey)) {
      orderKeys.add(orderKey);
      orderCreates+=1;
    }
    states.set(payload.phone,{revision:state.revision+1,value:prepared.value,lastAppliedAt:registration.messageCreatedAt});
    row.processingState='APPLIED';
    row.leaseId=null;
    return {status:'APPLIED',result:{applied:true}};
  };
  return {
    register,prepare,apply,messages,states,
    advance(milliseconds){ now+=milliseconds; },
    get orderCreates(){ return orderCreates; },
  };
}

test('crash after persistence leaves a leased PENDING message without applying state',async()=>{
  const harness=leaseHarness();
  const registration=await harness.register({phone:'a',waMessageId:'crash-1',text:'1 kopsus'});
  assert.equal(registration.recovered,false);
  assert.equal(harness.messages.get('crash-1').processingState,'PENDING');
  assert.equal(harness.states.has('a'),false);
});

test('an abandoned PENDING message becomes recoverable after lease timeout',async()=>{
  const harness=leaseHarness();
  const payload={phone:'a',waMessageId:'recover-1',text:'1 kopsus'};
  const abandoned=await harness.register(payload);
  harness.advance(101);
  const recovered=await harness.register(payload);
  assert.equal(recovered.recovered,true);
  assert.notEqual(recovered.leaseId,abandoned.leaseId);
  const prepared=await harness.prepare(payload,recovered);
  assert.equal((await harness.apply(payload,recovered,prepared)).status,'APPLIED');
});

test('duplicate webhook during an active lease cannot double-process',async()=>{
  const harness=leaseHarness();
  const payload={phone:'a',waMessageId:'active-1',text:'gas',createOrder:true};
  const first=await harness.register(payload);
  const duplicate=await harness.register(payload);
  assert.equal(duplicate.duplicate,true);
  const prepared=await harness.prepare(payload,first);
  await harness.apply(payload,first,prepared);
  assert.equal(harness.orderCreates,1);
});

test('recovery invalidates the old lease and cannot create a duplicate order',async()=>{
  const harness=leaseHarness();
  const payload={phone:'a',waMessageId:'order-1',text:'gas',createOrder:true};
  const abandoned=await harness.register(payload);
  const oldPrepared=await harness.prepare(payload,abandoned);
  harness.advance(101);
  const recovered=await harness.register(payload);
  const recoveredPrepared=await harness.prepare(payload,recovered);
  assert.equal((await harness.apply(payload,recovered,recoveredPrepared)).status,'APPLIED');
  assert.equal((await harness.apply(payload,abandoned,oldPrepared)).result.duplicate,true);
  assert.equal(harness.orderCreates,1);
});

test('an APPLIED message can never be reclaimed',async()=>{
  const harness=leaseHarness();
  const payload={phone:'a',waMessageId:'applied-1',text:'gas',createOrder:true};
  await runInboundPipeline({payload,...harness});
  harness.advance(1000);
  assert.equal((await harness.register(payload)).duplicate,true);
  assert.equal(harness.orderCreates,1);
});

test('stale recovered message cannot overwrite newer conversation state',async()=>{
  const harness=leaseHarness();
  const oldPayload={phone:'a',waMessageId:'old-abandoned',text:'old value'};
  await harness.register(oldPayload);
  harness.advance(10);
  const newerPayload={phone:'a',waMessageId:'new-applied',text:'new value'};
  await runInboundPipeline({payload:newerPayload,...harness});
  harness.advance(101);
  const recovered=await harness.register(oldPayload);
  const prepared=await harness.prepare(oldPayload,recovered);
  const outcome=await harness.apply(oldPayload,recovered,prepared);
  assert.equal(outcome.status,'STALE');
  assert.equal(harness.states.get('a').value,'new value');
});

test('production claim uses atomic expiry and lease ownership guards',async()=>{
  const source=await readFile(new URL('../services/chatbot/orchestrator.js',import.meta.url),'utf8');
  assert.match(source,/processingLeaseExpiresAt.*::timestamptz<=now\(\)/s);
  assert.match(source,/payload->>'processingState'='PENDING'/);
  assert.match(source,/processingLeaseId===registration\.leaseId/);
  assert.match(source,/wa-order:\$\{payload\.waMessageId\|\|messageId\}/);
  assert.match(source,/export async function recoverAbandonedInboundMessages/);
  const api=await readFile(new URL('../api/v2/commands.ts',import.meta.url),'utf8');
  assert.match(api,/await recoverAbandonedInboundMessages\(3\)/);
});
