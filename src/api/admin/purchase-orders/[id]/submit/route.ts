/**
 * src/api/admin/purchase-orders/[id]/submit/route.ts
 *
 * POST /admin/purchase-orders/:id/submit
 *
 * Transitions a PO from `draft` to `submitted` by running the
 * submitPurchaseOrderWorkflow. The workflow handles:
 *   - validating vendor + all lines have QB references
 *   - allocating PO-{seq}
 *   - freezing vendor snapshots
 *   - enqueueing the QB PurchaseOrderAdd pipeline row
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { submitPurchaseOrderWorkflow } from "../../../../../workflows/purchase-orders/submit-purchase-order";
import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const service = getPurchaseOrdersService(req);

  const po = (await service.retrievePurchaseOrder(id).catch(() => null)) as {
    id: string;
    status: string;
  } | null;
  if (!po) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }
  if (po.status !== "draft") {
    return res.status(409).json({
      error: `Only drafts can be submitted (current status: ${po.status}).`,
      code: "not_submittable",
    });
  }

  try {
    const { result } = await submitPurchaseOrderWorkflow(req.scope).run({
      input: {
        po_id: id,
        submitted_by_user_id: userId,
      },
    });

    return res.json({ submit: result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to submit purchase order";
    return res.status(400).json({ error: message, code: "submit_failed" });
  }
}
