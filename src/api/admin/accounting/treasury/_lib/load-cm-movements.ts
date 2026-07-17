/**
 * load-cm-movements.ts
 *
 * Credit-memo cross-category COGS movements for the daily Treasury report.
 *
 * When a credit memo born from a RETURN of one sourcing category (China/Local)
 * is REDEEMED against goods of the OTHER category, no new cash moves but a real
 * obligation to the other category's vendor is created — money parked in one
 * bank account should fund the other. This loader surfaces, per redemption
 * (payment_application), a suggested inter-bank rebalance the accountant then
 * confirms/ignores (see cm-movement/resolve route + the plan doc).
 *
 * Two sides, both derived LIVE (never snapshotted at credit issuance — the
 * user's explicit choice: store-pos is corrected day-to-day, so live picks up
 * data fixes to origin tags and costs):
 *   • backing     = China/Local COGS of the credit memo's OWN returned items
 *                   (pos_credit_memo_item), scaled to THIS application's share
 *                   of the whole credit (amount_applied / credit_total) so
 *                   partial redemptions each consume a proportional slice and
 *                   cumulative can never exceed the credit's full backing.
 *                   Uses RESTOCKED qty (quantity − damaged_qty): damaged units
 *                   that never re-entered inventory don't free parked cash.
 *   • consumption = China/Local COGS of the REDEEMED goods (the invoice/order
 *                   the credit was applied to), proportional to amount_applied.
 *
 * Cost is LIVE-preferred (product/variant metadata first, frozen item cost as
 * last-resort fallback) and origin is ALWAYS live (product.metadata
 * .is_sourced_via_agent). This is a deliberate, self-contained philosophy for
 * the movement feature: it's a rebalance decided NOW with best-known numbers,
 * unlike the cash-COGS path (frozen-preferred historical accounting) — the two
 * answer different questions, so different cost sources is correct, not a bug.
 *
 * The vector delta (Δchina/Δlocal), the suggested movement, backing status,
 * surplus/shortfall and the derivation hash are computed in JS below.
 */

import { createHash } from "crypto";
import type { TreasuryBucketCode } from "./compute-splits";
import { avgCostDollars } from "../../../../../lib/cost/cost-sql";

type PgConnection = {
  raw: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
};

export type CmBackingStatus =
  | "cash_backed"
  | "partially_cash_backed"
  | "unbacked"
  | "unknown";

export type CmMovementResolution = "confirmed" | "ignored" | "unattributable";

export interface CreditMemoMovementView {
  payment_application_id: string;
  payment_id: string;
  reference: string | null;
  customer_id: string | null;
  invoice_id: string | null;
  order_id: string | null;
  redeemed_on: string;
  amount_applied_cents: number;
  backing: { china_cents: number; local_cents: number; total_cents: number };
  consumption: { china_cents: number; local_cents: number; total_cents: number };
  /** Positive, directional inter-bank rebalance. Only set for cash_backed cross-category rows. */
  suggested_movement: { from: TreasuryBucketCode; to: TreasuryBucketCode; cents: number } | null;
  /** backing.total − consumption.total; shown separately, NOT as a transfer. */
  surplus_shortfall_cents: number;
  backing_status: CmBackingStatus;
  /** sha256 of the derived inputs — flips if items/costs/tags change → stale UI. */
  derivation_hash: string;
  /** Joined from treasury_cm_movement_resolution (null = unresolved). */
  resolution: CmMovementResolution | null;
  /** true when a stored resolution's hash no longer matches the live derivation. */
  resolution_stale: boolean;
  /** Required reason captured for ignored/unattributable resolutions. */
  resolution_reason: string | null;
}

interface RawRow {
  payment_application_id: string;
  payment_id: string;
  reference: string | null;
  customer_id: string | null;
  invoice_id: string | null;
  order_id: string | null;
  redeemed_on: string;
  amount_applied_cents: string | number;
  consumption_china_cents: string | number | null;
  consumption_local_cents: string | number | null;
  backing_china_cents: string | number | null;
  backing_local_cents: string | number | null;
  backing_lines_total: string | number | null;
  backing_lines_costed: string | number | null;
  stored_resolution: CmMovementResolution | null;
  stored_hash: string | null;
  stored_reason: string | null;
}

const num = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

// LIVE-preferred cost (dollars), frozen item cost as last-resort fallback.
const liveCost = (frozenCol: string): string => `COALESCE(
  ${avgCostDollars("pv")},
  ${frozenCol}
)`;

function backingStatus(total: number, costed: number): CmBackingStatus {
  if (total <= 0) return "unbacked";
  if (costed <= 0) return "unknown";
  if (costed < total) return "partially_cash_backed";
  return "cash_backed";
}

export interface CmMovementInputs {
  payment_application_id: string;
  amount_applied_cents: number;
  backing_china_cents: number;
  backing_local_cents: number;
  consumption_china_cents: number;
  consumption_local_cents: number;
  backing_lines_total: number;
  backing_lines_costed: number;
}

