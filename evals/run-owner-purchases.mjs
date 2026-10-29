// Groq extracts JSON only. This harness never gives it a database connection or tool.
// Run: node --env-file=.env.local evals/run-owner-purchases.mjs [--database] [--case=ID]
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {OwnerPurchaseExtractor} from '../services/owner/llm.js';
import {validatePurchase} from '../services/owner/purchases.js';
import {prepareOwnerTurn,handleOwnerTurn} from '../services/owner/pipeline.js';

export function scorePurchaseTurn(draft,catalog,expected) {
  const errors=[];
  try {
    const actual=validatePurchase(draft,catalog);
    if(draft.intent!==expected.intent)errors.push(`intent ${draft.intent}, expected ${expected.intent}`);
    const ready=draft.intent==='PURCHASE'&&actual.questions.length===0;
    if(ready!==expected.ready)errors.push(`ready ${ready}, expected ${expected.ready}`);
    if(Object.hasOwn(expected,'account_id')&&draft.account_id!==expected.account_id)errors.push('account mismatch');
    if(Object.hasOwn(expected,'total')&&actual.total!==expected.total)errors.push(`total ${actual.total}, expected ${expected.total}`);
    if(expected.lines){
      if(actual.lines.length!==expected.lines.length)errors.push('line count mismatch');
      const remaining=[...actual.lines];
      for(const line of expected.lines){
        const index=remaining.findIndex(x=>Object.entries(line).every(([key,value])=>key==='brand'
          ?String(x[key]).toLowerCase()===String(value).toLowerCase():x[key]===value));
        if(index<0)errors.push(`line mismatch: ${JSON.stringify(line)}`);else remaining.splice(index,1);
      }
    }
    if(expected.forbidden_ingredients?.some(id=>actual.lines.some(x=>x.ingredient_id===id)))errors.push('invented ingredient mapping');
  }catch(error){errors.push(error.message);}
  return errors;
}

// Scope test reads to synthetic rows, including nested purchase savepoints.
function scopedDb(tx,catalog) {
  const ingredients=catalog.ingredients.map(x=>x.id),accounts=catalog.accounts.map(x=>x.id);
  const db=async(strings,...values)=>{
    const query=strings.join('?');
    if(/from inventory_stock order by name/.test(query))return tx`select name,unit,available_stock::float8 available_stock,low_stock_threshold::float8 threshold from inventory_stock where ingredient_id=any(${ingredients}::uuid[]) order by name`;
    const rows=await tx(strings,...values);
    if(/from ingredients where is_active/.test(query))return rows.filter(x=>ingredients.includes(x.id));
    if(/from accounts where is_active/.test(query))return rows.filter(x=>accounts.includes(x.id));
    return rows;
  };
  db.json=value=>tx.json(value);
  db.savepoint=cb=>tx.savepoint(sp=>cb(scopedDb(sp,catalog)));
  return db;
}

