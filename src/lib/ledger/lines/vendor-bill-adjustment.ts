import {
  LedgerAccount,
  LedgerError,
  LedgerLine,
  PurchaseAccountMap,
} from "../types";

export type VendorBillAdjustmentDirection = "decrease_ap" | "increase_ap";

export interface VendorBillAdjustmentSnapshot {
  amountCents: bigint;
  direction: VendorBillAdjustmentDirection;
  /** Rounding / price-variance account of the row (`account_list_id`). */
  account: LedgerAccount;
}

/**
 * ap-rounding-cleanup-20260916: `vendor_bill_adjustment` — the AP twin of
 * `lines/rounding.ts`. `decrease_ap` = the POS owed MORE than the vendor was
 * paid (Σ lines > real invoice): Dr AP / Cr account, AP goes down.
 * `increase_ap` = the POS owed LESS (overpaid by cents): Dr account / Cr AP.
 * Always two lines, same amount on both sides.
 */
export function buildVendorBillAdjustmentLines(
  snapshot: VendorBillAdjustmentSnapshot,
  map: PurchaseAccountMap
): LedgerLine[] {
  if (snapshot.amountCents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", {
      amountCents: snapshot.amountCents.toString(),
    });
  if (snapshot.direction === "decrease_ap")
    return [
      {
        role: "accounts_payable",
        account: map.accounts_payable,
        debit_cents: snapshot.amountCents,
        credit_cents: 0n,
      },
      {
        role: "adjustment_account",
        account: snapshot.account,
        debit_cents: 0n,
        credit_cents: snapshot.amountCents,
      },
    ];
  return [
    {
      role: "adjustment_account",
      account: snapshot.account,
      debit_cents: snapshot.amountCents,
      credit_cents: 0n,
    },
    {
      role: "accounts_payable",
      account: map.accounts_payable,
      debit_cents: 0n,
      credit_cents: snapshot.amountCents,
    },
  ];
}
