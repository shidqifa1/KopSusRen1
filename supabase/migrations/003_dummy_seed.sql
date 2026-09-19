insert into public.products(code,name,price,is_active) values
  ('KSGA','Kopi Susu Gula Aren',8000,true),
  ('LATTE','Latte',8000,true),
  ('AMERICANO','Americano',8000,true),
  ('MATCHA','Matcha Latte',12000,true)
on conflict(code) do update set name=excluded.name,price=excluded.price,is_active=excluded.is_active;

insert into public.ingredients(code,name,unit,low_stock_threshold,is_active) values
  ('COFFEE','Kopi','g',100,true),('MILK','Susu UHT','ml',1000,true),
  ('PALM_SUGAR','Gula Aren','g',300,true),('MATCHA_POWDER','Matcha','g',20,true),
  ('SIMPLE_SYRUP','Simple Syrup','ml',250,true),('WATER','Air','ml',3000,true),
  ('ICE','Es','g',2000,true),('CUP','Cup 380 ml','pcs',10,true)
on conflict(code) do update set name=excluded.name,unit=excluded.unit,low_stock_threshold=excluded.low_stock_threshold,is_active=excluded.is_active;

insert into public.accounts(name,type) values ('Cash','CASH'),('Blu','BANK'),('QRIS','QRIS')
on conflict(name) do update set type=excluded.type,is_active=true;

insert into public.recipes(product_id,notes)
select id,'Resep dummy development' from public.products
on conflict(product_id) do update set notes=excluded.notes;

insert into public.recipe_items(recipe_id,ingredient_id,quantity)
select r.id,i.id,x.quantity from (values
 ('KSGA','COFFEE',6.5::numeric),('KSGA','MILK',100),('KSGA','PALM_SUGAR',18),('KSGA','ICE',250),('KSGA','CUP',1),
 ('LATTE','COFFEE',6.5),('LATTE','MILK',150),('LATTE','ICE',250),('LATTE','CUP',1),
 ('AMERICANO','COFFEE',6.5),('AMERICANO','WATER',210),('AMERICANO','ICE',250),('AMERICANO','CUP',1),
 ('MATCHA','MATCHA_POWDER',5),('MATCHA','WATER',50),('MATCHA','SIMPLE_SYRUP',25),('MATCHA','MILK',100),('MATCHA','ICE',150),('MATCHA','CUP',1)
) x(product_code,ingredient_code,quantity)
join public.products p on p.code=x.product_code join public.recipes r on r.product_id=p.id
join public.ingredients i on i.code=x.ingredient_code
on conflict(recipe_id,ingredient_id) do update set quantity=excluded.quantity;

insert into public.inventory_movements(ingredient_id,quantity_delta,movement_type,note)
select i.id,x.quantity,'OPENING_BALANCE','Dummy opening stock development'
from (values ('COFFEE',1000::numeric),('MILK',10000),('PALM_SUGAR',3000),('MATCHA_POWDER',500),('SIMPLE_SYRUP',3000),('WATER',30000),('ICE',20000),('CUP',100)) x(code,quantity)
join public.ingredients i on i.code=x.code
where not exists(select 1 from public.inventory_movements m where m.ingredient_id=i.id and m.quantity_delta<>0);

insert into public.ledger_entries(account_id,amount,entry_type,description)
select a.id,x.amount,'OPENING_BALANCE','Dummy opening balance development'
from (values ('Cash',500000::numeric),('Blu',1000000),('QRIS',250000)) x(name,amount)
join public.accounts a on a.name=x.name
where not exists(select 1 from public.ledger_entries le where le.account_id=a.id);
