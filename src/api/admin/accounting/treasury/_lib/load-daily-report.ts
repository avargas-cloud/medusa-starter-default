import {
  computeSplits,
  type TreasuryBucketCode,
} from "./compute-splits";
import {
  loadSalesByApplication,
  loadCreditMemoCogsGaps,
  STALE_COST_THRESHOLD_DAYS as APP_STALE_COST_THRESHOLD_DAYS,
} from "./load-sales-by-application";
import { loadUnattributedPayments } from "./load-unattributed-payments";
import type {
  TreasuryBucketView,
  TreasuryDailyReport,
  TreasurySplitWithBucket,
  TreasuryWarning,
  TreasuryWarningCode,
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

/** YYYY-MM-DD string arithmetic helpers — UTC midnight, no DST/TZ drift. */
function parseDateOnly(s: string): Date {
  const parts = s.split("-").map((n) => parseInt(n, 10));
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(Date.UTC(y, m - 1, d));
}
function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(s: string, n: number): string {
  const d = parseDateOnly(s);
  return formatDateOnly(new Date(d.getTime() + n * 86_400_000));
}
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cur = from;
  while (cur <= to) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}
/** Group the days NOT present in `lockedSet` into contiguous [from,to] runs. */
function contiguousUnlockedRuns(
  days: string[],
  lockedSet: Set<string>
): Array<{ from: string; to: string }> {
  const runs: Array<{ from: string; to: string }> = [];
  let runStart: string | null = null;
  let prev: string | null = null;
  for (const day of days) {
    if (lockedSet.has(day)) {
      if (runStart !== null && prev !== null) runs.push({ from: runStart, to: prev });
      runStart = null;
      prev = null;
      continue;
    }
    if (runStart === null) runStart = day;
    prev = day;
  }
  if (runStart !== null && prev !== null) runs.push({ from: runStart, to: prev });
  return runs;
}

/**
 * Computes a live (never-locked) report for a CONTIGUOUS range with a single
 * bulk SQL pass — this is the pre-existing computation, defer-aware (see
 * load-unattributed-payments.ts / the cash CTE below). Called once per
 * contiguous run of unlocked days by the public `loadDailyReport` below; in
 * the common case (locked days form a prefix of the requested range) this
 * runs exactly once.
 */
