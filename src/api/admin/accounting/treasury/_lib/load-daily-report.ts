import {
  computeSplits,
  type TreasuryBucketCode,
} from "./compute-splits";
import type {
  TreasuryBucketView,
  TreasuryDailyReport,
  TreasurySplitWithBucket,
  TreasuryWarning,
} from "../daily/types";

export const STALE_COST_THRESHOLD_DAYS = 30;

interface SalesAggregateRow {
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

interface CashRow {
  gross_payments_cents: string | null;
  refunds_cents: string | null;
  net_cash_received_cents: string | null;
}

interface BucketRow {
  id: string;
  code: TreasuryBucketCode;
  label: string;
  display_order: number;
  is_active: boolean;
  source_bank_id: string | null;
  source_bank_name: string | null;
  source_bank_type: string | null;
  dest_bank_id: string | null;
  dest_bank_name: string | null;
  dest_bank_type: string | null;
}

function toInt(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function mapBucket(row: BucketRow): TreasuryBucketView {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    display_order: row.display_order,
    is_active: row.is_active,
    source_bank: row.source_bank_id
      ? {
          id: row.source_bank_id,
          name: row.source_bank_name ?? "",
          type: row.source_bank_type ?? "",
        }
      : null,
    destination_bank: row.dest_bank_id
      ? {
          id: row.dest_bank_id,
          name: row.dest_bank_name ?? "",
          type: row.dest_bank_type ?? "",
        }
      : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgConnection = any;

export async function loadDailyReport(
  pg: PgConnection,
  date: string
): Promise<TreasuryDailyReport> {
  const dayStart = `${date} 00:00:00`;
  const dayEnd = `${date} 23:59:59.999999`;

  const salesResult = await pg.raw(
    `WITH lines AS (
       SELECT
         pii.id AS line_id,
         COALESCE(NULLIF(pii.sku, ''), NULLIF(pv.sku, ''), pii.id) AS sample_id,
         pii.quantity,
         pii.average_unit_cost,
         pii.average_unit_cost_synced_at,
         -- Cost fallback (priority order):
         --   1. pii.average_unit_cost — snapshot at invoice issue.
         --   2. pv.metadata.avg_landed_cost_cents — authoritative local AVCO,
         --      updated by every vendor-bill confirm (Miami receipt). Was
         --      backfilled from qb_avg_cost at rollout, so it covers history.
         --   3. pv.metadata.qb_avg_cost — legacy QB sync. Safety net.
         --   4. pv.metadata.qb_purchase_cost — raw vendor unit cost from QB
         --      (NO landing/freight/tariff). Last-resort approximation so we
         --      don't have to exclude the line.
         COALESCE(
           pii.average_unit_cost,
           NULLIF(pv.metadata->>'avg_landed_cost_cents', '')::numeric / 100.0,
           NULLIF(pv.metadata->>'qb_avg_cost', '')::numeric,
           NULLIF(pv.metadata->>'qb_purchase_cost', '')::numeric
         ) AS effective_unit_cost,
         -- True when the line had no avg-cost data and we fell back to the
         -- non-landed purchase cost. Used to emit an info-level note
         -- distinct from the "truly excluded" warning.
         (
           pii.average_unit_cost IS NULL
           AND NULLIF(pv.metadata->>'avg_landed_cost_cents', '') IS NULL
           AND NULLIF(pv.metadata->>'qb_avg_cost', '') IS NULL
           AND NULLIF(pv.metadata->>'qb_purchase_cost', '') IS NOT NULL
         ) AS used_unit_cost_fallback,
         (p.metadata->>'is_sourced_via_agent') AS origin_flag,
         p.id AS product_id,
         pi.subtotal AS inv_subtotal,
         pi.tax      AS inv_tax,
         pi.id       AS inv_id
       FROM pos_invoice pi
       JOIN pos_invoice_item pii ON pii.invoice_id = pi.id
       LEFT JOIN product_variant pv ON pv.id = pii.variant_id
       LEFT JOIN product p ON p.id = pv.product_id
       WHERE pi.created_at >= ?
         AND pi.created_at <= ?
         AND COALESCE(pi.status, '') NOT IN ('draft','voided','cancelled')
     ),
     inv_totals AS (
       SELECT
         COALESCE(SUM(inv_subtotal), 0)::bigint AS gross_revenue_pre_tax_cents,
         COALESCE(SUM(inv_tax), 0)::bigint      AS tax_collected_cents
       FROM (
         SELECT DISTINCT inv_id, inv_subtotal, inv_tax FROM lines
       ) s
     ),
     cogs AS (
       SELECT
         COALESCE(SUM(
           CASE WHEN origin_flag = 'true' AND effective_unit_cost IS NOT NULL
             THEN ROUND(quantity * effective_unit_cost * 100)
             ELSE 0 END
         ), 0)::bigint AS cogs_china_cents,
         COALESCE(SUM(
           CASE WHEN origin_flag IS DISTINCT FROM 'true' AND effective_unit_cost IS NOT NULL
             THEN ROUND(quantity * effective_unit_cost * 100)
             ELSE 0 END
         ), 0)::bigint AS cogs_local_cents
       FROM lines
     ),
     missing_cost AS (
       SELECT COUNT(*)::bigint AS c,
         COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
       FROM (SELECT sample_id FROM lines WHERE effective_unit_cost IS NULL LIMIT 20) x
     ),
     unit_cost_fallback AS (
       SELECT COUNT(*)::bigint AS c,
         COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
       FROM (SELECT sample_id FROM lines WHERE used_unit_cost_fallback LIMIT 20) x
     ),
     stale_cost AS (
       SELECT COUNT(*)::bigint AS c,
         COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
       FROM (
         SELECT sample_id FROM lines
         WHERE average_unit_cost IS NOT NULL
           AND (average_unit_cost_synced_at IS NULL
                OR average_unit_cost_synced_at < (?::timestamptz - INTERVAL '${STALE_COST_THRESHOLD_DAYS} days'))
         LIMIT 20
       ) x
     ),
     missing_origin AS (
       SELECT COUNT(*)::bigint AS c,
         COALESCE(ARRAY_AGG(sample_id) FILTER (WHERE TRUE), ARRAY[]::text[]) AS ids
       FROM (
         SELECT sample_id FROM lines
         WHERE product_id IS NOT NULL AND origin_flag IS NULL
         LIMIT 20
       ) x
     )
     SELECT
       it.gross_revenue_pre_tax_cents,
       it.tax_collected_cents,
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
     FROM inv_totals it
     CROSS JOIN cogs c
     CROSS JOIN missing_cost mc
     CROSS JOIN stale_cost sc
     CROSS JOIN missing_origin mo
     CROSS JOIN unit_cost_fallback uf`,
    [dayStart, dayEnd, dayStart]
  );

  const cashResult = await pg.raw(
    `WITH lwc AS (
       SELECT DISTINCT ON (reference_id)
         reference_id,
         COALESCE(updated_at, created_at) AS confirmed_at
       FROM qb_order_pipeline
       WHERE step = 'write_check' AND status = 'confirmed'
       ORDER BY reference_id, COALESCE(updated_at, created_at) DESC
     )
     SELECT
       COALESCE(SUM(gross), 0)::bigint   AS gross_payments_cents,
       COALESCE(SUM(refund), 0)::bigint  AS refunds_cents,
       COALESCE(SUM(gross), 0)::bigint - COALESCE(SUM(refund), 0)::bigint AS net_cash_received_cents
     FROM (
       SELECT
         CASE WHEN status <> 'voided' THEN amount ELSE 0 END AS gross,
         0 AS refund
       FROM customer_payment
       WHERE deleted_at IS NULL AND type = 'payment'
         AND received_at >= ? AND received_at <= ?
       UNION ALL
       SELECT
         0 AS gross,
         COALESCE((cp.metadata->>'refund_amount')::numeric, cp.amount) AS refund
       FROM customer_payment cp
       LEFT JOIN lwc ON lwc.reference_id = cp.id
       WHERE cp.deleted_at IS NULL
         AND (cp.type = 'refund'
              OR (cp.type <> 'refund' AND cp.status IN ('refunded','partial_refunded')))
         AND cp.qb->>'check_txn_id' IS NOT NULL
         AND COALESCE(lwc.confirmed_at, (cp.metadata->>'refunded_at')::timestamptz, cp.received_at) >= ?
         AND COALESCE(lwc.confirmed_at, (cp.metadata->>'refunded_at')::timestamptz, cp.received_at) <= ?
     ) sub`,
    [dayStart, dayEnd, dayStart, dayEnd]
  );

  const bucketsResult = await pg.raw(
    `SELECT
       tb.id, tb.code, tb.label, tb.display_order, tb.is_active,
       src.id AS source_bank_id, src.name AS source_bank_name, src.type AS source_bank_type,
       dst.id AS dest_bank_id,   dst.name AS dest_bank_name,   dst.type AS dest_bank_type
     FROM treasury_bucket tb
     LEFT JOIN qb_bank_account src ON src.id = tb.source_qb_bank_account_id AND src.deleted_at IS NULL
     LEFT JOIN qb_bank_account dst ON dst.id = tb.qb_bank_account_id AND dst.deleted_at IS NULL
     ORDER BY tb.display_order, tb.code`
  );

  const sales: SalesAggregateRow = salesResult.rows[0] ?? {
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
  };
  const cash: CashRow = cashResult.rows[0] ?? {
    gross_payments_cents: "0",
    refunds_cents: "0",
    net_cash_received_cents: "0",
  };
  const bucketRows: BucketRow[] = bucketsResult.rows ?? [];

  const totals = {
    gross_revenue_pre_tax_cents: toInt(sales.gross_revenue_pre_tax_cents),
    tax_collected_cents: toInt(sales.tax_collected_cents),
    cogs_china_cents: toInt(sales.cogs_china_cents),
    cogs_local_cents: toInt(sales.cogs_local_cents),
    gross_payments_cents: toInt(cash.gross_payments_cents),
    refunds_cents: toInt(cash.refunds_cents),
    net_cash_received_cents: toInt(cash.net_cash_received_cents),
  };

  const activeBuckets = bucketRows.filter((b) => b.is_active);
  const activeCodes = activeBuckets.map((b) => b.code);

  const result = computeSplits({
    gross_revenue_pre_tax_cents: totals.gross_revenue_pre_tax_cents,
    tax_collected_cents: totals.tax_collected_cents,
    cogs_china_cents: totals.cogs_china_cents,
    cogs_local_cents: totals.cogs_local_cents,
    net_cash_received_cents: totals.net_cash_received_cents,
    active_bucket_codes: activeCodes,
  });

  const bucketByCode = new Map<TreasuryBucketCode, BucketRow>();
  for (const b of bucketRows) bucketByCode.set(b.code, b);

  const splits: TreasurySplitWithBucket[] = result.splits.map((s) => {
    const row = bucketByCode.get(s.code);
    const bucket: TreasuryBucketView = row
      ? mapBucket(row)
      : {
          id: `tbk_${s.code}`,
          code: s.code,
          label: s.code,
          display_order: 999,
          is_active: false,
          source_bank: null,
          destination_bank: null,
        };
    return { ...s, bucket };
  });

  const warnings: TreasuryWarning[] = [];
  if (toInt(sales.unit_cost_fallback_count) > 0) {
    warnings.push({
      code: "LINES_USED_UNIT_COST_FALLBACK",
      severity: "info",
      count: toInt(sales.unit_cost_fallback_count),
      sample_ids: sales.sample_unit_cost_fallback ?? [],
      detail:
        "No avg cost available — used the raw purchase unit cost (without landing/freight/tariff) as an approximation.",
    });
  }
  if (toInt(sales.lines_missing_avg_cost_count) > 0) {
    warnings.push({
      code: "LINES_MISSING_AVG_COST",
      severity: "warning",
      count: toInt(sales.lines_missing_avg_cost_count),
      sample_ids: sales.sample_lines_missing_avg_cost ?? [],
      detail:
        "No cost data of any kind available for these lines — excluded from COGS.",
    });
  }
  if (toInt(sales.stale_cost_count) > 0) {
    warnings.push({
      code: "STALE_COST",
      severity: "info",
      count: toInt(sales.stale_cost_count),
      sample_ids: sales.sample_stale_cost ?? [],
      detail: `average_unit_cost not synced from QB in the last ${STALE_COST_THRESHOLD_DAYS} days.`,
    });
  }
  if (toInt(sales.missing_origin_tag_count) > 0) {
    warnings.push({
      code: "PRODUCT_MISSING_ORIGIN_TAG",
      severity: "info",
      count: toInt(sales.missing_origin_tag_count),
      sample_ids: sales.sample_missing_origin_tag ?? [],
      detail: "Products without is_sourced_via_agent metadata were treated as local.",
    });
  }
  const unmappedBuckets = activeBuckets.filter((b) => !b.dest_bank_id);
  if (unmappedBuckets.length > 0) {
    warnings.push({
      code: "BUCKET_WITHOUT_BANK_MAPPING",
      severity: "warning",
      count: unmappedBuckets.length,
      sample_ids: unmappedBuckets.map((b) => b.code),
      detail: "Map these buckets to a bank account in Settings → Treasury Buckets.",
    });
  }
  if (totals.cogs_china_cents + totals.cogs_local_cents === 0) {
    warnings.push({
      code: "NO_COGS_DATA_FOR_DAY",
      severity: "info",
      count: 1,
      sample_ids: [date],
      detail: "No COGS recorded — full net cash routed to Operating.",
    });
  }
  if (totals.net_cash_received_cents < totals.tax_collected_cents) {
    warnings.push({
      code: "NET_CASH_BELOW_TAX",
      severity: "warning",
      count: 1,
      sample_ids: [date],
      detail: "Sales tax exceeds net cash; Operating absorbed the shortfall.",
    });
  }
  if (totals.refunds_cents > 0 && totals.gross_revenue_pre_tax_cents === 0) {
    warnings.push({
      code: "CROSS_DAY_REFUND_DETECTED",
      severity: "info",
      count: 1,
      sample_ids: [date],
      detail: "Refunds cleared today for prior-day sales — Operating absorbs the COGS pull-back.",
    });
  }

  return {
    distribution_date: date,
    totals,
    splits,
    warnings,
    reconciliation: result.reconciliation,
    generated_at: new Date().toISOString(),
  };
}
