import test from 'node:test';
import assert from 'node:assert/strict';
import {aiConfig,requestChatCompletion,chatCompletion} from '../services/ai/provider.js';
import {createOwnerLlm} from '../services/owner/llm.js';
import {groqEnabled} from '../services/parser/groqOrderParser.js';
import {answerCustomerWithGroq} from '../services/ai/kopsusrenAssistant.js';

async function withGemini(run){
 const names=['AI_PROVIDER','GEMINI_MODEL','GEMINI_API_KEY','GROQ_API_KEY','GROQ_MODEL'];
 const saved=Object.fromEntries(names.map(key=>[key,process.env[key]]));const originalFetch=globalThis.fetch;
 Object.assign(process.env,{AI_PROVIDER:'gemini',GEMINI_API_KEY:'dummy-google-key',GROQ_API_KEY:'dummy-groq-key',GROQ_MODEL:'openai/gpt-oss-120b'});
 delete process.env.GEMINI_MODEL;
 try{await run();}finally{globalThis.fetch=originalFetch;for(const key of names)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
}

test('Gemini selection uses Flash-Lite and only sends Gemini credentials to Google',async()=>withGemini(async()=>{
 let request;
 globalThis.fetch=async(url,options)=>{request={url,options};return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));};
 const signal=new AbortController().signal;
 const schema={type:'json_schema',json_schema:{name:'test',strict:true,schema:{type:'object'}}};
 await requestChatCompletion({model:'openai/gpt-oss-120b',reasoning_effort:'low',messages:[{role:'user',content:'dummy'}],response_format:schema},{signal});
 assert.equal(aiConfig().model,'gemini-3.5-flash-lite');
 assert.equal(request.url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
 assert.equal(request.options.headers.Authorization,'Bearer dummy-google-key');
 assert.equal(request.options.signal,signal);
 const body=JSON.parse(request.options.body);
 assert.equal(body.model,'gemini-3.5-flash-lite');assert.equal(body.reasoning_effort,'minimal');
 assert.deepEqual(body.response_format,schema);
}));

test('Gemini missing key fails closed even when Groq key is configured',async()=>withGemini(async()=>{
 delete process.env.GEMINI_API_KEY;
 assert.equal(groqEnabled(),false);
 globalThis.fetch=()=>{throw Error('Must not call provider');};
 await assert.rejects(()=>chatCompletion({messages:[]}),/GEMINI_API_KEY/);
}));

test('Gemini quota errors propagate status and never fall back to Groq',async()=>withGemini(async()=>{
 let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'20'}});};
 await assert.rejects(()=>chatCompletion({messages:[]}),error=>error.status===429&&error.headers.get('retry-after')==='20');
 assert.equal(calls,1);
}));

test('owner and legacy customer replies use Gemini when Groq key is absent',async()=>withGemini(async()=>{
 delete process.env.GROQ_API_KEY;
 assert.equal(groqEnabled(),true);
 const requests=[];
 globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body),signal:options.signal});return new Response(JSON.stringify({choices:[{message:{content:requests.length===1?'READ_QUERY':'Menu dummy tersedia.'}}]}));};
 assert.equal(await createOwnerLlm().ownerRouter('stok bahan?'),'READ_QUERY');
 assert.equal(await answerCustomerWithGroq({question:'menu?',currentOrder:{},snapshot:{}}),'Menu dummy tersedia.');
 assert.ok(requests.every(x=>x.body.model==='gemini-3.5-flash-lite'&&x.signal instanceof AbortSignal));
}));

test('Gemini error payload cannot leak the supplied key through errors',async()=>withGemini(async()=>{
 globalThis.fetch=async()=>new Response('dummy-google-key',{status:403});
 await assert.rejects(()=>chatCompletion({messages:[]}),error=>!error.message.includes('dummy-google-key')&&error.status===403);
}));

test('customer extraction uses Gemini without Groq credentials and retains schema validation',async()=>withGemini(async()=>{
 const {parseWithGroq}=await import('../services/parser/groqOrderParser.js');
 delete process.env.GROQ_API_KEY;let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
  assert.equal(JSON.parse(options.body).response_format.type,'json_schema');
  return new Response(JSON.stringify({model:'gemini-3.5-flash-lite',choices:[{message:{content:JSON.stringify({
   intents:['UNKNOWN'],entities:{name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,confirmation:null},
   needs_clarification:true,ambiguities:['Menu belum jelas'],reply_hint:null,confidence:0,
  })}}]}));
 };
 const parsed=await parseWithGroq({text:'minuman dummy',currentOrder:{},menu:[]});
 assert.equal(parsed._model,'gemini-3.5-flash-lite');assert.equal(parsed.needs_clarification,true);assert.equal(calls,1);
}));

test('invalid Gemini schema responses stay on Gemini and return a clarification draft',async()=>withGemini(async()=>{
 const {parseWithGroq}=await import('../services/parser/groqOrderParser.js');
 const models=[];
 globalThis.fetch=async(url,options)=>{
  assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
  models.push(JSON.parse(options.body).model);
  return new Response('json_validate_failed',{status:400});
 };
 const parsed=await parseWithGroq({text:'dummy',currentOrder:{},menu:[],evaluationPolicy:{maxPrimaryAttempts:1,maxFallbackAttempts:1}});
 assert.equal(models.length,2);
 assert.ok(models.every(x=>x==='gemini-3.5-flash-lite'));
 assert.equal(parsed.needs_clarification,true);
 assert.equal(parsed._diagnostics.fallbackOccurred,undefined);
 assert.equal(parsed._model,'gemini-3.5-flash-lite');
}));
