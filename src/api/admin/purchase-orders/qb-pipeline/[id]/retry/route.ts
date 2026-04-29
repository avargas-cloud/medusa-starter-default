/**
 * POST /admin/purchase-orders/qb-pipeline/:id/retry
 *
 * Re-queues a failed pipeline entry back to waiting. Branches by id prefix:
 *   - qbpopipe_<ulid>           → qb_purchase_order_pipeline (PO add/mod/void)
 *   - qbrcpipe_<ulid>           → qb_item_receipt_pipeline ADD lane
 *                                 (status, qb_operation_id, last_error...)
 *   - qbrcpipe_<ulid>__void     → qb_item_receipt_pipeline VOID/DELETE lane
 *                                 (void_status, void_operation_id, void_*...)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { PURCHASE_ORDERS_MODULE } from "../../../../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../../../../modules/purchase-orders/service";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: rawId } = req.params as { id: string };
  const knex = (req.scope as any).resolve("__pg_connection__");

  const isVoidLane = rawId.endsWith("__void");
  const id = isVoidLane ? rawId.slice(0, -"__void".length) : rawId;

  // ── ItemReceipt VOID/DELETE lane ────────────────────────────────────────
  if (isVoidLane) {
    const rows = await knex
      .raw(
        `SELECT id, void_status FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (row.void_status !== "error") {
      return res.status(409).json({
        error: `Cannot retry void/delete lane in status '${row.void_status}'`,
      });
    }
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET void_status         = 'waiting',
              void_operation_id   = NULL,
              void_last_error     = NULL,
              void_next_retry_at  = NULL,
              updated_at          = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Re-queued for processing" });
  }

  // ── ItemReceipt ADD lane ────────────────────────────────────────────────
  if (id.startsWith("qbrcpipe_")) {
    const rows = await knex
      .raw(
        `SELECT id, status FROM qb_item_receipt_pipeline
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [id]
      )
      .then((r: any) => r.rows);
    const row = rows[0];
    if (!row)
      return res.status(404).json({ error: "Pipeline entry not found" });
    if (row.status !== "error") {
      return res.status(409).json({
        error: `Cannot retry entry with status '${row.status}'`,
      });
    }
    await knex.raw(
      `UPDATE qb_item_receipt_pipeline
          SET status          = 'waiting',
              qb_operation_id = NULL,
              last_error      = NULL,
              next_retry_at   = NULL,
              updated_at      = NOW()
        WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, message: "Re-queued for processing" });
  }

  // ── Purchase Order pipeline (default) ───────────────────────────────────
  const service = req.scope.resolve(
    PURCHASE_ORDERS_MODULE
  ) as unknown as PurchaseOrdersModuleService;

  const rows = (await service.listQbPurchaseOrderPipelines(
    { id },
    { take: 1 }
  )) as Array<{
    id: string;
    status: string;
    payload: unknown;
    last_error: string | null;
  }>;

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Pipeline entry not found" });
  const retryableStatuses = ["error", "waiting", "submitted"];
  if (!retryableStatuses.includes(row.status)) {
    return res
      .status(409)
      .json({ error: `Cannot retry entry with status '${row.status}'` });
  }

  // For mod/void: always re-query QB to get a fresh EditSequence (stale seq is the most common failure).
  const pl = (row.payload ?? {}) as Record<string, unknown>;
  const isEditSeqErr = /editsequence|edit.?sequence|3[12]00/i.test(
    row.last_error ?? ""
  );
  const needsQuery = (pl.is_mod || pl.is_void) && (!pl.edit_sequence || isEditSeqErr);
  // Strip _query_attempts so the re-queued query gets fresh retries.
  const { _query_attempts: _removed, ...plClean } = pl as Record<string, unknown>;
  const newPayload = needsQuery
    ? { ...plClean, is_query: true, edit_sequence: undefined }
    : plClean;

  await knex.raw(
    `UPDATE qb_purchase_order_pipeline
        SET status          = 'waiting',
            qb_operation_id = NULL,
            payload         = ?,
            last_error      = NULL,
            next_retry_at   = NULL,
            updated_at      = NOW()
      WHERE id = ?`,
    [JSON.stringify(newPayload), id]
  );

  return res.json({ success: true, message: "Re-queued for processing" });
}
