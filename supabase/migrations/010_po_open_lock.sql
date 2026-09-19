-- Serialize every transition that may open a PO. This preserves the invariant
-- of exactly one OPEN session even when web actions and gateway heartbeats race.
create or replace function public.set_po_status(p_po_session_id uuid,p_status text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_check jsonb; v_po public.po_sessions%rowtype;
begin
  if p_status not in ('DRAFT','OPEN','CLOSED','COMPLETED','CANCELLED') then raise exception 'Status PO tidak valid'; end if;
  if p_status='OPEN' then
    perform pg_advisory_xact_lock(hashtextextended('kopsusren:single-open-po',0));
  end if;
  select * into v_po from public.po_sessions where id=p_po_session_id for update;
  if not found then raise exception 'PO tidak ditemukan'; end if;
  if p_status='OPEN' then
    if v_po.open_at is not null and v_po.open_at>now() then raise exception 'PO belum mencapai jam buka'; end if;
    if v_po.cutoff_at is not null and v_po.cutoff_at<=now() then raise exception 'Jam tutup PO sudah lewat'; end if;
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
  perform pg_advisory_xact_lock(hashtextextended('kopsusren:single-open-po',0));

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

revoke all on function public.set_po_status(uuid,text) from public;
revoke all on function public.run_po_maintenance() from public;
grant execute on function public.set_po_status(uuid,text) to service_role;
grant execute on function public.run_po_maintenance() to service_role;
