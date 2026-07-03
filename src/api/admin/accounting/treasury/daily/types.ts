import type {
  BucketSplit,
  TreasuryBucketCode,
} from "../_lib/compute-splits";

export type { TreasuryBucketCode, BucketSplit };

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
  | "UNATTRIBUTED_PAYMENTS";

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
  received_at: string;
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
  reconciliation: {
    sum_of_splits_cents: number;
    net_cash_received_cents: number;
    delta_cents: number;
  };
  generated_at: string;
}
