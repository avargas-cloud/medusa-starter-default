/**
 * handle-bill-payment-add.ts
 *
 * Confirm handler for a dispatched `bill_payment_add` (gl-purchases-v2 §4).
 * Writes back `qb_txn_id` / `qb_edit_sequence` / `qb_synced_at` from
 * `BillPaymentCheckRet` or `BillPaymentCreditCardRet` (both carry the same
 * two fields this handler needs).
 */

export interface BillPaymentRet {
  TxnID?: string;
  EditSequence?: string;
}

export interface HandleBillPaymentAddKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number }>;
}

export async function handleBillPaymentAddConfirmed(
  knex: HandleBillPaymentAddKnex,
  vendorBillPaymentId: string,
  ret: BillPaymentRet
): Promise<{ confirmed: true } | { confirmed: false; reason: string }> {
  if (!ret.TxnID) {
    return { confirmed: false, reason: "BillPaymentRet has no TxnID" };
  }
  await knex.raw(
    `UPDATE vendor_bill_payment
        SET qb_txn_id = ?, qb_edit_sequence = COALESCE(?, qb_edit_sequence),
            qb_synced_at = NOW(), updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [ret.TxnID, ret.EditSequence ?? null, vendorBillPaymentId]
  );
  return { confirmed: true };
}
