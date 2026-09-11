/**
 * handle-bill-payment-void.ts — confirm handler for `bill_payment_void`
 * (gl-purchases-v2 §4). Same shape as handle-vendor-credit-void.ts.
 */

export interface HandleBillPaymentVoidKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number }>;
}

export async function handleBillPaymentVoidConfirmed(
  knex: HandleBillPaymentVoidKnex,
  vendorBillPaymentId: string,
  voidedBy: string | null
): Promise<void> {
  await knex.raw(
    `UPDATE vendor_bill_payment
        SET status = 'voided', voided_at = NOW(), voided_by = ?, updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL AND status <> 'voided'`,
    [voidedBy, vendorBillPaymentId]
  );
}
