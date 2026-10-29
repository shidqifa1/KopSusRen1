import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../../db/index.js";
import { errorMessage, requireAuth } from "../_guard.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const scope = typeof req.query.scope === "string" ? req.query.scope : "full";
    const lightPo = scope === "po";
    const productsAndIngredients = [
      sql`select id, code, name, price::float8 as price, is_active, chatbot_metadata from products order by name`,
      sql`select ingredient_id as id, code, name, unit, low_stock_threshold::float8 as low_stock_threshold,
                 physical_stock::float8 as physical_stock,
                 reserved_stock::float8 as reserved_stock,
                 available_stock::float8 as available_stock,
                 average_cost::float8 as average_cost,
                 cost_pack_price::float8 as cost_pack_price,
                 cost_pack_quantity::float8 as cost_pack_quantity
          from inventory_stock order by name`,
    ];
    const ordersAndMovements = [
      sql`select o.id, o.order_number, o.po_session_id, o.source, o.status, o.payment_method, o.total_amount::float8 as total_amount,
                 o.notes, o.created_at, c.name as customer_name, c.class_name,
                 coalesce(o.customer_phone,c.phone) as customer_phone,
                 p.status as payment_status, p.expires_at, p.proof_received_at,
                 coalesce(json_agg(json_build_object(
                   'order_item_id', oi.id,
                   'product_id', pr.id, 'product_code', pr.code, 'product_name', pr.name,
                   'quantity', oi.qty, 'unit_price', oi.unit_price::float8,
                   'unit_cost_snapshot', oi.unit_cost_snapshot::float8,
                   'cost_is_estimate', oi.cost_is_estimate,
                   'no_ice', oi.no_ice, 'notes', oi.notes
                 ) order by oi.created_at) filter (where oi.id is not null), '[]') as items
          from orders o
          left join customers c on c.id = o.customer_id
          left join payments p on p.order_id = o.id
          left join order_items oi on oi.order_id = o.id
          left join products pr on pr.id = oi.product_id
          where o.id in (
            (select id from orders order by created_at desc limit 500)
            union
            (select id from orders where source = 'IMPORT')
          )
          group by o.id, c.name, c.class_name, c.phone, p.status, p.expires_at, p.proof_received_at
          order by o.created_at desc limit 500`,
      lightPo ? Promise.resolve([]) : sql`select id, ingredient_id, quantity_delta::float8 as quantity_delta, movement_type,
                 reference_type, reference_id, note, created_at
          from inventory_movements order by created_at desc limit 500`,
    ];
    const accountsAndPurchases = [
      sql`select account_id as id, name, type, balance::float8 as balance from account_balances order by name`,
      lightPo ? Promise.resolve([]) : sql`select pu.id, pu.supplier, pu.total_amount::float8 as total_amount, pu.purchased_at,
                 pu.notes, a.name as account_name,
                 coalesce(json_agg(json_build_object(
                   'ingredient_id', pi.ingredient_id, 'ingredient_name', i.name,
                   'quantity', pi.quantity::float8, 'total_cost', pi.total_cost::float8
                 )) filter (where pi.id is not null), '[]') as items
          from purchases pu
          left join accounts a on a.id = pu.account_id
          left join purchase_items pi on pi.purchase_id = pu.id
          left join ingredients i on i.id = pi.ingredient_id
          group by pu.id, a.name order by pu.purchased_at desc limit 200`,
    ];
    const poSessionsQuery =
      sql`select ps.id, ps.name, ps.delivery_date, ps.open_at, ps.cutoff_at, ps.max_total_cups, ps.status, ps.qris_timeout_minutes,
                 coalesce(sum(oi.qty) filter (where o.status not in ('CANCELLED','REJECTED')), 0)::int as ordered_cups,
                 case when ps.status='OPEN' then evaluate_po_availability(ps.id,'[]'::jsonb) end as availability,
                 case when ps.status='OPEN' then get_po_summary(ps.id) end as summary,
                 coalesce((
                   select json_agg(json_build_object(
                     'ingredient_id', i.id,
                     'ingredient_code', i.code,
                     'ingredient_name', i.name,
                     'unit', i.unit,
                     'max_quantity', pil.max_quantity::float8,
                     'auto_close_threshold', pil.auto_close_threshold::float8,
                     'used_quantity', coalesce(used.quantity,0)::float8,
                     'remaining_quantity', greatest(pil.max_quantity - coalesce(used.quantity,0),0)::float8
                   ) order by i.name)
                   from po_ingredient_limits pil
                   join ingredients i on i.id=pil.ingredient_id
                   left join lateral (
                     select sum(ir.quantity) as quantity
                     from inventory_reservations ir
                     join orders oo on oo.id=ir.order_id
                     where oo.po_session_id=ps.id
                       and oo.status not in ('CANCELLED','REJECTED')
                       and ir.status in ('ACTIVE','CONSUMED')
                       and ir.ingredient_id=pil.ingredient_id
                   ) used on true
                   where pil.po_session_id=ps.id and pil.is_enabled
                 ), '[]'::json) as ingredient_limits
          from po_sessions ps
          left join orders o on o.po_session_id = ps.id
          left join order_items oi on oi.order_id = o.id
          group by ps.id order by ps.delivery_date desc limit 40`;
    const ledgerAndGateway = [
      lightPo ? Promise.resolve([]) : sql`select le.id, le.amount::float8 as amount, le.entry_type, le.description, le.created_at,
                 sum(le.amount) over(partition by le.account_id order by le.created_at, le.id)::float8 as running_balance,
                 a.name as account_name, a.type as account_type
          from ledger_entries le
          join accounts a on a.id = le.account_id
          order by le.created_at desc limit 500`,
      sql`select provider,status,last_heartbeat_at,metadata from chat_gateway_status where provider='baileys' limit 1`,
    ];

    const recipesQuery = sql`select p.id as product_id, i.id as ingredient_id,
                                      ri.quantity::float8 as quantity
                               from recipe_items ri
                               join recipes r on r.id = ri.recipe_id
                               join products p on p.id = r.product_id
                               join ingredients i on i.id = ri.ingredient_id`;

    // The shared pool still caps active connections at two. Dispatching reads
    // together removes the unnecessary wait between unrelated query groups.
    const [products, ingredients, orders, movements, accounts, purchases, poSessions,
      ledgerEntries, gatewayStatus, recipes] = await Promise.all([
      ...productsAndIngredients, ...ordersAndMovements, ...accountsAndPurchases,
      poSessionsQuery, ...ledgerAndGateway, recipesQuery,
    ]);

    res.status(200).json({ ok: true, environment: process.env.APP_ENV || "development", products, ingredients, recipes, orders, movements, accounts, purchases, poSessions, ledgerEntries, gatewayStatus: gatewayStatus[0] || null });
  } catch (error) {
    console.error("bootstrap_v2_failed", error);
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
}
