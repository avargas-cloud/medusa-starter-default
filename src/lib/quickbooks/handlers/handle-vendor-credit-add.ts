/**
 * handle-vendor-credit-add.ts
 *
 * Confirm handler for a dispatched `vendor_credit_add` (gl-purchases-v2 §4).
 * Writes back `qb_txn_id` / `qb_edit_sequence` / `qb_synced_at` from the
 * QuickBooks `VendorCreditRet`.
 *
 * PURE-ish: no bridge call, just the DB write — the caller (R3's dispatcher,
 * once the bridge actually returns a `VendorCreditRet`) is responsible for
 * polling the operation and handing this the parsed Ret. This phase never
 * calls it from a running job (`QB_BRIDGE_DISABLED=true`); it exists so R3
 * has a single, tested place to land the write-back, same shape as the
 * vendor-bill lane's confirm write (`poll-submitted-rows.ts` line ~277/329).
 */

export interface VendorCreditRet {
  TxnID?: string;
  EditSequence?: string;
}

export interface HandleVendorCreditAddKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount?: number }>;
}

export async function handleVendorCreditAddConfirmed(
  knex: HandleVendorCreditAddKnex,
  vendorCreditId: string,
  ret: VendorCreditRet
): Promise<{ confirmed: true } | { confirmed: false; reason: string }> {
  if (!ret.TxnID) {
    return { confirmed: false, reason: "VendorCreditRet has no TxnID" };
  }
  await knex.raw(
    `UPDATE vendor_credit
        SET qb_txn_id = ?, qb_edit_sequence = COALESCE(?, qb_edit_sequence),
            qb_synced_at = NOW(), updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [ret.TxnID, ret.EditSequence ?? null, vendorCreditId]
  );
  return { confirmed: true };
}
