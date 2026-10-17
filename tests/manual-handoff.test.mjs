import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseOwnerCommand,executeOwnerWriteCommand} from '../services/owner/commands.js';
import {emptyDraft} from '../services/chatbot/conversation.js';

const phone='628123400001';
const moduleUrl=new URL('../services/chatbot/orchestrator.js',import.meta.url);
let currentDb=null;
globalThis[Symbol.for('baristack-handoff-test-db')]=Object.assign(async(...args)=>currentDb(...args),{json:value=>structuredClone(value)});
const source=(await readFile(moduleUrl,'utf8'))
  .replace("import { sql } from '../../db/index.js';","const sql=globalThis[Symbol.for('baristack-handoff-test-db')];")
  .replace(/from '(\.[^']+)'/g,(_match,path)=>`from '${new URL(path,moduleUrl).href}'`);
const {handleCustomer,prepareChatTurn}=await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport {handleCustomer,prepareChatTurn};`).toString('base64')}`);

test('takeover commands accept exact phone numbers and remain owner WRITE commands',()=>{
  const parsed=parseOwnerCommand('/chat ambil 08123400001');
  assert.equal(parsed.kind,'WRITE');
  assert.equal(parsed.args.phone,phone);
  assert.equal(parseOwnerCommand(`/chat lanjut ${phone}`).kind,'WRITE');
  for(const text of ['/chat ambil Budi','/chat ambil 1','/chat lanjut 628123400001 extra','/chat ambil 628123400001;drop']) {
    assert.equal(parseOwnerCommand(text).ok,false,text);
  }
});

test('takeover serializes with incoming customer messages and invalidates old confirmations',async()=>{
  const queries=[];
  const db=async(strings,...values)=>{
    const query=strings.join('?');queries.push({query,values});
    if(query.includes('pg_advisory_xact_lock')) return [];
    assert.match(query,/update conversation_order_states/);
    assert.match(query,/_confirmation_snapshot/);
    assert.match(query,/_usual_order_suggestion/);
    assert.match(query,/awaiting_confirmation/);
    return [{customer_phone:phone}];
  };
  const result=await executeOwnerWriteCommand(db,parseOwnerCommand(`/chat ambil ${phone}`));
  assert.match(result.replyText,/berhenti|manual/i);
  assert.equal(queries[0].values[0],phone);
  assert.equal(queries[1].values[0],true);
  const resumed=await executeOwnerWriteCommand(db,parseOwnerCommand(`/chat lanjut ${phone}`));
  assert.match(resumed.replyText,/aktif|lanjut/i);
  assert.equal(queries.at(-1).values[0],false);
});

test('takeover never silently creates a missing conversation',async()=>{
  await assert.rejects(()=>executeOwnerWriteCommand(async()=>[],parseOwnerCommand(`/chat ambil ${phone}`)),/belum|tidak ditemukan/i);
});

test('paused customers skip business queries and the parser, including images',async()=>{
  let calls=0;
  currentDb=async strings=>{
    calls++;
    assert.match(strings.join('?'),/from conversation_order_states/);
    return [{order_state:{...emptyDraft('old-po'),_manual_handoff:true},updated_at:'2026-10-16T01:00:00Z'}];
  };
  for(const hasImage of [false,true]) {
    const prepared=await prepareChatTurn({phone,text:'gas',hasImage},{messageId:'m1'});
    assert.equal(prepared.manualHandoff,true);
    assert.equal(prepared.parsedByAi,false);
    const result=await handleCustomer(async()=>{throw new Error('Unexpected business query');},{phone,text:'gas',hasImage},'m1',prepared);
    assert.equal(result.replyText,null);
    assert.equal(result.manualHandoff,true);
  }
  assert.equal(calls,2);
});

test('repeated parser failure notifies once and persists pause without losing the draft',async()=>{
  let state={...emptyDraft('po'),items:[{productId:'aren',quantity:1,modifiers:[],noIce:false,notes:null}]};
  const db=async(strings,...values)=>{
    const query=strings.join('?');
    if(query.includes("from po_sessions where status='OPEN'")) return [{id:'po',name:'PO'}];
    if(query.includes('from products where is_active')) return [{id:'aren',name:'Aren',price:9000}];
    if(query.includes('select evaluate_po_availability')) return [{value:{products:[]}}];
    if(query.includes('from conversation_order_states')) return [{order_state:structuredClone(state)}];
    if(query.includes('insert into order_drafts')||query.includes('update order_drafts')) return [{id:'draft-id'}];
    if(query.includes('insert into conversation_order_states')) {state=structuredClone(values[1]);return [];}
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const previous=process.env.WA_OWNER_NUMBERS;
  process.env.WA_OWNER_NUMBERS='628999900001';
  try {
    await handleCustomer(db,{phone,text:'???'},'m1',{parsed:null});
    const second=await handleCustomer(db,{phone,text:'???'},'m2',{parsed:null});
    assert.equal(second.ownerNotifications.length,1);
    assert.equal(state._manual_handoff,true);
    assert.equal(state.items[0].quantity,1);
    assert.equal(state.awaiting_confirmation,false);
  } finally {
    if(previous===undefined) delete process.env.WA_OWNER_NUMBERS; else process.env.WA_OWNER_NUMBERS=previous;
  }
});
