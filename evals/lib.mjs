import { readFile,writeFile } from 'node:fs/promises';
import { applyParserAmbiguities,applyStructuredPatch,classifyDraftSafety,deterministicCustomerTurn,emptyDraft,sanitizeCustomerParsedResult } from '../services/chatbot/conversation.js';
import { parseWithGroq,safeParserError } from '../services/parser/groqOrderParser.js';

const VALID_SAFETY=new Set(['SAFE','NEEDS_CLARIFICATION','OWNER_HANDOFF']);
const ORDER_ACTIONS=new Set(['START_ORDER','ADD_ITEM','REMOVE_ITEM','UPDATE_ITEM','CONFIRM_ORDER']);
const sort=value=>[...(value||[])].sort();
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ratio=(passed,total)=>total?passed/total:0;
const average=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
const percentile=(values,p)=>values.length?values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:0;

export function validateDataset(data) {
  if (!data||typeof data!=='object'||!Number.isInteger(data.version)||!Array.isArray(data.products)||!Array.isArray(data.cases)) throw new Error('Dataset wajib memiliki version, products, dan cases');
  if (data.cases.length<1) throw new Error('Dataset tidak boleh kosong');
  const productCodes=new Set(data.products.map(product=>product.code));
  const ids=new Set();
  for (const entry of data.cases) {
    if (!entry.id||ids.has(entry.id)) throw new Error(`Case id hilang/duplikat: ${entry.id||'-'}`);
    ids.add(entry.id);
    if (!entry.category||!Array.isArray(entry.turns)||!entry.turns.length) throw new Error(`Case ${entry.id} tidak memiliki category/turns`);
    for (const [index,turn] of entry.turns.entries()) {
      if (typeof turn.input!=='string'||!turn.input.trim()||!turn.expected) throw new Error(`Case ${entry.id} turn ${index+1} malformed`);
      if (!Array.isArray(turn.expected.intents)||typeof turn.expected.ambiguous!=='boolean'||typeof turn.expected.orderLike!=='boolean') throw new Error(`Expected case ${entry.id} turn ${index+1} tidak lengkap`);
      if (turn.expected.safety&&!VALID_SAFETY.has(turn.expected.safety)) throw new Error(`Safety tidak valid pada ${entry.id}`);
      for (const item of turn.expected.items||[]) if (!productCodes.has(item.productCode)||!Number.isInteger(item.quantity)||item.quantity<1) throw new Error(`Item ground truth tidak valid pada ${entry.id}`);
    }
  }
  return data;
}

export async function loadDataset(path) { return validateDataset(JSON.parse(await readFile(path,'utf8'))); }

function menuFromDataset(data) {
  return data.products.map(product=>({id:`eval:${product.code}`,code:product.code,name:product.name,price:product.price||0,is_active:true,chatbot_metadata:{aliases:product.aliases||[],tags:product.tags||[]}}));
}

function actualItems(draft,menu) {
  return (draft.items||[]).map(item=>({
    productCode:menu.find(product=>product.id===item.productId)?.code||'UNRESOLVED',
    quantity:Number.isInteger(item.quantity)?Number(item.quantity):null,modifiers:sort(item.modifiers),
  })).sort((a,b)=>`${a.productCode}:${a.modifiers}`.localeCompare(`${b.productCode}:${b.modifiers}`));
}

function expectedItems(expected) {
  return (expected.items||[]).map(item=>({productCode:item.productCode,quantity:item.quantity,modifiers:sort(item.modifiers)}))
    .sort((a,b)=>`${a.productCode}:${a.modifiers}`.localeCompare(`${b.productCode}:${b.modifiers}`));
}

function semanticIntents(values) {
  const intents=new Set(values||[]);
  if ([...intents].some(intent=>['ADD_ITEM','REMOVE_ITEM','UPDATE_ITEM'].includes(intent))) intents.delete('START_ORDER');
  return [...intents].sort();
}

