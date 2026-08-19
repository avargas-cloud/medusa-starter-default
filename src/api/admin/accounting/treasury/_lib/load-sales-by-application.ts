/**
 * load-sales-by-application.ts
 *
 * Computes daily sales aggregates (gross revenue, tax, COGS china/local, plus
 * data-quality warning counts) anchored to **customer_payment.received_at**,
 * not pos_invoice.created_at.
 *
 * Per the treasury invariant:
 *   Treasury attribution follows the cash. For day D we look at every
 *   PaymentApplication whose CustomerPayment.received_at falls in D, and we
 *   attribute COGS proportionally:
 *     contribution = (amount_applied / source_total) × source_line_costs
 *
 * Sources:
 *   • invoice_id != NULL   → pos_invoice + pos_invoice_item (POS-issued)
 *   • invoice_id IS NULL   → "order" + order_line_item via order_item link
 *                             (Medusa order deposits not yet invoiced)
 *
 * Credit-memo method payments (existing credit being re-applied) never
 * represent new cash, so they're excluded from `gross_revenue_pre_tax_cents`
 * / `tax_collected_cents` — including them there would double-count money
 * already recognized (and its tax passthrough already routed) on the
 * original sale's day. Web payments ARE included in revenue/tax because
 * they correspond to real money captured on D.
 *
 * They are ALSO excluded from cogs_china_cents/cogs_local_cents (as of
 * 2026-07-17). Those two numbers feed a RATIO (china / (china+local)) that
 * decides how a day's real CASH pool gets split — see compute-splits.ts.
 * Since the ratio's denominator (gross_revenue_pre_tax) is already cash-only,
 * counting non-cash credit-memo COGS in the numerator both (a) inflated the
 * ratio inconsistently and (b) DOUBLE-FUNDED the redeemed obligation once the
 * explicit inter-bucket movement feature exists: the redemption nudged the
 * day's split toward local AND an explicit china→local wire moved the parked
 * money. So credit-memo redemption COGS now lives ONLY in the movement section
 * (see load-cm-movements.ts + TREASURY_CREDIT_MEMO_MOVEMENT_PLAN.md), where the
 * accountant approves the real bank rebalance. This supersedes the 2026-07-16
 * fix, which correctly identified the cross-category problem but solved it in
 * the wrong layer (the cash ratio) instead of an explicit movement.
 */

import { avgCostDollars } from "../../../../../lib/cost/cost-sql";

export const STALE_COST_THRESHOLD_DAYS = 30;

export interface SalesAggregateRow {
  gross_revenue_pre_tax_cents: string | null;
  tax_collected_cents: string | null;
  cogs_china_cents: string | null;
  cogs_local_cents: string | null;
  lines_missing_avg_cost_count: string | null;
  stale_cost_count: string | null;
  missing_origin_tag_count: string | null;
  unit_cost_fallback_count: string | null;
  sample_lines_missing_avg_cost: string[] | null;
  sample_stale_cost: string[] | null;
  sample_missing_origin_tag: string[] | null;
  sample_unit_cost_fallback: string[] | null;
}

