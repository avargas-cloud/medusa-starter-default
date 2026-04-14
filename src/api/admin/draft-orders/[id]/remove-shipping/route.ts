import {
  beginDraftOrderEditWorkflow,
  removeDraftOrderShippingMethodWorkflow,
  confirmDraftOrderEditWorkflow,
  cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

/**
 * DELETE /admin/draft-orders/:id/remove-shipping
 *
 * Removes ALL shipping methods from a draft order.
 *
 * CRITICAL ORDER OF OPERATIONS (version-aware):
 *   0. Cancel any pending edit (clean state)
 *   1. Query existing shipping method IDs BEFORE begin (version-safe)
 *   2. Begin a fresh order edit
 *   3. Remove each method
 *   4. Confirm the edit
 *
 * Same timing fix as add-shipping-force: retrieveOrder must be called
 * before beginDraftOrderEditWorkflow, because begin increments the
 * pending version and the current methods are no longer visible at
 * the new pending version.
 */
export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };

  try {
    // Step 0: Cancel any pending edit
    try {
      await cancelDraftOrderEditWorkflow(req.scope).run({
        input: { order_id: id },
      });
    } catch {
      // No pending edit — fine
    }

    // Step 1: Get existing shipping methods BEFORE begin (version-safe)
    const orderService = req.scope.resolve(Modules.ORDER);
    let existingMethodIds: string[] = [];
    try {
      const currentOrder = await (orderService as any).retrieveOrder(id, {
        relations: ["shipping_methods"],
      });
      const existingMethods: any[] =
        (currentOrder as any)?.shipping_methods ?? [];
      existingMethodIds = existingMethods
        .map((sm: any) => sm.id)
        .filter(Boolean);
    } catch (err: any) {
      console.warn(
        "[remove-all-shipping] Could not fetch existing methods:",
        err?.message
      );
    }

    if (existingMethodIds.length === 0) {
      res.status(200).json({ success: true, removed: 0 });
      return;
    }

    // Step 2: Begin edit
    await beginDraftOrderEditWorkflow(req.scope).run({
      input: { order_id: id },
    });

    // Step 3: Remove each method
    let removed = 0;
    for (const smId of existingMethodIds) {
      try {
        await removeDraftOrderShippingMethodWorkflow(req.scope).run({
          input: { order_id: id, shipping_method_id: smId },
        });
        removed++;
      } catch (rmErr: any) {
        console.warn(
          "[remove-all-shipping] Could not remove",
          smId,
          rmErr?.message
        );
      }
    }

    // Step 4: Confirm
    const confirmedBy = (req as any).auth_context?.actor_id ?? "admin";
    await confirmDraftOrderEditWorkflow(req.scope).run({
      input: { order_id: id, confirmed_by: confirmedBy },
    });

    res.status(200).json({ success: true, removed });
  } catch (e: any) {
    console.error("[remove-all-shipping]", e?.message);
    res
      .status(500)
      .json({ message: e?.message ?? "Failed to remove shipping methods" });
  }
}
