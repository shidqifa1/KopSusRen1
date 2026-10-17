import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDraft, parseUsualOrderRequest, usualOrderReply, orderConfirmationSnapshot,
  authorizeOrderCommit, classifyDraftSafety, applyStructuredPatch,
  summarizeDraft,
} from '../services/chatbot/conversation.js';

const menu=[{id:'aren',name:'Kopi Susu Gula Aren',code:'AREN',price:9000,is_active:true}];
const history=[{order_number:12,items:[{product_id:'aren',quantity:3,no_ice:false,notes:'less ice'}]}];
const availability={products:[{productId:'aren',available:true,availableQty:10}]};
const turn=(text,draft=emptyDraft('po'),extra={})=>usualOrderReply({text,draft,history,products:menu,availability,...extra});

test('usual requests recognize quantity without assuming the old quantity',()=>{
  for(const text of ['yang biasa ya 1','bang gua mau pesan yang biasa satu dong','seperti biasa 1 cup']) {
    assert.deepEqual(parseUsualOrderRequest(text),{quantity:1,supported:true},text);
  }
  assert.deepEqual(parseUsualOrderRequest('yang biasa ya'),{quantity:null,supported:true});
  for(const text of ['yang biasa 0','yang biasa -1','yang biasa 101','yang biasa 1 tambah matcha 2','yang biasa 1 tapi tanpa es']) {
    assert.equal(parseUsualOrderRequest(text).supported,false,text);
  }
  assert.equal(parseUsualOrderRequest('aren 1 es biasa'),null);
});

test('usual order is only a suggestion and always names the historical variant',()=>{
  const result=turn('yang biasa ya 1');
  assert.deepEqual(result.draft.items,[]);
  assert.equal(result.draft.awaiting_confirmation,false);
  assert.match(result.replyText,/Kopi Susu Gula Aren.*less ice/s);
  assert.match(result.replyText,/terakhir.*#12/s);
  assert.match(result.replyText,/9\.000/);
  assert.equal(result.draft._usual_order_suggestion.quantity,1);
  const accepted=turn('iya',result.draft);
  assert.equal(accepted.draft.items[0].quantity,1);
  assert.deepEqual(accepted.draft.items[0].modifiers,['LESS_ICE']);
  assert.equal(accepted.draft.payment_method,null);
  assert.equal(accepted.draft.customer_name,null);
  assert.equal(accepted.draft.awaiting_confirmation,false);
  assert.equal(accepted.draft._usual_order_suggestion,undefined);
});

test('unspecified quantity must be supplied and then confirmed',()=>{
  const first=turn('yang biasa');
  assert.match(first.replyText,/berapa cup/);
  const premature=turn('gas',first.draft);
  assert.deepEqual(premature.draft.items,[]);
  assert.match(premature.replyText,/berapa cup/);
  const quantity=turn('2 cup',first.draft);
  assert.deepEqual(quantity.draft.items,[]);
  assert.equal(quantity.draft._usual_order_suggestion.quantity,2);
  assert.match(quantity.replyText,/2x/);
  assert.equal(turn('iya',quantity.draft).draft.items[0].quantity,2);
});

test('no history, multiple variants and unknown notes require explicit menu selection',()=>{
  for(const rows of [[],[{...history[0],items:[...history[0].items,{product_id:'aren',quantity:1,no_ice:true,notes:null}]}],
    [{...history[0],items:[{...history[0].items[0],notes:'antar ke gerbang'}]}]]) {
    const result=turn('yang biasa 1',emptyDraft('po'),{history:rows});
    assert.deepEqual(result.draft.items,[]);
    assert.equal(result.draft._usual_order_suggestion,undefined);
    assert.match(result.replyText,/menu|catatan/i);
  }
});

test('inactive, unavailable or insufficient products are never silently substituted',()=>{
  for(const extra of [{products:[]},{products:[{...menu[0],is_active:false}]},
    {availability:{products:[{productId:'aren',available:false,availableQty:0}]}},
    {availability:{products:[{productId:'aren',available:true,availableQty:0}]}}]) {
    const result=turn('yang biasa 1',emptyDraft('po'),extra);
    assert.deepEqual(result.draft.items,[]);
    assert.equal(result.draft._usual_order_suggestion,undefined);
    assert.match(result.replyText,/tersedia|cukup/i);
  }
});

test('availability is checked again when accepting the suggestion',()=>{
  const first=turn('yang biasa 1');
  const result=turn('iya',first.draft,{availability:{products:[{productId:'aren',available:false}]}});
  assert.deepEqual(result.draft.items,[]);
  assert.equal(result.draft._usual_order_suggestion,undefined);
});

test('usual request cannot overwrite an existing cart or leave old confirmation valid',()=>{
  const draft={...emptyDraft('po'),items:[{productId:'aren',quantity:2}],awaiting_confirmation:true};
  const original=structuredClone(draft);
  const result=turn('yang biasa 1',draft);
  assert.deepEqual(result.draft.items,draft.items);
  assert.equal(result.draft.awaiting_confirmation,false);
  assert.equal(result.draft._confirmation_snapshot,undefined);
  assert.deepEqual(draft,original);
});

test('declining a suggestion clears it and choosing an explicit menu supersedes it',()=>{
  const first=turn('yang biasa 1');
  for(const text of ['bukan','batal','nggak']) {
    const result=turn(text,first.draft);
    assert.equal(result.draft._usual_order_suggestion,undefined);
    assert.deepEqual(result.draft.items,[]);
  }
  const changed=applyStructuredPatch(first.draft,{entities:{item_operations:[
    {action:'ADD',product_query:'AREN',quantity:2,modifiers:[]},
  ]}},menu);
  assert.equal(changed.draft._usual_order_suggestion,undefined);
  assert.equal(changed.draft.items[0].quantity,2);
});

function confirmedDraft() {
  const draft={...emptyDraft('po'),customer_name:'Dika',payment_method:'CASH',
    items:[{productId:'aren',quantity:1,noIce:false,modifiers:[],notes:null}],awaiting_confirmation:true};
  return {...draft,_confirmation_snapshot:orderConfirmationSnapshot(draft,menu)};
}

test('commit requires the exact cart and prices shown in the latest confirmation',()=>{
  const previous=confirmedDraft();
  const allow=(draft,products=menu)=>authorizeOrderCommit({text:'gas',previousDraft:previous,safety:classifyDraftSafety(draft),menu:products});
  assert.equal(allow(previous),true);
  assert.equal(allow(previous,[{...menu[0],price:10000}]),false);
  assert.equal(allow({...previous,items:[{...previous.items[0],quantity:2}]}),false);
  assert.equal(allow({...previous,items:[{...previous.items[0],notes:'less ice'}]}),false);
  assert.equal(allow({...previous,payment_method:'QRIS'}),false);
  assert.equal(allow({...previous,po_session_id:'other-po'}),false);
  assert.equal(authorizeOrderCommit({text:'gas',previousDraft:{...previous,_confirmation_snapshot:undefined},
    safety:classifyDraftSafety(previous),menu}),false);
});

test('confirmation summary includes custom notes and a no-ice flag even without modifier labels',()=>{
  const draft=confirmedDraft();
  draft.items=[{...draft.items[0],noIce:true,notes:'ambil jam 10'}];
  const summary=summarizeDraft(draft,menu).text;
  assert.match(summary,/no ice/);
  assert.match(summary,/ambil jam 10/);
});
