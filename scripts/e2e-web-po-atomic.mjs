import { createHmac } from 'node:crypto';
import postgres from 'postgres';

const baseUrl=process.argv[2]||'https://kopsusren-v2.vercel.app';
if (!process.env.DATABASE_URL||!process.env.AUTH_SECRET||!process.env.VALID_USERNAME) throw new Error('Environment test belum lengkap');
const db=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
const now=Math.floor(Date.now()/1000);
const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const body=Buffer.from(JSON.stringify({sub:process.env.VALID_USERNAME,iat:now,exp:now+300})).toString('base64url');
const signature=createHmac('sha256',process.env.AUTH_SECRET).update(`${header}.${body}`).digest('base64url');
const token=`${header}.${body}.${signature}`;
const name=`E2E rejected PO ${Date.now()}`;

try {
  const ingredients=await db`select id from ingredients where is_active`;
  const deliveryDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const response=await fetch(`${baseUrl}/api/v2/commands`,{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({action:'create_po',payload:{
      name,deliveryDate,
      openAt:new Date(Date.now()-60_000).toISOString(),
      cutoffAt:new Date(Date.now()+60*60_000).toISOString(),
      maxTotalCups:20,qrisTimeoutMinutes:30,
      ingredientLimits:ingredients.map(item=>({ingredientId:item.id,maxQuantity:0.001,autoCloseThreshold:90})),
    }}),
  });
  const result=await response.json();
  if (response.ok||result.ok!==false) throw new Error('PO mustahil justru diterima');
  const rows=await db`select id,status from po_sessions where name=${name}`;
  if (rows.length) throw new Error(`PO gagal meninggalkan ${rows.length} row yatim`);
  console.log(JSON.stringify({ok:true,rejectedByCapacity:true,noOrphanDraft:true,error:result.error},null,2));
} finally {
  await db.end();
}
