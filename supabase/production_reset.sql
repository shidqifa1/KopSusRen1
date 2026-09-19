begin;
truncate table public.audit_logs, public.inventory_reservations, public.inventory_movements,
  public.purchase_items, public.purchases, public.payments, public.order_items, public.orders,
  public.po_product_limits, public.po_sessions, public.ledger_entries, public.customers restart identity cascade;
commit;

-- Setelah reset: masukkan opening stock dan saldo REAL sebagai ledger baru.
