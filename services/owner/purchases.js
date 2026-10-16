// Purchase drafts live in the existing owner conversation; only exact Y can commit.
export async function loadPurchaseCatalog(db) {
  const ingredients=await db`select id,name,unit from ingredients where is_active order by name limit 200`;
  const accounts=await db`select id,name from accounts where is_active order by name limit 50`;
  return {ingredients,accounts};
}
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k));
export function validatePurchase(draft,catalog) {
  if(!keys(draft,['intent','account_id','questions','items'])||!['PURCHASE','OTHER'].includes(draft.intent)
    ||!(draft.account_id===null||typeof draft.account_id==='string')||!Array.isArray(draft.questions)
    ||draft.questions.length>10||draft.questions.some(x=>typeof x!=='string'||x.length>300)
    ||!Array.isArray(draft.items)||draft.items.length>20) throw Error('Format belanja tidak valid. Kirim ulang detailnya.');
  const questions=[...draft.questions];
  const account=catalog.accounts.find(x=>x.id===draft.account_id);
  if(!account) questions.push(`Bayar dari akun mana? Pilihan: ${catalog.accounts.map(x=>x.name).join(', ')}.`);
  const lines=draft.items.map(item=>{
    if(!keys(item,['ingredient_id','brand','quantity','count','unit','total_cost','approximate'])
      ||!(item.brand===null||typeof item.brand==='string'&&item.brand.length<=100)
      ||typeof item.approximate!=='boolean'||!['ML','L','G','KG','PCS'].includes(item.unit)
      ||![item.quantity,item.count,item.total_cost].every(x=>x===null||typeof x==='number'&&Number.isFinite(x)&&x>0)
      ||item.count!==null&&(!Number.isInteger(item.count)||item.count>10000)) throw Error('Detail belanja tidak valid. Kirim ulang jumlah, satuan, dan harga total.');
    const ingredient=catalog.ingredients.find(x=>x.id===item.ingredient_id);
    if(!ingredient) throw Error('Bahan belum cocok dengan katalog. Sebut nama bahan sesuai /stok list.');
    const scales={ML:['volume',1],L:['volume',1000],G:['weight',1],KG:['weight',1000],PCS:['count',1]};
    const target=scales[ingredient.unit];
    if(!target||target[0]!==scales[item.unit][0]) throw Error(`Satuan ${ingredient.name} tidak cocok.`);
    const quantity=item.quantity===null||item.count===null?null:Math.round(item.quantity*item.count*scales[item.unit][1]/target[1]*1000)/1000;
    if(quantity===null||!quantity||item.total_cost===null) questions.push(`Lengkapi jumlah, isi kemasan, dan harga total ${ingredient.name}.`);
    if(quantity>99999999999||item.total_cost>9999999999) throw Error('Jumlah atau biaya terlalu besar.');
    return {...item,name:ingredient.name,quantity,unit:ingredient.unit};
  });
  if(!lines.length) questions.push('Bahan apa saja yang sudah dibeli?');
  const total=lines.reduce((sum,line)=>sum+(line.total_cost||0),0);
  if(total>9999999999)throw Error('Total belanja terlalu besar.');
  return {draft,account,lines,total,questions:[...new Set(questions)]};
}
const rupiah=value=>`Rp${Number(value).toLocaleString('id-ID')}`;
export function formatPurchase(purchase) {
  return ['Rangkuman belanja (belum dicatat):',...purchase.lines.map(x=>
    `• ${x.name}${x.brand?` (${x.brand})`:''}: ${x.quantity??'?'} ${x.unit}${x.approximate?' (perkiraan; Y menyetujui angka ini)':''} — ${x.total_cost===null?'harga belum jelas':rupiah(x.total_cost)}`),
    `Total: ${rupiah(purchase.total)}${purchase.account?` · akun ${purchase.account.name}`:''}.`,
    ...(purchase.questions.length?['Lengkapi dulu:',...purchase.questions]:['Stok bertambah dan saldo akun berkurang sesuai rincian ini. Balas Y untuk catat, N untuk batal. Berlaku 5 menit.']),
    ...(purchase.questions.length?['Balas detail yang kurang, atau N untuk batal.']:[])].join('\n');
}
export async function executePurchase(db,draft,key) {
  // The caller already holds the owner lock in a transaction. Roll back every line on failure.
  return db.savepoint(async tx=>{
    const existing=await tx`select id from purchases where idempotency_key=${key}`;
    if(existing.length)return {replyText:`Belanja sudah tercatat (${existing[0].id}); tidak dicatat dua kali.`};
    const catalog=await loadPurchaseCatalog(tx);
    const purchase=validatePurchase(draft,catalog);
    if(draft.intent!=='PURCHASE'||purchase.questions.length)throw Error('Detail belanja belum lengkap. Belum ada perubahan.');
    // Keep catalog rows active and stable until the transaction commits.
    const accounts=await tx`select id from accounts where id=${purchase.account.id} and is_active for share`;
    if(!accounts.length)throw Error('Akun sudah tidak aktif.');
    for(const line of purchase.lines){
      const rows=await tx`select id from ingredients where id=${line.ingredient_id} and is_active and unit=${line.unit} for share`;
      if(!rows.length)throw Error('Data bahan berubah; kirim ulang belanjanya.');
    }
    const notes=formatPurchase(purchase).replace('Rangkuman belanja (belum dicatat):','Belanja WhatsApp:').split('\nStok bertambah')[0];
    const [saved]=await tx`insert into purchases(account_id,total_amount,source,status,notes,idempotency_key)
      values(${purchase.account.id},${purchase.total},'WHATSAPP','CONFIRMED',${notes},${key}) returning id`;
    for(const line of purchase.lines){
      await tx`insert into purchase_items(purchase_id,ingredient_id,quantity,total_cost) values(${saved.id},${line.ingredient_id},${line.quantity},${line.total_cost})`;
      await tx`insert into inventory_movements(ingredient_id,quantity_delta,movement_type,reference_type,reference_id,note)
        values(${line.ingredient_id},${line.quantity},'PURCHASE','purchase',${saved.id},${`${line.name} ${line.brand||''}${line.approximate?' (perkiraan disetujui owner)':''}`})`;
    }
    await tx`insert into ledger_entries(account_id,amount,entry_type,reference_type,reference_id,description)
      values(${purchase.account.id},${-purchase.total},'EXPENSE','purchase',${saved.id},${'Belanja bahan via WhatsApp'})`;
    await tx`insert into audit_logs(event_type,entity_type,entity_id,payload)
      values('PURCHASE_RECORDED','purchase',${saved.id},${tx.json({source:'WHATSAPP',idempotency_key:key})}::jsonb)`;
    return {replyText:`Belanja ${rupiah(purchase.total)} tercatat. ${purchase.lines.length} bahan masuk stok, saldo ${purchase.account.name} berkurang. ID: ${saved.id}`};
  });
}
