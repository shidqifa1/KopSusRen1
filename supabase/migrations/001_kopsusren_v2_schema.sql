create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  class_name text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  price numeric(12,2) not null check (price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  unit text not null,
  low_stock_threshold numeric(14,3) not null default 0 check (low_stock_threshold >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null unique references public.products(id) on delete cascade,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recipe_items (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (recipe_id, ingredient_id)
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null check (type in ('CASH','BANK','QRIS','EWALLET','OTHER')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.po_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  delivery_date date not null,
  cutoff_at timestamptz,
  max_total_cups integer check (max_total_cups is null or max_total_cups > 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','OPEN','CLOSED','COMPLETED','CANCELLED')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.po_product_limits (
  id uuid primary key default gen_random_uuid(),
  po_session_id uuid not null references public.po_sessions(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  max_qty integer check (max_qty is null or max_qty >= 0),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (po_session_id, product_id)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  customer_id uuid references public.customers(id) on delete set null,
  po_session_id uuid references public.po_sessions(id) on delete set null,
  source text not null default 'MANUAL' check (source in ('MANUAL','WHATSAPP','WEB','QUICK_SALE','IMPORT')),
  status text not null default 'ACCEPTED' check (status in ('PENDING','ACCEPTED','PREPARING','READY','FULFILLED','CANCELLED','REJECTED')),
  payment_method text not null check (payment_method in ('CASH','QRIS')),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  notes text,
  idempotency_key text unique,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  qty integer not null check (qty > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  no_ice boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  method text not null check (method in ('CASH','QRIS')),
  status text not null default 'UNPAID' check (status in ('UNPAID','PENDING','PAID','FAILED','EXPIRED','CANCELLED','REFUNDED')),
  amount numeric(12,2) not null check (amount >= 0),
  provider_reference text unique,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity_delta numeric(14,3) not null check (quantity_delta <> 0),
  movement_type text not null check (movement_type in ('OPENING_BALANCE','PURCHASE','SALE','WASTE','ADJUSTMENT','RETURN','PRODUCTION')),
  reference_type text,
  reference_id uuid,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','RELEASED','CONSUMED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, ingredient_id)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  supplier text,
  account_id uuid not null references public.accounts(id) on delete restrict,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  source text not null default 'MANUAL',
  status text not null default 'CONFIRMED' check (status in ('DRAFT','CONFIRMED','CANCELLED')),
  notes text,
  idempotency_key text unique,
  purchased_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  total_cost numeric(12,2) not null check (total_cost >= 0),
  unit_cost numeric(14,4) generated always as (total_cost / nullif(quantity, 0)) stored,
  created_at timestamptz not null default now()
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  amount numeric(12,2) not null check (amount <> 0),
  entry_type text not null check (entry_type in ('OPENING_BALANCE','SALE','EXPENSE','TRANSFER_IN','TRANSFER_OUT','REFUND','ADJUSTMENT')),
  reference_type text,
  reference_id uuid,
  description text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists ledger_reference_once
  on public.ledger_entries (account_id, entry_type, reference_type, reference_id)
  where reference_id is not null;

create table if not exists public.audit_logs (
  id bigserial primary key,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists orders_po_status_idx on public.orders(po_session_id, status);
create index if not exists orders_created_idx on public.orders(created_at desc);
create index if not exists inventory_movements_ingredient_idx on public.inventory_movements(ingredient_id, created_at);
create index if not exists reservations_active_idx on public.inventory_reservations(ingredient_id) where status = 'ACTIVE';

alter table public.orders add column if not exists idempotency_key text;
alter table public.purchases add column if not exists idempotency_key text;
create unique index if not exists orders_idempotency_key_idx on public.orders(idempotency_key) where idempotency_key is not null;
create unique index if not exists purchases_idempotency_key_idx on public.purchases(idempotency_key) where idempotency_key is not null;

create or replace view public.inventory_stock as
select i.id as ingredient_id, i.code, i.name, i.unit, i.low_stock_threshold,
       coalesce(m.physical_stock, 0) as physical_stock,
       coalesce(r.reserved_stock, 0) as reserved_stock,
       coalesce(m.physical_stock, 0) - coalesce(r.reserved_stock, 0) as available_stock,
       coalesce(c.average_cost, 0) as average_cost
from public.ingredients i
left join (
  select ingredient_id, sum(quantity_delta) as physical_stock
  from public.inventory_movements group by ingredient_id
) m on m.ingredient_id = i.id
left join (
  select ingredient_id, sum(quantity) as reserved_stock
  from public.inventory_reservations where status = 'ACTIVE' group by ingredient_id
) r on r.ingredient_id = i.id
left join (
  select ingredient_id, sum(total_cost) / nullif(sum(quantity), 0) as average_cost
  from public.purchase_items group by ingredient_id
) c on c.ingredient_id = i.id;

create or replace view public.account_balances as
select a.id as account_id, a.name, a.type, coalesce(sum(le.amount), 0) as balance
from public.accounts a
left join public.ledger_entries le on le.account_id = a.id
group by a.id, a.name, a.type;

alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.ingredients enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_items enable row level security;
alter table public.accounts enable row level security;
alter table public.po_sessions enable row level security;
alter table public.po_product_limits enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_reservations enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.audit_logs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
