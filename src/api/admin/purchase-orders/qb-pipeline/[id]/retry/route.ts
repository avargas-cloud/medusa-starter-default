/**
 * POST /admin/purchase-orders/qb-pipeline/:id/retry
 * Re-queues a failed PO pipeline entry back to waiting.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { PURCHASE_ORDERS_MODULE } from "../../../../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../../../../modules/purchase-orders/service";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params as { id: string };

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
  if (row.status !== "error") {
    return res
      .status(409)
      .json({ error: `Cannot retry entry with status '${row.status}'` });
  }

  // If the row is a mod with missing/stale EditSequence, convert to query-first flow
  const pl = (row.payload ?? {}) as Record<string, unknown>;
  const isEditSeqErr = /editsequence|edit.?sequence|3100/i.test(
    row.last_error ?? ""
  );
  const needsQuery = (pl.is_mod || pl.is_void) && (!pl.edit_sequence || isEditSeqErr);
  const newPayload = needsQuery
    ? { ...pl, is_query: true, edit_sequence: undefined }
    : pl;

  // Use raw SQL to also clear qb_operation_id — the service update won't clear it,
  // and Phase B would re-poll the stale operation ID otherwise.
  const knex = (req.scope as any).resolve("__pg_connection__");
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