export interface CmMovementDerived {
  backing: { china_cents: number; local_cents: number; total_cents: number };
  consumption: { china_cents: number; local_cents: number; total_cents: number };
  suggested_movement: { from: TreasuryBucketCode; to: TreasuryBucketCode; cents: number } | null;
  surplus_shortfall_cents: number;
  backing_status: CmBackingStatus;
  derivation_hash: string;
  /** True only when the row needs an accountant decision (a real suggested
   * movement, or an ambiguous backing that could hide one). Same-category
   * cash-backed and pure-goodwill (unbacked) redemptions return false. */
  needs_attention: boolean;
}

/**
 * Pure derivation of a single credit-memo movement from its raw China/Local
 * backing & consumption cents. No DB — unit-tested directly (see
 * verify-treasury-cm-movements.ts). The SQL loader below feeds it per row.
 */
export function deriveCmMovement(input: CmMovementInputs): CmMovementDerived {
  const backing = {
    china_cents: input.backing_china_cents,
    local_cents: input.backing_local_cents,
    total_cents: input.backing_china_cents + input.backing_local_cents,
  };
  const consumption = {
    china_cents: input.consumption_china_cents,
    local_cents: input.consumption_local_cents,
    total_cents: input.consumption_china_cents + input.consumption_local_cents,
  };

  const status = backingStatus(
    input.backing_lines_total,
    input.backing_lines_costed
  );

  const dChina = consumption.china_cents - backing.china_cents;
  const dLocal = consumption.local_cents - backing.local_cents;

  // Only a fully cash-backed credit auto-suggests a rebalance (Codex #3):
  // partial/unknown must be manually resolved, unbacked has nothing to move.
  let suggested: CmMovementDerived["suggested_movement"] = null;
  if (status === "cash_backed") {
    const move = Math.min(Math.abs(dChina), Math.abs(dLocal));
    if (move > 0) {
      if (dLocal > 0 && dChina < 0) {
        suggested = { from: "china_cogs", to: "local_cogs", cents: move };
      } else if (dChina > 0 && dLocal < 0) {
        suggested = { from: "local_cogs", to: "china_cogs", cents: move };
      }
    }
  }

  // Only surface rows that need a decision: a concrete suggested movement, or
  // an ambiguous backing that could hide one. Same-category cash-backed and
  // pure goodwill (unbacked) redemptions have nothing to rebalance.
  const needs_attention =
    suggested !== null ||
    ((status === "unknown" || status === "partially_cash_backed") &&
      consumption.total_cents > 0);

  const derivation_hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.payment_application_id,
        input.amount_applied_cents,
        backing.china_cents,
        backing.local_cents,
        consumption.china_cents,
        consumption.local_cents,
        status,
      ])
    )
    .digest("hex");

  return {
    backing,
    consumption,
    suggested_movement: suggested,
    surplus_shortfall_cents: backing.total_cents - consumption.total_cents,
    backing_status: status,
    derivation_hash,
    needs_attention,
  };
}

