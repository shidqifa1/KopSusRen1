create table if not exists public.chat_shadow_observations (
  id uuid primary key default gen_random_uuid(),
  source_message_id uuid not null references public.chat_messages(id) on delete cascade,
  wa_message_id text not null,
  customer_ref text not null,
  source_message_created_at timestamptz not null,
  observed_at timestamptz not null default now(),
  normalized_input text not null,
  parser_intents jsonb not null default '[]'::jsonb,
  resolved_items jsonb not null default '[]'::jsonb,
  unresolved_entities jsonb not null default '[]'::jsonb,
  ambiguities jsonb not null default '[]'::jsonb,
  safety_classification text not null check (safety_classification in ('SAFE','NEEDS_CLARIFICATION','OWNER_HANDOFF')),
  clarification_reason text,
  parser_failed boolean not null default false,
  parser_latency_ms integer not null default 0 check (parser_latency_ms >= 0),
  parser_provider text not null,
  parser_model text,
  would_be_safe boolean not null default false,
  parser_result jsonb,
  processing_outcome text not null default 'OBSERVED' check (processing_outcome in ('OBSERVED','STALE')),
  created_at timestamptz not null default now(),
  unique(source_message_id),
  unique(wa_message_id)
);

create index if not exists chat_shadow_observations_customer_idx
  on public.chat_shadow_observations(customer_ref, source_message_created_at desc);
create index if not exists chat_shadow_observations_safety_idx
  on public.chat_shadow_observations(safety_classification, observed_at desc);

alter table public.chat_shadow_observations enable row level security;
revoke all on public.chat_shadow_observations from anon, authenticated;

