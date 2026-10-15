import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOwnerLlm,OWNER_AI_FALLBACK,OWNER_OUT_OF_SCOPE_REPLY } from '../services/owner/llm.js';
import { parseOwnerCommand } from '../services/owner/commands.js';
import { handleOwnerTurn,prepareOwnerTurn } from '../services/owner/pipeline.js';

function completion(value) {
  return {choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]};
}

function fakeClient(responses) {
  const calls=[];
  return {
    calls,
    chat:{completions:{create:async(body,options)=>{
      calls.push({body,options});
      const next=responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }}},
  };
}

test('owner LLM functions make one SDK request each and expose narrow outputs',async()=>{
  const client=fakeClient([
    completion({route:'WRITE_INTENT'}),
    completion({command:'/po tutup besok'}),
    completion('PO besok sudah menjual 15 cup.'),
    completion('Coba buat promo bundling.'),
  ]);
  const llm=createOwnerLlm({client,model:'test-model',timeoutMs:4500});
  assert.equal(await llm.ownerRouter('tutup PO besok'),'WRITE_INTENT');
  assert.equal(await llm.ownerCommandGenerator('WRITE_INTENT','tutup PO besok'),'/po tutup besok');
  assert.equal(await llm.ownerSummarizer({cups:15},'berapa cup?'),'PO besok sudah menjual 15 cup.');
  assert.equal(await llm.ownerConsultant('cara naikin sales?'),'Coba buat promo bundling.');
  assert.equal(client.calls.length,4);
  assert.ok(client.calls.every(call=>call.options.signal instanceof AbortSignal));
  assert.match(client.calls[1].body.messages[0].content,/\/po tutup/);
  assert.match(client.calls[1].body.messages[0].content,/\/stok tambah/);
});

test('owner LLM aborts at the configured hard timeout without retry',async()=>{
  let calls=0;
  const client={chat:{completions:{create:(_body,{signal})=>{
    calls+=1;
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }}}};
  const llm=createOwnerLlm({client,model:'test',timeoutMs:15});
  await assert.rejects(()=>llm.ownerRouter('stok berapa'),/aborted/);
  assert.equal(calls,1);
});

test('deterministic command grammar separates read/write and rejects injection',()=>{
  assert.deepEqual(parseOwnerCommand('/po tutup besok'),{ok:true,kind:'WRITE',action:'PO_CLOSE',args:{selector:'besok'},command:'/po tutup besok'});
  assert.equal(parseOwnerCommand('/stok list').kind,'READ');
  assert.deepEqual(parseOwnerCommand('/menu list'),{ok:true,kind:'READ',action:'MENU_LIST',args:{},command:'/menu list'});
  assert.equal(parseOwnerCommand('/stok tambah gula_aren 500 gr').args.unit,'G');
  for (const input of ['/po tutup besok\n/order batal 1','/stok list; rm -rf x','/order batal nope','/po buka besok']) {
    assert.equal(parseOwnerCommand(input).ok,false,input);
  }
});

test('manual slash and Y/N bypass every owner LLM function',async()=>{
  const never=async()=>{throw new Error('LLM must not be called');};
  const llm={OwnerRouter:never,OwnerCommandGenerator:never,OwnerSummarizer:never,OwnerConsultant:never};
  const snapshot={orderState:{},stateVersion:'v1'};
  const manual=await prepareOwnerTurn({payload:{text:'/po tutup besok'},snapshot,db:null,llm});
  assert.equal(manual.ownerMode,'WRITE_COMMAND');
  const help=await prepareOwnerTurn({payload:{text:'/help'},snapshot,db:null,llm});
  assert.equal(help.ownerMode,'READ_RESULT');
  assert.match(help.replyText,/\/stok list/);
  const confirm=await prepareOwnerTurn({payload:{text:'Y'},snapshot,db:null,llm});
  assert.equal(confirm.ownerMode,'CONFIRMATION');
});

