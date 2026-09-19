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
  values(v_customer_id,p_po_session_id,case when p_po_session_id is null then 'QUICK_SALE' else 'WEB' end,'ACCEPTED',p_payment_method,v_price*p_quantity,v_price*p_quantity,p_notes,p_idempotency_key)
  returning id into v_order_id;
  insert into order_items(order_id,product_id,qty,unit_price,line_total,no_ice,notes)
  values(v_order_id,p_product_id,p_quantity,v_price,v_price*p_quantity,p_no_ice,p_notes);
  insert into inventory_reservations(order_id,ingredient_id,quantity)
  select v_order_id,ri.ingredient_id,ri.quantity*p_quantity
  from recipes r join recipe_items ri on ri.recipe_id=r.id join ingredients i on i.id=ri.ingredient_id
  where r.product_id=p_product_id and not (p_no_ice and i.code='ICE');
  insert into payments(order_id,method,status,amount)
  values(v_order_id,p_payment_method,case when p_payment_method='QRIS' then 'PENDING' else 'UNPAID' end,v_price*p_quantity);
  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('ORDER_CREATED','order',v_order_id,jsonb_build_object('quantity',p_quantity,'payment_method',p_payment_method));
  return v_order_id;
end $$;

create or replace function public.confirm_cash_payment(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_payment payments%rowtype; v_account_id uuid;
begin
  select * into v_payment from payments where order_id=p_order_id for update;
  if not found then raise exception 'Pembayaran tidak ditemukan'; end if;
  if v_payment.status='PAID' then return v_payment.id; end if;
  if v_payment.status not in ('UNPAID','PENDING') then raise exception 'Pembayaran tidak dapat dikonfirmasi'; end if;
  select id into v_account_id from accounts where type=case when v_payment.method='CASH' then 'CASH' else 'QRIS' end and is_active order by created_at limit 1;
  if v_account_id is null then raise exception 'Akun pembayaran belum tersedia'; end if;
  update payments set status='PAID',paid_at=now(),updated_at=now() where id=v_payment.id;
  insert into ledger_entries(account_id,amount,entry_type,reference_type,reference_id,description)
  values(v_account_id,v_payment.amount,'SALE','order',p_order_id,'Pembayaran order') on conflict do nothing;
  insert into audit_logs(event_type,entity_type,entity_id) values('PAYMENT_CONFIRMED','order',p_order_id);
  return v_payment.id;
end $$;

create or replace function public.complete_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_order orders%rowtype;
begin
  select * into v_order from orders where id=p_order_id for update;
  if not found then raise exception 'Order tidak ditemukan'; end if;
  if v_order.status='FULFILLED' then return p_order_id; end if;
  if v_order.status in ('CANCELLED','REJECTED') then raise exception 'Order sudah dibatalkan'; end if;
  insert into inventory_movements(ingredient_id,quantity_delta,movement_type,reference_type,reference_id,note)
  select ingredient_id,-quantity,'SALE','order',p_order_id,'Pemakaian bahan order'
  from inventory_reservations where order_id=p_order_id and status='ACTIVE';
  update inventory_reservations set status='CONSUMED',updated_at=now() where order_id=p_order_id and status='ACTIVE';
  update orders set status='FULFILLED',fulfilled_at=now(),updated_at=now() where id=p_order_id;
  insert into audit_logs(event_type,entity_type,entity_id) values('ORDER_COMPLETED','order',p_order_id);
  return p_order_id;
end $$;

create or replace function public.record_quick_sale(
  p_customer_name text,p_class_name text,p_product_id uuid,p_quantity integer,
  p_payment_method text,p_notes text,p_idempotency_key text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_order_id uuid;
begin
  v_order_id := create_order(p_customer_name,p_class_name,null,p_product_id,p_quantity,p_payment_method,false,p_notes,p_idempotency_key);
  perform confirm_cash_payment(v_order_id);
  perform complete_order(v_order_id);
  return v_order_id;
end $$;

create or replace function public.cancel_order(p_order_id uuid,p_reason text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_order orders%rowtype; v_payment payments%rowtype; v_account_id uuid;
begin
  select * into v_order from orders where id=p_order_id for update;
  if not found then raise exception 'Order tidak ditemukan'; end if;
  if v_order.status='CANCELLED' then return p_order_id; end if;
  if v_order.status='FULFILLED' then raise exception 'Order selesai tidak dapat dibatalkan langsung'; end if;
  update inventory_reservations set status='RELEASED',updated_at=now() where order_id=p_order_id and status='ACTIVE';
  select * into v_payment from payments where order_id=p_order_id for update;
  if v_payment.status='PAID' then
    select id into v_account_id from accounts where type=case when v_payment.method='CASH' then 'CASH' else 'QRIS' end and is_active order by created_at limit 1;
    insert into ledger_entries(account_id,amount,entry_type,reference_type,reference_id,description)
    values(v_account_id,-v_payment.amount,'REFUND','order',p_order_id,'Refund pembatalan order') on conflict do nothing;
    update payments set status='REFUNDED',updated_at=now() where id=v_payment.id;
  else
    update payments set status='EXPIRED',updated_at=now() where id=v_payment.id;
  end if;
  update orders set status='CANCELLED',cancelled_at=now(),notes=concat_ws(E'\n',notes,p_reason),updated_at=now() where id=p_order_id;
  insert into audit_logs(event_type,entity_type,entity_id,payload) values('ORDER_CANCELLED','order',p_order_id,jsonb_build_object('reason',p_reason));
  return p_order_id;
end $$;

create or replace function public.record_purchase(
  p_supplier text,p_account_id uuid,p_ingredient_id uuid,p_quantity numeric,p_total_cost numeric,
  p_source text default 'MANUAL',p_notes text default null,p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_purchase_id uuid;
begin
  if p_quantity<=0 or p_total_cost<=0 then raise exception 'Jumlah dan total harga harus lebih dari 0'; end if;
  if p_idempotency_key is not null then
    select id into v_purchase_id from purchases where idempotency_key=p_idempotency_key;
    if found then return v_purchase_id; end if;
  end if;
  if not exists(select 1 from accounts where id=p_account_id and is_active) then raise exception 'Akun tidak ditemukan'; end if;
  if not exists(select 1 from ingredients where id=p_ingredient_id and is_active) then raise exception 'Bahan tidak ditemukan'; end if;
  insert into purchases(supplier,account_id,total_amount,source,status,notes,idempotency_key)
  values(p_supplier,p_account_id,p_total_cost,p_source,'CONFIRMED',p_notes,p_idempotency_key) returning id into v_purchase_id;
  insert into purchase_items(purchase_id,ingredient_id,quantity,total_cost) values(v_purchase_id,p_ingredient_id,p_quantity,p_total_cost);
  insert into inventory_movements(ingredient_id,quantity_delta,movement_type,reference_type,reference_id,note)
  values(p_ingredient_id,p_quantity,'PURCHASE','purchase',v_purchase_id,coalesce(p_notes,'Pembelian bahan'));
  insert into ledger_entries(account_id,amount,entry_type,reference_type,reference_id,description)
  values(p_account_id,-p_total_cost,'EXPENSE','purchase',v_purchase_id,'Pembelian bahan dari '||coalesce(p_supplier,'supplier'));
  insert into audit_logs(event_type,entity_type,entity_id) values('PURCHASE_RECORDED','purchase',v_purchase_id);
  return v_purchase_id;
end $$;

create or replace function public.create_po(p_name text,p_delivery_date date,p_cutoff_at timestamptz,p_max_total_cups integer)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if p_name is null or btrim(p_name)='' then raise exception 'Nama PO wajib diisi'; end if;
  insert into po_sessions(name,delivery_date,cutoff_at,max_total_cups,status)
  values(btrim(p_name),p_delivery_date,p_cutoff_at,p_max_total_cups,'DRAFT') returning id into v_id;
  insert into po_product_limits(po_session_id,product_id,is_enabled) select v_id,id,true from products where is_active;
  insert into audit_logs(event_type,entity_type,entity_id) values('PO_CREATED','po_session',v_id);
  return v_id;
end $$;

create or replace function public.set_po_status(p_po_session_id uuid,p_status text)
returns uuid language plpgsql security definer set search_path=public as $$
begin
  if p_status not in ('DRAFT','OPEN','CLOSED','COMPLETED','CANCELLED') then raise exception 'Status PO tidak valid'; end if;
  update po_sessions set status=p_status,updated_at=now() where id=p_po_session_id;
  if not found then raise exception 'PO tidak ditemukan'; end if;
  insert into audit_logs(event_type,entity_type,entity_id,payload) values('PO_STATUS_CHANGED','po_session',p_po_session_id,jsonb_build_object('status',p_status));
  return p_po_session_id;
end $$;

create or replace function public.adjust_inventory(p_ingredient_id uuid,p_quantity_delta numeric,p_reason text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if p_quantity_delta=0 or btrim(coalesce(p_reason,''))='' then raise exception 'Jumlah dan alasan wajib diisi'; end if;
  insert into inventory_movements(ingredient_id,quantity_delta,movement_type,note)
  values(p_ingredient_id,p_quantity_delta,'ADJUSTMENT',p_reason) returning id into v_id;
  insert into audit_logs(event_type,entity_type,entity_id,payload) values('INVENTORY_ADJUSTED','ingredient',p_ingredient_id,jsonb_build_object('delta',p_quantity_delta,'reason',p_reason));
  return v_id;
end $$;

create or replace function public.adjust_account(p_account_id uuid,p_amount numeric,p_reason text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if p_amount=0 or btrim(coalesce(p_reason,''))='' then raise exception 'Jumlah dan alasan wajib diisi'; end if;
  insert into ledger_entries(account_id,amount,entry_type,description)
  values(p_account_id,p_amount,'ADJUSTMENT',p_reason) returning id into v_id;
  insert into audit_logs(event_type,entity_type,entity_id,payload) values('ACCOUNT_ADJUSTED','account',p_account_id,jsonb_build_object('amount',p_amount,'reason',p_reason));
  return v_id;
end $$;

create or replace function public.update_ingredient(
  p_ingredient_id uuid,p_physical_stock numeric,p_threshold numeric,p_reason text default 'Edit stok dari aplikasi'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_current numeric; v_delta numeric;
begin
  if p_physical_stock < 0 or p_threshold < 0 then raise exception 'Stok dan threshold tidak boleh negatif'; end if;
  select physical_stock into v_current from inventory_stock where ingredient_id=p_ingredient_id;
  if not found then raise exception 'Bahan tidak ditemukan'; end if;
  update ingredients set low_stock_threshold=p_threshold,updated_at=now() where id=p_ingredient_id;
  v_delta := p_physical_stock-v_current;
  if v_delta<>0 then
    insert into inventory_movements(ingredient_id,quantity_delta,movement_type,note)
    values(p_ingredient_id,v_delta,'ADJUSTMENT',p_reason);
  end if;
  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('INGREDIENT_UPDATED','ingredient',p_ingredient_id,jsonb_build_object('stock_before',v_current,'stock_after',p_physical_stock,'threshold',p_threshold));
  return p_ingredient_id;
end $$;

create or replace function public.update_product_recipe(
  p_product_id uuid,p_price numeric,p_items jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_recipe_id uuid; v_item jsonb;
begin
  if p_price<0 then raise exception 'Harga tidak boleh negatif'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Resep tidak boleh kosong'; end if;
  update products set price=p_price,updated_at=now() where id=p_product_id;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  insert into recipes(product_id,notes) values(p_product_id,'Resep utama KopSusRen')
  on conflict(product_id) do update set updated_at=now() returning id into v_recipe_id;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    insert into recipe_items(recipe_id,ingredient_id,quantity)
    values(v_recipe_id,(v_item->>'ingredientId')::uuid,(v_item->>'quantity')::numeric)
    on conflict(recipe_id,ingredient_id) do update set quantity=excluded.quantity;
  end loop;
  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('RECIPE_UPDATED','product',p_product_id,jsonb_build_object('price',p_price,'items',p_items));
  return p_product_id;
end $$;

revoke all on function public.create_order(text,text,uuid,uuid,integer,text,boolean,text,text) from public;
revoke all on function public.record_quick_sale(text,text,uuid,integer,text,text,text) from public;
revoke all on function public.record_purchase(text,uuid,uuid,numeric,numeric,text,text,text) from public;
