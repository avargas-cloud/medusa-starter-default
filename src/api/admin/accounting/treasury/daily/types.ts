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
  | "FOREIGN_CURRENCY_DETECTED";

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

export interface TreasuryDailyReport {
  distribution_date: string;
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
  reconciliation: {
    sum_of_splits_cents: number;
    net_cash_received_cents: number;
    delta_cents: number;
  };
  generated_at: string;
}
