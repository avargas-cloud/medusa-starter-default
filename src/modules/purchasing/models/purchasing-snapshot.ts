import { model } from "@medusajs/utils";

/**
 * Cached output of the Daily Sales Engine + Pareto Engine for every variant.
 * Recalculated nightly at 12 AM via cron job, or on-demand via
 * POST /admin/purchasing/recalculate.
 *
 * abc_class: 'A' | 'B' | 'C'
 * xyz_class: 'X' (stable CV<0.5) | 'Y' (variable 0.5-1) | 'Z' (erratic >1)
 * abcxyz_class: combined e.g. 'AX', 'AZ', 'BX' ...
 */
export const PurchasingSnapshot = model.define("purchasing_snapshot", {
  id: model.id({ prefix: "psnap" }).primaryKey(),

  variant_id: model.text(),

  // ── Daily Sales Engine output ──────────────────────────────────────────
  tier0_30d: model.bigNumber().default(0),    // sales last 30 days (monthly equiv.)
  sales_q4: model.bigNumber().default(0),     // avg months 10-12
  sales_q3: model.bigNumber().default(0),     // avg months 7-9
  sales_q2: model.bigNumber().default(0),     // avg months 4-6
  sales_q1: model.bigNumber().default(0),     // avg months 1-3 (oldest)
  daily_sales_est: model.bigNumber().default(0),
  monthly_sales_est: model.bigNumber().default(0),

  // ── ABC-XYZ Engine output ──────────────────────────────────────────────
  cv: model.bigNumber().default(0),           // coefficient of variation
  weighted_revenue: model.bigNumber().default(0),
  pareto_rank: model.number().nullable(),
  abc_class: model.text().nullable(),         // 'A' | 'B' | 'C'
  xyz_class: model.text().nullable(),         // 'X' | 'Y' | 'Z'
  abcxyz_class: model.text().nullable(),      // 'AX' | 'AZ' | 'BX' etc.

  // ── Inventory snapshot (at time of calculation) ───────────────────────
  inv_usa: model.number().default(0),
  inv_china: model.number().default(0),
  qty_on_so: model.number().default(0),
  qty_on_po_usa: model.number().default(0),
  qty_on_po_china: model.number().default(0),

  // ── Reorder recommendation ────────────────────────────────────────────
  qty_to_transfer: model.number().default(0), // order to Veetech (China → USA)
  qty_to_factory: model.number().default(0),  // order to factory (new production)

  last_calculated_at: model.dateTime().nullable(),
});
