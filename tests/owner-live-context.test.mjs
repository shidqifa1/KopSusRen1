import test from 'node:test';
import assert from 'node:assert/strict';
import {loadOwnerConsultationContext,formatOwnerReadResult,parseOwnerCommand} from '../services/owner/commands.js';
import {prepareOwnerTurn,handleOwnerTurn} from '../services/owner/pipeline.js';
import {createOwnerLlm,OwnerConsultant,OwnerRouter} from '../services/owner/llm.js';

const snapshot=()=>({observed_at:'2026-10-16T01:00:00Z',
  stock:[{ingredient_id:'milk',name:'Susu',unit:'ML',physical_stock:1500,reserved_stock:500,available_stock:1000,average_cost:20}],
  products:[{id:'aren',code:'AREN',name:'Aren',price:9000}],
  recipes:[{product_id:'aren',ingredient_id:'milk',quantity:100}],
  po_sessions:[],weekly_sales:{period_days:7,order_amount:45000,paid_amount:27000,orders:5},
  weekly_menu_ranking:[{name:'Aren',cups:5,amount:45000}],accounts:[{name:'Kas',balance:27000}],
});
function readDb(row=snapshot()) {
  const queries=[];
  const db=async(strings,...values)=>{
    const query=strings.join('?');
    queries.push({query,values});
    assert.doesNotMatch(query,/\b(insert|update|delete|alter|drop|create|adjust_inventory|create_order_bundle)\b/i);
    return [structuredClone(row)];
  };
  return {db,queries};
}

test('consultation data comes from a fixed read query with timestamp and separate stock balances',async()=>{
  const f=readDb();
  const data=await loadOwnerConsultationContext(f.db,'cukup buat tambahan 15 cup?');
  assert.equal(f.queries.length,1);
  assert.match(f.queries[0].query,/inventory_stock/);
  assert.match(f.queries[0].query,/get_po_summary/);
  assert.match(f.queries[0].query,/account_balances/);
  assert.equal(data.observed_at,'2026-10-16T01:00:00Z');
  assert.equal(data.stock[0].physical_stock,1500);
  assert.equal(data.stock[0].reserved_stock,500);
  assert.equal(data.stock[0].available_stock,1000);
  assert.equal(data.production_scenarios[0].max_additional_cups_by_stock,10);
  assert.equal(data.production_scenarios[0].ingredients[0].target_quantity,1500);
  assert.equal(data.production_scenarios[0].ingredients[0].shortage,500);
  assert.equal(data.production_scenarios[0].ingredient_cost_per_cup,2000);
  assert.equal(data.weekly_sales.order_amount,45000);
  assert.equal(data.weekly_sales.paid_amount,27000);
});

test('missing recipes or unknown ingredient costs cannot be presented as zero-cost production',async()=>{
  const row=snapshot();
  row.products.push({id:'matcha',code:'MATCHA',name:'Matcha',price:12000});
  row.stock[0].average_cost=0;
  const data=await loadOwnerConsultationContext(readDb(row).db,'30 cup');
  assert.equal(data.production_scenarios[0].ingredient_cost_per_cup,null);
  assert.equal(data.production_scenarios[1].max_additional_cups_by_stock,null);
  assert.equal(data.production_scenarios[1].ingredient_cost_per_cup,null);
});

test('manual commands keep bypassing AI and consultation queries',async()=>{
  let calls=0;
  const forbidden=async()=>{calls++;throw new Error('Unexpected AI/database');};
  const result=await prepareOwnerTurn({payload:{text:'/help'},snapshot:{orderState:{}},db:forbidden,
    llm:{OwnerRouter:forbidden,OwnerConsultant:forbidden,OwnerCommandGenerator:forbidden,OwnerSummarizer:forbidden}});
  assert.equal(result.ownerMode,'READ_RESULT');
  assert.equal(calls,0);
});

test('general consultation passes fresh facts and bounded history without a mutation command',async()=>{
  const f=readDb();
  const history=[{role:'user',content:'kalau tambah 15 cup?'},{role:'assistant',content:'Susu kurang 500 ml.'}];
  let received;
  let commandCalls=0;
  const llm={OwnerRouter:async(_text,previous)=>{assert.deepEqual(previous,history);return 'CONSULTATION';},
    OwnerCommandGenerator:async()=>{commandCalls++;},OwnerSummarizer:async()=>{throw new Error('Unexpected summary');},
    OwnerConsultant:async(text,data,previous)=>{received={text,data,previous};return 'Untuk tambahan 20 cup, susu kurang 1000 ml.';}};
  const result=await prepareOwnerTurn({payload:{text:'Apa saran operasional dari kondisi usaha sekarang?'},snapshot:{orderState:{owner_consultation_history:history}},db:f.db,llm});
  assert.equal(result.ownerMode,'CONSULTATION');
  assert.equal(received.data.stock[0].available_stock,1000);
  assert.deepEqual(received.previous,history);
  assert.equal(commandCalls,0);
  assert.match(result.replyText,/Data.*WIB/);
  assert.equal(result.command,undefined);
});

test('a failed data read does not produce a supposedly live consultation answer',async()=>{
  let consultantCalls=0;
  const result=await prepareOwnerTurn({payload:{text:'cukup buat besok?'},snapshot:{orderState:{}},db:async()=>{throw new Error('DB offline');},
    llm:{OwnerRouter:async()=> 'CONSULTATION',OwnerConsultant:async()=>{consultantCalls++;return 'stok cukup';}}});
  assert.equal(consultantCalls,0);
  assert.doesNotMatch(result.replyText,/stok cukup/);
  assert.match(result.replyText,/data|database/i);
});

