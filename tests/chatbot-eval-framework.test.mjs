import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLabelingExport } from '../evals/export-shadow.mjs';
import { buildReport,calculateMetrics,compareGroundTruth,evaluateDataset,loadDataset,summarizeAttemptTelemetry,validateDataset } from '../evals/lib.mjs';
import { ParserProviderError } from '../services/parser/groqOrderParser.js';

const expected={intents:['ADD_ITEM'],items:[{productCode:'KSGA',quantity:2,modifiers:[]}],ambiguous:false,orderLike:true,complete:true};
const actual={intents:['ADD_ITEM'],items:[{productCode:'KSGA',quantity:2,modifiers:[]}],ambiguous:false,safety:'SAFE',wouldBeSafe:true};
const row=(overrides={})=>({caseId:'x',category:'unit',turn:1,expected,actual,latencyMs:10,parserSuccess:true,parserFailure:false,parserPath:'NETWORK_PARSER',comparison:compareGroundTruth(expected,actual),...overrides});

test('ground-truth comparison detects exact material result and harmless intent-only difference',()=>{
  assert.equal(compareGroundTruth(expected,actual).severity,'PASS');
  const result=compareGroundTruth(expected,{...actual,intents:['START_ORDER']});
  assert.equal(result.materialCorrect,true);
  assert.equal(result.severity,'HARMLESS');
});

test('semantic intent metric ignores redundant START_ORDER but raw metric remains exact',()=>{
  const withStart={...actual,intents:['START_ORDER','ADD_ITEM']};
  const comparison=compareGroundTruth(expected,withStart);
  assert.equal(comparison.intentCorrect,false);
  assert.equal(comparison.semanticIntentCorrect,true);
  const metrics=calculateMetrics([row({actual:withStart,comparison})]);
  assert.equal(metrics.rawExactIntentAccuracy,0);
  assert.equal(metrics.semanticActionIntentAccuracy,1);
});

test('independent component metrics diagnose quantity and modifiers separately from product',()=>{
  const wrongProduct={...actual,items:[{productCode:'LATTE',quantity:2,modifiers:[]}]};
  const comparison=compareGroundTruth(expected,wrongProduct);
  assert.equal(comparison.productsCorrect,false);
  assert.equal(comparison.independentQuantityCorrect,true);
  assert.equal(comparison.independentModifierCorrect,true);
  const metrics=calculateMetrics([row({actual:wrongProduct,comparison})]);
  assert.equal(metrics.independentProductAccuracy,0);
  assert.equal(metrics.independentQuantityAccuracy,1);
  assert.equal(metrics.independentModifierAccuracy,1);
  assert.equal(metrics.exactCartAccuracy,0);
});

test('failure severity distinguishes critical safe mistake from recoverable clarification',()=>{
  const wrong={...actual,items:[{productCode:'LATTE',quantity:2,modifiers:[]}]};
  assert.equal(compareGroundTruth(expected,wrong).severity,'CRITICAL');
  assert.equal(compareGroundTruth(expected,{...wrong,safety:'NEEDS_CLARIFICATION',wouldBeSafe:false}).severity,'RECOVERABLE');
});

test('metric calculations include accuracy, safety, and latency',()=>{
  const criticalExpected={...expected,orderLike:false,complete:false,items:[]};
  const criticalActual={...actual,items:[{productCode:'KSGA',quantity:1,modifiers:[]}]};
  const results=[row(),row({latencyMs:30,expected:criticalExpected,actual:criticalActual,comparison:compareGroundTruth(criticalExpected,criticalActual)})];
  const metrics=calculateMetrics(results);
  assert.equal(metrics.intentAccuracy,1);
  assert.equal(metrics.completeOrderAccuracy,1);
  assert.equal(metrics.falseOrderRate,1);
  assert.equal(metrics.criticalSilentErrorRate,.5);
  assert.equal(metrics.averageParserLatencyMs,20);
  assert.equal(metrics.p95ParserLatencyMs,30);
});

test('dataset loader accepts multi-turn cases and the committed dataset stays within target size',async()=>{
  const data=await loadDataset(new URL('../evals/chatbot-cases.json',import.meta.url));
  assert.ok(data.cases.length>=100&&data.cases.length<=200);
  assert.ok(data.cases.some(entry=>entry.turns.length>1));
  assert.ok(data.cases.every(entry=>entry.turns.every(turn=>turn.expected)));
});

test('malformed dataset is rejected',()=>{
  assert.throws(()=>validateDataset({version:1,products:[],cases:[{id:'bad',category:'x',turns:[{input:'x'}]}]}),/malformed/);
  assert.throws(()=>validateDataset({version:1,products:[],cases:[{id:'same',category:'x',turns:[{input:'x',expected:{intents:[],ambiguous:false,orderLike:false}}]},{id:'same',category:'x',turns:[{input:'x',expected:{intents:[],ambiguous:false,orderLike:false}}]}]}),/duplikat/);
});