test('natural read uses generator, deterministic read engine, then summarizer',async()=>{
  const calls=[];
  const llm={
    OwnerRouter:async message=>{calls.push(['router',message]);return 'READ_QUERY';},
    OwnerCommandGenerator:async(intent,message)=>{calls.push(['generator',intent,message]);return '/help';},
    OwnerSummarizer:async(data,query)=>{calls.push(['summarizer',data,query]);return 'Ini daftar command yang tersedia.';},
    OwnerConsultant:async()=>{throw new Error('must not run');},
  };
  const prepared=await prepareOwnerTurn({payload:{text:'bisa ngapain aja?'},snapshot:{orderState:{}},db:null,llm});
  assert.equal(prepared.ownerMode,'READ_RESULT');
  assert.equal(prepared.replyText,'Ini daftar command yang tersedia.');
  assert.deepEqual(calls.map(call=>call[0]),['router','generator','summarizer']);
});

test('manual menu list reads real products and formats prices without LLM',async()=>{
  const never=async()=>{throw new Error('LLM must not be called');};
  const db=async strings=>{
    assert.match(strings.join('?'),/from products where is_active/);
    return [{code:'KSGA',name:'Kopi Susu Gula Aren',price:8000},{code:'MATCHA',name:'Matcha Latte',price:12000}];
  };
  const prepared=await prepareOwnerTurn({payload:{text:'/menu list'},snapshot:{orderState:{}},db,llm:{OwnerRouter:never,OwnerCommandGenerator:never,OwnerSummarizer:never,OwnerConsultant:never}});
  assert.equal(prepared.ownerMode,'READ_RESULT');
  assert.match(prepared.replyText,/Kopi Susu Gula Aren — Rp8\.000/);
  assert.match(prepared.replyText,/Matcha Latte — Rp12\.000/);
});

test('unsupported multiline owner batch fails safely instead of becoming consultation advice',async()=>{
  const llm={
    OwnerRouter:async()=> 'WRITE_INTENT',
    OwnerCommandGenerator:async()=> '/order batch',
    OwnerSummarizer:async()=>{throw new Error('must not run');},
    OwnerConsultant:async()=>{throw new Error('must not run');},
  };
  const prepared=await prepareOwnerTurn({payload:{text:'lutpi 7 latte 1\ndhiya 82 matcha 1'},snapshot:{orderState:{}},db:null,llm});
  assert.match(prepared.replyText,/batch order/i);
  assert.match(prepared.replyText,/satu customer tetap menjadi satu order/i);
});

test('consultation has no database or command-generator access',async()=>{
  let generatorCalls=0;
  const llm={
    OwnerRouter:async()=> 'CONSULTATION',
    OwnerCommandGenerator:async()=>{generatorCalls+=1;throw new Error('must not run');},
    OwnerSummarizer:async()=>{throw new Error('must not run');},
    OwnerConsultant:async()=> 'Coba evaluasi jam jualan dan bundling.',
  };
  const prepared=await prepareOwnerTurn({payload:{text:'cara naikin sales?'},snapshot:{orderState:{}},db:null,llm});
  assert.equal(prepared.replyText,'Coba evaluasi jam jualan dan bundling.');
  assert.equal(generatorCalls,0);
});

test('out-of-scope owner message is refused without consultant, command, or database access',async()=>{
  let downstreamCalls=0;
  const llm={
    OwnerRouter:async()=> 'OUT_OF_SCOPE',
    OwnerCommandGenerator:async()=>{downstreamCalls+=1;},
    OwnerSummarizer:async()=>{downstreamCalls+=1;},
    OwnerConsultant:async()=>{downstreamCalls+=1;},
  };
  const prepared=await prepareOwnerTurn({payload:{text:'kasih saran laptop 10 jutaan'},snapshot:{orderState:{}},db:null,llm});
  assert.equal(prepared.route,'OUT_OF_SCOPE');
  assert.equal(prepared.replyText,OWNER_OUT_OF_SCOPE_REPLY);
  assert.equal(downstreamCalls,0);
});

