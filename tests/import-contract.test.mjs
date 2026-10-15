import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const api=fs.readFileSync(new URL('../api/v2/commands.ts',import.meta.url),'utf8');
const services=fs.readFileSync(new URL('../src/services/kopsusren.js',import.meta.url),'utf8');
const migration=fs.readFileSync(new URL('../supabase/migrations/011_history_import.sql',import.meta.url),'utf8');

test('sales, cash, and JSON import controls are available',()=>{
  assert.match(html,/id="importPenjualanFile"/);
  assert.match(html,/id="importKasFile"/);
  assert.match(html,/id="importJsonFile"/);
  assert.match(html,/Import Setting JSON/);
});

test('CSV import and export actions only appear in settings',()=>{
  assert.equal((html.match(/onclick="exportPenjualanCSV\(\)"/g)||[]).length,1);
  assert.equal((html.match(/onclick="exportKasCSV\(\)"/g)||[]).length,1);
  const settings=html.slice(html.indexOf('id="page-pengaturan"'),html.indexOf('<!-- ============== MODALS'));
  assert.match(settings,/onclick="exportPenjualanCSV\(\)"/);
  assert.match(settings,/onclick="exportKasCSV\(\)"/);
  assert.match(settings,/id="settingsImportSalesButton"/);
  assert.match(settings,/id="settingsImportCashButton"/);
  assert.doesNotMatch(html,/id="page-riwayat"[\s\S]*onclick="exportPenjualanCSV\(\)"[\s\S]*id="page-kalkulator"/);
  assert.doesNotMatch(html,/id="page-pengeluaran"[\s\S]*onclick="exportKasCSV\(\)"[\s\S]*id="page-laporan"/);
  assert.doesNotMatch(html,/id="page-laporan"[\s\S]*onclick="export(?:Penjualan|Kas)CSV\(\)"[\s\S]*id="page-pengaturan"/);
});

test('settings page exposes sales, cash, and JSON import from one place',()=>{
  assert.equal((html.match(/id="importPenjualanFile"/g)||[]).length,1);
  assert.equal((html.match(/id="importKasFile"/g)||[]).length,1);
  assert.equal((html.match(/id="importJsonFile"/g)||[]).length,1);
  assert.match(html,/id="page-pengaturan"[\s\S]*id="settingsImportSalesButton"[\s\S]*id="settingsImportCashButton"[\s\S]*id="settingsImportLog"[\s\S]*id="importJsonFile"/);
  assert.match(html,/settingsImportSalesButton[^>]*onclick="document\.getElementById\('importPenjualanFile'\)\.click\(\)"/);
  assert.match(html,/settingsImportCashButton[^>]*onclick="document\.getElementById\('importKasFile'\)\.click\(\)"/);
});

test('V2 import flows use authenticated backend commands instead of local cache',()=>{
  assert.match(services,/importSales: payload => command\('import_sales'/);
  assert.match(services,/importCash: payload => command\('import_cash'/);
  assert.match(services,/importSettings: payload => command\('import_settings'/);
  assert.match(api,/"import_sales", "import_cash", "import_settings"/);
});

test('historical import is idempotent and does not consume current inventory',()=>{
  assert.match(migration,/idempotency_key=p_idempotency_key/);
  assert.match(migration,/source,status[\s\S]*'IMPORT','FULFILLED'/);
  assert.doesNotMatch(migration,/insert into public\.inventory_movements/i);
  assert.doesNotMatch(migration,/insert into public\.inventory_reservations/i);
});
