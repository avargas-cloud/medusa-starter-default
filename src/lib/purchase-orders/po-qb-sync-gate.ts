/**
 * src/lib/purchase-orders/po-qb-sync-gate.ts
 *
 * Dependency gate: an ItemReceipt must never be dispatched to QuickBooks while
 * its Purchase Order still has an unsynced change sitting in
 * `qb_purchase_order_pipeline`.
 *
 * Why (incident RCP-1143 / PO-1113, 2026-07-23):
 *   The PO was edited in Medusa (a line went 40 → 42, another 5 → 3, one line
 *   removed). The resulting PurchaseOrderMod failed in QB, so QuickBooks kept
 *   the pre-edit quantities. Minutes later the warehouse received the goods and
 *   the ItemReceipt ADD was dispatched with the NEW Medusa quantities — QB
 *   rejected it with error 3060 "This quantity exceeds what you ordered",
 *   because from QB's point of view only 40 were ever ordered.
 *
 *   The two pipelines (`qb_purchase_order_pipeline` and
 *   `qb_item_receipt_pipeline`) are drained by independent crons with no
 *   ordering between them, so nothing stopped the receipt from overtaking the
 *   PO edit it depends on. This gate is that ordering.
 *
 * A receipt held by this gate stays visible: `last_error` carries the reason,
 * which the QB pipeline UI renders under the row.
 */

export type KnexLike = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export type PoQbSyncGate =
  | { blocked: false }
  | {
      /** The receipt must not be sent to QB yet. */
      blocked: true;
      /**
       * `true` when the PO change failed permanently — the block will not clear
       * on its own; a human has to fix the PO sync (or Retry it) first.
       */
      terminal: boolean;
      /** Human-readable reason, stored in `last_error` and surfaced in the UI. */
      reason: string;
    };

const NOT_BLOCKED: PoQbSyncGate = { blocked: false };

type PipelineRow = {
  status: string | null;
  po_number: string | null;
};

/**
 * Returns whether QuickBooks work for `purchaseOrderId` is still pending, which
 * means any ItemReceipt add/mod for that PO would be evaluated by QB against
 * stale line quantities.
 *
 * No pipeline row at all → not blocked: the PO was never queued to QB, so the
 * receipt carries no `LinkToTxn` and there is nothing to be out of step with.
 */
export async function checkPoQbSyncGate(
  knex: KnexLike,
  purchaseOrderId: string
): Promise<PoQbSyncGate> {
  const rows = (await knex
    .raw(
      `SELECT p.status, po.number AS po_number
         FROM qb_purchase_order_pipeline p
         LEFT JOIN purchase_order po ON po.id = p.purchase_order_id
        WHERE p.purchase_order_id = ?
          AND p.deleted_at IS NULL
        LIMIT 1`,
      [purchaseOrderId]
    )
    .then((r) => r.rows)) as PipelineRow[];

  const row = rows[0];
  if (!row) return NOT_BLOCKED;

  const status = row.status ?? "";
  if (status === "synced") return NOT_BLOCKED;

  const terminal = status === "failed_permanent";
  const label = row.po_number ?? purchaseOrderId;

  return {
    blocked: true,
    terminal,
    reason:
      `Held: ${label} has an unsynced QuickBooks change ` +
      `(qb_purchase_order_pipeline = '${status}'). Sending this receipt now would be ` +
      `checked by QuickBooks against the OLD ordered quantities and rejected with ` +
      `error 3060. ` +
      (terminal
        ? `Fix the Purchase Order sync first (retry it from the QB pipeline), then retry this receipt.`
        : `Waiting for the Purchase Order to finish syncing.`),
  };
}
