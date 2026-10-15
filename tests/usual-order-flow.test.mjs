import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {emptyDraft,orderConfirmationSnapshot} from '../services/chatbot/conversation.js';

// Run the actual handlers against a strict SQL fixture; no credentials or live DB.
const orchestratorUrl=new URL('../services/chatbot/orchestrator.js',import.meta.url);
const dbSymbol=Symbol.for('baristack-usual-order-test-db');
const globalDb=Object.assign(async(...args)=>{
  if (!globalDb.fixture) throw new Error('Unexpected global SQL');
  return globalDb.fixture(...args);
},{json:value=>structuredClone(value)});
globalThis[dbSymbol]=globalDb;
const source=(await readFile(orchestratorUrl,'utf8'))
  .replace("import { sql } from '../../db/index.js';","const sql=globalThis[Symbol.for('baristack-usual-order-test-db')];")
  .replace(/from '(\.[^']+)'/g,(_match,path)=>`from '${new URL(path,orchestratorUrl).href}'`);
const {handleCustomer,prepareChatTurn}=await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport {handleCustomer,prepareChatTurn};`).toString('base64')}`);

const phone='628123400001';
const product={id:'aren',code:'AREN',name:'Kopi Susu Gula Aren',price:9000,is_active:true,chatbot_metadata:{aliases:['aren']}};
const historical={order_number:12,phone,status:'FULFILLED',source:'WHATSAPP',items:[{product_id:'aren',quantity:3,no_ice:false,notes:'less ice'}]};
const parsed=entities=>({intents:['ADD_ITEM'],entities:{item_operations:[],...entities},confidence:1});

function fixture({history=[historical],state=emptyDraft('po'),poOpen=true,available=true}={}) {
  let current=structuredClone(state);
  let orderCount=0;
  const queries=[];
  const db=async(strings,...values)=>{
    const query=strings.join('?').replace(/\s+/g,' ').trim();
    queries.push({query,values});
    if (query.includes("from po_sessions where status='OPEN'")) return poOpen?[{id:'po',name:'PO Test',status:'OPEN'}]:[];
    if (query.includes('from products where is_active')) return [product];
    if (query.startsWith('select evaluate_po_availability')) return [{value:{products:[{productId:'aren',available,availableQty:available?10:0}]}}];
    if (query.includes('from conversation_order_states')) return [{order_state:structuredClone(current),updated_at:'2026-10-16T01:00:00Z'}];
    if (query.includes('from chat_messages')) return [];
    if (query.includes('from orders o')&&query.includes("o.status='FULFILLED'")) {
      assert.match(query,/o\.customer_phone=\?/);
      assert.match(query,/o\.source='WHATSAPP'/);
      assert.doesNotMatch(query,/c\.phone|c\.name/);
      assert.equal(values[0],phone);
      return history.filter(row=>row.phone===values[0]&&row.status==='FULFILLED'&&row.source==='WHATSAPP').slice(0,1);
    }
    if (query.startsWith('insert into order_drafts')) return [{id:'draft-id'}];
    if (query.startsWith('update order_drafts')) return [{id:'draft-id'}];
    if (query.startsWith('insert into conversation_order_states')) {current=structuredClone(values[1]);return [];}
    if (query.startsWith('update conversation_order_states')) {current=structuredClone(values[0]);return [];}
    if (query.startsWith('select create_order_bundle')) {orderCount++;return [{id:'new-order'}];}
    if (query.includes('from orders o join payments p on p.order_id=o.id where o.id=')) return [{order_number:13,total_amount:9000}];
    throw new Error(`Unhandled SQL: ${query}`);
  };
  db.json=value=>structuredClone(value);
  return {db,queries,get state(){return current;},get orderCount(){return orderCount;}};
}

const send=(f,text,extracted=null)=>handleCustomer(f.db,{phone,text,waMessageId:`test-${text}`},'message-id',{parsed:extracted});

