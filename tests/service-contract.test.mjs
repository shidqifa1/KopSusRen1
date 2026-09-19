import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('service layer sends authenticated V2 commands', async () => {
  const calls = [];
  const context = {
    window: {},
    sessionStorage: { getItem: () => 'test-token' },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: 'abc' }) };
    },
  };
  vm.createContext(context);
  const source = await readFile(new URL('../src/services/kopsusren.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  await context.window.kopsusrenServices.recordQuickSale({ productId: 'p1' });
  assert.equal(calls[0].url, '/api/v2/commands');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(JSON.parse(calls[0].options.body).action, 'record_quick_sale');
});

test('service layer rejects unauthenticated use', async () => {
  const context = { window: {}, sessionStorage: { getItem: () => null }, fetch: async () => assert.fail('fetch must not run') };
  vm.createContext(context);
  const source = await readFile(new URL('../src/services/kopsusren.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  await assert.rejects(() => context.window.kopsusrenServices.bootstrap(), /Sesi login/);
});

test('PO payment, fulfillment, cancellation, and void use server commands', async () => {
  const actions = [];
  const context = {
    window: {},
    sessionStorage: { getItem: () => 'test-token' },
    fetch: async (_url, options = {}) => {
      actions.push(JSON.parse(options.body).action);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: 'abc' }) };
    },
  };
  vm.createContext(context);
  const source = await readFile(new URL('../src/services/kopsusren.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  const services = context.window.kopsusrenServices;
  await services.confirmCashPayment('o1');
  await services.completeOrder('o1');
  await services.cancelOrder('o1', 'test');
  await services.voidOrder('o1', 'test');
  assert.deepEqual(actions, ['confirm_cash_payment', 'complete_order', 'cancel_order', 'void_order']);
});

test('history export uses the authenticated full-history endpoint', async () => {
  const calls = [];
  const context = {
    window: {},
    sessionStorage: { getItem: () => 'test-token' },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rows: [] }) };
    },
  };
  vm.createContext(context);
  const source = await readFile(new URL('../src/services/kopsusren.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  await context.window.kopsusrenServices.exportHistory('sales');
  assert.equal(calls[0].url, '/api/v2/export?type=sales');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.method, undefined);
});