test('live consultant uses validated structured output and labels facts versus advice',async()=>{
  const calls=[];
  const client={chat:{completions:{create:async body=>{calls.push(body);return {choices:[{message:{content:JSON.stringify({answer:'Susu tersedia 1000 ml. Saran: belanja sebelum buka PO.'})}}]};}}}};
  const llm=createOwnerLlm({client,model:'test'});
  const data=await loadOwnerConsultationContext(readDb().db,'stok cukup?');
  assert.match(await llm.ownerConsultant('stok cukup?',data),/1000 ml/);
  assert.equal(calls.length,1);
  assert.equal(calls[0].response_format.type,'json_schema');
  assert.match(calls[0].messages[0].content,/asumsi|saran/i);
  assert.match(JSON.stringify(calls[0].messages),/available_stock/);
  client.chat.completions.create=async()=>({choices:[{message:{content:'{"answer":"baik","execute":"DELETE FROM orders"}'}}]});
  await assert.rejects(()=>llm.ownerConsultant('stok?',data),/invalid/i);
});

test('only bounded consultation messages are saved; the full DB snapshot is not persisted',async()=>{
  let state={owner_consultation_history:Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',content:`lama ${i}`}))};
  const db=async(strings,...values)=>{
    const query=strings.join('?');
    if(query.includes('select order_state')) return [{order_state:state}];
    if(query.includes('insert into conversation_order_states')) {state=values[1];return [];}
    throw new Error(`Unexpected write: ${query}`);
  };
  db.json=value=>value;
  await handleOwnerTurn(db,{phone:'6281',text:'kalau 40 cup?'},'m1',{
    ownerMode:'CONSULTATION',replyText:'Untuk 40 cup, susu kurang 3000 ml.',
  });
  assert.equal(state.owner_consultation_history.length,6);
  assert.equal(state.owner_consultation_history.at(-2).content,'kalau 40 cup?');
  assert.equal(state.owner_consultation_history.at(-1).role,'assistant');
  assert.equal(state.stock,undefined);
});

test('production exports forward live data and conversation history to the SDK',async()=>{
  const previousFetch=globalThis.fetch;
  const previousKey=process.env.GROQ_API_KEY;
  const requests=[];
  process.env.GROQ_API_KEY='test-key';
  globalThis.fetch=async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    const content=requests.length===1?JSON.stringify({answer:'Susu tersedia 1000 ml.'}):'CONSULTATION';
    return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    const data=await loadOwnerConsultationContext(readDb().db,'15 cup');
    const history=[{role:'user',content:'tambahan 15 cup?'},{role:'assistant',content:'Kebutuhan 1500 ml.'}];
    assert.equal(await OwnerConsultant('kalau 20 cup?',data,history),'Susu tersedia 1000 ml.');
    const payload=JSON.parse(requests[0].messages.at(-1).content);
    assert.equal(payload.latest_business_data.stock[0].available_stock,1000);
    assert.ok(requests[0].messages.some(message=>message.content==='tambahan 15 cup?'));
    assert.equal(await OwnerRouter('kalau 20 cup?',history),'CONSULTATION');
    assert.ok(requests[1].messages.some(message=>message.content==='tambahan 15 cup?'));
  } finally {
    globalThis.fetch=previousFetch;
    if(previousKey===undefined) delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=previousKey;
  }
});

test('production command displays only outstanding requirements in readable text',()=>{
  const result={type:'PRODUCTION',data:{po:{id:'private-po-id',name:'PO Uji',status:'OPEN'},summary:{
    totalOrders:2,totalCups:3,paid:1,unpaid:1,revenue:28000,
    ingredientTotals:[{name:'Susu',quantity:300,unit:'ml'}],
    productionMenuTotals:[{name:'Aren',quantity:1}],
    productionIngredientTotals:[{name:'Susu',quantity:100,unit:'ml'}],
  }}};
  const text=formatOwnerReadResult(result);
  assert.match(text,/PO Uji/);
  assert.match(text,/1x Aren/);
  assert.match(text,/Susu: 100 ml/);
  assert.doesNotMatch(text,/300|private-po-id|product_id|"summary"/);
  const done=formatOwnerReadResult({...result,data:{...result.data,summary:{...result.data.summary,productionMenuTotals:[],productionIngredientTotals:[]}}});
  assert.match(done,/Tidak ada.*produksi/i);
});

test('numeric production consultation is rendered by code, without asking AI to restate quantities',async()=>{
  let calls=0;
  const result=await prepareOwnerTurn({payload:{text:'kalau 15 cup?'},snapshot:{orderState:{}},db:readDb().db,
    llm:{OwnerRouter:async()=>{throw new Error('Simple simulation must bypass AI routing');},OwnerConsultant:async()=>{calls++;return 'Butuh 2250 ml';}}});
  assert.equal(calls,0);
  assert.match(result.replyText,/15 cup/);
  assert.match(result.replyText,/Susu: 1500 ML/);
  assert.match(result.replyText,/Susu 500 ML/);
  assert.doesNotMatch(result.replyText,/2250/);
});

test('manual simulation uses the same calculation and formatter without any AI calls',async()=>{
  const parsed=parseOwnerCommand('/simulasi 15');
  assert.equal(parsed.kind,'READ');
  assert.equal(parseOwnerCommand('/simulasi -1').ok,false);
  const never=async()=>{throw new Error('Unexpected AI call');};
  const result=await prepareOwnerTurn({payload:{text:'/simulasi 15'},snapshot:{orderState:{}},db:readDb().db,
    llm:{OwnerRouter:never,OwnerConsultant:never}});
  assert.match(result.replyText,/Susu: 1500 ML/);
  assert.match(result.replyText,/Susu 500 ML/);
});