test('real customer handler repeats only after selection, name, payment and final confirmation',async()=>{
  const f=fixture();
  const first=await send(f,'yang biasa ya 1');
  assert.match(first.replyText,/Kopi Susu Gula Aren.*less ice/s);
  assert.match(first.replyText,/9\.000/);
  assert.equal(f.orderCount,0);
  const adopted=await send(f,'iya');
  assert.match(adopted.replyText,/Atas nama siapa/);
  assert.equal(f.state.items[0].quantity,1);
  assert.equal(f.orderCount,0);
  await send(f,'Dika',parsed({name:'Dika'}));
  await send(f,'cash',parsed({payment_method:'CASH'}));
  assert.equal(f.orderCount,0);
  const confirmed=await send(f,'gas',parsed({confirmation:true}));
  assert.deepEqual(confirmed.orderIds,['new-order']);
  assert.equal(f.orderCount,1);
  const creation=f.queries.find(row=>row.query.startsWith('select create_order_bundle'));
  assert.equal(creation.values.at(-1),phone);
  assert.deepEqual(creation.values[3],[{productId:'aren',quantity:1,noIce:false,notes:'less ice'}]);
});

test('history must belong to the exact WhatsApp order identity and be fulfilled',async()=>{
  for(const row of [{...historical,phone:'628999999999'},{...historical,status:'CANCELLED'},{...historical,status:'ACCEPTED'}]) {
    const f=fixture({history:[row]});
    const result=await send(f,'yang biasa 1');
    assert.match(result.replyText,/Belum ada riwayat/);
    assert.deepEqual(f.state.items,[]);
    assert.equal(f.orderCount,0);
  }
});

test('a closed PO cannot create or suggest a usual order',async()=>{
  const f=fixture({poOpen:false});
  const result=await send(f,'yang biasa 1');
  assert.match(result.replyText,/PO belum dibuka|ditutup/);
  assert.equal(f.queries.some(row=>row.query.includes("o.status='FULFILLED'")),false);
  assert.equal(f.orderCount,0);
});

test('prepare bypasses the external AI for a usual request and its confirmation',async()=>{
  for(const state of [emptyDraft('po'),{...emptyDraft('po'),_usual_order_suggestion:{productId:'aren',quantity:1,modifiers:[],noIce:false,source_order_number:12}}]) {
    const f=fixture({state});
    const globalDb=globalThis[dbSymbol];
    // The module captures the SQL function, so route that function through this fixture.
    globalDb.fixture=f.db;
    const text=state._usual_order_suggestion?'iya':'yang biasa 1';
    const prepared=await prepareChatTurn({phone,text},{messageId:'prepare-test'});
    assert.equal(prepared.parsedByAi,false);
    assert.equal(prepared.usualOrder,true);
  }
});

test('price changes after showing a summary require a new confirmation before creating',async()=>{
  const state={...emptyDraft('po'),customer_name:'Dika',payment_method:'CASH',awaiting_confirmation:true,
    items:[{productId:'aren',quantity:1,modifiers:[],noIce:false,notes:null}]};
  state._confirmation_snapshot=orderConfirmationSnapshot(state,[{...product,price:8000}]);
  const f=fixture({state});
  const changed=await send(f,'gas',parsed({confirmation:true}));
  assert.equal(f.orderCount,0);
  assert.match(changed.replyText,/berubah|konfirmasi ulang/i);
  assert.match(changed.replyText,/9\.000/);
  await send(f,'gas',parsed({confirmation:true}));
  assert.equal(f.orderCount,1);
});

test('asking for the menu must not silently approve an updated cart price',async()=>{
  const state={...emptyDraft('po'),customer_name:'Dika',payment_method:'CASH',awaiting_confirmation:true,
    items:[{productId:'aren',quantity:1,modifiers:[],noIce:false,notes:null}]};
  state._confirmation_snapshot=orderConfirmationSnapshot(state,[{...product,price:8000}]);
  const f=fixture({state});
  await send(f,'lihat menu',{intents:['SHOW_MENU'],entities:{item_operations:[]},confidence:1});
  const result=await send(f,'gas',parsed({confirmation:true}));
  assert.equal(f.orderCount,0);
  assert.match(result.replyText,/konfirmasi ulang/);
});