export function compareGroundTruth(expected,actual) {
  const wanted=expectedItems(expected);
  const got=actual.items;
  const productsCorrect=equal(wanted.map(item=>item.productCode),got.map(item=>item.productCode));
  const quantitiesCorrect=productsCorrect&&equal(wanted.map(item=>item.quantity),got.map(item=>item.quantity));
  const modifiersCorrect=productsCorrect&&equal(wanted.map(item=>item.modifiers),got.map(item=>item.modifiers));
  const independentQuantityCorrect=equal(wanted.map(item=>item.quantity).sort((a,b)=>a-b),got.map(item=>item.quantity).sort((a,b)=>(a??-1)-(b??-1)));
  const independentModifierCorrect=equal(wanted.map(item=>item.modifiers).sort(),got.map(item=>item.modifiers).sort());
  const exactCartCorrect=equal(wanted,got);
  const intentCorrect=equal(sort(expected.intents),sort(actual.intents));
  const semanticIntentCorrect=equal(semanticIntents(expected.intents),semanticIntents(actual.intents));
  const ambiguityCorrect=Boolean(expected.ambiguous)===Boolean(actual.ambiguous);
  const materialCorrect=exactCartCorrect&&ambiguityCorrect;
  const completeCorrect=!expected.complete||(materialCorrect&&actual.safety==='SAFE');
  const parserLevelFalseOrder=expected.orderLike===false&&(actual.items.length>0||(actual.intents||[]).some(intent=>ORDER_ACTIONS.has(intent)));
  const falseOrder=parserLevelFalseOrder&&actual.wouldBeSafe;
  const severity=materialCorrect&&!falseOrder?(intentCorrect?'PASS':'HARMLESS'):(actual.safety==='SAFE'?'CRITICAL':'RECOVERABLE');
  return {intentCorrect,semanticIntentCorrect,productsCorrect,quantitiesCorrect,modifiersCorrect,independentQuantityCorrect,independentModifierCorrect,exactCartCorrect,ambiguityCorrect,materialCorrect,completeCorrect,parserLevelFalseOrder,falseOrder,severity};
}

function sanitizedParserOutput(parsed) {
  if (!parsed) return null;
  return {
    intents:[...(parsed.intents||[])],entities:{
      name:parsed.entities?.name?'[present]':null,class_name:parsed.entities?.class_name?'[present]':null,
      payment_method:parsed.entities?.payment_method||null,
      item_operations:(parsed.entities?.item_operations||[]).map(operation=>({
        action:operation.action,product_query:String(operation.product_query||'').slice(0,80),quantity:operation.quantity??null,
        modifiers:[...(operation.modifiers||[])],notes:operation.notes?String(operation.notes).slice(0,120):null,
      })),confirmation:parsed.entities?.confirmation??null,
    },
    needs_clarification:Boolean(parsed.needs_clarification),ambiguities:[...(parsed.ambiguities||[])],confidence:Number(parsed.confidence||0),
  };
}

async function parseTurn({input,draft,menu,provider,history,parser,configuredModel,beforeNetwork,evaluationPolicy}) {
  const started=performance.now();
  const fast=deterministicCustomerTurn(input,draft,menu);
  if (fast) return {parsed:fast,latencyMs:performance.now()-started,parserSuccess:true,parserPath:'DETERMINISTIC_FAST_PATH',configuredModel:'deterministic-fast-path',actualModel:'deterministic-fast-path',parserError:null};
  if (provider!=='groq') return {parsed:null,latencyMs:performance.now()-started,parserSuccess:false,parserPath:'DETERMINISTIC_FAST_PATH',configuredModel:'deterministic-fast-path',actualModel:null,parserError:{category:'NO_DETERMINISTIC_MATCH',httpStatus:null,message:'No deterministic fast-path match'}};
  try {
    await beforeNetwork?.();
    const parsed=await parser({text:input,currentOrder:draft,menu,role:'CUSTOMER',pendingQuestion:draft.pending_question,history,evaluationPolicy});
    const diagnostics=parsed?._diagnostics||{};
    return {parsed,latencyMs:performance.now()-started,parserSuccess:Boolean(parsed),parserPath:diagnostics.parserPath||'NETWORK_PARSER',configuredModel:diagnostics.configuredModel||configuredModel,actualModel:diagnostics.actualModel||parsed?._model||null,
      networkAttempts:diagnostics.attempts||[],totalBackoffMs:Number(diagnostics.totalBackoffMs||0),parserError:parsed?null:{category:'EMPTY_RESPONSE',httpStatus:null,message:'Parser returned no result'}};
  } catch(error) {
    const safe=safeParserError(error);
    return {parsed:null,latencyMs:performance.now()-started,parserSuccess:false,parserPath:safe.parserPath||'NETWORK_PARSER',configuredModel:safe.configuredModel||configuredModel,actualModel:safe.actualModel||null,
      networkAttempts:safe.attempts||[],totalBackoffMs:Number(safe.totalBackoffMs||0),parserError:{category:safe.category,httpStatus:safe.httpStatus,message:safe.message}};
  }
}

