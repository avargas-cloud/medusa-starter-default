import { randomUUID } from "crypto";

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "./qb-purchase-dependency-chain";

/**
 * Stages the destructive half of a Vendor Bill rebuild.
 *
 * The operation deliberately stops after QuickBooks confirms TxnDel. The local
 * bill remains a draft until the operator reconfirms it, at which point the
 * normal accounting transaction freezes a fresh BillAdd behind the confirmed
 * delete. This prevents local AVCO/COGS from moving before QB releases the bill.
 */
export type UnlockKnex = PurchaseDependencyKnex;

export type ClaimUnlockResult =
  | {
      ok: true;
      pipelineRowId: string;
      preflightOperationId: string;
      deleteOperationId: string;
    }
  | { ok: false; code: "bill_not_found"; message: string }
  | { ok: false; code: "bill_not_synced"; message: string }
  | { ok: false; code: "bill_rebuild_not_required"; message: string }
  | { ok: false; code: "adopted_bill_readonly"; message: string }
  | { ok: false; code: "unlock_already_in_flight"; message: string };

export interface ClaimUnlockInput {
  reason: string;
  actorId: string;
  /**
   * Why the rebuild is being claimed.
   *
   * `new_po_line` is the original flow: a Bill grew a PO-linked line, which
   * `BillMod` cannot create, so the document has to be rebuilt.
   *
   * `po_contraction_repair` is the 2026-08-04 repair path: the PO is being
   * reduced below what QuickBooks' Bill claims, and QB refuses the PO Mod
   * (error 3060) until that claim is gone. There may be no new line at all,
   * and the guards below are relaxed ONLY for this trigger — the original
   * flow keeps the exact behaviour it was written with.
   */
  trigger?: "new_po_line" | "po_contraction_repair";
}

interface BillRow {
  id: string;
  purchase_order_id: string | null;
  qb_txn_id: string | null;
  qb_source: string | null;
}

interface PipelineRow {
  id: string;
  intent: string;
  status: string;
  void_status: string | null;
  delegated_status: string | null;
}

const TERMINAL_VOID_STATUSES = new Set<string | null>([
  null,
  "voided",
  "failed_permanent",
]);
const REBUILD_INTENTS = new Set([
  "unlock_rebuild",
  "rebuild_prepare",
  "rebuild_deleting",
]);
const TERMINAL_DELEGATED_STATUSES = new Set(["confirmed", "fixed"]);

