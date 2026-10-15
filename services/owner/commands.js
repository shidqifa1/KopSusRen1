import { OWNER_READ_COMMANDS,OWNER_WRITE_COMMANDS } from './llm.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SELECTORS=new Set(['aktif','hari-ini','besok']);
const UNITS=new Set(['ML','L','G','KG','PCS']);

function unsafeCommand(value) {
  return /[\r\n;&|`$<>\\]/.test(value)||value.includes('..')||value.length>180;
}

function selector(value) {
  const normalized=String(value||'').toLowerCase();
  return SELECTORS.has(normalized)||UUID.test(normalized)?normalized:null;
}

function positiveNumber(value) {
  const number=Number(value);
  return Number.isFinite(number)&&number>0?number:null;
}

export function parseOwnerCommand(input) {
  const raw=String(input||'').trim().replace(/\s+/g,' ');
  if (!raw.startsWith('/')||unsafeCommand(raw)) return {ok:false,error:'Command tidak valid. Pakai /help untuk melihat format command.'};
  const tokens=raw.split(' ');
  const head=tokens[0].toLowerCase();
  const verb=tokens[1]?.toLowerCase();
  if (raw==='/help') return {ok:true,kind:'READ',action:'HELP',args:{},command:'/help'};
  if (head==='/menu'&&verb==='list'&&tokens.length===2) return {ok:true,kind:'READ',action:'MENU_LIST',args:{},command:'/menu list'};
  if (head==='/stok'&&verb==='list'&&tokens.length===2) return {ok:true,kind:'READ',action:'STOCK_LIST',args:{},command:'/stok list'};
  if (head==='/stok'&&verb==='lihat'&&tokens.length===3) return {ok:true,kind:'READ',action:'STOCK_GET',args:{item:tokens[2]},command:`/stok lihat ${tokens[2]}`};
  if (head==='/po'&&verb==='list'&&tokens.length===2) return {ok:true,kind:'READ',action:'PO_LIST',args:{},command:'/po list'};
  if (head==='/po'&&verb==='status'&&tokens.length===3&&selector(tokens[2])) return {ok:true,kind:'READ',action:'PO_STATUS',args:{selector:selector(tokens[2])},command:`/po status ${selector(tokens[2])}`};
  if (head==='/order'&&['list','unpaid'].includes(verb)&&tokens.length===3&&selector(tokens[2])) {
    return {ok:true,kind:'READ',action:verb==='list'?'ORDER_LIST':'ORDER_UNPAID',args:{selector:selector(tokens[2])},command:`/order ${verb} ${selector(tokens[2])}`};
  }
  if (head==='/produksi'&&tokens.length===2&&selector(tokens[1])) return {ok:true,kind:'READ',action:'PRODUCTION',args:{selector:selector(tokens[1])},command:`/produksi ${selector(tokens[1])}`};
  if (head==='/stok'&&['tambah','kurang'].includes(verb)&&tokens.length===5) {
    const quantity=positiveNumber(tokens[3]);
    const unit=tokens[4].toUpperCase()==='GR'?'G':tokens[4].toUpperCase();
    if (!quantity||!UNITS.has(unit)) return {ok:false,error:'Format stok: /stok tambah|kurang <item> <qty> <ML|L|G|KG|PCS>'};
    return {ok:true,kind:'WRITE',action:'STOCK_ADJUST',args:{item:tokens[2],quantity,unit,direction:verb==='tambah'?1:-1},command:`/stok ${verb} ${tokens[2]} ${quantity} ${unit.toLowerCase()}`};
  }
  if (head==='/po'&&verb==='buka'&&tokens.length===6) {
    const date=tokens[2]; const openTime=tokens[3]; const closeTime=tokens[4]; const maxCups=positiveNumber(tokens[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(openTime)||!/^\d{2}:\d{2}$/.test(closeTime)||!Number.isInteger(maxCups)) {
      return {ok:false,error:'Format PO: /po buka <YYYY-MM-DD> <HH:MM> <HH:MM> <max-cup>'};
    }
    return {ok:true,kind:'WRITE',action:'PO_OPEN',args:{date,openTime,closeTime,maxCups},command:`/po buka ${date} ${openTime} ${closeTime} ${maxCups}`};
  }
  if (head==='/po'&&verb==='tutup'&&tokens.length===3&&selector(tokens[2])) return {ok:true,kind:'WRITE',action:'PO_CLOSE',args:{selector:selector(tokens[2])},command:`/po tutup ${selector(tokens[2])}`};
  if (head==='/bayar'&&['konfirmasi','tolak'].includes(verb)&&tokens.length===3&&Number.isInteger(Number(tokens[2]))&&Number(tokens[2])>0) {
    return {ok:true,kind:'WRITE',action:verb==='konfirmasi'?'PAYMENT_CONFIRM':'PAYMENT_REJECT',args:{orderNumber:Number(tokens[2])},command:`/bayar ${verb} ${Number(tokens[2])}`};
  }
  if (head==='/order'&&verb==='batal'&&tokens.length===3&&Number.isInteger(Number(tokens[2]))&&Number(tokens[2])>0) {
    return {ok:true,kind:'WRITE',action:'ORDER_CANCEL',args:{orderNumber:Number(tokens[2])},command:`/order batal ${Number(tokens[2])}`};
  }
  return {ok:false,error:'Command tidak dikenal atau argumennya belum lengkap. Pakai /help.'};
}

function jakartaDate(offsetDays=0) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const date=new Date(`${values.year}-${values.month}-${values.day}T00:00:00+07:00`);
  date.setUTCDate(date.getUTCDate()+offsetDays);
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}

async function resolvePo(db,value) {
  let rows=[];
  if (value==='aktif') rows=await db`select id,name,delivery_date,status,open_at,cutoff_at,max_total_cups from po_sessions where status='OPEN' order by created_at desc limit 2`;
  else if (value==='hari-ini'||value==='besok') rows=await db`select id,name,delivery_date,status,open_at,cutoff_at,max_total_cups from po_sessions where delivery_date=${jakartaDate(value==='besok'?1:0)}::date and status not in ('COMPLETED') order by created_at desc limit 2`;
  else rows=await db`select id,name,delivery_date,status,open_at,cutoff_at,max_total_cups from po_sessions where id=${value}::uuid limit 2`;
  if (rows.length!==1) throw new Error(rows.length?'Selector PO cocok ke lebih dari satu sesi. Pakai po-id.':'PO yang dimaksud tidak ditemukan.');
  return rows[0];
}

function normalizeItem(value) {
  return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
}

async function resolveIngredient(db,token) {
  const rows=await db`select ingredient_id id,name,unit,available_stock::float8 available_stock,low_stock_threshold::float8 threshold from inventory_stock order by name`;
  const matches=rows.filter(row=>normalizeItem(row.name)===normalizeItem(token));
  if (matches.length!==1) throw new Error(matches.length?'Nama bahan ambigu. Pakai nama bahan yang lebih spesifik.':'Bahan tidak ditemukan. Pakai /stok list untuk melihat nama bahan.');
  return matches[0];
}

function convertQuantity(quantity,from,to) {
  if (from===to) return quantity;
  if (from==='L'&&to==='ML') return quantity*1000;
  if (from==='ML'&&to==='L') return quantity/1000;
  if (from==='KG'&&to==='G') return quantity*1000;
  if (from==='G'&&to==='KG') return quantity/1000;
  return null;
}

export function ownerCommandHelp() {
  return ['Command owner:',...OWNER_READ_COMMANDS,...OWNER_WRITE_COMMANDS].join('\n');
}

export async function executeOwnerReadCommand(db,parsed) {
  if (!parsed?.ok||parsed.kind!=='READ') throw new Error('Read command tidak valid.');
  if (parsed.action==='HELP') return {command:parsed.command,type:'HELP',data:{text:ownerCommandHelp()}};
  if (parsed.action==='MENU_LIST') {
    const rows=await db`select code,name,price::float8 price from products where is_active order by name limit 100`;
    return {command:parsed.command,type:'MENU',data:rows};
  }
  if (parsed.action==='STOCK_LIST') {
    const rows=await db`select name,unit,available_stock::float8 available_stock,low_stock_threshold::float8 threshold from inventory_stock order by name limit 100`;
    return {command:parsed.command,type:'STOCK',data:rows};
  }
  if (parsed.action==='STOCK_GET') return {command:parsed.command,type:'STOCK',data:[await resolveIngredient(db,parsed.args.item)]};
  if (parsed.action==='PO_LIST') {
    const rows=await db`select id,name,delivery_date,status,open_at,cutoff_at,max_total_cups from po_sessions order by delivery_date desc,created_at desc limit 50`;
    return {command:parsed.command,type:'PO_LIST',data:rows};
  }
  const po=await resolvePo(db,parsed.args.selector);
  if (parsed.action==='PO_STATUS') {
    const rows=await db`select get_po_summary(${po.id}) as summary`;
    return {command:parsed.command,type:'PO_STATUS',data:{po,summary:rows[0]?.summary||null}};
  }
  if (parsed.action==='ORDER_LIST'||parsed.action==='ORDER_UNPAID') {
    const unpaid=parsed.action==='ORDER_UNPAID';
    const rows=await db`select o.order_number,o.status,o.total_amount::float8 total_amount,c.name,c.class_name,p.method,p.status payment_status
      from orders o join customers c on c.id=o.customer_id left join payments p on p.order_id=o.id
      where o.po_session_id=${po.id} and (${unpaid}=false or p.status in ('PENDING','UNPAID')) order by o.created_at limit 100`;
    return {command:parsed.command,type:unpaid?'ORDER_UNPAID':'ORDER_LIST',data:{po,orders:rows}};
  }
  if (parsed.action==='PRODUCTION') {
    const rows=await db`select get_po_summary(${po.id}) as summary`;
    return {command:parsed.command,type:'PRODUCTION',data:{po,summary:rows[0]?.summary||null}};
  }
  throw new Error('Read command belum didukung.');
}

export async function executeOwnerWriteCommand(db,parsed) {
  if (!parsed?.ok||parsed.kind!=='WRITE') throw new Error('Write command tidak valid.');
  if (parsed.action==='STOCK_ADJUST') {
    const ingredient=await resolveIngredient(db,parsed.args.item);
    const quantity=convertQuantity(parsed.args.quantity,parsed.args.unit,String(ingredient.unit).toUpperCase());
    if (!quantity) throw new Error(`Satuan tidak cocok dengan ${ingredient.name} (${ingredient.unit}).`);
    const delta=parsed.args.direction*quantity;
    await db`select adjust_inventory(${ingredient.id},${delta},${`Owner CLI: ${parsed.command}`}) as id`;
    return {replyText:`Stok ${ingredient.name} disesuaikan ${delta>0?'+':''}${delta} ${ingredient.unit}.`};
  }
  if (parsed.action==='PO_OPEN') {
    const {date,openTime,closeTime,maxCups}=parsed.args;
    const openAt=new Date(`${date}T${openTime}:00+07:00`);
    let closeAt=new Date(`${date}T${closeTime}:00+07:00`);
    if (!Number.isFinite(openAt.getTime())||!Number.isFinite(closeAt.getTime())) throw new Error('Tanggal atau jam PO tidak valid.');
    if (closeAt<=openAt) closeAt=new Date(closeAt.getTime()+86400000);
    if (closeAt<=new Date()) throw new Error('Jam tutup PO sudah lewat.');
    const rows=await db`select create_po(${`PO ${date}`},${date},${openAt.toISOString()},${closeAt.toISOString()},${maxCups},${JSON.stringify([])}::jsonb,${30}) id`;
    if (openAt<=new Date()) await db`select set_po_status(${rows[0].id},'OPEN') id`;
    return {replyText:`PO ${date} dibuat, buka ${openTime} dan tutup ${closeTime}, maksimal ${maxCups} cup.`};
  }
  if (parsed.action==='PO_CLOSE') {
    const po=await resolvePo(db,parsed.args.selector);
    await db`select set_po_status(${po.id},'CLOSED') id`;
    return {replyText:`${po.name} sudah ditutup.`};
  }
  if (['PAYMENT_CONFIRM','PAYMENT_REJECT','ORDER_CANCEL'].includes(parsed.action)) {
    const rows=await db`select o.id,o.order_number,o.status,coalesce(o.customer_phone,c.phone) customer_phone,p.status payment_status,p.proof_received_at
      from orders o join customers c on c.id=o.customer_id left join payments p on p.order_id=o.id
      where o.order_number=${parsed.args.orderNumber} limit 2`;
    if (rows.length!==1) throw new Error('Order tidak ditemukan.');
    const order=rows[0];
    if (parsed.action==='PAYMENT_CONFIRM') {
      if (order.payment_status!=='PENDING') throw new Error('Payment order ini tidak berstatus PENDING.');
      if (!order.proof_received_at) throw new Error('Bukti pembayaran QRIS belum diterima.');
      await db`select confirm_cash_payment(${order.id}) id`;
      return {replyText:`Pembayaran order #${order.order_number} dikonfirmasi.`,customerNotifications:order.customer_phone?[{phone:order.customer_phone,text:`Pembayaran QRIS order #${order.order_number} sudah masuk. Pesanan kamu sudah dikonfirmasi ya.`}]:[]};
    }
    const reason=parsed.action==='PAYMENT_REJECT'?'Pembayaran ditolak owner':'Dibatalkan owner via WhatsApp';
    await db`select cancel_order(${order.id},${reason}) id`;
    return {replyText:`Order #${order.order_number} dibatalkan.`,customerNotifications:order.customer_phone?[{phone:order.customer_phone,text:`Order #${order.order_number} dibatalkan oleh owner.`}]:[]};
  }
  throw new Error('Write command belum didukung.');
}

export function formatOwnerReadResult(result) {
  if (result.type==='HELP') return result.data.text;
  if (result.type==='MENU') return result.data.length?['Menu aktif:',...result.data.map(row=>`• ${row.name} — Rp${Number(row.price).toLocaleString('id-ID')}`)].join('\n'):'Belum ada menu aktif.';
  if (result.type==='STOCK') return result.data.length?['Stok tersedia:',...result.data.map(row=>`• ${row.name}: ${Number(row.available_stock)} ${row.unit}${Number(row.available_stock)<=Number(row.threshold)?' ⚠️':''}`)].join('\n'):'Stok tidak ditemukan.';
  if (result.type==='PO_LIST') return result.data.length?['Daftar PO:',...result.data.map(row=>`• ${row.name} · ${row.delivery_date} · ${row.status}`)].join('\n'):'Belum ada PO.';
  return JSON.stringify(result.data,null,2).slice(0,4000);
}
