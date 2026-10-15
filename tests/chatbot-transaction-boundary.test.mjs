import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decideParsedResultApplicability,runInboundPipeline } from '../services/chatbot/transactionFlow.js';

const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

function memoryPipeline() {
  const claimed=new Set();
  const states=new Map();
  let sequence=0;
  const prepareCounts=new Map();
  const applyCounts=new Map();
  const register=async payload=>{
    if (claimed.has(payload.waMessageId)) return {duplicate:true};
    claimed.add(payload.waMessageId);
    sequence+=1;
    return {messageId:payload.waMessageId,messageCreatedAt:new Date(1_700_000_000_000+sequence*1000).toISOString()};
  };
  const prepare=async payload=>{
    const current=states.get(payload.phone)||{revision:0,value:null,lastAppliedAt:null};
    prepareCounts.set(payload.waMessageId,(prepareCounts.get(payload.waMessageId)||0)+1);
    const snapshotVersion=String(current.revision);
    await wait(payload.delay||0);
    return {stateVersion:snapshotVersion,value:payload.text,role:'CUSTOMER'};
  };
  const apply=async (payload,registration,prepared)=>{
    const current=states.get(payload.phone)||{revision:0,value:null,lastAppliedAt:null};
    const applicability=decideParsedResultApplicability({
      snapshotVersion:prepared.stateVersion,
      currentVersion:String(current.revision),
      messageCreatedAt:registration.messageCreatedAt,
      lastAppliedAt:current.lastAppliedAt,
    });
    if (applicability==='STALE') return {status:'STALE',result:{superseded:true}};
    if (applicability==='RETRY') return {status:'RETRY'};
    applyCounts.set(payload.waMessageId,(applyCounts.get(payload.waMessageId)||0)+1);
    states.set(payload.phone,{revision:current.revision+1,value:prepared.value,lastAppliedAt:registration.messageCreatedAt});
    return {status:'APPLIED',result:{value:prepared.value}};
  };
  return {register,prepare,apply,states,prepareCounts,applyCounts};
}

test('older slow parser result becomes stale and cannot overwrite a newer message',async()=>{
  const memory=memoryPipeline();
  const old=runInboundPipeline({payload:{phone:'customer-a',waMessageId:'old',text:'old draft',delay:60},...memory});
  await wait(2);
  const newer=runInboundPipeline({payload:{phone:'customer-a',waMessageId:'new',text:'new draft',delay:5},...memory});
  const [oldResult,newResult]=await Promise.all([old,newer]);
  assert.equal(newResult.value,'new draft');
  assert.equal(oldResult.superseded,true);
  assert.equal(memory.states.get('customer-a').value,'new draft');
  assert.equal(memory.applyCounts.get('old')||0,0);
});

test('newer message is reparsed against authoritative state when an older message applied first',async()=>{
  const memory=memoryPipeline();
  const old=runInboundPipeline({payload:{phone:'customer-a',waMessageId:'old-fast',text:'first',delay:5},...memory});
  await wait(1);
  const newer=runInboundPipeline({payload:{phone:'customer-a',waMessageId:'new-slow',text:'second',delay:35},...memory});
  await Promise.all([old,newer]);
  assert.equal(memory.states.get('customer-a').value,'second');
  assert.equal(memory.prepareCounts.get('new-slow'),2);
  assert.equal(memory.applyCounts.get('new-slow'),1);
});

test('duplicate wa_message_id cannot parse, transition, or create twice',async()=>{
  const memory=memoryPipeline();
  const payload={phone:'customer-a',waMessageId:'same-id',text:'gas',delay:10};
  const results=await Promise.all([
    runInboundPipeline({payload,...memory}),
    runInboundPipeline({payload,...memory}),
  ]);
  assert.equal(results.filter(result=>result.duplicate).length,1);
  assert.equal(memory.prepareCounts.get('same-id'),1);
  assert.equal(memory.applyCounts.get('same-id'),1);
});

test('a slow LLM call for one customer does not block a different customer',async()=>{
  const memory=memoryPipeline();
  const completion=[];
  const slow=runInboundPipeline({payload:{phone:'customer-slow',waMessageId:'slow',text:'slow',delay:80},...memory}).then(()=>completion.push('slow'));
  const fast=runInboundPipeline({payload:{phone:'customer-fast',waMessageId:'fast',text:'fast',delay:5},...memory}).then(()=>completion.push('fast'));
  await Promise.all([slow,fast]);
  assert.deepEqual(completion,['fast','slow']);
  assert.equal(memory.states.get('customer-fast').value,'fast');
  assert.equal(memory.states.get('customer-slow').value,'slow');
});

test('external parser calls live only in the prepare phase outside transaction callbacks',async()=>{
  const source=await readFile(new URL('../services/chatbot/orchestrator.js',import.meta.url),'utf8');
  const prepareBlock=source.slice(source.indexOf('async function prepareChatTurn'),source.indexOf('async function handleCustomer'));
  const registerBlock=source.slice(source.indexOf('async function registerInboundMessage'),source.indexOf('async function applyPreparedTurn'));
  const applyBlock=source.slice(source.indexOf('async function applyPreparedTurn'),source.indexOf('async function finalizeContention'));
  assert.match(prepareBlock,/parseWithGroq/);
  assert.doesNotMatch(registerBlock,/parseWithGroq/);
  assert.doesNotMatch(applyBlock,/parseWithGroq/);
  assert.match(source,/runInboundPipeline\(\{[\s\S]{0,180}register:registerInboundMessage,[\s\S]{0,100}prepare:prepareChatTurn,[\s\S]{0,180}apply:\(currentPayload,registration,prepared\)=>registration\.processingMode/);
});
