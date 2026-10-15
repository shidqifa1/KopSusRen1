-- Serialize retries before reading the idempotency key, including quick sales.
-- Keep the same primitive and RPC signatures for all callers.
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
    perform pg_advisory_xact_lock(hashtextextended('order-idempotency:' || p_idempotency_key,0));
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
