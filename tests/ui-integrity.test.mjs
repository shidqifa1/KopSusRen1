import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('all inline UI handlers resolve to declared functions',()=>{
  const handlers=[...html.matchAll(/on(?:click|change|input|submit)="([A-Za-z_$][\w$]*)\s*\(/g)].map(match=>match[1]);
  const functions=new Set([...html.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match=>match[1]));
  assert.deepEqual([...new Set(handlers)].filter(name=>!functions.has(name)),[]);
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
  assert.match(html,/id="page-pengeluaran"[\s\S]*id="saldoKasDisplay"[\s\S]*id="importKasFile"[\s\S]*id="kasMutasiList"/);
});

test('mutations always reload a complete authoritative snapshot',()=>{
  assert.match(html,/async function refreshV2\(\)[\s\S]*kopsusrenServices\.bootstrap\(\)/);
  assert.doesNotMatch(html,/bootstrap\(scope\)|scope === 'po'/);
});

test('retired external report uploader is absent',()=>{
  assert.doesNotMatch(html,/script\.google\.com|uploadLaporanKeDrive/);
});