test('machine report contains required metadata, category metrics, and failure lists',()=>{
  const data={version:7,products:[],cases:[{id:'x'}]};
  const report=buildReport(data,[row()],{provider:'unit',model:'fake'});
  assert.equal(report.datasetVersion,7);
  assert.equal(report.provider,'unit');
  assert.equal(report.caseCount,1);
  assert.ok(report.timestamp);
  assert.ok(report.categoryMetrics.unit);
  assert.deepEqual(report.criticalFailures,[]);
  assert.equal(report.denominators.networkParserAttempts,1);
});

test('attempt telemetry summary separates primary, retry, fallback, failures, and backoff',()=>{
  const attempts=[
    {attempt:1,requestedModel:'120b',status:429,errorCategory:'RATE_LIMIT',backoffMs:100,fallback:false},
    {attempt:2,requestedModel:'120b',status:200,errorCategory:null,backoffMs:0,fallback:false},
    {attempt:1,requestedModel:'120b',status:400,errorCategory:'SCHEMA_VALIDATION',backoffMs:0,fallback:false,fallbackReason:'SCHEMA_VALIDATION'},
    {attempt:2,requestedModel:'20b',status:200,errorCategory:null,backoffMs:0,fallback:true,fallbackReason:'SCHEMA_VALIDATION'},
  ];
  const results=[row({networkAttempts:attempts.slice(0,2)}),row({networkAttempts:attempts.slice(2),parserPath:'FALLBACK'})];
  assert.deepEqual(summarizeAttemptTelemetry(results),{
    logicalNetworkTurns:2,totalModelAttempts:4,primarySuccessCount:0,retrySuccessCount:1,fallbackSuccessCount:1,
    rateLimitCountByModel:{'120b':1,'20b':0},schemaFailureCountByModel:{'120b':1,'20b':0},totalBackoffMs:100,
  });
});

test('complete-order metrics split single-turn, multi-turn, confirmation, availability, and end-to-end denominators',()=>{
  const single=row({caseId:'single',caseTurnCount:1});
  const multiExpected={...expected,intents:['CONFIRM_ORDER']};
  const multiActual={...actual,intents:['CONFIRM_ORDER']};
  const multi=row({caseId:'multi',caseTurnCount:2,turn:2,expected:multiExpected,actual:multiActual,comparison:compareGroundTruth(multiExpected,multiActual)});
  const failed=row({caseId:'failed',caseTurnCount:2,turn:2,expected:multiExpected,actual:{...multiActual,safety:'NEEDS_CLARIFICATION',wouldBeSafe:false},
    comparison:compareGroundTruth(multiExpected,{...multiActual,safety:'NEEDS_CLARIFICATION',wouldBeSafe:false}),parserSuccess:false,parserFailure:true});
  const report=buildReport({version:1,cases:[{id:'single'},{id:'multi'},{id:'failed'}]},[single,multi,failed],{provider:'unit',model:'fake'});
  assert.equal(report.denominators.singleTurnExpectedCompleteTurns,1);
  assert.equal(report.denominators.multiTurnExpectedCompleteTurns,2);
  assert.equal(report.denominators.explicitConfirmationTurns,2);
  assert.equal(report.metrics.singleTurnSlotCompleteAccuracy,1);
  assert.equal(report.metrics.multiTurnDraftCompletionAccuracy,.5);
  assert.equal(report.metrics.explicitConfirmationSuccess,.5);
  assert.equal(report.metrics.providerParserAvailability,2/3);
  assert.equal(report.metrics.endToEndCompletionAccuracy,2/3);
  assert.equal(report.metrics.completeOrderAccuracy,report.metrics.endToEndCompletionAccuracy);
});

test('evaluation pacing runs only between sequential network turns',async()=>{
  const data={version:1,products:[],cases:[{id:'pace',category:'unit',turns:[
    {input:'hello one',expected:{intents:['UNKNOWN'],items:[],ambiguous:false,orderLike:false}},
    {input:'hello two',expected:{intents:['UNKNOWN'],items:[],ambiguous:false,orderLike:false}},
  ]}]};
  const waits=[];
  const parser=async()=>({intents:['UNKNOWN'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],confirmation:null},needs_clarification:false,ambiguities:[],confidence:1,
    _diagnostics:{configuredModel:'m',actualModel:'m',parserPath:'NETWORK_PARSER',attempts:[]}});
  await evaluateDataset(data,{provider:'groq',parser,configuredModel:'m',pacingMs:250,sleep:async ms=>waits.push(ms)});
  assert.deepEqual(waits,[250]);
});

