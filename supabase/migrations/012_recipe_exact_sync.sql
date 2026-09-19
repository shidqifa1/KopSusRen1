create or replace function public.update_product_recipe(
  p_product_id uuid,p_price numeric,p_items jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_recipe_id uuid; v_item jsonb;
begin
  if p_price<0 then raise exception 'Harga tidak boleh negatif'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Resep tidak boleh kosong'; end if;

  perform 1 from public.products where id=p_product_id for update;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  if exists(
    select 1 from jsonb_array_elements(p_items) item
    left join public.ingredients i on i.id=(item->>'ingredientId')::uuid and i.is_active
    where i.id is null or (item->>'quantity')::numeric<=0
  ) then raise exception 'Bahan atau jumlah resep tidak valid'; end if;

  update public.products set price=p_price,updated_at=now() where id=p_product_id;
  insert into public.recipes(product_id,notes) values(p_product_id,'Resep utama KopSusRen')
  on conflict(product_id) do update set updated_at=now() returning id into v_recipe_id;

  delete from public.recipe_items ri
  where ri.recipe_id=v_recipe_id
    and not exists(
      select 1 from jsonb_array_elements(p_items) item
      where (item->>'ingredientId')::uuid=ri.ingredient_id
    );

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    insert into public.recipe_items(recipe_id,ingredient_id,quantity)
    values(v_recipe_id,(v_item->>'ingredientId')::uuid,(v_item->>'quantity')::numeric)
    on conflict(recipe_id,ingredient_id) do update set quantity=excluded.quantity;
  end loop;

  insert into public.audit_logs(event_type,entity_type,entity_id,payload)
  values('RECIPE_UPDATED','product',p_product_id,jsonb_build_object('price',p_price,'items',p_items));
  return p_product_id;
end $$;

revoke all on function public.update_product_recipe(uuid,numeric,jsonb) from public;
grant execute on function public.update_product_recipe(uuid,numeric,jsonb) to service_role;
