import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const end = html.indexOf('\n}', start);
  return html.slice(start, end + 2);
}
function run(name, globals, ...args) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(source(name), context);
  return context[name](...args);
}
test('report refresh preserves the chosen date', () => {
  const date = { value: '2026-09-01' };
  run('renderLaporan', { today: () => '2026-10-17', state: {laporanList:[]}, document: {getElementById: id => id === 'laporanTanggal' ? date : {}} });
  assert.equal(date.value, '2026-09-01');
});
test('failed stock save keeps the dialog and entered values', async () => {
  const fields = {editBahanId:'id', editBahanStok:'120', editBahanHargaKemasan:'1', editBahanIsiKemasan:'1', editBahanThreshold:'10'};
  let closed = false;
  await run('simpanEditBahan', {state:{isV2:true}, getBahan:()=>({threshold:10}), ensureSyncedV2Entity:()=>true,
    document:{getElementById:id=>({value:fields[id]})}, runV2Mutation:async()=>false,
    closeModal:()=>{closed=true;}, renderStok:()=>{}, window:{} });
  assert.equal(closed,false);
});
test('sale details use the sale cost including no-ice adjustments', () => {
  let content;
  run('showDetail', { state:{isV2:true,penjualan:[{id:'a',modal:1234,totalHarga:8000}]},
    document:{getElementById:id=>id === 'modalDetailContent' ? {set innerHTML(v){content=v;}} : {}},
    getMenu:()=>({}), hitungModalMenu:()=>9999, rp:String, safeText:String, formatDate:String, openModal:()=>{} }, 'a');
  assert.match(content,/>1234</);
  assert.match(content,/>6766</);
});
test('automatic refresh waits while a form, dialog, or mutation is active', async () => {
  for (const mode of ['input','modal','mutation','refresh']) {
    let calls=0;
    await run('autoRefreshV2', {getToken:()=>true, v2MutationInFlight:mode==='mutation', v2RefreshInFlight:mode==='refresh',
      document:{hidden:false,activeElement:{matches:()=>mode==='input'},querySelector:()=>mode==='modal'?{}:null},
      refreshV2:async()=>{calls++;},renderPage:()=>{},activePage:'dashboard',updateSyncStatus:()=>{} });
    assert.equal(calls,0,mode);
  }
});
test('calculator redraw retains entered cup quantities', () => {
  const input = {value:'7'};
  let content;
  run('renderKalkulator', {state:{menu:[{id:'latte',nama:'Latte'}]},safeText:String,
    document:{getElementById:id=>id==='kalc_latte'?input:{set innerHTML(v){content=v;}}} });
  assert.match(content,/value="7"/);
});
test('a committed operation stays successful when the follow-up sync fails', async () => {
  let writes=0;
  const messages=[];
  const ok = await run('runV2Mutation', {v2MutationInFlight:false, showToast:(text)=>messages.push(text),
    showLoading:()=>{}, refreshV2:async()=>{throw Error('offline');},updateSyncStatus:()=>{},renderPage:()=>{},activePage:'po',hideLoading:()=>{},
  },'Menyimpan...',async()=>{writes++;return {};},'Berhasil disimpan');
  assert.equal(ok,true);
  assert.equal(writes,1);
  assert.ok(messages.some(text=>text.includes('tersimpan') && text.includes('sinkron')));
});
test('bootstrap failure without a cache never exposes sample inventory', async () => {
  let synced;
  const context = vm.createContext({state:{}, window:{kopsusrenServices:{bootstrap:async()=>{throw Error('offline');}}},
    DEFAULT_BAHAN:[{id:'sample'}],DEFAULT_MENU:[{id:'sample'}],showToast:()=>{}, localStorage:{getItem:()=>null,setItem:()=>{}}, showLoading:()=>{},hideLoading:()=>{},updateSyncStatus:v=>{synced=v;},console,
  });
  vm.runInContext(source('legacyStateFromV2') + '\n' + source('getDefaultState') + '\n' + source('loadState'),context);
  await context.loadState();
  assert.equal(context.state.bahan.length,0);
  assert.equal(context.state.menu.length,0);
  assert.equal(context.state.isV2,true);
  assert.equal(synced,false);
});

