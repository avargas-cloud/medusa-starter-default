import {
  computeSplits,
  type TreasuryBucketCode,
} from "./compute-splits";
import {
  loadSalesByApplication,
  STALE_COST_THRESHOLD_DAYS as APP_STALE_COST_THRESHOLD_DAYS,
} from "./load-sales-by-application";
import { loadUnattributedPayments } from "./load-unattributed-payments";
import type {
  TreasuryBucketView,
  TreasuryDailyReport,
  TreasurySplitWithBucket,
  TreasuryWarning,
} from "../daily/types";

export const STALE_COST_THRESHOLD_DAYS = APP_STALE_COST_THRESHOLD_DAYS;

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
  from: string,
  to: string = from
): Promise<TreasuryDailyReport> {
  const isRange = from !== to;
  // Range tag for warning sample_ids, and period-aware wording for details.
  const rangeTag = isRange ? `${from}..${to}` : from;
  const dayStart = `${from} 00:00:00`;
  const dayEnd = `${to} 23:59:59.999999`;

  const sales = await loadSalesByApplication(pg, dayStart, dayEnd);
  const unattributedPayments = await loadUnattributedPayments(
    pg,
    dayStart,
    dayEnd
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
      sample_ids: [rangeTag],
      detail: "No COGS recorded — full net cash routed to Operating.",
    });
  }
  if (totals.net_cash_received_cents < totals.tax_collected_cents) {
    warnings.push({
      code: "NET_CASH_BELOW_TAX",
      severity: "warning",
      count: 1,
      sample_ids: [rangeTag],
      detail: "Sales tax exceeds net cash; Operating absorbed the shortfall.",
    });
  }
  if (totals.refunds_cents > 0 && totals.gross_revenue_pre_tax_cents === 0) {
    warnings.push({
      code: "CROSS_DAY_REFUND_DETECTED",
      severity: "info",
      count: 1,
      sample_ids: [rangeTag],
      detail: `Refunds cleared ${
        isRange ? "in this period" : "today"
      } for prior-day sales — Operating absorbs the COGS pull-back.`,
    });
  }
  if (unattributedPayments.length > 0) {
    const unattributedCents = unattributedPayments.reduce(
      (sum, p) => sum + p.unapplied_cents,
      0
    );
    warnings.push({
      code: "UNATTRIBUTED_PAYMENTS",
      severity: "warning",
      count: unattributedPayments.length,
      sample_ids: unattributedPayments
        .slice(0, 20)
        .map((p) => (p.display_id ? `PAY-${p.display_id}` : p.payment_id)),
      detail: `$${(unattributedCents / 100).toFixed(2)} of ${
        isRange ? "this period's" : "today's"
      } cash is not linked to an order/invoice — counted as cash but not as a sale. Link these to attribute revenue & COGS.`,
    });
  }

  return {
    distribution_date: from,
    range_start: from,
    range_end: to,
    totals,
    splits,
    warnings,
    unattributed_payments: unattributedPayments,
    reconciliation: result.reconciliation,
    generated_at: new Date().toISOString(),
  };
}
