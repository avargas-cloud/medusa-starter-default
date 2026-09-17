/**
 * Pure split computation for the daily treasury report.
 *
 * All inputs and outputs are in CENTS (integer). The single hard invariant
 * this module guarantees:
 *
 *     sum(splits[].amount_cents) === net_cash_received_cents
 *
 * That guarantee is what makes the daily report trustable: every penny that
 * arrived at (or left) the merchant's cash position is accounted for in
 * exactly one bucket. Any rounding remainder is dumped into the `operating`
 * bucket so the invariant holds even with messy ratios.
 *
 * The formula intentionally does NOT try to retroactively attribute COGS
 * for cross-day refunds. When today's invoices say "$0 of china COGS" but
 * cash dropped due to a refund of an old china order, the refund flows into
 * `operating` (negative) — and a CROSS_DAY_REFUND_DETECTED warning is
 * emitted upstream so the operator knows to interpret accordingly.
 */

export type TreasuryBucketCode =
  | "china_cogs"
  | "local_cogs"
  | "tax_holding"
  | "operating"
  | "reserve";

export interface SplitInputs {
  gross_revenue_pre_tax_cents: number;
  tax_collected_cents: number;
  cogs_china_cents: number;
  cogs_local_cents: number;
  net_cash_received_cents: number;
  /**
   * Cash counted in `net_cash_received_cents` that has NO order/invoice
   * behind it yet (customer deposits, unlinked wires). It carries no revenue
   * and no COGS, so it must not feed the COGS-weighted pool: it sits whole in
   * `operating` until the operator links or assigns it. Defaults to 0.
   *
   * 2026-09-17: before this input the pool was derived from ALL cash with a
   * ratio derived from ORDERED sales only — a $23.5k deposit on a $5.2k sales
   * day inflated the pool 5.7× and, once its face value was also assigned to
   * a bucket, drove Operating to −$8,773.86 on 09/14.
   */
  unapplied_cash_cents?: number;
  /**
   * Bucket codes that are active in the treasury_bucket registry. Inactive
   * buckets are omitted from the result entirely. `operating` should always
   * be in this list — it is the rounding sink that guarantees delta=0.
   */
  active_bucket_codes: ReadonlyArray<TreasuryBucketCode>;
}

export interface BucketSplit {
  code: TreasuryBucketCode;
  amount_cents: number;
  basis: string;
}

export interface SplitResult {
  splits: BucketSplit[];
  reconciliation: {
    sum_of_splits_cents: number;
    net_cash_received_cents: number;
    delta_cents: number;
  };
}

const intDiv = (n: number, d: number): number => Math.trunc(n / d);

export function computeSplits(inputs: SplitInputs): SplitResult {
  const {
    gross_revenue_pre_tax_cents,
    tax_collected_cents,
    cogs_china_cents,
    cogs_local_cents,
    net_cash_received_cents,
    active_bucket_codes,
  } = inputs;
  const unapplied_cash_cents = Math.max(0, inputs.unapplied_cash_cents ?? 0);

  const active = new Set<TreasuryBucketCode>(active_bucket_codes);
  if (!active.has("operating")) {
    // Operating MUST be present as the rounding sink. Force it on rather than
    // silently dropping pennies.
    active.add("operating");
  }

  // 1. Tax is a pure passthrough — what was collected, regardless of cash.
  const split_tax = active.has("tax_holding") ? tax_collected_cents : 0;

  // 2. Cash available after parking sales tax aside.
  const cash_after_tax = net_cash_received_cents - split_tax;
  // 2b. Only cash with an order behind it can carry COGS. Un-ordered cash
  // (deposits, unlinked wires) is left out of the pool basis — never below 0.
  const pool_basis = Math.max(0, cash_after_tax - unapplied_cash_cents);

  // 3. COGS-weighted attribution.
  const cogs_total = cogs_china_cents + cogs_local_cents;
  let split_china = 0;
  let split_local = 0;
  let basis_china = "no china COGS today";
  let basis_local = "no local COGS today";

  if (cogs_total > 0 && gross_revenue_pre_tax_cents > 0) {
    // recovery_share is the fraction of today's sales that represents COGS
    // recovery (i.e. cash that needs to go back into inventory replenishment).
    // Clamp to [0, 1] so a freak data state can't blow up the pool.
    const ratio_num = cogs_total;
    const ratio_den = gross_revenue_pre_tax_cents;
    // pool_cents = floor(pool_basis * cogs_total / gross_revenue) in integer math.
    const pool_signed =
      ratio_num >= ratio_den
        ? pool_basis
        : intDiv(pool_basis * ratio_num, ratio_den);

    if (active.has("china_cogs")) {
      split_china = intDiv(pool_signed * cogs_china_cents, cogs_total);
      basis_china = `pool × cogs_china/cogs_total (${cogs_china_cents}/${cogs_total})`;
    }
    if (active.has("local_cogs")) {
      // Local absorbs the china/local rounding remainder so china+local = pool.
      split_local = pool_signed - split_china;
      basis_local = `pool − china split`;
    } else if (split_china !== 0) {
      // china active but local inactive: china took everything.
      split_china = pool_signed;
      basis_china = `pool (local bucket inactive)`;
    }
  }

  // 4. Operating absorbs everything left so the invariant holds.
  const split_operating =
    net_cash_received_cents - split_tax - split_china - split_local;

  // 5. Reserve is always 0 in v1 (monthly sweep is Phase 2).
  const split_reserve = 0;

  const ordered: ReadonlyArray<[TreasuryBucketCode, number, string]> = [
    ["china_cogs", split_china, basis_china],
    ["local_cogs", split_local, basis_local],
    ["tax_holding", split_tax, "sales tax collected (passthrough)"],
    ["operating", split_operating, "net cash − tax − china − local (sink)"],
    ["reserve", split_reserve, "Phase 2 — not allocated in v1"],
  ];

  const splits: BucketSplit[] = ordered
    .filter(([code]) => active.has(code))
    .map(([code, amount_cents, basis]) => ({ code, amount_cents, basis }));

  const sum = splits.reduce((acc, s) => acc + s.amount_cents, 0);

  return {
    splits,
    reconciliation: {
      sum_of_splits_cents: sum,
      net_cash_received_cents,
      delta_cents: sum - net_cash_received_cents,
    },
  };
}
