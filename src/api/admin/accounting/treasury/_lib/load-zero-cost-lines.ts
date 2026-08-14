/**
 * load-zero-cost-lines.ts
 *
 * Surfaces the specific CASH sale lines that shipped/were-paid in
 * [dayStart, dayEnd] but carry NO usable cost (unit cost is NULL or literally
 * $0). Because compute-splits.ts can only weight China/Local COGS against
 * lines that HAVE a cost, a zero-cost line contributes $0 to the COGS pool —
 * so its full revenue lands in Operating instead of being split. That's not
 * always wrong (a genuine free sample/giveaway is legitimately $0 cost), but
 * it's just as often a data error (a brand-new product whose purchase cost was
 * never loaded — e.g. SAT-65-869 on 2026-07-15, a $4,237 deposit that pushed
 * the whole day to Operating). Either way the accountant should eyeball it.
 *
 * Scope is CASH-funded applications only (method <> 'credit_memo'): those are
 * the ones whose revenue actually entered net cash this day and therefore
 * inflated Operating. Credit-memo redemptions move no new cash, so a zero-cost
 * redemption is a different (ratio-only) concern already covered by the
 * credit_memo_cogs_gaps panel — including it here would just be noise.
 *
 * This is READ-ONLY / advisory: it never changes a number. It materializes,
 * with per-line detail, exactly what the existing LINES_MISSING_AVG_COST
 * warning only counted — so the accountant can click through to the
 * invoice/order and verify each one.
 */

import {
  COST_FALLBACK_EXPR,
  ORDER_COST_FALLBACK_EXPR,
} from "./load-sales-by-application";

type PgConnection = {
  raw: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
};

export interface ZeroCostLineRow {
  source_kind: "invoice" | "order";
  /** pos_invoice.id or order.id — for building a detail-page link. */
  source_id: string | null;
  /** Invoice number (e.g. "20930") or order display id (e.g. "2450"). */
  source_ref: string | null;
  payment_display_id: number | null;
  sku: string | null;
  description: string | null;
  quantity: number;
  /** Sale value of this line attributed to the day's cash (weighted by the
   * payment's proportion of its source total), in cents. This is the money
   * that flowed to Operating with no matching COGS. */
  revenue_cents: number;
  /** 'china' | 'local' | 'untagged' — where the COGS WOULD have gone. */
  origin: "china" | "local" | "untagged";
  /** true when the unit cost is literally 0 (possible legit sample); false
   * when it's missing entirely (more likely a data error). */
  cost_is_explicit_zero: boolean;
}

