/**
 * handle-vendor-credit-apply.ts
 *
 * Confirm handler for a dispatched `vendor_credit_apply` (vc-apply-qb-20260915).
 * There is no `TxnID` to write back for the $0 Pay Bills itself — QuickBooks
 * never mints a document for it — so this is a plain readback confirmation:
 * `poll-submitted-rows.ts`'s dedicated branch verified the bill's
 * `LinkedTxn` before calling this, and this just stamps that the trip
 * happened.
 */

export interface VendorCreditApplyConfirmedRet {
  billTxnId: string;
  creditTxnId: string;
  /** Null unless QuickBooks (unobserved so far) actually minted a document. */
  paymentTxnId: string | null;
}

export interface HandleVendorCreditApplyKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number }>;
}

export async function handleVendorCreditApplyConfirmed(
  knex: HandleVendorCreditApplyKnex,
  vendorCreditApplicationId: string,
  ret: VendorCreditApplyConfirmedRet
): Promise<{ confirmed: true } | { confirmed: false; reason: string }> {
  if (!ret.billTxnId || !ret.creditTxnId) {
    return { confirmed: false, reason: "missing bill/credit TxnID for confirmation" };
  }
  await knex.raw(
    `UPDATE vendor_credit_application
        SET qb_applied_at = NOW(), qb_bill_txn_id = ?, qb_credit_txn_id = ?,
            qb_payment_txn_id = ?, updated_at = NOW()
      WHERE id = ?`,
    [ret.billTxnId, ret.creditTxnId, ret.paymentTxnId ?? null, vendorCreditApplicationId]
  );
  return { confirmed: true };
}
