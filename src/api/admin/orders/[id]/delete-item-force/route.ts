import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { assertOrderEditable } from "../_lib/assert-order-editable";
import { Modules } from "@medusajs/utils";

import { listActiveReservationsRaw } from "../../../../../lib/reservations";

/**
 * DELETE /admin/draft-orders/:id/delete-item-force
 * POST   /admin/draft-orders/:id/delete-item-force  (POS compat alias)
 *
 * Hard-deletes a line item — physically removes the record from the DB.
 *
 * Body: { line_item_id: string }
 * Query param: ?line_item_id=xxx  (fallback)
 */
async function handleDelete(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const archivedBlock = await assertOrderEditable(req.scope, String(req.params.id));
  if (archivedBlock) {
    res.status(409).json({ error: archivedBlock, code: "ORDER_ARCHIVED" });
    return;
  }
  const body = req.body as Record<string, any> | undefined;
  const line_item_id: string | undefined =
    body?.line_item_id ?? (req.query?.line_item_id as string | undefined);

  if (!line_item_id) {
    res.status(400).json({ message: "line_item_id is required" });
    return;
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as any;
    const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any;

    // Release any reservation tied to this line item before deleting it,
    // so inventory_level.reserved_quantity stays accurate. RAW SQL read —
    // the module's { line_item_id } filter is unreliable in Medusa v2; a miss
    // here leaks a phantom reservation on a deleted line (permanently lowers
    // available under the apartado policy).
    try {
      const knex = req.scope.resolve("__pg_connection__") as any;
      const existing = await listActiveReservationsRaw(knex, line_item_id);
      if (existing.length) {
        await inventoryModule.deleteReservationItems(existing.map((r) => r.id));
        console.log(
          `[delete-item-force] Released ${existing.length} reservation(s) for ${line_item_id}`
        );
      }
    } catch (resErr: any) {
      console.warn(
        `[delete-item-force] Reservation cleanup failed (non-fatal): ${resErr.message}`
      );
    }

    // Hard delete — physically removes the row from order_line_item
    if (typeof orderModule.deleteOrderLineItems === "function") {
      await orderModule.deleteOrderLineItems([line_item_id]);
      console.log("[delete-item-force] hard-deleted:", line_item_id);
      res.status(200).json({ success: true });
      return;
    }

    // Fallback: soft-delete (better than qty=0)
    if (typeof orderModule.softDeleteOrderLineItems === "function") {
      await orderModule.softDeleteOrderLineItems([line_item_id]);
      console.log("[delete-item-force] soft-deleted:", line_item_id);
      res.status(200).json({ success: true, method: "softDelete" });
      return;
    }

    res
      .status(500)
      .json({ message: "No delete method available on order module" });
  } catch (e: any) {
    console.error("[delete-item-force]", e?.message);
    res.status(500).json({ message: e?.message ?? "Failed to delete item" });
  }
}

export const DELETE = handleDelete;
export const POST = handleDelete; // POS calls via POST, admin panel via DELETE
