/**
 * The `orders` index schema — ONE list, two consumers.
 *
 * These arrays are applied from two places that both have to agree:
 *
 *   - `medusa-config.ts` → the plugin's `indexSettings`, re-applied on EVERY
 *     boot so the index survives the plugin's startup overrides.
 *   - `sync-orders-runner.ts` → applied by the backfill/reindex.
 *
 * They used to be two hand-kept literals, and that cost a broken orders view:
 * `has_deposit` was added to the runner, the reindex made it filterable, and the
 * next backend boot re-applied the config's older list and silently dropped it —
 * so every request carrying that filter came back 500 with
 * "Attribute `has_deposit` is not filterable".
 *
 * A new filterable field is now one edit. Adding one to only one side is no
 * longer possible.
 *
 * Deliberately import-free: `medusa-config.ts` is evaluated before the app
 * container exists, so anything this file pulled in would load at that moment
 * too. Keep it as plain data.
 */

export const ORDERS_SEARCHABLE_ATTRIBUTES = [
  "document_number",
  "display_id_str",
  "customer_name",
  "customer_email",
  "customer_phone",
  "customer_phone_digits",
  "company_name",
  "qb_sales_order_ref",
  "qb_invoice_refs",
] as const;

export const ORDERS_FILTERABLE_ATTRIBUTES = [
  "status",
  "payment_status",
  "fulfillment_status",
  "effective_payment",
  "is_unpaid",
  // "Is this order holding money I have not used yet" — a different question
  // from effective_payment, which grades how covered the order is. An order can
  // be fully_paid and still hold a live deposit (paid in full, invoiced in
  // part), which is exactly what the Deposited filter is asked to find.
  "has_deposit",
  "is_draft",
  "is_open",
  "is_closed",
  "is_separated",
  "is_canceled",
  "is_voided",
  "is_web",
  "is_web_order",
  "sales_rep_initials",
  "sales_channel_id",
  "created_at_ts",
  "effective_date_ts",
] as const;

export const ORDERS_SORTABLE_ATTRIBUTES = [
  "display_id",
  "created_at_ts",
  "effective_date_ts",
  "total_cents",
] as const;