function appHarness() {
  const nodes = new Map();
  const listeners = {};
  const node = id => {
    if (!nodes.has(id)) {
      let content = '';
      const element = {value:'',textContent:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}},
        setAttribute(){},addEventListener(){},removeEventListener(){},querySelector(){return null;},focus(){},getClientRects(){return [1];},
        parentElement:{},get innerHTML(){return content;},set innerHTML(value){content=value;if(['orderProduct','belBahan','belAccount'].includes(id))this.value='';}};
      nodes.set(id,element);
    }
    return nodes.get(id);
  };
  const context = vm.createContext({console,Intl,Date,URL,Math,JSON,Number,String,Object,Array,
    Chart: class {destroy(){}},document:{getElementById:node,addEventListener(type,callback){listeners[type]=callback;},querySelectorAll:()=>[],querySelector:()=>null},
    window:{addEventListener(){}},sessionStorage:{getItem:()=>null},localStorage:{getItem:()=>null},
  });
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts.at(-1)[1],context);
  vm.runInContext("state = {...getDefaultState(), isV2:true, accounts:[{id:'cash',name:'Kas',type:'CASH',balance:28000}], orders:[],poSessions:[]};", context);
  return {context,node,listeners};
}
test('all nine data pages render from the complete app script', () => {
  const {context}=appHarness();
  for (const page of ['dashboard','po','approval','riwayat','kalkulator','stok','resep','pengeluaran','laporan']) {
    assert.doesNotThrow(()=>context.renderPage(page),page);
  }
});
test('background redraw preserves product, ingredient and payment account selections', () => {
  const {context,node}=appHarness();
  node('orderProduct').value='latte'; context.renderPo();
  assert.equal(node('orderProduct').value,'latte');
  node('belBahan').value='susu';node('belAccount').value='cash';
  context.renderPengeluaran();
  assert.equal(node('belBahan').value,'susu');
  assert.equal(node('belAccount').value,'cash');
});
test('dashboard renders even when the chart CDN is unavailable', () => {
  const {context,node}=appHarness();
  vm.runInContext('Chart = undefined;',context);
  assert.doesNotThrow(()=>context.renderDashboard());
  assert.match(node('chartDashboard').parentElement.innerHTML,/Grafik belum tersedia/);
});
test('failed recipe save leaves the editor open', async () => {
  const {context,node}=appHarness();
  node('editResepId').value='latte';
  vm.runInContext("ensureSyncedV2Entity=()=>true;isUuid=()=>true;runV2Mutation=async()=>false;window.closed=false;closeModal=()=>{window.closed=true;};",context);
  node('editResepHarga').value='8000';
  for (const id of ['kopi','air','susu','es','cup']) node('resep_'+id).value='1';
  await context.simpanEditResep();
  assert.equal(context.window.closed,false);
});
test('cash and expense history show the newest entries first regardless of input order', () => {
  const {context,node}=appHarness();
  vm.runInContext(`state.mutasiKas=[{tanggal:'2026-10-17',waktu:'10:00',keterangan:'TERBARU',jumlah:1,saldo:1,jenis:'masuk'},{tanggal:'2026-10-16',waktu:'10:00',keterangan:'LAMA',jumlah:1,saldo:1,jenis:'masuk'}];
    state.pengeluaranList=[{tanggal:'2026-10-17',keterangan:'TERBARU',jumlah:1,jenis:'masuk'},{tanggal:'2026-10-16',keterangan:'LAMA',jumlah:1,jenis:'masuk'}];`,context);
  context.renderPengeluaran();
  for(const id of ['kasMutasiList','pengeluaranList']) {
    const content=node(id).innerHTML;
    assert.ok(content.indexOf('TERBARU') < content.indexOf('LAMA'),id);
  }
});
test('regenerated reports replace the saved version and exclude ice for no-ice sales', () => {
  const {context,node}=appHarness();
  context.Blob=class {};
  context.URL={createObjectURL:()=> 'blob:preview',revokeObjectURL(){}};
  context.document.createElement=()=>({click(){}});
  context.saveState=()=>{}; context.showToast=()=>{};
  vm.runInContext(`state.penjualan=[{tanggal:'2026-10-17',menuId:'latte',customer:'Uji',jumlah:1,totalHarga:8000,modal:1000,noIce:true}];`,context);
  node('laporanTanggal').value='2026-10-17';
  context.generateLaporan();
  vm.runInContext('state.penjualan[0].totalHarga=9000;',context);
  context.generateLaporan();
  const reports=vm.runInContext('state.laporanList',context);
  assert.equal(reports.length,1);
  assert.equal(reports[0].omzet,9000);
  const usage=reports[0].htmlContent.split('<h2>Estimasi Bahan Terpakai</h2>')[1]?.split('<h2>Informasi Kas</h2>')[0];
  assert.ok(usage);
  assert.doesNotMatch(usage,/Es batu/);
  assert.match(reports[0].htmlContent,/Saldo Kas Saat Laporan Dibuat/);
});
test('transaction tabs support arrow keys, Home and End', () => {
  const {context,listeners}=appHarness();
  let selected=-1;
  const tabs=Array.from({length:3},(_,index)=>({click(){selected=index;},focus(){},closest(){return this;}}));
  context.document.querySelectorAll=()=>tabs;
  for (const [key,start,expected] of [['ArrowRight',2,0],['ArrowLeft',0,2],['Home',2,0],['End',0,2]]) {
    let prevented=false; selected=-1;
    listeners.keydown({key,target:tabs[start],preventDefault(){prevented=true;}});
    assert.equal(selected,expected,key);
    assert.equal(prevented,true,key);
  }
});

