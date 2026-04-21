/**
 * src/api/admin/purchase-orders/[id]/close/route.ts
 *
 * POST /admin/purchase-orders/:id/close
 *
 * Manually closes a PurchaseOrder — remaining open qty is forfeited
 * (zeroed into qty_cancelled on each line). Use when the vendor can't
 * fulfill the rest of an order and you want to stop showing it as
 * partially_received.
 *
 * Only submitted / partially_received POs can be closed. Already-closed /
 * received / voided POs are rejected.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { closeSchema } from "../../_lib/validators";
import { zodErrorToBody } from "../../_lib/format";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";

interface PoHeader {
  id: string;
  status: string;
}

interface PoLine {
  id: string;
  qty_ordered: number;
  qty_received: number;
  qty_cancelled: number;
  status: string;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const po = (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeader | null;
  if (!po) {
    return res.status(404).json({ error: "Purchase order not found", code: "not_found" });
  }
  if (po.status !== "submitted" && po.status !== "partially_received") {
    return res.status(409).json({
      error: `Cannot close a PO in status '${po.status}'.`,
      code: "not_closable",
    });
  }

  // Zero out remaining qty on each line — records forfeited qty into qty_cancelled
  const lines = (await service.listPurchaseOrderLines(
    { purchase_order_id: id },
    { take: 1000, skip: 0 }
  )) as unknown as PoLine[];

  const lineUpdates = lines
    .filter((l) => l.status !== "cancelled" && l.status !== "complete")
    .map((l) => {
      const remaining = l.qty_ordered - l.qty_received - l.qty_cancelled;
      return {
        id: l.id,
        qty_cancelled: l.qty_cancelled + Math.max(0, remaining),
        status: (l.qty_received > 0 ? "partial" : "cancelled") as "partial" | "cancelled",
      };
    });

  if (lineUpdates.length > 0) {
    await service.updatePurchaseOrderLines(lineUpdates);
  }

  const [updated] = await service.updatePurchaseOrders([
    {
      id,
      status: "closed",
      closed_at: new Date(),
      closed_by_user_id: userId,
      close_reason: body.close_reason,
    },
  ]);

  return res.json({ purchase_order: updated });
}
