import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import {
  beginDraftOrderEditWorkflow,
  removeDraftOrderShippingMethodWorkflow,
  confirmDraftOrderEditWorkflow,
} from "@medusajs/core-flows";

/**
 * DELETE /admin/draft-orders/:id/remove-shipping/:methodId
 *
 * Removes a shipping method from a draft order in one atomic operation:
 *   1. begins a draft order edit (or reuses existing)
 *   2. removes the specified shipping method
 *   3. confirms the edit
 */
export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id, methodId } = req.params as { id: string; methodId: string };

  if (!methodId) {
    res.status(400).json({ message: "methodId is required" });
    return;
  }

  try {
    // Step 1: Begin draft order edit (idempotent)
    try {
      await beginDraftOrderEditWorkflow(req.scope).run({
        input: { order_id: id },
      });
    } catch (beginErr: any) {
      const msg: string = beginErr?.message ?? "";
      if (
        !msg.toLowerCase().includes("active") &&
        !msg.toLowerCase().includes("change")
      ) {
        throw beginErr;
      }
    }

    // Step 2: Remove shipping method
    await removeDraftOrderShippingMethodWorkflow(req.scope).run({
      input: {
        order_id: id,
        shipping_method_id: methodId,
      },
    });

    // Step 3: Confirm the edit
    const confirmedBy = (req as any).auth_context?.actor_id ?? "admin";
    await confirmDraftOrderEditWorkflow(req.scope).run({
      input: { order_id: id, confirmed_by: confirmedBy },
    });

    res.status(200).json({ success: true });
  } catch (e: any) {
    console.error("[remove-shipping]", e?.message);
    res
      .status(500)
      .json({ message: e?.message ?? "Failed to remove shipping method" });
  }
}
