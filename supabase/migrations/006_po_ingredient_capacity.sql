create table if not exists public.po_ingredient_limits (
  id uuid primary key default gen_random_uuid(),
  po_session_id uuid not null references public.po_sessions(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  max_quantity numeric(14,3) not null check (max_quantity > 0),
  auto_close_threshold numeric(5,2) not null default 100 check (auto_close_threshold > 0 and auto_close_threshold <= 100),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (po_session_id, ingredient_id)
);

create index if not exists po_ingredient_limits_session_idx on public.po_ingredient_limits(po_session_id);
alter table public.po_ingredient_limits enable row level security;
revoke all on public.po_ingredient_limits from anon, authenticated;

create or replace function public.set_po_ingredient_limit(
  p_po_session_id uuid,
  p_ingredient_id uuid,
  p_max_quantity numeric,
  p_auto_close_threshold numeric default 100
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if p_max_quantity is null or p_max_quantity <= 0 then raise exception 'Kapasitas bahan harus lebih dari 0'; end if;
  if p_auto_close_threshold is null or p_auto_close_threshold <= 0 or p_auto_close_threshold > 100 then raise exception 'Threshold harus 1 sampai 100 persen'; end if;
  if not exists(select 1 from po_sessions where id=p_po_session_id) then raise exception 'PO tidak ditemukan'; end if;
  if not exists(select 1 from ingredients where id=p_ingredient_id and is_active) then raise exception 'Bahan tidak ditemukan'; end if;

  insert into po_ingredient_limits(po_session_id,ingredient_id,max_quantity,auto_close_threshold,is_enabled)
  values(p_po_session_id,p_ingredient_id,p_max_quantity,p_auto_close_threshold,true)
  on conflict(po_session_id, ingredient_id)
  do update set max_quantity=excluded.max_quantity,
                auto_close_threshold=excluded.auto_close_threshold,
                is_enabled=true,
                updated_at=now()
  returning id into v_id;

  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('PO_INGREDIENT_LIMIT_SET','po_session',p_po_session_id,jsonb_build_object('ingredient_id',p_ingredient_id,'max_quantity',p_max_quantity,'threshold',p_auto_close_threshold));
  return v_id;
end $$;

create or replace function public.create_order(
  p_customer_name text,
  p_class_name text,
  p_po_session_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_payment_method text,
  p_no_ice boolean default false,
  p_notes text default null,
  p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_price numeric(12,2);
  v_po po_sessions%rowtype;
  v_ordered integer;
  v_limit po_product_limits%rowtype;
  v_required record;
  v_po_limit record;
  v_usage_after numeric(14,3);
  v_should_close boolean := false;
begin
  if p_customer_name is null or btrim(p_customer_name) = '' then raise exception 'Nama customer wajib diisi'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Jumlah harus lebih dari 0'; end if;
  if p_payment_method not in ('CASH','QRIS') then raise exception 'Metode pembayaran tidak valid'; end if;

  if p_idempotency_key is not null then
    select id into v_order_id from orders where idempotency_key = p_idempotency_key;
    if found then return v_order_id; end if;
  end if;

  select price into v_price from products where id = p_product_id and is_active for share;
  if not found then raise exception 'Menu tidak ditemukan atau nonaktif'; end if;

  if p_po_session_id is not null then
    select * into v_po from po_sessions where id = p_po_session_id for update;
    if not found or v_po.status <> 'OPEN' then raise exception 'PO tidak sedang dibuka'; end if;
    if v_po.cutoff_at is not null and now() > v_po.cutoff_at then raise exception 'Waktu pemesanan PO sudah berakhir'; end if;
    select coalesce(sum(oi.qty),0)::int into v_ordered
    from orders o join order_items oi on oi.order_id = o.id
    where o.po_session_id = p_po_session_id and o.status not in ('CANCELLED','REJECTED');
    if v_po.max_total_cups is not null and v_ordered + p_quantity > v_po.max_total_cups then
      raise exception 'Kapasitas PO tidak cukup';
    end if;
    select * into v_limit from po_product_limits where po_session_id = p_po_session_id and product_id = p_product_id;
    if found then
      if not v_limit.is_enabled then raise exception 'Menu dinonaktifkan untuk PO ini'; end if;
      if v_limit.max_qty is not null and (
        select coalesce(sum(oi.qty),0) from orders o join order_items oi on oi.order_id=o.id
        where o.po_session_id=p_po_session_id and oi.product_id=p_product_id and o.status not in ('CANCELLED','REJECTED')
      ) + p_quantity > v_limit.max_qty then raise exception 'Batas menu untuk PO ini sudah tercapai'; end if;
    end if;

    for v_po_limit in
      select pil.ingredient_id, pil.max_quantity, pil.auto_close_threshold, i.name, i.unit,
             coalesce((
               select sum(ir.quantity)
               from inventory_reservations ir
               join orders o on o.id=ir.order_id
               where o.po_session_id=p_po_session_id
                 and o.status not in ('CANCELLED','REJECTED')
                 and ir.status in ('ACTIVE','CONSUMED')
                 and ir.ingredient_id=pil.ingredient_id
             ),0) as used_quantity,
             coalesce((
               select ri.quantity * p_quantity
               from recipes r
               join recipe_items ri on ri.recipe_id=r.id
               join ingredients ii on ii.id=ri.ingredient_id
               where r.product_id=p_product_id
                 and ri.ingredient_id=pil.ingredient_id
                 and not (p_no_ice and ii.code='ICE')
               limit 1
             ),0) as new_quantity
      from po_ingredient_limits pil
      join ingredients i on i.id=pil.ingredient_id
      where pil.po_session_id=p_po_session_id and pil.is_enabled
      for update of pil
    loop
      v_usage_after := v_po_limit.used_quantity + v_po_limit.new_quantity;
      if v_usage_after > v_po_limit.max_quantity then
        raise exception 'Kapasitas bahan % tidak cukup. Terpakai % / % %', v_po_limit.name, v_po_limit.used_quantity, v_po_limit.max_quantity, v_po_limit.unit;
      end if;
      if v_usage_after >= (v_po_limit.max_quantity * v_po_limit.auto_close_threshold / 100) then
        v_should_close := true;
      end if;
    end loop;
  end if;

  for v_required in
    select ri.ingredient_id, ri.quantity * p_quantity as quantity, s.available_stock
    from recipes r join recipe_items ri on ri.recipe_id=r.id
    join inventory_stock s on s.ingredient_id=ri.ingredient_id
    where r.product_id=p_product_id and not (p_no_ice and s.code='ICE')
  loop
    if v_required.available_stock < v_required.quantity then
      raise exception 'Stok bahan tidak cukup';
    end if;
  end loop;

  select id into v_customer_id from customers
  where lower(name)=lower(btrim(p_customer_name)) and coalesce(lower(class_name),'')=coalesce(lower(btrim(p_class_name)),'')
  order by created_at limit 1;
  if v_customer_id is null then
    insert into customers(name,class_name) values(btrim(p_customer_name),nullif(btrim(p_class_name),'')) returning id into v_customer_id;
  end if;

  insert into orders(customer_id,po_session_id,source,status,payment_method,subtotal,total_amount,notes,idempotency_key)
  values(v_customer_id,p_po_session_id,case when p_po_session_id is null then 'QUICK_SALE' else 'WHATSAPP' end,'ACCEPTED',p_payment_method,v_price*p_quantity,v_price*p_quantity,p_notes,p_idempotency_key)
  returning id into v_order_id;
  insert into order_items(order_id,product_id,qty,unit_price,line_total,no_ice,notes)
  values(v_order_id,p_product_id,p_quantity,v_price,v_price*p_quantity,p_no_ice,p_notes);
  insert into inventory_reservations(order_id,ingredient_id,quantity)
  select v_order_id,ri.ingredient_id,ri.quantity*p_quantity
  from recipes r join recipe_items ri on ri.recipe_id=r.id join ingredients i on i.id=ri.ingredient_id
  where r.product_id=p_product_id and not (p_no_ice and i.code='ICE');
  insert into payments(order_id,method,status,amount)
  values(v_order_id,p_payment_method,case when p_payment_method='QRIS' then 'PENDING' else 'UNPAID' end,v_price*p_quantity);

  if v_should_close then
    update po_sessions set status='CLOSED', updated_at=now() where id=p_po_session_id and status='OPEN';
    insert into audit_logs(event_type,entity_type,entity_id,payload)
    values('PO_AUTO_CLOSED','po_session',p_po_session_id,jsonb_build_object('order_id',v_order_id,'reason','ingredient_threshold_reached'));
  end if;

  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('ORDER_CREATED','order',v_order_id,jsonb_build_object('quantity',p_quantity,'payment_method',p_payment_method));
  return v_order_id;
end $$;

create or replace function public.create_po(
  p_name text,
  p_delivery_date date,
  p_cutoff_at timestamptz,
  p_max_total_cups integer,
  p_ingredient_limits jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_item jsonb;
begin
  if p_name is null or btrim(p_name)='' then raise exception 'Nama PO wajib diisi'; end if;
  insert into po_sessions(name,delivery_date,cutoff_at,max_total_cups,status)
  values(btrim(p_name),p_delivery_date,p_cutoff_at,p_max_total_cups,'DRAFT') returning id into v_id;
  insert into po_product_limits(po_session_id,product_id,is_enabled) select v_id,id,true from products where is_active;

  if jsonb_typeof(coalesce(p_ingredient_limits,'[]'::jsonb)) = 'array' then
    for v_item in select value from jsonb_array_elements(coalesce(p_ingredient_limits,'[]'::jsonb))
    loop
      if coalesce((v_item->>'maxQuantity')::numeric,0) > 0 then
        perform set_po_ingredient_limit(
          v_id,
          (v_item->>'ingredientId')::uuid,
          (v_item->>'maxQuantity')::numeric,
          coalesce((v_item->>'autoCloseThreshold')::numeric,100)
        );
      end if;
    end loop;
  end if;

  insert into audit_logs(event_type,entity_type,entity_id) values('PO_CREATED','po_session',v_id);
  return v_id;
end $$;

create or replace function public.approve_order_draft(
  p_approval_id uuid,
  p_resolved_by text,
  p_payment_method text default 'CASH',
  p_po_session_id uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_approval approval_requests%rowtype;
  v_draft order_drafts%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_order_id uuid;
  v_first_order_id uuid;
  v_po_session_id uuid;
begin
  select * into v_approval from approval_requests where id=p_approval_id for update;
  if not found then raise exception 'Approval tidak ditemukan'; end if;
  if v_approval.status = 'APPROVED' then
    return (v_approval.execution->>'order_id')::uuid;
  end if;
  if v_approval.status <> 'NEEDS_APPROVAL' then
    raise exception 'Approval sudah diproses';
  end if;
  select * into v_draft from order_drafts where id=v_approval.draft_id for update;
  if not found then raise exception 'Draft tidak ditemukan'; end if;
  if v_draft.state <> 'DRAFT_READY' then raise exception 'Draft belum lengkap'; end if;

  v_po_session_id := p_po_session_id;
  if v_po_session_id is null then
    select id into v_po_session_id
    from po_sessions
    where status='OPEN'
    order by delivery_date asc, created_at asc
    limit 1;
  end if;

  for v_item in select value from jsonb_array_elements(v_draft.items)
  loop
    select id into v_product_id from products where code=(v_item->>'productCode') and is_active limit 1;
    if v_product_id is null then raise exception 'Menu draft tidak ditemukan'; end if;
    v_order_id := create_order(
      v_draft.customer_name,
      v_draft.class_name,
      v_po_session_id,
      v_product_id,
      coalesce((v_item->>'quantity')::int, (v_item->>'qty')::int, 1),
      p_payment_method,
      coalesce((v_item->>'noIce')::boolean,false),
      v_draft.notes,
      'approval:' || p_approval_id::text || ':' || (v_item->>'productCode')
    );
    if v_first_order_id is null then v_first_order_id := v_order_id; end if;
  end loop;

  update order_drafts set state='APPROVED', updated_at=now() where id=v_draft.id;
  update approval_requests
    set status='APPROVED',
        resolved_by=p_resolved_by,
        resolved_at=now(),
        execution=jsonb_build_object('order_id',v_first_order_id,'po_session_id',v_po_session_id)
    where id=p_approval_id;
  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('ORDER_DRAFT_APPROVED','approval_request',p_approval_id,jsonb_build_object('draft_id',v_draft.id,'order_id',v_first_order_id,'po_session_id',v_po_session_id));
  return v_first_order_id;
end $$;

revoke all on function public.set_po_ingredient_limit(uuid,uuid,numeric,numeric) from public;
revoke all on function public.create_order(text,text,uuid,uuid,integer,text,boolean,text,text) from public;
revoke all on function public.create_po(text,date,timestamptz,integer,jsonb) from public;
revoke all on function public.approve_order_draft(uuid,text,text,uuid) from public;
