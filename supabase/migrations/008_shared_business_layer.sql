-- Kopi Manager remains the only business database. Chatbot state is additive
-- and all order/inventory decisions stay in these shared RPCs.

alter table public.po_sessions
  add column if not exists open_at timestamptz,
  add column if not exists qris_timeout_minutes integer not null default 30
    check (qris_timeout_minutes between 1 and 1440);

update public.po_sessions
set open_at = coalesce(open_at, created_at)
where open_at is null;

alter table public.order_drafts
  add column if not exists po_session_id uuid references public.po_sessions(id) on delete set null,
  add column if not exists payment_method text
    check (payment_method is null or payment_method in ('CASH','QRIS'));

alter table public.payments
  add column if not exists expires_at timestamptz,
  add column if not exists proof_received_at timestamptz;

create index if not exists payments_pending_expiry_idx
  on public.payments(expires_at)
  where status = 'PENDING' and proof_received_at is null;

alter table public.products
  add column if not exists chatbot_metadata jsonb not null default '{}'::jsonb;

update public.products
set chatbot_metadata = case upper(code)
  when 'KSGA' then jsonb_build_object(
    'aliases', jsonb_build_array('kopsus','kopi susu','gula aren','kopsus aren','kopi susu gula aren'),
    'tags', jsonb_build_array('creamy','manis','kopi','susu'),
    'description', 'Creamy, manis gula aren, dan rasa kopi tidak terlalu pahit.'
  )
  when 'LATTE' then jsonb_build_object(
    'aliases', jsonb_build_array('latte','coffee latte','kopi latte','cafe latte'),
    'tags', jsonb_build_array('creamy','kopi','susu','tidak manis'),
    'description', 'Creamy, tidak terlalu pahit, dan tanpa pemanis pada resep standar.'
  )
  when 'AMERICANO' then jsonb_build_object(
    'aliases', jsonb_build_array('americano','amer','kopi hitam','long black'),
    'tags', jsonb_build_array('strong','kopi','tidak manis','tanpa susu'),
    'description', 'Rasa kopi paling kuat, tidak manis, dan tanpa susu.'
  )
  when 'MATCHA' then jsonb_build_object(
    'aliases', jsonb_build_array('matcha','matcha latte','macha','green tea'),
    'tags', jsonb_build_array('creamy','manis','non kopi','susu'),
    'description', 'Matcha creamy dengan susu dan bukan minuman kopi.'
  )
  else chatbot_metadata
end
where chatbot_metadata = '{}'::jsonb;

alter table public.chat_messages
  add column if not exists dedupe_key text,
  add column if not exists delivery_status text
    check (delivery_status is null or delivery_status in ('PENDING','SENT','FAILED')),
  add column if not exists sent_at timestamptz;

create unique index if not exists chat_messages_dedupe_key_idx
  on public.chat_messages(dedupe_key)
  where dedupe_key is not null;

