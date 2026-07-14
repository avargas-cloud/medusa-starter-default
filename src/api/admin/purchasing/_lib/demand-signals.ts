/** Shared demand signals for the purchasing analysis.
 *
 *  Both the snapshot list (`/admin/purchasing/snapshot`) and the per-variant
 *  alternatives feed (`/admin/purchasing/alternatives/:id`) need these, and the two
 *  rows sit side by side in the same grid — if the definitions ever drift, the parent
 *  row and its alternatives silently disagree about the same SKU. Keep them here, in
 *  one place, rather than copy-pasted into each route.
 */

/** POS go-live. Before this date the history is an aggregated Excel import with no
 *  per-order/per-customer granularity, so concentration cannot be measured. */
export const STORE_EPOCH = "2026-04-14";

/** Order/customer concentration since go-live — the basis of the "looks like a
 *  one-off project sale" flag (one customer buying in bulk, not organic repeat
 *  demand). Exposes: distinct_orders, distinct_customers, total_qty_live, top_order_qty.
 *  Join on `project_signal.variant_id`. */
export const PROJECT_SIGNAL_CTE = `
  SELECT variant_id,
         COUNT(DISTINCT invoice_id)::int AS distinct_orders,
         COUNT(DISTINCT customer_id)::int AS distinct_customers,
         SUM(inv_qty)::int AS total_qty_live,
         MAX(inv_qty)::int AS top_order_qty
  FROM (
    SELECT pii.variant_id, pii.invoice_id, pi.customer_id,
           SUM(pii.quantity - pii.refunded_quantity) AS inv_qty
    FROM pos_invoice_item pii
    JOIN pos_invoice pi ON pi.id = pii.invoice_id
    WHERE pi.issued_at >= '${STORE_EPOCH}'
      AND pi.status NOT IN ('voided')
      AND pii.deleted_at IS NULL
      AND pii.variant_id IS NOT NULL
    GROUP BY pii.variant_id, pii.invoice_id, pi.customer_id
  ) per_invoice
  WHERE inv_qty > 0
  GROUP BY variant_id`;

/** Net unmet demand over the SAME 28-calendar-day window as `sales_last_24d`.
 *
 *  WHY THIS EXISTS SEPARATELY FROM `snapshot.unmet_net_30d`: that column is measured
 *  over the tier0 window (26 business days), which does NOT line up with the L4W
 *  window (28 calendar days ≈ 24 Mon-Sat days). Dividing tier0-window unmet demand by
 *  the L4W day count overstates the daily rate. The "Factory 4W" column blends unmet
 *  demand into the realized rate — realized sales understate true demand when Miami
 *  was out of stock (you sold less because you had none) — so it needs an unmet figure
 *  measured over exactly its own window. Anything else is comparing two clocks.
 *
 *  `requested` = customer asked for it · `purchased` = they took a forced alternative.
 *  Net = requested − purchased: demand we genuinely failed to serve, floored at 0.
 *  Join on `unmet_l4w.variant_id`. */
export const UNMET_L4W_CTE = `
  SELECT udi.variant_id,
         GREATEST(0,
           COALESCE(SUM(udi.quantity) FILTER (WHERE udi.kind = 'requested'), 0)
           - COALESCE(SUM(udi.quantity) FILTER (WHERE udi.kind = 'purchased'), 0)
         )::int AS unmet_net_l4w
  FROM unmet_demand_item udi
  JOIN unmet_demand_record udr ON udr.id = udi.record_id
  WHERE udi.variant_id IS NOT NULL
    AND udr.created_at >= (NOW() - INTERVAL '28 days')
  GROUP BY udi.variant_id`;
