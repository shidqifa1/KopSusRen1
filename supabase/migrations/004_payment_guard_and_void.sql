create or replace function public.complete_order(p_order_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_order orders%rowtype; v_payment_status text;
begin
  select * into v_order from orders where id=p_order_id for update;
  if not found then raise exception 'Order tidak ditemukan'; end if;
  if v_order.status='FULFILLED' then return p_order_id; end if;
  if v_order.status in ('CANCELLED','REJECTED') then raise exception 'Order sudah dibatalkan'; end if;
  select status into v_payment_status from payments where order_id=p_order_id for update;
  if v_payment_status is distinct from 'PAID' then raise exception 'Konfirmasi pembayaran sebelum menyelesaikan order'; end if;
  insert into inventory_movements(ingredient_id,quantity_delta,movement_type,reference_type,reference_id,note)
  select ingredient_id,-quantity,'SALE','order',p_order_id,'Pemakaian bahan order'
  from inventory_reservations where order_id=p_order_id and status='ACTIVE';
  update inventory_reservations set status='CONSUMED',updated_at=now() where order_id=p_order_id and status='ACTIVE';
  update orders set status='FULFILLED',fulfilled_at=now(),updated_at=now() where id=p_order_id;
  insert into audit_logs(event_type,entity_type,entity_id) values('ORDER_COMPLETED','order',p_order_id);
  return p_order_id;
end $$;

create or replace function public.void_fulfilled_order(p_order_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_order orders%rowtype; v_payment payments%rowtype; v_account_id uuid;
begin
  if btrim(coalesce(p_reason,''))='' then raise exception 'Alasan void wajib diisi'; end if;
  select * into v_order from orders where id=p_order_id for update;
  if not found then raise exception 'Order tidak ditemukan'; end if;
  select * into v_payment from payments where order_id=p_order_id for update;
  if v_order.status='CANCELLED' and v_payment.status='REFUNDED' then return p_order_id; end if;
  if v_order.status<>'FULFILLED' then raise exception 'Hanya order selesai yang dapat di-void'; end if;

  insert into inventory_movements(ingredient_id,quantity_delta,movement_type,reference_type,reference_id,note)
  select ingredient_id,-sum(quantity_delta),'ADJUSTMENT','order_void',p_order_id,'Pengembalian stok karena void order'
  from inventory_movements
  where reference_type='order' and reference_id=p_order_id and movement_type='SALE'
  group by ingredient_id;

  if v_payment.status='PAID' then
    select id into v_account_id from accounts
    where type=case when v_payment.method='CASH' then 'CASH' else 'QRIS' end and is_active
    order by created_at limit 1;
    insert into ledger_entries(account_id,amount,entry_type,reference_type,reference_id,description)
    values(v_account_id,-v_payment.amount,'REFUND','order',p_order_id,'Refund void order') on conflict do nothing;
    update payments set status='REFUNDED',updated_at=now() where id=v_payment.id;
  end if;

  update orders set status='CANCELLED',cancelled_at=now(),notes=concat_ws(E'\n',notes,'VOID: '||p_reason),updated_at=now()
  where id=p_order_id;
  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('ORDER_VOIDED','order',p_order_id,jsonb_build_object('reason',p_reason));
  return p_order_id;
end $$;

revoke all on function public.void_fulfilled_order(uuid,text) from public;
