-- Keep WhatsApp identity on the order itself. A customer master row may be
-- reused by name/class, so it must not be the authorization boundary for chat.
alter table public.orders
  add column if not exists customer_phone text;

create index if not exists orders_customer_phone_created_idx
  on public.orders(customer_phone,created_at desc)
  where customer_phone is not null;

-- Prefer the phone captured by the exact draft that created the order.
update public.orders o
set customer_phone=regexp_replace(od.customer_phone,'\D','','g')
from public.order_drafts od
where od.created_order_id=o.id
  and o.customer_phone is null
  and od.customer_phone is not null;

-- Compatibility fallback for older WhatsApp rows without a linked draft.
update public.orders o
set customer_phone=regexp_replace(c.phone,'\D','','g')
from public.customers c
where o.customer_id=c.id
  and o.source='WHATSAPP'
  and o.customer_phone is null
  and c.phone is not null;

create or replace function public.create_order_bundle(
  p_customer_name text,
  p_class_name text,
  p_po_session_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_notes text,
  p_source text,
  p_idempotency_key text,
  p_customer_phone text
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_order_id uuid;
  v_phone text;
begin
  v_phone := regexp_replace(coalesce(p_customer_phone,''),'\D','','g');
  if left(v_phone,1)='0' then v_phone := '62' || substr(v_phone,2); end if;
  if p_source='WHATSAPP' and v_phone='' then
    raise exception 'Nomor WhatsApp customer wajib diisi';
  end if;

  v_order_id := public.create_order_bundle(
    p_customer_name,p_class_name,p_po_session_id,p_items,p_payment_method,
    p_notes,p_source,p_idempotency_key
  );

  update public.orders
  set customer_phone=nullif(v_phone,''),updated_at=now()
  where id=v_order_id;

  -- Retain a convenient contact on customer master only when it is empty.
  -- Never overwrite it: two people can legitimately share name/class.
  update public.customers c
  set phone=nullif(v_phone,''),updated_at=now()
  from public.orders o
  where o.id=v_order_id and c.id=o.customer_id and c.phone is null;

  return v_order_id;
end $$;

revoke all on function public.create_order_bundle(text,text,uuid,jsonb,text,text,text,text,text) from public;
grant execute on function public.create_order_bundle(text,text,uuid,jsonb,text,text,text,text,text) to service_role;
