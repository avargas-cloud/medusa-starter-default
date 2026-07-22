import type {
  BucketSplit,
  TreasuryBucketCode,
} from "../_lib/compute-splits";
import type { CreditMemoMovementView } from "../_lib/load-cm-movements";

export type { TreasuryBucketCode, BucketSplit };
export type { CreditMemoMovementView };

export type TreasuryWarningCode =
  | "LINES_MISSING_AVG_COST"
  | "LINES_USED_UNIT_COST_FALLBACK"
  | "STALE_COST"
  | "PRODUCT_MISSING_ORIGIN_TAG"
  | "BUCKET_WITHOUT_BANK_MAPPING"
  | "NO_COGS_DATA_FOR_DAY"
  | "NET_CASH_BELOW_TAX"
  | "CROSS_DAY_REFUND_DETECTED"
  | "FOREIGN_CURRENCY_DETECTED"
  | "UNATTRIBUTED_PAYMENTS"
  | "CREDIT_MEMO_COGS_UNROUTED"
  | "CM_MOVEMENTS_UNRESOLVED";

export interface TreasuryWarning {
  code: TreasuryWarningCode;
  severity: "info" | "warning" | "error";
  count: number;
  sample_ids: string[];
  detail?: string;
}

export interface TreasuryBucketView {
  id: string;
  code: TreasuryBucketCode;
  label: string;
  display_order: number;
  is_active: boolean;
  source_bank: {
    id: string;
    name: string;
    type: string;
  } | null;
  destination_bank: {
    id: string;
    name: string;
    type: string;
  } | null;
}

export interface TreasurySplitWithBucket extends BucketSplit {
  bucket: TreasuryBucketView;
}

export interface UnattributedPaymentView {
  payment_id: string;
  display_id: number | null;
  customer_id: string | null;
  amount_cents: number;
  applied_cents: number;
  unapplied_cents: number;
  method: string | null;
  source: string | null;
  status: string | null;
  has_locked_order: boolean;
  /** The payment's real capture timestamp — never altered by deferral. */
  original_received_at: string;
  /** Day this payment's unapplied cash currently counts toward for Treasury. */
  effective_treasury_date: string;
  /** How many times "Exception — defer to next day" has been used on this payment. */
  defer_count: number;
  /** True when the referenced order is still a draft (approved estimate not yet converted). */
  estimate_pending: boolean;
  /** The estimate's document number (e.g. "E-2687") when estimate_pending. */
  estimate_doc_no: string | null;
  /** The draft order id to deep-link into the estimate for conversion. */
  estimate_order_id: string | null;
  /** Bucket from a "treat as credit" resolution (null = none). */
  credit_bucket: TreasuryBucketCode | null;
  /** Remainder snapshot stored when the credit resolution was made. */
  credit_amount_cents: number | null;
  /** True when the live remainder no longer matches the resolved snapshot. */
  credit_stale: boolean;
  /** True when this row still blocks the day's Confirm Transfers. */
  blocking: boolean;
}

/**
 * A credit-memo redemption whose COGS contribution wasn't actually reflected
 * in that day's china_cogs/local_cogs split — because the day had zero
 * real-cash revenue to weight it against (compute-splits.ts's pool formula
 * requires gross_revenue_pre_tax_cents > 0 to run at all). The credit itself
 * moved zero new cash (correctly excluded from net_cash always), but the
 * China/Local vendor obligation behind the redeemed goods is real and — on
 * a day like this — never got a chance to shift the bucket split. It isn't
 * carried forward to any other day; this is the only place it's visible.
 */
export interface CreditMemoCogsGapView {
  payment_id: string;
  /** e.g. "CM-1090" */
  reference: string | null;
  customer_id: string | null;
  /** The invoice/order the credit was redeemed against. */
  invoice_id: string | null;
  order_id: string | null;
  /** Day the redemption itself happened (payment_application.applied_at), not the original return date. */
  redeemed_on: string;
  cogs_china_cents: number;
  cogs_local_cents: number;
}

/**
 * A single CASH sale line that shipped/was-paid this day but has no usable
 * cost (unit cost is NULL or literally $0), so it contributed $0 to the COGS
 * pool and its whole revenue landed in Operating. Advisory only — could be a
 * legit free sample or a missing-cost data error; the accountant verifies.
 * See load-zero-cost-lines.ts.
 */
export interface ZeroCostLineView {
  source_kind: "invoice" | "order";
  /** pos_invoice.id or order.id — for building a detail-page link. */
  source_id: string | null;
  /** Invoice number (e.g. "20930") or order display id (e.g. "2450"). */
  source_ref: string | null;
  payment_display_id: number | null;
  sku: string | null;
  description: string | null;
  quantity: number;
  /** Line's sale value attributed to the day's cash, in cents — the money
   * that went to Operating with no matching COGS. */
  revenue_cents: number;
  /** Where the COGS WOULD have been routed had a cost existed. */
  origin: "china" | "local" | "untagged";
  /** true = cost is literally 0 (possible legit sample); false = cost missing
   * entirely (more likely a data error to fix). */
  cost_is_explicit_zero: boolean;
}

export interface TreasuryDailyReport {
  /** Backward-compat single-day anchor; equals range_start. */
  distribution_date: string;
  /** Inclusive range start (YYYY-MM-DD). Equals range_end for single-day reports. */
  range_start: string;
  /** Inclusive range end (YYYY-MM-DD). */
  range_end: string;
  totals: {
    gross_revenue_pre_tax_cents: number;
    tax_collected_cents: number;
    cogs_china_cents: number;
    cogs_local_cents: number;
    gross_payments_cents: number;
    refunds_cents: number;
    net_cash_received_cents: number;
  };
  splits: TreasurySplitWithBucket[];
  warnings: TreasuryWarning[];
  unattributed_payments: UnattributedPaymentView[];
  /** Credit-memo redemptions whose China/Local COGS never got routed to a bucket — see CreditMemoCogsGapView. Empty/absent on snapshots frozen before this field existed. */
  credit_memo_cogs_gaps?: CreditMemoCogsGapView[];
  /** Credit-memo cross-category COGS movements needing accountant resolution before lock — see CreditMemoMovementView. Empty/absent on snapshots frozen before this field existed. */
  credit_memo_movements?: CreditMemoMovementView[];
  /** Cash sale lines with no usable cost ($0/missing) whose revenue fell into Operating — see ZeroCostLineView. Empty/absent on snapshots frozen before this field existed. */
  zero_cost_cogs_lines?: ZeroCostLineView[];
  reconciliation: {
    sum_of_splits_cents: number;
    net_cash_received_cents: number;
    delta_cents: number;
  };
  generated_at: string;
  /** True when this exact single day (range_start === range_end) is frozen/locked. */
  is_locked?: boolean;
  /** Set when is_locked — timestamp the "Confirm Transfers" action ran. */
  confirmed_at?: string;
  /** Set when is_locked — the user_id that clicked "Confirm Transfers". */
  confirmed_by_user_id?: string | null;
  /** Set when is_locked — the treasury_distribution_log row id. */
  log_id?: string;
  /** Multi-day (range) reports only: how many of the days in [range_start, range_end] are locked. */
  locked_days_count?: number;
  /** Multi-day (range) reports only: total calendar days in [range_start, range_end]. */
  total_days_count?: number;
}
