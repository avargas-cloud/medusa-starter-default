/**
 * build-order-cost-snapshot.ts
 *
 * Captures the per-line cost basis of a Medusa order at a moment in time, so an
 * order-only PaymentApplication can freeze it (column `payment_application.cost_snapshot`).
 *
 * This mirrors EXACTLY the order-line cost logic used by Treasury's `order_lines`
 * CTE in load-sales-by-application.ts (ORDER_COST_FALLBACK_EXPR + is_sourced_via_agent
 * origin flag). Treasury, when a snapshot is present, reads from it instead of the
 * live product metadata — eliminating COGS drift on closed days when POs are received.
 *
 * Units: `unit_cost_cents` is the effective unit cost in CENTS.
 *   - metadata.avg_landed_cost_cents is already cents.
 *   - metadata.qb_avg_cost / qb_purchase_cost are dollars → ×100.
 * NULL `unit_cost_cents` means no cost data was available (line excluded from COGS,
 * same as today's live behavior).
 */

import { avgCostCents } from "../cost/cost-sql";

// NOTE: these are `type` aliases (not `interface`) on purpose. Medusa's
// model.json() create-input expects `Record<string, unknown>`, and only object
// *type literals* get an implicit string index signature — interfaces do not —
// so an interface value would fail to assign. See createPaymentApplications callers.
export type CostSnapshotLine = {
  line_id: string;
  variant_id: string | null;
  sku: string;
  quantity: number;
  unit_cost_cents: number | null;
  is_china: boolean;
};

export type OrderCostSnapshot = {
  captured_at: string;
  lines: CostSnapshotLine[];
};

interface PgConnection {
  raw: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface RawLine {
  line_id: string;
  variant_id: string | null;
  sku: string;
  quantity: string | number | null;
  unit_cost_cents: string | number | null;
  is_china: boolean | null;
}

function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build a frozen cost snapshot for every (non-deleted) line of `orderId`.
 * Returns an OrderCostSnapshot ready to store as JSONB. Returns an empty
 * `lines` array if the order has no lines (caller may choose to store null).
 */
export async function buildOrderCostSnapshot(
  pg: PgConnection,
  orderId: string
): Promise<OrderCostSnapshot> {
  const result = await pg.raw(
    `
    SELECT
      oli.id                                                       AS line_id,
      oli.variant_id                                              AS variant_id,
      COALESCE(NULLIF(oli.variant_sku, ''), NULLIF(pv.sku, ''), oli.id) AS sku,
      oi.quantity                                                AS quantity,
      ${avgCostCents("pv")}::bigint                               AS unit_cost_cents,
      ((p.metadata->>'is_sourced_via_agent') = 'true')           AS is_china
    FROM order_item oi
    JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
    LEFT JOIN product_variant pv ON pv.id = oli.variant_id
    LEFT JOIN product p          ON p.id = pv.product_id
    WHERE oi.order_id = ?
    `,
    [orderId]
  );

  const rows = (result.rows ?? []) as RawLine[];
  const lines: CostSnapshotLine[] = rows.map((r) => ({
    line_id: r.line_id,
    variant_id: r.variant_id ?? null,
    sku: r.sku,
    quantity: toNum(r.quantity),
    unit_cost_cents:
      r.unit_cost_cents === null || r.unit_cost_cents === undefined
        ? null
        : toNum(r.unit_cost_cents),
    is_china: r.is_china === true,
  }));

  return {
    captured_at: new Date().toISOString(),
    lines,
  };
}
