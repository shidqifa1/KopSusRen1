import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const manifest=fs.readFileSync(new URL('../manifest.json',import.meta.url),'utf8');
const styles=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const design=fs.readFileSync(new URL('../DESIGN.md',import.meta.url),'utf8');

test('all inline UI handlers resolve to declared functions',()=>{
  const handlers=[...html.matchAll(/on(?:click|change|input|submit)="([A-Za-z_$][\w$]*)\s*\(/g)].map(match=>match[1]);
  const functions=new Set([...html.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match=>match[1]));
  assert.deepEqual([...new Set(handlers)].filter(name=>!functions.has(name)),[]);
});

test('all inline script blocks compile',()=>{
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(match=>!/^<script[^>]*\ssrc=/i.test(match[0]))
    .map(match=>match[1]);
  for (const script of scripts) assert.doesNotThrow(()=>new Function(script));
});

test('static DOM ids are unique and every direct id lookup exists',()=>{
  const allIds=[...html.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  const counts=allIds.reduce((result,id)=>({...result,[id]:(result[id]||0)+1}),{});
  assert.deepEqual(Object.entries(counts).filter(([,count])=>count>1),[]);
  const ids=new Set(allIds);
  const lookups=[...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match=>match[1]);
  assert.deepEqual([...new Set(lookups)].filter(id=>!ids.has(id)),[]);
});

test('cash operations are consolidated without a duplicate Kas Usaha page',()=>{
  assert.doesNotMatch(html,/id="page-kas"|goPage\('kas'\)|>Kas Usaha</);
  assert.match(html,/id="page-pengeluaran"[\s\S]*id="saldoKasDisplay"[\s\S]*id="kasMutasiList"/);
  assert.match(html,/id="page-pengaturan"[\s\S]*id="settingsImportCashButton"[\s\S]*id="importKasFile"/);
});

test('mutations always reload a complete authoritative snapshot',()=>{
  assert.match(html,/async function refreshV2\(\)[\s\S]*kopsusrenServices\.bootstrap\(\)/);
  assert.doesNotMatch(html,/bootstrap\(scope\)|scope === 'po'/);
});

test('retired external report uploader is absent',()=>{
  assert.doesNotMatch(html,/script\.google\.com|uploadLaporanKeDrive/);
});

test('PO form opens immediately with a 17:50 default cutoff',()=>{
  assert.doesNotMatch(html,/id="poDate"|id="poOpenAt"|id="poQrisTimeout"/);
  assert.match(html,/id="poCutoffAt"[^>]*value="17:50"/);
  assert.match(html,/id="modalBukaPo"[\s\S]*id="poMaxCups"[\s\S]*id="poMilkLimit"[\s\S]*id="poMatchaLimit"/);
  assert.match(html,/kopsusrenServices\.openPoNow/);
  assert.doesNotMatch(html,/Belum ada kebutuhan produksi|Order PO yang aktif akan diringkas otomatis/);
});

test('customer-facing web and PWA branding use Baristack App',()=>{
  assert.match(html,/<title>Baristack App<\/title>/);
  assert.match(html,/<h2 class="serif" id="loginTitle">Baristack App<\/h2>/);
  assert.match(html,/<h1>Baristack App<\/h1>/);
  assert.doesNotMatch(html,/>Kopi Manager</);
  const parsed=JSON.parse(manifest);
  assert.equal(parsed.name,'Baristack App');
  assert.equal(parsed.short_name,'Baristack');
});

test('viewport and authentication shell remain accessible',()=>{
  const documentHead=html.slice(0,html.indexOf('</head>'));
  assert.equal([...documentHead.matchAll(/<meta name="viewport"/g)].length,1);
  assert.doesNotMatch(documentHead,/user-scalable\s*=\s*no|maximum-scale/);
  assert.match(html,/<body class="auth-locked">/);
  assert.match(styles,/body\.auth-locked[\s\S]*\.page[\s\S]*display:\s*none\s*!important/);
});

test('navigation and dialogs expose keyboard semantics',()=>{
  assert.doesNotMatch(html,/<div class="nav-item/);
  assert.match(html,/<button type="button" class="nav-item active"[^>]*aria-current="page"/);
  assert.match(html,/id="menuButton"[^>]*aria-controls="navDrawer"[^>]*aria-expanded="false"/);
  assert.equal([...html.matchAll(/role="dialog"/g)].length,4);
  assert.equal([...html.matchAll(/aria-modal="true"/g)].length,4);
  assert.match(html,/event\.key === 'Escape'[\s\S]*closeModal/);
  assert.match(html,/function getFocusableElements\(/);
});

test('focus, touch targets, and contrast tokens keep their accessibility guards',()=>{
  assert.doesNotMatch(styles,/:focus\s*\{[\s\S]*?outline:\s*(?:none|0)/);
  assert.match(styles,/:focus-visible\s*\{[\s\S]*outline:\s*3px solid/);
  assert.match(styles,/\.btn\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(styles,/\.modal-close\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(styles,/--abu2:\s*#746B63/);
  assert.match(styles,/--kuning:\s*#A64B00/);
  assert.doesNotMatch(html,/syncStatus[\s\S]{0,800}style\.color/);
});

test('UI copy avoids decorative emoji and has documented direction',()=>{
  assert.doesNotMatch(html,/[\p{Extended_Pictographic}]/u);
  assert.doesNotMatch(html,/—/u);
  assert.match(design,/## Visual decisions and reasons/);
  assert.match(design,/ENERGY 1/);
  assert.match(design,/RHYTHM 1/);
  assert.match(design,/MOTION 1/);
});