async function computeLiveRangeReport(
  pg: PgConnection,
  from: string,
  to: string
): Promise<TreasuryDailyReport> {
  const rangeTag = from === to ? from : `${from}..${to}`;
  const dayStart = `${from} 00:00:00`;
  const dayEnd = `${to} 23:59:59.999999`;

  const sales = await loadSalesByApplication(pg, dayStart, dayEnd);
  const unattributedPayments = await loadUnattributedPayments(pg, dayStart, dayEnd);
  const creditMemoCogsRows = await loadCreditMemoCogsGaps(pg, dayStart, dayEnd);

  // Cash total, decomposed per payment into an APPLIED portion (always
  // counted on the payment's real received_at day — this stays in lockstep
  // with load-sales-by-application.ts, which also keys off received_at via
  // payment_application, so it can never desync) and an UNAPPLIED remainder
  // (counted on its current effective treasury date — received_at's day,
  // unless "Exception — defer to next day" pushed it forward). This is the
  // fix for the historical bug where an unlinked payment's FULL amount would
  // move day-to-day if we naively shifted the whole customer_payment.
  const cashResult = await pg.raw(
    `WITH lwc AS (
       SELECT DISTINCT ON (reference_id)
         reference_id,
         COALESCE(updated_at, created_at) AS confirmed_at
       FROM qb_order_pipeline
       WHERE step = 'write_check' AND status = 'confirmed'
       ORDER BY reference_id, COALESCE(updated_at, created_at) DESC
     ),
     applied AS (
       SELECT payment_id, COALESCE(SUM(amount_applied), 0)::numeric AS applied
       FROM payment_application
       WHERE voided_at IS NULL AND deleted_at IS NULL
       GROUP BY payment_id
     ),
     latest_defer AS (
       SELECT DISTINCT ON (payment_id) payment_id, effective_treasury_date
       FROM treasury_payment_defer
       ORDER BY payment_id, created_at DESC
     ),
     payment_cash AS (
       SELECT
         cp.id,
         cp.received_at,
         CASE WHEN cp.status <> 'voided'
           THEN LEAST(cp.amount, COALESCE(a.applied, 0))
           ELSE 0 END AS applied_cents,
         CASE WHEN cp.status <> 'voided'
           THEN GREATEST(cp.amount - COALESCE(a.applied, 0), 0)
           ELSE 0 END AS unapplied_cents,
         COALESCE(ld.effective_treasury_date, cp.received_at::date) AS unapplied_effective_date
       FROM customer_payment cp
       LEFT JOIN applied a ON a.payment_id = cp.id
       LEFT JOIN latest_defer ld ON ld.payment_id = cp.id
       WHERE cp.deleted_at IS NULL AND cp.type = 'payment'
     )
     SELECT
       COALESCE(SUM(gross), 0)::bigint   AS gross_payments_cents,
       COALESCE(SUM(refund), 0)::bigint  AS refunds_cents,
       COALESCE(SUM(gross), 0)::bigint - COALESCE(SUM(refund), 0)::bigint AS net_cash_received_cents
     FROM (
       SELECT
         (
           COALESCE(SUM(applied_cents) FILTER (
             WHERE received_at >= ?::timestamptz AND received_at <= ?::timestamptz
           ), 0)
           +
           COALESCE(SUM(unapplied_cents) FILTER (
             WHERE unapplied_effective_date >= ?::date AND unapplied_effective_date <= ?::date
           ), 0)
         ) AS gross,
         0 AS refund
       FROM payment_cash
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
    [dayStart, dayEnd, from, to, dayStart, dayEnd]
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

  // Mirrors compute-splits.ts's own pool guard exactly: with zero real-cash
  // revenue this range, the COGS-weighted split never runs, so any credit-memo
  // redemption's China/Local obligation counted in totals.cogs_* above never
  // actually reached a bucket this range — surface those rows as a gap.
  const cogsRouted =
    totals.cogs_china_cents + totals.cogs_local_cents > 0 &&
    totals.gross_revenue_pre_tax_cents > 0;
  const creditMemoCogsGaps: TreasuryDailyReport["credit_memo_cogs_gaps"] = cogsRouted
    ? []
    : creditMemoCogsRows.map((r) => ({
        payment_id: r.payment_id,
        reference: r.reference,
        customer_id: r.customer_id,
        invoice_id: r.invoice_id,
        order_id: r.order_id,
        redeemed_on: r.redeemed_on,
        cogs_china_cents: toInt(r.cogs_china_cents),
        cogs_local_cents: toInt(r.cogs_local_cents),
      }));

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
        from === to ? "today" : "in this period"
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
        from === to ? "today's" : "this period's"
      } cash is not linked to an order/invoice — counted as cash but not as a sale. Link these to attribute revenue & COGS, or defer them to the next day.`,
    });
  }
  if (creditMemoCogsGaps.length > 0) {
    const gapCents = creditMemoCogsGaps.reduce(
      (sum, r) => sum + r.cogs_china_cents + r.cogs_local_cents,
      0
    );
    warnings.push({
      code: "CREDIT_MEMO_COGS_UNROUTED",
      severity: "info",
      count: creditMemoCogsGaps.length,
      sample_ids: creditMemoCogsGaps.slice(0, 20).map((r) => r.reference ?? r.payment_id),
      detail: `$${(gapCents / 100).toFixed(2)} in China/Local COGS from credit-memo redemptions had no real-cash sale ${
        from === to ? "today" : "in this period"
      } to weight it against, so it never reached a bucket — not carried forward to another day.`,
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
    credit_memo_cogs_gaps: creditMemoCogsGaps,
    reconciliation: result.reconciliation,
    generated_at: new Date().toISOString(),
  };
}

interface LockedDayRow {
  id: string;
  distribution_date: string;
  executed_at: string;
  executed_by_user_id: string | null;
  snapshot_json: TreasuryDailyReport;
}

/** Merges N day/run contributions (locked frozen snapshots + live runs) into one report. */
function mergeContributions(
  from: string,
  to: string,
  contributions: TreasuryDailyReport[],
  liveBucketRows: BucketRow[]
): TreasuryDailyReport {
  const totals = {
    gross_revenue_pre_tax_cents: 0,
    tax_collected_cents: 0,
    cogs_china_cents: 0,
    cogs_local_cents: 0,
    gross_payments_cents: 0,
    refunds_cents: 0,
    net_cash_received_cents: 0,
  };
  const splitAmounts = new Map<TreasuryBucketCode, number>();
  const splitBasisCount = new Map<TreasuryBucketCode, number>();
  const warningsByCode = new Map<
    TreasuryWarningCode,
    { count: number; sample_ids: string[]; severity: TreasuryWarning["severity"]; detail?: string }
  >();
  const unattributed: TreasuryDailyReport["unattributed_payments"] = [];
  const creditMemoCogsGaps: NonNullable<TreasuryDailyReport["credit_memo_cogs_gaps"]> = [];
  let sumOfSplits = 0;
  let netCash = 0;

  for (const c of contributions) {
    (Object.keys(totals) as Array<keyof typeof totals>).forEach((k) => {
      totals[k] += c.totals[k] ?? 0;
    });
    for (const s of c.splits) {
      splitAmounts.set(s.code, (splitAmounts.get(s.code) ?? 0) + s.amount_cents);
      splitBasisCount.set(s.code, (splitBasisCount.get(s.code) ?? 0) + 1);
    }
    for (const w of c.warnings) {
      const existing = warningsByCode.get(w.code);
      if (existing) {
        existing.count += w.count;
        existing.sample_ids = existing.sample_ids.concat(w.sample_ids).slice(0, 20);
      } else {
        warningsByCode.set(w.code, {
          count: w.count,
          sample_ids: w.sample_ids.slice(0, 20),
          severity: w.severity,
          detail: w.detail,
        });
      }
    }
    unattributed.push(...c.unattributed_payments);
    creditMemoCogsGaps.push(...(c.credit_memo_cogs_gaps ?? []));
    sumOfSplits += c.reconciliation.sum_of_splits_cents;
    netCash += c.reconciliation.net_cash_received_cents;
  }

  const bucketByCode = new Map<TreasuryBucketCode, BucketRow>();
  for (const b of liveBucketRows) bucketByCode.set(b.code, b);

  const splits: TreasurySplitWithBucket[] = Array.from(splitAmounts.entries()).map(
    ([code, amount_cents]) => {
      const row = bucketByCode.get(code);
      const bucket: TreasuryBucketView = row
        ? mapBucket(row)
        : {
            id: `tbk_${code}`,
            code,
            label: code,
            display_order: 999,
            is_active: false,
            source_bank: null,
            destination_bank: null,
          };
      const dayCount = splitBasisCount.get(code) ?? 1;
      return {
        code,
        amount_cents,
        basis:
          dayCount > 1
            ? `sum across ${dayCount} day(s)/run(s) in range`
            : contributions.find((c) => c.splits.some((s) => s.code === code))?.splits.find(
                (s) => s.code === code
              )?.basis ?? "",
        bucket,
      };
    }
  );

  const warnings: TreasuryWarning[] = Array.from(warningsByCode.entries()).map(
    ([code, w]) => ({ code, ...w })
  );

  return {
    distribution_date: from,
    range_start: from,
    range_end: to,
    totals,
    splits,
    warnings,
    unattributed_payments: unattributed,
    credit_memo_cogs_gaps: creditMemoCogsGaps,
    reconciliation: {
      sum_of_splits_cents: sumOfSplits,
      net_cash_received_cents: netCash,
      delta_cents: sumOfSplits - netCash,
    },
    generated_at: new Date().toISOString(),
  };
}

/**
 * GET /admin/accounting/treasury/daily entrypoint. For each calendar day in
 * [from,to]: if it's already been confirmed ("Confirm Transfers" — see
 * daily/log/route.ts), its numbers are FROZEN forever — this returns the
 * exact snapshot_json captured at confirm time, never recomputed. Days that
 * aren't confirmed yet are computed live (contiguous unlocked runs share one
 * bulk SQL pass via computeLiveRangeReport — in the common case, locked days
 * form a prefix of the range, so there's exactly one live run).
 *
 * Single-day requests (from === to) get `is_locked`/`confirmed_at`/etc. set
 * directly. Multi-day requests get `locked_days_count`/`total_days_count` so
 * the UI can show how much of the range is audited vs. still a live estimate.
 */
export async function loadDailyReport(
  pg: PgConnection,
  from: string,
  to: string = from
): Promise<TreasuryDailyReport> {
  const days = enumerateDays(from, to);

  const lockedResult = await pg.raw(
    `SELECT id, distribution_date::text AS distribution_date, executed_at,
            executed_by_user_id, snapshot_json
     FROM treasury_distribution_log
     WHERE executed_at IS NOT NULL
       AND distribution_date >= ?::date AND distribution_date <= ?::date`,
    [from, to]
  );
  const lockedRows: LockedDayRow[] = lockedResult.rows ?? [];
  const lockedByDate = new Map<string, LockedDayRow>();
  for (const row of lockedRows) lockedByDate.set(row.distribution_date, row);

  const unlockedRuns = contiguousUnlockedRuns(days, new Set(lockedByDate.keys()));

  const contributions: TreasuryDailyReport[] = [];
  for (const day of days) {
    const locked = lockedByDate.get(day);
    if (locked) contributions.push(locked.snapshot_json);
  }
  for (const run of unlockedRuns) {
    contributions.push(await computeLiveRangeReport(pg, run.from, run.to));
  }

  // Fetch CURRENT bucket→bank mapping for display purposes on merged splits,
  // so a range spanning a bucket remap always shows today's bank names
  // rather than whatever was frozen into an old snapshot.
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
  const liveBucketRows: BucketRow[] = bucketsResult.rows ?? [];

  // Always route through mergeContributions (even for a single contribution)
  // so the return type is never `TreasuryDailyReport | undefined` — a
  // single-element merge just sums to the same values as that one element.
  const merged = mergeContributions(from, to, contributions, liveBucketRows);

  if (from === to) {
    const locked = lockedByDate.get(from);
    if (locked) {
      return {
        ...merged,
        distribution_date: from,
        range_start: from,
        range_end: to,
        is_locked: true,
        confirmed_at: locked.executed_at,
        confirmed_by_user_id: locked.executed_by_user_id,
        log_id: locked.id,
      };
    }
    return merged;
  }

  return {
    ...merged,
    locked_days_count: lockedByDate.size,
    total_days_count: days.length,
  };
}
