import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const end = html.indexOf('\n}', start);
  return html.slice(start, end + 2);
}

test('bootstrap starts independent database reads without waiting for earlier reads', async () => {
  const source = fs.readFileSync(new URL('../api/v2/bootstrap.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const pending = [];
  const sql = () => new Promise(resolve => pending.push(resolve));
  const module = { exports: {} };
  const require = path => path.includes('/db/') ? { sql } : { requireAuth: () => true, errorMessage: String };
  vm.runInNewContext(compiled, { module, exports: module.exports, require, process: { env: {} }, console });
  let response;
  const task = module.exports.default({ method: 'GET', query: {} }, {
    status(code) { this.code = code; return this; },
    json(value) { response = value; return this; },
  });
  assert.equal(pending.length, 10, 'all ten independent reads should be dispatched');
  for (const resolve of pending) resolve([]);
  await task;
  assert.equal(response.ok, true);
});

test('loading overlay waits briefly so quick actions do not flash a full-screen spinner', () => {
  const overlay = { open: false, classList: { add() { overlay.open = true; }, remove() { overlay.open = false; } }, setAttribute() {} };
  const label = { textContent: '' };
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    loadingTimer: null,
    document: { getElementById: id => id === 'loadingOverlay' ? overlay : label },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(functionSource('showLoading') + '\n' + functionSource('hideLoading'), context);
  context.showLoading('Menyimpan...');
  assert.equal(overlay.open, false);
  context.hideLoading();
  for (const callback of timers.values()) callback();
  assert.equal(overlay.open, false, 'completed actions must not show a late overlay');
  context.showLoading('Memuat...');
  for (const callback of timers.values()) callback();
  assert.equal(overlay.open, true, 'slow actions still show progress');
  assert.equal(label.textContent, 'Memuat...');
});

test('an older background response cannot replace a newer snapshot', async () => {
  const callbacks = [];
  const snapshots = [];
  const context = vm.createContext({
    state: { marker: 'initial' },
    window: { kopsusrenServices: { bootstrap: () => new Promise(resolve => callbacks.push(resolve)) } },
    legacyStateFromV2: data => data,
    localStorage: { setItem: (_key, value) => snapshots.push(JSON.parse(value).marker) },
    updateSyncStatus() {}, renderNotifications() {},
  });
  vm.runInContext(functionSource('refreshV2'), context);
  const oldRefresh = context.refreshV2();
  const newRefresh = context.refreshV2();
  callbacks[1]({ marker: 'new' });
  await newRefresh;
  callbacks[0]({ marker: 'old' });
  await oldRefresh;
  assert.equal(context.state.marker, 'new');
  assert.deepEqual(snapshots, ['new']);
});

test('background reads stay frequent for PO but ease off on other pages', async () => {
  const calls = [];
  const context = vm.createContext({
    window: { baristackLastRefreshAt: Date.now() - 30000 },
    document: { hidden: false, activeElement: { matches: () => false }, querySelector: () => null },
    getToken: () => 'session', v2MutationInFlight: false, v2RefreshInFlight: false,
    activePage: 'dashboard', refreshV2: async () => { calls.push('read'); return true; },
    renderPage() { calls.push('paint'); }, updateSyncStatus() {},
  });
  vm.runInContext(functionSource('autoRefreshV2'), context);
  await context.autoRefreshV2();
  assert.deepEqual(calls, []);
  context.activePage = 'po';
  await context.autoRefreshV2();
  assert.deepEqual(calls, ['read', 'paint']);
});

test('after a write succeeds, loading text explains the data refresh phase', async () => {
  const phases = [];
  const context = vm.createContext({
    v2MutationInFlight: false,
    showLoading: text => phases.push(text), hideLoading() {},
    refreshV2: async () => {}, renderPage() {}, showToast() {},
    activePage: 'stok',
  });
  vm.runInContext(functionSource('runV2Mutation'), context);
  await context.runV2Mutation('Menyimpan...', async () => ({}), 'Berhasil');
  assert.deepEqual(phases, ['Menyimpan...', 'Memperbarui tampilan...']);
});
