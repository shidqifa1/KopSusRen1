-- Manual HPP is a cost basis only: it never creates stock or cash movements.
alter table public.ingredients
  add column cost_pack_price numeric(18,4) check (cost_pack_price >= 0),
  add column cost_pack_quantity numeric(18,6) check (cost_pack_quantity > 0),
  add constraint ingredients_cost_pack_pair check (
    (cost_pack_price is null and cost_pack_quantity is null)
    or (cost_pack_price is not null and cost_pack_quantity is not null)
  );

create or replace view public.inventory_stock as
select i.id as ingredient_id, i.code, i.name, i.unit, i.low_stock_threshold,
       coalesce(m.physical_stock, 0) as physical_stock,
       coalesce(r.reserved_stock, 0) as reserved_stock,
       coalesce(m.physical_stock, 0) - coalesce(r.reserved_stock, 0) as available_stock,
       coalesce(i.cost_pack_price / nullif(i.cost_pack_quantity, 0), c.average_cost, 0) as average_cost,
       i.cost_pack_price, i.cost_pack_quantity
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