const ts = (await import('typescript')).default;
const commands = fs.readFileSync(new URL('../api/v2/commands.ts',import.meta.url),'utf8');
async function importCase(action, rows) {
  const start=commands.indexOf(`case "${action}": {`);
  const end=commands.indexOf('\n      case ',start+1);
  const body=commands.slice(start+`case "${action}": {`.length,end).trim().slice(0,-1);
  const statements=[];
  const tagged=async (parts,...values)=>{
    const query=parts.join('?');
    if(query.includes('from accounts'))return [{id:'cash'}];
    statements.push({query,values});
    return query.includes('jsonb_array_elements') ? rows.map((_,i)=>({id:`id-${i}`})) : [{id:'single'}];
  };
  tagged.json=value=>({json:JSON.parse(JSON.stringify(value))});
  tagged.begin=async callback=>callback(tagged);
  let response;
  const context=vm.createContext({payload:{rows,batchKey:'a'.repeat(64)},sql:tagged,
    importRows:p=>p,resolveProductId:async v=>v,importDate:v=>v,importReferenceUuid:v=>v,
    res:{status(){return this;},json(value){response=value;return value;}}});
  const script=ts.transpile(`(async()=>{${body}})()`,{target:ts.ScriptTarget.ES2022});
  await vm.runInContext(script,context);
  return {statements,response};
}
test('sales import sends one parameterized batch and retains every row idempotency key',async()=>{
  const {statements,response}=await importCase('import_sales',Array.from({length:3},(_,i)=>({customerName:`CUSTOMER-${i}`,productId:'product',unitPrice:8000,date:'2026-10-17'})));
  assert.equal(statements.length,1);
  assert.equal(response.imported,3);
  assert.deepEqual(Array.from(response.ids),['id-0','id-1','id-2']);
  const batch=statements[0].values.find(value=>value?.json)?.json;
  assert.deepEqual(batch.map(row=>row.key),[0,1,2].map(i=>`csv-sale:${'a'.repeat(64)}:${i}`));
  assert.doesNotMatch(statements[0].query,/CUSTOMER-/);
});
test('cash import sends one batch and retains signed amounts and references',async()=>{
  const {statements,response}=await importCase('import_cash',[{amount:5000,date:'2026-10-17'},{amount:-1000,date:'2026-10-17'}]);
  assert.equal(statements.length,1);
  assert.equal(response.imported,2);
  const batch=statements[0].values.find(value=>value?.json)?.json;
  assert.deepEqual(batch.map(row=>row.amount),[5000,-1000]);
  assert.equal(batch[1].referenceId,`csv-cash:${'a'.repeat(64)}:1`);
});
