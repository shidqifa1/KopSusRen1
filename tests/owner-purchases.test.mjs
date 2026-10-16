import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePurchase,formatPurchase,executePurchase } from '../services/owner/purchases.js';
import { prepareOwnerTurn,handleOwnerTurn } from '../services/owner/pipeline.js';
const catalog={ingredients:[{id:'milk',name:'Susu UHT',unit:'ML'},{id:'coffee',name:'Kopi',unit:'G'},{id:'ice',name:'Es Batu',unit:'G'}],accounts:[{id:'cash',name:'Cash'}]};
const draft={intent:'PURCHASE',account_id:'cash',questions:[],items:[
 {ingredient_id:'milk',brand:'Milk Life',quantity:1000,count:12,unit:'ML',total_cost:270000,approximate:false},
 {ingredient_id:'coffee',brand:'Limas',quantity:1,count:1,unit:'KG',total_cost:89000,approximate:false},
 {ingredient_id:'ice',brand:null,quantity:15,count:1,unit:'KG',total_cost:25000,approximate:true}]};
test('purchase arithmetic converts packages and kilograms and exposes approximate stock',()=>{
 const result=validatePurchase(draft,catalog);
 assert.deepEqual(result.lines.map(x=>x.quantity),[12000,1000,15000]);
 assert.equal(result.total,384000);
 assert.match(formatPurchase(result),/384\.000/);
 assert.match(formatPurchase(result),/perkiraan/);
});
test('purchase refuses unknown catalog, missing account, negative and invalid model output',()=>{
 assert.ok(validatePurchase({...draft,account_id:null},catalog).questions.length);
 assert.throws(()=>validatePurchase({...draft,items:[{...draft.items[0],ingredient_id:'invented'}]},catalog));
 assert.throws(()=>validatePurchase({...draft,items:[{...draft.items[0],quantity:-1}]},catalog));
 assert.throws(()=>validatePurchase({...draft,extra:'sql'},catalog));
});
test('purchase preparation reads only and clarification never confirms',async()=>{
 const db=async strings=>strings.join('').includes('from ingredients')?catalog.ingredients:catalog.accounts;
 const llm={OwnerPurchaseExtractor:async()=>({...draft,account_id:null,questions:['Es sudah dibeli?']})};
 const prepared=await prepareOwnerTurn({payload:{text:'gua beli susu dan es'},snapshot:{orderState:{}},db,llm});
 assert.equal(prepared.ownerMode,'PURCHASE_DRAFT');
 assert.ok(prepared.purchase.questions.length>=2);
 let state={};const stateDb=async(strings,...values)=>{
 if(strings.join('').includes('from ingredients'))return catalog.ingredients;
 if(strings.join('').includes('from accounts'))return catalog.accounts;
 if(strings.join('').includes('select order_state')) return [{order_state:state}];
 if(strings.join('').includes('insert into conversation_order_states')) {state=values.find(x=>x&&typeof x==='object');return [];}
 throw Error('No business mutation allowed');};stateDb.json=x=>x;
 await handleOwnerTurn(stateDb,{phone:'6281',text:'beli susu'},'m1',prepared);
 const result=await handleOwnerTurn(stateDb,{phone:'6281'},'m2',{ownerMode:'CONFIRMATION',confirmation:'Y'});
 assert.match(result.replyText,/lengkapi/i);
});
test('purchase writes all lines within savepoint and replays return existing id',async()=>{
 let queries=[];let saved=false;
 const db=async(strings,...values)=>{const q=strings.join('?');queries.push(q);
 if(q.includes('from ingredients'))return catalog.ingredients;
 if(q.includes('from accounts'))return catalog.accounts;
 if(q.includes('select id from purchases'))return saved?[{id:'p1'}]:[];
 if(q.includes('insert into purchases')){saved=true;return [{id:'p1'}];}
 return [];};db.json=x=>x;let savepoints=0;db.savepoint=async cb=>{savepoints++;return cb(db);};
 await executePurchase(db,draft,'key');
 assert.equal(queries.filter(q=>q.includes('insert into purchase_items')).length,3);
 assert.equal(queries.filter(q=>q.includes('insert into ledger_entries')).length,1);
 await executePurchase(db,draft,'key');
 assert.equal(queries.filter(q=>q.includes('insert into purchase_items')).length,3);
 assert.equal(savepoints,2);
});

