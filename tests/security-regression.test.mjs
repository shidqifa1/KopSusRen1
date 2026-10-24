import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const root=new URL('../',import.meta.url);
const authSource=fs.readFileSync(new URL('api/auth.ts',root),'utf8');
function authHarness(){
 let now=0,verifications=0;
 const context=vm.createContext({Date:class extends Date{static now(){return now;}},Map,String,Math,Array,
  process:{env:{VALID_USERNAME:'owner',VALID_PASSWORD_HASH:'test-hash',AUTH_SECRET:'test-secret'},versions:{node:'22.23.4'}},
  verifyPassword(password){verifications++;if(typeof password!=='string')throw Error('password type');return password==='correct';},
  createToken:()=> 'test-token',verifyToken:token=>({valid:token==='valid',username:'owner'}),extractToken:req=>req.headers.authorization?.replace('Bearer ','')||null,
 });
 const source=authSource.replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
 vm.runInContext(ts.transpile(source,{target:ts.ScriptTarget.ES2022}),context);
 return {advance(ms){now+=ms;},get verifications(){return verifications;},async request(body,method='POST',token){
  let status,data;const headers={};
  await context.handler({method,body,headers:{...(token?{authorization:`Bearer ${token}`}:{})},socket:{remoteAddress:'127.0.0.1'}},
   {status(code){status=code;return this;},json(value){data=value;return this;},send(value){data=value;return this;},setHeader(k,v){headers[k]=v;}});
  return {status,data,headers};
 }};
}

test('malformed anonymous login cannot throw or reach password hashing',async()=>{
 const app=authHarness();
 for(const password of [{},[],42,true]){
  const result=await app.request({username:'owner',password});
  assert.equal(result.status,400);
 }
 assert.equal((await app.request({username:{toString:null},password:"probe"})).status,400);
 assert.equal(app.verifications,0);
});

test('login lockout lasts the full block even when the counting window expires',async()=>{
 const app=authHarness();
 for(let i=0;i<5;i++)assert.equal((await app.request({username:'owner',password:'wrong'})).status,401);
 app.advance(10*60*1000+1);
 assert.equal((await app.request({username:'owner',password:'correct'})).status,429);
 assert.equal(app.verifications,5);
 app.advance(5*60*1000);
 assert.equal((await app.request({username:'owner',password:'correct'})).status,200);
});

test('runtime diagnostics require an authenticated owner session',async()=>{
 const app=authHarness();
 assert.equal((await app.request(undefined,'GET')).status,401);
 const valid=await app.request(undefined,'GET','valid');
 assert.equal(valid.status,200);assert.equal(valid.data.nodeVersion,'22.23.4');
 assert.equal(valid.headers['Cache-Control'],'no-store');
});

test('media parsers and production Node image meet the security patch floor',()=>{
 const lock=JSON.parse(fs.readFileSync(new URL('package-lock.json',root),'utf8'));
 const atLeast=(version,min)=>version.localeCompare(min,undefined,{numeric:true})>=0;
 assert.ok(atLeast(lock.packages['node_modules/sharp'].version,'0.35.5'));
 assert.ok(atLeast(lock.packages['node_modules/music-metadata'].version,'11.16.0'));
 const docker=fs.readFileSync(new URL('Dockerfile',root),'utf8');
 const versions=[...docker.matchAll(/FROM node:([\d.]+)-bookworm-slim/g)].map(m=>m[1]);
 assert.equal(versions.length,2);
 assert.ok(versions.every(v=>atLeast(v,'22.23.4')));
});
