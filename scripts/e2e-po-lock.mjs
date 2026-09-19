import postgres from 'postgres';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL wajib tersedia');
const db=postgres(process.env.DATABASE_URL,{prepare:false,max:4});
const suffix=Date.now();
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const created=[];

async function create(name,openAt,cutoffAt,limits=[]) {
  const rows=await db`select create_po(${name},${date},${openAt},${cutoffAt},${20},${db.json(limits)},${30}) id`;
  created.push(rows[0].id);
  return rows[0].id;
}

try {
  const existing=await db`select id from po_sessions where status='OPEN' limit 1`;
  if (existing.length) throw new Error('Tutup PO aktif sebelum menjalankan tes PO lock');
  const past=new Date(Date.now()-60_000).toISOString();
  const future=new Date(Date.now()+60*60_000).toISOString();

  const first=await create(`E2E open race A ${suffix}`,past,future);
  const second=await create(`E2E open race B ${suffix}`,past,future);
  const race=await Promise.allSettled([
    db`select set_po_status(${first},'OPEN')`,
    db`select set_po_status(${second},'OPEN')`,
  ]);
  if (race.filter(result=>result.status==='fulfilled').length!==1) throw new Error('Race open manual tidak menghasilkan tepat satu PO aktif');
  const openAfterRace=await db`select id from po_sessions where status='OPEN'`;
  if (openAfterRace.length!==1) throw new Error(`Ada ${openAfterRace.length} PO aktif setelah race manual`);
  await db`select set_po_status(${openAfterRace[0].id},'CLOSED')`;

  const third=await create(`E2E maintenance race ${suffix}`,past,future);
  await Promise.all([db`select run_po_maintenance()`,db`select run_po_maintenance()`]);
  const openAfterMaintenance=await db`select id from po_sessions where status='OPEN' and id in ${db([first,second,third])}`;
  if (openAfterMaintenance.length!==1) throw new Error(`Ada ${openAfterMaintenance.length} PO aktif setelah heartbeat bersamaan`);
  await db`select set_po_status(${openAfterMaintenance[0].id},'CLOSED')`;

  const scheduled=await create(`E2E scheduled guard ${suffix}`,new Date(Date.now()+30*60_000).toISOString(),new Date(Date.now()+90*60_000).toISOString());
  const scheduledAttempt=await Promise.allSettled([db`select set_po_status(${scheduled},'OPEN')`]);
  if (scheduledAttempt[0].status!=='rejected') throw new Error('PO terjadwal bisa dibuka sebelum waktunya');

  const expired=await create(`E2E expired guard ${suffix}`,new Date(Date.now()-120*60_000).toISOString(),new Date(Date.now()-60*60_000).toISOString());
  const expiredAttempt=await Promise.allSettled([db`select set_po_status(${expired},'OPEN')`]);
  if (expiredAttempt[0].status!=='rejected') throw new Error('PO kedaluwarsa bisa dibuka ulang');

  const milkRows=await db`select id from ingredients where code='MILK' limit 1`;
  const milk=milkRows[0]?.id;
  if (!milk) throw new Error('Ingredient MILK tidak ditemukan');
  const partial=await create(`E2E partial availability ${suffix}`,past,future,[{ingredientId:milk,maxQuantity:1,autoCloseThreshold:90}]);
  await db`select set_po_status(${partial},'OPEN')`;
  const availabilityRows=await db`select evaluate_po_availability(${partial},'[]'::jsonb) value`;
  const products=availabilityRows[0].value.products||[];
  const americano=products.find(product=>product.code==='AMERICANO');
  const milkMenu=products.find(product=>product.code==='KSGA');
  if (!americano?.available || milkMenu?.available) throw new Error('Availability per-menu saat susu tidak cukup salah');
  await db`select run_po_maintenance()`;
  const partialRows=await db`select status from po_sessions where id=${partial}`;
  if (partialRows[0]?.status!=='OPEN') throw new Error('PO tertutup padahal Americano masih tersedia');

  console.log(JSON.stringify({
    ok:true,
    oneOpenPoUnderManualRace:true,
    oneOpenPoUnderHeartbeatRace:true,
    scheduledOpenGuard:true,
    expiredOpenGuard:true,
    oneUnavailableIngredientDoesNotCloseWholePo:true,
  },null,2));
} finally {
  for (const id of created) {
    const rows=await db`select status from po_sessions where id=${id}`;
    if (!rows.length) continue;
    if (rows[0].status==='OPEN') await db`select set_po_status(${id},'CLOSED')`;
    else if (!['CLOSED','COMPLETED','CANCELLED'].includes(rows[0].status)) await db`select set_po_status(${id},'CANCELLED')`;
  }
  await db.end();
}