test('parser failure records safe diagnostics, actual latency, and upstream cascade',async()=>{
  const data={version:1,products:[{code:'KSGA',name:'Kopi Susu Gula Aren',aliases:['kopsus']}],cases:[{id:'cascade',category:'multi_turn',turns:[
    {input:'pesan awal',expected:{intents:['ADD_ITEM'],items:[{productCode:'KSGA',quantity:1,modifiers:[]}],ambiguous:false,orderLike:true}},
    {input:'pesan lanjutan',expected:{intents:['SHOW_ORDER_DRAFT'],items:[{productCode:'KSGA',quantity:1,modifiers:[]}],ambiguous:false,orderLike:true}},
  ]}]};
  let calls=0;
  const parser=async()=>{
    calls+=1;
    if (calls===1) {
      await new Promise(resolve=>setTimeout(resolve,5));
      throw new ParserProviderError('rate limited',{category:'RATE_LIMIT',httpStatus:429,configuredModel:'model-a',actualModel:'model-b',parserPath:'FALLBACK'});
    }
    return {intents:['SHOW_ORDER_DRAFT'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],confirmation:null},needs_clarification:false,ambiguities:[],confidence:.9,
      _model:'model-a',_diagnostics:{configuredModel:'model-a',actualModel:'model-a',parserPath:'NETWORK_PARSER'}};
  };
  const report=await evaluateDataset(data,{provider:'groq',parser,configuredModel:'model-a'});
  const failed=report.results[0];
  assert.equal(failed.parserError.category,'RATE_LIMIT');
  assert.equal(failed.parserError.httpStatus,429);
  assert.equal(failed.configuredModel,'model-a');
  assert.equal(failed.actualModel,'model-b');
  assert.equal(failed.parserPath,'FALLBACK');
  assert.ok(failed.latencyMs>=4);
  assert.equal(report.results[1].upstreamParserFailure,true);
  assert.equal(report.results[1].cascadingFailure,true);
  assert.equal(report.cascadingFailures.length,1);
});

test('evaluation propagates model ambiguity into safety classification',async()=>{
  const data={version:1,products:[{code:'KSGA',name:'Kopi Susu Gula Aren',aliases:['kopsus']}],cases:[{id:'amb',category:'ambiguity',turns:[
    {input:'yang biasa satu buat budi cash',expected:{intents:['ADD_ITEM'],items:[],ambiguous:true,orderLike:true}},
  ]}]};
  const parser=async()=>({intents:['ADD_ITEM'],entities:{name:'Budi',class_name:null,payment_method:'CASH',item_operations:[],confirmation:null},needs_clarification:true,
    ambiguities:['Produk belum jelas'],confidence:.5,_model:'model-a',_diagnostics:{configuredModel:'model-a',actualModel:'model-a',parserPath:'NETWORK_PARSER'}});
  const report=await evaluateDataset(data,{provider:'groq',parser,configuredModel:'model-a'});
  assert.equal(report.results[0].actual.ambiguous,true);
  assert.equal(report.results[0].actual.safety,'NEEDS_CLARIFICATION');
  assert.deepEqual(report.results[0].parserOutput.ambiguities,['Produk belum jelas']);
});

test('evaluation strips model-only confirmation and inferred payment like production',async()=>{
  const data={version:1,products:[{code:'KSGA',name:'Kopi Susu Gula Aren',aliases:['kopsus']}],cases:[{id:'guard',category:'safety',turns:[
    {input:'kopsus satu',expected:{intents:['ADD_ITEM'],items:[{productCode:'KSGA',quantity:1,modifiers:[]}],ambiguous:false,orderLike:true}},
  ]}]};
  const parser=async()=>({intents:['ADD_ITEM','CONFIRM_ORDER','SET_PAYMENT_METHOD'],entities:{name:null,class_name:null,payment_method:'CASH',
    item_operations:[{action:'ADD',product_query:'kopsus',quantity:1,modifiers:[],notes:null}],confirmation:true},needs_clarification:false,ambiguities:[],confidence:.9,
    _model:'model-a',_diagnostics:{configuredModel:'model-a',actualModel:'model-a',parserPath:'NETWORK_PARSER'}});
  const report=await evaluateDataset(data,{provider:'groq',parser,configuredModel:'model-a'});
  assert.deepEqual(report.results[0].actual.intents,['ADD_ITEM']);
  assert.equal(report.results[0].parserOutput.entities.payment_method,'CASH');
  assert.equal(report.results[0].appliedParserOutput.entities.payment_method,null);
  assert.equal(report.results[0].actual.safety,'NEEDS_CLARIFICATION');
});

test('shadow export is anonymized, separates predictions, and leaves human label empty',()=>{
  const result=buildLabelingExport([{id:'private-id',normalized_input:'2 kopsus',parser_intents:['ADD_ITEM'],resolved_items:[{productCode:'KSGA',quantity:2}],safety_classification:'SAFE',parser_failed:false}]);
  assert.equal(result.count,1);
  assert.equal(result.candidates[0].humanLabel,null);
  assert.equal(result.candidates[0].prediction.items[0].productCode,'KSGA');
  assert.equal(JSON.stringify(result).includes('private-id'),false);
  assert.match(result.warning,/not ground truth/i);
});
