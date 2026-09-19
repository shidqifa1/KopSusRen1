import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMessage, buildReplyText, emptyOrder, isOrderStartText, parseOrderText } from '../services/parser/orderParser.js';

test('parser turns complete WhatsApp text into ready draft', () => {
  const draft = parseOrderText('pesen kopi susu 2 normal qris buat Dinda 8.1');
  assert.equal(draft.state, 'DRAFT_READY');
  assert.equal(draft.customer, 'Dinda');
  assert.equal(draft.className, '8.1');
  assert.equal(draft.items[0].productCode, 'KSGA');
  assert.equal(draft.items[0].quantity, 2);
});

test('parser asks for missing customer name', () => {
  const draft = parseOrderText('latte 1');
  assert.equal(draft.state, 'INCOMPLETE');
  assert.ok(draft.missing.includes('nama'));
  assert.match(buildReplyText(draft), /ice|nama|cash|QRIS/);
});

test('bot offers menu list and correct examples when menu is unclear', () => {
  const draft = parseOrderText('mau beli dong buat nanti');
  const reply = buildReplyText(draft);
  assert.equal(draft.state, 'INCOMPLETE');
  assert.ok(draft.missing.includes('menu'));
  assert.match(reply, /Menu yang tersedia/);
  assert.match(reply, /Kopi Susu Gula Aren/);
  assert.match(reply, /Contoh/);
});

test('casual joined typing is recognized as starting an order', () => {
  assert.equal(isOrderStartText('guamau mesen dong'), true);
  assert.equal(isOrderStartText('gue maupesen'), true);
  assert.equal(isOrderStartText('pengen order nih'), true);
  assert.equal(isOrderStartText('lagi nanya harga'), false);
});

test('bot asks for menu before payment when no item exists', () => {
  const result = applyMessage('cash buat Andi', emptyOrder());
  assert.equal(result.order.items.length, 0);
  assert.match(result.reply, /creamy|strong|nggak terlalu manis/);
  assert.doesNotMatch(result.reply, /bayarnya cash atau QRIS/);
});

test('conversation keeps draft state and confirms only after slots are complete', () => {
  let state = emptyOrder();
  let result = applyMessage('mau kopsus 2', state);
  state = result.order;
  assert.equal(state.items[0].productCode, 'KSGA');
  assert.equal(state.items[0].quantity, 2);
  assert.match(result.reply, /cash|QRIS/);

  result = applyMessage('no ice qris buat kenzie', state);
  state = result.order;
  assert.equal(state.customer_name, 'kenzie');
  assert.equal(state.payment_method, 'qris');
  assert.equal(state.items[0].ice, 'no_ice');
  assert.equal(state.order_status, 'ready_to_confirm');
  assert.match(result.reply, /balas/);

  result = applyMessage('gas', state);
  assert.equal(result.readyToCommit, true);
});

test('conversation can remove and update items', () => {
  let result = applyMessage('kopsus dua sama americano satu no ice qris buat shidqi', emptyOrder());
  let state = result.order;
  assert.equal(state.items.length, 2);

  result = applyMessage('americano batal', state);
  state = result.order;
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].productCode, 'KSGA');

  result = applyMessage('jadi tiga', state);
  assert.equal(result.order.items[0].quantity, 3);
});

test('customer name after buat stops before quantity and menu', () => {
  const result = applyMessage('buat kenzie dua kopsus no ice sama americano satu bayar qris', emptyOrder());
  assert.equal(result.order.customer_name, 'kenzie');
  assert.equal(result.order.payment_method, 'qris');
  assert.equal(result.order.items.length, 2);
});

test('a.n alias cannot accidentally capture text inside ordinary words', () => {
  const result = applyMessage('emm yang ga manis banget si', emptyOrder());
  assert.equal(result.order.customer_name, null);
});

test('casual name and comma class format are parsed correctly', () => {
  const result = applyMessage('iya gua mau kopsus aja 1, shidqi 9,2, cash', emptyOrder());
  assert.equal(result.order.customer_name, 'shidqi');
  assert.equal(result.order.class_name, '9.2');
  assert.equal(result.order.payment_method, 'cash');
});

test('recommended menu selection is remembered before quantity follow-up', () => {
  let result = applyMessage('hemm gula aren keknya enak deh', emptyOrder());
  assert.equal(result.order.items[0].productCode, 'KSGA');
  assert.equal(result.order.items[0].quantityConfirmed, false);
  assert.match(result.reply, /berapa cup/);

  result = applyMessage('1 aja dah buat sendiri', result.order);
  assert.equal(result.order.items[0].quantity, 1);
  assert.equal(result.order.items[0].quantityConfirmed, true);
  assert.equal(result.order.customer_name, null);
});

test('repeating a provisional menu confirms it instead of duplicating it', () => {
  let result = applyMessage('gula aren kayaknya enak', emptyOrder());
  result = applyMessage('iya kopsus 1, shidqi 9,2, cash', result.order);
  assert.equal(result.order.items.length, 1);
  assert.equal(result.order.items[0].quantityConfirmed, true);
  assert.equal(result.order.customer_name, 'shidqi');
  assert.equal(result.order.class_name, '9.2');
});

test('nama gua syntax ignores a trailing address word', () => {
  const result = applyMessage('nama gua shidqi paok', emptyOrder());
  assert.equal(result.order.customer_name, 'shidqi');
});

test('qris fills payment slot without becoming confirmation', () => {
  let result = applyMessage('matcha 1', emptyOrder());
  result = applyMessage('qris', result.order);
  assert.equal(result.intent, 'unknown');
  assert.equal(result.readyToCommit, false);
  assert.equal(result.order.payment_method, 'qris');
  assert.match(result.reply, /atas nama siapa/);
});