export async function checkDatabase(dataset,results) {
  if(process.env.APP_ENV!=='development')throw Error('--database hanya untuk APP_ENV=development');
  const {default:postgres}=await import('postgres');
  const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1,connect_timeout:10});
  const run=randomUUID(),prefix=`dummy-purchase-${run}`;
  // Fresh random IDs isolate concurrent runs and avoid touching existing records.
  const mapping=new Map([...dataset.catalog.ingredients,...dataset.catalog.accounts].map(x=>[x.id,randomUUID()]));
  const remap=value=>JSON.parse(JSON.stringify(value).replace(/d[12]000000-0000-4000-8000-00000000000[1-4]/g,id=>mapping.get(id)||id));
  const data=remap(dataset),records=remap(results);
  const rolledBack=new Error('EXPECTED_DUMMY_ROLLBACK');
  let confirmed=0;
  try {
    try {await sql.begin(async tx=>{
      await tx`set local statement_timeout='15s'`;
      await tx`set local lock_timeout='5s'`;
      for(const ingredient of data.catalog.ingredients){
        await tx`insert into ingredients(id,code,name,unit) values(${ingredient.id},${prefix+ingredient.id},${ingredient.name},${ingredient.unit})`;
        await tx`insert into inventory_movements(ingredient_id,quantity_delta,movement_type,note) values(${ingredient.id},${data.initial_stock[ingredient.id]},'OPENING_BALANCE',${prefix})`;
      }
      for(const account of data.catalog.accounts){
        await tx`insert into accounts(id,name,type) values(${account.id},${`${account.name} ${run}`},'OTHER')`;
        await tx`insert into ledger_entries(account_id,amount,entry_type,description) values(${account.id},${data.initial_balance},'OPENING_BALANCE',${prefix})`;
      }
      const db=scopedDb(tx,data.catalog);
      const expectedStock={...data.initial_stock};
      const expectedBalance=Object.fromEntries(data.catalog.accounts.map(x=>[x.id,data.initial_balance]));
      for(let i=0;i<records.length;i++){
        const record=records[i];
        console.log(`DB_CHECK ${record.id}`);
        if(!record.turns.every(x=>x.errors.length===0))continue;
        const testCase=data.cases.find(x=>x.id===record.id);
        if(testCase.turns.at(-1).expected.intent!=='PURCHASE')continue;
        const phone=`628000${Date.now()}${i}`;
        for(let j=0;j<record.turns.length;j++){
          const turn=record.turns[j];
          const [row]=await tx`select order_state from conversation_order_states where channel='whatsapp' and customer_phone=${phone}`;
          const payload={phone,text:testCase.turns[j].text,waMessageId:`${prefix}-${i}-${j}`};
          const prepared=await prepareOwnerTurn({payload,snapshot:{orderState:row?.order_state||{}},db,llm:{OwnerPurchaseExtractor:async()=>turn.draft}});
          assert.equal(prepared.ownerMode,'PURCHASE_DRAFT');
          await handleOwnerTurn(db,payload,payload.waMessageId,prepared);
        }
        const last=record.turns.at(-1),purchase=validatePurchase(last.draft,data.catalog);
        const before=await tx`select count(*)::int count from purchases where account_id=any(${data.catalog.accounts.map(x=>x.id)}::uuid[])`;
        assert.equal(before[0].count,confirmed,'draft must never write a purchase');
        const response=await handleOwnerTurn(db,{phone},`${prefix}-confirm-${i}`,{ownerMode:'CONFIRMATION',confirmation:'Y'});
        if(last.expected.ready){
          assert.match(response.replyText,/tercatat/);confirmed++;
          for(const line of purchase.lines)expectedStock[line.ingredient_id]+=line.quantity;
          expectedBalance[purchase.account.id]-=purchase.total;
          const replay=await handleOwnerTurn(db,{phone},`${prefix}-replay-${i}`,{ownerMode:'CONFIRMATION',confirmation:'Y'});
          assert.match(replay.replyText,/Tidak ada command/);
        }else{
          assert.match(response.replyText,/Lengkapi/);
          await handleOwnerTurn(db,{phone},`${prefix}-cancel-${i}`,{ownerMode:'CONFIRMATION',confirmation:'N'});
        }
      }
      for(const ingredient of data.catalog.ingredients){
        const [stock]=await tx`select physical_stock,available_stock from inventory_stock where ingredient_id=${ingredient.id}`;
        assert.equal(Number(stock.physical_stock),expectedStock[ingredient.id]);
        assert.equal(Number(stock.available_stock),expectedStock[ingredient.id]);
      }
      for(const account of data.catalog.accounts){
        const [balance]=await tx`select balance from account_balances where account_id=${account.id}`;
        assert.equal(Number(balance.balance),expectedBalance[account.id]);
      }
      const phone=`628000${Date.now()}999`;
      const read=await prepareOwnerTurn({payload:{phone,text:'/stok list'},snapshot:{orderState:{}},db});
      assert.equal(read.ownerMode,'READ_RESULT');
      assert.equal(read.result.data.length,data.catalog.ingredients.length);
      assert.ok(read.replyText.includes('Susu UHT'));
      const [ledger]=await tx`select count(*)::int count from ledger_entries where account_id=any(${data.catalog.accounts.map(x=>x.id)}::uuid[]) and entry_type='EXPENSE'`;
      assert.equal(ledger.count,confirmed);
      const complete=records.find(x=>x.turns.at(-1).expected.ready&&x.turns.every(t=>!t.errors.length));
      if(complete){
        const {executePurchase}=await import('../services/owner/purchases.js');
        const failing=Object.assign((...args)=>db(...args),{json:db.json,savepoint:cb=>db.savepoint(sp=>cb(Object.assign(
          (strings,...values)=>{if(strings.join('').includes('insert into ledger_entries'))throw Error('INJECTED_LEDGER_FAILURE');return sp(strings,...values);},{json:sp.json})))});
        await assert.rejects(()=>executePurchase(failing,complete.turns.at(-1).draft,`${prefix}-failure`),/INJECTED_LEDGER_FAILURE/);
        assert.equal((await tx`select id from purchases where idempotency_key=${prefix+'-failure'}`).length,0);
      }
      throw rolledBack;
    });}catch(error){if(error!==rolledBack)throw error;}
    const leftovers=await sql`select id from ingredients where id=any(${data.catalog.ingredients.map(x=>x.id)}::uuid[])`;
    assert.equal(leftovers.length,0);
    return {passed:true,confirmed,rolledBack:true,checks:['draft before Y','incomplete Y blocked','replay blocked','stock view','account balances','owner stock read','ledger once','failure savepoint rollback','dummy rows rolled back']};
  }finally{await sql.end({timeout:3});}
}

