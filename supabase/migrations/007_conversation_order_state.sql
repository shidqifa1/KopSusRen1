create table if not exists public.conversation_order_states (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'whatsapp',
  customer_phone text not null,
  order_state jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','collecting_information','ready_to_confirm','confirmed','cancelled','expired')),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(channel, customer_phone)
);

create index if not exists conversation_order_states_status_idx on public.conversation_order_states(status, updated_at desc);
alter table public.conversation_order_states enable row level security;
revoke all on public.conversation_order_states from anon, authenticated;