export async function evaluateDataset(data,{provider='deterministic',parser=parseWithGroq,configuredModel=process.env.GROQ_MODEL||'openai/gpt-oss-120b',pacingMs=0,retryPolicy=null,sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  validateDataset(data);
  const menu=menuFromDataset(data);
  const results=[];
  let networkTurnsStarted=0;
  for (const entry of data.cases) {
    let draft=emptyDraft('eval-po');
    const history=[];
    let upstreamParserFailure=false;
    for (const [turnIndex,turn] of entry.turns.entries()) {
      const beforeNetwork=async()=>{
        if (networkTurnsStarted>0&&pacingMs>0) await sleep(pacingMs);
        networkTurnsStarted+=1;
      };
      const parsedTurn=await parseTurn({input:turn.input,draft,menu,provider,history,parser,configuredModel,beforeNetwork,evaluationPolicy:retryPolicy});
      const parserFailure=!parsedTurn.parserSuccess;
      const rawParsed=parsedTurn.parsed;
      const parsed=sanitizeCustomerParsedResult(turn.input,draft,rawParsed);
      let patch={draft,unresolved:[],ambiguous:[],invalidModifiers:[]};
      if (parsed) patch=applyParserAmbiguities(applyStructuredPatch(draft,parsed,menu),parsed);
      const safety=classifyDraftSafety(patch.draft,{...patch,parserFailed:parserFailure});
      draft=safety.draft;
      const actual={
        intents:parsed?.intents||[],items:actualItems(draft,menu),
        ambiguous:Boolean((patch.ambiguous||[]).length||(patch.unresolved||[]).length||(patch.invalidModifiers||[]).length||safety.missing.includes('quantity')),
        safety:safety.classification,wouldBeSafe:safety.classification==='SAFE'&&!safety.issues.length,
      };
      const comparison=compareGroundTruth(turn.expected,actual);
      const cascadingFailure=upstreamParserFailure&&!parserFailure&&!comparison.materialCorrect;
      const networkAttempts=(parsedTurn.networkAttempts||[]).map(attempt=>({caseId:entry.id,turn:turnIndex+1,configuredModel,...attempt}));
      results.push({caseId:entry.id,category:entry.category,caseTurnCount:entry.turns.length,turn:turnIndex+1,input:turn.input,expected:turn.expected,actual,comparison,
        latencyMs:parsedTurn.latencyMs,parserSuccess:parsedTurn.parserSuccess,parserFailure,parserPath:parsedTurn.parserPath,
        configuredModel:parsedTurn.configuredModel,actualModel:parsedTurn.actualModel,parserError:parsedTurn.parserError,
        networkAttempts,totalBackoffMs:parsedTurn.totalBackoffMs||0,parserOutput:sanitizedParserOutput(rawParsed),appliedParserOutput:sanitizedParserOutput(parsed),upstreamParserFailure,cascadingFailure});
      if (parserFailure) upstreamParserFailure=true;
      history.push({role:'user',content:turn.input});
    }
  }
  return buildReport(data,results,{provider,model:provider==='groq'?configuredModel:'deterministic-fast-path'});
}

function coreMetrics(results) {
  const count=results.length;
  const itemCases=results.filter(row=>(row.expected.items||[]).length);
  const ambiguous=results.filter(row=>row.expected.ambiguous);
  const nonOrders=results.filter(row=>!row.expected.orderLike);
  const complete=results.filter(row=>row.expected.complete);
  return {
    rawExactIntentAccuracy:ratio(results.filter(row=>row.comparison.intentCorrect).length,count),semanticActionIntentAccuracy:ratio(results.filter(row=>row.comparison.semanticIntentCorrect).length,count),
    independentProductAccuracy:ratio(itemCases.filter(row=>row.comparison.productsCorrect).length,itemCases.length),independentQuantityAccuracy:ratio(itemCases.filter(row=>row.comparison.independentQuantityCorrect).length,itemCases.length),
    independentModifierAccuracy:ratio(itemCases.filter(row=>row.comparison.independentModifierCorrect).length,itemCases.length),exactCartAccuracy:ratio(itemCases.filter(row=>row.comparison.exactCartCorrect).length,itemCases.length),
    ambiguityDetection:ratio(ambiguous.filter(row=>row.actual.ambiguous).length,ambiguous.length),parserLevelFalseOrderRate:ratio(nonOrders.filter(row=>row.comparison.parserLevelFalseOrder).length,nonOrders.length),
    commitSafeFalseOrderRate:ratio(nonOrders.filter(row=>row.comparison.falseOrder).length,nonOrders.length),completeOrderAccuracy:ratio(complete.filter(row=>row.comparison.completeCorrect).length,complete.length),
    criticalSilentErrorRate:ratio(results.filter(row=>row.comparison.severity==='CRITICAL').length,count),recoverableErrorRate:ratio(results.filter(row=>row.comparison.severity==='RECOVERABLE').length,count),
  };
}

function completionMetrics(results) {
  const complete=results.filter(row=>row.expected.complete);
  const singleTurn=complete.filter(row=>(row.caseTurnCount||1)===1);
  const multiTurn=complete.filter(row=>(row.caseTurnCount||1)>1);
  const confirmations=results.filter(row=>(row.expected.intents||[]).includes('CONFIRM_ORDER'));
  const network=results.filter(row=>['NETWORK_PARSER','FALLBACK'].includes(row.parserPath));
  const correct=rows=>ratio(rows.filter(row=>row.comparison.materialCorrect&&row.actual.safety==='SAFE').length,rows.length);
  return {
    singleTurnSlotCompleteAccuracy:correct(singleTurn),
    multiTurnDraftCompletionAccuracy:correct(multiTurn),
    explicitConfirmationSuccess:correct(confirmations),
    providerParserAvailability:ratio(network.filter(row=>row.parserSuccess).length,network.length),
    endToEndCompletionAccuracy:correct(complete),
  };
}

export function calculateMetrics(results) {
  const count=results.length;
  const itemCases=results.filter(row=>(row.expected.items||[]).length);
  const ambiguous=results.filter(row=>row.expected.ambiguous);
  const nonOrders=results.filter(row=>!row.expected.orderLike);
  const complete=results.filter(row=>row.expected.complete);
  const latencies=results.map(row=>row.latencyMs);
  const network=results.filter(row=>['NETWORK_PARSER','FALLBACK'].includes(row.parserPath));
  const successfulNetwork=network.filter(row=>row.parserSuccess);
  const failedNetwork=network.filter(row=>!row.parserSuccess);
  const parserSucceeded=results.filter(row=>row.parserSuccess);
  return {
    intentAccuracy:ratio(results.filter(row=>row.comparison.intentCorrect).length,count),productAccuracy:ratio(itemCases.filter(row=>row.comparison.productsCorrect).length,itemCases.length),
    quantityAccuracy:ratio(itemCases.filter(row=>row.comparison.quantitiesCorrect).length,itemCases.length),modifierAccuracy:ratio(itemCases.filter(row=>row.comparison.modifiersCorrect).length,itemCases.length),
    ambiguityDetection:ratio(ambiguous.filter(row=>row.actual.ambiguous).length,ambiguous.length),falseOrderRate:ratio(nonOrders.filter(row=>row.comparison.falseOrder).length,nonOrders.length),
    completeOrderAccuracy:ratio(complete.filter(row=>row.comparison.completeCorrect).length,complete.length),criticalSilentErrorRate:ratio(results.filter(row=>row.comparison.severity==='CRITICAL').length,count),
    recoverableErrorRate:ratio(results.filter(row=>row.comparison.severity==='RECOVERABLE').length,count),averageParserLatencyMs:average(latencies),p95ParserLatencyMs:percentile(latencies,.95),
    parserSuccessRate:ratio(parserSucceeded.length,count),networkParserSuccessRate:ratio(successfulNetwork.length,network.length),
    successfulNetworkAverageLatencyMs:average(successfulNetwork.map(row=>row.latencyMs)),successfulNetworkP95LatencyMs:percentile(successfulNetwork.map(row=>row.latencyMs),.95),
    failedNetworkAverageLatencyMs:average(failedNetwork.map(row=>row.latencyMs)),failedNetworkP95LatencyMs:percentile(failedNetwork.map(row=>row.latencyMs),.95),
    ...coreMetrics(results),...completionMetrics(results),parserSuccessConditional:coreMetrics(parserSucceeded),
  };
}

export function metricDenominators(results) {
  const network=results.filter(row=>['NETWORK_PARSER','FALLBACK'].includes(row.parserPath));
  return {allTurns:results.length,itemBearingTurns:results.filter(row=>(row.expected.items||[]).length).length,expectedAmbiguousTurns:results.filter(row=>row.expected.ambiguous).length,
    expectedNonOrderTurns:results.filter(row=>!row.expected.orderLike).length,expectedCompleteTurns:results.filter(row=>row.expected.complete).length,
    singleTurnExpectedCompleteTurns:results.filter(row=>row.expected.complete&&(row.caseTurnCount||1)===1).length,
    multiTurnExpectedCompleteTurns:results.filter(row=>row.expected.complete&&(row.caseTurnCount||1)>1).length,
    explicitConfirmationTurns:results.filter(row=>(row.expected.intents||[]).includes('CONFIRM_ORDER')).length,
    parserSucceededTurns:results.filter(row=>row.parserSuccess).length,networkParserAttempts:network.length,successfulNetworkTurns:network.filter(row=>row.parserSuccess).length,failedNetworkTurns:network.filter(row=>!row.parserSuccess).length};
}

export function summarizeAttemptTelemetry(results) {
  const logical=results.filter(row=>['NETWORK_PARSER','FALLBACK'].includes(row.parserPath));
  const attempts=results.flatMap(row=>row.networkAttempts||[]);
  const successful=attempts.filter(attempt=>Number(attempt.status)>=200&&Number(attempt.status)<300);
  const byModel=(category)=>Object.fromEntries([...new Set(attempts.map(attempt=>attempt.requestedModel).filter(Boolean))].map(model=>[
    model,attempts.filter(attempt=>attempt.requestedModel===model&&attempt.errorCategory===category).length,
  ]));
  return {
    logicalNetworkTurns:logical.length,
    totalModelAttempts:attempts.length,
    primarySuccessCount:successful.filter(attempt=>!attempt.fallback&&attempt.attempt===1).length,
    retrySuccessCount:successful.filter(attempt=>!attempt.fallback&&attempt.attempt>1).length,
    fallbackSuccessCount:successful.filter(attempt=>attempt.fallbackOccurred??attempt.fallback).length,
    rateLimitCountByModel:byModel('RATE_LIMIT'),
    schemaFailureCountByModel:byModel('SCHEMA_VALIDATION'),
    totalBackoffMs:attempts.reduce((sum,attempt)=>sum+Number(attempt.backoffMs||0),0),
  };
}

export function buildReport(data,results,{provider='deterministic',model='unknown'}={}) {
  const categories={};
  for (const category of new Set(results.map(row=>row.category))) {
    const rows=results.filter(row=>row.category===category);
    categories[category]={caseTurns:rows.length,denominators:metricDenominators(rows),metrics:calculateMetrics(rows)};
  }
  return {timestamp:new Date().toISOString(),provider,model,datasetVersion:data.version,caseCount:data.cases.length,turnCount:results.length,
    attemptSummary:summarizeAttemptTelemetry(results),
    denominators:metricDenominators(results),metrics:calculateMetrics(results),categoryMetrics:categories,parserFailures:results.filter(row=>row.parserFailure),
    cascadingFailures:results.filter(row=>row.cascadingFailure),criticalFailures:results.filter(row=>row.comparison.severity==='CRITICAL'),recoverableFailures:results.filter(row=>row.comparison.severity==='RECOVERABLE'),results};
}

export async function writeJsonReport(path,report) { await writeFile(path,`${JSON.stringify(report,null,2)}\n`); }