type PgConnection = { raw: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

// Canonical cost: frozen per-line snapshot first, then the origin-correct
// live average_cost (→ purchase fallback). See lib/cost/cost-sql.ts.
export const COST_FALLBACK_EXPR = `COALESCE(
  pii.average_unit_cost,
  ${avgCostDollars("pv")}
)`;

export const ORDER_COST_FALLBACK_EXPR = avgCostDollars("pv");

export interface CreditMemoCogsGapRow {
  payment_id: string;
  reference: string | null;
  customer_id: string | null;
  invoice_id: string | null;
  order_id: string | null;
  redeemed_on: string;
  cogs_china_cents: string | number;
  cogs_local_cents: string | number;
}

/**
 * Every credit-memo redemption that resolved in [dayStart, dayEnd] (dated by
 * payment_application.applied_at — the actual redemption day, not the
 * original return's cp.received_at), with its China/Local COGS contribution.
 * Whether that contribution actually got routed to a bucket depends on the
 * SAME day's gross_revenue_pre_tax_cents (see compute-splits.ts's pool
 * guard) — the caller (load-daily-report.ts) decides that and tags each row;
 * this function only computes the raw per-payment COGS split.
 */
export async function loadCreditMemoCogsGaps(
  pg: PgConnection,
  dayStart: string,
  dayEnd: string
): Promise<CreditMemoCogsGapRow[]> {
  const result = await pg.raw(
    `
    WITH apps_day AS (
      SELECT pa.id AS app_id, pa.payment_id, pa.invoice_id, pa.order_id,
             pa.amount_applied, pa.cost_snapshot, pa.applied_at
      FROM payment_application pa
      JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.voided_at IS NULL AND pa.deleted_at IS NULL AND cp.deleted_at IS NULL
        AND cp.type = 'credit_memo' AND cp.method = 'credit_memo' AND cp.status <> 'voided'
        AND pa.applied_at >= ? AND pa.applied_at <= ?
    ),
    invoice_lines AS (
      SELECT ad.app_id, ad.amount_applied AS app_amount, pi.id AS source_id,
             pi.total AS source_total, pii.quantity,
             ${COST_FALLBACK_EXPR} AS effective_unit_cost,
             (p.metadata->>'is_sourced_via_agent') AS origin_flag
      FROM apps_day ad
      JOIN pos_invoice pi ON pi.id = ad.invoice_id
      JOIN pos_invoice_item pii ON pii.invoice_id = pi.id
      LEFT JOIN product_variant pv ON pv.id = pii.variant_id
      LEFT JOIN product p ON p.id = pv.product_id
      WHERE ad.invoice_id IS NOT NULL
        AND COALESCE(pi.status, '') NOT IN ('draft','voided','cancelled')
    ),
    order_lines AS (
      SELECT ad.app_id, ad.amount_applied AS app_amount, o.id AS source_id,
             order_totals.source_total_cents AS source_total, oi.quantity,
             COALESCE(cs.snap_unit_cost_cents / 100.0, ${ORDER_COST_FALLBACK_EXPR}) AS effective_unit_cost,
             CASE
               WHEN cs.snap_is_china IS NOT NULL THEN (CASE WHEN cs.snap_is_china THEN 'true' ELSE 'false' END)
               ELSE (p.metadata->>'is_sourced_via_agent')
             END AS origin_flag
      FROM apps_day ad
      JOIN "order" o ON o.id = ad.order_id
      JOIN order_item oi ON oi.order_id = o.id
      JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      JOIN LATERAL (
        SELECT COALESCE(SUM(ROUND(oli2.unit_price * oi2.quantity * 100)), 0)::numeric AS source_total_cents
        FROM order_item oi2
        JOIN order_line_item oli2 ON oli2.id = oi2.item_id AND oli2.deleted_at IS NULL
        WHERE oi2.order_id = o.id
      ) order_totals ON TRUE
      LEFT JOIN LATERAL (
        SELECT (snap->>'unit_cost_cents')::numeric AS snap_unit_cost_cents,
               (snap->>'is_china')::boolean AS snap_is_china
        FROM jsonb_array_elements(COALESCE(ad.cost_snapshot->'lines', '[]'::jsonb)) snap
        WHERE snap->>'line_id' = oli.id
        LIMIT 1
      ) cs ON TRUE
      LEFT JOIN product_variant pv ON pv.id = oli.variant_id
      LEFT JOIN product p ON p.id = pv.product_id
      WHERE ad.invoice_id IS NULL AND ad.order_id IS NOT NULL
        AND COALESCE(o.status::text, '') NOT IN ('draft','canceled','cancelled')
    ),
    weighted AS (
      SELECT app_id, source_total, quantity, effective_unit_cost, origin_flag,
             CASE WHEN source_total > 0 THEN app_amount::numeric / source_total ELSE 0 END AS prop
      FROM invoice_lines
      UNION ALL
      SELECT app_id, source_total, quantity, effective_unit_cost, origin_flag,
             CASE WHEN source_total > 0 THEN app_amount::numeric / source_total ELSE 0 END AS prop
      FROM order_lines
    ),
    per_app AS (
      SELECT
        w.app_id,
        COALESCE(SUM(CASE WHEN origin_flag = 'true' AND effective_unit_cost IS NOT NULL
          THEN ROUND(quantity * effective_unit_cost * 100 * prop) ELSE 0 END), 0)::bigint AS cogs_china_cents,
        COALESCE(SUM(CASE WHEN origin_flag IS DISTINCT FROM 'true' AND effective_unit_cost IS NOT NULL
          THEN ROUND(quantity * effective_unit_cost * 100 * prop) ELSE 0 END), 0)::bigint AS cogs_local_cents
      FROM weighted w
      GROUP BY w.app_id
    )
    SELECT
      cp.id AS payment_id,
      cp.reference,
      cp.customer_id,
      ad.invoice_id,
      ad.order_id,
      (ad.applied_at AT TIME ZONE 'America/New_York')::date::text AS redeemed_on,
      pa2.cogs_china_cents,
      pa2.cogs_local_cents
    FROM apps_day ad
    JOIN customer_payment cp ON cp.id = ad.payment_id
    JOIN per_app pa2 ON pa2.app_id = ad.app_id
    WHERE pa2.cogs_china_cents > 0 OR pa2.cogs_local_cents > 0
    ORDER BY ad.applied_at
    `,
    [dayStart, dayEnd]
  );
  return (result.rows ?? []) as CreditMemoCogsGapRow[];
}

export async function loadSalesByApplication(
  pg: PgConnection,
  dayStart: string,
  dayEnd: string
): Promise<SalesAggregateRow> {
  const result = await pg.raw(
    `
    WITH apps_day AS (
      -- All non-voided PaymentApplications resolved today — both real-cash
      -- payments AND credit-memo redemptions (see is_cash_funded below; the
      -- cash-vs-categorization split happens downstream, not here).
      --
      -- The day-window itself is keyed differently per kind: a real payment's
      -- cash entered on cp.received_at, so that's the attribution date (this
      -- is what "attribution follows the cash" means). A credit-memo's
      -- cp.received_at is frozen at the ORIGINAL RETURN's date — the goods
      -- behind a redemption ship on whatever day the redemption itself
      -- happens (pa.applied_at), which is frequently a different day (real
      -- data: one credit sat unredeemed for 8 months). Using received_at for
      -- both would misdate the categorization to the return day instead of
      -- the actual shipment day.
      SELECT
        pa.id            AS app_id,
        pa.payment_id,
        pa.invoice_id,
        pa.order_id,
        pa.amount_applied,
        pa.cost_snapshot,
        COALESCE(cp.method, '') <> 'credit_memo' AS is_cash_funded
      FROM payment_application pa
      JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.voided_at IS NULL
        AND pa.deleted_at IS NULL
        AND cp.deleted_at IS NULL
        -- customer_payment rows for a credit memo carry type='credit_memo'
        -- (NOT 'payment') — this must stay in sync with the method check
        -- below, both set together at creation (credit_memos complete route).
        AND cp.type IN ('payment', 'credit_memo')
        AND cp.status <> 'voided'
        AND (
          (COALESCE(cp.method, '') <> 'credit_memo' AND cp.received_at >= ? AND cp.received_at <= ?)
          OR
          (cp.method = 'credit_memo' AND pa.applied_at >= ? AND pa.applied_at <= ?)
        )
    ),

    invoice_lines AS (
      -- Per-line view for invoice-bound applications.
      SELECT
        ad.app_id,
        ad.amount_applied                                          AS app_amount,
        pi.id                                                      AS source_id,
        pi.subtotal                                                AS source_subtotal,
        pi.tax                                                     AS source_tax,
        pi.total                                                   AS source_total,
        pii.id                                                     AS line_id,
        COALESCE(NULLIF(pii.sku, ''), NULLIF(pv.sku, ''), pii.id)  AS sample_id,
        pii.quantity                                               AS quantity,
        pii.average_unit_cost,
        pii.average_unit_cost_synced_at,
        -- LIVE cost freshness (origin-agnostic): set at QB sync for USA and at
        -- vendor-bill confirm for China. Drives the "stale cost" warning.
        COALESCE(NULLIF(pv.metadata->>'average_cost_updated_at', ''),
                 NULLIF(pv.metadata->>'qb_avg_cost_synced_at', ''))::timestamptz AS avg_cost_freshness,
        ${COST_FALLBACK_EXPR}                                      AS effective_unit_cost,
        (
          pii.average_unit_cost IS NULL
          AND NULLIF(NULLIF(pv.metadata->>'average_cost', '')::numeric, 0) IS NULL
          AND NULLIF(pv.metadata->>'purchase_cost', '') IS NOT NULL
        )                                                          AS used_unit_cost_fallback,
        (p.metadata->>'is_sourced_via_agent')                      AS origin_flag,
        p.id                                                       AS product_id,
        ad.is_cash_funded                                          AS is_cash_funded
      FROM apps_day ad
      JOIN pos_invoice pi      ON pi.id = ad.invoice_id
      JOIN pos_invoice_item pii ON pii.invoice_id = pi.id
      LEFT JOIN product_variant pv ON pv.id = pii.variant_id
      LEFT JOIN product p          ON p.id = pv.product_id
      WHERE ad.invoice_id IS NOT NULL
        AND COALESCE(pi.status, '') NOT IN ('draft','voided','cancelled')
    ),

    order_lines AS (
      -- Per-line view for order-only (no invoice yet) applications.
      -- order_line_item.unit_price is in DOLLARS — multiply by 100 to align with
      -- pos_invoice.subtotal which is already in CENTS.
      SELECT
        ad.app_id,
        ad.amount_applied                                          AS app_amount,
        o.id                                                       AS source_id,
        order_totals.source_total_cents                            AS source_subtotal,
        0::numeric                                                 AS source_tax,
        order_totals.source_total_cents                            AS source_total,
        oli.id                                                     AS line_id,
        COALESCE(NULLIF(oli.variant_sku, ''), NULLIF(pv.sku, ''), oli.id) AS sample_id,
        oi.quantity                                                AS quantity,
        NULL::numeric                                              AS average_unit_cost,
        NULL::timestamptz                                          AS average_unit_cost_synced_at,
        COALESCE(NULLIF(pv.metadata->>'average_cost_updated_at', ''),
                 NULLIF(pv.metadata->>'qb_avg_cost_synced_at', ''))::timestamptz AS avg_cost_freshness,
        -- Prefer the per-line cost frozen on the application at attribution
        -- time (cost_snapshot, in cents → dollars); fall back to LIVE metadata
        -- only for legacy rows without a snapshot. This is what stops a closed
        -- day's COGS from drifting when POs are received later.
        COALESCE(cs.snap_unit_cost_cents / 100.0, ${ORDER_COST_FALLBACK_EXPR}) AS effective_unit_cost,
        FALSE                                                      AS used_unit_cost_fallback,
        -- Origin is also frozen in the snapshot (is_china) so re-tagging a
        -- product can't retroactively reclassify a closed day's COGS.
        CASE
          WHEN cs.snap_is_china IS NOT NULL
            THEN (CASE WHEN cs.snap_is_china THEN 'true' ELSE 'false' END)
          ELSE (p.metadata->>'is_sourced_via_agent')
        END                                                        AS origin_flag,
        p.id                                                       AS product_id,
        ad.is_cash_funded                                          AS is_cash_funded
      FROM apps_day ad
      JOIN "order" o            ON o.id = ad.order_id
      JOIN order_item oi        ON oi.order_id = o.id
      JOIN order_line_item oli  ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      JOIN LATERAL (
        SELECT COALESCE(SUM(ROUND(oli2.unit_price * oi2.quantity * 100)), 0)::numeric AS source_total_cents
        FROM order_item oi2
        JOIN order_line_item oli2 ON oli2.id = oi2.item_id AND oli2.deleted_at IS NULL
        WHERE oi2.order_id = o.id
      ) order_totals ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          (snap->>'unit_cost_cents')::numeric AS snap_unit_cost_cents,
          (snap->>'is_china')::boolean        AS snap_is_china
        FROM jsonb_array_elements(
          COALESCE(ad.cost_snapshot->'lines', '[]'::jsonb)
        ) snap
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
    ),

    weighted AS (
      -- Proportion of each application that this line should contribute.
      -- Lines belonging to the same source share a single source_total denom.
      SELECT
        al.*,
        CASE
          WHEN source_total > 0 THEN app_amount::numeric / source_total
          ELSE 0
        END AS prop
      FROM all_lines al
    ),

    -- Revenue/tax aggregate at APPLICATION level (deduped — each app contributes
    -- once). Credit-memo-funded apps are excluded here (real-cash-only) — see
    -- the module docstring. As of 2026-07-17 the cogs CTE below ALSO filters
    -- on is_cash_funded: the ratio splits cash-funded revenue, so its COGS
    -- numerator must be cash-funded too. Credit-memo redemption COGS is handled
    -- as an explicit accountant-approved movement (load-cm-movements.ts), not
    -- by silently nudging this day's cash ratio.
    app_revenue AS (
      SELECT DISTINCT app_id, source_subtotal, source_tax, source_total, app_amount,
        CASE
          WHEN source_total > 0 THEN app_amount::numeric / source_total
          ELSE 0
        END AS prop
      FROM all_lines
      WHERE is_cash_funded
    ),
    revenue_totals AS (
      SELECT
        COALESCE(SUM(ROUND(source_subtotal * prop)), 0)::bigint AS gross_revenue_pre_tax_cents,
        COALESCE(SUM(ROUND(source_tax * prop)), 0)::bigint      AS tax_collected_cents
      FROM app_revenue
    ),

    -- COGS aggregate at LINE level (every CASH-funded line's cost contributes
    -- once, scaled). Non-cash credit-memo redemption lines are excluded — their
    -- China/Local obligation is surfaced as an explicit inter-bucket movement
    -- (load-cm-movements.ts), never folded into the day's cash split ratio.
    cogs AS (
      SELECT
        COALESCE(SUM(
          CASE WHEN origin_flag = 'true' AND effective_unit_cost IS NOT NULL
            THEN ROUND(quantity * effective_unit_cost * 100 * prop)
            ELSE 0 END
        ), 0)::bigint AS cogs_china_cents,
        COALESCE(SUM(
          CASE WHEN origin_flag IS DISTINCT FROM 'true' AND effective_unit_cost IS NOT NULL
            THEN ROUND(quantity * effective_unit_cost * 100 * prop)
            ELSE 0 END
        ), 0)::bigint AS cogs_local_cents
      FROM weighted
      WHERE is_cash_funded
    ),

    missing_cost AS (
      SELECT COUNT(*)::bigint AS c,
        COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
      FROM (
        SELECT sample_id FROM weighted
        WHERE effective_unit_cost IS NULL AND product_id IS NOT NULL
        LIMIT 20
      ) x
    ),
    unit_cost_fallback AS (
      SELECT COUNT(*)::bigint AS c,
        COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
      FROM (SELECT sample_id FROM weighted WHERE used_unit_cost_fallback LIMIT 20) x
    ),
    stale_cost AS (
      SELECT COUNT(*)::bigint AS c,
        COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
      FROM (
        SELECT sample_id FROM weighted
        WHERE effective_unit_cost IS NOT NULL
          AND (avg_cost_freshness IS NULL
               OR avg_cost_freshness < (?::timestamptz - INTERVAL '${STALE_COST_THRESHOLD_DAYS} days'))
        LIMIT 20
      ) x
    ),
    missing_origin AS (
      SELECT COUNT(*)::bigint AS c,
        COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
      FROM (
        SELECT sample_id FROM weighted
        WHERE product_id IS NOT NULL AND origin_flag IS NULL
        LIMIT 20
      ) x
    )

    SELECT
      rt.gross_revenue_pre_tax_cents,
      rt.tax_collected_cents,
      c.cogs_china_cents,
      c.cogs_local_cents,
      mc.c   AS lines_missing_avg_cost_count,
      sc.c   AS stale_cost_count,
      mo.c   AS missing_origin_tag_count,
      uf.c   AS unit_cost_fallback_count,
      mc.ids AS sample_lines_missing_avg_cost,
      sc.ids AS sample_stale_cost,
      mo.ids AS sample_missing_origin_tag,
      uf.ids AS sample_unit_cost_fallback
    FROM revenue_totals rt
    CROSS JOIN cogs c
    CROSS JOIN missing_cost mc
    CROSS JOIN stale_cost sc
    CROSS JOIN missing_origin mo
    CROSS JOIN unit_cost_fallback uf
    `,
    [dayStart, dayEnd, dayStart, dayEnd, dayStart]
  );

  return (result.rows[0] ?? {
    gross_revenue_pre_tax_cents: "0",
    tax_collected_cents: "0",
    cogs_china_cents: "0",
    cogs_local_cents: "0",
    lines_missing_avg_cost_count: "0",
    stale_cost_count: "0",
    missing_origin_tag_count: "0",
    unit_cost_fallback_count: "0",
    sample_lines_missing_avg_cost: [],
    sample_stale_cost: [],
    sample_missing_origin_tag: [],
    sample_unit_cost_fallback: [],
  }) as SalesAggregateRow;
}
