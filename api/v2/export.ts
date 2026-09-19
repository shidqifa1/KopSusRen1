import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../../db/index.js";
import { errorMessage, requireAuth } from "../_guard.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const type = typeof req.query.type === "string" ? req.query.type : "";
    if (type === "sales") {
      const rows = await sql`
        select o.id as order_id, o.created_at, coalesce(c.name, 'Customer') as customer_name,
               coalesce(c.class_name, '') as class_name, pr.name as product_name,
               oi.unit_price::float8 as unit_price, coalesce(o.notes, '') as notes,
               o.payment_method
        from orders o
        left join customers c on c.id = o.customer_id
        join order_items oi on oi.order_id = o.id
        join products pr on pr.id = oi.product_id
        cross join lateral generate_series(1, greatest(oi.qty, 1)) cup
        where o.status = 'FULFILLED'
        order by o.created_at, o.id, oi.created_at, cup`;
      return res.status(200).json({ ok: true, rows });
    }

    if (type === "cash") {
      const rows = await sql`
        select * from (
          select le.id, le.created_at, le.amount::float8 as amount, le.description,
                 sum(le.amount) over (
                   partition by le.account_id order by le.created_at, le.id
                   rows between unbounded preceding and current row
                 )::float8 as running_balance
          from ledger_entries le
          join accounts a on a.id = le.account_id
          where a.type = 'CASH'
        ) history
        order by created_at, id`;
      return res.status(200).json({ ok: true, rows });
    }

    return res.status(400).json({ ok: false, error: "Jenis export tidak valid" });
  } catch (error) {
    console.error("export_v2_failed", error);
    return res.status(500).json({ ok: false, error: errorMessage(error) });
  }
}
