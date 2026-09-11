/**
 * handle-vendor-credit-void.ts — confirm handler for `vendor_credit_void`
 * (gl-purchases-v2 §4). QuickBooks' `TxnVoidRs` carries no useful Ret body —
 * success just means the void happened — so this only stamps local state.
 * See handle-vendor-credit-add.ts for the write-back precedent.
 */

export interface HandleVendorCreditVoidKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number }>;
}

export async function handleVendorCreditVoidConfirmed(
  knex: HandleVendorCreditVoidKnex,
  vendorCreditId: string,
  voidedBy: string | null
): Promise<void> {
  await knex.raw(
    `UPDATE vendor_credit
        SET status = 'voided', voided_at = NOW(), voided_by = ?, updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL AND status <> 'voided'`,
    [voidedBy, vendorCreditId]
  );
}