export async function loadCreditMemoMovements(
  pg: PgConnection,
  dayStart: string,
  dayEnd: string
): Promise<CreditMemoMovementView[]> {
  const result = await pg.raw(
    `
    WITH apps_day AS (
      SELECT pa.id AS app_id, pa.payment_id, pa.invoice_id, pa.order_id,
             pa.amount_applied, pa.cost_snapshot, pa.applied_at,
             cp.reference, cp.customer_id, cp.amount AS credit_total_cents
      FROM payment_application pa
      JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.voided_at IS NULL AND pa.deleted_at IS NULL AND cp.deleted_at IS NULL
        AND cp.type = 'credit_memo' AND cp.method = 'credit_memo' AND cp.status <> 'voided'
        AND pa.applied_at >= ? AND pa.applied_at <= ?
    ),
    -- CONSUMPTION: redeemed goods, per line, proportional to amount_applied.
    invoice_lines AS (
      SELECT ad.app_id, ad.amount_applied AS app_amount, pi.total AS source_total,
             pii.quantity, ${liveCost("pii.average_unit_cost")} AS effective_unit_cost,
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
      SELECT ad.app_id, ad.amount_applied AS app_amount,
             order_totals.source_total_cents AS source_total, oi.quantity,
             ${liveCost("cs.snap_unit_cost_cents / 100.0")} AS effective_unit_cost,
             CASE
               WHEN (p.metadata->>'is_sourced_via_agent') IS NOT NULL
                 THEN (p.metadata->>'is_sourced_via_agent')
               WHEN cs.snap_is_china IS NOT NULL
                 THEN (CASE WHEN cs.snap_is_china THEN 'true' ELSE 'false' END)
               ELSE NULL
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
    consumption_lines AS (
      SELECT app_id, quantity, effective_unit_cost, origin_flag,
             CASE WHEN source_total > 0 THEN app_amount::numeric / source_total ELSE 0 END AS prop
      FROM invoice_lines
      UNION ALL
      SELECT app_id, quantity, effective_unit_cost, origin_flag,
             CASE WHEN source_total > 0 THEN app_amount::numeric / source_total ELSE 0 END AS prop
      FROM order_lines
    ),
    consumption AS (
      SELECT app_id,
        COALESCE(SUM(CASE WHEN origin_flag = 'true' AND effective_unit_cost IS NOT NULL
          THEN ROUND(quantity * effective_unit_cost * 100 * prop) ELSE 0 END), 0)::bigint AS china_cents,
        COALESCE(SUM(CASE WHEN origin_flag IS DISTINCT FROM 'true' AND effective_unit_cost IS NOT NULL
          THEN ROUND(quantity * effective_unit_cost * 100 * prop) ELSE 0 END), 0)::bigint AS local_cents
      FROM consumption_lines
      GROUP BY app_id
    ),
    -- BACKING: credit memo's own returned items (full credit), restocked qty.
    cm_backing AS (
      SELECT ad.app_id, ad.credit_total_cents,
        COUNT(cmi.id) AS backing_lines_total,
        COUNT(cmi.id) FILTER (WHERE ${liveCost("cmi.average_unit_cost")} IS NOT NULL) AS backing_lines_costed,
        COALESCE(SUM(CASE WHEN (p.metadata->>'is_sourced_via_agent') = 'true'
              AND ${liveCost("cmi.average_unit_cost")} IS NOT NULL
          THEN ROUND(GREATEST(cmi.quantity - COALESCE(cmi.damaged_qty, 0), 0) * ${liveCost("cmi.average_unit_cost")} * 100)
          ELSE 0 END), 0)::bigint AS full_backing_china_cents,
        COALESCE(SUM(CASE WHEN (p.metadata->>'is_sourced_via_agent') IS DISTINCT FROM 'true'
              AND ${liveCost("cmi.average_unit_cost")} IS NOT NULL
          THEN ROUND(GREATEST(cmi.quantity - COALESCE(cmi.damaged_qty, 0), 0) * ${liveCost("cmi.average_unit_cost")} * 100)
          ELSE 0 END), 0)::bigint AS full_backing_local_cents
      FROM apps_day ad
      JOIN pos_credit_memo cm ON cm.credit_memo_number = ad.reference AND cm.status <> 'voided'
      LEFT JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id
      LEFT JOIN product_variant pv ON pv.id = cmi.variant_id
      LEFT JOIN product p ON p.id = pv.product_id
      GROUP BY ad.app_id, ad.credit_total_cents
    )
    SELECT
      ad.app_id AS payment_application_id,
      ad.payment_id, ad.reference, ad.customer_id, ad.invoice_id, ad.order_id,
      ad.applied_at::date::text AS redeemed_on,
      ad.amount_applied::bigint AS amount_applied_cents,
      cons.china_cents AS consumption_china_cents,
      cons.local_cents AS consumption_local_cents,
      ROUND(cb.full_backing_china_cents *
        (CASE WHEN cb.credit_total_cents > 0 THEN ad.amount_applied::numeric / cb.credit_total_cents ELSE 0 END))::bigint AS backing_china_cents,
      ROUND(cb.full_backing_local_cents *
        (CASE WHEN cb.credit_total_cents > 0 THEN ad.amount_applied::numeric / cb.credit_total_cents ELSE 0 END))::bigint AS backing_local_cents,
      cb.backing_lines_total,
      cb.backing_lines_costed,
      r.resolution AS stored_resolution,
      r.derivation_hash AS stored_hash,
      r.reason AS stored_reason
    FROM apps_day ad
    LEFT JOIN consumption cons ON cons.app_id = ad.app_id
    LEFT JOIN cm_backing cb ON cb.app_id = ad.app_id
    LEFT JOIN treasury_cm_movement_resolution r ON r.payment_application_id = ad.app_id
    ORDER BY ad.applied_at
    `,
    [dayStart, dayEnd]
  );

  const rows = (result.rows ?? []) as RawRow[];
  const views: CreditMemoMovementView[] = [];

  for (const r of rows) {
    const d = deriveCmMovement({
      payment_application_id: r.payment_application_id,
      amount_applied_cents: num(r.amount_applied_cents),
      backing_china_cents: num(r.backing_china_cents),
      backing_local_cents: num(r.backing_local_cents),
      consumption_china_cents: num(r.consumption_china_cents),
      consumption_local_cents: num(r.consumption_local_cents),
      backing_lines_total: num(r.backing_lines_total),
      backing_lines_costed: num(r.backing_lines_costed),
    });
    if (!d.needs_attention) continue;

    views.push({
      payment_application_id: r.payment_application_id,
      payment_id: r.payment_id,
      reference: r.reference,
      customer_id: r.customer_id,
      invoice_id: r.invoice_id,
      order_id: r.order_id,
      redeemed_on: r.redeemed_on,
      amount_applied_cents: num(r.amount_applied_cents),
      backing: d.backing,
      consumption: d.consumption,
      suggested_movement: d.suggested_movement,
      surplus_shortfall_cents: d.surplus_shortfall_cents,
      backing_status: d.backing_status,
      derivation_hash: d.derivation_hash,
      resolution: r.stored_resolution ?? null,
      resolution_stale:
        r.stored_resolution !== null && r.stored_hash !== d.derivation_hash,
      resolution_reason: r.stored_reason ?? null,
    });
  }

  return views;
}
