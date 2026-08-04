/**
 * unbind-receipt-from-bills.ts
 *
 * Severs every receipt↔bill link before a PurchaseOrderReceipt row is
 * destroyed, so the FK cascade cannot take a vendor bill with it.
 *
 * WHY THIS EXISTS (2026-08-04)
 * ---------------------------
 * `vendor_bill.purchase_order_receipt_id` is declared ON DELETE CASCADE, and
 * `vendor_bill_line.vendor_bill_id` cascades in turn. So deleting a receipt
 * HARD-DELETES any bill whose legacy "primary receipt" pointer names it —
 * together with every one of its lines — silently, in the database, with no
 * code path to observe it. That was survivable only because the delete route
 * refused to run whenever a draft/confirmed/synced bill was linked at all.
 *
 * Now that a DRAFT bill no longer blocks the delete (a draft is not yet an
 * accounting fact; the bill's own drift banner reports lines that are no
 * longer backed by a receipt), that guard is gone and the cascade is live.
 * Unbinding first is what keeps "delete the receipt" from meaning "and also
 * destroy the vendor's invoice".
 *
 * Deliberately status-agnostic and deleted_at-agnostic: cancelled, voided and
 * SOFT-DELETED bills still own a live row, and a soft-deleted bill cascades
 * exactly like any other. The blocking decision belongs to the route; by the
 * time we are called, whatever is still linked is a bill that must survive.
 *
 * Confirmed/synced bills never reach here — the route rejects those with 409
 * `receipt_has_active_vendor_bill`.
 */

import { syncPrimaryReceiptPointer, type RawKnex } from "./vendor-bill-receipts";

export interface UnbindReceiptResult {
  /** Bills that had a link to this receipt and were detached from it. */
  unbound_bill_ids: string[];
  /** vendor_bill_line rows whose receipt_line_id pointer was cleared. */
  cleared_bill_lines: number;
}

/**
 * Detaches `receiptId` from every bill that references it, in all three ways
 * a link can exist, and re-derives each affected bill's legacy primary-receipt
 * pointer from whatever receipts remain bound.
 *
 * Idempotent: a second call finds nothing and returns an empty result.
 */
export async function unbindReceiptFromBills(
  db: RawKnex,
  receiptId: string
): Promise<UnbindReceiptResult> {
  // ---- 1) Collect every bill linked to this receipt, by any of the three
  // routes the delete guard checks. No status or deleted_at filter: the point
  // is to find rows that would cascade, and both cancelled and soft-deleted
  // bills cascade.
  const affected = await db.raw(
    `SELECT DISTINCT vb.id
       FROM vendor_bill vb
      WHERE vb.purchase_order_receipt_id = ?
         OR vb.id = (
              SELECT por.vendor_bill_id
                FROM purchase_order_receipt por
               WHERE por.id = ?
            )
         OR EXISTS (
              SELECT 1
                FROM vendor_bill_line vbl
               WHERE vbl.vendor_bill_id = vb.id
                 AND vbl.receipt_line_id IN (
                       SELECT id
                         FROM purchase_order_receipt_line
                        WHERE purchase_order_receipt_id = ?
                     )
            )`,
    [receiptId, receiptId, receiptId]
  );
  const billIds = (affected.rows as Array<{ id: string }>).map((r) => r.id);

  // ---- 2) Drop the per-line pointers. These are bare columns (no FK), so
  // they would not cascade — they would DANGLE, pointing at receipt lines that
  // no longer exist, which is worse: the bill would still claim to be sourced
  // from a receipt nobody can read.
  const clearedLines = await db.raw(
    `UPDATE vendor_bill_line
        SET receipt_line_id = NULL, updated_at = NOW()
      WHERE receipt_line_id IN (
              SELECT id
                FROM purchase_order_receipt_line
               WHERE purchase_order_receipt_id = ?
            )`,
    [receiptId]
  );

  // ---- 3) Drop the new source of truth (receipt → bill).
  await db.raw(
    `UPDATE purchase_order_receipt
        SET vendor_bill_id = NULL, updated_at = NOW()
      WHERE id = ?`,
    [receiptId]
  );

  // ---- 4) Drop the legacy mirror (bill → primary receipt). This is THE
  // cascade edge.
  //
  // Unfiltered on purpose, and NOT redundant with step 5 even though step 5
  // would blank the same column for a live bill: syncPrimaryReceiptPointer
  // ends in `WHERE id = ? AND deleted_at IS NULL`, so it cannot touch a
  // SOFT-DELETED bill — and a soft-deleted bill still owns a row, so it still
  // cascades. Removing this line leaves exactly one victim: the soft-deleted
  // bill, which is also the one nobody would think to look for.
  // (Proven by mutation test: with this line commented out, the soft-deleted
  // fixture in verify-receipt-delete-draft-bill.ts is destroyed.)
  await db.raw(
    `UPDATE vendor_bill
        SET purchase_order_receipt_id = NULL, updated_at = NOW()
      WHERE purchase_order_receipt_id = ?`,
    [receiptId]
  );

  // ---- 5) Re-derive the legacy pointer for each affected bill from the
  // receipts that are STILL bound. A bill spanning three receipts keeps a
  // valid primary; a bill left with none keeps NULL from step 4.
  for (const billId of billIds) {
    await syncPrimaryReceiptPointer(db, billId);
  }

  return {
    unbound_bill_ids: billIds,
    cleared_bill_lines:
      (clearedLines as unknown as { rowCount?: number }).rowCount ?? 0,
  };
}
