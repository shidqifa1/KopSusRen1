begin;

-- Keep a per-cup cost when an item is recorded. Existing sales cannot recover
-- their original ingredient prices, so their frozen backfill is flagged.
alter table public.order_items
  add column unit_cost_snapshot numeric(18,4) check (unit_cost_snapshot >= 0),
  add column cost_is_estimate boolean not null default true;

create function public.calculate_order_item_hpp(p_product_id uuid, p_no_ice boolean)
returns numeric language sql stable set search_path = public as $$
  select round(500 + coalesce(sum(ri.quantity * stock.average_cost), 0), 4)
  from public.recipes r
  join public.recipe_items ri on ri.recipe_id = r.id
  join public.ingredients i on i.id = ri.ingredient_id
  join public.inventory_stock stock on stock.ingredient_id = i.id
  where r.product_id = p_product_id
    and not (coalesce(p_no_ice, false) and i.code = 'ICE');
$$;

create function public.capture_order_item_hpp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_source text;
begin
  select source into v_source from public.orders where id = new.order_id;
  new.unit_cost_snapshot := public.calculate_order_item_hpp(new.product_id, new.no_ice);
  new.cost_is_estimate := v_source = 'IMPORT';
  return new;
end;
$$;

create trigger order_item_hpp_on_insert
before insert on public.order_items
for each row execute function public.capture_order_item_hpp();

-- Orders already open at migration time have no creation-time cost. Freeze
-- their best available estimate if they are fulfilled later.
create function public.capture_legacy_order_hpp_on_fulfillment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.order_items oi
  set unit_cost_snapshot = public.calculate_order_item_hpp(oi.product_id, oi.no_ice),
      cost_is_estimate = true
  where oi.order_id = new.id and oi.unit_cost_snapshot is null;
  return new;
end;
$$;

create trigger legacy_order_hpp_on_fulfillment
after update of status on public.orders
for each row when (new.status = 'FULFILLED' and old.status is distinct from new.status)
execute function public.capture_legacy_order_hpp_on_fulfillment();

update public.order_items oi
set unit_cost_snapshot = public.calculate_order_item_hpp(oi.product_id, oi.no_ice),
    cost_is_estimate = true
from public.orders o
where o.id = oi.order_id and o.status = 'FULFILLED' and oi.unit_cost_snapshot is null;

revoke all on function public.calculate_order_item_hpp(uuid, boolean) from public;
revoke all on function public.capture_order_item_hpp() from public;
revoke all on function public.capture_legacy_order_hpp_on_fulfillment() from public;

commit;