create table if not exists public.chat_gateway_status (
  provider text primary key,
  status text not null check (status in ('CONNECTED','DISCONNECTED','DEGRADED')),
  last_heartbeat_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.chat_gateway_status enable row level security;
revoke all on public.chat_gateway_status from anon, authenticated;

-- Returns the authoritative live capacity snapshot. proposedItems uses:
-- [{"productId":"uuid","quantity":2,"noIce":false}]
create or replace function public.evaluate_po_availability(
  p_po_session_id uuid,
  p_proposed_items jsonb default '[]'::jsonb
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_po public.po_sessions%rowtype;
  v_ordered_cups integer := 0;
  v_remaining_cups integer := 2147483647;
  v_errors jsonb := '[]'::jsonb;
  v_products jsonb := '[]'::jsonb;
  v_requirements jsonb := '[]'::jsonb;
  v_total_proposed integer := 0;
  v_item record;
  v_req record;
  v_product record;
  v_available integer;
  v_product_ordered integer;
  v_product_limit integer;
  v_product_enabled boolean;
begin
  if jsonb_typeof(coalesce(p_proposed_items,'[]'::jsonb)) <> 'array' then
    raise exception 'Daftar item tidak valid';
  end if;

  if p_po_session_id is not null then
    select * into v_po from public.po_sessions where id=p_po_session_id;
    if not found then
      return jsonb_build_object('ok',false,'errors',jsonb_build_array('PO tidak ditemukan'),'products','[]'::jsonb,'requirements','[]'::jsonb);
    end if;
    select coalesce(sum(oi.qty),0)::int into v_ordered_cups
    from public.orders o join public.order_items oi on oi.order_id=o.id
    where o.po_session_id=p_po_session_id and o.status not in ('CANCELLED','REJECTED');
    if v_po.max_total_cups is not null then
      v_remaining_cups := greatest(v_po.max_total_cups-v_ordered_cups,0);
    end if;
    if v_po.status <> 'OPEN' then
      v_errors := v_errors || jsonb_build_array('PO tidak sedang dibuka');
    elsif v_po.cutoff_at is not null and now() > v_po.cutoff_at then
      v_errors := v_errors || jsonb_build_array('Waktu pemesanan PO sudah berakhir');
    end if;
  end if;

  for v_item in
    select (x->>'productId')::uuid as product_id,
           coalesce((x->>'quantity')::int,0) as quantity,
           coalesce((x->>'noIce')::boolean,false) as no_ice
    from jsonb_array_elements(coalesce(p_proposed_items,'[]'::jsonb)) x
  loop
    if v_item.quantity <= 0 or v_item.quantity > 100 then
      v_errors := v_errors || jsonb_build_array('Jumlah item harus 1 sampai 100');
      continue;
    end if;
    if not exists(select 1 from public.products where id=v_item.product_id and is_active) then
      v_errors := v_errors || jsonb_build_array('Menu tidak ditemukan atau nonaktif');
      continue;
    end if;
    if not exists(select 1 from public.recipes r join public.recipe_items ri on ri.recipe_id=r.id where r.product_id=v_item.product_id) then
      v_errors := v_errors || jsonb_build_array('Resep menu belum lengkap');
      continue;
    end if;
    v_total_proposed := v_total_proposed + v_item.quantity;
  end loop;

  if p_po_session_id is not null and v_total_proposed > v_remaining_cups then
    v_errors := v_errors || jsonb_build_array('Kapasitas cup PO tidak cukup');
  end if;

  for v_item in
    select (x->>'productId')::uuid as product_id, sum((x->>'quantity')::int)::int as quantity
    from jsonb_array_elements(coalesce(p_proposed_items,'[]'::jsonb)) x
    where coalesce((x->>'quantity')::int,0) > 0
    group by (x->>'productId')::uuid
  loop
    if p_po_session_id is not null then
      select coalesce(sum(oi.qty),0)::int into v_product_ordered
      from public.orders o join public.order_items oi on oi.order_id=o.id
      where o.po_session_id=p_po_session_id and oi.product_id=v_item.product_id
        and o.status not in ('CANCELLED','REJECTED');
      select ppl.max_qty, ppl.is_enabled into v_product_limit, v_product_enabled
      from public.po_product_limits ppl
      where ppl.po_session_id=p_po_session_id and ppl.product_id=v_item.product_id;
      if found and not v_product_enabled then
        v_errors := v_errors || jsonb_build_array('Menu dinonaktifkan untuk PO ini');
      elsif found and v_product_limit is not null and v_product_ordered+v_item.quantity > v_product_limit then
        v_errors := v_errors || jsonb_build_array('Batas menu untuk PO ini tidak cukup');
      end if;
    end if;
  end loop;

  for v_req in
    with proposed as (
      select (x->>'productId')::uuid product_id,
             (x->>'quantity')::int quantity,
             coalesce((x->>'noIce')::boolean,false) no_ice
      from jsonb_array_elements(coalesce(p_proposed_items,'[]'::jsonb)) x
      where coalesce((x->>'quantity')::int,0) > 0
    ), required as (
      select ri.ingredient_id, sum(ri.quantity*p.quantity)::numeric(14,3) quantity
      from proposed p
      join public.recipes r on r.product_id=p.product_id
      join public.recipe_items ri on ri.recipe_id=r.id
      join public.ingredients i on i.id=ri.ingredient_id
      where not (p.no_ice and i.code='ICE')
      group by ri.ingredient_id
    )
    select req.ingredient_id, req.quantity, i.name, i.unit,
           coalesce(s.available_stock,0) available_stock,
           pil.max_quantity allocation,
           coalesce((select sum(ir.quantity)
                     from public.inventory_reservations ir
                     join public.orders o on o.id=ir.order_id
                     where o.po_session_id=p_po_session_id
                       and o.status not in ('CANCELLED','REJECTED')
                       and ir.status in ('ACTIVE','CONSUMED')
                       and ir.ingredient_id=req.ingredient_id),0) allocation_used
    from required req
    join public.ingredients i on i.id=req.ingredient_id
    left join public.inventory_stock s on s.ingredient_id=req.ingredient_id
    left join public.po_ingredient_limits pil on pil.po_session_id=p_po_session_id
      and pil.ingredient_id=req.ingredient_id and pil.is_enabled
  loop
    v_requirements := v_requirements || jsonb_build_array(jsonb_build_object(
      'ingredientId',v_req.ingredient_id,'name',v_req.name,'unit',v_req.unit,
      'quantity',v_req.quantity,'availableStock',v_req.available_stock,
      'allocationRemaining',case when v_req.allocation is null then null else greatest(v_req.allocation-v_req.allocation_used,0) end
    ));
    if v_req.quantity > v_req.available_stock then
      v_errors := v_errors || jsonb_build_array(format('Stok %s tidak cukup',v_req.name));
    end if;
    if v_req.allocation is not null and v_req.quantity > greatest(v_req.allocation-v_req.allocation_used,0) then
      v_errors := v_errors || jsonb_build_array(format('Alokasi %s untuk PO tidak cukup',v_req.name));
    end if;
  end loop;

  for v_product in
    select p.id, p.code, p.name, p.price, p.chatbot_metadata
    from public.products p where p.is_active order by p.name
  loop
    v_available := v_remaining_cups;
    if not exists(select 1 from public.recipes r join public.recipe_items ri on ri.recipe_id=r.id where r.product_id=v_product.id) then
      v_available := 0;
    else
      select least(v_available, coalesce(min(floor(coalesce(s.available_stock,0)/nullif(ri.quantity,0)))::int,0))
      into v_available
      from public.recipes r
      join public.recipe_items ri on ri.recipe_id=r.id
      left join public.inventory_stock s on s.ingredient_id=ri.ingredient_id
      where r.product_id=v_product.id;
    end if;

    if p_po_session_id is not null then
      select coalesce(sum(oi.qty),0)::int into v_product_ordered
      from public.orders o join public.order_items oi on oi.order_id=o.id
      where o.po_session_id=p_po_session_id and oi.product_id=v_product.id
        and o.status not in ('CANCELLED','REJECTED');
      select ppl.max_qty,ppl.is_enabled into v_product_limit,v_product_enabled
      from public.po_product_limits ppl
      where ppl.po_session_id=p_po_session_id and ppl.product_id=v_product.id;
      if found then
        if not v_product_enabled then v_available := 0;
        elsif v_product_limit is not null then v_available := least(v_available,greatest(v_product_limit-v_product_ordered,0));
        end if;
      end if;
      select least(v_available,coalesce(min(floor(greatest(pil.max_quantity-coalesce(used.quantity,0),0)/nullif(ri.quantity,0)))::int,v_available))
      into v_available
      from public.recipes r
      join public.recipe_items ri on ri.recipe_id=r.id
      join public.po_ingredient_limits pil on pil.po_session_id=p_po_session_id
        and pil.ingredient_id=ri.ingredient_id and pil.is_enabled
      left join lateral (
        select sum(ir.quantity) quantity
        from public.inventory_reservations ir join public.orders o on o.id=ir.order_id
        where o.po_session_id=p_po_session_id and o.status not in ('CANCELLED','REJECTED')
          and ir.status in ('ACTIVE','CONSUMED') and ir.ingredient_id=ri.ingredient_id
      ) used on true
      where r.product_id=v_product.id;
    end if;
    v_products := v_products || jsonb_build_array(jsonb_build_object(
      'productId',v_product.id,'code',v_product.code,'name',v_product.name,
      'price',v_product.price,'availableQty',greatest(coalesce(v_available,0),0),
      'available',coalesce(v_available,0)>0,'metadata',v_product.chatbot_metadata
    ));
  end loop;

  return jsonb_build_object(
    'ok',jsonb_array_length(v_errors)=0,
    'poId',p_po_session_id,
    'status',case when p_po_session_id is null then null else v_po.status end,
    'orderedCups',v_ordered_cups,
    'remainingCups',case when v_remaining_cups=2147483647 then null else v_remaining_cups end,
    'proposedCups',v_total_proposed,
    'errors',v_errors,
    'requirements',v_requirements,
    'products',v_products
  );
exception when invalid_text_representation then
  return jsonb_build_object('ok',false,'errors',jsonb_build_array('Referensi produk tidak valid'),'products','[]'::jsonb,'requirements','[]'::jsonb);
end $$;

create or replace function public.create_order_bundle(
  p_customer_name text,
  p_class_name text,
  p_po_session_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_notes text default null,
  p_source text default 'WEB',
  p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_total numeric(12,2);
  v_check jsonb;
  v_error text;
  v_timeout integer := 30;
begin
  if p_customer_name is null or btrim(p_customer_name)='' then raise exception 'Nama customer wajib diisi'; end if;
  if p_payment_method not in ('CASH','QRIS') then raise exception 'Metode pembayaran tidak valid'; end if;
  if p_source not in ('MANUAL','WHATSAPP','WEB','QUICK_SALE','IMPORT') then raise exception 'Source order tidak valid'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb))<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Item pesanan wajib diisi'; end if;

  if p_idempotency_key is not null then
    select id into v_order_id from public.orders where idempotency_key=p_idempotency_key;
    if found then return v_order_id; end if;
  end if;

  if p_po_session_id is not null then
    perform 1 from public.po_sessions where id=p_po_session_id for update;
    if not found then raise exception 'PO tidak ditemukan'; end if;
    select qris_timeout_minutes into v_timeout from public.po_sessions where id=p_po_session_id;
  end if;

  perform 1
  from public.ingredients i
  where i.id in (
    select distinct ri.ingredient_id
    from jsonb_array_elements(p_items) x
    join public.recipes r on r.product_id=(x->>'productId')::uuid
    join public.recipe_items ri on ri.recipe_id=r.id
  )
  order by i.id for update;

  v_check := public.evaluate_po_availability(p_po_session_id,p_items);
  if not coalesce((v_check->>'ok')::boolean,false) then
    select string_agg(value,'; ') into v_error from jsonb_array_elements_text(v_check->'errors');
    raise exception '%',coalesce(v_error,'Pesanan tidak tersedia');
  end if;

  select sum(p.price*(x->>'quantity')::int)::numeric(12,2) into v_total
  from jsonb_array_elements(p_items) x
  join public.products p on p.id=(x->>'productId')::uuid and p.is_active;

  select id into v_customer_id from public.customers
  where lower(name)=lower(btrim(p_customer_name))
    and coalesce(lower(class_name),'')=coalesce(lower(nullif(btrim(p_class_name),'')),'')
  order by created_at limit 1;
  if v_customer_id is null then
    insert into public.customers(name,class_name)
    values(btrim(p_customer_name),nullif(btrim(p_class_name),'')) returning id into v_customer_id;
  end if;

  insert into public.orders(customer_id,po_session_id,source,status,payment_method,subtotal,total_amount,notes,idempotency_key)
  values(v_customer_id,p_po_session_id,p_source,'ACCEPTED',p_payment_method,v_total,v_total,p_notes,p_idempotency_key)
  returning id into v_order_id;

  insert into public.order_items(order_id,product_id,qty,unit_price,line_total,no_ice,notes)
  select v_order_id,p.id,(x->>'quantity')::int,p.price,p.price*(x->>'quantity')::int,
         coalesce((x->>'noIce')::boolean,false),nullif(x->>'notes','')
  from jsonb_array_elements(p_items) x
  join public.products p on p.id=(x->>'productId')::uuid and p.is_active;

  insert into public.inventory_reservations(order_id,ingredient_id,quantity)
  select v_order_id,ri.ingredient_id,sum(ri.quantity*(x->>'quantity')::int)
  from jsonb_array_elements(p_items) x
  join public.recipes r on r.product_id=(x->>'productId')::uuid
  join public.recipe_items ri on ri.recipe_id=r.id
  join public.ingredients i on i.id=ri.ingredient_id
  where not (coalesce((x->>'noIce')::boolean,false) and i.code='ICE')
  group by ri.ingredient_id;

  insert into public.payments(order_id,method,status,amount,expires_at)
  values(v_order_id,p_payment_method,case when p_payment_method='QRIS' then 'PENDING' else 'UNPAID' end,
         v_total,case when p_payment_method='QRIS' then now()+make_interval(mins=>v_timeout) else null end);

  insert into public.audit_logs(event_type,entity_type,entity_id,payload)
  values('ORDER_CREATED','order',v_order_id,jsonb_build_object('source',p_source,'payment_method',p_payment_method,'items',p_items));
  return v_order_id;
end $$;

create or replace function public.create_order(
  p_customer_name text,p_class_name text,p_po_session_id uuid,p_product_id uuid,
  p_quantity integer,p_payment_method text,p_no_ice boolean default false,
  p_notes text default null,p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path=public as $$
begin
  return public.create_order_bundle(
    p_customer_name,p_class_name,p_po_session_id,
    jsonb_build_array(jsonb_build_object('productId',p_product_id,'quantity',p_quantity,'noIce',p_no_ice,'notes',p_notes)),
    p_payment_method,p_notes,case when p_po_session_id is null then 'QUICK_SALE' else 'WEB' end,p_idempotency_key
  );
end $$;

create or replace function public.record_quick_sale(
  p_customer_name text,p_class_name text,p_product_id uuid,p_quantity integer,
  p_payment_method text,p_notes text,p_idempotency_key text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_order_id uuid;
begin
  v_order_id := public.create_order_bundle(
    p_customer_name,p_class_name,null,
    jsonb_build_array(jsonb_build_object('productId',p_product_id,'quantity',p_quantity,'noIce',false,'notes',p_notes)),
    p_payment_method,p_notes,'QUICK_SALE',p_idempotency_key
  );
  perform public.confirm_cash_payment(v_order_id);
  perform public.complete_order(v_order_id);
  return v_order_id;
end $$;

create or replace function public.get_po_summary(p_po_session_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  with valid_orders as (
    select o.* from public.orders o
    where o.po_session_id=p_po_session_id and o.status not in ('CANCELLED','REJECTED')
  ), production_orders as (
    select * from valid_orders where status not in ('FULFILLED','READY')
  ), menu_totals as (
    select p.id product_id,p.name,sum(oi.qty)::int quantity
    from valid_orders o join public.order_items oi on oi.order_id=o.id
    join public.products p on p.id=oi.product_id group by p.id,p.name
  ), ingredient_totals as (
    select i.id ingredient_id,i.name,i.unit,sum(ir.quantity)::numeric(14,3) quantity
    from valid_orders o join public.inventory_reservations ir on ir.order_id=o.id
    join public.ingredients i on i.id=ir.ingredient_id
    where ir.status in ('ACTIVE','CONSUMED') group by i.id,i.name,i.unit
  ), production_menu_totals as (
    select p.id product_id,p.name,sum(oi.qty)::int quantity
    from production_orders o join public.order_items oi on oi.order_id=o.id
    join public.products p on p.id=oi.product_id group by p.id,p.name
  ), production_ingredient_totals as (
    select i.id ingredient_id,i.name,i.unit,sum(ir.quantity)::numeric(14,3) quantity
    from production_orders o join public.inventory_reservations ir on ir.order_id=o.id
    join public.ingredients i on i.id=ir.ingredient_id
    where ir.status='ACTIVE' group by i.id,i.name,i.unit
  ), totals as (
    select count(*)::int total_orders,coalesce(sum(total_amount),0) revenue from valid_orders
  ), payment_totals as (
    select count(*) filter(where p.status='PAID')::int paid,
           count(*) filter(where p.status in ('PENDING','UNPAID'))::int unpaid
    from valid_orders o join public.payments p on p.order_id=o.id
  )
  select jsonb_build_object(
    'poId',p_po_session_id,
    'totalOrders',(select total_orders from totals),
    'totalCups',coalesce((select sum(quantity) from menu_totals),0),
    'revenue',(select revenue from totals),
    'paid',(select paid from payment_totals),
    'unpaid',(select unpaid from payment_totals),
    'menuTotals',coalesce((select jsonb_agg(to_jsonb(m) order by m.name) from menu_totals m),'[]'::jsonb),
    'ingredientTotals',coalesce((select jsonb_agg(to_jsonb(i) order by i.name) from ingredient_totals i),'[]'::jsonb),
    'productionMenuTotals',coalesce((select jsonb_agg(to_jsonb(m) order by m.name) from production_menu_totals m),'[]'::jsonb),
    'productionIngredientTotals',coalesce((select jsonb_agg(to_jsonb(i) order by i.name) from production_ingredient_totals i),'[]'::jsonb)
  )
$$;

create or replace function public.record_qris_proof(p_order_id uuid,p_message_id text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_payment public.payments%rowtype;
begin
  select * into v_payment from public.payments where order_id=p_order_id for update;
  if not found then raise exception 'Pembayaran tidak ditemukan'; end if;
  if v_payment.method<>'QRIS' then raise exception 'Order ini bukan pembayaran QRIS'; end if;
  if v_payment.status='PAID' then return v_payment.id; end if;
  if v_payment.status<>'PENDING' then raise exception 'Pembayaran QRIS tidak sedang menunggu bukti'; end if;
  update public.payments set proof_received_at=coalesce(proof_received_at,now()),updated_at=now() where id=v_payment.id;
  insert into public.audit_logs(event_type,entity_type,entity_id,payload)
  values('QRIS_PROOF_RECEIVED','order',p_order_id,jsonb_build_object('message_id',p_message_id));
  return v_payment.id;
end $$;

create or replace function public.create_po(
  p_name text,p_delivery_date date,p_open_at timestamptz,p_cutoff_at timestamptz,
  p_max_total_cups integer,p_ingredient_limits jsonb default '[]'::jsonb,
  p_qris_timeout_minutes integer default 30
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_item jsonb;
begin
  if p_name is null or btrim(p_name)='' then raise exception 'Nama PO wajib diisi'; end if;
  if p_open_at is null or p_cutoff_at is null or p_cutoff_at<=p_open_at then raise exception 'Jadwal buka dan tutup PO tidak valid'; end if;
  if p_qris_timeout_minutes not between 1 and 1440 then raise exception 'Timeout QRIS tidak valid'; end if;
  insert into public.po_sessions(name,delivery_date,open_at,cutoff_at,max_total_cups,status,qris_timeout_minutes)
  values(btrim(p_name),p_delivery_date,p_open_at,p_cutoff_at,p_max_total_cups,'DRAFT',p_qris_timeout_minutes) returning id into v_id;
  insert into public.po_product_limits(po_session_id,product_id,is_enabled)
  select v_id,id,true from public.products where is_active;
  for v_item in select value from jsonb_array_elements(coalesce(p_ingredient_limits,'[]'::jsonb)) loop
    if coalesce((v_item->>'maxQuantity')::numeric,0)>0 then
      perform public.set_po_ingredient_limit(v_id,(v_item->>'ingredientId')::uuid,
        (v_item->>'maxQuantity')::numeric,coalesce((v_item->>'autoCloseThreshold')::numeric,100));
    end if;
  end loop;
  insert into public.audit_logs(event_type,entity_type,entity_id) values('PO_CREATED','po_session',v_id);
  return v_id;
end $$;

create or replace function public.set_po_status(p_po_session_id uuid,p_status text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_check jsonb;
begin
  if p_status not in ('DRAFT','OPEN','CLOSED','COMPLETED','CANCELLED') then raise exception 'Status PO tidak valid'; end if;
  perform 1 from public.po_sessions where id=p_po_session_id for update;
  if not found then raise exception 'PO tidak ditemukan'; end if;
  if p_status='OPEN' then
    if exists(select 1 from public.po_sessions where status='OPEN' and id<>p_po_session_id) then raise exception 'Masih ada PO lain yang sedang dibuka'; end if;
    v_check := public.evaluate_po_availability(p_po_session_id,'[]'::jsonb);
    if not exists(select 1 from jsonb_array_elements(v_check->'products') p where coalesce((p->>'available')::boolean,false)) then
      raise exception 'PO belum bisa dibuka karena tidak ada menu yang tersedia';
    end if;
  end if;
  update public.po_sessions set status=p_status,updated_at=now() where id=p_po_session_id;
  insert into public.audit_logs(event_type,entity_type,entity_id,payload)
  values('PO_STATUS_CHANGED','po_session',p_po_session_id,jsonb_build_object('status',p_status));
  return p_po_session_id;
end $$;

create or replace function public.run_po_maintenance()
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_row record; v_opened jsonb:='[]'::jsonb; v_closed jsonb:='[]'::jsonb; v_expired jsonb:='[]'::jsonb; v_check jsonb;
begin
  for v_row in
    select p.order_id from public.payments p join public.orders o on o.id=p.order_id
    where p.method='QRIS' and p.status='PENDING' and p.proof_received_at is null
      and p.expires_at is not null and p.expires_at<=now()
      and o.status not in ('CANCELLED','REJECTED','FULFILLED')
    for update of p,o
  loop
    perform public.cancel_order(v_row.order_id,'Bukti QRIS tidak diterima sampai batas waktu');
    v_expired:=v_expired||jsonb_build_array(v_row.order_id);
  end loop;

  for v_row in select id,name from public.po_sessions where status='OPEN' for update loop
    v_check:=public.evaluate_po_availability(v_row.id,'[]'::jsonb);
    if exists(select 1 from public.po_sessions where id=v_row.id and cutoff_at is not null and cutoff_at<=now())
       or not exists(select 1 from jsonb_array_elements(v_check->'products') p where coalesce((p->>'available')::boolean,false)) then
      update public.po_sessions set status='CLOSED',updated_at=now() where id=v_row.id;
      insert into public.audit_logs(event_type,entity_type,entity_id,payload)
      values('PO_AUTO_CLOSED','po_session',v_row.id,jsonb_build_object('reason','cutoff_or_capacity'));
      v_closed:=v_closed||jsonb_build_array(jsonb_build_object('id',v_row.id,'name',v_row.name));
    end if;
  end loop;

  if not exists(select 1 from public.po_sessions where status='OPEN') then
    select id,name into v_row from public.po_sessions
    where status='DRAFT' and open_at<=now() and cutoff_at>now()
    order by open_at,created_at limit 1 for update skip locked;
    if found then
      v_check:=public.evaluate_po_availability(v_row.id,'[]'::jsonb);
      if exists(select 1 from jsonb_array_elements(v_check->'products') p where coalesce((p->>'available')::boolean,false)) then
        update public.po_sessions set status='OPEN',updated_at=now() where id=v_row.id;
        insert into public.audit_logs(event_type,entity_type,entity_id,payload)
        values('PO_AUTO_OPENED','po_session',v_row.id,jsonb_build_object('reason','open_at'));
        v_opened:=v_opened||jsonb_build_array(jsonb_build_object('id',v_row.id,'name',v_row.name));
      end if;
    end if;
  end if;
  return jsonb_build_object('opened',v_opened,'closed',v_closed,'expiredOrderIds',v_expired);
end $$;

revoke all on function public.evaluate_po_availability(uuid,jsonb) from public;
revoke all on function public.create_order_bundle(text,text,uuid,jsonb,text,text,text,text) from public;
revoke all on function public.get_po_summary(uuid) from public;
revoke all on function public.record_qris_proof(uuid,text) from public;
revoke all on function public.create_po(text,date,timestamptz,timestamptz,integer,jsonb,integer) from public;
revoke all on function public.run_po_maintenance() from public;
