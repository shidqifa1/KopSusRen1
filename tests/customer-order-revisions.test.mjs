import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDraft, applyStructuredPatch, applyParserAmbiguities, classifyDraftSafety,
  authorizeOrderCommit, sanitizeCustomerParsedResult, deterministicCustomerTurn,
} from '../services/chatbot/conversation.js';

const menu=[{id:'aren',code:'AREN',name:'Kopi Susu Gula Aren',price:8000,chatbot_metadata:{aliases:['kopsus']}},
  {id:'matcha',code:'MATCHA',name:'Matcha Latte',price:12000,chatbot_metadata:{aliases:['matcha']}}];
const item=(quantity,modifiers=[])=>({productId:'aren',quantity,modifiers,noIce:modifiers.includes('NO_ICE'),notes:null});
const draft=(items=[item(2),item(1,['NO_ICE'])])=>({...emptyDraft('po-test'),items,customer_name:'Test',payment_method:'CASH',awaiting_confirmation:true});
const patch=(state,action,quantity,modifiers=[],product_query='kopsus')=>applyStructuredPatch(state,{
  intents:[action==='REMOVE'?'REMOVE_ITEM':'UPDATE_ITEM'],
  entities:{item_operations:[{action,product_query,quantity,modifiers,notes:null}]},
},menu);

test('removing no-ice variant preserves normal cups and original draft',()=>{
  const original=draft();
  const result=patch(original,'REMOVE',1,['NO_ICE']);
  assert.deepEqual(result.draft.items,[item(2)]);
  assert.equal(original.items.length,2);
});
test('partial removal only decreases the selected variant',()=>{
  const result=patch(draft([item(2),item(3,['NO_ICE'])]),'REMOVE',1,['NO_ICE']);
  assert.deepEqual(result.draft.items,[item(2),item(2,['NO_ICE'])]);
});
test('removing a variant absent from the cart preserves all cups and blocks confirmation',()=>{
  const original=draft([item(2)]);
  const result=patch(original,'REMOVE',1,['LESS_ICE']);
  assert.deepEqual(result.draft.items,original.items);
  assert.equal(classifyDraftSafety(result.draft,result).classification,'NEEDS_CLARIFICATION');
});
test('removal without variant selection cannot guess among multiple variants',()=>{
  const original=draft();
  const result=patch(original,'REMOVE',1);
  assert.deepEqual(result.draft.items,original.items);
  const safety=classifyDraftSafety(result.draft,result);
  assert.equal(authorizeOrderCommit({text:'gas',previousDraft:original,safety}),false);
});
test('ambiguous quantity revision does not silently change normal cups',()=>{
  const original=draft();
  const result=patch(original,'UPDATE',5);
  assert.deepEqual(result.draft.items,original.items);
  assert.equal(result.ambiguous.length,1);
});
test('new modifier on a multi-variant cart requires selecting its source variant',()=>{
  const original=draft();
  const result=patch(original,'UPDATE',1,['LESS_SWEET']);
  assert.deepEqual(result.draft.items,original.items);
  assert.equal(result.ambiguous.length,1);
});
test('explicit variant correction resolves clarification without losing other cups',()=>{
  const first=patch(draft(),'UPDATE',2);
  const blocked=classifyDraftSafety(first.draft,first);
  const correction=patch(blocked.draft,'UPDATE',2,['NO_ICE']);
  const safe=classifyDraftSafety(correction.draft,correction);
  assert.deepEqual(safe.draft.items,[item(2),item(2,['NO_ICE'])]);
  assert.equal(safe.classification,'SAFE');
  assert.equal(safe.clarificationAttempts,0);
});
test('a second unresolved variant revision requests owner assistance',()=>{
  const first=patch(draft(),'REMOVE',1);
  const firstSafety=classifyDraftSafety(first.draft,first);
  const second=patch(firstSafety.draft,'REMOVE',1);
  assert.equal(classifyDraftSafety(second.draft,second).classification,'OWNER_HANDOFF');
});
test('single-variant modifier split preserves the total quantity',()=>{
  const result=patch(draft([item(3)]),'UPDATE',1,['NO_ICE']);
  assert.deepEqual(result.draft.items,[item(2),item(1,['NO_ICE'])]);
});
test('customer can add, revise, choose QRIS and explicitly confirm the resulting cart',()=>{
  let current=emptyDraft('po-test');
  const turns=[
    ['2 kopsus', {intents:['ADD_ITEM'],entities:{item_operations:[{action:'ADD',product_query:'kopsus',quantity:2,modifiers:[]}]}}],
    ['satu aja', {intents:['UPDATE_ITEM'],entities:{item_operations:[{action:'UPDATE',product_query:'kopsus',quantity:1,modifiers:[]}]}}],
    ['nama Test', {intents:['PROVIDE_NAME'],entities:{name:'Test',item_operations:[]}}],
    ['qris', null],
  ];
  for(const [text,extracted] of turns){
    const parsed=sanitizeCustomerParsedResult(text,current,extracted||deterministicCustomerTurn(text,current,menu));
    const result=applyParserAmbiguities(applyStructuredPatch(current,parsed,menu),parsed);
    const safety=classifyDraftSafety(result.draft,result);
    assert.equal(authorizeOrderCommit({text,previousDraft:current,safety}),false);
    current=safety.draft;
  }
  assert.equal(current.items[0].quantity,1);
  assert.equal(current.payment_method,'QRIS');
  const parsed=deterministicCustomerTurn('gas',current,menu);
  const result=applyStructuredPatch(current,parsed,menu);
  assert.equal(authorizeOrderCommit({text:'gas',previousDraft:current,safety:classifyDraftSafety(result.draft,result)}),true);
});
