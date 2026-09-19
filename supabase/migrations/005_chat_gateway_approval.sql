create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'gateway',
  wa_message_id text unique,
  customer_phone text,
  customer_name text,
  direction text not null default 'INBOUND' check (direction in ('INBOUND','OUTBOUND')),
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.order_drafts (
  id uuid primary key default gen_random_uuid(),
  source_message_id uuid references public.chat_messages(id) on delete set null,
  customer_name text,
  class_name text,
  customer_phone text,
  items jsonb not null default '[]'::jsonb,
  state text not null default 'INCOMPLETE' check (state in ('INCOMPLETE','DRAFT_READY','APPROVED','REJECTED','EXPIRED')),
  missing jsonb not null default '[]'::jsonb,
  confidence numeric(5,2) not null default 0,
  session_hint text,
  notes text,
  created_order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'ORDER_DRAFT',
  draft_id uuid not null references public.order_drafts(id) on delete cascade,
  status text not null default 'NEEDS_APPROVAL' check (status in ('NEEDS_APPROVAL','APPROVED','REJECTED','EXPIRED')),
  payload jsonb not null default '{}'::jsonb,
  reason text,
  resolved_by text,
  resolved_at timestamptz,
  execution jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists approval_requests_status_idx on public.approval_requests(status, created_at desc);
create index if not exists order_drafts_state_idx on public.order_drafts(state, created_at desc);
create index if not exists chat_messages_customer_idx on public.chat_messages(customer_phone, created_at desc);

alter table public.chat_messages enable row level security;
alter table public.order_drafts enable row level security;
alter table public.approval_requests enable row level security;

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
  v_created_order_id uuid;
  v_first boolean := true;
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
  if not found then raise exception 'Draft order tidak ditemukan'; end if;
  if v_draft.state <> 'DRAFT_READY' then raise exception 'Draft belum lengkap'; end if;

  for v_item in select * from jsonb_array_elements(v_draft.items)
  loop
    select id into v_product_id from products
    where lower(code)=lower(v_item->>'productCode') and is_active
    limit 1;
    if v_product_id is null then
      raise exception 'Menu draft tidak ditemukan: %', v_item->>'productCode';
    end if;
    v_created_order_id := create_order(
      v_draft.customer_name,
      v_draft.class_name,
      p_po_session_id,
      v_product_id,
      coalesce((v_item->>'quantity')::integer, 1),
      p_payment_method,
      coalesce((v_draft.notes ilike '%tanpa es%'), false),
      concat_ws(E'\n', v_draft.notes, 'Draft WA ' || v_draft.id::text),
      'approval:' || p_approval_id::text || ':' || (v_item->>'productCode')
    );
    if v_first then
      v_order_id := v_created_order_id;
      v_first := false;
    end if;
  end loop;

  if v_order_id is null then raise exception 'Draft tidak punya item'; end if;

  update order_drafts
    set state='APPROVED', created_order_id=v_order_id, updated_at=now()
    where id=v_draft.id;
  update approval_requests
    set status='APPROVED',
        resolved_by=p_resolved_by,
        resolved_at=now(),
        execution=jsonb_build_object('order_id', v_order_id, 'payment_method', p_payment_method, 'po_session_id', p_po_session_id),
        updated_at=now()
    where id=p_approval_id;
  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('ORDER_DRAFT_APPROVED','approval_request',p_approval_id,jsonb_build_object('draft_id',v_draft.id,'order_id',v_order_id));
  return v_order_id;
end $$;

create or replace function public.reject_order_draft(
  p_approval_id uuid,
  p_resolved_by text,
  p_reason text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_approval approval_requests%rowtype;
begin
  select * into v_approval from approval_requests where id=p_approval_id for update;
  if not found then raise exception 'Approval tidak ditemukan'; end if;
  if v_approval.status <> 'NEEDS_APPROVAL' then return p_approval_id; end if;
  update order_drafts set state='REJECTED', updated_at=now() where id=v_approval.draft_id;
  update approval_requests
    set status='REJECTED', resolved_by=p_resolved_by, resolved_at=now(), reason=p_reason, updated_at=now()
    where id=p_approval_id;
  insert into audit_logs(event_type,entity_type,entity_id,payload)
  values('ORDER_DRAFT_REJECTED','approval_request',p_approval_id,jsonb_build_object('reason',p_reason));
  return p_approval_id;
end $$;

revoke all on function public.approve_order_draft(uuid,text,text,uuid) from public;
revoke all on function public.reject_order_draft(uuid,text,text) from public;