export async function claimUnlock(
  db: UnlockKnex,
  vendorBillId: string,
  input: ClaimUnlockInput
): Promise<ClaimUnlockResult> {
  if (!db.transaction) {
    throw new Error("Vendor Bill rebuild requires a database transaction");
  }

  return db.transaction(async (trx) => {
    const billResult = await trx.raw(
      `SELECT id, purchase_order_id, qb_txn_id, qb_source
         FROM vendor_bill
        WHERE id = ? AND deleted_at IS NULL AND bill_type = 'regular'
        FOR UPDATE`,
      [vendorBillId]
    );
    const bill = (billResult.rows[0] ?? null) as BillRow | null;
    if (!bill) {
      return {
        ok: false,
        code: "bill_not_found",
        message: "Vendor bill not found or not a regular bill",
      };
    }
    if (!bill.qb_txn_id || !bill.purchase_order_id) {
      return {
        ok: false,
        code: "bill_not_synced",
        message:
          "This bill is not linked to a QuickBooks Bill and cannot be prepared for rebuild",
      };
    }
    if (bill.qb_source === "adopted") {
      return {
        ok: false,
        code: "adopted_bill_readonly",
        message:
          "This adopted bill is managed by the accountant in QuickBooks Desktop",
      };
    }
    const unlinkedPoLineResult = await trx.raw(
      `SELECT 1
         FROM vendor_bill_line
        WHERE vendor_bill_id = ?
          AND deleted_at IS NULL
          AND COALESCE(line_type, 'product') = 'product'
          AND purchase_order_line_id IS NOT NULL
          AND qb_txn_line_id IS NULL
        LIMIT 1`,
      [vendorBillId]
    );
    // A contraction repair has no new line to look for — the Bill is being
    // deleted so the PO can SHRINK below what QuickBooks says is billed. Asking
    // for a new line here would reject exactly the case the repair exists for.
    if (
      unlinkedPoLineResult.rows.length === 0 &&
      input.trigger !== "po_contraction_repair"
    ) {
      return {
        ok: false,
        code: "bill_rebuild_not_required",
        message:
          "This Bill has no new PO-linked line. Existing lines must be updated through BillMod, not by rebuilding the Bill.",
      };
    }

    const agentResult = await trx.raw(
      `SELECT 1
         FROM qb_vendor qv
         JOIN purchase_order po
           ON po.vendor_id = qv.id AND po.deleted_at IS NULL
        WHERE po.id = ? AND qv.deleted_at IS NULL
          AND COALESCE((qv.metadata ->> 'is_china_agent') = 'true'
                       OR qv.metadata @> '{"is_china_agent": true}'::jsonb, false)`,
      [bill.purchase_order_id]
    );
    // [REMOVED 2026-08-04] `china_agent_unlock_blocked`.
    //
    // China-agent bills carry negative clearing lines that cancel their sibling
    // freight/commission bills, so deleting one leaves those siblings
    // uncancelled in A/P until the operator re-confirms. That window is why the
    // path was closed to them — but closing it did not avoid the problem, it
    // only removed the way out: a China-agent bill with a new PO-linked line
    // cannot be corrected by BillMod either (QuickBooks creates PO links on Add
    // only), so those bills had NO path at all.
    //
    // The owner weighed the window and accepted it: the repair is a deliberate
    // correction that ends in a confirm, and the real risk is not the window
    // but someone never finishing — which the TO CONFIRM! markers address.
    //
    // Everything that made this dangerous still guards it: the rebuild still
    // requires a genuinely new PO-linked line (unless it is a contraction
    // repair), the route still demands a supervisor PIN and a reason, and the
    // preflight now refuses any bill with a payment applied to it.
    void agentResult;

    const existingResult = await trx.raw(
      `SELECT qvb.id, qvb.intent, qvb.status, qvb.void_status,
              qop.status AS delegated_status
         FROM qb_vendor_bill_pipeline qvb
         LEFT JOIN qb_order_pipeline qop ON qop.id = qvb.order_pipeline_id
        WHERE qvb.vendor_bill_id = ? AND qvb.deleted_at IS NULL
        LIMIT 1
        FOR UPDATE OF qvb`,
      [vendorBillId]
    );
    const existing = (existingResult.rows[0] ?? null) as PipelineRow | null;
    const delegatedInFlight =
      existing?.delegated_status != null &&
      !TERMINAL_DELEGATED_STATUSES.has(existing.delegated_status);
    if (
      existing &&
      (REBUILD_INTENTS.has(existing.intent) ||
        delegatedInFlight ||
        !TERMINAL_VOID_STATUSES.has(existing.void_status))
    ) {
      return {
        ok: false,
        code: "unlock_already_in_flight",
        message:
          "A QuickBooks operation is already in progress for this bill. Let it finish or resolve it before rebuilding.",
      };
    }

    const rebuildRequestId = `qbrebuild_${randomUUID().replace(/-/g, "")}`;
    const snapshot = {
      previous_payload: null,
      rebuild_reason: input.reason,
      requested_by: input.actorId,
      requested_at: new Date().toISOString(),
      rebuild_request_id: rebuildRequestId,
    };

    let pipelineRowId = existing?.id ?? null;
    if (pipelineRowId) {
      const updated = await trx.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET intent = 'rebuild_prepare', status = 'waiting',
                qb_operation_id = NULL, retries = 0,
                next_retry_at = NULL, last_error = NULL,
                qb_txn_id = COALESCE(qb_txn_id, ?),
                snapshot = ?::jsonb ||
                  jsonb_build_object('previous_payload', payload),
                updated_at = NOW()
          WHERE id = ?
          RETURNING id`,
        [bill.qb_txn_id, JSON.stringify(snapshot), pipelineRowId]
      );
      pipelineRowId = String(
        (updated.rows[0] as { id: string } | undefined)?.id ?? ""
      );
    } else {
      pipelineRowId = `qbvbpipe_${randomUUID().replace(/-/g, "")}`;
      await trx.raw(
        `INSERT INTO qb_vendor_bill_pipeline
           (id, vendor_bill_id, purchase_order_id, status, intent, qb_txn_id,
            payload, snapshot, created_at, updated_at)
         VALUES (?, ?, ?, 'waiting', 'rebuild_prepare', ?,
                 '{}'::jsonb, ?::jsonb, NOW(), NOW())`,
        [
          pipelineRowId,
          vendorBillId,
          bill.purchase_order_id,
          bill.qb_txn_id,
          JSON.stringify(snapshot),
        ]
      );
    }
    if (!pipelineRowId) {
      throw new Error("Vendor Bill rebuild pipeline row was not created");
    }

    const commonPayload = {
      delegated_to_consolidator: true,
      rebuild_request_id: rebuildRequestId,
      vendor_bill_id: vendorBillId,
      qb_vendor_bill_pipeline_id: pipelineRowId,
      txn_id: bill.qb_txn_id,
      reason: input.reason,
      requested_by: input.actorId,
    };
    const preflight = await enqueuePurchaseQbOperation(trx, {
      purchaseOrderId: bill.purchase_order_id,
      referenceId: vendorBillId,
      referenceType: "vendor_bill",
      step: "vendor_bill_rebuild_preflight",
      qbTxnId: bill.qb_txn_id,
      payload: commonPayload,
      operationKey: purchaseOperationKey(
        "vendor_bill_rebuild_preflight",
        vendorBillId,
        commonPayload
      ),
    });
    const deletePayload = {
      ...commonPayload,
      preflight_operation_id: preflight.id,
    };
    const deletion = await enqueuePurchaseQbOperation(trx, {
      purchaseOrderId: bill.purchase_order_id,
      referenceId: vendorBillId,
      referenceType: "vendor_bill",
      step: "vendor_bill_rebuild_delete",
      qbTxnId: bill.qb_txn_id,
      payload: deletePayload,
      operationKey: purchaseOperationKey(
        "vendor_bill_rebuild_delete",
        vendorBillId,
        deletePayload
      ),
    });
    await trx.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET order_pipeline_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [deletion.id, pipelineRowId]
    );

    return {
      ok: true,
      pipelineRowId,
      preflightOperationId: preflight.id,
      deleteOperationId: deletion.id,
    };
  });
}
