create or replace function public.import_historical_sale(
  p_customer_name text,
  p_class_name text,
  p_product_id uuid,
  p_unit_price numeric,
  p_payment_method text,
  p_notes text,
  p_occurred_at timestamptz,
  p_idempotency_key text
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
begin
  if p_customer_name is null or btrim(p_customer_name)='' then p_customer_name := 'Anonim'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception 'Harga satuan tidak valid'; end if;
  if p_payment_method not in ('CASH','QRIS') then raise exception 'Metode pembayaran tidak valid'; end if;
  if p_occurred_at is null then raise exception 'Tanggal penjualan wajib diisi'; end if;
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then raise exception 'Kunci import wajib diisi'; end if;

  select id into v_order_id from public.orders where idempotency_key=p_idempotency_key;
  if found then return v_order_id; end if;

  perform 1 from public.products where id=p_product_id and is_active;
  if not found then raise exception 'Menu tidak ditemukan atau tidak aktif'; end if;

  select id into v_customer_id from public.customers
  where lower(name)=lower(btrim(p_customer_name))
    and coalesce(lower(class_name),'')=coalesce(lower(nullif(btrim(p_class_name),'')),'')
  order by created_at limit 1;
  if v_customer_id is null then
    insert into public.customers(name,class_name,created_at,updated_at)
    values(btrim(p_customer_name),nullif(btrim(p_class_name),''),p_occurred_at,p_occurred_at)
    returning id into v_customer_id;
  end if;

  insert into public.orders(
    customer_id,source,status,payment_method,subtotal,total_amount,notes,
    idempotency_key,fulfilled_at,created_at,updated_at
  ) values(
    v_customer_id,'IMPORT','FULFILLED',p_payment_method,p_unit_price,p_unit_price,
    nullif(btrim(p_notes),''),p_idempotency_key,p_occurred_at,p_occurred_at,p_occurred_at
  ) returning id into v_order_id;

  insert into public.order_items(order_id,product_id,qty,unit_price,line_total,created_at)
  values(v_order_id,p_product_id,1,p_unit_price,p_unit_price,p_occurred_at);

  -- Kas diimpor lewat file kas secara terpisah agar round-trip dua file export
  -- tidak menghitung pemasukan dua kali.
  insert into public.payments(order_id,method,status,amount,paid_at,created_at,updated_at)
  values(v_order_id,p_payment_method,'PAID',p_unit_price,p_occurred_at,p_occurred_at,p_occurred_at);

  insert into public.audit_logs(event_type,entity_type,entity_id,payload,created_at)
  values('HISTORICAL_SALE_IMPORTED','order',v_order_id,
    jsonb_build_object('idempotency_key',p_idempotency_key),p_occurred_at);
  return v_order_id;
end $$;

create or replace function public.import_cash_entry(
  p_account_id uuid,
  p_amount numeric,
  p_description text,
  p_occurred_at timestamptz,
  p_reference_id uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_entry_id uuid;
begin
  if p_amount is null or p_amount=0 then raise exception 'Jumlah mutasi tidak boleh nol'; end if;
  if p_occurred_at is null then raise exception 'Tanggal mutasi wajib diisi'; end if;
  if p_reference_id is null then raise exception 'Referensi import wajib diisi'; end if;
  perform 1 from public.accounts where id=p_account_id and is_active;
  if not found then raise exception 'Akun kas tidak ditemukan'; end if;

  select id into v_entry_id from public.ledger_entries
  where account_id=p_account_id and entry_type='ADJUSTMENT'
    and reference_type='CSV_IMPORT' and reference_id=p_reference_id;
  if found then return v_entry_id; end if;

  insert into public.ledger_entries(
    account_id,amount,entry_type,reference_type,reference_id,description,created_at
  ) values(
    p_account_id,p_amount,'ADJUSTMENT','CSV_IMPORT',p_reference_id,
    coalesce(nullif(btrim(p_description),''),'Import dari CSV'),p_occurred_at
  ) returning id into v_entry_id;

  insert into public.audit_logs(event_type,entity_type,entity_id,payload,created_at)
  values('CASH_ENTRY_IMPORTED','ledger_entry',v_entry_id,
    jsonb_build_object('amount',p_amount,'reference_id',p_reference_id),p_occurred_at);
  return v_entry_id;
end $$;

revoke all on function public.import_historical_sale(text,text,uuid,numeric,text,text,timestamptz,text) from public;
revoke all on function public.import_cash_entry(uuid,numeric,text,timestamptz,uuid) from public;