function stateDb(initialState={}) {
  let state=structuredClone(initialState);
  let mutations=0;
  const db=async(strings,...values)=>{
    const query=strings.join('?');
    if (/select order_state from conversation_order_states/.test(query)) return [{order_state:structuredClone(state)}];
    if (/insert into conversation_order_states/.test(query)) {
      const serialized=values.find(value=>typeof value==='string'&&value.startsWith('{'));
      if (serialized) state=JSON.parse(serialized);
      return [];
    }
    if (/from orders o join customers/.test(query)) return [{id:'order-id',order_number:17,status:'ACCEPTED',customer_phone:'6281',payment_status:'UNPAID',proof_received_at:null}];
    if (/select cancel_order/.test(query)) { mutations+=1; return [{id:'order-id'}]; }
    throw new Error(`Unexpected SQL in test: ${query}`);
  };
  db.json=value=>JSON.stringify(value);
  return {db,get state(){return state;},get mutations(){return mutations;}};
}

test('write command persists for five minutes and exact N aborts without mutation',async()=>{
  const fake=stateDb();
  const prepared={ownerMode:'WRITE_COMMAND',command:parseOwnerCommand('/order batal 17')};
  const pending=await handleOwnerTurn(fake.db,{phone:'6285175403169',waMessageId:'wa-1'},'m1',prepared);
  assert.equal(pending.replyText,'Eksekusi command ini? /order batal 17 (Balas Y/N)');
  assert.equal(fake.state.pending_owner_command.status,'PENDING');
  const ttl=new Date(fake.state.pending_owner_command.expires_at)-new Date(fake.state.pending_owner_command.created_at);
  assert.equal(ttl,300000);
  const cancelled=await handleOwnerTurn(fake.db,{phone:'6285175403169'},'m2',{ownerMode:'CONFIRMATION',confirmation:'N'});
  assert.equal(cancelled.replyText,'Command dibatalkan.');
  assert.equal(fake.mutations,0);
  assert.equal(fake.state.pending_owner_command,undefined);
});

test('exact Y executes once and replay cannot duplicate mutation',async()=>{
  const fake=stateDb({pending_owner_command:{command:'/order batal 17',kind:'WRITE',source_message_id:'wa-1',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+300000).toISOString(),status:'PENDING'}});
  const first=await handleOwnerTurn(fake.db,{phone:'6285175403169'},'m2',{ownerMode:'CONFIRMATION',confirmation:'Y'});
  assert.match(first.replyText,/dibatalkan/);
  assert.equal(fake.mutations,1);
  const replay=await handleOwnerTurn(fake.db,{phone:'6285175403169'},'m3',{ownerMode:'CONFIRMATION',confirmation:'Y'});
  assert.match(replay.replyText,/Tidak ada command/);
  assert.equal(fake.mutations,1);
});

test('owner integration no longer sends owner messages through monolithic parser',async()=>{
  const source=await readFile(new URL('../services/chatbot/orchestrator.js',import.meta.url),'utf8');
  const prepare=source.slice(source.indexOf('async function prepareChatTurn'),source.indexOf('async function handleCustomer'));
  const ownerBranch=prepare.slice(prepare.indexOf('if (isOwnerPhone(phone))'),prepare.indexOf('const saved='));
  assert.match(ownerBranch,/prepareOwnerTurn/);
  assert.doesNotMatch(ownerBranch,/parseWithGroq|ownerFallback/);
  assert.match(prepare,/if \(isOwnerPhone\(phone\)\)[\s\S]*prepareOwnerTurn/);
  assert.match(source,/handleOwnerTurn\(db,payload,registration\.messageId,prepared\)/);
  assert.equal(OWNER_AI_FALLBACK,'Sistem AI lagi sibuk. Pakai /help untuk melihat command manual.');
});
