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
  )) as Array<{ id: string; status: string }>;

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Pipeline entry not found" });
  if (row.status !== "error") {
    return res.status(409).json({ error: `Cannot retry entry with status '${row.status}'` });
  }

  await service.updateQbPurchaseOrderPipelines([
    { id, status: "waiting", next_retry_at: null, last_error: null },
  ]);

  return res.json({ success: true, message: "Re-queued for processing" });
}