async function main(){
  const args=new Map(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
  const dataset=JSON.parse(await readFile(new URL('./owner-purchase-cases.json',import.meta.url),'utf8'));
  if(args.has('case'))dataset.cases=dataset.cases.filter(x=>args.get('case').split(',').includes(x.id));
  if(!dataset.cases.length)throw Error('Case tidak ditemukan');
  const results=[];
  const output=args.get('output')||'/tmp/kopsusren-owner-purchase-report.json';
  for(const testCase of dataset.cases){
    let previous=null;const turns=[];
    for(const turn of testCase.turns){
      const started=Date.now();let draft=null,errors=[];
      let providerFailure=null;
      for(let attempt=1;attempt<=3;attempt++){
        try{draft=await OwnerPurchaseExtractor(turn.text,dataset.catalog,previous);break;}
        catch(error){
          providerFailure=error.status||error.name||'Error';
          if(error.status!==429||attempt===3)break;
          const retryAfter=Number(error.headers?.get?.('retry-after')||0);
          const delay=Math.min(60000,Math.max(15000,Number.isFinite(retryAfter)?retryAfter*1000:0));
          console.log(`RATE_LIMIT ${testCase.id}: wait ${delay}ms (attempt ${attempt}/3)`);
          await new Promise(resolve=>setTimeout(resolve,delay));
        }
      }
      if(draft){errors=scorePurchaseTurn(draft,dataset.catalog,turn.expected);if(draft.intent==='PURCHASE')previous=draft;}
      else errors=[`Extraction failed: ${providerFailure}`];
      const result={text:turn.text,expected:turn.expected,draft,errors,latencyMs:Date.now()-started};turns.push(result);
      console.log(`${errors.length?'FAIL':'PASS'} ${testCase.id}/${turns.length}${errors.length?`: ${errors.join('; ')}`:''}`);
      await new Promise(resolve=>setTimeout(resolve,6000));
    }
    results.push({id:testCase.id,turns});
    await writeFile(output,JSON.stringify({provider:'groq',partial:true,results},null,2),{mode:0o600});
  }
  const total=results.flatMap(x=>x.turns),failed=total.filter(x=>x.errors.length).length;
  const report={provider:'groq',datasetVersion:dataset.version,cases:results.length,turns:total.length,passed:total.length-failed,failed,results};
  await writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
  if(args.has('database'))report.database=await checkDatabase(dataset,results);
  await writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({cases:report.cases,turns:report.turns,passed:report.passed,failed:report.failed,database:report.database,report:output}));
  if(failed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