export async function loadZeroCostLines(
  pg: PgConnection,
  dayStart: string,
  dayEnd: string
): Promise<ZeroCostLineRow[]> {
  const result = await pg.raw(
    `
    WITH apps_day AS (
      SELECT
        pa.id            AS app_id,
        pa.invoice_id,
        pa.order_id,
        pa.amount_applied,
        pa.cost_snapshot,
        cp.display_id    AS payment_display_id
      FROM payment_application pa
      JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.voided_at IS NULL
        AND pa.deleted_at IS NULL
        AND cp.deleted_at IS NULL
        AND cp.type = 'payment' AND COALESCE(cp.metadata->>'is_commission_credit', '') <> 'true'
        AND COALESCE(cp.method, '') <> 'credit_memo'
        AND cp.status <> 'voided'
        AND cp.received_at >= ? AND cp.received_at <= ?
    ),

    invoice_lines AS (
      SELECT
        'invoice'                                                     AS source_kind,
        pi.id                                                         AS source_id,
        pi.invoice_number                                             AS source_ref,
        ad.payment_display_id,
        COALESCE(NULLIF(pii.sku, ''), NULLIF(pv.sku, ''), pii.id)     AS sku,
        COALESCE(NULLIF(pii.description, ''), p.title, pii.sku)       AS description,
        pii.quantity                                                  AS quantity,
        ROUND(pii.total * CASE WHEN pi.total > 0 THEN ad.amount_applied::numeric / pi.total ELSE 0 END) AS revenue_cents,
        ${COST_FALLBACK_EXPR}                                         AS effective_unit_cost,
        (p.metadata->>'is_sourced_via_agent')                         AS origin_flag,
        p.id                                                          AS product_id
      FROM apps_day ad
      JOIN pos_invoice pi       ON pi.id = ad.invoice_id
      JOIN pos_invoice_item pii ON pii.invoice_id = pi.id
      LEFT JOIN product_variant pv ON pv.id = pii.variant_id
      LEFT JOIN product p          ON p.id = pv.product_id
      WHERE ad.invoice_id IS NOT NULL
        AND COALESCE(pi.status, '') NOT IN ('draft','voided','cancelled')
    ),

    order_lines AS (
      SELECT
        'order'                                                       AS source_kind,
        o.id                                                          AS source_id,
        o.display_id::text                                            AS source_ref,
        ad.payment_display_id,
        COALESCE(NULLIF(oli.variant_sku, ''), NULLIF(pv.sku, ''), oli.id) AS sku,
        COALESCE(NULLIF(oli.title, ''), p.title, oli.variant_sku)     AS description,
        oi.quantity                                                   AS quantity,
        ROUND(
          ROUND(oli.unit_price * oi.quantity * 100)
          * CASE WHEN ot.source_total_cents > 0 THEN ad.amount_applied::numeric / ot.source_total_cents ELSE 0 END
        )                                                             AS revenue_cents,
        COALESCE(cs.snap_unit_cost_cents / 100.0, ${ORDER_COST_FALLBACK_EXPR}) AS effective_unit_cost,
        CASE
          WHEN cs.snap_is_china IS NOT NULL
            THEN (CASE WHEN cs.snap_is_china THEN 'true' ELSE 'false' END)
          ELSE (p.metadata->>'is_sourced_via_agent')
        END                                                           AS origin_flag,
        p.id                                                          AS product_id
      FROM apps_day ad
      JOIN "order" o           ON o.id = ad.order_id
      JOIN order_item oi       ON oi.order_id = o.id
      JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      JOIN LATERAL (
        SELECT COALESCE(SUM(ROUND(oli2.unit_price * oi2.quantity * 100)), 0)::numeric AS source_total_cents
        FROM order_item oi2
        JOIN order_line_item oli2 ON oli2.id = oi2.item_id AND oli2.deleted_at IS NULL
        WHERE oi2.order_id = o.id
      ) ot ON TRUE
      LEFT JOIN LATERAL (
        SELECT (snap->>'unit_cost_cents')::numeric AS snap_unit_cost_cents,
               (snap->>'is_china')::boolean        AS snap_is_china
        FROM jsonb_array_elements(COALESCE(ad.cost_snapshot->'lines', '[]'::jsonb)) snap
        WHERE snap->>'line_id' = oli.id
        LIMIT 1
      ) cs ON TRUE
      LEFT JOIN product_variant pv ON pv.id = oli.variant_id
      LEFT JOIN product p          ON p.id = pv.product_id
      WHERE ad.invoice_id IS NULL
        AND ad.order_id IS NOT NULL
        AND COALESCE(o.status::text, '') NOT IN ('draft','canceled','cancelled')
    ),

    all_lines AS (
      SELECT * FROM invoice_lines
      UNION ALL
      SELECT * FROM order_lines
    )

    SELECT
      source_kind,
      source_id,
      source_ref,
      payment_display_id,
      sku,
      description,
      quantity,
      revenue_cents,
      CASE
        WHEN origin_flag = 'true' THEN 'china'
        WHEN origin_flag IS NULL  THEN 'untagged'
        ELSE 'local'
      END                                       AS origin,
      (effective_unit_cost IS NOT NULL AND effective_unit_cost = 0) AS cost_is_explicit_zero
    FROM all_lines
    WHERE product_id IS NOT NULL
      AND (effective_unit_cost IS NULL OR effective_unit_cost = 0)
    ORDER BY revenue_cents DESC
    LIMIT 500
    `,
    [dayStart, dayEnd]
  );

  return (result.rows ?? []).map((r) => ({
    source_kind: r.source_kind,
    source_id: r.source_id ?? null,
    source_ref: r.source_ref ?? null,
    payment_display_id: r.payment_display_id ?? null,
    sku: r.sku ?? null,
    description: r.description ?? null,
    quantity: Number(r.quantity) || 0,
    revenue_cents: Number(r.revenue_cents) || 0,
    origin: r.origin,
    cost_is_explicit_zero: r.cost_is_explicit_zero === true,
  }));
}