test('extractor receives catalog and previous draft; malformed output fails closed',async()=>{
 const {createOwnerLlm}=await import('../services/owner/llm.js');
 let call;
 const client={chat:{completions:{create:async body=>{call=body;return {choices:[{message:{content:JSON.stringify({...draft,account_id:'cash'})}}]};}}}};
 const llm=createOwnerLlm({client});
 const result=await llm.ownerPurchaseExtractor('pakai Cash',catalog,{...draft,account_id:null});
 assert.equal(result.account_id,'cash');
 assert.match(call.messages[1].content,/previous/);
 assert.match(call.messages[0].content,/ga dah beli/);
 const db=async strings=>strings.join('').includes('from ingredients')?catalog.ingredients:catalog.accounts;
 const prepared=await prepareOwnerTurn({payload:{text:'beli susu'},snapshot:{orderState:{}},db,llm:{OwnerPurchaseExtractor:async()=>({...draft,extra:true})}});
 assert.equal(prepared.ownerMode,'DIRECT_REPLY');
 assert.match(prepared.replyText,/belanja tidak valid/i);
});
test('N cancels purchase and expired Y never writes business data',async()=>{
 for(const [answer,expires] of [['N',Date.now()+300000],['Y',Date.now()-1]]){
  let state={pending_owner_command:{kind:'PURCHASE',draft,expires_at:new Date(expires).toISOString(),status:'PENDING'}};
  const db=async(strings,...values)=>{
   if(strings.join('').includes('select order_state'))return [{order_state:state}];
   if(strings.join('').includes('insert into conversation_order_states')){state=values.find(x=>x&&typeof x==='object');return [];}
   throw Error('Business SQL forbidden');};db.json=x=>x;
  const result=await handleOwnerTurn(db,{phone:'6281'},'m1',{ownerMode:'CONFIRMATION',confirmation:answer});
  assert.match(result.replyText,answer==='N'?/dibatalkan/:/kedaluwarsa/);
  assert.equal(state.pending_owner_command,undefined);
 }
});
test('ambiguous negation always asks even if extractor overlooks it',async()=>{
 const db=async strings=>strings.join('').includes('from ingredients')?catalog.ingredients:catalog.accounts;
 const prepared=await prepareOwnerTurn({payload:{text:'sama ga dah beli esbatu 15kg 25k'},snapshot:{orderState:{}},db,llm:{OwnerPurchaseExtractor:async()=>structuredClone(draft)}});
 assert.match(prepared.purchase.questions.join(' '),/sudah dibeli/);
});
test('savepoint rolls every business write back when ledger fails',async()=>{
 let writes=[];
 const db=async(strings)=>{const q=strings.join('?');
  if(q.includes('from ingredients'))return catalog.ingredients;
  if(q.includes('from accounts'))return catalog.accounts;
  if(q.includes('select id from purchases'))return [];
  if(q.includes('insert into ledger_entries'))throw Error('ledger unavailable');
  writes.push(q);return q.includes('insert into purchases')?[{id:'p1'}]:[];};db.json=x=>x;
 db.savepoint=async cb=>{const before=[...writes];try{return await cb(db);}catch(e){writes=before;throw e;}};
 await assert.rejects(()=>executePurchase(db,draft,'fail-key'),/ledger unavailable/);
 assert.deepEqual(writes,[]);
});

test('dummy evaluator rejects plausible but wrong totals and silent writes on incomplete input',async()=>{
 const {scorePurchaseTurn}=await import('../evals/run-owner-purchases.mjs');
 const expected={intent:'PURCHASE',ready:true,account_id:'cash',total:384000,lines:[
  {ingredient_id:'milk',quantity:12000,total_cost:270000},
  {ingredient_id:'coffee',quantity:1000,total_cost:89000},
  {ingredient_id:'ice',quantity:15000,total_cost:25000,approximate:true}]};
 assert.deepEqual(scorePurchaseTurn(draft,catalog,expected),[]);
 assert.ok(scorePurchaseTurn({...draft,items:[{...draft.items[0],total_cost:27000},...draft.items.slice(1)]},catalog,expected).length);
 assert.ok(scorePurchaseTurn(draft,catalog,{intent:'PURCHASE',ready:false}).length);
 assert.ok(scorePurchaseTurn({...draft,intent:'OTHER'},catalog,expected).length);
});

test('Groq extraction validates schema before returning data to its caller',async()=>{
 const {createOwnerLlm}=await import('../services/owner/llm.js');
 const client={chat:{completions:{create:async()=>({choices:[{message:{content:JSON.stringify({...draft,execute_sql:'DROP TABLE purchases'})}}]})}}};
 await assert.rejects(()=>createOwnerLlm({client}).ownerPurchaseExtractor('beli susu',catalog),/belanja tidak valid/);
});

test('extraction API itself blocks ambiguous negation even if Groq omits questions',async()=>{
 const {createOwnerLlm}=await import('../services/owner/llm.js');
 const client={chat:{completions:{create:async()=>({choices:[{message:{content:JSON.stringify(draft)}}]})}}};
 const extracted=await createOwnerLlm({client}).ownerPurchaseExtractor('sama ga dah beli es 15kg 25k',catalog);
 assert.ok(validatePurchase(extracted,catalog).questions.length);
});

test('unit price extraction cannot silently become a confirmed line total',async()=>{
 const {createOwnerLlm}=await import('../services/owner/llm.js');
 const client={chat:{completions:{create:async()=>({choices:[{message:{content:JSON.stringify(draft)}}]})}}};
 const extracted=await createOwnerLlm({client}).ownerPurchaseExtractor('beli susu 1L x12 harga per kotak 22500 bayar Cash',catalog);
 assert.ok(validatePurchase(extracted,catalog).questions.length);
});

test('explicit whole-message negation cannot create a purchase without previous draft',async()=>{
 const {createOwnerLlm}=await import('../services/owner/llm.js');
 const client={chat:{completions:{create:async()=>({choices:[{message:{content:JSON.stringify(draft)}}]})}}};
 const extracted=await createOwnerLlm({client}).ownerPurchaseExtractor('gua nggak jadi beli susu 1L 22rb',catalog);
 assert.equal(extracted.intent,'OTHER');
 assert.deepEqual(extracted.items,[]);
});
